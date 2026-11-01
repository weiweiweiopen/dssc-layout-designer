import type { DesignArtwork, FabricationGeometry, Point, PolygonSet, Rect } from "./model";
import { shape, union, setArea, rectRing, difference } from "./polygons";

export function cellCoating(f: Pick<FabricationGeometry, "activeRegions" | "activeShapes">, index: number): PolygonSet {
  return f.activeShapes ? f.activeShapes[index] ?? [] : shape(f.activeRegions[index] ?? []);
}

export function parseDesignArtwork(input: unknown): DesignArtwork {
  const fail = () => { throw new Error("圖案資料無效或超過可處理的範圍，請回 Studio 重新移交。"); };
  if (!input || typeof input !== "object") return fail();
  const a = input as DesignArtwork;
  const finite = (n: number, lo: number, hi: number) => typeof n === "number" && Number.isFinite(n) && n >= lo && n <= hi;
  if (a.format !== "dssc-vector-artwork-v1" || typeof a.id !== "string" || !/^[a-zA-Z0-9-]{1,80}$/.test(a.id) ||
    typeof a.title !== "string" || a.title.length > 160 || !finite(a.widthMm, 20, 150) || !finite(a.heightMm, 20, 150) ||
    !finite(a.targetVocV, 0.1, 40) || !finite(a.targetIscMa, 0, 100) || !finite(a.voltageToleranceV, 0.01, 2) ||
    !Array.isArray(a.regions) || a.regions.length > 500 ||
    (a.recipeJson !== undefined && (typeof a.recipeJson !== "string" || a.recipeJson.length > 4_200_000))) return fail();
  let vertices = 0;
  for (const polygon of a.regions) {
    if (!Array.isArray(polygon) || !polygon.length || polygon.length > 300) return fail();
    for (const ring of polygon) {
      if (!Array.isArray(ring) || ring.length < 3) return fail();
      vertices += ring.length;
      if (vertices > 60000 || ring.some((p) => !p || !finite(p.x, 0, a.widthMm) || !finite(p.y, 0, a.heightMm))) return fail();
    }
  }
  const regions = union(a.regions);
  const page = shape(rectRing({ x: 0, y: 0, width: a.widthMm, height: a.heightMm }));
  if (setArea(regions) < 0.01 || setArea(difference(regions, page)) > 1e-6) return fail();
  return { format: a.format, id: a.id, title: a.title, widthMm: a.widthMm, heightMm: a.heightMm, regions,
    ...(a.recipeJson ? { recipeJson: a.recipeJson } : {}), targetVocV: a.targetVocV, targetIscMa: a.targetIscMa, voltageToleranceV: a.voltageToleranceV };
}

/** Preserve aspect ratio. Frame placement is recorded and shared by all operations. */
export function mapArtwork(a: DesignArtwork, target: Rect): { polygons: PolygonSet; scale: number } {
  const scale = Math.min(target.width / a.widthMm, target.height / a.heightMm);
  const x = target.x + (target.width - a.widthMm * scale) / 2, y = target.y + (target.height - a.heightMm * scale) / 2;
  return { polygons: a.regions.map((p) => p.map((r) => r.map((v) => ({ x: x + v.x * scale, y: y + v.y * scale })))), scale };
}

/** Guaranteed interior sample from an even-odd scanline; centroids can lie in holes. */
export function interiorPoint(polygon: Point[][]): Point {
  const ys = [...new Set(polygon.flat().map((p) => p.y))].sort((a, b) => a - b);
  let best: Point | null = null, bestWidth = 0;
  const probes = Array.from({ length: Math.min(ys.length - 1, 40) }, (_, i) => {
    const index = Math.min(ys.length - 2, Math.floor(i * (ys.length - 1) / Math.min(ys.length - 1, 40)));
    return (ys[index] + ys[index + 1]) / 2;
  });
  for (const y of probes) {
    const hits: number[] = [];
    for (const ring of polygon) ring.forEach((p, i) => {
      const q = ring[(i + 1) % ring.length];
      if ((p.y > y) !== (q.y > y)) hits.push(p.x + (q.x - p.x) * (y - p.y) / (q.y - p.y));
    });
    hits.sort((a, b) => a - b);
    for (let i = 0; i + 1 < hits.length; i += 2) if (hits[i + 1] - hits[i] > bestWidth) {
      bestWidth = hits[i + 1] - hits[i]; best = { x: (hits[i] + hits[i + 1]) / 2, y };
    }
  }
  if (!best) throw new Error("圖案中有無法取樣的零面積區域。");
  return best;
}
