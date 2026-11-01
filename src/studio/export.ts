import { pathData, type Artwork } from "./geometry";
import type { StudioDocument } from "./model";

const escape = (s: string) => s.replace(/[<>&"']/g, (c) => ({ "<": "&lt;", ">": "&gt;", "&": "&amp;", '"': "&quot;", "'": "&apos;" })[c]!);
export function artworkSvg(art: Artwork, document: StudioDocument): string {
  const r = document.designs[document.active];
  return `<?xml version="1.0" encoding="UTF-8"?>
<svg xmlns="http://www.w3.org/2000/svg" width="${art.width}mm" height="${art.height}mm" viewBox="0 0 ${art.width} ${art.height}">
<title>${escape(r.text || r.preset)} — ${r.flavor} / resolved artwork</title>
<desc>Artwork geometry only. A/B are shape sets, not TiO2/Pt assignments. W-type mapping, electrical and flow checks have not been performed. Source curve flattening tolerance before deformation: ${art.toleranceMm} mm, not a fabrication tolerance.</desc>
<metadata>${escape(JSON.stringify({ format: art.format, stage: art.stage, units: art.units, flavor: r.flavor, preset: r.preset, seed: r.seed, recipeFormat: document.format, stats: art.stats }))}</metadata>
<g id="SET_B" fill="white" fill-rule="evenodd"><path d="${pathData(art.b)}"/></g>
<g id="SET_A" fill="black" fill-rule="evenodd"><path d="${pathData(art.a)}"/></g>
</svg>`;
}
export function projectJson(document: StudioDocument): string { return JSON.stringify(document, null, 2); }
export function geometryJson(art: Artwork, document: StudioDocument): string {
  return JSON.stringify({ format: art.format, stage: art.stage, units: art.units, width: art.width, height: art.height,
    toleranceMm: art.toleranceMm, sets: { A: art.a, B: art.b }, stats: art.stats, warnings: art.warnings,
    recipe: document, materialMapping: null, electricalChecks: null, flowChecks: null }, null, 2);
}
export function download(content: string, filename: string, type: string) {
  const url = URL.createObjectURL(new Blob([content], { type }));
  const a = document.createElement("a"); a.href = url; a.download = filename; a.click();
  setTimeout(() => URL.revokeObjectURL(url), 1500);
}

/** A viewing image, deliberately separate from the physical-size vector artwork. */
export async function downloadPng(art: Artwork, document: StudioDocument): Promise<void> {
  const source = URL.createObjectURL(new Blob([artworkSvg(art, document)], { type: "image/svg+xml" }));
  try {
    const image = new Image(); image.src = source; await image.decode();
    const canvas = window.document.createElement("canvas"), scale = 1600 / Math.max(art.width, art.height);
    canvas.width = Math.round(art.width * scale); canvas.height = Math.round(art.height * scale);
    const context = canvas.getContext("2d");
    if (!context) throw new Error("無法建立 PNG 畫布。");
    context.fillStyle = "white"; context.fillRect(0, 0, canvas.width, canvas.height);
    context.drawImage(image, 0, 0, canvas.width, canvas.height);
    const blob = await new Promise<Blob>((resolve, reject) => canvas.toBlob((value) => value ? resolve(value) : reject(new Error("PNG 轉換失敗。")), "image/png"));
    const url = URL.createObjectURL(blob), a = window.document.createElement("a");
    a.href = url; a.download = `artwork-preview-${document.active}-${document.designs[document.active].seed}.png`; a.click();
    setTimeout(() => URL.revokeObjectURL(url), 1500);
  } finally { URL.revokeObjectURL(source); }
}
