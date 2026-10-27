import type { DesignConfig, FabricationGeometry, FillPort, LayoutGeometry, Point, PolygonSet, Rect } from "./model";
import { insetConvexPolygon } from "./point-code";
import { area, center, difference, intersect, offsetPolygons, rectRing, setArea, shape } from "./polygons";
import { artworkOpeningWidth, sealProcess } from "./process";
import { buildIsolationRoutes } from "./isolation";
import { bleedCheck as checkBleeds } from "./etch";
import { boundarySegments, coatingInset, minimumSealGap } from "./coating";
import { buildRetainedFto, checkFtoConnectivity } from "./fto-connectivity";

type BaseGeometry = Omit<LayoutGeometry, "fabrication">;

export function printedSealFootprint(outer: Rect, cells: Point[][], widthMm: number): PolygonSet {
  return difference(shape(rectRing(outer)), ...cells.map((r) => shape(insetConvexPolygon(r, widthMm / 2))));
}

function verticalInterval(r: Point[], x: number): [number, number] | null {
  const hits: number[] = [];
  r.forEach((p, i) => {
    const q = r[(i + 1) % r.length];
    if (Math.abs(q.x - p.x) < 1e-10) return;
    const t = (x - p.x) / (q.x - p.x);
    if (t >= 0 && t <= 1) hits.push(p.y + t * (q.y - p.y));
  });
  return hits.length >= 2 ? [Math.min(...hits), Math.max(...hits)] : null;
}

/** Minimum inclusion-wise edge cover with both upstream and downstream reachability.
 * All physical slots are vertical and cross just one inter-cell wall. */
function fillPorts(c: DesignConfig, g: BaseGeometry, regions: Point[][], width: number, printCavities: Point[][]): { ports: FillPort[]; errors: string[] } {
  const p = sealProcess(c), candidates: FillPort[] = [];
  const half = width / 2;
  const top = g.overlap.y, bottom = top + g.overlap.height;
  const centers = regions.map(center);
  const addCandidate = (from: number | "top", to: number | "bottom", minX: number, maxX: number) => {
    if (maxX - minX < width + 0.02) return;
    let best: FillPort | undefined;
    for (let step = 0; step <= 24; step++) {
      const x = minX + half + 0.01 + (maxX - minX - width - 0.02) * step / 24;
      const probes = [x - half, x, x + half];
      const upper = typeof from === "number" ? probes.map((v) => verticalInterval(regions[from], v)) : [];
      const lower = typeof to === "number" ? probes.map((v) => verticalInterval(regions[to], v)) : [];
      if ([...upper, ...lower].some((v) => !v)) continue;
      const y = from === "top" ? top : Math.min(...upper.map((v) => v![1])) - 0.02;
      const end = to === "bottom" ? bottom : Math.max(...lower.map((v) => v![0])) + 0.02;
      if (end <= y || (upper.length && y <= Math.max(...upper.map((v) => v![0]))) ||
        (lower.length && end >= Math.min(...lower.map((v) => v![1])))) continue;
      const port: FillPort = { x: x - half, y, width, height: end - y, from, to, finalWidthMm: p.targetScenarioClearMm, printedWidthMm: width };
      const slot = shape(rectRing(port));
      // Guard actual printed cavities, not only the shrunken stress cavities:
      // a wide cut must not open an unintended third cell near a junction.
      if (printCavities.some((r, i) => i !== from && i !== to && setArea(intersect(slot, shape(r))) > 1e-8)) continue;
      if (!best || port.height < best.height) best = port;
    }
    if (best) candidates.push(best);
  };
  const bounds = (r: Point[]) => [Math.min(...r.map((v) => v.x)), Math.max(...r.map((v) => v.x))];
  g.cells.forEach((cell, i) => {
    if (!regions[i].length) return;
    const [left, right] = bounds(regions[i]);
    if (cell.polygon.some((v) => Math.abs(v.y - g.active.y) < 1e-7)) addCandidate("top", i, left, right);
    if (cell.polygon.some((v) => Math.abs(v.y - g.active.y - g.active.height) < 1e-7)) addCandidate(i, "bottom", left, right);
  });
  g.boundaries.forEach((b) => {
    const [a, d] = b.cells;
    if (!regions[a].length || !regions[d].length || Math.abs(b.end.x - b.start.x) < 1e-7) return;
    const [from, to] = centers[a].y < centers[d].y ? [a, d] : [d, a];
    const [al, ar] = bounds(regions[a]), [bl, br] = bounds(regions[d]);
    addCandidate(from, to, Math.max(al, bl, Math.min(b.start.x, b.end.x)), Math.min(ar, br, Math.max(b.start.x, b.end.x)));
  });
  const reachable = (ports: FillPort[]) => {
    const up = new Set(ports.filter((p) => p.from === "top"));
    const down = new Set(ports.filter((p) => p.to === "bottom"));
    const follows = (a: FillPort, b: FillPort) => a.to === b.from && a.y + a.height <= b.y + 1e-7;
    // A cavity is convex, so ordered inlet/outlet heights admit an internal
    // straight path with nondecreasing Y. Centroid ordering alone is insufficient.
    for (let n = 0; n <= regions.length; n++) ports.forEach((p) => {
      if (ports.some((a) => up.has(a) && follows(a, p))) up.add(p);
      if (ports.some((b) => down.has(b) && follows(p, b))) down.add(p);
    });
    return regions.every((_, i) => ports.some((a) => a.to === i && up.has(a) &&
      ports.some((b) => b.from === i && down.has(b) && follows(a, b))));
  };
  const errors: string[] = [];
  if (!reachable(candidates)) errors.push("無法建立讓每個子電池由上進液、向下排氣的通道。請降低面積平衡／開口／Binding Width 或 Cell Jitter。");
  // Longest slots first: keep the shortest necessary network, remove all redundant slots.
  let ports = [...candidates].sort((a, b) => b.height - a.height);
  for (const candidate of [...ports]) {
    const reduced = ports.filter((p) => p !== candidate);
    if (reachable(reduced)) ports = reduced;
  }
  return { ports, errors };
}

