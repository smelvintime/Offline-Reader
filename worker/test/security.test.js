// URL validation and SSRF defence — the tests that matter most (§7).

import { test, describe } from 'node:test';
import assert from 'node:assert/strict';

import {
  validateTargetUrl,
  isIpLiteral,
  isPrivateIpv4,
  isPrivateIpv6,
  isPrivateIp,
  normalizeHost,
  assertPublicDns,
  safeFetch,
  readTextCapped,
  capStream,
  upstreamHeaders,
  LIMITS,
} from '../src/lib/security.js';
import { fetchStub } from './helpers.js';

describe('validateTargetUrl — schemes', () => {
  test('accepts http and https', () => {
    assert.equal(validateTargetUrl('https://example.com/a').ok, true);
    assert.equal(validateTargetUrl('http://example.com/a').ok, true);
  });

  for (const bad of [
    'ftp://example.com/x',
    'file:///etc/passwd',
    'javascript:alert(1)',
    'data:text/html,<script>',
    'gopher://example.com/',
    'blob:https://example.com/uuid',
  ]) {
    test(`rejects ${bad}`, () => {
      const r = validateTargetUrl(bad);
      assert.equal(r.ok, false);
      assert.equal(r.error, 'bad_url');
    });
  }

  test('rejects missing / non-string / relative', () => {
    assert.equal(validateTargetUrl('').error, 'bad_url');
    assert.equal(validateTargetUrl(null).error, 'bad_url');
    assert.equal(validateTargetUrl('/relative/path').error, 'bad_url');
  });

  test('rejects absurdly long URLs', () => {
    assert.equal(validateTargetUrl('https://example.com/' + 'a'.repeat(4000)).error, 'bad_url');
  });

  test('rejects embedded credentials', () => {
    const r = validateTargetUrl('https://user:pass@example.com/');
    assert.equal(r.ok, false);
    assert.equal(r.error, 'bad_url');
  });
});

describe('validateTargetUrl — SSRF host rules', () => {
  const blocked = [
    'http://127.0.0.1/x',
    'http://127.1/x',
    'http://10.0.0.1/x',
    'http://10.255.255.254/x',
    'http://172.16.0.1/x',
    'http://172.31.255.1/x',
    'http://192.168.1.1/x',
    'http://169.254.169.254/latest/meta-data/',
    'http://100.64.0.1/x',
    'http://0.0.0.0/x',
    'http://[::1]/x',
    'http://[fc00::1]/x',
    'http://[fe80::1]/x',
    'http://2130706433/x', // decimal 127.0.0.1
    'http://0x7f000001/x', // hex 127.0.0.1
    'http://localhost/x',
    'http://LOCALHOST/x',
    'http://foo.local/x',
    'http://svc.internal/x',
    'http://thing.cluster.local/x',
    'http://metadata.google.internal/x',
    'http://intranet-box/x', // single label
  ];
  for (const url of blocked) {
    test(`blocks ${url}`, () => {
      const r = validateTargetUrl(url);
      assert.equal(r.ok, false, `${url} should be rejected`);
      assert.equal(r.error, 'blocked_host');
    });
  }

  test('blocks classic SSRF pivot ports', () => {
    assert.equal(validateTargetUrl('http://example.com:6379/').error, 'blocked_host');
    assert.equal(validateTargetUrl('http://example.com:22/').error, 'blocked_host');
    assert.equal(validateTargetUrl('http://example.com:9200/').error, 'blocked_host');
  });

  test('allows ordinary public hosts and ports', () => {
    assert.equal(validateTargetUrl('https://mangadex.org/title/abc').ok, true);
    assert.equal(validateTargetUrl('https://example.com:8443/x').ok, true);
    assert.equal(validateTargetUrl('https://sub.domain.example.com/x').ok, true);
  });

  test('allowPrivate is an explicit opt-in, not the default', () => {
    assert.equal(validateTargetUrl('http://127.0.0.1:8000/x').ok, false);
    assert.equal(validateTargetUrl('http://127.0.0.1:8000/x', { allowPrivate: true }).ok, true);
  });
});

