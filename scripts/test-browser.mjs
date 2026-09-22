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
const MOBILE = { label: 'mobile', width: 390, height: 844 };
const DESKTOP = { label: 'desktop', width: 1440, height: 900 };
const definitions = {
  platform:       { name: 'platform' },
  settings:       { name: 'settings' },
  catalogue:      { name: 'catalogue', path: '/index.html', layout: true, viewports: [MOBILE, DESKTOP] },
  'image-zoom':   { name: 'image-zoom' },
  'image-reader': { name: 'image-reader', layout: true, viewports: [MOBILE, DESKTOP] },
  'novel-reader': { name: 'novel-reader', layout: true, viewports: [MOBILE, DESKTOP] },
  'novel-voice':  { name: 'novel-voice' },
  'voice-worker': { name: 'voice-worker' },
  importer:       { name: 'importer' },
};

function layoutResult(assertions) {
  const failed = assertions.filter(row => !row.pass);
  return {
    pass: failed.length === 0,
    summary: failed.length ? failed.map(row => row.name + ': ' + row.detail).join('; ') : `${assertions.length} layout assertions`,
    assertions,
  };
}

async function checkLayout(page, suite, viewport) {
  if (suite === 'catalogue') {
    await page.waitForSelector('#home-screen');
    return page.evaluate(({ desktop }) => {
      if (typeof window.showScreen === 'function') window.showScreen('home-screen');
      else document.getElementById('home-screen').style.display = 'flex';
      const shell = document.getElementById('home-body').getBoundingClientRect();
      const header = document.getElementById('home-header-inner').getBoundingClientRect();
      const rows = [
        { name: 'catalogue has no horizontal overflow', pass: document.documentElement.scrollWidth <= window.innerWidth + 1,
          detail: `${document.documentElement.scrollWidth}px in ${window.innerWidth}px` },
        { name: 'catalogue body stays inside the viewport', pass: shell.left >= -1 && shell.right <= window.innerWidth + 1,
          detail: `${shell.left.toFixed(1)}..${shell.right.toFixed(1)}` },
        { name: 'catalogue header stays reachable', pass: header.left >= -1 && header.right <= window.innerWidth + 1 && header.top >= -1,
          detail: `${header.left.toFixed(1)}..${header.right.toFixed(1)}` },
      ];
      if (desktop) rows.push({
        name: 'catalogue body is capped on a wide window',
        pass: shell.width <= 1181 && shell.width < window.innerWidth - 1,
        detail: `${shell.width.toFixed(1)}px in ${window.innerWidth}px`,
      });
      return rows;
    }, { desktop: viewport.label === 'desktop' }).then(layoutResult);
  }

  if (suite === 'image-reader') {
    return page.evaluate(async ({ desktop }) => {
      openSession({ chapters: 1, perChapter: 1 });
      document.getElementById('reader-header').classList.remove('ui-hidden');
      document.getElementById('reader-footer').classList.remove('ui-hidden');
      await new Promise(resolve => requestAnimationFrame(() => requestAnimationFrame(resolve)));
      const column = document.querySelector('.page-wrapper').getBoundingClientRect();
      const header = document.getElementById('reader-header').getBoundingClientRect();
      const footer = document.getElementById('reader-footer').getBoundingClientRect();
      const rows = [
        { name: 'image reader has no horizontal overflow', pass: document.documentElement.scrollWidth <= window.innerWidth + 1,
          detail: `${document.documentElement.scrollWidth}px in ${window.innerWidth}px` },
        { name: 'image reader chrome stays reachable',
          pass: header.left >= -1 && header.right <= window.innerWidth + 1 && header.top >= -1
            && footer.left >= -1 && footer.right <= window.innerWidth + 1 && footer.bottom <= window.innerHeight + 1,
          detail: `header ${header.left.toFixed(1)}..${header.right.toFixed(1)}, footer bottom ${footer.bottom.toFixed(1)}` },
        { name: 'image column stays inside the viewport', pass: column.left >= -1 && column.right <= window.innerWidth + 1,
          detail: `${column.left.toFixed(1)}..${column.right.toFixed(1)}` },
      ];
      if (desktop) rows.push({
        name: 'image column is capped on a wide window',
        pass: column.width <= 1001 && column.width < window.innerWidth - 1,
        detail: `${column.width.toFixed(1)}px in ${window.innerWidth}px`,
      });
      return rows;
    }, { desktop: viewport.label === 'desktop' }).then(layoutResult);
  }

  const result = await page.evaluate(async ({ desktop }) => {
    await T.reset();
    T.stubTuning(10, desktop);
    await T.open(1);
    T.hideHarness();
    await new Promise(resolve => requestAnimationFrame(() => requestAnimationFrame(resolve)));
    const column = document.querySelector('#novel-screen .nv-measure').getBoundingClientRect();
    const header = document.querySelector('#novel-screen .nv-header').getBoundingClientRect();
    const footer = document.querySelector('#novel-screen .nv-footer').getBoundingClientRect();
    const rows = [
      { name: 'novel reader has no horizontal overflow', pass: document.documentElement.scrollWidth <= window.innerWidth + 1,
        detail: `${document.documentElement.scrollWidth}px in ${window.innerWidth}px` },
      { name: 'novel reader chrome stays reachable',
        pass: header.left >= -1 && header.right <= window.innerWidth + 1 && header.top >= -1
          && footer.left >= -1 && footer.right <= window.innerWidth + 1 && footer.bottom <= window.innerHeight + 1,
        detail: `header ${header.left.toFixed(1)}..${header.right.toFixed(1)}, footer bottom ${footer.bottom.toFixed(1)}` },
      { name: 'novel column stays inside the viewport', pass: column.left >= -1 && column.right <= window.innerWidth + 1,
        detail: `${column.left.toFixed(1)}..${column.right.toFixed(1)}` },
    ];
    if (desktop) rows.push({
      name: 'novel column is capped on a wide window',
      pass: column.width <= 673 && column.width < window.innerWidth - 1,
      detail: `${column.width.toFixed(1)}px in ${window.innerWidth}px`,
    });
    return rows;
  }, { desktop: viewport.label === 'desktop' }).then(layoutResult);

  if (viewport.label === 'desktop') {
    const before = await page.evaluate(() => NovelReader.state().page);
    const next = await page.locator('#novel-screen .nv-zone-next').boundingBox();
    if (!next) {
      result.assertions.push({ name: 'desktop mouse reaches the page-turn zone', pass: false, detail: 'next zone has no box' });
    } else {
      await page.mouse.click(next.x + next.width / 2, next.y + next.height / 2);
      await page.waitForTimeout(50);
      const after = await page.evaluate(() => NovelReader.state().page);
      result.assertions.push({
        name: 'desktop mouse reaches the page-turn zone',
        pass: after === before + 1,
        detail: `page ${before} to ${after}`,
      });
    }
    return layoutResult(result.assertions);
  }
  return result;
}

