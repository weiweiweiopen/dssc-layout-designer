import { Delaunay } from "d3-delaunay";
import { buildFabricationGeometry, printedSealFootprint, volumeOffsetForFootprint } from "./fabrication-geometry";
import { sealProcess } from "./process";
import { buildBleedEtchPaths } from "./etch";
import { insetConvexPolygon } from "./point-code";
import { coatingInset } from "./coating";
import { rectRing, shape } from "./polygons";
import { buildRetainedFto, checkFtoConnectivity } from "./fto-connectivity";

import type {
  DesignConfig,
  DesignWarning,
  ElectrodeBoundary,
  ElectrodeCell,
  EtchPath,
  LayoutGeometry,
  PlateId,
  Point,
  Rect,
  Segment,
  TerminalGate,
} from "./model";

const EDGE_INSET_RATIO = 0.08;
const MAX_SITE_JITTER_RATIO = 2;
const PRACTICAL_CELL_LIMIT = 64;
const POINT_EPSILON = 1e-9;
const JITTER_RETRY_FACTORS = [1, 0.75, 0.5, 0.25, 0.125, 0] as const;
const SITE_TEMPLATE_RETRY_COUNT = 32;
const SEED_RETRY_INCREMENT = 0x9e3779b9;
const TOPOLOGY_TIE_BREAK_JITTER_RATIO = 1e-9;

interface SiteTemplate {
  point: Point;
  xStep: number;
  yStep: number;
  xNoise: number;
  yNoise: number;
}

interface VoronoiResult {
  sites: Point[];
  polygons: Point[][];
  boundaries: ElectrodeBoundary[];
}

function finiteNonnegative(value: number): number {
  return Number.isFinite(value) ? Math.max(0, value) : 0;
}

function normalizedCellCount(value: number): number {
  return Number.isFinite(value) ? Math.max(0, Math.trunc(value)) : 0;
}

function cloneRect(rect: Rect): Rect {
  return { ...rect };
}

function intersectRects(first: Rect, second: Rect): Rect {
  const x = Math.max(first.x, second.x);
  const y = Math.max(first.y, second.y);
  const right = Math.min(first.x + first.width, second.x + second.width);
  const bottom = Math.min(first.y + first.height, second.y + second.height);

  return {
    x,
    y,
    width: Math.max(0, right - x),
    height: Math.max(0, bottom - y),
  };
}

function insetRect(rect: Rect, inset: number): Rect {
  return {
    x: rect.x + inset,
    y: rect.y + inset,
    width: Math.max(0, rect.width - inset * 2),
    height: Math.max(0, rect.height - inset * 2),
  };
}

function activePerimeter(rect: Rect): Segment[] {
  const topLeft = { x: rect.x, y: rect.y };
  const topRight = { x: rect.x + rect.width, y: rect.y };
  const bottomRight = {
    x: rect.x + rect.width,
    y: rect.y + rect.height,
  };
  const bottomLeft = { x: rect.x, y: rect.y + rect.height };

  return [
    { start: topLeft, end: topRight },
    { start: topRight, end: bottomRight },
    { start: bottomRight, end: bottomLeft },
    { start: bottomLeft, end: topLeft },
  ];
}

function seededRandom(seed: number): () => number {
  let state = (Number.isFinite(seed) ? Math.trunc(seed) : 0) >>> 0;

  return () => {
    state = (state + 0x6d2b79f5) >>> 0;
    let value = state;
    value = Math.imul(value ^ (value >>> 15), value | 1);
    value ^= value + Math.imul(value ^ (value >>> 7), value | 61);
    return ((value ^ (value >>> 14)) >>> 0) / 4_294_967_296;
  };
}

function chooseOddRowCount(count: number, active: Rect): number {
  if (count <= 2) return count === 0 ? 0 : 1;

  const width = active.width > 0 ? active.width : 1;
  const height = active.height > 0 ? active.height : 1;
  let bestRows = 1;
  let bestScore = Number.POSITIVE_INFINITY;

  for (let rows = 1; rows <= count; rows += 2) {
    const cellAspect = (width * rows * rows) / (height * count);
    const score = Math.abs(Math.log(cellAspect));
    if (
      score < bestScore - Number.EPSILON ||
      (Math.abs(score - bestScore) <= Number.EPSILON && rows > bestRows)
    ) {
      bestRows = rows;
      bestScore = score;
    }
  }

  return bestRows;
}

function balancedRowLengths(count: number, rowCount: number): number[] {
  if (rowCount === 0) return [];

  const baseLength = Math.floor(count / rowCount);
  const remainder = count % rowCount;
  const lengths = Array<number>(rowCount).fill(baseLength);

  for (let extra = 0; extra < remainder; extra += 1) {
    const row = Math.floor(((extra + 0.5) * rowCount) / remainder);
    lengths[row] += 1;
  }

  return lengths;
}

