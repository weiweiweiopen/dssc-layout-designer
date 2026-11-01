import { access, mkdtemp, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { createServer } from "vite";
import puppeteer from "puppeteer-core";

const server = process.env.APP_URL ? null : await createServer({ server: { host: "127.0.0.1", port: 0 } });
await server?.listen();
const base = process.env.APP_URL ?? server.resolvedUrls.local[0];
const executablePath = process.env.CHROME_PATH ?? "/Applications/Google Chrome.app/Contents/MacOS/Google Chrome";
await access(executablePath);
const output = await mkdtemp(join(process.env.TEST_TMPDIR ?? tmpdir(), "capsule-studio-"));
const browser = await puppeteer.launch({ executablePath, headless: true, args: ["--no-sandbox"] });
const page = await browser.newPage(), errors = [];
page.on("pageerror", (e) => errors.push(String(e)));
const ensure = (ok, message) => { if (!ok) throw new Error(message); };
const ready = () => page.waitForFunction(() => document.querySelector(".tg-canvas")?.getAttribute("data-pending") === "false" && !document.querySelector('[role="alert"]'), { timeout: 60000 });
const path = () => page.$eval('[data-set="A"]', (e) => e.getAttribute("d"));
const count = () => page.$$eval("[data-capsule-target]", (elements) => elements.length);
async function setInput(label, value) {
  await page.$eval(`[aria-label="${label}"]`, (el, v) => {
    const type = el.tagName === "TEXTAREA" ? HTMLTextAreaElement : HTMLInputElement;
    Object.getOwnPropertyDescriptor(type.prototype, "value").set.call(el, String(v));
    el.dispatchEvent(new Event("input", { bubbles: true })); el.dispatchEvent(new Event("change", { bubbles: true }));
  }, value);
  await ready();
}
async function drag(selector, dx, dy) {
  const node = await page.$(selector); await node.scrollIntoView();
  const box = await node.boundingBox(); ensure(box, `missing handle ${selector}`);
  await page.mouse.move(box.x + box.width / 2, box.y + box.height / 2); await page.mouse.down();
  await page.mouse.move(box.x + box.width / 2 + dx, box.y + box.height / 2 + dy, { steps: 8 }); await page.mouse.up(); await ready();
}
async function screenshot(name) {
  await page.$eval(".tg-sidebar", (e) => { e.scrollTop = document.querySelector(".tg-capsule-controls").offsetTop - e.offsetTop - 15; });
  await page.screenshot({ path: join(output, `${name}.png`) });
}
try {
  await page.setViewport({ width: 1440, height: 1050 });
  await page.goto(new URL("?studio=type", base).href, { waitUntil: "networkidle2" }); await ready();
  await page.click('[data-preset="capsules"]'); await ready(); await page.click('[data-tool="capsule"]');
  const initial = await path(); ensure(await count() === 3, "default should be three text-line capsules");
  await screenshot("capsule-lines");

  await setInput("標題文字", "MAKE\nSPACE\nNOW"); ensure(await path() !== initial, "text still has no effect on Capsule Rhythm");
  await page.click('button[aria-label="復原"]'); await ready(); ensure(await path() === initial, "text undo did not restore capsule geometry");
  await page.select('select[aria-label="字型"]', "anton"); await ready(); ensure(await path() !== initial, "font still has no effect on capsules");
  await page.select('select[aria-label="字型"]', "anybody"); await ready(); ensure(await path() === initial, "font roundtrip failed");

  for (const [label, value] of [["膠囊間距 mm", 2.5], ["交錯位移", -0.8], ["長短變化", 0.8], ["端部圓度", 0.4], ["字面內留白", 0.22], ["圓端順形", 0]]) {
    const before = await path(); await setInput(label, value);
    ensure(await path() !== before, `${label} did not change exported geometry`);
    await page.click('button[aria-label="復原"]'); await ready();
    ensure(await path() === before, `${label} undo failed`);
  }
  await page.click('[data-tool="rows"]'); const beforeRow = await path(); await drag('[data-handle="row-0"]', 0, 20);
  ensure(await path() !== beforeRow, "row height did not change capsules and text");
  await page.click('button[aria-label="復原"]'); await ready(); ensure(await path() === beforeRow, "capsule row undo failed");

  await setInput("標題文字", "MAKE IT\nHAPPEN NOW\nSOLAR ORACLE");
  await page.click('[data-capsule-style="words"]'); await ready();
  ensure(await count() === 6, "word flow should generate six linked carriers");
  const twoColumns = await path(); await setInput("每排膠囊數", 3);
  ensure(await path() !== twoColumns && await count() === 6, "lane count should reflow, not drop or duplicate text");
  await screenshot("capsule-words");
  const beforeDrag = await path(); await drag('[data-capsule-target="0:0"]', 18, 8);
  ensure(await path() !== beforeDrag, "single capsule drag changed only guides");
  await setInput("膠囊旋轉 °", 15);
  await screenshot("capsule-group-edit");

  await page.select('select[aria-label="膠囊方向"]', "vertical"); await ready();
  await page.click('[data-tool="rows"]');
  const beforeVertical = await path(); await drag('[data-handle="row-0"]', 15, 0);
  ensure(await path() !== beforeVertical, "vertical row divider must respond along X");
  await screenshot("capsule-vertical");

  await page.click('[data-capsule-style="weave"]'); await ready();
  ensure(await count() === 12, "weave should begin with four tracks / three segments");
  const weave = await path(); await setInput("每條段數", 2);
  ensure(await count() === 8 && await path() !== weave, "segment count has no effect");
  await setInput("節奏條數", 3); ensure(await count() === 6, "track count has no effect");
  const paths = new Set();
  for (const operation of ["knockout", "xor", "intersect", "outline"]) {
    await page.select('select[aria-label="膠囊文字組合"]', operation); await ready(); paths.add(await path());
  }
  ensure(paths.size === 4, "composition operations should resolve distinct shapes");
  await page.select('select[aria-label="膠囊文字組合"]', "xor"); await ready();
  await screenshot("capsule-weave");

  const beforeCharacter = await path(); await page.click('input[aria-label="加入角色"]'); await ready();
  await page.click('input[aria-label="加入角色"]'); await ready(); ensure(await path() === beforeCharacter, "character toggle reset capsule layout");
  await page.locator(".tg-variation-head button").click();
  await page.waitForFunction(() => document.querySelectorAll("[data-variant]").length === 6, { timeout: 60000 });
  const variantPaths = await page.$$eval("[data-variant] svg path", (elements) => elements.map((e) => e.getAttribute("d")));
  ensure(new Set(variantPaths).size > 1, "capsule variants do not affect the layout");
  await page.click('[data-variant]'); await ready();

  await page.evaluate(() => {
    window.__downloads = [];
    HTMLAnchorElement.prototype.click = function () { if (this.download) { const name = this.download; fetch(this.href).then((r) => r.text()).then((text) => window.__downloads.push({ name, text })); } };
  });
  await page.locator(".tg-exports button:nth-child(1)").click(); await page.locator(".tg-exports button:nth-child(2)").click();
  await page.waitForFunction(() => window.__downloads.length === 2);
  const downloads = await page.evaluate(() => window.__downloads), json = JSON.parse(downloads.find((d) => d.name.endsWith("json")).text);
  ensure(json.recipe.designs.fluid.capsule.layout === "weave", "capsule settings missing from export");
  ensure(!/<text|editor-only|data-capsule-target/.test(downloads.find((d) => d.name.endsWith("svg")).text), "SVG still includes unresolved text / guides");
  const finalPath = await path(); await new Promise((resolve) => setTimeout(resolve, 650));
  await page.reload({ waitUntil: "networkidle2" }); await ready(); ensure(await path() === finalPath, "capsule recipe persistence is not reproducible");
  await page.setViewport({ width: 390, height: 844 }); await page.click(".tg-settings-toggle");
  ensure(await page.evaluate(() => document.querySelector(".tg-studio").scrollWidth <= 390), "capsule controls overflow on mobile");
  ensure(!errors.length, errors.join("\n"));
  await writeFile(join(output, "result.json"), JSON.stringify({ status: "PASS", checks: "text/font coupling, all fit controls, line/word flow, horizontal/vertical dividers, carrier group drag, rotations, weaving controls, booleans, independent character, variants, real exports, persistence, mobile" }, null, 2));
  console.log(`Capsule Rhythm browser smoke: PASS\nArtifacts: ${output}`);
} catch (error) {
  await page.screenshot({ path: join(output, "failure.png") }); console.error(`Artifacts: ${output}`);
  console.error(await page.$eval(".tg-results", (e) => e.innerText).catch(() => "No result")); throw error;
} finally { await browser.close(); await server?.close(); }
