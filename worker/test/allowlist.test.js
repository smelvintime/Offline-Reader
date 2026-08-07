// The /image allowlist: static tier, learned tier, and the KV-optional path.

import { test, describe, beforeEach } from 'node:test';
import assert from 'node:assert/strict';

import {
  isStaticallyAllowed,
  isAllowedHost,
  learnHosts,
  hasKv,
  hostsOf,
  staticList,
  LEARNED_TTL,
} from '../src/lib/allowlist.js';
import { kvStub } from './helpers.js';

describe('static tier', () => {
  test('known content hosts are allowed with no KV at all', () => {
    assert.equal(isStaticallyAllowed('uploads.mangadex.org'), true);
    assert.equal(isStaticallyAllowed('cdn.flamecomics.xyz'), true);
    assert.equal(isStaticallyAllowed('www.gutenberg.org'), true);
  });

  test('wildcard entries match subdomains and the apex', () => {
    assert.equal(isStaticallyAllowed('cmdxd98sb0x3yprd.mangadex.network'), true);
    assert.equal(isStaticallyAllowed('anything.mangadex.org'), true);
  });

  test('lookalike hosts are NOT allowed', () => {
    assert.equal(isStaticallyAllowed('mangadex.org.evil.com'), false);
    assert.equal(isStaticallyAllowed('notmangadex.org'), false);
    assert.equal(isStaticallyAllowed('evil.com'), false);
  });

  test('operators can extend the static list with a var', () => {
    const env = { EXTRA_ALLOWED_HOSTS: 'cdn.mysite.org, *.othercdn.net' };
    assert.equal(isStaticallyAllowed('cdn.mysite.org', env), true);
    assert.equal(isStaticallyAllowed('img.othercdn.net', env), true);
    assert.equal(isStaticallyAllowed('cdn.mysite.org'), false);
    assert.ok(staticList(env).length > staticList({}).length);
  });
});

describe('KV is optional', () => {
  test('hasKv is false without the binding', () => {
    assert.equal(hasKv({}), false);
    assert.equal(hasKv({ OR_ALLOWLIST: {} }), false);
    assert.equal(hasKv({ OR_ALLOWLIST: kvStub() }), true);
  });

  test('without KV, only the static tier applies', async () => {
    assert.deepEqual(await isAllowedHost('uploads.mangadex.org', {}), {
      allowed: true,
      via: 'static',
    });
    assert.deepEqual(await isAllowedHost('random.example.org', {}), { allowed: false, via: null });
  });

  test('without KV, learning is a silent no-op', async () => {
    assert.deepEqual(await learnHosts(['cdn.example.org'], {}), []);
  });

  test('a KV outage degrades to static-only instead of failing open', async () => {
    const broken = {
      OR_ALLOWLIST: {
        get: async () => {
          throw new Error('KV down');
        },
        put: async () => {
          throw new Error('KV down');
        },
      },
    };
    assert.deepEqual(await isAllowedHost('unknown.example.org', broken), {
      allowed: false,
      via: null,
    });
    assert.deepEqual(await isAllowedHost('uploads.mangadex.org', broken), {
      allowed: true,
      via: 'static',
    });
  });
});

describe('learned tier', () => {
  let env;
  beforeEach(() => {
    env = { OR_ALLOWLIST: kvStub() };
  });

  test('a learned host becomes allowed', async () => {
    assert.equal((await isAllowedHost('cdn.example.org', env)).allowed, false);
    const written = await learnHosts(['cdn.example.org'], env);
    assert.deepEqual(written, ['cdn.example.org']);
    assert.deepEqual(await isAllowedHost('cdn.example.org', env), {
      allowed: true,
      via: 'learned',
    });
  });

  test('learned entries carry the 30-day TTL', async () => {
    let seenTtl = null;
    const env2 = {
      OR_ALLOWLIST: {
        async get() {
          return null;
        },
        async put(_k, _v, opts) {
          seenTtl = opts && opts.expirationTtl;
        },
      },
    };
    await learnHosts(['cdn.example.org'], env2);
    assert.equal(seenTtl, LEARNED_TTL);
    assert.equal(LEARNED_TTL, 30 * 24 * 60 * 60);
  });

  test('hosts already covered statically are not written', async () => {
    const written = await learnHosts(['uploads.mangadex.org', 'new.example.org'], env);
    assert.deepEqual(written, ['new.example.org']);
  });

  test('learning is bounded so one page cannot burn the write budget', async () => {
    const many = Array.from({ length: 50 }, (_, i) => `h${i}.example.org`);
    const written = await learnHosts(many, env);
    assert.equal(written.length, 12);
  });

  test('junk hosts are ignored', async () => {
    const written = await learnHosts(['', 'nodot', 'x'.repeat(300) + '.com', null], env);
    assert.deepEqual(written, []);
  });

  test('a learned wildcard covers subdomains', async () => {
    await env.OR_ALLOWLIST.put('allow:host:*.imgcdn.example', '1');
    const r = await isAllowedHost('a.imgcdn.example', env);
    assert.deepEqual(r, { allowed: true, via: 'learned-wildcard' });
  });
});

describe('hostsOf', () => {
  test('collects hostnames from absolute URLs and skips junk', () => {
    const s = hostsOf([
      'https://a.example.org/x.png',
      'https://b.example.org/y.png',
      'https://a.example.org/z.png',
      'not a url',
      '',
    ]);
    assert.deepEqual([...s].sort(), ['a.example.org', 'b.example.org']);
  });
});