function createSiteTemplates(
  count: number,
  rowCount: number,
  active: Rect,
  seed: number,
): SiteTemplate[] {
  if (count === 0) return [];

  const random = seededRandom(seed);
  const left = active.x + active.width * EDGE_INSET_RATIO;
  const right = active.x + active.width * (1 - EDGE_INSET_RATIO);
  const top = active.y + active.height * EDGE_INSET_RATIO;
  const bottom = active.y + active.height * (1 - EDGE_INSET_RATIO);
  const spanX = right - left;
  const spanY = bottom - top;
  const templates: SiteTemplate[] = [];

  if (rowCount <= 1) {
    for (let index = 0; index < count; index += 1) {
      const amount = count === 1 ? 0.5 : index / (count - 1);
      templates.push({
        point: {
          x: count === 1 ? active.x + active.width / 2 : left + spanX * amount,
          y: count === 1 ? active.y + active.height / 2 : top + spanY * amount,
        },
        xStep: count > 1 ? spanX / (count - 1) : active.width,
        yStep: count > 1 ? spanY / (count - 1) : active.height,
        xNoise: random() * 2 - 1,
        yNoise: random() * 2 - 1,
      });
    }
    return templates;
  }

  const rowLengths = balancedRowLengths(count, rowCount);
  const longestRow = Math.max(...rowLengths);
  const yStep = spanY / (rowCount - 1);

  for (let row = 0; row < rowCount; row += 1) {
    const rowLength = rowLengths[row];
    const rowXStep =
      rowLength > 1
        ? spanX / (rowLength - 1)
        : spanX / Math.max(1, longestRow - 1);

    for (
      let sequenceColumn = 0;
      sequenceColumn < rowLength;
      sequenceColumn += 1
    ) {
      const physicalColumn =
        row % 2 === 0 ? sequenceColumn : rowLength - sequenceColumn - 1;
      let x: number;

      if (rowLength > 1) {
        x = left + physicalColumn * rowXStep;
      } else if (row === 0) {
        x = left;
      } else if (row === rowCount - 1) {
        x = right;
      } else {
        x = active.x + active.width / 2;
      }

      templates.push({
        point: { x, y: top + row * yStep },
        xStep: rowXStep,
        yStep,
        xNoise: random() * 2 - 1,
        yNoise: random() * 2 - 1,
      });
    }
  }

  return templates;
}

function clamp(value: number, minimum: number, maximum: number): number {
  return Math.min(maximum, Math.max(minimum, value));
}

function interiorPadding(origin: number, length: number): number {
  const floatingPointPadding =
    Number.EPSILON * Math.max(1, Math.abs(origin), length) * 32;
  return Math.min(length / 4, Math.max(length * 1e-9, floatingPointPadding));
}

function sitesForJitter(
  templates: SiteTemplate[],
  active: Rect,
  requestedJitter: number,
  retryFactor: number,
): Point[] {
  const jitter =
    Number.isFinite(requestedJitter) && requestedJitter > 0
      ? Math.min(requestedJitter, MAX_SITE_JITTER_RATIO)
      : 0;
  const paddingX = interiorPadding(active.x, active.width);
  const paddingY = interiorPadding(active.y, active.height);
  const minimumX = active.x + paddingX;
  const maximumX = active.x + active.width - paddingX;
  const minimumY = active.y + paddingY;
  const maximumY = active.y + active.height - paddingY;

  return templates.map((template, index) => {
    const endpointDamping =
      index === 0 || index === templates.length - 1 ? 0.35 : 1;
    return {
      x: clamp(
        template.point.x +
          template.xNoise *
            template.xStep *
            jitter *
            retryFactor *
            endpointDamping,
        minimumX,
        maximumX,
      ),
      y: clamp(
        template.point.y +
          template.yNoise *
            template.yStep *
            jitter *
            retryFactor *
            endpointDamping,
        minimumY,
        maximumY,
      ),
    };
  });
}

function pointsEqual(first: Point, second: Point): boolean {
  const scale = Math.max(
    1,
    Math.abs(first.x),
    Math.abs(first.y),
    Math.abs(second.x),
    Math.abs(second.y),
  );
  return (
    Math.abs(first.x - second.x) <= POINT_EPSILON * scale &&
    Math.abs(first.y - second.y) <= POINT_EPSILON * scale
  );
}

function polygonVertexCount(polygon: Point[]): number {
  return polygon.length > 1 &&
    pointsEqual(polygon[0], polygon[polygon.length - 1])
    ? polygon.length - 1
    : polygon.length;
}

function segmentLength(segment: Segment): number {
  return Math.hypot(
    segment.end.x - segment.start.x,
    segment.end.y - segment.start.y,
  );
}

function maximalOwnedSideSpan(
  polygon: Point[],
  active: Rect,
  side: "left" | "right",
): Segment | null {
  const vertexCount = polygonVertexCount(polygon);
  if (vertexCount < 2) return null;

  const sideX = side === "left" ? active.x : active.x + active.width;
  const coordinateScale = Math.max(
    1,
    Math.abs(sideX),
    Math.abs(active.y),
    active.width,
    active.height,
  );
  const tolerance = POINT_EPSILON * coordinateScale;
  const intervals: Array<{ top: number; bottom: number }> = [];

  for (let index = 0; index < vertexCount; index += 1) {
    const start = polygon[index];
    const end = polygon[(index + 1) % vertexCount];
    if (
      Math.abs(start.x - sideX) > tolerance ||
      Math.abs(end.x - sideX) > tolerance
    ) {
      continue;
    }

    const top = Math.min(start.y, end.y);
    const bottom = Math.max(start.y, end.y);
    if (bottom - top > tolerance) intervals.push({ top, bottom });
  }

  if (intervals.length === 0) return null;
  intervals.sort((first, second) => first.top - second.top);
  const merged: Array<{ top: number; bottom: number }> = [];
  for (const interval of intervals) {
    const previous = merged[merged.length - 1];
    if (previous && interval.top <= previous.bottom + tolerance) {
      previous.bottom = Math.max(previous.bottom, interval.bottom);
    } else {
      merged.push({ ...interval });
    }
  }

  const maximal = merged.reduce((longest, interval) =>
    interval.bottom - interval.top > longest.bottom - longest.top
      ? interval
      : longest,
  );
  if (maximal.bottom - maximal.top <= tolerance) return null;
  return {
    start: { x: sideX, y: maximal.top },
    end: { x: sideX, y: maximal.bottom },
  };
}

