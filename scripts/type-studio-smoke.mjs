import { access, mkdtemp, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { createServer } from "vite";
import puppeteer from "puppeteer-core";

const server = process.env.APP_URL ? null : await createServer({ server: { host: "127.0.0.1", port: 0 } });
await server?.listen();
const base = process.env.APP_URL ?? server.resolvedUrls.local[0];
const executablePath = process.env.CHROME_PATH ?? "/Applications/Google Chrome.app/Contents/MacOS/Google Chrome";
await access(executablePath);
const output = await mkdtemp(join(process.env.TEST_TMPDIR ?? tmpdir(), "type-geometry-smoke-"));
const browser = await puppeteer.launch({ executablePath, headless: true, args: ["--no-sandbox"] });
const page = await browser.newPage(), errors = [];
page.on("pageerror", (error) => errors.push(String(error)));
const ensure = (condition, message) => { if (!condition) throw new Error(message); };
const ready = () => page.waitForFunction(() => document.querySelector(".tg-canvas")?.getAttribute("data-pending") === "false" && !document.querySelector('[role="alert"]'), { timeout: 60000 });
const path = () => page.$eval('path[data-set="A"]', (e) => e.getAttribute("d"));
const value = (label) => page.$eval(`[aria-label="${label}"]`, (e) => e.value);
const saved = () => page.evaluate(() => JSON.parse(localStorage.getItem("dssc-type-geometry-studio-v1")));
const settleStorage = async () => { await new Promise((resolve) => setTimeout(resolve, 650)); };
async function range(label, number) {
  await page.$eval(`[aria-label="${label}"]`, (e, v) => {
    Object.getOwnPropertyDescriptor(HTMLInputElement.prototype, "value").set.call(e, String(v));
    e.dispatchEvent(new Event("input", { bubbles: true })); e.dispatchEvent(new Event("change", { bubbles: true }));
  }, number);
  await ready();
}
async function drag(selector, dx, dy) {
  const b = await page.$eval(selector, (e) => { const r = e.getBoundingClientRect(); return { x: r.x + r.width / 2, y: r.y + r.height / 2 }; });
  await page.mouse.move(b.x, b.y); await page.mouse.down(); await page.mouse.move(b.x + dx, b.y + dy, { steps: 8 }); await page.mouse.up(); await ready();
}
try {
  await page.setViewport({ width: 1440, height: 1050 });
  await page.goto(new URL("?studio=type", base).href, { waitUntil: "networkidle2" });
  await ready();
  ensure((await page.$$('svg.tg-canvas text')).length === 0, "studio still depends on live text");
  ensure((await page.$$('svg.tg-canvas [data-cell]')).length === 0, "studio still starts with W-type cell polygons");
  await page.evaluate(() => localStorage.setItem("w-series-voronoi-layout-v6", JSON.stringify({ electrodeSeed: 555, glassHeightMm: 60 })));
  const initial = await path(); ensure(initial?.length > 500, "no resolved glyph geometry");
  await page.screenshot({ path: join(output, "fluid.png"), fullPage: false });

  await drag('[data-handle="cage-4"]', 25, 16);
  ensure(await path() !== initial, "cage drag did not change actual geometry");
  await page.click('button[aria-label="復原"]'); await ready();
  ensure(await path() === initial, "one undo did not restore the full drag transaction");

  for (const font of ["anton", "fraunces", "anybody"]) {
    await page.select('select[aria-label="字型"]', font); await ready();
    ensure((await path()).length > 500, `font ${font} has no outline`);
  }
  for (const preset of ["tall", "capsules", "squeeze"]) {
    await page.click(`[data-preset="${preset}"]`); await ready();
    ensure((await path()).length > 500, `${preset} has no resolved geometry`);
    if (preset === "capsules") await page.screenshot({ path: join(output, "capsules.png") });
  }
  await page.click('[data-tool="rows"]');
  const beforeRow = await path();
  await drag('[data-handle="row-0"]', 0, 18);
  ensure(await path() !== beforeRow, "row divider did not redistribute actual glyph heights");
  await page.click('button[aria-label="復原"]'); await ready();
  ensure(await path() === beforeRow, "row transaction undo failed");
  await page.click('[data-tool="glyph"]');
  const glyphPoint = await page.evaluate(() => {
    const svg = document.querySelector(".tg-canvas"), outline = new Path2D(svg.querySelector('[data-set="A"]').getAttribute("d"));
    const ctx = document.createElement("canvas").getContext("2d");
    for (let y = 4; y < 18; y += 0.5) for (let x = 4; x < 46; x += 0.5) {
      if (ctx.isPointInPath(outline, x, y, "evenodd")) {
        const p = new DOMPoint(x, y).matrixTransform(svg.getScreenCTM()); return { x: p.x, y: p.y };
      }
    }
  });
  ensure(glyphPoint, "no glyph pick point");
  await page.mouse.move(glyphPoint.x, glyphPoint.y); await page.mouse.down(); await page.mouse.move(glyphPoint.x + 12, glyphPoint.y + 6, { steps: 5 }); await page.mouse.up(); await ready();
  ensure(await path() !== beforeRow, "individual glyph drag did not affect geometry");
  await page.click('button[aria-label="復原"]'); await ready();
  ensure(await path() === beforeRow, "glyph edit undo failed");
  await page.click('[data-preset="flip"]'); await ready();
  const flipped = await path();
  await page.click('[data-tool="mask"]'); await drag('[data-handle="mask"]', 30, -20);
  ensure(await path() !== flipped, "mask drag changed only a preview overlay");
  await page.screenshot({ path: join(output, "shape-flip.png") });

  await page.click('[data-preset="squeeze"]'); await ready();
  const noCharacter = await path();
  await settleStorage(); const beforeCharacter = await saved();
  await page.click('input[aria-label="加入角色"]'); await ready();
  const withCharacter = await path(); ensure(withCharacter !== noCharacter, "character did not enter actual geometry");
  await page.click('input[aria-label="加入角色"]'); await ready();
  ensure(await path() === noCharacter, "character off failed to restore text / geometry");
  await settleStorage(); const afterCharacter = await saved();
  ensure(JSON.stringify(beforeCharacter.designs.fluid) === JSON.stringify(afterCharacter.designs.fluid), "character toggle reset another parameter");

  await page.click('[data-flavor="pixel"]'); await ready();
  for (const preset of ["steps", "blocks"]) {
    await page.click(`[data-preset="${preset}"]`); await ready();
    ensure((await path()).length > 500, `${preset} has no resolved geometry`);
    if (preset === "blocks") await page.screenshot({ path: join(output, "pixel-blocks.png") });
  }
  await page.click('[data-preset="cuts"]'); await ready();
  await range("局部缺口", 0.15);
  const pixelPath = await path();
  ensure(pixelPath !== noCharacter, "flavors did not change actual geometry");
  await page.screenshot({ path: join(output, "pixel-cuts.png") });
  await page.click('[data-flavor="fluid"]'); await ready();
  ensure(await path() === noCharacter, "fluid state was not retained independently");
  await page.click('[data-flavor="pixel"]'); await ready();
  ensure(await path() === pixelPath, "pixel state was not retained independently");
  ensure(await value("局部缺口") === "0.15", "pixel controls lost their values");

  await page.evaluate(() => {
    window.__downloads = [];
    const click = HTMLAnchorElement.prototype.click;
    HTMLAnchorElement.prototype.click = function () {
      if (this.download) {
        const filename = this.download;
        fetch(this.href).then(async (r) => {
          if (filename.endsWith(".png")) { const bitmap = await createImageBitmap(await r.blob()); window.__downloads.push({ filename, width: bitmap.width, height: bitmap.height }); bitmap.close(); }
          else window.__downloads.push({ filename, text: await r.text() });
        });
      }
      else click.call(this);
    };
  });
  await page.locator(".tg-exports button:nth-child(1)").click();
  await page.locator(".tg-exports button:nth-child(2)").click();
  await page.waitForFunction(() => window.__downloads.length === 2);
  const downloads = await page.evaluate(() => window.__downloads);
  const svg = downloads.find((d) => d.filename.endsWith(".svg")).text;
  ensure(!/<text|<mask|<clipPath|editor-only|non-printing-art-guide/.test(svg), "export contains unresolved effects");
  ensure(svg.includes('id="SET_A"') && svg.includes('id="SET_B"'), "missing A/B geometry");
  const geometry = JSON.parse(downloads.find((d) => d.filename.endsWith(".json")).text);
  ensure(geometry.stage === "resolved-artwork-not-fabrication" && geometry.materialMapping === null, "misleading fabrication status");
  ensure(Math.abs(geometry.stats.areaA + geometry.stats.areaB - geometry.width * geometry.height) < 1e-4, "sets fail to partition the physical area");
  const rasterArea = await page.evaluate(async ({ svg, width, height }) => {
    const image = new Image(); image.src = URL.createObjectURL(new Blob([svg], { type: "image/svg+xml" })); await image.decode();
    const canvas = document.createElement("canvas"); canvas.width = width * 10; canvas.height = height * 10;
    const ctx = canvas.getContext("2d"); ctx.fillStyle = "white"; ctx.fillRect(0, 0, canvas.width, canvas.height); ctx.drawImage(image, 0, 0, canvas.width, canvas.height);
    const rgba = ctx.getImageData(0, 0, canvas.width, canvas.height).data; let pixels = 0;
    for (let i = 0; i < rgba.length; i += 4) pixels += 1 - rgba[i] / 255;
    URL.revokeObjectURL(image.src); return pixels / 100;
  }, { svg, width: geometry.width, height: geometry.height });
  ensure(Math.abs(rasterArea - geometry.stats.areaA) < geometry.width * geometry.height * 0.01, "independent SVG raster area disagrees with polygon area / holes");

  // Save/open the actual recipe format; imports restore geometry, not only parameters for Voronoi.
  await page.locator(".tg-exports button:nth-child(3)").click();
  await page.waitForFunction(() => window.__downloads.length === 3);
  const recipeText = await page.evaluate(() => window.__downloads[2].text);
  const recipeFile = join(output, "roundtrip-recipe.json"); await writeFile(recipeFile, recipeText);
  await range("錯位距離 mm", 3.5);
  await (await page.$('input[aria-label="匯入配方"]')).uploadFile(recipeFile);
  await page.waitForFunction(() => document.querySelector('input[aria-label="錯位距離 mm"]').value === "1.4");
  await ready();
  ensure(await path() === pixelPath, "imported recipe failed to restore artwork");
  await page.locator(".tg-exports button:nth-child(4)").click();
  await page.waitForFunction(() => window.__downloads.length === 4);
  const png = await page.evaluate(() => window.__downloads[3]);
  ensure(Math.max(png.width, png.height) === 1600, "PNG viewing image has wrong dimensions");

  await page.locator(".tg-variation-head button").click();
  await page.waitForFunction(() => document.querySelectorAll("[data-variant]").length === 6, { timeout: 60000 });
  await page.click('[data-variant]'); await ready(); await settleStorage();
  const selected = await path();
  await page.reload({ waitUntil: "networkidle2" }); await ready();
  ensure(await path() === selected, "saved recipe does not reproduce its outline");
  ensure(await page.evaluate(() => JSON.parse(localStorage.getItem("w-series-voronoi-layout-v6")).electrodeSeed === 555), "studio overwrote Layout state");

  // Cursor-anchored zoom + fit are view-only.
  const viewBefore = await page.$eval(".tg-canvas", (e) => e.getAttribute("viewBox"));
  await page.hover(".tg-canvas"); await page.mouse.wheel({ deltaY: -220 });
  await page.waitForFunction((v) => document.querySelector(".tg-canvas").getAttribute("viewBox") !== v, {}, viewBefore);
  ensure(await path() === selected, "zoom changed geometry");
  await page.locator("button::-p-text(Fit)").click();

  await (await page.$('input[aria-label="匯入字型"]')).uploadFile(fileURLToPath(new URL("../node_modules/@fontsource/anybody/files/anybody-latin-900-normal.woff", import.meta.url)));
  await page.waitForFunction(() => document.querySelector('select[aria-label="字型"]').value === "custom"); await ready(); await settleStorage();
  const importedFontPath = await path();
  await page.reload({ waitUntil: "networkidle2" }); await ready();
  ensure(await value("字型") === "custom" && await path() === importedFontPath, "imported font bytes were not restored reproducibly");

  await page.setViewport({ width: 390, height: 844 });
  ensure(await page.evaluate(() => document.documentElement.scrollWidth <= 390 && document.querySelector(".tg-studio").scrollWidth <= 390), "mobile horizontal overflow");
  await page.screenshot({ path: join(output, "mobile.png"), fullPage: true });
  ensure(errors.length === 0, errors.join("\n"));
  await writeFile(join(output, "result.json"), JSON.stringify({ status: "PASS", downloads: downloads.map((d) => d.filename), assertions: "worker/fonts, outlined sets, independent flavors/character, cage/mask drag, undo, XOR, variants, persistence, view-only zoom, Layout isolation, mobile" }, null, 2));
  console.log(`Type + Geometry browser smoke: PASS\nArtifacts: ${output}`);
} catch (error) {
  await page.screenshot({ path: join(output, "failure.png"), fullPage: true });
  console.error(`Browser artifacts: ${output}`);
  console.error(await page.$eval(".tg-results", (e) => e.innerText).catch(() => "No result panel"));
  throw error;
} finally { await browser.close(); await server?.close(); }
