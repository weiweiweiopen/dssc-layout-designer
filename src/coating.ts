import type { DesignConfig, Point, PolygonSet, Segment } from "./model";
import { intersect, setArea, shape } from "./polygons";

/** The same parallel wall offset is used by every cell. No per-cell scaling. */
export function coatingInset(c: DesignConfig, scenarioSpreadMm: number) {
  const scenarioRequiredMm = c.coatingSafetyGapMm + c.registrationMm;
  const printedRequiredMm = scenarioSpreadMm + scenarioRequiredMm;
  return {
    targetMm: c.coatingSafetyGapMm,
    registrationMm: c.registrationMm,
    scenarioSpreadMm,
    scenarioRequiredMm,
    printedRequiredMm,
    insetMm: Math.max(c.bindingWidthMm / 2 + printedRequiredMm,
      c.ftoEtchWidthMm / 2 + c.registrationMm),
  };
}

export function boundarySegments(polygons: PolygonSet): Segment[] {
  return polygons.flatMap((p) => p.flatMap((r) => r.flatMap((start, i) => {
    const end = r[(i + 1) % r.length];
    return Math.hypot(end.x - start.x, end.y - start.y) > 1e-12 ? [{ start, end }] : [];
  })));
}

function pointSegmentSquared(p: Point, a: Point, b: Point): number {
  const dx = b.x - a.x, dy = b.y - a.y;
  const t = Math.max(0, Math.min(1, ((p.x - a.x) * dx + (p.y - a.y) * dy) / (dx * dx + dy * dy)));
  return (p.x - a.x - t * dx) ** 2 + (p.y - a.y - t * dy) ** 2;
}

const cross = (p: Point, q: Point, r: Point) => (q.x - p.x) * (r.y - p.y) - (q.y - p.y) * (r.x - p.x);

/** Independent Euclidean gap measurement on the actual generated polygons.
 * Segment bounds prune the many round-offset arc chords before distance work. */
export function minimumSealGap(region: Point[], seal: PolygonSet, segments = boundarySegments(seal)): number | null {
  if (region.length < 3 || !segments.length) return null;
  if (setArea(intersect(shape(region), seal)) > 1e-9) return 0;
  let best = Infinity;
  for (let i = 0; i < region.length; i++) {
    const a = region[i], b = region[(i + 1) % region.length];
    if (Math.hypot(b.x - a.x, b.y - a.y) < 1e-12) continue;
    for (const { start: c, end: d } of segments) {
      const dx = Math.max(0, Math.min(a.x, b.x) - Math.max(c.x, d.x), Math.min(c.x, d.x) - Math.max(a.x, b.x));
      const dy = Math.max(0, Math.min(a.y, b.y) - Math.max(c.y, d.y), Math.min(c.y, d.y) - Math.max(a.y, b.y));
      if (dx * dx + dy * dy >= best) continue;
      if (dx === 0 && dy === 0 && cross(a, b, c) * cross(a, b, d) <= 0 && cross(c, d, a) * cross(c, d, b) <= 0) return 0;
      best = Math.min(best, pointSegmentSquared(a, c, d), pointSegmentSquared(b, c, d),
        pointSegmentSquared(c, a, b), pointSegmentSquared(d, a, b));
    }
  }
  return Number.isFinite(best) ? Math.sqrt(best) : null;
}