function sharedPolygonEdge(first: Point[], second: Point[]): Segment | null {
  const firstCount = polygonVertexCount(first);
  const secondCount = polygonVertexCount(second);
  const shared: Point[] = [];

  for (let firstIndex = 0; firstIndex < firstCount; firstIndex += 1) {
    const firstStart = first[firstIndex];
    const firstEnd = first[(firstIndex + 1) % firstCount];
    for (let secondIndex = 0; secondIndex < secondCount; secondIndex += 1) {
      const secondStart = second[secondIndex];
      const secondEnd = second[(secondIndex + 1) % secondCount];
      if (
        pointsEqual(firstStart, secondEnd) &&
        pointsEqual(firstEnd, secondStart)
      ) {
        shared.push(firstStart, firstEnd);
      }
    }
  }

  // d3 may split a straight shared boundary at an extra collinear vertex
  // (notably two-cell layouts). Etching only the first piece leaves a bypass.
  let span: Segment | null = null;
  let longest = 0;
  for (const start of shared) for (const end of shared) {
    const length = Math.hypot(end.x - start.x, end.y - start.y);
    if (length > longest) { span = { start, end }; longest = length; }
  }
  return span;
}

function orderedSegment(segment: Segment): Segment {
  const startFirst =
    segment.start.x < segment.end.x ||
    (segment.start.x === segment.end.x && segment.start.y <= segment.end.y);
  return startFirst ? segment : { start: segment.end, end: segment.start };
}

function oppositePlate(plate: PlateId): PlateId {
  return plate === "glass-6060" ? "glass-6066" : "glass-6060";
}

function makeBoundary(
  firstCell: number,
  secondCell: number,
  segment: Segment,
): ElectrodeBoundary {
  const cells: [number, number] =
    firstCell < secondCell ? [firstCell, secondCell] : [secondCell, firstCell];
  const seriesConnection = cells[1] === cells[0] + 1;
  const connectionPlate: PlateId | null = seriesConnection
    ? cells[0] % 2 === 0
      ? "glass-6060"
      : "glass-6066"
    : null;
  const etchPlates: PlateId[] = connectionPlate
    ? [oppositePlate(connectionPlate)]
    : ["glass-6066", "glass-6060"];

  return {
    ...orderedSegment(segment),
    cells,
    seriesConnection,
    connectionPlate,
    etchPlates,
  };
}

function recoverBoundaries(
  polygons: Point[][],
  neighbors: (index: number) => Iterable<number>,
): ElectrodeBoundary[] | null {
  const boundaries: ElectrodeBoundary[] = [];

  for (let firstCell = 0; firstCell < polygons.length; firstCell += 1) {
    for (const secondCell of neighbors(firstCell)) {
      if (secondCell <= firstCell) continue;
      const edge = sharedPolygonEdge(polygons[firstCell], polygons[secondCell]);
      if (!edge) return null;
      boundaries.push(makeBoundary(firstCell, secondCell, edge));
    }
  }

  boundaries.sort(
    (first, second) =>
      first.cells[0] - second.cells[0] ||
      first.cells[1] - second.cells[1] ||
      first.start.x - second.start.x ||
      first.start.y - second.start.y,
  );
  return boundaries;
}

function buildVoronoiCandidate(
  sites: Point[],
  active: Rect,
): VoronoiResult | null {
  const tuples = sites.map(({ x, y }) => [x, y] as [number, number]);
  const delaunay = Delaunay.from(tuples);
  const voronoi = delaunay.voronoi([
    active.x,
    active.y,
    active.x + active.width,
    active.y + active.height,
  ]);
  const polygons: Point[][] = [];

  for (let index = 0; index < sites.length; index += 1) {
    const polygon = voronoi.cellPolygon(index);
    if (!polygon || polygon.length < 4) return null;
    polygons.push(
      polygon.map(([x, y]) => ({
        x: Object.is(x, -0) ? 0 : x,
        y: Object.is(y, -0) ? 0 : y,
      })),
    );
  }

  for (let index = 0; index < sites.length - 1; index += 1) {
    if (!new Set(delaunay.neighbors(index)).has(index + 1)) return null;
  }

  const boundaries = recoverBoundaries(polygons, (index) =>
    voronoi.neighbors(index),
  );
  if (!boundaries) return null;

  const seriesPairs = new Set(
    boundaries
      .filter(({ seriesConnection }) => seriesConnection)
      .map(({ cells }) => `${cells[0]}:${cells[1]}`),
  );
  for (let index = 0; index < sites.length - 1; index += 1) {
    if (!seriesPairs.has(`${index}:${index + 1}`)) return null;
  }

  if (
    !maximalOwnedSideSpan(polygons[0], active, "left") ||
    !maximalOwnedSideSpan(polygons[polygons.length - 1], active, "right")
  ) {
    return null;
  }

  return { sites, polygons, boundaries };
}

function buildVoronoi(
  count: number,
  rowCount: number,
  active: Rect,
  config: DesignConfig,
): VoronoiResult {
  if (count === 0) return { sites: [], polygons: [], boundaries: [] };

  if (active.width <= 0 || active.height <= 0) {
    const site = {
      x: active.x + active.width / 2,
      y: active.y + active.height / 2,
    };
    return {
      sites: Array.from({ length: count }, () => ({ ...site })),
      polygons: Array.from({ length: count }, () => []),
      boundaries: [],
    };
  }

  // Exact grids can be cocircular, so later seeded templates provide deterministic tie-breaking.
  const baseSeed =
    (Number.isFinite(config.electrodeSeed)
      ? Math.trunc(config.electrodeSeed)
      : 0) >>> 0;
  for (
    let templateAttempt = 0;
    templateAttempt < SITE_TEMPLATE_RETRY_COUNT;
    templateAttempt += 1
  ) {
    const templates = createSiteTemplates(
      count,
      rowCount,
      active,
      (baseSeed + Math.imul(templateAttempt, SEED_RETRY_INCREMENT)) >>> 0,
    );
    const requestedJitter =
      templateAttempt > 0 &&
      (!Number.isFinite(config.electrodeJitter) || config.electrodeJitter <= 0)
        ? TOPOLOGY_TIE_BREAK_JITTER_RATIO
        : config.electrodeJitter;

    for (const retryFactor of JITTER_RETRY_FACTORS) {
      const sites = sitesForJitter(
        templates,
        active,
        requestedJitter,
        retryFactor,
      );
      try {
        const candidate = buildVoronoiCandidate(sites, active);
        if (candidate) return candidate;
      } catch {
        // Retry deterministically before treating a valid envelope as impossible.
      }
    }
  }

  throw new Error(
    `無法為 ${count} 個子電池建立連續的 Delaunay/Voronoi 電氣路徑。`,
  );
}

