import test from 'node:test';
import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import vm from 'node:vm';
import { nativeTokenizer } from '../js/voice-native-tokenizer.mjs';

test('native tokenizer rejects incompatible model resources instead of changing pronunciation', async () => {
  const json = JSON.parse(await readFile(new URL('./fixtures/voice/tokenizer.json', import.meta.url)));
  const config = JSON.parse(await readFile(new URL('./fixtures/voice/tokenizer_config.json', import.meta.url)));
  assert.throws(() => nativeTokenizer(json, { ...config, model_max_length: 1024 }), /Unsupported/);
  assert.throws(() => nativeTokenizer({ ...json, pre_tokenizer: { type: 'Whitespace' } }, config), /Unsupported/);
  const tokens = nativeTokenizer(json, config)('a'.repeat(1000)).input_ids;
  assert.equal(tokens.dims[1], 512);
});

test('an upgraded shell serves its voice worker instead of the stale vendor-cache copy', async () => {
  const source = await readFile(new URL('../sw.js', import.meta.url), 'utf8');
  const shell = source.match(/const CACHE_NAME = '([^']+)'/)[1];
  const workerUrl = 'https://reader.test/js/novel-voice-worker.js';
  const listeners = {};
  const buckets = new Map([
    ['or-voice-engine-v1', new Map([[workerUrl, 'old worker'], ['https://reader.test/vendor/tts/model.onnx', 'weights']])],
    [shell, new Map([[workerUrl, 'current worker']])],
  ]);
  const cache = rows => ({ match: async request => rows.has(request.url) ? new Response(rows.get(request.url)) : undefined });
  const context = {
    URL, Response, console,
    self: { location: { origin: 'https://reader.test' }, addEventListener: (type, fn) => { listeners[type] = fn; } },
    caches: {
      open: async name => cache(buckets.get(name)),
      match: async request => { for (const rows of buckets.values()) { const hit = await cache(rows).match(request); if (hit) return hit; } },
    },
    fetch: () => { throw Error('An offline update must use its cached worker'); },
  };
  vm.runInNewContext(source, context);
  let response;
  listeners.fetch({ request: new Request(workerUrl), respondWith: value => { response = value; } });
  assert.equal(await (await response).text(), 'current worker');
  assert.equal(buckets.get('or-voice-engine-v1').get('https://reader.test/vendor/tts/model.onnx'), 'weights');
});
