import paper from "paper";
import ClipperLib from "clipper-lib";
import type { Font } from "opentype.js";
import type { Point, PolygonSet, Rect } from "../model";
import { componentAt, difference, intersect, offsetPolygons, rectRing, setArea, shape, union } from "../polygons";
import { capsuleTexts, clamp, random, type Recipe, type Vec } from "./model";

export interface ArtworkElement { id: string; kind: "glyph" | "geometry"; label: string; polygons: PolygonSet; bounds: Rect; groupId?: string }
export interface LayoutDivider { index: number; from: Point; to: Point; axis: "x" | "y"; direction: number; span: number; rows: number }
interface TextPlacement { text: string; line: number; box: Rect; groupId?: string; mapPoint?: (p: Point) => Point }
export interface Artwork {
  format: "type-geometry-artwork-v1";
  stage: "resolved-artwork-not-fabrication";
  units: "mm";
  toleranceMm: number;
  width: number;
  height: number;
  a: PolygonSet;
  b: PolygonSet;
  elements: ArtworkElement[];
  dividers: LayoutDivider[];
  mask: PolygonSet;
  character: PolygonSet;
  stats: { areaA: number; areaB: number; coverage: number; components: number; holes: number; vertices: number };
  warnings: string[];
}

const SCALE = 1e5;
export const FLATNESS_MM = 0.025;

/** Resolve raw font winding into explicit polygon / hole nesting before any edits. */
function resolveRings(rings: Point[][]): PolygonSet {
  const c = new ClipperLib.Clipper();
  c.StrictlySimple = true;
  c.AddPaths(rings.filter((r) => r.length >= 3).map((r) => r.map((p) => ({ X: Math.round(p.x * SCALE), Y: Math.round(p.y * SCALE) }))), ClipperLib.PolyType.ptSubject, true);
  const tree = new ClipperLib.PolyTree();
  c.Execute(ClipperLib.ClipType.ctUnion, tree, ClipperLib.PolyFillType.pftNonZero, ClipperLib.PolyFillType.pftNonZero);
  const ring = (r: ClipperLib.Path) => r.map((p) => ({ x: p.X / SCALE, y: p.Y / SCALE }));
  return ClipperLib.JS.PolyTreeToExPolygons(tree).map((p) => [ring(p.outer), ...p.holes.map(ring)]);
}
export function bounds(polygons: PolygonSet): Rect {
  const points = polygons.flat(2);
  if (!points.length) return { x: 0, y: 0, width: 0, height: 0 };
  let x = Infinity, y = Infinity, right = -Infinity, bottom = -Infinity;
  for (const p of points) { x = Math.min(x, p.x); y = Math.min(y, p.y); right = Math.max(right, p.x); bottom = Math.max(bottom, p.y); }
  return { x, y, width: right - x, height: bottom - y };
}
const mapSet = (set: PolygonSet, fn: (p: Point) => Point): PolygonSet => set.map((p) => p.map((r) => r.map(fn)));
const xor = (a: PolygonSet, b: PolygonSet) => union(difference(a, b), difference(b, a));
export function combine(a: PolygonSet, b: PolygonSet, operation: Recipe["mask"]["operation"]): PolygonSet {
  if (operation === "union") return union(a, b);
  if (operation === "intersect") return intersect(a, b);
  if (operation === "subtract") return difference(a, b);
  return xor(a, b);
}

function subdivide(ring: Point[], limit = 0.45): Point[] {
  return ring.flatMap((a, i) => {
    const b = ring[(i + 1) % ring.length], steps = Math.max(1, Math.ceil(Math.hypot(b.x - a.x, b.y - a.y) / limit));
    return Array.from({ length: steps }, (_, j) => ({ x: a.x + (b.x - a.x) * j / steps, y: a.y + (b.y - a.y) * j / steps }));
  });
}

