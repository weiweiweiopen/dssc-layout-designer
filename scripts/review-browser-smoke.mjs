import { access, mkdtemp, readFile, readdir, rename } from "node:fs/promises";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { unzipSync } from "fflate";
import puppeteer from "puppeteer-core";

const url = process.env.APP_URL ?? "http://127.0.0.1:5173";
const ensure = (value, message) => { if (!value) throw new Error(message); };
const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms));
const designKey = "w-series-voronoi-layout-v6", reviewKey = "dssc-layout-review-3d-v1";
let executablePath;
for (const path of [process.env.CHROME_PATH, "/Applications/Google Chrome.app/Contents/MacOS/Google Chrome", "/Applications/Chromium.app/Contents/MacOS/Chromium", "/usr/bin/chromium"].filter(Boolean)) {
  try { await access(path); executablePath = path; break; } catch { /* next */ }
}
ensure(executablePath, "Set CHROME_PATH to a Chrome executable.");
const directory = await mkdtemp(join(process.env.TEST_TMPDIR ?? tmpdir(), "dssc-3d-smoke-"));
const browser = await puppeteer.launch({ executablePath, headless: true,
  args: ["--no-sandbox", "--use-angle=swiftshader", "--enable-unsafe-swiftshader"] });
const errors = [], externalRequests = [], requests = [];
try {
  const page = await browser.newPage();
  await page.setViewport({ width: 1500, height: 1000, deviceScaleFactor: 1 });
  page.on("pageerror", (error) => errors.push(error.message));
  page.on("console", (message) => { if (message.type() === "error") errors.push(message.text()); });
  await page.setRequestInterception(true);
  page.on("request", (request) => {
    requests.push(request.url());
    if (/^https?:/.test(request.url()) && new URL(request.url()).origin !== new URL(url).origin) {
      externalRequests.push(request.url()); request.abort();
    } else request.continue();
  });
  const client = await page.createCDPSession();
  await client.send("Browser.setDownloadBehavior", { behavior: "allow", downloadPath: directory });
  await page.goto(url, { waitUntil: "networkidle2" });
  await page.evaluate(() => { localStorage.clear(); localStorage.setItem("dssc-layout-language", "en"); });
  await page.reload({ waitUntil: "networkidle2" });
  const ready = () => page.waitForFunction(() => document.querySelector(".title-status")?.dataset.state === "pass", { timeout: 30000 });
  const sceneReady = async () => {
    await page.waitForFunction(() => document.querySelector('[data-testid="review-canvas"]')?.dataset.state === "ready"
      && document.querySelector('[data-testid="review-canvas"]')?.dataset.cameraPose, { timeout: 60000 });
    await sleep(500);
  };
  const clickView = async (view) => {
    await page.click(`[data-view-mode="${view}"]`);
    await page.waitForFunction((value) => document.querySelector('[data-view-mode].selected')?.dataset.viewMode === value, {}, view);
  };
  const settings = () => page.evaluate((key) => JSON.parse(localStorage.getItem(key)), reviewKey);
  const pose = () => page.$eval('[data-testid="review-canvas"]', (el) => JSON.parse(el.dataset.cameraPose));
  const direction = (p) => { const d = p.position.map((v, i) => v - p.target[i]); const n = Math.hypot(...d); return d.map((v) => v / n); };
  const difference = (a, b) => Math.hypot(...a.map((v, i) => v - b[i]));
  const sceneImage = async () => Buffer.from(await (await page.$('[data-testid="review-canvas"]')).screenshot());
  const engineering = () => page.evaluate((key) => ({ config: localStorage.getItem(key),
    current: document.querySelector('[data-testid="electrical-estimate"]')?.dataset.iscMa,
    area: document.querySelector('[data-testid="coating-clearance"]')?.dataset.totalActiveMm2,
  }), designKey);
  let bundleSequence = 0;
  const bundle = async () => {
    const before = new Set(await readdir(directory));
    ensure(await page.evaluate(() => {
      const button = [...document.querySelectorAll("button")].find((b) => b.textContent.trim() === "Export Vector ZIP");
      if (!button || button.disabled) return false; button.click(); return true;
    }), "Vector export is unavailable");
    const end = Date.now() + 60000;
    while (Date.now() < end) {
      const name = (await readdir(directory)).find((n) => n.endsWith(".zip") && !before.has(n));
      if (name) {
        await sleep(200);
        const result = unzipSync(await readFile(join(directory, name)));
        await rename(join(directory, name), join(directory, `vector-${++bundleSequence}.zip`));
        return result;
      }
      await sleep(100);
    }
    throw new Error("Vector download timed out");
  };
  await ready();
  ensure(!requests.some((r) => /\/Review3D-[^/]+\.js/.test(r)), "3D bundle was eagerly loaded on the 2D page");
  const beforeEngineering = await engineering();
  const beforeSvg = await page.$eval(".preview-frame", (el) => el.innerHTML);
  const beforeBundle = await bundle();
  await clickView("review-3d"); await sceneReady();
  ensure(await page.$eval('[data-testid="review-canvas"]', (el) => Number(el.dataset.layerCount) === 11), "Incomplete canonical stack");
  const initialImage = await sceneImage();
  await page.screenshot({ path: join(directory, "3d-assembled-en.png") });
  await page.select('[data-review-dye="bigger"]', "blue");
  await page.select('[data-review-dye="smaller"]', "amber"); await sleep(300);
  ensure((await settings()).biggerDye === "blue" && (await settings()).smallerDye === "amber", "Dyes are not independent");
  ensure(!initialImage.equals(await sceneImage()), "Dyes did not change rendered WebGL appearance");
  await page.$eval('[data-review-color="bigger"]', (input) => {
    const setter = Object.getOwnPropertyDescriptor(HTMLInputElement.prototype, "value").set;
    setter.call(input, "#118833"); input.dispatchEvent(new Event("input", { bubbles: true })); input.dispatchEvent(new Event("change", { bubbles: true }));
  });
  await sleep(200);
  ensure((await settings()).biggerDye === "custom" && (await settings()).biggerColor === "#118833" && (await settings()).smallerDye === "amber", "Custom dye changed the other electrode");

  const drag = async (button, shift = false) => {
    const box = await (await page.$('[data-testid="review-canvas"]')).boundingBox();
    await page.mouse.move(box.x + box.width * 0.5, box.y + box.height * 0.55);
    if (shift) await page.keyboard.down("Shift");
    await page.mouse.down({ button });
    await page.mouse.move(box.x + box.width * 0.5 + 55, box.y + box.height * 0.55 + 30, { steps: 10 });
    await page.mouse.up({ button });
    if (shift) await page.keyboard.up("Shift");
    await sleep(900);
  };
  const orbitBefore = await pose(); await drag("middle");
  ensure(difference(direction(orbitBefore), direction(await pose())) > 0.01, "Middle-drag did not orbit");
  const panBefore = await pose(); await drag("middle", true); const panAfter = await pose();
  ensure(difference(panBefore.target, panAfter.target) > 1 && difference(direction(panBefore), direction(panAfter)) < 0.001,
    `Shift-middle did not pan while retaining orientation: ${JSON.stringify({ panBefore, panAfter })}`);
  const zoomBefore = await pose(); await page.mouse.wheel({ deltaY: -240 }); await sleep(800);
  const zoomAfter = await pose();
  ensure(difference(zoomAfter.position, zoomAfter.target) < difference(zoomBefore.position, zoomBefore.target), "Wheel did not zoom in");
  for (const [view, expected] of [["top", [0, 0, 1]], ["front", [0, -1, 0]], ["side", [1, 0, 0]]]) {
    await page.click(`[data-review-view="${view}"]`); await sleep(500);
    ensure(difference(direction(await pose()), expected) < 0.002, `Incorrect ${view} camera`);
  }
  await page.click('[data-testid="review-projection"]'); await sleep(500);
  ensure((await pose()).projection === "orthographic", "Orthographic projection did not activate");
  await page.click('[data-review-view="iso"]'); await sleep(500);
  await page.focus('[data-testid="review-explode"]'); await page.keyboard.press("End"); await sleep(500);
  ensure((await settings()).explodeMm === 15, "Explosion slider did not reach 15 mm");
  const allLayers = Number(await page.$eval('[data-testid="review-canvas"]', (el) => el.dataset.layerCount));
  await page.click('[data-review-toggle="smaller"]');
  ensure(Number(await page.$eval('[data-testid="review-canvas"]', (el) => el.dataset.layerCount)) === allLayers - 4, "Plate visibility did not hide all its layers");
  await page.click('[data-review-toggle="smaller"]');
  await page.click('[data-review-toggle="glass"]');
  ensure(Number(await page.$eval('[data-testid="review-canvas"]', (el) => el.dataset.layerCount)) === allLayers - 2, "Glass toggle changed wrong layers");
  await page.click('[data-review-toggle="glass"]');
  await page.screenshot({ path: join(directory, "3d-exploded-en.png") });
  const beforeLocale = await pose(), storedBeforeLocale = await settings();
  await page.click('[data-testid="language-zh-TW"]'); await sleep(300);
  ensure(JSON.stringify(await pose()) === JSON.stringify(beforeLocale) && JSON.stringify(await settings()) === JSON.stringify(storedBeforeLocale),
    `Language switch reset 3D camera or appearance: ${JSON.stringify({ beforeLocale, afterLocale: await pose(), storedBeforeLocale, storedAfterLocale: await settings() })}`);
  ensure(await page.$eval('.review-settings h2', (el) => el.textContent.includes("染料外觀")), "Chinese 3D interface missing");
  await page.screenshot({ path: join(directory, "3d-exploded-zh-TW.png") });
  await page.click('[data-testid="language-en"]');
  ensure(await page.$eval('[data-testid="review-3d"]', (el) => !/[\u3400-\u9fff]/.test(el.textContent)), "Mixed-language English 3D interface");
  await page.click('[data-testid="seal-stage-toggle"]');
  await clickView("binding");
  await page.waitForFunction(() => document.querySelector("#BINDING_MASK")?.dataset.sealStage === "compression-scenario");
  await clickView("review-3d"); await sceneReady();
  ensure(await page.$eval('[data-testid="seal-stage-toggle"]', (el) => el.checked), "3D did not share the seal-stage state");
  await page.click('[data-testid="seal-stage-toggle"]');
  ensure(JSON.stringify(await engineering()) === JSON.stringify(beforeEngineering), "Appearance changed engineering configuration, area or current");
  const afterBundle = await bundle();
  ensure(Object.keys(beforeBundle).length === 20 && Object.keys(afterBundle).length === 20 &&
    Object.entries(beforeBundle).every(([name, data]) => afterBundle[name] && Buffer.from(data).equals(Buffer.from(afterBundle[name]))),
  "3D appearance or preview stage altered exported vector file contents");
  await clickView("assembly");
  await page.waitForSelector(".preview-frame svg"); await sleep(200);
  ensure(await page.$eval(".preview-frame", (el, before) => el.innerHTML === before, beforeSvg), "Returning from 3D changed the 2D SVG");
  const oldTransform = await page.$eval(".preview-camera", (el) => el.style.transform);
  const box = await (await page.$(".preview-workspace")).boundingBox();
  await page.mouse.move(box.x + box.width / 2, box.y + box.height / 2); await page.mouse.wheel({ deltaY: -100 }); await sleep(200);
  ensure(await page.$eval(".preview-camera", (el, old) => el.style.transform !== old, oldTransform), "2D wheel listener did not reconnect after 3D");
  await page.reload({ waitUntil: "networkidle2" }); await ready();
  await clickView("review-3d"); await sceneReady();
  ensure(JSON.stringify(await settings()) === JSON.stringify(storedBeforeLocale), "Appearance did not persist across tab switches / reload");
  await page.setViewport({ width: 520, height: 900, deviceScaleFactor: 1 }); await sleep(500);
  ensure(await page.$eval('[data-testid="review-canvas"]', (el) => el.getBoundingClientRect().height >= 250), "Mobile 3D canvas is collapsed");
  await page.$eval('[data-testid="review-3d"]', (el) => el.scrollIntoView());
  await page.screenshot({ path: join(directory, "3d-mobile.png") });
  ensure(externalRequests.length === 0, `3D relies on external resources: ${externalRequests.join(", ")}`);
  ensure(errors.length === 0, `Browser errors: ${errors.join("; ")}`);
  const unavailable = await browser.newPage();
  await unavailable.evaluateOnNewDocument(() => {
    const getContext = HTMLCanvasElement.prototype.getContext;
    HTMLCanvasElement.prototype.getContext = function (kind, ...args) {
      return /^webgl|^experimental-webgl/.test(kind) ? null : getContext.call(this, kind, ...args);
    };
  });
  await unavailable.goto(url, { waitUntil: "networkidle2" });
  await unavailable.$eval('[data-view-mode="review-3d"]', (button) => button.click());
  await unavailable.waitForFunction(() => document.querySelector('.review-placeholder')?.textContent.includes("WebGL"), { timeout: 30000 });
  await unavailable.$eval('[data-view-mode="assembly"]', (button) => button.click());
  await unavailable.waitForSelector('.preview-frame svg[data-view="assembly"]');
  await unavailable.close();
  console.log(`PASS: 3D WebGL rendering, independent dyes, camera gestures, preset views, projections, layers, bilingual persistence, responsive layout and byte-identical 20-file vector exports. Screenshots: ${directory}`);
} catch (error) {
  console.error(`3D browser check failed. Artifacts: ${directory}. Browser errors:`, errors);
  const page = (await browser.pages()).at(-1);
  if (page) await page.screenshot({ path: join(directory, "failure.png") }).catch(() => {});
  throw error;
} finally { await browser.close(); }
