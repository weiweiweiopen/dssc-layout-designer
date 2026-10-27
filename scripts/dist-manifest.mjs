import { createHash } from "node:crypto";
import { readdir, readFile, writeFile } from "node:fs/promises";
import { fileURLToPath } from "node:url";
import { join, relative } from "node:path";

const root = fileURLToPath(new URL("../", import.meta.url));
const dist = join(root, "dist");
const manifestPath = join(root, "dist-manifest.json");
async function files(directory) {
  const entries = await readdir(directory, { withFileTypes: true });
  const paths = await Promise.all(entries.map((entry) => entry.isDirectory()
    ? files(join(directory, entry.name)) : [join(directory, entry.name)]));
  return paths.flat().sort();
}

const manifest = {};
for (const path of await files(dist)) {
  manifest[relative(dist, path).split("\\").join("/")] = createHash("sha256").update(await readFile(path)).digest("hex");
}
if (process.argv.includes("--check")) {
  const recorded = JSON.parse(await readFile(manifestPath, "utf8"));
  if (JSON.stringify(recorded) !== JSON.stringify(manifest)) throw new Error("dist differs from dist-manifest.json");
  console.log(`Verified ${Object.keys(manifest).length} build files.`);
} else {
  await writeFile(manifestPath, `${JSON.stringify(manifest, null, 2)}\n`);
  console.log(`Recorded ${Object.keys(manifest).length} build files in dist-manifest.json.`);
}