/** Piecewise bilinear cage + a shared smooth field, evaluated from source coordinates. */
export function deform(p: Point, r: Recipe): Point {
  const u = clamp(p.x / r.width, 0, 1), v = clamp(p.y / r.height, 0, 1);
  const column = Math.min(1, Math.floor(u * 2)), row = Math.min(1, Math.floor(v * 2));
  const tx = u * 2 - column, ty = v * 2 - row;
  const cage = (axis: keyof Vec) => {
    const get = (x: number, y: number) => r.warp.cage[y * 3 + x][axis];
    return (get(column, row) * (1 - tx) + get(column + 1, row) * tx) * (1 - ty) +
      (get(column, row + 1) * (1 - tx) + get(column + 1, row + 1) * tx) * ty;
  };
  // Smooth shared displacement, not independent random scales on each letter.
  const waist = Math.sin(Math.PI * v) ** 2;
  return {
    x: p.x + (u - 0.5) * r.width * (-0.42 * r.warp.squeeze * waist) + r.warp.slant * r.width * (v - 0.5) * 0.28 + cage("x") * r.width,
    y: p.y + Math.sin(u * Math.PI * 2 + v * Math.PI * 0.5) * r.warp.wave * r.height * 0.075 + cage("y") * r.height,
  };
}

function posterLayout(r: Recipe): { placements: TextPlacement[]; dividers: LayoutDivider[] } {
  const lines = r.text.split("\n"), weights = lines.map((_, i) => r.rowWeights[i]);
  const available = r.height - r.margin * 2 - r.lineGap * (lines.length - 1);
  if (available < lines.length * 0.5) throw new Error("行距與邊距沒有留下足夠的字面高度。請減少行數／間距，或加高畫布。");
  const total = weights.reduce((s, w) => s + w, 0), dividers: LayoutDivider[] = [];
  let top = r.margin;
  const placements = lines.map((text, line) => {
    const rowHeight = available * weights[line] / total;
    const box = { x: r.margin, y: top, width: r.width - r.margin * 2, height: rowHeight };
    top += rowHeight + r.lineGap;
    if (line < lines.length - 1) dividers.push({ index: line, from: { x: 0, y: top - r.lineGap / 2 }, to: { x: r.width, y: top - r.lineGap / 2 }, axis: "y", direction: 1, span: available, rows: lines.length });
    return { text, line, box };
  });
  return { placements, dividers };
}