/** Uniform edge-growth volume approximation on the ACTUAL printed footprint.
 * Solve A(grown print)*gap = A(print)*wet-film. No full-plate ligament surrogate. */
export function volumeOffsetForFootprint(print: PolygonSet, outer: PolygonSet, ratio: number): number | null {
  if (!Number.isFinite(ratio) || ratio < 1) return null;
  if (ratio === 1 || !print.length) return 0;
  const target = setArea(print) * ratio;
  if (target >= setArea(outer)) return null;
  let lo = 0, hi = 0.01;
  const grownArea = (s: number) => setArea(intersect(offsetPolygons(print, s), outer));
  while (hi < 1000 && grownArea(hi) < target) hi *= 2;
  if (hi >= 1000) return null;
  for (let i = 0; i < 17; i++) {
    const mid = (lo + hi) / 2;
    if (grownArea(mid) < target) lo = mid; else hi = mid;
  }
  return hi;
}

/** Largest centred rectangular free corridor through this slot, measured from
 * the dilated adhesive, not assigned from the requested opening setting. */
export function measurePortClearance(seal: PolygonSet, port: Rect): number {
  const obstacles = intersect(seal, shape(rectRing(port)));
  const cx = port.x + port.width / 2;
  let half = port.width / 2;
  obstacles.forEach((poly) => poly.forEach((ring) => ring.forEach((p, i) => {
    const q = ring[(i + 1) % ring.length];
    if ((p.x - cx) * (q.x - cx) <= 0) half = 0;
    half = Math.min(half, Math.abs(p.x - cx));
  })));
  return Math.max(0, 2 * half);
}

