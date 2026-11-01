export type Flavor = "fluid" | "pixel";
export type FontId = "anybody" | "anton" | "fraunces" | "custom";
export type PresetId = "squeeze" | "flip" | "tall" | "capsules" | "steps" | "cuts" | "blocks";
export interface Vec { x: number; y: number }
export interface GlyphEdit extends Vec { scale: number; angle: number }
export interface CapsuleSettings {
  layout: "fit" | "weave";
  units: "lines" | "words";
  direction: "horizontal" | "vertical";
  lanes: number;
  segments: number;
  gap: number;
  stagger: number;
  variation: number;
  roundness: number;
  padding: number;
  follow: number;
  proportion: number;
  operation: "knockout" | "xor" | "intersect" | "outline";
  seed: number;
  edits: Record<string, GlyphEdit>;
}
export interface Recipe {
  flavor: Flavor;
  preset: PresetId;
  seed: number;
  text: string;
  font: FontId;
  width: number;
  height: number;
  margin: number;
  lineGap: number;
  tracking: number;
  rowWeights: number[];
  capsule: CapsuleSettings;
  warp: { squeeze: number; wave: number; slant: number; cage: Vec[] };
  pixel: { pitch: number; phase: number; bands: number; shift: number; damage: number; backing: boolean };
  mask: { enabled: boolean; shape: "ellipse" | "star" | "diamond" | "band"; operation: "xor" | "subtract" | "intersect" | "union"; x: number; y: number; width: number; height: number; angle: number };
  character: { enabled: boolean; seed: number; x: number; y: number; size: number; operation: "union" | "xor" };
  edits: Record<string, GlyphEdit>;
  inverted: boolean;
}
export interface StudioDocument {
  format: "type-geometry-studio-v1";
  active: Flavor;
  designs: Record<Flavor, Recipe>;
  customFont?: { name: string; base64: string };
}

export const STORAGE_KEY = "dssc-type-geometry-studio-v1";
export const PRESETS: Array<{ id: PresetId; flavor: Flavor; name: string; description: string }> = [
  { id: "squeeze", flavor: "fluid", name: "Soft Squeeze", description: "整組收腰・厚字密排" },
  { id: "flip", flavor: "fluid", name: "Shape Flip", description: "橢圓遮罩・正負形反相" },
  { id: "tall", flavor: "fluid", name: "Tall Press", description: "極高字面・緊密標題" },
  { id: "capsules", flavor: "fluid", name: "Capsule Rhythm", description: "字形包覆・條帶交織" },
  { id: "steps", flavor: "pixel", name: "Stepped Type", description: "階梯輪廓・保留字腔" },
  { id: "cuts", flavor: "pixel", name: "Offset Cuts", description: "帶狀切斷・局部錯位" },
  { id: "blocks", flavor: "pixel", name: "Block Ground", description: "階梯底板・字面留白" },
];