function letterElements(font: Font, r: Recipe, placements = posterLayout(r).placements): ArtworkElement[] {
  const scope = new paper.PaperScope();
  scope.setup(new scope.Size(r.width, r.height));
  try {
    return placements.flatMap(({ text, line, box: target, groupId, mapPoint }) => {
      const raw: Array<{ label: string; data: string; x: number }> = [];
      let cursor = 0;
      // Latin-first editor: keep a stable ID per input character (no ffi ligature collapse).
      const glyphs = Array.from(text, (character) => font.charToGlyph(character));
      for (let i = 0; i < glyphs.length; i++) {
        const glyph = glyphs[i];
        if (!glyph.index && text.trim()) throw new Error(`目前字型沒有字元「${text[i]}」。請更換字型或文字。`);
        const data = glyph.getPath(0, 0, 100).toPathData(5);
        raw.push({ label: text[i] ?? "", data, x: cursor });
        cursor += glyph.advanceWidth! / font.unitsPerEm * 100 + r.tracking * 100;
        if (i + 1 < glyphs.length) cursor += font.getKerningValue(glyph, glyphs[i + 1]) / font.unitsPerEm * 100;
      }
      const paths = raw.map(({ data, x }) => {
        const item = new scope.CompoundPath({ pathData: data, insert: false });
        item.translate(new scope.Point(x, 0));
        return item;
      });
      const valid = paths.filter((p) => p.children.length > 0);
      const box = valid.reduce<paper.Rectangle | null>((rect, p) => rect ? rect.unite(p.bounds) : p.bounds.clone(), null);
      if (!box || box.width < 1e-8 || box.height < 1e-8) { paths.forEach((p) => p.remove()); return []; }
      const sx = target.width / box.width, sy = target.height / box.height;
      return paths.flatMap((item, i) => {
        item.scale(sx, sy, new scope.Point(box.x, box.y));
        item.translate(new scope.Point(target.x - box.x, target.y - box.y));
        const rings = item.children.map((child) => {
          const path = child as paper.Path;
          path.flatten(FLATNESS_MM);
          return path.segments.map((s) => ({ x: s.point.x, y: s.point.y }));
        });
        const id = `${line}:${i}`, edit = r.edits[id];
        let polygons = resolveRings(rings);
        polygons = mapSet(polygons.map((p) => p.map((ring) => subdivide(ring))), (p) => deform(mapPoint ? mapPoint(p) : p, r));
        // Re-resolve after warping, so folds / overlaps cannot silently become invalid rings.
        polygons = resolveRings(polygons.flat());
        if (edit) {
          const b = bounds(polygons), cx = b.x + b.width / 2, cy = b.y + b.height / 2, angle = edit.angle * Math.PI / 180;
          polygons = mapSet(polygons, (p) => ({
            x: cx + edit.x + edit.scale * ((p.x - cx) * Math.cos(angle) - (p.y - cy) * Math.sin(angle)),
            y: cy + edit.y + edit.scale * ((p.x - cx) * Math.sin(angle) + (p.y - cy) * Math.cos(angle)),
          }));
        }
        item.remove();
        return polygons.length ? [{ id, kind: "glyph" as const, label: raw[i].label, polygons, bounds: bounds(polygons), ...(groupId ? { groupId } : {}) }] : [];
      });
    });
  } finally { scope.project.remove(); }
}

function ellipse(cx: number, cy: number, rx: number, ry: number): PolygonSet {
  return shape(Array.from({ length: 100 }, (_, i) => ({ x: cx + Math.cos(i / 100 * Math.PI * 2) * rx, y: cy + Math.sin(i / 100 * Math.PI * 2) * ry })));
}
function roundedRect(x: number, y: number, width: number, height: number, radius: number): PolygonSet {
  const rad = Math.min(radius, width / 2, height / 2);
  return shape(Array.from({ length: 4 }, (_, corner) => {
    const cx = [x + width - rad, x + width - rad, x + rad, x + rad][corner];
    const cy = [y + rad, y + height - rad, y + height - rad, y + rad][corner];
    return Array.from({ length: 18 }, (_, j) => {
      const angle = (-Math.PI / 2 + corner * Math.PI / 2) + j / 17 * Math.PI / 2;
      return { x: cx + Math.cos(angle) * rad, y: cy + Math.sin(angle) * rad };
    });
  }).flat());
}

