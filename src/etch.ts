import type { ElectrodeBoundary, EtchPath, LayoutGeometry, PlateId, Point, Rect } from "./model";

const EPS = 1e-7;
const close = (a: number, b: number) => Math.abs(a - b) < EPS;

function coreSide(p: Point, r: Rect): EtchPath["glassEdge"] | undefined {
  // Corner ties prefer top/bottom, outside the protected side-contact bands.
  if (close(p.y, r.y)) return "top";
  if (close(p.y, r.y + r.height)) return "bottom";
  if (close(p.x, r.x)) return "left";
  if (close(p.x, r.x + r.width)) return "right";
}

function rayExit(p: Point, other: Point, glass: Rect): { point: Point; edge: EtchPath["glassEdge"] } {
  const dx = p.x - other.x, dy = p.y - other.y;
  const hits: Array<{ t: number; point: Point; edge: EtchPath["glassEdge"] }> = [];
  for (const [edge, x] of [["left", glass.x], ["right", glass.x + glass.width]] as const) {
    if (Math.abs(dx) < 1e-12) continue;
    const t = (x - p.x) / dx, y = p.y + t * dy;
    if (t >= -EPS && y >= glass.y - EPS && y <= glass.y + glass.height + EPS) hits.push({ t, point: { x, y }, edge });
  }
  for (const [edge, y] of [["top", glass.y], ["bottom", glass.y + glass.height]] as const) {
    if (Math.abs(dy) < 1e-12) continue;
    const t = (y - p.y) / dy, x = p.x + t * dx;
    if (t >= -EPS && x >= glass.x - EPS && x <= glass.x + glass.width + EPS) hits.push({ t, point: { x, y }, edge });
  }
  hits.sort((a, b) => a.t - b.t);
  return hits[0] ?? { point: { ...p }, edge: undefined };
}

/** No perimeter / independent fence is generated. Every extra cut starts at
 * an existing selected Voronoi endpoint and bleeds to a real glass edge. */
export function buildBleedEtchPaths(
  plate: PlateId, glass: Rect, core: Rect, boundaries: ElectrodeBoundary[], terminals: LayoutGeometry["terminals"],
): EtchPath[] {
  const selected = boundaries.flatMap((b, boundaryIndex) => b.etchPlates.includes(plate) ? [{ b, boundaryIndex }] : []);
  const coreCuts: EtchPath[] = selected.map(({ b, boundaryIndex }): EtchPath => ({
    source: "electrode-voronoi", plate, boundaryIndex, cells: [...b.cells], start: { ...b.start }, end: { ...b.end },
  }));
  const bleeds: EtchPath[] = [];
  const seen = new Set<string>();
  const shared = new Map<string, { side: "left" | "right"; edge: "top" | "bottom";
    b: ElectrodeBoundary; boundaryIndex: number; pieceIndex: number; p: Point }[]>();
  for (const { b, boundaryIndex } of selected) for (const [pieceIndex, p] of [b.start, b.end].entries()) {
    const side = coreSide(p, core);
    if (!side) continue;
    const other = pieceIndex === 0 ? b.end : b.start;
    let exit = rayExit(p, other, glass);
    if (plate === "glass-6066" && (side === "left" || side === "right")) {
      // All tips on one side must join ONE common line. Separate fan rays make
      // unnecessary parallel cuts and slivers along the zebra contact face.
      const terminal = terminals[side === "left" ? 0 : 1];
      let edge: "top" | "bottom";
      if (p.y <= terminal.gate.start.y + EPS) {
        edge = "top";
      } else if (p.y >= terminal.gate.end.y - EPS) {
        edge = "bottom";
      } else {
        throw new Error("Voronoi bleed endpoint falls inside a terminal-owned gate.");
      }
      const group = `${side}-${edge}`;
      shared.set(group, [...shared.get(group) ?? [], { side, edge, b, boundaryIndex, pieceIndex, p }]);
      continue;
    } else if (plate === "glass-6066" && (side === "top" || side === "bottom")) {
      // Keep a sloping ray out of the protected side-contact bands.
      if (exit.point.x < core.x - EPS || exit.point.x > core.x + core.width + EPS || exit.edge !== side) {
        exit = { point: { x: p.x, y: side === "top" ? glass.y : glass.y + glass.height }, edge: side };
      }
    }
    if (!exit.edge || Math.hypot(exit.point.x - p.x, exit.point.y - p.y) < 1e-9) continue;
    const key = [p.x, p.y, exit.point.x, exit.point.y].map((v) => Math.round(v * 1e7)).join(",");
    if (seen.has(key)) continue;
    seen.add(key);
    bleeds.push({ source: "voronoi-bleed", plate, boundaryIndex, cells: [...b.cells], pieceIndex,
      glassEdge: exit.edge, start: { ...p }, end: exit.point });
  }
  for (const tips of shared.values()) {
    const edge = tips[0].edge;
    // Farthest tip from the glass edge owns the one maximal shared interval;
    // every other branch ends on that interval as an exact T junction.
    const root = tips.reduce((a, b) => edge === "top" ? a.p.y >= b.p.y ? a : b : a.p.y <= b.p.y ? a : b);
    bleeds.push({ source: "voronoi-bleed", plate, boundaryIndex: root.boundaryIndex, cells: [...root.b.cells],
      pieceIndex: root.pieceIndex, glassEdge: edge, sharedSide: root.side,
      start: { ...root.p }, end: { x: root.p.x, y: edge === "top" ? glass.y : glass.y + glass.height } });
  }
  // A corner bleed can coincide with part of a shared interval. Keep only the
  // longest collinear segment ending at the same glass point, never scan twice.
  const merged: EtchPath[] = [];
  for (const p of bleeds) {
    const dx = p.end.x - p.start.x, dy = p.end.y - p.start.y, l = Math.hypot(dx, dy);
    if (l < 1e-9) continue;
    const index = merged.findIndex((q) => Math.hypot(q.end.x - p.end.x, q.end.y - p.end.y) < EPS &&
      Math.abs(dx * (q.start.y - p.start.y) - dy * (q.start.x - p.start.x)) <= EPS * l);
    if (index < 0) merged.push(p);
    else {
      const q = merged[index];
      const longer = l > Math.hypot(q.end.x - q.start.x, q.end.y - q.start.y) ? p : q;
      merged[index] = { ...longer, ...(p.sharedSide || q.sharedSide ? { sharedSide: p.sharedSide ?? q.sharedSide } : {}) };
    }
  }
  return [...coreCuts, ...merged];
}

export function bleedCheck(paths: EtchPath[], glass: Rect) {
  const bleeds = paths.filter((p) => p.source === "voronoi-bleed");
  const onGlass = (p: Point) => p.x >= glass.x - EPS && p.x <= glass.x + glass.width + EPS &&
    p.y >= glass.y - EPS && p.y <= glass.y + glass.height + EPS &&
    (close(p.x, glass.x) || close(p.x, glass.x + glass.width) || close(p.y, glass.y) || close(p.y, glass.y + glass.height));
  return { count: bleeds.length, allReachGlass: bleeds.every((p) => onGlass(p.end)),
    noPerimeter: paths.every((p) => p.source === "electrode-voronoi" || p.source === "voronoi-bleed") };
}
