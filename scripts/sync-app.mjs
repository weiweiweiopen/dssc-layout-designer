import { copyFile, mkdir, readFile, readdir, stat } from "node:fs/promises";
import { resolve, join } from "node:path";
import { execFileSync } from "node:child_process";
import { fileURLToPath } from "node:url";

const project = fileURLToPath(new URL("../", import.meta.url));
const target = resolve(process.argv[2] ?? join(project, "DSSC Layout.app"));
const resources = join(target, "Contents", "Resources");
const identity = JSON.parse(await readFile(join(resources, "identity.json"), "utf8"));
if (identity.app !== "w-series-dssc-layout-designer") throw new Error("Target is not this DSSC app.");
await stat(join(project, "dist", "index.html"));
// Keep the launcher's service identity stable so the running local server can
// serve the new index/assets immediately. Only generated web assets are copied.
async function copyBuild(source, destination) {
  await mkdir(destination, { recursive: true });
  for (const entry of await readdir(source, { withFileTypes: true })) {
    const from = join(source, entry.name), to = join(destination, entry.name);
    if (entry.isDirectory()) await copyBuild(from, to);
    else await copyFile(from, to);
  }
}
await copyBuild(join(project, "dist"), join(resources, "dist"));
for (const name of ["README.md", "DEVELOPMENT.md", "PROCESS_MODEL.md", "THIRD_PARTY_NOTICES.md", "DEPENDENCY_LICENSES.txt"]) {
  await copyFile(join(project, name), join(resources, name));
}
if (process.platform === "darwin") {
  execFileSync("/usr/bin/codesign", ["--force", "--sign", "-", target], { stdio: "inherit" });
  execFileSync("/usr/bin/codesign", ["--verify", "--strict", target], { stdio: "inherit" });
}
console.log(`Updated ${target}; refresh the local browser window.`);