/** Layout carriers and text in the same coordinate system, then deform them together. */
function capsuleComposition(font: Font, r: Recipe): { elements: ArtworkElement[]; polygons: PolygonSet; dividers: LayoutDivider[] } {
  const cap = r.capsule, rng = random(cap.seed), vertical = cap.direction === "vertical";
  const width = vertical ? r.height : r.width, height = vertical ? r.width : r.height;
  const toPage = (p: Point): Point => vertical ? { x: r.width - p.y, y: p.x } : p;
  const carriers: ArtworkElement[] = [], placements: TextPlacement[] = [], dividers: LayoutDivider[] = [];
  const addCarrier = (box: Rect, key: string, text?: string, line = 0) => {
    if (box.width < 1.2 || box.height < 1.2) throw new Error("膠囊沒有足夠空間。請減少每排數量／段數、間距或外邊距。");
    const radius = Math.min(box.width, box.height) / 2 * cap.roundness;
    const source = roundedRect(box.x, box.y, box.width, box.height, radius);
    const polygons = mapSet(source.map((p) => p.map((ring) => subdivide(ring))), (p) => deform(toPage(p), r));
    carriers.push({ id: `capsule:${key}`, groupId: key, kind: "geometry", label: text || "Capsule", polygons, bounds: bounds(polygons) });
    if (text !== undefined) {
      const padding = Math.min(box.width, box.height) * cap.padding;
      const inner = { x: box.x + padding, y: box.y + padding, width: box.width - 2 * padding, height: box.height - 2 * padding };
      const innerRadius = Math.max(0, radius - padding);
      placements.push({ text, line, box: inner, groupId: key, mapPoint: (p) => {
        // Contract the letterfield at rounded ends. x/y are still local; all letters
        // share this envelope instead of getting separately clipped by the capsule.
        const u = clamp((p.x - inner.x) / inner.width, 0, 1), v = clamp((p.y - inner.y) / inner.height, 0, 1);
        const edgeY = Math.min(v * inner.height, (1 - v) * inner.height);
        const insetX = edgeY < innerRadius ? innerRadius - Math.sqrt(Math.max(0, innerRadius ** 2 - (innerRadius - edgeY) ** 2)) : 0;
        const edgeX = Math.min(u * inner.width, (1 - u) * inner.width);
        const insetY = edgeX < innerRadius ? innerRadius - Math.sqrt(Math.max(0, innerRadius ** 2 - (innerRadius - edgeX) ** 2)) : 0;
        // Apply the rounded-end envelope along the long axis only.
        return toPage(box.width >= box.height
          ? { x: p.x + (1 - 2 * u) * insetX * cap.follow, y: p.y }
          : { x: p.x, y: p.y + (1 - 2 * v) * insetY * cap.follow });
      } });
    }
  };

  if (cap.layout === "fit") {
    const texts = capsuleTexts(r), columns = Math.min(cap.lanes, texts.length), rows = Math.ceil(texts.length / columns);
    if (rows > 6) throw new Error(`文字包覆需要 ${rows} 排，最多 6 排。請增加每排膠囊數，或將文字單位改為「字行」。`);
    const rowGap = cap.gap + r.lineGap, availableHeight = height - 2 * r.margin - rowGap * (rows - 1);
    if (availableHeight < rows * 1.2) throw new Error("膠囊排距太大，沒有留下字面高度。請減少間距或排數。");
    const totalWeight = r.rowWeights.slice(0, rows).reduce((s, v) => s + v, 0);
    const usableWidth = width - r.margin * 2, staggerBudget = usableWidth * 0.07 * Math.abs(cap.stagger);
    let top = r.margin;
    for (let row = 0; row < rows; row++) {
      const rowTexts = texts.slice(row * columns, (row + 1) * columns), rowHeight = availableHeight * r.rowWeights[row] / totalWeight;
      const advance = rowTexts.map((text) => Math.max(1, font.getAdvanceWidth(text || "M", 100) + Math.max(0, text.length - 1) * r.tracking * 100));
      const average = advance.reduce((s, v) => s + v, 0) / advance.length;
      const proportions = advance.map((v) => 1 + cap.proportion * (v / average - 1));
      const sum = proportions.reduce((s, v) => s + v, 0), availableWidth = usableWidth - 2 * staggerBudget - (rowTexts.length - 1) * cap.gap;
      let left = r.margin + staggerBudget + (row % 2 ? 1 : -1) * usableWidth * 0.07 * cap.stagger;
      rowTexts.forEach((text, column) => {
        const slotWidth = availableWidth * proportions[column] / sum;
        const shorten = slotWidth * cap.variation * (0.08 + rng() * 0.2);
        addCarrier({ x: left + shorten * (0.5 + (row % 2 ? 0.4 : -0.4) * cap.stagger), y: top,
          width: slotWidth - shorten, height: rowHeight }, `${row}:${column}`, text, row * columns + column);
        left += slotWidth + cap.gap;
      });
      top += rowHeight + rowGap;
      if (row < rows - 1) {
        const y = top - rowGap / 2;
        dividers.push({ index: row, from: toPage({ x: 0, y }), to: toPage({ x: width, y }), axis: vertical ? "x" : "y", direction: vertical ? -1 : 1, span: availableHeight, rows });
      }
    }
  } else {
    const crossGap = cap.gap + r.lineGap;
    const laneSize = (height - r.margin * 2 - (cap.lanes - 1) * crossGap) / cap.lanes;
    const along = width - r.margin * 2 - (cap.segments - 1) * cap.gap;
    for (let lane = 0; lane < cap.lanes; lane++) {
      const lengths = Array.from({ length: cap.segments }, () => 1 + cap.variation * (rng() - 0.5) * 1.4);
      const sum = lengths.reduce((s, v) => s + v, 0);
      let left = r.margin + (lane % 2 ? 1 : -1) * cap.stagger * laneSize * 0.55;
      lengths.forEach((weight, segment) => {
        const length = along * weight / sum;
        addCarrier({ x: left, y: r.margin + lane * (laneSize + crossGap), width: length, height: laneSize }, `${lane}:${segment}`);
        left += length + cap.gap;
      });
    }
    placements.push(...posterLayout(r).placements);
    dividers.push(...posterLayout(r).dividers);
  }

  let elements = [...carriers, ...letterElements(font, r, placements)];
  // A carrier edit is a group transform: fitted text and capsule move / rotate together.
  elements = elements.map((element) => {
    const edit = element.groupId ? cap.edits[element.groupId] : undefined;
    if (!edit) return element;
    const carrier = carriers.find((c) => c.groupId === element.groupId)!;
    const cx = carrier.bounds.x + carrier.bounds.width / 2, cy = carrier.bounds.y + carrier.bounds.height / 2, a = edit.angle * Math.PI / 180;
    const polygons = mapSet(element.polygons, (p) => ({
      x: cx + edit.x + edit.scale * ((p.x - cx) * Math.cos(a) - (p.y - cy) * Math.sin(a)),
      y: cy + edit.y + edit.scale * ((p.x - cx) * Math.sin(a) + (p.y - cy) * Math.cos(a)),
    }));
    return { ...element, polygons, bounds: bounds(polygons) };
  });
  const shapes = union(...elements.filter((e) => e.kind === "geometry").map((e) => e.polygons));
  const text = union(...elements.filter((e) => e.kind === "glyph").map((e) => e.polygons));
  let polygons: PolygonSet;
  if (cap.operation === "outline") {
    const strokes = elements.filter((e) => e.kind === "geometry").map((e) => difference(e.polygons, offsetPolygons(e.polygons, -Math.max(0.15, Math.min(e.bounds.width, e.bounds.height) * 0.07))));
    polygons = union(text, ...strokes);
  } else polygons = combine(shapes, text, cap.operation === "knockout" ? "subtract" : cap.operation);
  return { elements, polygons, dividers };
}

