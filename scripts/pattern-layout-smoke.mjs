import { access, mkdtemp, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { createServer } from 'vite';
import puppeteer from 'puppeteer-core';
import { unzipSync, strFromU8 } from 'fflate';
import { closeTestBrowser } from './browser-cleanup.mjs';

const server = process.env.APP_URL ? null : await createServer({ server: { host: '127.0.0.1', port: 0 } });
await server?.listen();
const base = process.env.APP_URL ?? server.resolvedUrls.local[0];
const output = await mkdtemp(join(process.env.TEST_TMPDIR ?? tmpdir(), 'pattern-layout-'));
const executablePath = process.env.CHROME_PATH ?? '/Applications/Google Chrome.app/Contents/MacOS/Google Chrome';
await access(executablePath);
const browser = await puppeteer.launch({ executablePath, headless: true, args: ['--no-sandbox'] });
const page = await browser.newPage(), errors = [];
page.on('pageerror', (e) => errors.push(String(e)));
const ensure = (ok, message) => { if (!ok) throw new Error(message); };
const ready = () => page.waitForFunction(() => {
  const state = document.querySelector('.title-status')?.dataset.state;
  return state && state !== 'pending' && state !== 'exporting' && document.querySelector('[data-testid="pattern-panel"]')?.dataset.busy === 'false';
}, { timeout: 120000 });
async function parameter(label, value) {
  const input = await page.$(`[data-parameter="${label}"] input`);
  await input.evaluate((el) => { el.focus(); el.select(); });
  await page.keyboard.press('Backspace'); await input.type(String(value)); await page.keyboard.press('Enter');
  if (label === 'Measured Wet Film') await page.waitForFunction((source) => document.querySelector('[data-testid="pattern-panel"]')?.dataset.filmSource === source, {}, value > 0 ? 'measured-wet-film' : 'unmeasured-screen-charge');
  await ready();
}
try {
  await page.setViewport({ width: 1500, height: 1050 });
  await page.goto(base, { waitUntil: 'networkidle2' });
  await page.waitForSelector('.title-status');
  await page.click('[data-testid="language-en"]');
  const original = await page.evaluate(() => {
    const config = JSON.parse(localStorage.getItem('w-series-voronoi-layout-v6'));
    // Synthetic test calibration only; isolated browser profile, not user data.
    config.electrodeSeed = 555; config.measuredWetFilmUm = 15;
    const raw = JSON.stringify(config); localStorage.setItem('w-series-voronoi-layout-v6', raw); return raw;
  });
  await page.goto(new URL('?studio=type', base).href, { waitUntil: 'networkidle2' });
  await page.waitForFunction(() => document.querySelector('.tg-canvas')?.getAttribute('data-pending') === 'false');
  await page.$eval('textarea[aria-label="標題文字"]', (el) => {
    Object.getOwnPropertyDescriptor(HTMLTextAreaElement.prototype, 'value').set.call(el, 'SOLAR\nORACLE');
    el.dispatchEvent(new Event('input', { bubbles: true }));
  });
  await page.waitForFunction(() => document.querySelector('.tg-canvas')?.getAttribute('data-pending') === 'false');
  await Promise.all([page.waitForNavigation({ waitUntil: 'networkidle2', timeout: 120000 }), page.click('button[aria-label="送往 DSSC Layout"]')]);
  await page.waitForSelector('[data-testid="pattern-panel"]', { timeout: 120000 }); await ready();
  ensure(new URL(page.url()).searchParams.has('artwork'), 'header still only returns to an ordinary Layout');
  ensure(await page.$eval('.preview-frame svg', (svg) => svg.getAttribute('data-view')) === 'circuit', 'transferred artwork should open the actual dual-plate circuit');
  ensure((await page.$$('[data-region-id^="circuit-"][data-material]')).length > 0, 'no actual circuit coating shapes');
  await page.click('[data-view-mode="materials"]');
  await page.waitForSelector('.preview-frame svg[data-view="materials"]');
  ensure(await page.$eval('.preview-frame svg',svg=>svg.textContent.includes('18NR-T')&&svg.textContent.includes('PT-1')&&!svg.querySelector('[id^="ELECTRON_ROUTE"]')),'pattern material distribution is not a separate paste reference');
  for(const view of ['pt-6066','pt-6060']){await page.click(`[data-view-mode="${view}"]`);await page.waitForSelector(`.preview-frame svg[data-view="${view}"]`);ensure(await page.$eval('.preview-frame svg',svg=>!!svg.querySelector('[data-material="pt"][data-paste="PT-1"]')),'pattern PT-1 view is missing');}
  await page.click('[data-view-mode="circuit"]');await page.waitForSelector('.preview-frame svg[data-view="circuit"]');
  await page.screenshot({ path: join(output, 'font-circuit.png') });
  const status = await page.$eval('.title-status', (e) => e.dataset.state);
  ensure(status === 'pass', `synthetic-calibration trial should pass geometry: ${await page.$eval('[data-testid="pattern-panel"]', (e) => e.innerText)}`);
  ensure(await page.evaluate((raw) => localStorage.getItem('w-series-voronoi-layout-v6') === raw, original), 'trial overwrote the existing Layout reference');
  await page.click('[data-testid="search-pattern"]');
  await page.waitForFunction(() => document.querySelector('[data-testid="pattern-panel"]').dataset.busy === 'true');
  await page.locator('button::-p-text(Cancel search)').click(); await ready();
  ensure(await page.$eval('[data-testid="search-pattern"]', (e) => !e.disabled), 'cancelling a search leaves the trial stuck');

  await page.evaluate(() => {
    const create = URL.createObjectURL.bind(URL); window.__blobMap = new Map(); window.__downloads = [];
    URL.createObjectURL = (blob) => { const url = create(blob); window.__blobMap.set(url, blob); return url; };
    HTMLAnchorElement.prototype.click = function () { if (this.download) window.__downloads.push({ name: this.download, blob: window.__blobMap.get(this.href) }); };
  });
  // Existing Layout controls use stable text rather than a new export implementation.
  await page.locator('button::-p-text(Export Vector ZIP)').click().catch(async () => { await page.locator('button::-p-text(匯出向量 ZIP)').click(); });
  await page.waitForFunction(() => window.__downloads.length > 0, { timeout: 120000 });
  const bytes = new Uint8Array(await page.evaluate(async () => Array.from(new Uint8Array(await window.__downloads[0].blob.arrayBuffer()))));
  const files = unzipSync(bytes), design = JSON.parse(strFromU8(files['design.json']));
  const f = design.geometry.fabrication;
  ensure(design.config.artwork.title === 'SOLAR\nORACLE', 'title source did not arrive in the manufacturing record');
  ensure(f.activeShapes?.length === design.config.subcellCount && f.pattern?.flow.pass, 'pattern / flow data missing');
  ensure(f.pattern.ftoFragmentsValid && f.errors.length === 0, 'pattern is exported despite failed checks');
  for (const plate of ['6066', '6060']) for (const material of ['tio2', 'pt']) {
    const svg = strFromU8(files[`svg-production/screen-glass-${plate}-${material}.svg`]);
    ensure(svg.includes('piece-') && svg.includes('fill-rule="evenodd"'), `${plate}/${material} is not actual outlined pattern geometry`);
    ensure(!/<text\b/.test(svg), 'screen depends on live text');
    const sample = await page.evaluate(({ svg }) => {
      const doc = new DOMParser().parseFromString(svg, 'image/svg+xml');
      return [...doc.querySelectorAll('path[data-subcell-index]')].map((p) => ({ index: Number(p.getAttribute('data-subcell-index')), material: p.getAttribute('data-material') }));
    }, { svg });
    ensure(sample.every((p) => p.material === material && (plate === '6066' ? p.index % 2 === 0 : p.index % 2 !== 0) === (material === 'tio2')), 'material assignment no longer follows W-series parity');
    const paintedArea = await page.evaluate(async (svg) => {
      const doc = new DOMParser().parseFromString(svg, 'image/svg+xml'), [,,w,h] = doc.documentElement.getAttribute('viewBox').split(/\s+/).map(Number);
      const image = new Image(); image.src = URL.createObjectURL(new Blob([svg], {type:'image/svg+xml'})); await image.decode();
      const canvas = document.createElement('canvas'); canvas.width=Math.round(w*10);canvas.height=Math.round(h*10);
      const ctx=canvas.getContext('2d');ctx.fillStyle='white';ctx.fillRect(0,0,canvas.width,canvas.height);ctx.drawImage(image,0,0,canvas.width,canvas.height);
      const pixels=ctx.getImageData(0,0,canvas.width,canvas.height).data;let black=0;for(let i=0;i<pixels.length;i+=4)black+=1-pixels[i]/255;
      URL.revokeObjectURL(image.src);return black/100;
    },svg);
    const expectedArea=f.cellAreasMm2.reduce((sum,a,i)=>sum+(((plate==='6066'?i%2===0:i%2!==0)===(material==='tio2'))?a:0),0);
    ensure(Math.abs(paintedArea-expectedArea)<Math.max(1,expectedArea*.02),`${plate}/${material} SVG does not paint the net patterned area / holes`);
  }
  ensure(strFromU8(files['manufacturing-layout.dxf']).includes('SCREEN_6066_PT_REGIONS'), 'DXF lost patterned Pt / hole hatches');
  const estimates = JSON.parse(strFromU8(files['process-estimates.json']));
  ensure(Math.abs(estimates.electrical.iscMa - Math.min(...f.cellAreasMm2) / design.config.referenceAreaMm2 * design.config.referenceIscMa) < 1e-6, 'current is not based on patterned net area');
  ensure(Object.keys(files).length === 25 && files['svg-layered/materials-reference.svg'], 'pattern vector bundle should include all four paste screens and material reference');
  await writeFile(join(output, 'pattern-vector.zip'), bytes);

  await page.locator('button::-p-text(Complete ZIP: PDF + 1-bit TIFF)').click();
  await page.waitForFunction(() => window.__downloads.length === 2, { timeout: 120000 });
  const completeBytes = new Uint8Array(await page.evaluate(async () => Array.from(new Uint8Array(await window.__downloads[1].blob.arrayBuffer()))));
  const complete = unzipSync(completeBytes), names = Object.keys(complete);
  ensure(names.length === 37 && names.filter((n) => n.endsWith('.pdf')).length === 8 && names.filter((n) => n.endsWith('.tif')).length === 4, 'pattern complete bundle lost Pt PDF/TIFF files or material reference');
  for (const name of names.filter((n) => n.endsWith('.tif'))) {
    const data = complete[name]; ensure(data[0] === 0x49 && data[1] === 0x49 && data[2] === 42, 'invalid TIFF header');
    const view = new DataView(data.buffer, data.byteOffset, data.byteLength), ifd = view.getUint32(4, true), count = view.getUint16(ifd, true);
    const tags = new Map();
    for (let i = 0; i < count; i++) { const p = ifd + 2 + i * 12; tags.set(view.getUint16(p, true), view.getUint16(p + 2, true) === 3 ? view.getUint16(p + 8, true) : view.getUint32(p + 8, true)); }
    ensure(tags.get(258) === 1, 'pattern TIFF is not true 1-bit');
    const w=tags.get(256),h=tags.get(257),start=tags.get(273),stride=Math.ceil(w/8),bits=Array.from({length:256},(_,i)=>i.toString(2).replace(/0/g,'').length);
    let black=0;for(let y=0;y<h;y++)for(let x=0;x<stride;x++){let b=data[start+y*stride+x];if(x===stride-1&&w%8)b&=0xff<<(8-w%8);black+=bits[b];}
    const plate=name.includes('6066')?'6066':'6060',material=name.includes('-pt-')?'pt':'tio2';
    const expected=f.cellAreasMm2.reduce((sum,a,i)=>sum+(((plate==='6066'?i%2===0:i%2!==0)===(material==='tio2'))?a:0),0);
    ensure(Math.abs(black*(25.4/1200)**2-expected)<Math.max(1,expected*.02),'TIFF pixels do not match the actual net patterned areas');
  }
  await writeFile(join(output, 'pattern-complete.zip'), completeBytes);

  await page.click('[data-view-mode="binding"]'); await page.screenshot({ path: join(output, 'pattern-binding.png') });
  await page.click('[data-view-mode="glass-6066"]'); await page.screenshot({ path: join(output, 'pattern-screen-bigger.png') });
  await parameter('Measured Wet Film', 0);
  ensure(await page.$eval('.title-status', (e) => e.dataset.state) === 'error', 'unknown high-volume glue scenario was silently calibrated');
  const disabled = await page.$$eval('button', (buttons) => buttons.filter((b) => /ZIP|TIFF|Save View|儲存目前/.test(b.textContent)).every((b) => b.disabled));
  ensure(disabled, 'failed pattern checks leave a manufacturing export route enabled');
  await parameter('Measured Wet Film', 15); ensure(await page.$eval('.title-status', (e) => e.dataset.state) === 'pass', 'restoring synthetic calibration did not restore valid geometry');

  const trialUrl = page.url(); await page.reload({ waitUntil: 'networkidle2' }); await ready();
  ensure(await page.$eval('[data-testid="pattern-panel"]', (e) => e.dataset.sourceId) === design.config.artwork.id, 'reload lost the actual artwork');
  await page.goto(new URL('?from=type-studio&artwork=does-not-exist', base).href, { waitUntil: 'networkidle2' });
  ensure(await page.$('.pattern-transfer-error'), 'missing transfer silently fell back to plain Voronoi');
  ensure(!errors.length, errors.join('\n'));
  await writeFile(join(output, 'result.json'), JSON.stringify({ status: 'PASS', trialUrl, vectorFiles: Object.keys(files).length, completeFiles: names.length, activeArea: f.totalActiveMm2, areaCv: f.areaCv, flow: f.pattern.flow, checks: 'real header transfer, source preservation, W material parity, active area / current, glue / channel geometry, Pt screens, DXF holes, 8 PDFs / 4 true 1-bit TIFFs, export gates, reload, missing-source error' }, null, 2));
  console.log(`Pattern → W-type browser smoke: PASS\nArtifacts: ${output}`);
} catch (error) {
  await page.screenshot({ path: join(output, 'failure.png') }); console.error(`Artifacts: ${output}`);
  console.error(await page.$eval('[data-testid="pattern-panel"]', (e) => e.innerText).catch(() => 'No pattern panel'));
  throw error;
} finally { await closeTestBrowser(browser); await server?.close(); }
