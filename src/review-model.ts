import type { DesignConfig, LayoutGeometry, PlateId, PolygonSet, Rect } from "./model";
import { zebraContactRegions } from "./contacts";

// Review settings deliberately live outside DesignConfig: appearance is not a
// measured optical model, an electrical input, or production artwork.
export const REVIEW_STORAGE_KEY = "dssc-layout-review-3d-v1";
export const DYE_PRESETS = {
  undyed: { label: "dyeUndyed", color: "#e0d9c9" },
  amber: { label: "dyeAmber", color: "#b86a20" },
  burgundy: { label: "dyeBurgundy", color: "#812f40" },
  violet: { label: "dyeViolet", color: "#73538e" },
  blue: { label: "dyeBlue", color: "#376c9d" },
  green: { label: "dyeGreen", color: "#587f45" },
  custom: { label: "dyeCustom", color: "#812f40" },
} as const;
export type DyeId = keyof typeof DYE_PRESETS;
export type ReviewKind = "glass" | "fto" | "tio2" | "pt" | "seal" | "contacts";
export interface ReviewSettings {
  biggerDye: DyeId;
  smallerDye: DyeId;
  biggerColor: string;
  smallerColor: string;
  glassThicknessMm: number;
  thinLayerScale: number;
  explodeMm: number;
  orthographic: boolean;
  bigger: boolean;
  smaller: boolean;
  glass: boolean;
  fto: boolean;
  coatings: boolean;
  seal: boolean;
  contacts: boolean;
  labels: boolean;
}
export const DEFAULT_REVIEW_SETTINGS: ReviewSettings = {
  biggerDye: "burgundy", smallerDye: "burgundy",
  biggerColor: "#812f40", smallerColor: "#812f40",
  glassThicknessMm: 2.2, thinLayerScale: 40, explodeMm: 0,
  orthographic: false, bigger: true, smaller: true,
  glass: true, fto: true, coatings: true, seal: true, contacts: true, labels: true,
};

export function parseReviewSettings(raw: string | null): ReviewSettings {
  const result = { ...DEFAULT_REVIEW_SETTINGS };
  try {
    const parsed = JSON.parse(raw ?? "null");
    if (!parsed || typeof parsed !== "object") return result;
    for (const key of Object.keys(result) as Array<keyof ReviewSettings>) {
      if (typeof result[key] === "boolean" && typeof parsed[key] === "boolean") {
        Object.assign(result, { [key]: parsed[key] });
      }
    }
    for (const key of ["biggerDye", "smallerDye"] as const) {
      if (typeof parsed[key] === "string" && Object.hasOwn(DYE_PRESETS, parsed[key])) result[key] = parsed[key] as DyeId;
    }
    for (const key of ["biggerColor", "smallerColor"] as const) {
      if (typeof parsed[key] === "string" && /^#[0-9a-f]{6}$/i.test(parsed[key])) result[key] = parsed[key];
    }
    for (const [key, min, max] of [["glassThicknessMm", 0.5, 5], ["thinLayerScale", 1, 100], ["explodeMm", 0, 15]] as const) {
      if (typeof parsed[key] === "number" && Number.isFinite(parsed[key])) result[key] = Math.min(max, Math.max(min, parsed[key]));
    }
  } catch { /* A stale visual preference must not prevent loading a design. */ }
  return result;
}

export function reviewDyeColor(settings: ReviewSettings, plate: PlateId): string {
  const dye = plate === "glass-6066" ? settings.biggerDye : settings.smallerDye;
  return dye === "custom" ? (plate === "glass-6066" ? settings.biggerColor : settings.smallerColor) : DYE_PRESETS[dye].color;
}

export interface ReviewFootprint {
  id: string;
  kind: ReviewKind;
  plate?: PlateId;
  polygons: PolygonSet;
}
const rectangle = ({ x, y, width, height }: Rect): PolygonSet => [[[
  { x, y }, { x: x + width, y }, { x: x + width, y: y + height }, { x, y: y + height },
]]];

/** All XY data are canonical assembly coordinates. The smaller plate is already
 * registered here; the conductive-side fabrication mirror is NOT applied again. */
export function buildReviewFootprints(geometry: LayoutGeometry, compression: boolean): ReviewFootprint[] {
  const result: ReviewFootprint[] = [];
  for (const plate of ["glass-6066", "glass-6060"] as const) {
    result.push({ id: `${plate}-glass`, kind: "glass", plate, polygons: rectangle(plate === "glass-6066" ? geometry.glass6066 : geometry.glass6060) });
    result.push({ id: `${plate}-fto`, kind: "fto", plate, polygons: geometry.fabrication.retainedFto[plate] });
    for (const kind of ["tio2", "pt"] as const) {
      result.push({ id: `${plate}-${kind}`, kind, plate,
        polygons: geometry.cells.filter((cell) => (plate === "glass-6066" ? cell.glass6066Material : cell.glass6060Material) === kind)
          .map((cell) => [geometry.fabrication.activeRegions[cell.index]]).filter(([ring]) => ring.length >= 3) });
    }
  }
  result.push({ id: "ab-313", kind: "seal", polygons: compression ? geometry.fabrication.sealAssembled : geometry.fabrication.sealPrint });
  for (const contact of zebraContactRegions(geometry)) {
    result.push({ id: contact.polarity, kind: "contacts", plate: contact.plate, polygons: contact.polygons });
  }
  return result;
}

// Explicit, unmeasured visual thickness assumptions. These do not feed process
// calculations. Only the face-to-face gap uses the existing bead-D50 assumption.
export const REVIEW_FILM_UM = { fto: 0.5, tio2: 10, pt: 0.01 } as const;
export function reviewStack(config: DesignConfig, settings: ReviewSettings) {
  const scale = settings.thinLayerScale / 1000;
  const fto = REVIEW_FILM_UM.fto * scale;
  const gap = config.beadDiameterUm * scale;
  const e = settings.explodeMm;
  const glass = settings.glassThicknessMm;
  const position = (layer: ReviewFootprint): { z: number; depth: number } => {
    const bigger = layer.plate === "glass-6066";
    if (layer.kind === "glass") return { z: bigger ? -glass - 3 * e : 2 * fto + gap + 3 * e, depth: glass };
    if (layer.kind === "fto") return { z: bigger ? -2 * e : fto + gap + 2 * e, depth: fto };
    if (layer.kind === "seal") return { z: fto, depth: gap };
    // Contact color is a zero-thickness reference on retained bigger-plate FTO.
    if (layer.kind === "contacts") return { z: fto - 2 * e + 0.0001, depth: 0 };
    const depth = REVIEW_FILM_UM[layer.kind] * scale;
    return { z: bigger ? fto - e : fto + gap - depth + e, depth };
  };
  return { position, minZ: -glass - 3 * e, maxZ: 2 * fto + gap + glass + 3 * e };
}