function makeCell(
  index: number,
  site: Point,
  polygon: Point[],
): ElectrodeCell {
  const even = index % 2 === 0;
  return {
    index,
    site,
    polygon,
    glass6066Material: even ? "tio2" : "pt",
    glass6060Material: even ? "pt" : "tio2",
  };
}

function manufacturablePartition(candidate: VoronoiResult, active: Rect, c: DesignConfig, clearance: number): boolean {
  if (!(Number.isFinite(c.ftoEtchWidthMm) && c.ftoEtchWidthMm > 0 && Number.isFinite(c.laserSpotMm) && c.laserSpotMm > 0)) return false;
  const glass6066 = { x: 0, y: 0, width: c.glass6066WidthMm, height: c.glassHeightMm };
  const glass6060 = { x: (c.glass6066WidthMm - c.glass6060WidthMm) / 2, y: 0, width: c.glass6060WidthMm, height: c.glassHeightMm };
  const cells = candidate.sites.map((site, i) => makeCell(i, site, candidate.polygons[i]));
  const overlap = intersectRects(glass6066, glass6060);
  const terminals = terminalGeometry(glass6066, overlap, active, cells);
  try {
    const etchPaths = { "glass-6066": buildBleedEtchPaths("glass-6066", glass6066, active, candidate.boundaries, terminals),
      "glass-6060": buildBleedEtchPaths("glass-6060", glass6060, active, candidate.boundaries, terminals) };
    if (Object.values(etchPaths).some((paths) => paths.some((p) => segmentLength(p) < c.laserSpotMm))) return false;
    const retained = buildRetainedFto(c, { glass6066, glass6060, etchPaths });
    const regions = candidate.polygons.map((r) => insetConvexPolygon(r, clearance));
    return checkFtoConnectivity({ cells, terminals }, regions, retained).errors.length === 0;
  } catch {
    return false;
  }
}

/** Constrained coordinate descent on Voronoi generators. Every accepted move
 * preserves the Hamiltonian W-series adjacency and terminal side ownership.
 * The objective uses post-seal active area, not raw Voronoi area. */
function balanceVoronoi(initial: VoronoiResult, active: Rect, config: DesignConfig): VoronoiResult {
  const strength = Math.max(0, Math.min(1, config.areaBalance));
  if (!strength || active.width <= 0 || active.height <= 0 || !Number.isFinite(config.bindingWidthMm) || config.bindingWidthMm < 0) return initial;
  const process = sealProcess(config);
  const half = config.bindingWidthMm / 2;
  const overlap = { x: active.x - half, y: active.y - half, width: active.width + 2 * half, height: active.height + 2 * half };
  // Use the same opening-film basis as final coating clearance. This first
  // footprint is a planning estimate; final ports / offset are remeasured later.
  const planningSpread = (volumeOffsetForFootprint(printedSealFootprint(overlap, initial.polygons, config.bindingWidthMm),
    shape(rectRing(overlap)), process.openingVolumeRatio) ?? process.openingVolumeSpreadMm ?? 0) + process.allowanceMm;
  const clearance = coatingInset(config, planningSpread).insetMm;
  const score = (candidate: VoronoiResult) => {
    const areas = candidate.polygons.map((r) => polygonArea(insetConvexPolygon(r, clearance)));
    const mean = areas.reduce((s, a) => s + a, 0) / areas.length;
    if (!(mean > 0) || Math.min(...areas) <= 0) return Infinity;
    return areas.reduce((s, a) => s + (a - mean) ** 2, 0) / (areas.length * mean ** 2)
      - 0.15 * Math.min(...areas) / mean - 0.05 * mean * areas.length / (active.width * active.height);
  };
  let best = initial, bestScore = score(initial);
  // Search can cross a cocircular / tiny-edge intermediate state (notably
  // jitter=0). Only the best finite-kerf-manufacturable visited layout is output.
  let feasible = manufacturablePartition(initial, active, config, clearance) ? initial : null;
  let feasibleScore = feasible ? bestScore : Infinity;
  const length = Math.min(active.width, active.height) / Math.sqrt(initial.sites.length);
  for (const factor of [0.12, 0.06, 0.025, 0.01]) {
    const step = length * factor * strength;
    for (let sweep = 0; sweep < (best.sites.length <= 16 ? 2 : 1); sweep++) {
      let improved = false;
      for (let i = 0; i < best.sites.length; i++) for (const axis of ["x", "y"] as const) {
        for (const direction of [-1, 1]) {
          const sites = best.sites.map((p) => ({ ...p }));
          sites[i][axis] += direction * step;
          const origin = axis === "x" ? active.x : active.y;
          const span = axis === "x" ? active.width : active.height;
          if (sites[i][axis] <= origin + 1e-5 || sites[i][axis] >= origin + span - 1e-5) continue;
          const candidate = buildVoronoiCandidate(sites, active);
          if (!candidate) continue;
          const value = score(candidate);
          if (value < bestScore - 1e-10) {
            best = candidate; bestScore = value; improved = true;
          }
        }
      }
      // Gate whole coordinate-descent sweeps, not every trial move. This keeps
      // the same exact final connectivity check affordable for 32–64 cells.
      if (bestScore < feasibleScore && manufacturablePartition(best, active, config, clearance)) {
        feasible = best; feasibleScore = bestScore;
      }
      if (!improved) break;
    }
  }
  return feasible ?? initial;
}

