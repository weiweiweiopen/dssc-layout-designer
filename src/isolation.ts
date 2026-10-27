import type { IsolationRoute, LayoutGeometry, PlateId, Point } from "./model";

type RouteGeometry = Pick<LayoutGeometry, "glass6066" | "glass6060" | "cells" | "terminals" | "etchPaths">;
const key = (p: Point) => `${Math.round(p.x * 1e7)},${Math.round(p.y * 1e7)}`;

/** Trace actual Voronoi + bleed cuts incident to each terminal cell. No
 * perimeter edges are invented to complete a route. 6060 has no external
 * terminals and does not need an artificial pair of full-height fences. */
export function buildIsolationRoutes(g: RouteGeometry, plate: PlateId): IsolationRoute[] {
  if (plate !== "glass-6066") return [];
  const glass = g.glass6066;
  return (["left", "right"] as const).map((side, i) => {
    const terminal = g.terminals[i];
    const incident = g.etchPaths[plate].filter((path) => path.source === "electrode-voronoi" && path.cells?.includes(terminal.cellIndex));
    const tips = new Set(incident.flatMap((p) => [key(p.start), key(p.end)]));
    const paths = g.etchPaths[plate].map((path, pathIndex) => ({ path, pathIndex }))
      .filter(({ path }) => path.cells?.includes(terminal.cellIndex) || path.source === "voronoi-bleed" && tips.has(key(path.start)));
    const nodes = new Map<string, Point>();
    paths.forEach(({ path }) => { nodes.set(key(path.start), path.start); nodes.set(key(path.end), path.end); });
    const edges = new Map<string, Array<{ to: string; index: number }>>();
    for (const { path, pathIndex } of paths) {
      const dx = path.end.x - path.start.x, dy = path.end.y - path.start.y, l2 = dx * dx + dy * dy;
      if (l2 < 1e-16) continue;
      // Split a long collinear segment at any incident vertex before tracing.
      const points = [...nodes.entries()].flatMap(([id, p]) => {
        const t = ((p.x - path.start.x) * dx + (p.y - path.start.y) * dy) / l2;
        const d = Math.abs(dx * (p.y - path.start.y) - dy * (p.x - path.start.x)) / Math.sqrt(l2);
        return t >= -1e-7 && t <= 1 + 1e-7 && d < 1e-7 ? [{ id, t }] : [];
      }).sort((a, b) => a.t - b.t);
      for (let n = 1; n < points.length; n++) {
        const a = points[n - 1].id, b = points[n].id;
        if (a === b) continue;
        edges.set(a, [...edges.get(a) ?? [], { to: b, index: pathIndex }]);
        edges.set(b, [...edges.get(b) ?? [], { to: a, index: pathIndex }]);
      }
    }
    const starts = [...nodes.entries()].filter(([, p]) => Math.abs(p.y - glass.y) < 1e-7)
      .sort((a, b) => Math.abs(a[1].x - terminal.contact.x) - Math.abs(b[1].x - terminal.contact.x));
    const previous = new Map<string, { from: string | null; index: number }>();
    const queue = starts.map(([id]) => { previous.set(id, { from: null, index: -1 }); return id; });
    let target: string | undefined;
    for (let read = 0; read < queue.length; read++) {
      const id = queue[read], p = nodes.get(id)!;
      if (Math.abs(p.y - glass.y - glass.height) < 1e-7) { target = id; break; }
      for (const e of edges.get(id) ?? []) if (!previous.has(e.to)) {
        previous.set(e.to, { from: id, index: e.index }); queue.push(e.to);
      }
    }
    const points: Point[] = [], indices: number[] = [];
    let cursor: string | null = target ?? null;
    while (cursor !== null) {
      points.push(nodes.get(cursor)!);
      const p = previous.get(cursor)!;
      if (p.index >= 0) indices.push(p.index);
      cursor = p.from;
    }
    return { side, points: points.reverse(), pathIndices: [...new Set(indices.reverse())],
      continuousTopToBottom: target !== undefined && points.length > 1 };
  });
}