export function buildFabricationGeometry(c: DesignConfig, g: BaseGeometry): FabricationGeometry {
  const process = sealProcess(c);
  const outer = shape(rectRing(g.overlap));
  // Binding Width means exactly the printed normal wall width. It is NOT
  // inferred as the complement of a balanced / registration-inset coating.
  const printCavities = g.cells.map((cell) => insetConvexPolygon(cell.polygon, c.bindingWidthMm / 2));
  const unopened = printedSealFootprint(g.overlap, g.cells.map((cell) => cell.polygon), c.bindingWidthMm);
  let scenarioVolumeSpread = volumeOffsetForFootprint(unopened, outer, process.openingVolumeRatio);
  let spread = (scenarioVolumeSpread ?? process.openingVolumeSpreadMm ?? 0) + process.allowanceMm;
  let sealPrint = unopened;
  let fills: ReturnType<typeof fillPorts> = { ports: [], errors: [] };
  for (let attempt = 0; attempt < 3; attempt++) {
    const designSpread = spread + 0.005;
    const cavities = printCavities.map((r) => insetConvexPolygon(r, designSpread));
    fills = fillPorts(c, g, cavities, artworkOpeningWidth(c, spread), printCavities);
    sealPrint = difference(unopened, ...fills.ports.map((r) => shape(rectRing(r))));
    scenarioVolumeSpread = volumeOffsetForFootprint(sealPrint, outer, process.openingVolumeRatio);
    spread = (scenarioVolumeSpread ?? process.openingVolumeSpreadMm ?? 0) + process.allowanceMm;
    if (spread <= designSpread) break;
  }
  const sealAssembled = intersect(offsetPolygons(sealPrint, spread), outer);
  const ports = fills.ports.map((port) => ({ ...port, printedWidthMm: measurePortClearance(sealPrint, port),
    finalWidthMm: measurePortClearance(sealAssembled, port) }));
  const volumeSpread = volumeOffsetForFootprint(sealPrint, outer, process.volumeRatio);
  // Fill each convex cell to the shared safe wall offset. Centroid rescaling
  // previously discarded area and gave every edge a different white border.
  const clearance = coatingInset(c, spread);
  const activeRegions = g.cells.map((cell) => insetConvexPolygon(cell.polygon, clearance.insetMm));
  const printEdges = boundarySegments(sealPrint), scenarioEdges = boundarySegments(sealAssembled);
  const perCell = activeRegions.map((r, i) => ({ cellNumber: i + 1,
    printedMm: minimumSealGap(r, sealPrint, printEdges), scenarioMm: minimumSealGap(r, sealAssembled, scenarioEdges) }));
  const minimumGap = (key: "printedMm" | "scenarioMm") => {
    const values = perCell.map((r) => r[key]).filter((v): v is number => v !== null);
    return values.length ? Math.min(...values) : null;
  };
  const coatingClearance = { ...clearance, minimumPrintedMm: minimumGap("printedMm"), minimumScenarioMm: minimumGap("scenarioMm"),
    perCell, method: "parallel-wall-offset-no-trimming" as const };
  const cellAreasMm2 = activeRegions.map(area);
  const totalActiveMm2 = cellAreasMm2.reduce((a, b) => a + b, 0);
  const mean = totalActiveMm2 / Math.max(1, cellAreasMm2.length);
  const areaCv = mean > 0 ? Math.sqrt(cellAreasMm2.reduce((s, a) => s + (a - mean) ** 2, 0) / cellAreasMm2.length) / mean : 0;
  const retainedFto = buildRetainedFto(c, g);
  const errors = [...fills.errors];
  if (!Number.isFinite(c.coatingSafetyGapMm) || c.coatingSafetyGapMm < 0) errors.push("Coating Safety Gap 必須為有限且不小於 0 的平面距離。");
  if (perCell.some((r) => r.printedMm !== null && r.printedMm < clearance.printedRequiredMm - 0.002 ||
    r.scenarioMm !== null && r.scenarioMm < clearance.scenarioRequiredMm - 0.002)) {
    errors.push("塗層與 AB-313 的實際多邊形間距小於要求的安全距離／對位餘量，請檢查膠版與塗層幾何。");
  }
  const isolationRoutes = { "glass-6066": buildIsolationRoutes(g, "glass-6066"), "glass-6060": buildIsolationRoutes(g, "glass-6060") };
  const bleedCheck = { "glass-6066": checkBleeds(g.etchPaths["glass-6066"], g.glass6066),
    "glass-6060": checkBleeds(g.etchPaths["glass-6060"], g.glass6060) };
  for (const plate of ["glass-6066", "glass-6060"] as const) {
    if (isolationRoutes[plate].some((route) => !route.continuousTopToBottom)) errors.push(`${plate} 隔離路徑未連續貫穿實際玻璃上、下邊緣。`);
    if (!bleedCheck[plate].allReachGlass || !bleedCheck[plate].noPerimeter) errors.push(`${plate} Voronoi 出血未到玻璃邊緣，或含多餘周界蝕刻框。`);
  }
  if (process.compressionValid && volumeSpread === null) errors.push("印膠體積無法在指定玻璃間隙內容納，壓合模型不成立。");
  if (!process.openingScenarioValid || scenarioVolumeSpread === null) errors.push("開口設計情境的膠層／間隙不相容，不能據此推算壓合後孔寬。");
  if (ports.some((p) => p.printedWidthMm < c.minimumArtworkOpeningMm - 0.002)) errors.push("實際製版開口小於指定的製版孔寬下限。");
  if (ports.some((p) => p.finalWidthMm < process.targetScenarioClearMm - 0.002)) errors.push("壓合包絡下至少一個通道小於設定淨寬／已閉合；請加大開口或修正實測厚度與側向擴散餘量。");
  if (cellAreasMm2.some((a) => a < 0.01)) errors.push("至少一個子電池扣除封膠、對位與 FTO 蝕刻後沒有可用 active area。");
  const connectivity = checkFtoConnectivity(g, activeRegions, retainedFto);
  errors.push(...connectivity.errors);
  const terminalCheck = { ...connectivity.terminalCheck,
    fullHeightIsolation: isolationRoutes["glass-6066"].every((r) => r.continuousTopToBottom) };
  return { activeRegions, cellAreasMm2, totalActiveMm2, areaCv, coatingClearance, sealPrint, sealAssembled, ports, retainedFto,
    sealPrintAreaMm2: setArea(sealPrint), volumeSpreadMm: volumeSpread, envelopeSpreadMm: spread,
    minimumChannelMm: ports.length ? Math.min(...ports.map((p) => p.finalWidthMm)) : 0,
    minimumPrintedChannelMm: ports.length ? Math.min(...ports.map((p) => p.printedWidthMm)) : 0,
    openingScenario: { filmUm: process.openingFilmUm, source: process.openingFilmSource,
      volumeSpreadMm: scenarioVolumeSpread, valid: process.openingScenarioValid && scenarioVolumeSpread !== null },
    compressionValid: process.compressionValid && volumeSpread !== null, terminalCheck, isolationRoutes, bleedCheck, errors: [...new Set(errors)] };
}