function terminalGates(
  active: Rect,
  cells: ElectrodeCell[],
): [TerminalGate, TerminalGate] {
  const makeGate = (
    polarity: TerminalGate["polarity"],
    side: TerminalGate["side"],
    cellIndex: number,
    polygon: Point[] | undefined,
  ): TerminalGate => {
    const sideX = side === "left" ? active.x : active.x + active.width;
    const middleY = active.y + active.height / 2;
    const span = polygon
      ? maximalOwnedSideSpan(polygon, active, side)
      : null;
    return {
      polarity,
      plate: "glass-6066",
      cellIndex,
      side,
      start: span?.start ?? { x: sideX, y: middleY },
      end: span?.end ?? { x: sideX, y: middleY },
    };
  };

  return [
    makeGate("negative", "left", cells.length > 0 ? 0 : -1, cells[0]?.polygon),
    makeGate(
      "positive",
      "right",
      cells.length - 1,
      cells[cells.length - 1]?.polygon,
    ),
  ];
}

function terminalContactStrips(
  glass6066: Rect,
  overlap: Rect,
): [Rect, Rect] {
  const glassRight = glass6066.x + glass6066.width;
  const overlapRight = overlap.x + overlap.width;
  const leftStripRight = clamp(overlap.x, glass6066.x, glassRight);
  const rightStripLeft = clamp(overlapRight, glass6066.x, glassRight);

  return [
    {
      x: glass6066.x,
      y: glass6066.y,
      width: Math.max(0, leftStripRight - glass6066.x),
      height: glass6066.height,
    },
    {
      x: rightStripLeft,
      y: glass6066.y,
      width: Math.max(0, glassRight - rightStripLeft),
      height: glass6066.height,
    },
  ];
}

function terminalGeometry(
  glass6066: Rect,
  overlap: Rect,
  active: Rect,
  cells: ElectrodeCell[],
): LayoutGeometry["terminals"] {
  const [negativeStrip, positiveStrip] = terminalContactStrips(
    glass6066,
    overlap,
  );
  const [negativeGate, positiveGate] = terminalGates(active, cells);

  return [
    {
      polarity: "negative",
      plate: "glass-6066",
      contactStrip: negativeStrip,
      contact: {
        x: negativeStrip.x + negativeStrip.width / 2,
        y: (negativeGate.start.y + negativeGate.end.y) / 2,
      },
      cellIndex: negativeGate.cellIndex,
      gate: negativeGate,
    },
    {
      polarity: "positive",
      plate: "glass-6066",
      contactStrip: positiveStrip,
      contact: {
        x: positiveStrip.x + positiveStrip.width / 2,
        y: (positiveGate.start.y + positiveGate.end.y) / 2,
      },
      cellIndex: positiveGate.cellIndex,
      gate: positiveGate,
    },
  ];
}

function canonicalEtchPaths(
  plate: PlateId,
  glass: Rect,
  active: Rect,
  _perimeter: Segment[],
  boundaries: ElectrodeBoundary[],
  terminals: LayoutGeometry["terminals"],
): EtchPath[] {
  return buildBleedEtchPaths(plate, glass, active, boundaries, terminals);
}

export function buildGeometry(config: DesignConfig): LayoutGeometry {
  const glass6066: Rect = {
    x: 0,
    y: 0,
    width: finiteNonnegative(config.glass6066WidthMm),
    height: finiteNonnegative(config.glassHeightMm),
  };
  const glass6060Width = finiteNonnegative(config.glass6060WidthMm);
  const glass6060: Rect = {
    x: (glass6066.width - glass6060Width) / 2,
    y: 0,
    width: glass6060Width,
    height: glass6066.height,
  };
  const overlap = intersectRects(glass6066, glass6060);
  const bindingWidth = finiteNonnegative(config.bindingWidthMm);
  // Half the printed outer seal is inside the Voronoi frame; the cell inset
  // supplies the other half. The resulting outer AND inter-cell print widths are B.
  const active = insetRect(overlap, bindingWidth / 2);
  const cellCount = normalizedCellCount(config.subcellCount);
  const rowCount = chooseOddRowCount(cellCount, active);
  const voronoi = balanceVoronoi(buildVoronoi(cellCount, rowCount, active, config), active, config);
  const cells = voronoi.sites.map((site, index) =>
    makeCell(index, site, voronoi.polygons[index]),
  );
  const perimeter = activePerimeter(active);
  const terminals = terminalGeometry(glass6066, overlap, active, cells);
  const etchPaths: LayoutGeometry["etchPaths"] = {
    "glass-6066": canonicalEtchPaths(
      "glass-6066",
      glass6066,
      active,
      perimeter,
      voronoi.boundaries,
      terminals,
    ),
    "glass-6060": canonicalEtchPaths(
      "glass-6060",
      glass6060,
      active,
      perimeter,
      voronoi.boundaries,
      terminals,
    ),
  };

  const base = {
    glass6066,
    glass6060,
    overlap,
    active,
    bindingOuter: cloneRect(overlap),
    bindingInner: cloneRect(active),
    rowCount,
    cells,
    boundaries: voronoi.boundaries,
    activePerimeter: perimeter,
    terminals,
    etchPaths,
    electronPath: [
      terminals[0].contact,
      ...cells.map(({ site }) => site),
      terminals[1].contact,
    ],
  };
  return { ...base, fabrication: buildFabricationGeometry(config, base) };
}

function validRect(rect: Rect): boolean {
  return (
    Number.isFinite(rect.x) &&
    Number.isFinite(rect.y) &&
    Number.isFinite(rect.width) &&
    Number.isFinite(rect.height) &&
    rect.width > 0 &&
    rect.height > 0
  );
}

