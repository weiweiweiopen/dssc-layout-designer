import type { DesignConfig, FabricationGeometry, LayoutGeometry, Point, PolygonSet } from "./model";
import { center, componentAt, difference, intersect, offsetPolygons, rectRing, setArea, shape, strokeRect, union } from "./polygons";
import { insetConvexPolygon } from "./point-code";
import { interiorPoint, mapArtwork } from "./artwork-source";
import { artworkOpeningWidth, sealProcess } from "./process";
import { coatingInset, minimumShapeSealGap } from "./coating";
import { measurePortClearance, volumeOffsetForFootprint } from "./fabrication-geometry";

type BaseGeometry = Omit<LayoutGeometry, "fabrication">;
const disc = (p: Point, radius: number) => shape(Array.from({ length: 20 }, (_, i) => ({ x: p.x + radius * Math.cos(i * Math.PI / 10), y: p.y + radius * Math.sin(i * Math.PI / 10) })));
const stroke = (a: Point, b: Point, width: number) => union(strokeRect({ start: a, end: b }, width), disc(a, width / 2), disc(b, width / 2));

/** Connect only disconnected natural cavities. Prim's tree needs n-1 joins,
 * rather than a visually destructive inlet/outlet fan for every letter. */
function cavityJoins(components: PolygonSet, width: number): PolygonSet {
  if (components.length < 2) return [];
  const samples = components.map((p) => p.flatMap((ring) => ring.filter((_, i) => i % Math.max(1, Math.ceil(ring.length / 36)) === 0)));
  const edges = new Map<string, { a: Point; b: Point; cost: number }>();
  const edge = (i: number, j: number) => {
    const key = `${Math.min(i, j)}:${Math.max(i, j)}`;
    if (!edges.has(key)) {
      let best = { a: samples[i][0], b: samples[j][0], cost: Infinity };
      for (const a of samples[i]) for (const b of samples[j]) {
        const cost = (a.x - b.x) ** 2 + (a.y - b.y) ** 2;
        if (cost < best.cost) best = { a, b, cost };
      }
      edges.set(key, best);
    }
    return edges.get(key)!;
  };
  const visited = new Set([0]), cuts: PolygonSet[] = [];
  while (visited.size < components.length) {
    let target = -1, best: ReturnType<typeof edge> | null = null;
    for (const i of visited) for (let j = 0; j < components.length; j++) if (!visited.has(j)) {
      const candidate = edge(i, j);
      if (!best || candidate.cost < best.cost) { best = candidate; target = j; }
    }
    if (!best || target < 0) break;
    cuts.push(stroke(best.a, best.b, width)); visited.add(target);
  }
  return union(...cuts);
}

/** Inlet / outlet connectivity at the actual compressed adhesive geometry.
 * Erosion tests a clearance corridor; it does not simulate capillary kinetics or air. */
export function checkPatternFlow(outer: PolygonSet, seal: PolygonSet, active: PolygonSet[], requiredWidthMm: number): NonNullable<FabricationGeometry["pattern"]>["flow"] {
  const free = difference(outer, seal);
  const points = outer.flat(2), left = Math.min(...points.map((p) => p.x)), right = Math.max(...points.map((p) => p.x));
  const top = Math.min(...points.map((p) => p.y)), bottom = Math.max(...points.map((p) => p.y));
  const radius = Math.max(0, requiredWidthMm - 0.002) / 2, padding = Math.max(1, requiredWidthMm * 2);
  const topPad = shape(rectRing({ x: left - padding, y: top - padding, width: right - left + 2 * padding, height: padding + 0.0001 }));
  const bottomPad = shape(rectRing({ x: left - padding, y: bottom - 0.0001, width: right - left + 2 * padding, height: padding + 0.0001 }));
  const topProbe = shape(rectRing({ x: left, y: top, width: right - left, height: 0.01 }));
  const bottomProbe = shape(rectRing({ x: left, y: bottom - 0.01, width: right - left, height: 0.01 }));
  const reachesBoth = (p: Point[][]) => setArea(intersect([p], topProbe)) > 1e-8 && setArea(intersect([p], bottomProbe)) > 1e-8;
  const reachable = free.filter(reachesBoth);
  // Extend only the actual top / bottom exterior before erosion so an open port
  // is not artificially closed by eroding the boundary of the glass itself.
  const wide = intersect(offsetPolygons(union(free, topPad, bottomPad), -radius), outer);
  const wideReachable = wide.filter(reachesBoth);
  const cells = active.map((regions, i) => ({ cellNumber: i + 1, fragments: regions.length,
    reachableFragments: regions.filter((p) => {
      const sample = interiorPoint(p);
      return componentAt(sample, reachable) >= 0 && setArea(intersect([p], wideReachable)) > 1e-8;
    }).length }));
  return { requiredWidthMm, chambers: free.length, reachableChambers: reachable.length, cells,
    pass: free.length > 0 && reachable.length === free.length && cells.every((v) => v.fragments > 0 && v.fragments === v.reachableFragments),
    monotoneDownwardVerified: false,
    basis: "polygon-connectivity-and-eroded-clearance-not-fluid-simulation" };
}

