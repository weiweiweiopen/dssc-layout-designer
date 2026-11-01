import { parse, type Font } from "opentype.js";
import anybodyUrl from "@fontsource/anybody/files/anybody-latin-900-normal.woff?url";
import antonUrl from "@fontsource/anton/files/anton-latin-400-normal.woff?url";
import frauncesUrl from "@fontsource/fraunces/files/fraunces-latin-900-normal.woff?url";
import type { FontId, StudioDocument } from "./model";

export const FONT_OPTIONS = [
  { id: "anybody", label: "Anybody Black — 厚字", url: anybodyUrl },
  { id: "anton", label: "Anton — 極窄標題", url: antonUrl },
  { id: "fraunces", label: "Fraunces Black — 展示襯線", url: frauncesUrl },
] as const;
const cache = new Map<string, Promise<Font>>();
export async function loadFont(id: FontId, custom?: StudioDocument["customFont"]): Promise<Font> {
  if (id === "custom") {
    if (!custom) throw new Error("請重新載入自訂字型，或選擇內建字型。");
    return parse(Uint8Array.from(atob(custom.base64), (c) => c.charCodeAt(0)).buffer);
  }
  if (!cache.has(id)) {
    const pending = fetch(FONT_OPTIONS.find((f) => f.id === id)!.url).then(async (response) => {
      if (!response.ok) throw new Error(`字型載入失敗：${response.status}`);
      return parse(await response.arrayBuffer());
    }).catch((error) => { cache.delete(id); throw error; });
    cache.set(id, pending);
  }
  return cache.get(id)!;
}

export async function importFont(file: File): Promise<NonNullable<StudioDocument["customFont"]>> {
  if (!/\.(otf|ttf|woff)$/i.test(file.name) || file.size > 3_000_000) throw new Error("請選擇 3 MB 以內的 OTF、TTF 或 WOFF 字型。");
  const bytes = new Uint8Array(await file.arrayBuffer());
  const font = parse(bytes.buffer);
  if (!font.charToGlyph("A").index) throw new Error("此字型沒有可用的拉丁字母 A。");
  let binary = "";
  for (const value of bytes) binary += String.fromCharCode(value);
  return { name: file.name.slice(0, 100), base64: btoa(binary) };
}