function samePlateSet(actual: PlateId[], expected: PlateId[]): boolean {
  return (
    actual.length === expected.length &&
    expected.every((plate) => actual.includes(plate))
  );
}

function expectedConnectionPlate(index: number): PlateId {
  return index % 2 === 0 ? "glass-6060" : "glass-6066";
}

function rectsEqual(first: Rect | undefined, second: Rect): boolean {
  return (
    first !== undefined &&
    pointsEqual(
      { x: first.x, y: first.y },
      { x: second.x, y: second.y },
    ) &&
    pointsEqual(
      { x: first.width, y: first.height },
      { x: second.width, y: second.height },
    )
  );
}

function segmentsEqual(
  first: Segment | undefined,
  second: Segment,
): boolean {
  return (
    first !== undefined &&
    pointsEqual(first.start, second.start) &&
    pointsEqual(first.end, second.end)
  );
}

function gatesEqual(
  actual: TerminalGate | undefined,
  expected: TerminalGate,
): boolean {
  return (
    actual !== undefined &&
    actual.polarity === expected.polarity &&
    actual.plate === expected.plate &&
    actual.cellIndex === expected.cellIndex &&
    actual.side === expected.side &&
    segmentsEqual(actual, expected)
  );
}

function etchPathsEqual(actual: EtchPath, expected: EtchPath): boolean {
  const commonKeys = ["source", "plate", "start", "end"];
  const sourceKeys: Record<EtchPath["source"], string[]> = {
    "electrode-voronoi": ["boundaryIndex", "cells"],
    "voronoi-bleed": ["boundaryIndex", "cells", "pieceIndex", "glassEdge", "sharedSide"],
    "active-perimeter": ["perimeterIndex", "pieceIndex"],
    "terminal-isolation": ["isolationIndex"],
    "contact-strip-isolation": ["polarity", "pieceIndex"],
  };
  const allowedKeys = new Set([...commonKeys, ...sourceKeys[expected.source]]);
  if (Object.keys(actual).some((key) => !allowedKeys.has(key))) return false;
  if (
    actual.source !== expected.source ||
    actual.plate !== expected.plate ||
    !segmentsEqual(actual, expected)
  ) {
    return false;
  }

  if (expected.source === "electrode-voronoi" || expected.source === "voronoi-bleed") {
    return (
      actual.boundaryIndex === expected.boundaryIndex &&
      actual.cells?.[0] === expected.cells?.[0] &&
      actual.cells?.[1] === expected.cells?.[1] &&
      (expected.source !== "voronoi-bleed" || actual.pieceIndex === expected.pieceIndex && actual.glassEdge === expected.glassEdge && actual.sharedSide === expected.sharedSide)
    );
  }
  if (expected.source === "active-perimeter") {
    return (
      actual.perimeterIndex === expected.perimeterIndex &&
      actual.pieceIndex === expected.pieceIndex
    );
  }
  if (expected.source === "contact-strip-isolation") {
    return actual.polarity === expected.polarity && actual.pieceIndex === expected.pieceIndex;
  }
  return actual.isolationIndex === expected.isolationIndex;
}

function canonicalPathSetMatches(
  actual: EtchPath[] | undefined,
  expected: EtchPath[],
): boolean {
  return (
    actual !== undefined &&
    actual.length === expected.length &&
    actual.every((path, index) => etchPathsEqual(path, expected[index]))
  );
}

