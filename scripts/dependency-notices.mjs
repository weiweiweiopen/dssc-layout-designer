import { readFile, readdir, writeFile } from "node:fs/promises";

// Preserve collected notices and append licenses for new installed packages.
const root = new URL("../", import.meta.url);
const target = new URL("DEPENDENCY_LICENSES.txt", root);
let notices = await readFile(target, "utf8");
const lock = JSON.parse(await readFile(new URL("package-lock.json", root), "utf8"));
let added = 0;
const missing = [];
for (const directory of Object.keys(lock.packages).filter((p) => p.startsWith("node_modules/")).sort()) {
  let entries;
  try { entries = await readdir(new URL(`${directory}/`, root), { withFileTypes: true }); }
  catch (error) { if (error.code === "ENOENT") continue; throw error; }
  const files = entries.filter((e) => e.isFile() && /^(licen[cs]e|copying|notice)(?:[._-].*)?$/i.test(e.name));
  if (!files.length && !lock.packages[directory].dev) missing.push(directory);
  for (const file of files.sort((a, b) => a.name.localeCompare(b.name))) {
    const heading = `===== ${directory.replace(/^node_modules\//, "")}/${file.name} =====`;
    if (notices.includes(heading)) continue;
    notices += `\n\n${heading}\n${(await readFile(new URL(`${directory}/${file.name}`, root), "utf8")).trim()}\n`;
    added++;
  }
}
await writeFile(target, notices.replace(/\r\n/g, "\n").replace(/[ \t]+$/gm, ""));
console.log(`Appended ${added} dependency license files.`);
if (missing.length) console.log("Packages without a root license file:", missing);