/** Sample on a global mm grid, merge horizontal runs, then union to real regions. */
export function pixelate(polygons: PolygonSet, pitch: number, phase = 0): PolygonSet {
  const b = bounds(polygons), origin = phase * pitch, runs: PolygonSet[] = [];
  for (let iy = Math.floor((b.y - origin) / pitch); iy < Math.ceil((b.y + b.height - origin) / pitch); iy++) {
    const left = Math.floor((b.x - origin) / pitch), right = Math.ceil((b.x + b.width - origin) / pitch);
    let start: number | null = null;
    for (let ix = left; ix <= right; ix++) {
      const filled = ix < right && componentAt({ x: origin + (ix + 0.5) * pitch, y: origin + (iy + 0.5) * pitch }, polygons) >= 0;
      if (filled && start === null) start = ix;
      if (!filled && start !== null) {
        runs.push(shape(rectRing({ x: origin + start * pitch, y: origin + iy * pitch, width: (ix - start) * pitch, height: pitch })));
        start = null;
      }
    }
  }
  return union(...runs);
}

function glitch(polygons: PolygonSet, r: Recipe): PolygonSet {
  const rng = random(r.seed ^ 0x315fa), { bands, shift, damage, pitch } = r.pixel;
  if (bands > 0) {
    const height = r.height / bands;
    const parts = Array.from({ length: bands }, (_, i) => {
      const slice = intersect(polygons, shape(rectRing({ x: -r.width, y: i * height + (shift > 0 ? pitch * 0.18 : 0), width: r.width * 3, height: height - (shift > 0 ? pitch * 0.36 : 0) })));
      const dx = Math.round(((rng() - 0.5) * 2 * shift) / pitch) * pitch;
      return mapSet(slice, (p) => ({ x: p.x + dx, y: p.y }));
    });
    polygons = union(...parts);
  }
  const cuts: PolygonSet[] = [];
  for (let i = 0; i < Math.round(damage * 45); i++) {
    const x = Math.round(rng() * r.width / pitch) * pitch, y = Math.round(rng() * r.height / pitch) * pitch;
    cuts.push(shape(rectRing({ x, y, width: pitch * (1 + Math.floor(rng() * 4)), height: pitch })));
  }
  return cuts.length ? difference(polygons, ...cuts) : polygons;
}

