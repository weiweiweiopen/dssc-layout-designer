import { access, mkdtemp, readFile, readdir, rm } from "node:fs/promises";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { strFromU8, unzipSync } from "fflate";
import puppeteer from "puppeteer-core";

const url = process.env.APP_URL ?? "http://127.0.0.1:5173";
const storageKey = "w-series-voronoi-layout-v6";
const temporaryRoot = process.env.TEST_TMPDIR ?? tmpdir();
const ensure = (condition, message) => { if (!condition) throw new Error(message); };
const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms));
let executablePath;
for (const p of [process.env.CHROME_PATH, "/Applications/Google Chrome.app/Contents/MacOS/Google Chrome", "/Applications/Chromium.app/Contents/MacOS/Chromium", "/usr/bin/chromium"].filter(Boolean)) {
  try { await access(p); executablePath = p; break; } catch { /* next */ }
}
ensure(executablePath, "Chrome not found. Set CHROME_PATH.");
const directory = await mkdtemp(join(temporaryRoot, "dssc-v6-smoke-"));
const errors = [];
const browser = await puppeteer.launch({ executablePath, headless: true, args: ["--no-sandbox", "--disable-gpu"] });
try {
  const page = await browser.newPage();
  await page.setViewport({ width: 1440, height: 1000, deviceScaleFactor: 1 });
  page.on("pageerror", (e) => errors.push(e.message));
  const client = await page.createCDPSession();
  await client.send("Browser.setDownloadBehavior", { behavior: "allow", downloadPath: directory });
  await page.goto(url, { waitUntil: "networkidle2" });
  await page.evaluate(() => { localStorage.clear(); localStorage.setItem("dssc-layout-language", "en"); });
  await page.reload({ waitUntil: "networkidle2" });
  const ready = () => page.waitForFunction(() => document.querySelector(".title-status")?.dataset.state === "pass" && !document.querySelector(".preview-frame.pending"), { timeout: 30000 });
  await ready();
  const button = async (label) => {
    ensure(await page.evaluate((text) => {
      const b = [...document.querySelectorAll("button")].find((b) => b.textContent.trim() === text);
      if (!b || b.disabled) return false;
      b.click(); return true;
    }, label), `Unavailable button: ${label}`);
  };
  const field = async (label, value) => {
    ensure(await page.evaluate((text) => {
      const i = [...document.querySelectorAll("label.form-row")].find((r) => r.dataset.parameter === text)?.querySelector("input");
      if (!i) return false; i.focus(); i.select(); return true;
    }, label), `Missing field ${label}`);
    await page.keyboard.press("Backspace");
    await page.keyboard.type(String(value));
    await page.keyboard.press("Enter");
    await sleep(200);
    await page.waitForFunction(() => !document.querySelector(".preview-frame.pending"), { timeout: 30000 });
  };
  const config = () => page.evaluate((key) => JSON.parse(localStorage.getItem(key)), storageKey);
  const select = async (label, value) => {
    await page.select(`[data-parameter="${label}"] select`, value);
    await sleep(200); await ready();
  };
  ensure(await page.evaluate(() => !document.querySelector("textarea") && !/OVERLAP/.test(document.body.textContent)), "Removed UI is still present");
  const original = await config();
  // One app / one design: locale changes must not regenerate the geometry,
  // reset view/camera/stage, or even commit an in-progress numeric draft.
  await button("Binding");
  await page.waitForFunction(() => document.querySelector('.preview-frame svg[data-view="binding"]'));
  await page.click('[data-testid="seal-stage-toggle"]');
  await page.waitForFunction(() => document.querySelector('#BINDING_MASK')?.dataset.sealStage === "compression-scenario");
  const work = await page.$(".preview-workspace");
  const bounds = await work.boundingBox();
  await page.mouse.move(bounds.x + bounds.width / 2, bounds.y + bounds.height / 2);
  await page.mouse.wheel({ deltaY: -200 }); await sleep(100);
  const snapshot = () => page.evaluate((key) => ({
    config: localStorage.getItem(key), svg: document.querySelector(".preview-frame").innerHTML,
    camera: document.querySelector(".preview-camera").style.transform,
    mode: document.querySelector("[data-view-mode].selected")?.dataset.viewMode,
    stage: document.querySelector('[data-testid="seal-stage-toggle"]')?.checked,
  }), storageKey);
  const designBeforeLocale = await snapshot();
  await page.focus('[data-parameter="Coating Safety Gap"] input');
  await page.$eval('[data-parameter="Coating Safety Gap"] input', (el) => el.select());
  await page.keyboard.type("0.25");
  await page.click('[data-testid="language-zh-TW"]');
  await page.waitForFunction(() => document.documentElement.lang === "zh-TW");
  ensure(JSON.stringify(await snapshot()) === JSON.stringify(designBeforeLocale), "Chinese switch changed design, SVG, camera, mode or seal stage");
  ensure(await page.$eval('[data-parameter="Coating Safety Gap"] input', (el) => el.value === "0.25"),
    "Language switch lost an uncommitted numeric draft");
  ensure(await page.$eval('[data-parameter="Coating Safety Gap"] > span', (el) => el.textContent === "塗層安全間距"),
    "Chinese parameter labels were not applied");
  await page.keyboard.press("Escape");
  await page.click('[data-testid="language-en"]');
  await page.waitForFunction(() => document.documentElement.lang === "en");
  ensure(JSON.stringify(await snapshot()) === JSON.stringify(designBeforeLocale), "English switch regenerated the design");
  ensure(await page.evaluate(() => {
    const clone = document.body.cloneNode(true); clone.querySelector(".language-switch")?.remove();
    return !/[\u3400-\u9fff]/.test(clone.textContent);
  }), "English interface still contains Chinese visible text");
  await page.click('[data-testid="language-zh-TW"]');
  await page.reload({ waitUntil: "networkidle2" }); await ready();
  ensure(await page.evaluate(() => document.documentElement.lang === "zh-TW" && localStorage.getItem("dssc-layout-language") === "zh-TW"),
    "Language preference did not survive reload");
  await page.$eval(".sidebar-panel", (el) => { el.scrollTop = 0; });
  await page.screenshot({ path: join(directory, "interface-zh-TW.png") });
  await page.click('[data-testid="language-en"]'); await ready();
  await page.screenshot({ path: join(directory, "interface-en.png") });
  ensure(await page.evaluate(() => {
    const rows = [...document.querySelectorAll("label.form-row")];
    return ["Shared Glass Height", "Bigger Electrode W", "Smaller Electrode W"]
      .every((label) => rows.some((r) => r.dataset.parameter === label)) &&
      !rows.some((r) => /Electrode H$/.test(r.dataset.parameter)) &&
      rows.every((r) => r.dataset.help?.length > 20 && r.querySelector("input, select")?.getAttribute("aria-describedby")) &&
      !document.querySelector(".parameter-note, [role=tooltip]");
  }), "Role-based names or per-parameter help missing; old permanent notes remain");
  await field("Shared Glass Height", 64);
  await field("Bigger Electrode W", 70);
  await field("Smaller Electrode W", 58);
  await page.waitForFunction(() => {
    const contacts = [...document.querySelectorAll('#ASSEMBLY_ZEBRA_CONTACTS > g')];
    return contacts.length === 2 && contacts.every((g) => Number(g.dataset.stripWidthMm) === 6 &&
      Number(g.dataset.stripHeightMm) === 64 && Math.abs(Number(g.dataset.areaMm2) - 384) < 1e-6);
  });
  ensure(await page.evaluate(() => [...document.querySelectorAll('[data-testid="assembly-contacts"] [data-area-mm2]')]
    .every((el) => Math.abs(Number(el.dataset.areaMm2) - 384) < 1e-6)), "Contact readout does not follow resized exposed FTO");
  await page.screenshot({ path: join(directory, "assembly-zebra-resized.png") });
  await button("Screen Smaller");
  await page.waitForFunction(() => document.querySelector('.preview-frame svg[data-view="glass-6060"]')?.getAttribute("viewBox") === "0 0 58 64");
  await button("Screen Bigger");
  await page.waitForFunction(() => document.querySelector('.preview-frame svg[data-view="glass-6066"]')?.getAttribute("viewBox") === "0 0 70 64");
  await button("Final Assembly");
  await field("Smaller Electrode W", 70);
  await page.waitForFunction(() => document.querySelector('.warning-stack [data-code="contact-exposure"]'));
  ensure(await page.evaluate(() => document.querySelectorAll('#ASSEMBLY_ZEBRA_CONTACTS > g').length === 0),
    "Equal glass widths still display fictitious zebra contact area");
  await button("Reset"); await ready();
  await field("Bigger Electrode W", 70);
  await field("Electrical Cells", 6);
  await field("Seed", 4361322);
  await field("Screen Mesh", 140);
  await field("Wire Diameter", 14);
  await field("Binding Width", 1);
  await page.waitForFunction(() => {
    const el = document.querySelector('[data-testid="coating-clearance"]');
    return Number(el?.dataset.totalActiveMm2) > 2136.6 && Number(el?.dataset.scenarioMm) >= 0.19999;
  });
  await page.screenshot({ path: join(directory, "uniform-coating-screenshot-settings.png") });
  await button("Reset"); await ready();
  const d90 = await page.$('[data-parameter="Bead D90 (assumed)"]');
  await d90.scrollIntoView(); await d90.hover();
  await page.waitForSelector('[role="tooltip"]');
  ensure(await page.evaluate(() => {
    const tip = document.querySelector('[role="tooltip"]'), box = tip.getBoundingClientRect();
    return tip.textContent.includes("same bead batch") && /not a second bead type/i.test(tip.textContent) &&
      tip.parentElement === document.body && box.left >= 0 && box.top >= 0 &&
      box.right <= innerWidth && box.bottom <= innerHeight;
  }), "D90 tooltip is missing, misleading, or clipped by the sidebar / viewport");
  await page.keyboard.press("Escape");
  await page.waitForFunction(() => !document.querySelector('[role="tooltip"]'));
  await page.focus('[data-parameter="Area Balance"] input');
  await page.waitForFunction(() => document.querySelector('[role="tooltip"]')?.textContent.includes("no longer trims"));
  await page.keyboard.press("Escape");
  await page.waitForFunction(() => !document.querySelector('[role="tooltip"]'));
  const electricalReadout = () => page.evaluate(() => {
    const e = document.querySelector('[data-testid="electrical-estimate"]');
    return { iscMa: e.dataset.iscMa === "" ? null : Number(e.dataset.iscMa),
      ftoIscMa: e.dataset.ftoIscMa === "" ? null : Number(e.dataset.ftoIscMa),
      area: Number(e.dataset.minAreaMm2), cell: Number(e.dataset.limitingCell) };
  });
  ensure(original.referenceAreaMm2 === 3025 && original.referenceLightMode === "same-light",
    "Confirmed 55x55 area and same-reference-light defaults are missing");
  const referenceElectrical = await electricalReadout();
  ensure(Math.abs(referenceElectrical.iscMa - 39 * referenceElectrical.area / 3025) < 1e-9 && referenceElectrical.ftoIscMa === null,
    "Reference scaling is wrong, or unpaired website voltage is silently fitted as an I–V curve");
  ensure(await page.evaluate(() => document.querySelector('[data-testid="voltage-observation"]')?.textContent.includes("497.10") &&
    document.querySelector('[data-testid="voltage-observation"]')?.dataset.currentPaired === "false" &&
    !document.querySelector('[data-parameter="Irradiance"]')),
    "Online voltage provenance is missing or same-light mode implies a known mW/cm² input");
  await select("Voltage Observation", "a-2026-10-25");
  ensure(Math.abs((await electricalReadout()).iscMa - referenceElectrical.iscMa) < 1e-9 &&
    await page.$eval('[data-testid="voltage-observation"]', (el) => el.textContent.includes("328.63")),
    "Voltage aging was converted into an unsupported Isc aging factor");
  await select("Reference Light Mode", "lux-ratio");
  ensure((await electricalReadout()).iscMa === null, "Online Voc lux was substituted for missing Isc-paired lux");
  await field("Isc Reference Lux", 1000); await ready();
  await field("Target Illuminance", 500); await ready();
  ensure(Math.abs((await electricalReadout()).iscMa - referenceElectrical.iscMa / 2) < 1e-9,
    "Explicit same-spectrum lux ratio is not applied correctly");
  await button("Use DSSC 55×55 A reference"); await ready();
  await page.$eval('[data-parameter="Reference Active Area"]', (el) => el.scrollIntoView());
  await page.keyboard.press("Escape");
  await page.screenshot({ path: join(directory, "reference-fto-estimate.png") });
  const ftoR = () => page.$eval('[data-testid="fto-resistance"]', (el) => Number(el.dataset.totalOhm));
  const r15 = await ftoR();
  await select("Bigger FTO Grade", "tec7");
  ensure((await config()).ftoBiggerOhmSq === 7 && (await config()).ftoSmallerOhmSq === 13 && await ftoR() < r15,
    "TEC grade does not affect resistance independently on the two plates");
  await field("Bigger FTO Rs", 9); await ready();
  ensure((await config()).ftoBiggerPreset === "custom", "Manual sheet resistance still claims a TEC preset");
  await button("Reset"); await ready();
  await select("Current Basis", "jsc-input");
  await select("Voltage Observation", "manual");
  const baseElectrical = await electricalReadout();
  await field("Cell Jsc @100", 15); await ready();
  const jscElectrical = await electricalReadout();
  ensure(Math.abs(jscElectrical.iscMa - jscElectrical.area / 100 * 15) < 1e-9 &&
    Math.abs(jscElectrical.iscMa / baseElectrical.iscMa - 1.5) < 1e-9 && jscElectrical.cell > 0,
    "UI Isc does not use the limiting cell at the entered Jsc");
  await field("Irradiance", 50); await ready();
  ensure(Math.abs((await electricalReadout()).iscMa - jscElectrical.iscMa / 2) < 1e-9,
    "Isc irradiance scaling is incorrect");
  const lowFtoCurrent = (await electricalReadout()).ftoIscMa;
  await field("Bigger FTO Rs", 500); await ready();
  await field("Smaller FTO Rs", 500); await ready();
  ensure((await electricalReadout()).ftoIscMa < lowFtoCurrent,
    "FTO resistance is displayed but not connected to the Isc scenario");
  await button("Reset"); await ready();
  ensure(original.beadDiameterUm === 15 && original.beadGradeMesh === 1000 && original.screenMeshPerInch === 200, "Bead and screen defaults conflated");
  await field("Screen Mesh", 140);
  await field("Wire Diameter", 14);
  await field("Binding Width", 1);
  ensure(await page.evaluate(() => document.querySelector(".title-status").dataset.state === "error" &&
    document.body.textContent.includes("10.83") && document.body.textContent.includes("underfill") &&
    document.body.textContent.includes("INVALID")), "Screenshot underfill was misreported as zero-spread safety");
  await button("Binding");
  await page.waitForFunction(() => document.querySelector('.preview-frame svg[data-view="binding"]'));
  await page.screenshot({ path: join(directory, "screenshot-settings-underfill.png") });
  const screenshotAperture = await page.evaluate(() => {
    const el = document.querySelector('[data-testid="binding-aperture"]');
    return { printGapMm: Number(el.dataset.printGapMm), filmUm: Number(el.dataset.sizingFilmUm), source: el.dataset.sizingSource };
  });
  ensure(screenshotAperture.printGapMm > 1 && screenshotAperture.source === "unmeasured-screen-charge",
    "Screenshot settings still use the nominal 0.32 transfer to make a tiny aperture");
  ensure(await page.evaluate(() => document.querySelector('[data-testid="binding-aperture"]').textContent.includes("Actual pressed opening: NOT MEASURED")),
    "The scenario opening is still presented as a physical measurement");
   await button("Etch Bigger");
  await page.waitForFunction(() => document.querySelector('.preview-frame svg[data-view="etch-6066"]') &&
    document.querySelector('[data-testid="terminal-check"]')?.getAttribute("data-isolated") === "true");
  ensure(await page.evaluate(() => document.querySelectorAll('.preview-frame #FTO_ETCH_6066 path[data-source="voronoi-bleed"]').length > 0 &&
    !document.querySelector('.preview-frame path[data-source="active-perimeter"], .preview-frame path[data-source="terminal-isolation"]')),
    "Voronoi bleed is missing or an etch frame is still present");
  ensure(await page.evaluate(() => ["left", "right"].every((side) =>
    document.querySelectorAll(`.preview-frame #FTO_ETCH_6066 path[data-shared-side="${side}"]`).length === 1)),
    "The marked side regions still have multiple bleed rays");
  ensure(await page.evaluate(() => {
    const frame = document.querySelector(".preview-frame"), svg = frame.querySelector("svg");
    const css = getComputedStyle(frame), a = frame.getBoundingClientRect(), b = svg.getBoundingClientRect();
    return parseFloat(css.paddingTop) === 0 && parseFloat(css.borderTopWidth) === 0 &&
      Math.abs(a.width - b.width) < 0.1 && Math.abs(a.height - b.height) < 0.1 &&
      !svg.querySelector('[fill="#eeeeee"], [fill="#dddddd"]') &&
      document.querySelector('[data-testid="glass-boundary"]').textContent.includes("NO ETCH FRAME");
  }), "Preview has an artboard border / inset, or fails to identify the real glass edge");
  await page.screenshot({ path: join(directory, "etch-6066-strip-isolation.png") });
   await button("Etch Smaller");
  await page.waitForFunction(() => document.querySelector('.preview-frame svg[data-view="etch-6060"]'));
  ensure(await page.evaluate(() => document.querySelector('.preview-frame svg').getAttribute("viewBox") === "0 0 60 60" &&
    document.querySelector('[data-testid="glass-boundary"]').textContent.includes("NO ETCH FRAME")),
    "6060 glass range / full-height routes are unclear");
  await page.screenshot({ path: join(directory, "etch-6060-glass-edge.png") });
   await button("Etch Bigger");
  await field("Measured Wet Film", 20);
  const recommended = await page.evaluate(() => [...document.querySelectorAll("button")].find((b) => b.textContent.startsWith("Apply print-size estimate"))?.textContent.trim());
  await button(recommended); await ready();
  await field("Electrical Cells", 4); await ready();
  await field("Print Gap Floor", 2); await ready();
  ensure(await page.evaluate(() => Number(document.querySelector('[data-testid="binding-aperture"]').dataset.printGapMm) >= 2 - 1e-6),
    "Requested print-gap floor was silently reduced");
  ensure((await config()).bindingWidthMm < 0.5, "Submillimetre print-width estimate still has a hidden 1.5 mm target");
  await field("Bead Grade (linked)", 2000);
  ensure((await config()).beadDiameterUm === 7.5 && (await config()).beadD90Um === 10, "Bead grade / diameter did not link");
  await field("Bead D50 / Gap", 15);
  ensure((await config()).beadGradeMesh === 1000, "Diameter did not update grade in reverse");
  await page.evaluate((old) => {
    const legacy = { ...old, bindingWidthMm: 1.5, screenMeshPerInch: 140, screenWireUm: 14,
      referenceAreaMm2: 0, cellVocV: 0.7, glass6066HeightMm: 64, glass6060HeightMm: 54 };
    delete legacy.glassHeightMm;
    delete legacy.referenceVoltageObservation;
    delete legacy.referenceLightMode;
    localStorage.setItem("w-series-voronoi-layout-v5", JSON.stringify(legacy));
    localStorage.removeItem("w-series-voronoi-layout-v6");
  }, original);
  await page.reload({ waitUntil: "networkidle2" });
  await page.waitForSelector(".classic-window");
  ensure((await config()).bindingWidthMm === 1.5 && (await config()).screenMeshPerInch === 140,
    "Migration silently replaced manual dimensions");
  ensure((await config()).glassHeightMm === 64 && !Object.hasOwn(await config(), "glass6066HeightMm") &&
    !Object.hasOwn(await config(), "glass6060HeightMm"), "Legacy two-height config was not migrated to one shared height");
  ensure((await config()).referenceAreaMm2 === 3025 && (await config()).referenceLightMode === "same-light" &&
    (await config()).referenceVoltageObservation === "manual" && (await config()).cellVocV === 0.7,
    "Legacy reference migration overwrote manual voltage or did not adopt the confirmed unknown-area replacement");
   ensure(await page.evaluate(() => document.body.textContent.includes("underfill")), "Migrated underfill was not flagged");
  await button("Reset"); await ready();
  await field("Screen Mesh", 400);
  ensure(await page.evaluate(() => document.querySelector(".title-status").dataset.state === "error" && document.querySelector(".warning-stack").textContent.includes("D90")), "Unprintable bead / screen combination was not detected");
  await button("Reset"); await ready();
  await field("FTO Etch Width", 7);
  ensure((await config()).ftoEtchWidthMm === 5, "Etch width does not clamp to 5 mm");
  await button("Reset"); await ready();
  await field("Binding Width", 99);
  ensure((await config()).bindingWidthMm <= 5, "Manual seal width exceeded upper limit");
  await button("Reset"); await ready();
  await field("Area Balance", 0); await ready();
  const unbalancedArea = (await electricalReadout()).area;
  const unbalancedCv = await page.$eval('[data-testid="active-area"]', (el) => Number(el.dataset.areaCv));
  await field("Area Balance", 1); await ready();
  ensure((await electricalReadout()).area > unbalancedArea &&
    await page.$eval('[data-testid="active-area"]', (el) => Number(el.dataset.areaCv)) < unbalancedCv,
    "Site-only balancing did not improve the weakest cell and residual area variation");
  const beforeGap = await page.$eval('[data-testid="coating-clearance"]', (el) => Number(el.dataset.totalActiveMm2));
  await field("Coating Safety Gap", 0.4); await ready();
  ensure(await page.$eval('[data-testid="coating-clearance"]', (el) => Number(el.dataset.scenarioMm)) >= 0.49999 &&
    await page.$eval('[data-testid="coating-clearance"]', (el) => Number(el.dataset.totalActiveMm2)) < beforeGap,
    "Safety-gap control is not connected to the coating geometry / active-area readout");
  await button("Reset"); await ready();
  const download = async (label) => {
    const before = new Set(await readdir(directory));
    await button(label);
    let path;
    for (let i = 0; i < 300; i++) {
      path = (await readdir(directory)).find((name) => !before.has(name) && name.endsWith(".zip"));
      if (path) break;
      await sleep(100);
    }
    ensure(path, "ZIP download timed out");
    await ready();
    const data = unzipSync(new Uint8Array(await readFile(join(directory, path))));
    await rm(join(directory, path));
    return data;
  };
  const referenceVector = await download("Export Vector ZIP");
  await page.click('[data-testid="language-zh-TW"]');
  await page.waitForFunction(() => document.documentElement.lang === "zh-TW");
  const chineseVector = await download("匯出向量 ZIP");
  ensure(Object.keys(referenceVector).length === Object.keys(chineseVector).length &&
    Object.entries(referenceVector).every(([name, data]) => chineseVector[name] && strFromU8(data) === strFromU8(chineseVector[name])),
    "Language selection changed design data or fabrication/reference file contents");
  await page.click('[data-testid="language-en"]'); await ready();
  const publishedReference = JSON.parse(strFromU8(referenceVector["process-estimates.json"])).electrical;
  ensure(publishedReference.voltageObservation.sampleId === "green_proofs_are_not_always_about_tax_write-offs_1" &&
    publishedReference.calibration.referenceAreaMm2 === 3025 && publishedReference.effectiveJscMaCm2 === null &&
    publishedReference.calibration.referenceIrradianceMwCm2 === null && publishedReference.scenario === null &&
    Math.abs(publishedReference.iscMa - publishedReference.minimumAreaMm2 / 3025 * 39) < 1e-9,
    "Export does not preserve A's voltage-only provenance and unknown absolute irradiance");
  await select("Current Basis", "jsc-input");
  await select("Voltage Observation", "manual");
  const vector = await download("Export Vector ZIP");
  ensure(strFromU8(referenceVector["svg-production/binding-mask.svg"]) === strFromU8(vector["svg-production/binding-mask.svg"]),
    "Electrical reference / voltage observation changed the production seal geometry");
  ensure(Object.keys(vector).length === 20, "Vector bundle count differs from 20");
  const project = JSON.parse(strFromU8(vector["design.json"]));
  const f = project.geometry.fabrication;
  ensure(f.coatingClearance.method === "parallel-wall-offset-no-trimming" &&
    f.coatingClearance.perCell.every((r) => r.printedMm >= f.coatingClearance.printedRequiredMm - 0.00001 &&
      r.scenarioMm >= f.coatingClearance.scenarioRequiredMm - 0.00001),
    "Exported coating polygons do not preserve the shared glue clearance");
  ensure(project.format === "w-series-dssc-project-v9" && f.errors.length === 0 &&
    project.config.glassHeightMm === project.geometry.glass6066.height && project.config.glassHeightMm === project.geometry.glass6060.height,
    "Exported project does not use the v9 shared-height model");
  ensure(project.zebraContactReference.length === 2 && project.zebraContactReference.every((r) => Math.abs(r.areaMm2 - 180) < 1e-6) &&
    strFromU8(vector["svg-layered/assembly-preview.svg"]).includes("ASSEMBLY_ZEBRA_CONTACTS") &&
    !Object.keys(vector).filter((p) => p.startsWith("svg-production/")).some((p) => strFromU8(vector[p]).includes("ASSEMBLY_ZEBRA_CONTACTS")),
    "Zebra contact references are missing from Assembly or leaked into production artwork");
  ensure(f.compressionValid && f.volumeSpreadMm < 0.01 && f.openingScenario.volumeSpreadMm > f.volumeSpreadMm,
    "Nominal film and unmeasured stress scenario are not distinguished");
  ensure(f.ports.every((p) => p.finalWidthMm >= project.config.minimumOpenMm - 0.002), "Actual compressed channel fell below requested width");
  ensure(project.config.bindingWidthMm < 0.5 && project.config.beadDiameterUm === 15, "Default planar and thickness dimensions are wrong");
  ensure(Object.values(f.terminalCheck).every(Boolean), "Whole-plate terminal connectivity check failed");
  ensure(f.ports.length > 0 && f.totalActiveMm2 > 0, "No real fill slots / active area");
  ensure(strFromU8(vector["manufacturing-layout.dxf"]).includes("AcDbHatch"), "DXF has no opened seal hatches");
  for (const suffix of ["6066", "6060"]) {
    const etch = strFromU8(vector[`svg-production/fto-etch-glass-${suffix}.svg`]);
    ensure(!/GUIDES_NON_PRINTING|<text/.test(etch), "Non-printing outlines leaked into production etch");
    ensure((etch.match(/data-source="voronoi-bleed"/g) ?? []).length > 0 &&
      !/data-source="active-perimeter"|data-source="terminal-isolation"|data-source="contact-strip-isolation"/.test(etch), "Etch has no bleed or still contains a frame");
    const screen = strFromU8(vector[`svg-production/screen-glass-${suffix}-tio2.svg`]);
    ensure(!/<circle/.test(screen), "Removed point code produced screen holes");
    ensure(vector[`laser-fill/glass-${suffix}-fill.svg`], "Missing laser fill SVG");
  }
  const laser = JSON.parse(strFromU8(vector["laser-fill/toolpaths.json"]));
  ensure(laser.plates["glass-6060"].mirroredHorizontally && laser.plates["glass-6066"].scans.length > project.geometry.etchPaths["glass-6066"].length, "Fill scanning / mirror failed");
  project.geometry.etchPaths["glass-6066"].forEach((p, i) => {
    if (p.source === "voronoi-bleed") {
      const scans = laser.plates["glass-6066"].scans.filter((s) => s.pathIndex === i);
      ensure(scans.length && scans.every((s) => [s.start, s.end].some((p) => Math.min(Math.abs(p.x),
        Math.abs(p.x - project.geometry.glass6066.width), Math.abs(p.y), Math.abs(p.y - project.geometry.glass6066.height)) < 1e-7)),
        "A laser bleed scan stops short of the physical glass edge");
    }
  });
  const galvo = JSON.parse(strFromU8(vector["fto-galvo-toolpaths.json"]));
  for (const side of ["left", "right"]) {
    ensure(galvo.plates["glass-6066"].paths.filter((p) => p.sharedSide === side).length === 1,
      "Galvo output repeats a shared side cut");
    const svg = strFromU8(vector["svg-production/fto-etch-glass-6066.svg"]);
    ensure((svg.match(new RegExp(`data-shared-side="${side}"`, "g")) ?? []).length === 1,
      "Production SVG repeats a shared side cut");
  }
  for (const plate of ["glass-6066", "glass-6060"]) {
    const outputPlate = galvo.plates[plate];
    ensure(outputPlate.isolationRoutes.length === (plate === "glass-6066" ? 2 : 0) && outputPlate.isolationRoutes.every((r) =>
      r.continuousTopToBottom && Math.abs(r.points[0].y) < 1e-7 && Math.abs(r.points.at(-1).y - outputPlate.heightMm) < 1e-7),
      `${plate} has no two complete glass-top to glass-bottom isolation routes`);
    const misses = await page.evaluate(async (source, output) => {
      const image = new Image(); image.src = `data:image/svg+xml;charset=utf-8,${encodeURIComponent(source)}`; await image.decode();
      const scale = 50, canvas = document.createElement("canvas");
      canvas.width = Math.round(output.widthMm * scale); canvas.height = Math.round(output.heightMm * scale);
      const ctx = canvas.getContext("2d"); ctx.drawImage(image, 0, 0, canvas.width, canvas.height);
      const px = ctx.getImageData(0, 0, canvas.width, canvas.height).data;
      let missing = 0;
      for (const route of output.paths) route.points.slice(1).forEach((b, i) => {
        const a = route.points[i];
        for (const t of [0.15, 0.35, 0.5, 0.65, 0.85]) {
          const x = Math.max(0, Math.min(canvas.width - 1, Math.floor((a.x + (b.x - a.x) * t) * scale)));
          const y = Math.max(0, Math.min(canvas.height - 1, Math.floor((a.y + (b.y - a.y) * t) * scale)));
          if (px[(y * canvas.width + x) * 4] > 128) missing++;
        }
      });
      return missing;
    }, strFromU8(vector[`svg-production/fto-etch-${plate}.svg`]), outputPlate);
    ensure(misses === 0, `${plate} has ${misses} unetched samples along an alleged full-height route`);
  }

  // Independent proof on rendered PRODUCTION etch pixels: flood retained white
  // FTO over the entire glass, including strips and all external margins.
  const netRaster = await page.evaluate(async (source, geometry) => {
    const scale = 50, w = Math.round(geometry.glass6066.width * scale), h = Math.round(geometry.glass6066.height * scale);
    const index = (p) => Math.floor(p.y * scale) * w + Math.floor(p.x * scale);
    const check = async (omitCrosscuts) => {
      const doc = new DOMParser().parseFromString(source, "image/svg+xml");
      if (omitCrosscuts) doc.querySelectorAll('[data-source="voronoi-bleed"]').forEach((p) => p.remove());
      const image = new Image();
      image.src = `data:image/svg+xml;charset=utf-8,${encodeURIComponent(new XMLSerializer().serializeToString(doc.documentElement))}`;
      await image.decode();
      const canvas = document.createElement("canvas"); canvas.width = w; canvas.height = h;
      const ctx = canvas.getContext("2d"); ctx.drawImage(image, 0, 0, w, h);
      const px = ctx.getImageData(0, 0, w, h).data, visited = new Uint8Array(w * h), queue = new Int32Array(w * h);
      const flood = (seed, label) => {
        let read = 0, end = 0;
        if (px[seed * 4] < 128 || visited[seed]) return;
        queue[end++] = seed; visited[seed] = label;
        const add = (i) => { if (!visited[i] && px[i * 4] >= 128) { visited[i] = label; queue[end++] = i; } };
        while (read < end) {
          const i = queue[read++], x = i % w;
          if (x) add(i - 1); if (x < w - 1) add(i + 1);
          if (i >= w) add(i - w); if (i < w * (h - 1)) add(i + w);
        }
      };
      const a = index(geometry.terminals[0].contact), b = index(geometry.terminals[1].contact);
      flood(a, 1);
      const short = visited[b] === 1;
      flood(b, 2);
      const vertexMean = (r) => ({ x: r.reduce((s, p) => s + p.x, 0) / r.length, y: r.reduce((s, p) => s + p.y, 0) / r.length });
      let label = 3;
      const cellIslands = geometry.fabrication.activeRegions.map((r) => {
        const seed = index(vertexMean(r));
        if (!visited[seed]) flood(seed, label++);
        return visited[seed] || -1;
      });
      return { short, negativeCell: visited[index(vertexMean(geometry.fabrication.activeRegions[0]))] === 1,
        positiveCell: visited[index(vertexMean(geometry.fabrication.activeRegions.at(-1)))] === 2,
        cellIslands,
        strips: geometry.terminals.every((t, n) => [0.01, 0.5, 0.99].every((v) =>
          visited[index({ x: t.contact.x, y: v * geometry.glass6066.height })] === n + 1)) };
    };
    return { actual: await check(false), missingCrosscuts: await check(true) };
  }, strFromU8(vector["svg-production/fto-etch-glass-6066.svg"]), project.geometry);
  ensure(!netRaster.actual.short && netRaster.actual.negativeCell && netRaster.actual.positiveCell && netRaster.actual.strips,
    `Production etch raster has a short / open contact: ${JSON.stringify(netRaster.actual)}`);
  ensure(netRaster.missingCrosscuts.short, "Raster test did not detect the deliberately introduced annular bypass");
  for (let i = 0; i < f.activeRegions.length; i++) for (let j = i + 1; j < f.activeRegions.length; j++) {
    const expected = j === i + 1 && i % 2 === 1;
    ensure((netRaster.actual.cellIslands[i] === netRaster.actual.cellIslands[j]) === expected,
      `Production SVG changes the W-series net between cells ${i + 1}/${j + 1}`);
  }

  // Render the actual production SVG, not DOM-only assertions: every slot must
  // have a white continuous centreline through the printed seal.
  const raster = await page.evaluate(async (source, ports) => {
    const image = new Image();
    image.src = `data:image/svg+xml;charset=utf-8,${encodeURIComponent(source)}`;
    await image.decode();
    const canvas = document.createElement("canvas"); canvas.width = 3300; canvas.height = 3000;
    const ctx = canvas.getContext("2d"); ctx.drawImage(image, 0, 0, canvas.width, canvas.height);
    const pixels = ctx.getImageData(0, 0, canvas.width, canvas.height).data;
    let dark = 0;
    for (const p of ports) for (let i = 1; i < 100; i++) {
      const x = Math.floor((p.x + p.width / 2) * 50), y = Math.min(2999, Math.floor((p.y + p.height * i / 100) * 50));
      if (pixels[(y * 3300 + x) * 4] < 240) dark++;
    }
    return dark;
  }, strFromU8(vector["svg-production/binding-mask.svg"]), f.ports);
  ensure(raster === 0, `Binding SVG has ${raster} blocked slot samples`);

  const sealView = async (label, group, stage) => {
    await button(label);
    await page.waitForFunction((id, wanted) => document.querySelector(`#${id}`)?.getAttribute("data-seal-stage") === wanted &&
      document.querySelector('[data-testid="seal-stage"]')?.getAttribute("data-seal-stage") === wanted,
      { timeout: 30000 }, group, stage);
    return page.evaluate((id) => [...document.querySelectorAll(`#${id} > path`)].map((p) => p.getAttribute("d")), group);
  };
  const toggleSeal = async (group, stage) => {
    await page.click('[data-testid="seal-stage-toggle"]');
    await page.waitForFunction((id, wanted) => document.querySelector(`#${id}`)?.getAttribute("data-seal-stage") === wanted,
      { timeout: 30000 }, group, stage);
  };
  const printedSeal = await sealView("Binding", "BINDING_MASK", "printed");
  await page.screenshot({ path: join(directory, "binding.png") });
  const assemblyPrintedSeal = await sealView("Final Assembly", "ASSEMBLY_SEAL", "printed");
  ensure(JSON.stringify(assemblyPrintedSeal) === JSON.stringify(printedSeal), "Default Assembly uses a different glue mask than Binding");
  await page.screenshot({ path: join(directory, "assembly.png") });
  await toggleSeal("ASSEMBLY_SEAL", "compression-scenario");
  const assemblyScenario = await page.evaluate(() => [...document.querySelectorAll("#ASSEMBLY_SEAL > path")].map((p) => p.getAttribute("d")));
  const bindingScenario = await sealView("Binding", "BINDING_MASK", "compression-scenario");
  ensure(JSON.stringify(bindingScenario) === JSON.stringify(assemblyScenario), "Scenario stages do not match across tabs");
  ensure(JSON.stringify(bindingScenario) !== JSON.stringify(printedSeal), "Scenario toggle has no effect");
  ensure(await page.$eval('[data-testid="seal-stage-toggle"]', (el) => el.checked), "Shared stage selection was lost on tab switch");
  await page.screenshot({ path: join(directory, "binding-compression-envelope.png") });
  await toggleSeal("BINDING_MASK", "printed");
  const resetAssembly = await sealView("Final Assembly", "ASSEMBLY_SEAL", "printed");
  ensure(JSON.stringify(resetAssembly) === JSON.stringify(printedSeal), "Turning off the scenario does not restore matching printed masks");
  // Export while the scenario is displayed; production must still be printed geometry.
  await toggleSeal("ASSEMBLY_SEAL", "compression-scenario");
  const complete = await download("Complete ZIP: PDF + 1-bit TIFF");
  ensure(Object.keys(complete).length === 28, "Complete bundle count differs from 28");
  ensure(strFromU8(complete["svg-production/binding-mask.svg"]) === strFromU8(vector["svg-production/binding-mask.svg"]),
    "Scenario preview changed the production adhesive mask");
  ensure(strFromU8(complete["svg-layered/assembly-preview.svg"]) === strFromU8(vector["svg-layered/assembly-preview.svg"]),
    "Scenario preview changed the default exported assembly reference");
  for (const [name, data] of Object.entries(complete)) {
    if (name.endsWith(".pdf")) ensure(strFromU8(data.slice(0, 5)) === "%PDF-" && data.length > 500, `Invalid PDF: ${name}`);
    if (name.endsWith(".tif")) {
      const view = new DataView(data.buffer, data.byteOffset, data.byteLength);
      ensure(view.getUint16(2, true) === 42, "TIFF magic");
      const offset = view.getUint32(4, true), n = view.getUint16(offset, true);
      const tags = new Map(Array.from({ length: n }, (_, i) => {
        const k = offset + 2 + 12 * i; return [view.getUint16(k, true), view.getUint32(k + 8, true)];
      }));
      ensure(tags.get(258) === 1 && tags.get(259) === 1 && tags.get(277) === 1, "TIFF is not uncompressed true 1-bit");
    }
  }
  ensure(errors.length === 0, `Browser errors: ${errors.join("; ")}`);
  const estimates = JSON.parse(strFromU8(vector["process-estimates.json"]));
  const independentCurrents = f.cellAreasMm2.map((area) => area / 100 * project.config.jscMaCm2 * project.config.irradianceMwCm2 / 100);
  const minimumCurrent = Math.min(...independentCurrents);
  ensure(Math.abs(estimates.electrical.iscMa - minimumCurrent) < 1e-9 &&
    estimates.electrical.limitingCellNumber === f.cellAreasMm2.indexOf(Math.min(...f.cellAreasMm2)) + 1 &&
    estimates.electrical.cellIscMa.every((value, i) => Math.abs(value - independentCurrents[i]) < 1e-9),
    "Exported electrical estimate does not retain weakest-cell current and identity");
  ensure(Math.abs((await electricalReadout()).iscMa - minimumCurrent) < 1e-9,
    "Displayed series Isc differs from the exported weakest-cell estimate");
  ensure(estimates.electrical.fto.paths.length === project.geometry.cells.length * 2 &&
    estimates.electrical.scenario.confidence === "unfitted-scenario" &&
    Math.abs((await electricalReadout()).ftoIscMa - estimates.electrical.scenario.iscMa) < 1e-9,
    "Exported FTO / I–V scenario is missing or differs from the UI");
  console.log(JSON.stringify({ status: "PASS", vectorFiles: 20, completeFiles: 28, fillPorts: f.ports.length,
    activeAreaMm2: f.totalActiveMm2, cellMinMm2: Math.min(...f.cellAreasMm2), cellMaxMm2: Math.max(...f.cellAreasMm2),
    areaCv: f.areaCv, printWidthMm: project.config.bindingWidthMm, actualStencil: estimates.actualStencil,
    screenshotAperture, apertureDesign: estimates.apertureDesign, electrical: estimates.electrical,
    terminalCheck: f.terminalCheck, terminalRaster: netRaster,
    depositUm: estimates.seal.depositUm, depositSource: estimates.seal.depositSource, screenshots: directory }, null, 2));
} finally {
  await browser.close();
}