describe('IP classification', () => {
  test('isIpLiteral', () => {
    assert.equal(isIpLiteral('127.0.0.1'), true);
    assert.equal(isIpLiteral('2130706433'), true);
    assert.equal(isIpLiteral('[::1]'), true);
    assert.equal(isIpLiteral('example.com'), false);
    assert.equal(isIpLiteral('1example.com'), false);
  });

  test('private IPv4 ranges', () => {
    for (const ip of [
      '10.0.0.1', '10.255.255.255', '172.16.0.1', '172.31.255.255',
      '192.168.0.1', '127.0.0.1', '169.254.169.254', '100.64.0.1',
      '0.0.0.0', '224.0.0.1', '240.0.0.1',
    ]) {
      assert.equal(isPrivateIpv4(ip), true, `${ip} should be private`);
    }
  });

  test('public IPv4 addresses are allowed', () => {
    for (const ip of ['8.8.8.8', '1.1.1.1', '172.32.0.1', '172.15.255.255', '104.16.0.1']) {
      assert.equal(isPrivateIpv4(ip), false, `${ip} should be public`);
    }
  });

  test('private IPv6 ranges', () => {
    for (const ip of [
      '::1', '::', 'fc00::1', 'fd12:3456::1', 'fe80::1', 'ff02::1',
      '::ffff:127.0.0.1', '::ffff:10.0.0.1', '2002:7f00:0001::1',
    ]) {
      assert.equal(isPrivateIpv6(ip), true, `${ip} should be private`);
    }
  });

  test('public IPv6 addresses are allowed', () => {
    assert.equal(isPrivateIpv6('2001:4860:4860::8888'), false);
    assert.equal(isPrivateIpv6('2606:4700:4700::1111'), false);
  });

  test('unparseable input fails closed', () => {
    assert.equal(isPrivateIpv4('not-an-ip'), true);
    assert.equal(isPrivateIpv6('zzz::'), true);
    assert.equal(isPrivateIp(''), true);
  });

  test('normalizeHost lowercases and drops the trailing dot', () => {
    assert.equal(normalizeHost('Example.COM.'), 'example.com');
  });
});

describe('assertPublicDns', () => {
  test('rejects a name that resolves into a private range', async () => {
    const r = await assertPublicDns('evil.example.com', {
      mode: 'strict',
      resolve: async () => ['10.0.0.5'],
    });
    assert.equal(r.ok, false);
    assert.equal(r.error, 'blocked_host');
    assert.match(r.message, /private address/);
  });

  test('accepts a name that resolves publicly', async () => {
    const r = await assertPublicDns('good1.example.com', {
      mode: 'strict',
      resolve: async () => ['93.184.216.34'],
    });
    assert.equal(r.ok, true);
  });

  test('strict mode fails closed when the lookup returns nothing', async () => {
    const r = await assertPublicDns('unknown1.example.com', {
      mode: 'strict',
      resolve: async () => [],
    });
    assert.equal(r.ok, false);
  });

  test('lenient mode (the default) fails open when the lookup fails', async () => {
    const r = await assertPublicDns('unknown2.example.com', {
      mode: 'lenient',
      resolve: async () => {
        throw new Error('resolver down');
      },
    });
    assert.equal(r.ok, true);
  });

  test('off mode skips the lookup entirely', async () => {
    let called = false;
    const r = await assertPublicDns('whatever.example.com', {
      mode: 'off',
      resolve: async () => {
        called = true;
        return ['10.0.0.1'];
      },
    });
    assert.equal(r.ok, true);
    assert.equal(called, false);
  });
});

