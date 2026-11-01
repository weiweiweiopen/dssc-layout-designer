import { access, mkdtemp, writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import puppeteer from 'puppeteer-core';
import { closeTestBrowser } from './browser-cleanup.mjs';

const url = process.env.APP_URL ?? 'http://127.0.0.1:4174';
const executablePath = process.env.CHROME_PATH ?? '/Applications/Google Chrome.app/Contents/MacOS/Google Chrome';
await access(executablePath);
const output = await mkdtemp(join(process.env.TEST_TMPDIR ?? tmpdir(), 'review-transparency-'));
const browser = await puppeteer.launch({ executablePath, headless: true, args: ['--no-sandbox', '--use-angle=swiftshader', '--enable-unsafe-swiftshader'] });
const page = await browser.newPage(), errors = [];
page.on('pageerror', (e) => errors.push(String(e)));
const ensure = (ok, message) => { if (!ok) throw new Error(message); };
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
async function image(name) {
  await sleep(350);
  const buffer = await (await page.$('[data-testid="review-canvas"] canvas')).screenshot();
  await writeFile(join(output, `${name}.png`), buffer);
  return buffer.toString('base64');
}
async function compare(a, b) {
  return page.evaluate(async ({ a, b }) => {
    const decode = async (base64) => {
      const image = new Image(); image.src = `data:image/png;base64,${base64}`; await image.decode();
      const canvas = document.createElement('canvas'); canvas.width = image.width; canvas.height = image.height;
      const ctx = canvas.getContext('2d'); ctx.drawImage(image, 0, 0); return ctx.getImageData(0, 0, canvas.width, canvas.height).data;
    };
    const x = await decode(a), y = await decode(b); let changed = 0, totalDelta = 0;
    for (let i = 0; i < x.length; i += 4) {
      const delta = Math.max(Math.abs(x[i]-y[i]),Math.abs(x[i+1]-y[i+1]),Math.abs(x[i+2]-y[i+2]));
      if (delta > 3) changed++; totalDelta += delta;
    }
    return { fraction: changed/(x.length/4), meanDelta: totalDelta/(x.length/4) };
  }, { a, b });
}
try {
  await page.setViewport({ width: 1500, height: 1000, deviceScaleFactor: 1 });
  await page.goto(url, { waitUntil: 'networkidle2' });
  await page.evaluate(() => {
    localStorage.setItem('dssc-layout-language', 'en');
    localStorage.setItem('dssc-layout-review-3d-v1', JSON.stringify({ biggerDye: 'burgundy', smallerDye: 'custom', smallerColor: '#00bbed',
      glass: true, fto: true, coatings: false, seal: false, contacts: false, labels: false, orthographic: true, explodeMm: 0 }));
  });
  await page.reload({ waitUntil: 'networkidle2' });
  await page.waitForFunction(() => document.querySelector('.title-status')?.dataset.state === 'pass', { timeout: 60000 });
  const before = await page.evaluate(() => localStorage.getItem('w-series-voronoi-layout-v6'));
  await page.click('[data-view-mode="review-3d"]');
  await page.waitForFunction(() => document.querySelector('[data-testid="review-canvas"]')?.dataset.state === 'ready' && document.querySelector('[data-testid="review-canvas"]')?.dataset.cameraPose, { timeout: 60000 });
  await page.click('[data-review-view="top"]');
  const clear = await image('substrates-on');
  await page.click('[data-review-toggle="glass"]'); await page.click('[data-review-toggle="fto"]');
  const empty = await image('substrates-off');
  const blankDifference = await compare(clear, empty);
  ensure(blankDifference.fraction < 0.04, `Transparent substrates paint a filled gray/blue pane: ${JSON.stringify(blankDifference)}`);
  ensure(blankDifference.fraction > 0.00005, 'Substrate controls should still show useful engineering outlines');
  await page.click('[data-review-toggle="coatings"]');
  const coatings = await image('coatings-only');
  const coatingDifference = await compare(coatings, empty);
  ensure(coatingDifference.fraction > 0.03, 'Actual TiO2 / Pt surfaces were incorrectly made transparent');
  await page.click('[data-review-toggle="glass"]'); await page.click('[data-review-toggle="fto"]');
  const throughGlass = await image('coatings-with-clear-substrates');
  const tintDifference = await compare(throughGlass, coatings);
  ensure(tintDifference.fraction < 0.04, `Substrates still tint the dyed areas: ${JSON.stringify(tintDifference)}`);
  await page.click('[data-review-toggle="coatings"]'); await page.click('[data-review-toggle="seal"]');
  const adhesive = await image('adhesive-only');
  ensure((await compare(adhesive, empty)).fraction > 0.003, 'Actual adhesive was removed from the scene');
  ensure(await page.evaluate((raw) => localStorage.getItem('w-series-voronoi-layout-v6') === raw, before), 'Display correction changed engineering settings');
  ensure(!errors.length, errors.join('\n'));
  await writeFile(join(output, 'result.json'), JSON.stringify({ status: 'PASS', blankDifference, tintDifference, coatingDifference,
    checks: 'actual rendered pixels: blank clear areas vs background, neutral outlines, preserved TiO2/Pt/adhesive, unchanged engineering state' }, null, 2));
  console.log(`3D clear-substrate rendering: PASS\nArtifacts: ${output}`);
} catch (error) { await page.screenshot({ path: join(output, 'failure.png') }); console.error(`Artifacts: ${output}`); throw error; }
finally { await closeTestBrowser(browser); }