export function validateDesign(
  config: DesignConfig,
  geometry: LayoutGeometry,
): DesignWarning[] {
  const warnings: DesignWarning[] = [];
  const add = (severity: DesignWarning["severity"], message: string): void => {
    warnings.push({ severity, message });
  };
  // Fabrication checks use actual cut widths and printable polygons.
  geometry.fabrication.errors.forEach((message) => add("error", message));
  const process = sealProcess(config);
  process.errors.forEach((message) => add("error", message));
  if (config.bindingWidthMm < process.minBindingMm || config.bindingWidthMm > process.maxBindingMm) {
    add("error", `Binding Width 超出此製程幾何範圍 ${process.minBindingMm.toFixed(2)}–${process.maxBindingMm.toFixed(2)} mm。`);
  }
  if (config.ftoEtchWidthMm > 5) add("error", "FTO Etch Width 上限為 5 mm。");
  if (config.laserHatchMm <= 0 || config.laserSpotMm <= 0 || config.laserHatchMm > config.laserSpotMm || config.laserSpotMm > config.ftoEtchWidthMm) {
    add("error", "雷射需滿足 0 < hatch ≤ spot ≤ FTO Etch Width，才能填滿且不超出切除區。");
  }
  if (Object.values(geometry.etchPaths).some((paths) => paths.some((s) => segmentLength(s) < config.laserSpotMm))) {
    add("error", "至少一段蝕刻線短於光斑，雷射填滿會超出名義端點；請縮小光斑或調整 seed / jitter。");
  }
  for (const [key, value] of Object.entries(config)) {
    if (typeof value === "number" && !Number.isFinite(value)) add("error", `${key} 必須是有限數值。`);
  }

  if (!validRect(geometry.glass6066)) {
    add("error", "6066 玻璃的寬高必須是有限且大於 0 的數值。");
  }
  if (!validRect(geometry.glass6060)) {
    add("error", "6060 玻璃的寬高必須是有限且大於 0 的數值。");
  }
  if (config.glass6066WidthMm <= config.glass6060WidthMm) {
    add("error", "Bigger Electrode W 必須大於 Smaller Electrode W，才能在左右兩側保留斑馬條接觸區。");
  }
  if (geometry.glass6066.height !== config.glassHeightMm || geometry.glass6060.height !== config.glassHeightMm || geometry.glass6060.y !== 0) {
    add("error", "兩片電極必須使用同一 Shared Glass Height，並上下齊平。");
  }
  if (!validRect(geometry.overlap)) {
    add("error", "兩片玻璃的重疊區必須具有有限且大於 0 的寬高。");
  }
  if (!validRect(geometry.active)) {
    add(
      "error",
      "Binding 內縮後沒有正尺寸的有效區，請縮小封框寬度或增加重疊尺寸。",
    );
  }

  const validBindingWidth =
    Number.isFinite(config.bindingWidthMm) && config.bindingWidthMm > 0;
  if (!validBindingWidth) {
    add("error", "Binding 寬度必須是有限且大於 0 的數值。");
  } else if (config.bindingWidthMm < process.minBindingMm || config.bindingWidthMm > 5) {
    add(
      "error",
      `Binding 寬度必須介於 ${process.minBindingMm.toFixed(2)} 至 5 mm；目前為 ${String(config.bindingWidthMm)} mm。`,
    );
  }

  const expectedActive = insetRect(
    geometry.overlap,
    finiteNonnegative(config.bindingWidthMm) / 2,
  );
  if (
    !rectsEqual(geometry.bindingOuter, geometry.overlap) ||
    !rectsEqual(geometry.bindingInner, geometry.active) ||
    !rectsEqual(geometry.active, expectedActive)
  ) {
    add(
      "error",
      "Binding 外框為玻璃交集，Voronoi / FTO frame 必須內縮 bindingWidthMm/2，印膠腔室再內縮另一半；不可重複加寬。",
    );
  }

  if (
    !Number.isInteger(config.subcellCount) ||
    !Number.isFinite(config.subcellCount) ||
    config.subcellCount < 2
  ) {
    add("error", "子電池數量必須是至少 2 的整數。");
  } else if (config.subcellCount % 2 !== 0) {
    add(
      "error",
      "子電池數量必須是偶數，才能讓正、負外部接點都位於 6066 玻璃。",
    );
  }
  if (
    Number.isFinite(config.subcellCount) &&
    config.subcellCount > PRACTICAL_CELL_LIMIT
  ) {
    add(
      "warning",
      `子電池數量超過實務建議上限 ${PRACTICAL_CELL_LIMIT}，請確認最小圖形與製程解析度。`,
    );
  }

  if (!Number.isFinite(config.ftoEtchWidthMm) || config.ftoEtchWidthMm <= 0) {
    add("error", "FTO 蝕刻寬度必須是有限且大於 0 的數值。");
  }

  if (
    !Number.isFinite(config.electrodeJitter) ||
    config.electrodeJitter < 0 ||
    config.electrodeJitter > MAX_SITE_JITTER_RATIO
  ) {
    add(
      "error",
      `electrodeJitter 必須是有限且介於 0 至 ${MAX_SITE_JITTER_RATIO} 的數值；目前為 ${String(config.electrodeJitter)}。`,
    );
  }

  const expectedCount = normalizedCellCount(config.subcellCount);
  if (geometry.cells.length !== expectedCount) {
    add("error", "幾何中的子電池數量與設計設定不一致。");
  }

  let missingSeriesBoundary = false;
  let invalidSeriesBoundary = false;
  for (let index = 0; index < geometry.cells.length - 1; index += 1) {
    const boundary = geometry.boundaries.find(
      ({ cells, seriesConnection }) =>
        seriesConnection && cells[0] === index && cells[1] === index + 1,
    );
    if (!boundary) {
      missingSeriesBoundary = true;
      continue;
    }

    const connectionPlate = expectedConnectionPlate(index);
    if (
      boundary.connectionPlate !== connectionPlate ||
      !samePlateSet(boundary.etchPlates, [oppositePlate(connectionPlate)])
    ) {
      invalidSeriesBoundary = true;
    }
  }
  if (missingSeriesBoundary) {
    add("error", "至少一組相鄰電氣序列子電池缺少連續的串聯共邊。");
  }
  if (invalidSeriesBoundary) {
    add("error", "串聯共邊的連接玻璃或對側蝕刻玻璃不符合交替規則。");
  }

  if (
    geometry.boundaries.some(
      ({ cells, seriesConnection, connectionPlate, etchPlates }) =>
        cells[1] !== cells[0] + 1 &&
        (seriesConnection ||
          connectionPlate !== null ||
          !samePlateSet(etchPlates, ["glass-6066", "glass-6060"])),
    )
  ) {
    add("error", "非連續鄰接共邊必須在兩片玻璃上都進行 FTO 蝕刻。");
  }

  if (
    geometry.cells.some(({ index, glass6066Material, glass6060Material }) => {
      const even = index % 2 === 0;
      return (
        glass6066Material !== (even ? "tio2" : "pt") ||
        glass6060Material !== (even ? "pt" : "tio2")
      );
    })
  ) {
    add("error", "子電池的 TiO2／Pt 玻璃配置不符合電氣序列交替規則。");
  }

  const [negative, positive] = geometry.terminals;
  const firstCell = geometry.cells[0];
  const lastCell = geometry.cells[geometry.cells.length - 1];
  const canonicalTerminals = terminalGeometry(
    geometry.glass6066,
    geometry.overlap,
    geometry.active,
    geometry.cells,
  );
  const terminalInvariantFailed =
    !negative ||
    !positive ||
    negative.polarity !== "negative" ||
    positive.polarity !== "positive" ||
    negative.plate !== "glass-6066" ||
    positive.plate !== "glass-6066" ||
    negative.cellIndex !== (firstCell ? 0 : -1) ||
    positive.cellIndex !== geometry.cells.length - 1 ||
    (firstCell !== undefined &&
      (firstCell.glass6066Material !== "tio2" ||
        firstCell.glass6060Material !== "pt")) ||
    (config.subcellCount % 2 === 0 &&
      lastCell !== undefined &&
      (lastCell.glass6066Material !== "pt" ||
        lastCell.glass6060Material !== "tio2"));
  if (terminalInvariantFailed) {
    add(
      "error",
      "端點材料或玻璃不符合規則：負端起於 6066/TiO2，偶數序列正端須終於 6066/Pt。",
    );
  }

  const firstOwnedSpan = firstCell
    ? maximalOwnedSideSpan(firstCell.polygon, geometry.active, "left")
    : null;
  const lastOwnedSpan = lastCell
    ? maximalOwnedSideSpan(lastCell.polygon, geometry.active, "right")
    : null;
  if (
    !firstOwnedSpan ||
    !lastOwnedSpan ||
    segmentLength(firstOwnedSpan) <= POINT_EPSILON ||
    segmentLength(lastOwnedSpan) <= POINT_EPSILON
  ) {
    add(
      "error",
      "第一個與最後一個子電池必須分別在有效區左、右邊界擁有正尺寸跨度。",
    );
  }

  if (
    !negative ||
    !positive ||
    !rectsEqual(negative.contactStrip, canonicalTerminals[0].contactStrip) ||
    !rectsEqual(positive.contactStrip, canonicalTerminals[1].contactStrip) ||
    !validRect(canonicalTerminals[0].contactStrip) ||
    !validRect(canonicalTerminals[1].contactStrip)
  ) {
    add(
      "error",
      "6066 玻璃左右外露接觸條必須具有正尺寸並涵蓋玻璃完整高度。",
    );
  }

  if (
    !negative ||
    !positive ||
    !gatesEqual(negative.gate, canonicalTerminals[0].gate) ||
    !gatesEqual(positive.gate, canonicalTerminals[1].gate) ||
    !pointsEqual(negative.contact, canonicalTerminals[0].contact) ||
    !pointsEqual(positive.contact, canonicalTerminals[1].contact)
  ) {
    add(
      "error",
      "每個端子 gate 必須等於端點子電池在 facing side 的完整最大跨度，接點須對齊其中點。",
    );
  }

  const expectedPerimeter = activePerimeter(geometry.active);
  if (
    geometry.activePerimeter.length !== expectedPerimeter.length ||
    !geometry.activePerimeter.every((segment, index) =>
      segmentsEqual(segment, expectedPerimeter[index]),
    )
  ) {
    add("error", "有效區周界必須是 active 矩形的完整四邊。");
  }

  const expectedEtchPaths: LayoutGeometry["etchPaths"] = {
    "glass-6066": canonicalEtchPaths(
      "glass-6066",
      geometry.glass6066,
      geometry.active,
      expectedPerimeter,
      geometry.boundaries,
      canonicalTerminals,
    ),
    "glass-6060": canonicalEtchPaths(
      "glass-6060",
      geometry.glass6060,
      geometry.active,
      expectedPerimeter,
      geometry.boundaries,
      canonicalTerminals,
    ),
  };
  if (
    !canonicalPathSetMatches(
      geometry.etchPaths?.["glass-6066"],
      expectedEtchPaths["glass-6066"],
    ) ||
    !canonicalPathSetMatches(
      geometry.etchPaths?.["glass-6060"],
      expectedEtchPaths["glass-6060"],
    )
  ) {
    add(
      "error",
      "canonical etchPaths 只能包含選定的Voronoi邊界與端點出血延伸；不可附加周界蝕刻框，且必須保留6066端點引出。",
    );
  }

  const pathMatches =
    negative !== undefined &&
    positive !== undefined &&
    geometry.electronPath.length === geometry.cells.length + 2 &&
    pointsEqual(geometry.electronPath[0], negative.contact) &&
    geometry.cells.every(({ site }, index) =>
      pointsEqual(geometry.electronPath[index + 1], site),
    ) &&
    pointsEqual(
      geometry.electronPath[geometry.electronPath.length - 1],
      positive.contact,
    );
  if (!pathMatches) {
    add("error", "電子路徑必須由負端依序通過每個 Voronoi 站點後到達正端。");
  }

  add(
    "info",
    "FTO 蝕刻與封裝尺寸仍須依材料、設備及實際試片進行校正。",
  );
  return warnings;
}

