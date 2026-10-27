import ClipperLib from "clipper-lib";
import type { Point, PolygonSet, Rect, Segment } from "./model";

// Integer 1 nm grid in mm avoids sweep-line failures at co-circular junctions.
const SCALE = 1e6;
function paths(p: PolygonSet): ClipperLib.Paths {
  return p.flatMap((poly) => poly.map((ring, i) => {
    const path = ring.map(({ x, y }) => ({ X: Math.round(x * SCALE), Y: Math.round(y * SCALE) }));
    if (ClipperLib.Clipper.Orientation(path) !== (i === 0)) path.reverse();
    return path;
  }));
}
function operate(a: PolygonSet, b: PolygonSet, type: ClipperLib.ClipType): PolygonSet {
  const clipper = new ClipperLib.Clipper();
  clipper.StrictlySimple = true;
  clipper.AddPaths(paths(a), ClipperLib.PolyType.ptSubject, true);
  clipper.AddPaths(paths(b), ClipperLib.PolyType.ptClip, true);
  const tree = new ClipperLib.PolyTree();
  if (!clipper.Execute(type, tree, ClipperLib.PolyFillType.pftNonZero, ClipperLib.PolyFillType.pftNonZero)) return [];
  const ring = (p: ClipperLib.Path): Point[] => {
    const r = p.map(({ X, Y }) => ({ x: X / SCALE, y: Y / SCALE }));
    return r.length ? [...r, { ...r[0] }] : [];
  };
  return ClipperLib.JS.PolyTreeToExPolygons(tree).map((p) => [ring(p.outer), ...p.holes.map(ring)]);
}
export const shape = (ring: Point[]): PolygonSet => ring.length >= 3 ? [[ring]] : [];
export const union = (...p: PolygonSet[]): PolygonSet => operate(p.flat(), [], ClipperLib.ClipType.ctUnion);
export const difference = (a: PolygonSet, ...b: PolygonSet[]): PolygonSet =>
  a.length ? operate(a, b.flat(), ClipperLib.ClipType.ctDifference) : [];
export const intersect = (a: PolygonSet, b: PolygonSet): PolygonSet =>
  a.length && b.length ? operate(a, b, ClipperLib.ClipType.ctIntersection) : [];
export function offsetPolygons(polygons: PolygonSet, deltaMm: number): PolygonSet {
  if (!polygons.length || Math.abs(deltaMm) < 1e-7) return polygons;
  const offset = new ClipperLib.ClipperOffset(2, 500); // round arcs, 0.5 µm tolerance
  offset.AddPaths(paths(polygons), ClipperLib.JoinType.jtRound, ClipperLib.EndType.etClosedPolygon);
  const result: ClipperLib.Paths = [];
  offset.Execute(result, deltaMm * SCALE);
  // Preserve Clipper's outer/hole orientations when resolving the offset result.
  const clipper = new ClipperLib.Clipper();
  clipper.AddPaths(result, ClipperLib.PolyType.ptSubject, true);
  const tree = new ClipperLib.PolyTree();
  if (result.length && !clipper.Execute(ClipperLib.ClipType.ctUnion, tree,
    ClipperLib.PolyFillType.pftNonZero, ClipperLib.PolyFillType.pftNonZero)) {
    throw new Error("Unable to resolve adhesive offset polygons.");
  }
  const ring = (p: ClipperLib.Path) => { const r = p.map(({ X, Y }) => ({ x: X / SCALE, y: Y / SCALE })); return [...r, { ...r[0] }]; };
  return ClipperLib.JS.PolyTreeToExPolygons(tree).map((p) => [ring(p.outer), ...p.holes.map(ring)]);
}
export const rectRing = (r: Rect): Point[] => [
  { x: r.x, y: r.y }, { x: r.x + r.width, y: r.y },
  { x: r.x + r.width, y: r.y + r.height }, { x: r.x, y: r.y + r.height },
];
export function area(r: Point[]): number {
  return Math.abs(r.reduce((s, p, i) => { const q = r[(i + 1) % r.length]; return s + p.x * q.y - q.x * p.y; }, 0)) / 2;
}
export const setArea = (s: PolygonSet): number => s.reduce((a, p) => a + area(p[0]) - p.slice(1).reduce((h, r) => h + area(r), 0), 0);
export function center(r: Point[]): Point {
  let cross = 0, x = 0, y = 0;
  r.forEach((p, i) => { const q = r[(i + 1) % r.length]; const k = p.x * q.y - q.x * p.y; cross += k; x += (p.x + q.x) * k; y += (p.y + q.y) * k; });
  return Math.abs(cross) > 1e-12 ? { x: x / (3 * cross), y: y / (3 * cross) } : { x: 0, y: 0 };
}
export function scaleRing(r: Point[], scale: number): Point[] {
  const c = center(r);
  return r.map((p) => ({ x: c.x + (p.x - c.x) * scale, y: c.y + (p.y - c.y) * scale }));
}
/** Convex polygon parallel offset; positive expands, negative erodes. */
export function expandConvex(ring: Point[], offset: number): Point[] {
  const r = ring.length > 1 && ring[0].x === ring.at(-1)!.x && ring[0].y === ring.at(-1)!.y ? ring.slice(0, -1) : ring;
  if (r.length < 3) return [];
  const signed = r.reduce((a, p, i) => { const q = r[(i + 1) % r.length]; return a + p.x * q.y - q.x * p.y; }, 0);
  const lines = r.map((p, i) => {
    const q = r[(i + 1) % r.length], dx = q.x - p.x, dy = q.y - p.y, l = Math.hypot(dx, dy);
    return { p: { x: p.x + Math.sign(signed) * dy / l * offset, y: p.y - Math.sign(signed) * dx / l * offset }, dx, dy };
  });
  return lines.map((b, i) => {
    const a = lines[(i + lines.length - 1) % lines.length];
    const cross = a.dx * b.dy - a.dy * b.dx;
    if (Math.abs(cross) < 1e-12) return b.p;
    const t = ((b.p.x - a.p.x) * b.dy - (b.p.y - a.p.y) * b.dx) / cross;
    return { x: a.p.x + t * a.dx, y: a.p.y + t * a.dy };
  });
}
export function strokeRect(s: Segment, width: number): PolygonSet {
  const dx = s.end.x - s.start.x, dy = s.end.y - s.start.y, l = Math.hypot(dx, dy);
  if (l < 1e-10 || width <= 0) return [];
  const nx = -dy / l * width / 2, ny = dx / l * width / 2;
  return shape([{ x: s.start.x + nx, y: s.start.y + ny }, { x: s.end.x + nx, y: s.end.y + ny },
    { x: s.end.x - nx, y: s.end.y - ny }, { x: s.start.x - nx, y: s.start.y - ny }]);
}
export function containsRing(p: Point, r: Point[]): boolean {
  let inside = false;
  for (let i = 0, j = r.length - 1; i < r.length; j = i++) {
    const a = r[i], b = r[j];
    if ((a.y > p.y) !== (b.y > p.y) && p.x < (b.x - a.x) * (p.y - a.y) / (b.y - a.y) + a.x) inside = !inside;
  }
  return inside;
}
export const componentAt = (p: Point, s: PolygonSet): number => s.findIndex((poly) => containsRing(p, poly[0]) && !poly.slice(1).some((r) => containsRing(p, r)));