export function maskGeometry(r: Recipe): PolygonSet {
  const m = r.mask, cx = m.x * r.width, cy = m.y * r.height, rx = m.width * r.width / 2, ry = m.height * r.height / 2;
  let result: PolygonSet;
  if (m.shape === "ellipse") result = ellipse(cx, cy, rx, ry);
  else if (m.shape === "band") result = shape(rectRing({ x: cx - rx, y: cy - ry, width: rx * 2, height: ry * 2 }));
  else result = shape(Array.from({ length: m.shape === "star" ? 10 : 4 }, (_, i) => {
    const star = m.shape === "star", count = star ? 10 : 4, angle = -Math.PI / 2 + i / count * Math.PI * 2, scale = star && i % 2 ? 0.42 : 1;
    return { x: cx + Math.cos(angle) * rx * scale, y: cy + Math.sin(angle) * ry * scale };
  }));
  const a = m.angle * Math.PI / 180;
  result = mapSet(result, (p) => ({ x: cx + (p.x - cx) * Math.cos(a) - (p.y - cy) * Math.sin(a), y: cy + (p.x - cx) * Math.sin(a) + (p.y - cy) * Math.cos(a) }));
  return result;
}

/** Original procedural shape vocabulary: lobed body, feet / antennae and cut-out face. */
export function characterGeometry(r: Recipe): PolygonSet {
  const rng = random(r.character.seed ^ 0x9a3f1), lobes = 4 + Math.floor(rng() * 4), radius = 0.75 + rng() * 0.2;
  const body = shape(Array.from({ length: 120 }, (_, i) => {
    const a = i / 120 * Math.PI * 2, rad = radius + 0.09 * Math.cos(a * lobes);
    return { x: Math.cos(a) * rad, y: Math.sin(a) * rad };
  }));
  const limbs = Array.from({ length: 2 + Math.floor(rng() * 3) }, (_, i) => {
    const a = i / 4 * Math.PI * 2 + 0.5;
    return roundedRect(Math.cos(a) * 0.68 - 0.13, Math.sin(a) * 0.68 - 0.13, 0.27, 0.52, 0.13);
  });
  const eyeY = -0.18 + rng() * 0.18, eyeGap = 0.22 + rng() * 0.15;
  const eyes = union(ellipse(-eyeGap, eyeY, 0.09, 0.15), ellipse(eyeGap, eyeY, 0.09, 0.15));
  const mouth = roundedRect(-0.16, 0.3, 0.32, 0.11 + rng() * 0.12, 0.05);
  let result = difference(union(body, ...limbs), eyes, mouth);
  if (r.flavor === "pixel") result = pixelate(result, 0.12);
  const s = r.character.size * Math.min(r.width, r.height) / 2.2;
  result = mapSet(result, (p) => ({ x: p.x * s + r.character.x * r.width, y: p.y * s + r.character.y * r.height }));
  return result;
}