describe('safeFetch — redirects are re-validated', () => {
  const opts = { mode: 'off' };

  test('follows a redirect to another public host', async () => {
    const stub = fetchStub({
      'a.example.com/one': () =>
        new Response(null, { status: 302, headers: { location: 'https://b.example.com/two' } }),
      'b.example.com/two': () => new Response('done', { status: 200 }),
    });
    const { response, finalUrl, hops } = await safeFetch('https://a.example.com/one', {
      ...opts,
      fetchImpl: stub,
    });
    assert.equal(response.status, 200);
    assert.equal(finalUrl, 'https://b.example.com/two');
    assert.equal(hops.length, 2);
  });

  test('REJECTS a redirect that points at cloud metadata', async () => {
    const stub = fetchStub({
      'a.example.com/one': () =>
        new Response(null, {
          status: 302,
          headers: { location: 'http://169.254.169.254/latest/meta-data/' },
        }),
    });
    await assert.rejects(
      () => safeFetch('https://a.example.com/one', { ...opts, fetchImpl: stub }),
      (e) => e.code === 'blocked_host',
    );
  });

  test('REJECTS a redirect to localhost', async () => {
    const stub = fetchStub({
      'a.example.com/one': () =>
        new Response(null, { status: 302, headers: { location: 'http://localhost:8080/admin' } }),
    });
    await assert.rejects(
      () => safeFetch('https://a.example.com/one', { ...opts, fetchImpl: stub }),
      (e) => e.code === 'blocked_host',
    );
  });

  test('REJECTS a redirect that changes scheme to file:', async () => {
    const stub = fetchStub({
      'a.example.com/one': () =>
        new Response(null, { status: 302, headers: { location: 'file:///etc/passwd' } }),
    });
    await assert.rejects(
      () => safeFetch('https://a.example.com/one', { ...opts, fetchImpl: stub }),
      (e) => e.code === 'bad_url',
    );
  });

  test('caps the redirect chain', async () => {
    let n = 0;
    const stub = fetchStub({
      '*': () => {
        n++;
        return new Response(null, {
          status: 302,
          headers: { location: `https://hop${n}.example.com/x` },
        });
      },
    });
    await assert.rejects(
      () => safeFetch('https://start.example.com/x', { ...opts, fetchImpl: stub }),
      (e) => e.code === 'upstream_error' && /Too many redirects/.test(e.message),
    );
    assert.ok(n <= LIMITS.maxRedirects + 1, `made ${n} requests`);
  });

  test('uses redirect:manual so the runtime never follows on its own', async () => {
    const stub = fetchStub({ 'a.example.com/x': () => new Response('ok') });
    await safeFetch('https://a.example.com/x', { ...opts, fetchImpl: stub });
    assert.equal(stub.calls[0].opts.redirect, 'manual');
  });

  test('sends an AbortSignal', async () => {
    const stub = fetchStub({ 'a.example.com/x': () => new Response('ok') });
    await safeFetch('https://a.example.com/x', { ...opts, fetchImpl: stub });
    assert.ok(stub.calls[0].opts.signal, 'expected an AbortSignal on the outbound fetch');
  });
});

describe('upstreamHeaders — nothing from the client is forwarded (§7.4)', () => {
  test('produces a fixed, complete header set', () => {
    const h = upstreamHeaders({ referer: 'https://mangadex.org/' });
    assert.equal(h.Referer, 'https://mangadex.org/');
    assert.equal(h.Origin, 'https://mangadex.org');
    assert.ok(h['User-Agent']);
    // The allowlist of what we send is exactly these keys.
    assert.deepEqual(
      Object.keys(h).sort(),
      ['Accept', 'Accept-Encoding', 'Accept-Language', 'Origin', 'Referer', 'User-Agent'].sort(),
    );
  });

  test('never contains cookie or auth headers', () => {
    const h = upstreamHeaders({});
    const keys = Object.keys(h).map((k) => k.toLowerCase());
    for (const forbidden of ['cookie', 'authorization', 'set-cookie', 'x-forwarded-for']) {
      assert.equal(keys.includes(forbidden), false, `${forbidden} must not be sent upstream`);
    }
  });

  test('a client Cookie header does not reach the upstream call', async () => {
    const stub = fetchStub({ 'a.example.com/x': () => new Response('ok') });
    await safeFetch('https://a.example.com/x', {
      mode: 'off',
      fetchImpl: stub,
      headers: upstreamHeaders({ referer: 'https://a.example.com/' }),
    });
    const sent = Object.keys(stub.calls[0].headers).map((k) => k.toLowerCase());
    assert.equal(sent.includes('cookie'), false);
    assert.equal(sent.includes('authorization'), false);
  });
});

describe('size caps', () => {
  test('readTextCapped rejects on a too-large Content-Length', async () => {
    const res = new Response('x'.repeat(100), { headers: { 'content-length': '999999' } });
    await assert.rejects(
      () => readTextCapped(res, 1000),
      (e) => e.code === 'too_large',
    );
  });

  test('readTextCapped rejects mid-stream when the declared length lied', async () => {
    const body = new ReadableStream({
      start(c) {
        for (let i = 0; i < 40; i++) c.enqueue(new TextEncoder().encode('x'.repeat(100)));
        c.close();
      },
    });
    const res = new Response(body);
    await assert.rejects(
      () => readTextCapped(res, 1000),
      (e) => e.code === 'too_large',
    );
  });

  test('readTextCapped returns the body when it fits', async () => {
    const res = new Response('hello world');
    assert.equal(await readTextCapped(res, 1000), 'hello world');
  });

  test('capStream errors the stream past the cap', async () => {
    const body = new ReadableStream({
      start(c) {
        c.enqueue(new Uint8Array(600));
        c.enqueue(new Uint8Array(600));
        c.close();
      },
    });
    const capped = capStream(body, 1000);
    await assert.rejects(async () => {
      const reader = capped.getReader();
      for (;;) {
        const { done } = await reader.read();
        if (done) break;
      }
    });
  });
});