export const clone = <T,>(value: T): T => structuredClone(value);
export const clamp = (value: number, min: number, max: number) => Math.max(min, Math.min(max, value));
export function capsuleDefaults(seed = 6066): CapsuleSettings {
  return { layout: "fit", units: "lines", direction: "horizontal", lanes: 1, segments: 3,
    gap: 1.3, stagger: 0.35, variation: 0.3, roundness: 1, padding: 0.12, follow: 0.85,
    proportion: 0.7, operation: "knockout", seed, edits: {} };
}
export function capsuleTexts(r: Recipe): string[] {
  return r.capsule.units === "words" ? r.text.trim().split(/\s+/) : r.text.split("\n");
}
export function random(seed: number) {
  let state = seed >>> 0;
  return () => {
    state = (state + 0x6d2b79f5) >>> 0;
    let t = Math.imul(state ^ (state >>> 15), state | 1);
    t ^= t + Math.imul(t ^ (t >>> 7), t | 61);
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

export function recipeFor(preset: PresetId, previous?: Recipe): Recipe {
  const flavor = PRESETS.find((p) => p.id === preset)!.flavor;
  const r: Recipe = {
    flavor, preset, seed: previous?.seed ?? 6066, text: previous?.text ?? "SOLAR\nORACLE\nWALKMAN",
    font: preset === "tall" || preset === "flip" ? "anton" : "anybody",
    width: previous?.width ?? 50, height: previous?.height ?? 60,
    margin: 3, lineGap: 0.7, tracking: 0, rowWeights: [1, 1, 1, 1, 1, 1],
    capsule: capsuleDefaults(previous?.seed ?? 6066),
    warp: { squeeze: preset === "squeeze" ? 0.55 : 0, wave: preset === "squeeze" ? 0.28 : 0, slant: 0, cage: Array.from({ length: 9 }, () => ({ x: 0, y: 0 })) },
    pixel: { pitch: 0.65, phase: 0, bands: preset === "cuts" ? 4 : 0, shift: preset === "cuts" ? 1.4 : 0, damage: 0, backing: preset === "blocks" },
    mask: { enabled: preset === "flip", shape: "ellipse", operation: "xor", x: 0.5, y: 0.5, width: 0.88, height: 0.42, angle: -12 },
    character: previous ? clone(previous.character) : { enabled: false, seed: 23, x: 0.78, y: 0.79, size: 0.18, operation: "xor" },
    edits: {}, inverted: false,
  };
  return r;
}
export function newDocument(): StudioDocument {
  return { format: "type-geometry-studio-v1", active: "fluid", designs: { fluid: recipeFor("squeeze"), pixel: recipeFor("blocks") } };
}

/** Variants change only unlocked design parameters; character has an independent stream. */
export function variantOf(source: Recipe, seed: number, locks: { layout: boolean; mask: boolean }): Recipe {
  const r = clone(source), rng = random(seed);
  r.seed = seed;
  if (!locks.layout) {
    r.rowWeights = r.rowWeights.map(() => 0.7 + rng() * 0.65);
    r.tracking = (rng() - 0.5) * 0.035;
    if (r.flavor === "fluid") {
      r.warp.squeeze = (rng() - 0.25) * 0.9;
      r.warp.wave = (rng() - 0.5) * 0.9;
      r.warp.slant = (rng() - 0.5) * 0.35;
      if (r.preset === "capsules") {
        r.capsule.seed = seed;
        r.capsule.stagger = (rng() - 0.5) * 1.4;
        r.capsule.variation = 0.1 + rng() * 0.6;
        r.capsule.roundness = 0.65 + rng() * 0.35;
        r.capsule.proportion = 0.3 + rng() * 0.7;
      }
    } else {
      r.pixel.phase = rng();
      r.pixel.shift = rng() * 2.6;
    }
  }
  if (!locks.mask) {
    r.mask.x = 0.35 + rng() * 0.3;
    r.mask.y = 0.3 + rng() * 0.4;
    r.mask.angle = (rng() - 0.5) * 70;
  }
  return r;
}

/** Strict bounded recipe parsing. Never restore arbitrary SVG / executable expressions. */
export function parseDocument(input: unknown): StudioDocument {
  const fail = () => { throw new Error("不是有效的 Type + Geometry v1 配方，或參數超出範圍。"); };
  if (!input || typeof input !== "object") return fail();
  const d = clone(input as StudioDocument);
  if (d.format !== "type-geometry-studio-v1" || !["fluid", "pixel"].includes(d.active) || !d.designs) return fail();
  const num = (v: number, lo: number, hi: number) => typeof v === "number" && Number.isFinite(v) && v >= lo && v <= hi;
  for (const flavor of ["fluid", "pixel"] as const) {
    const r = d.designs[flavor];
    // v1 recipes from the first Studio did not have capsule settings.
    if (r && r.capsule === undefined) r.capsule = capsuleDefaults(r.seed);
    if (!r || r.flavor !== flavor || !PRESETS.some((p) => p.id === r.preset && p.flavor === flavor) ||
      !["anybody", "anton", "fraunces", "custom"].includes(r.font) || typeof r.text !== "string" || r.text.length > 120 ||
      /[^\x20-\x7e\n]/.test(r.text) || r.text.split("\n").length > 6 || !num(r.seed, 0, 4294967295) || !Number.isInteger(r.seed) ||
      !num(r.width, 20, 150) || !num(r.height, 20, 150) || !num(r.margin, 0.5, Math.min(r.width, r.height) / 4) ||
      !num(r.lineGap, 0, 3) || !num(r.tracking, -0.08, 0.15) || typeof r.inverted !== "boolean" ||
      !Array.isArray(r.rowWeights) || r.rowWeights.length !== 6 || r.rowWeights.some((v) => !num(v, 0.4, 2))) return fail();
    const w = r.warp, p = r.pixel, m = r.mask, c = r.character, cap = r.capsule;
    if (!cap || !["fit", "weave"].includes(cap.layout) || !["lines", "words"].includes(cap.units) ||
      !["horizontal", "vertical"].includes(cap.direction) || !num(cap.lanes, 1, 6) || !Number.isInteger(cap.lanes) ||
      !num(cap.segments, 1, 6) || !Number.isInteger(cap.segments) || !num(cap.gap, 0, 5) ||
      !num(cap.stagger, -1, 1) || !num(cap.variation, 0, 1) || !num(cap.roundness, 0.1, 1) ||
      !num(cap.padding, 0.03, 0.25) || !num(cap.follow, 0, 1) || !num(cap.proportion, 0, 1) ||
      !["knockout", "xor", "intersect", "outline"].includes(cap.operation) || !num(cap.seed, 0, 4294967295) || !Number.isInteger(cap.seed) ||
      !cap.edits || typeof cap.edits !== "object" || Array.isArray(cap.edits) || Object.keys(cap.edits).length > 36) return fail();
    if (!w || !num(w.squeeze, -0.8, 0.8) || !num(w.wave, -0.8, 0.8) || !num(w.slant, -0.6, 0.6) ||
      !Array.isArray(w.cage) || w.cage.length !== 9 || w.cage.some((v) => !v || !num(v.x, -0.1, 0.1) || !num(v.y, -0.1, 0.1)) ||
      !p || !num(p.pitch, 0.3, 2.5) || !num(p.phase, 0, 1) || !num(p.bands, 0, 12) || !Number.isInteger(p.bands) ||
      !num(p.shift, 0, 4) || !num(p.damage, 0, 0.35) || typeof p.backing !== "boolean" ||
      !m || typeof m.enabled !== "boolean" || !["ellipse", "star", "diamond", "band"].includes(m.shape) ||
      !["xor", "subtract", "intersect", "union"].includes(m.operation) || !num(m.x, 0, 1) || !num(m.y, 0, 1) ||
      !num(m.width, 0.1, 1.3) || !num(m.height, 0.1, 1.3) || !num(m.angle, -180, 180) ||
      !c || typeof c.enabled !== "boolean" || !num(c.seed, 0, 4294967295) || !Number.isInteger(c.seed) ||
      !num(c.x, 0, 1) || !num(c.y, 0, 1) || !num(c.size, 0.08, 0.4) || !["union", "xor"].includes(c.operation) ||
      !r.edits || typeof r.edits !== "object" || Array.isArray(r.edits) || Object.keys(r.edits).length > 120) return fail();
    for (const [key, e] of [...Object.entries(r.edits), ...Object.entries(cap.edits)]) {
      if (!/^\d+:\d+$/.test(key) || !e || !num(e.x, -50, 50) || !num(e.y, -50, 50) || !num(e.scale, 0.5, 1.5) || !num(e.angle, -60, 60)) return fail();
    }
  }
  if (d.customFont && (typeof d.customFont.name !== "string" || d.customFont.name.length > 100 || typeof d.customFont.base64 !== "string" ||
    d.customFont.base64.length > 4_200_000 || !/^[A-Za-z0-9+/]+={0,2}$/.test(d.customFont.base64))) return fail();
  if (Object.values(d.designs).some((r) => r.font === "custom") && !d.customFont) return fail();
  // Keep only the documented fields (no handoff configuration or old preview flags).
  return clone({ format: d.format, active: d.active, designs: d.designs, ...(d.customFont ? { customFont: d.customFont } : {}) });
}