export function generateArtwork(r: Recipe, font: Font): Artwork {
  const frame = shape(rectRing({ x: 0, y: 0, width: r.width, height: r.height }));
  const capsules = r.preset === "capsules" ? capsuleComposition(font, r) : null;
  const elements = capsules?.elements ?? letterElements(font, r);
  const dividers = capsules?.dividers ?? posterLayout(r).dividers;
  let artwork = capsules?.polygons ?? union(...elements.map((e) => e.polygons));
  const warnings: string[] = [];
  if (r.flavor === "pixel") {
    const countersBefore = artwork.reduce((n, p) => n + p.length - 1, 0);
    artwork = pixelate(artwork, r.pixel.pitch, r.pixel.phase);
    const countersAfter = artwork.reduce((n, p) => n + p.length - 1, 0);
    if (countersAfter < countersBefore) warnings.push(`階梯取樣後少了 ${countersBefore - countersAfter} 個孔洞／字腔。可減小階梯尺寸、改格點相位或換較開放的字型。`);
    artwork = glitch(artwork, r);
    if (r.pixel.backing) {
      const rows = r.text.split("\n").length, rng = random(r.seed ^ 0x7da9), rowHeight = (r.height - r.margin * 2) / rows;
      const backing = union(...Array.from({ length: rows }, (_, i) => {
        const inset = Math.round(rng() * 3) * r.pixel.pitch;
        return shape(rectRing({ x: r.margin * 0.5 + inset, y: r.margin * 0.5 + i * rowHeight, width: r.width - r.margin - inset * 2, height: rowHeight + r.margin }));
      }));
      artwork = difference(backing, artwork);
    }
  }
  const mask = maskGeometry(r), character = r.character.enabled ? characterGeometry(r) : [];
  if (r.mask.enabled) artwork = combine(artwork, mask, r.mask.operation);
  if (r.character.enabled) artwork = combine(artwork, character, r.character.operation);
  artwork = intersect(artwork, frame);
  if (r.inverted) artwork = difference(frame, artwork);
  const complement = difference(frame, artwork);
  const areaA = setArea(artwork), areaB = setArea(complement), vertices = artwork.flat(2).length + complement.flat(2).length;
  if (!r.text.trim() && r.preset !== "capsules") warnings.push("文字為空；目前只有啟用的幾何元素。");
  if (areaA < 0.01 || areaB < 0.01) warnings.push("至少一個形狀集合幾乎為空，請調整文字或布林操作。");
  const small = artwork.filter((p) => setArea([p]) < 0.15).length;
  if (small) warnings.push(`${small} 個 A 集合分量小於 0.15 mm²；尚未作製程修整。`);
  if (artwork.length > 80) warnings.push("圖案分量較多，後續需檢查集流與注液腔室；它們不代表子電池數量。");
  if (vertices > 150000) throw new Error("輪廓過於複雜，請加大階梯尺寸或減少文字。");
  return {
    format: "type-geometry-artwork-v1", stage: "resolved-artwork-not-fabrication", units: "mm", toleranceMm: FLATNESS_MM,
    width: r.width, height: r.height, a: artwork, b: complement, elements, dividers, mask, character,
    stats: { areaA, areaB, coverage: areaA / (r.width * r.height), components: artwork.length, holes: artwork.reduce((n, p) => n + p.length - 1, 0), vertices }, warnings,
  };
}

export function pathData(polygons: PolygonSet): string {
  const f = (v: number) => Number(v.toFixed(5));
  return polygons.map((p) => p.map((ring) => ring.map((v, i) => `${i ? "L" : "M"}${f(v.x)} ${f(v.y)}`).join("") + "Z").join("")).join("");
}
