import { chromium } from 'playwright';
import { createServer } from 'node:http';
import { readFile } from 'node:fs/promises';
import { resolve, extname, sep } from 'node:path';

const root = resolve('.');
const mime = { '.js': 'text/javascript', '.mjs': 'text/javascript', '.html': 'text/html', '.css': 'text/css', '.json': 'application/json', '.wasm': 'application/wasm' };
const server = createServer(async (req, res) => {
  const path = resolve(root, '.' + decodeURIComponent(new URL(req.url, 'http://localhost').pathname));
  if (path !== root && !path.startsWith(root + sep)) { res.writeHead(403).end(); return; }
  try { res.setHeader('Content-Type', mime[extname(path)] || 'application/octet-stream'); res.end(await readFile(path === root ? resolve(root, 'index.html') : path)); }
  catch { res.writeHead(404).end(); }
});
await new Promise(r => server.listen(0, '127.0.0.1', r));
const origin = `http://127.0.0.1:${server.address().port}`;
let browser;
try {
  browser = await chromium.launch({ headless: true });
  const suites = process.argv.slice(2);
  for (const suite of (suites.length ? suites : ['platform', 'settings', 'image-zoom', 'image-reader', 'novel-reader', 'novel-voice', 'voice-worker', 'importer'])) {
    const context = await browser.newContext({ viewport: { width: 390, height: 844 } });
    const page = await context.newPage();
    page.setDefaultTimeout(180000);
    if (suite === 'voice-worker') {
      await context.route('**/vendor/tts/models/**', async route => {
        const name = new URL(route.request().url()).pathname.split('/').pop();
        if (!['tokenizer.json', 'tokenizer_config.json', 'config.json'].includes(name)) throw Error('Unexpected model download: ' + name);
        await route.fulfill({ body: name === 'config.json' ? '{}' : await readFile(resolve(root, 'test/fixtures/voice', name)), contentType: 'application/json' });
      });
      await context.route('**/vendor/tts/voices/*.bin', route => route.fulfill({ body: Buffer.alloc(510 * 256 * 4) }));
      await context.route('https://**', route => { throw Error('Unexpected external voice request: ' + route.request().url()); });
    }
    await page.goto(`${origin}/test/${suite}.test.html`);
    let result;
    if (suite === 'voice-worker') {
      await page.waitForFunction(() => !!window.run);
      result = await page.evaluate(() => window.run());
    } else if (suite === 'novel-voice') {
      await page.waitForFunction(() => !!window.T);
      result = await page.evaluate(() => T.all());
    } else if (suite === 'importer') {
      await page.waitForFunction(() => window.__ready);
      result = await page.evaluate(() => T.runAll());
    } else if (suite === 'novel-reader') {
      await page.waitForFunction(() => !!window.T);
      result = await page.evaluate(async () => {
        const results = [];
        for (const name of Object.keys(T).filter(k => /^test/.test(k))) results.push({ name, ...await T[name]() });
        return { failed: results.reduce((n, r) => n + r.failed, 0), results };
      });
    } else {
      await page.waitForFunction(() => /^(PASS|FAIL)/.test(document.title));
      result = await page.evaluate(() => ({ pass: document.title.startsWith('PASS'), summary: document.querySelector('#summary')?.textContent }));
    }
    const pass = result.pass !== false && !(result.failed > 0);
    console.log(`${pass ? 'PASS' : 'FAIL'} ${suite}`);
    if (!pass) {
      console.log(JSON.stringify(result));
      console.log((await page.locator('body').innerText()).split('\n').filter(line => /FAIL|threw|error/i.test(line)).join('\n')); 
      process.exitCode = 1;
    }
    await context.close();
  }
} finally {
  await browser?.close();
  await new Promise(r => server.close(r));
}