export function applyArtworkPattern(c: DesignConfig, g: BaseGeometry, base: FabricationGeometry): FabricationGeometry {
  if (!c.artwork) return base;
  const { polygons: mapped, scale } = mapArtwork(c.artwork, g.active), process = sealProcess(c), outer = shape(rectRing(g.overlap));
  const cavities = g.cells.map((cell) => shape(insetConvexPolygon(cell.polygon, c.bindingWidthMm / 2)));
  const portCuts = union(...base.ports.map((p) => shape(rectRing(p))));
  const errors = [...base.errors];
  let spread = base.envelopeSpreadMm, sealPrint = base.sealPrint, channels: PolygonSet = [], scenarioVolume: number | null = null;
  let routeWidth = artworkOpeningWidth(c, spread);
  // Rebuild the white-area adhesive against the measured / scenario spread.
  // Source letters are not secretly scaled per-cell to achieve equal current.
  for (let attempt = 0; attempt < 4; attempt++) {
    const designSpread = spread + 0.005, clearance = coatingInset(c, designSpread);
    const protectedArt = offsetPolygons(mapped, clearance.printedRequiredMm);
    const extra = difference(outer, protectedArt);
    const unopened = union(base.sealPrint, extra);
    routeWidth = artworkOpeningWidth(c, designSpread);
    const routes: PolygonSet[] = [];
    for (const cell of g.cells) {
      const i = cell.index, cavity = cavities[i];
      const incoming = base.ports.filter((p) => p.to === i), outgoing = base.ports.filter((p) => p.from === i);
      // Extend a port only inside this cavity. A tiny 0.02-mm lip is sufficient
      // for boolean connectivity, but not for a compression-clearance corridor.
      const extensions = (ports: typeof incoming) => ports.map((p) => intersect(cavity,
        shape(rectRing({ x: p.x, y: g.overlap.y, width: p.width, height: g.overlap.height }))));
      const inletExtensions = extensions(incoming), outletExtensions = extensions(outgoing);
      const anchor = (sets: PolygonSet[]) => sets.flat().filter((p) => setArea([p]) > 1e-8).map(interiorPoint);
      const upstream = anchor(inletExtensions), downstream = anchor(outletExtensions);
      if (!upstream.length || !downstream.length) { errors.push(`圖案 cell ${i + 1} 缺少可用的注液／排氣接點。`); continue; }
      const naturalFree = union(difference(cavity, unopened), ...inletExtensions, ...outletExtensions);
      // A narrow pre-compression touch is not a robust connection. Route between
      // clearance-eroded cores so tiny joins cannot disappear after glue growth.
      const coreInset = Math.max(0, spread + process.targetScenarioClearMm / 2 - 0.002);
      const chambers = offsetPolygons(naturalFree, -coreInset).filter((p) => setArea([p]) > 1e-8);
      if (chambers.length > 150) { errors.push(`圖案 cell ${i + 1} 的腔室過多，請簡化圖案。`); continue; }
      // Internal routes stay inside their original cavity. Only the original,
      // third-cell-checked ports cross a cell wall or the outside seal.
      routes.push(union(intersect(cavityJoins(chambers, routeWidth), cavity), ...inletExtensions, ...outletExtensions));
    }
    channels = union(portCuts, ...routes);
    sealPrint = difference(unopened, channels);
    scenarioVolume = volumeOffsetForFootprint(sealPrint, outer, process.openingVolumeRatio);
    const nextSpread = (scenarioVolume ?? base.openingScenario.volumeSpreadMm ?? 0) + process.allowanceMm;
    spread = nextSpread;
    if (scenarioVolume === null || nextSpread <= designSpread) break;
    if (attempt === 3) errors.push("圖案補膠與流道補償尚未收斂，請調整實測濕膜、間距或簡化圖案。");
  }
  const sealAssembled = intersect(offsetPolygons(sealPrint, spread), outer), clearance = coatingInset(c, spread);
  const safeFromGlue = difference(outer, offsetPolygons(sealAssembled, clearance.scenarioRequiredMm + 0.002));
  const activeShapes = g.cells.map((cell) => intersect(intersect(mapped,
    shape(insetConvexPolygon(cell.polygon, clearance.insetMm))), safeFromGlue));
  const cellAreasMm2 = activeShapes.map(setArea), totalActiveMm2 = cellAreasMm2.reduce((s, a) => s + a, 0), mean = totalActiveMm2 / g.cells.length;
  const areaCv = mean > 0 ? Math.sqrt(cellAreasMm2.reduce((s, a) => s + (a - mean) ** 2, 0) / g.cells.length) / mean : 0;
  const perCell = activeShapes.map((p, i) => ({ cellNumber: i + 1, printedMm: minimumShapeSealGap(p, sealPrint), scenarioMm: minimumShapeSealGap(p, sealAssembled) }));
  const minGap = (key: "printedMm" | "scenarioMm") => { const values = perCell.map((p) => p[key]).filter((v): v is number => v !== null); return values.length ? Math.min(...values) : null; };
  const ports = base.ports.map((p) => ({ ...p, printedWidthMm: measurePortClearance(sealPrint, p), finalWidthMm: measurePortClearance(sealAssembled, p) }));
  const volumeSpread = volumeOffsetForFootprint(sealPrint, outer, process.volumeRatio);
  if (scenarioVolume === null) errors.push("圖案補膠的體積超過指定間隙可容納範圍；請填入實測濕膜或調整補膠／製程。未知滿載情境不能視為已通過。");
  if (process.compressionValid && volumeSpread === null) errors.push("圖案補膠的名義體積無法在玻璃間隙內容納。");
  if (cellAreasMm2.some((a) => a < 0.01)) errors.push("至少一個圖案子電池沒有有效塗層。請降低串聯數或重新平衡分區。");
  if (perCell.some((p) => p.printedMm !== null && p.printedMm < clearance.printedRequiredMm - 0.002 || p.scenarioMm !== null && p.scenarioMm < clearance.scenarioRequiredMm - 0.002)) errors.push("圖案塗層到補膠的安全間距不足。");
  if (ports.some((p) => p.finalWidthMm < process.targetScenarioClearMm - 0.002)) errors.push("圖案補膠後的至少一個注液開口已閉合或小於要求淨寬。");
  let ftoFragmentsValid = true;
  for (const plate of ["glass-6066", "glass-6060"] as const) for (const cell of g.cells) {
    const expected = componentAt(base.activeRegions[cell.index]?.length ? center(base.activeRegions[cell.index]) : cell.site, base.retainedFto[plate]);
    const island = expected >= 0 ? [base.retainedFto[plate][expected]] : [];
    if (!island.length || setArea(difference(activeShapes[cell.index], island)) > 1e-7) {
      ftoFragmentsValid = false; errors.push(`${plate} 圖案 cell ${cell.index + 1} 的塗層分量未完整連到正確 FTO 導體島。`);
    }
  }
  const flow = checkPatternFlow(outer, sealAssembled, activeShapes, process.targetScenarioClearMm);
  if (!flow.pass) errors.push("圖案的部分腔室／塗層分量沒有同時連到上方注液及下方排氣，或通道淨寬不足。");
  return { ...base, activeShapes, cellAreasMm2, totalActiveMm2, areaCv, sealPrint, sealAssembled, ports,
    coatingClearance: { ...clearance, method: "parallel-wall-offset-no-trimming", perCell, minimumPrintedMm: minGap("printedMm"), minimumScenarioMm: minGap("scenarioMm") },
    sealPrintAreaMm2: setArea(sealPrint), volumeSpreadMm: volumeSpread, envelopeSpreadMm: spread,
    compressionValid: process.compressionValid && volumeSpread !== null,
    openingScenario: { ...base.openingScenario, volumeSpreadMm: scenarioVolume, valid: process.openingScenarioValid && scenarioVolume !== null },
    minimumChannelMm: ports.length ? Math.min(...ports.map((p) => p.finalWidthMm)) : 0,
    minimumPrintedChannelMm: ports.length ? Math.min(...ports.map((p) => p.printedWidthMm)) : 0,
    pattern: { sourceId: c.artwork.id, mapped, scale, sourceAreaMm2: setArea(mapped), retainedAreaFraction: totalActiveMm2 / Math.max(1e-9, setArea(mapped)),
      additionalSealMm2: setArea(difference(sealPrint, base.sealPrint)), channels, channelWidthMm: routeWidth, scenarioValid: process.openingScenarioValid && scenarioVolume !== null, ftoFragmentsValid, flow },
    errors: [...new Set(errors)] };
}