export function polygonArea(points: Point[]): number {
  if (points.length < 3) return 0;

  let twiceArea = 0;
  for (let index = 0; index < points.length; index += 1) {
    const current = points[index];
    const next = points[(index + 1) % points.length];
    twiceArea += current.x * next.y - next.x * current.y;
  }
  return Math.abs(twiceArea) / 2;
}

export function pointInConvexPolygon(point: Point, polygon: Point[]): boolean {
  if (
    !Number.isFinite(point.x) ||
    !Number.isFinite(point.y) ||
    polygon.length < 3
  ) {
    return false;
  }

  const vertexCount = polygonVertexCount(polygon);
  if (vertexCount < 3) return false;

  let direction = 0;
  for (let index = 0; index < vertexCount; index += 1) {
    const start = polygon[index];
    const end = polygon[(index + 1) % vertexCount];
    if (
      !Number.isFinite(start.x) ||
      !Number.isFinite(start.y) ||
      !Number.isFinite(end.x) ||
      !Number.isFinite(end.y)
    ) {
      return false;
    }

    const cross =
      (end.x - start.x) * (point.y - start.y) -
      (end.y - start.y) * (point.x - start.x);
    const tolerance =
      POINT_EPSILON *
      Math.max(
        1,
        Math.abs(end.x - start.x),
        Math.abs(end.y - start.y),
        Math.abs(point.x - start.x),
        Math.abs(point.y - start.y),
      ) **
        2;
    if (Math.abs(cross) <= tolerance) continue;

    const nextDirection = Math.sign(cross);
    if (direction !== 0 && nextDirection !== direction) return false;
    direction = nextDirection;
  }

  return direction !== 0;
}