let browser;
try {
  browser = await chromium.launch({ headless: true });
  const requested = process.argv.slice(2);
  const suiteNames = requested.length
    ? requested
    : ['platform', 'settings', 'catalogue', 'image-zoom', 'image-reader', 'novel-reader', 'novel-voice', 'voice-worker', 'importer'];
  for (const suiteName of suiteNames) {
    const definition = definitions[suiteName];
    if (!definition) throw Error(`Unknown browser suite: ${suiteName}`);
    for (const viewport of (definition.viewports || [MOBILE])) {
      const suite = definition.name;
      const context = await browser.newContext({ viewport: { width: viewport.width, height: viewport.height } });
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
      await page.goto(`${origin}${definition.path || `/test/${suite}.test.html`}`);
      let result;
      if (suite === 'catalogue') {
        result = await checkLayout(page, suite, viewport);
      } else if (suite === 'voice-worker') {
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
      if (definition.layout && suite !== 'catalogue' && result.pass !== false && !(result.failed > 0)) {
        result = await checkLayout(page, suite, viewport);
      }
      const pass = result.pass !== false && !(result.failed > 0);
      console.log(`${pass ? 'PASS' : 'FAIL'} ${suite} [${viewport.label} ${viewport.width}x${viewport.height}]`);
      if (!pass) {
        console.log(JSON.stringify(result));
        console.log((await page.locator('body').innerText()).split('\n').filter(line => /FAIL|threw|error/i.test(line)).join('\n'));
        process.exitCode = 1;
      }
      await context.close();
    }
  }
} finally {
  await browser?.close();
  await new Promise(r => server.close(r));
}
