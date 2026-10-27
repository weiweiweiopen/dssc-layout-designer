import { readFile, writeFile } from "node:fs/promises";

const root = new URL("../", import.meta.url);
const sections = await Promise.all(["THIRD_PARTY_NOTICES.md", "DEPENDENCY_LICENSES.txt"]
  .map((name) => readFile(new URL(name, root), "utf8")));
await writeFile(new URL("dist/THIRD_PARTY_NOTICES.txt", root),
  sections.join("\n\n").replace(/\r\n/g, "\n").replace(/[ \t]+$/gm, ""));
