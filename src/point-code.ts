import {
  POINT_CODE_MIN_GAP_MM,
  POINT_CODE_RADIUS_MM,
  type DesignConfig,
  type DesignWarning,
  type LayoutGeometry,
  type Point,
  type PointCodeArtwork,
} from "./model";
import {
  normalizeVoronoiLayoutText,
  VORONOI_FONT,
} from "./voronoi-font-data";

interface Bounds {
  minX: number;
  minY: number;
  maxX: number;
  maxY: number;
}

interface SlotDraft {
  slotIndex: number;
  slotIndexInSubcell: number;
  subcellIndex: number;
  character: string;
  safePolygon: Point[];
}

const MIN_SHRINK_FACTOR = 1e-6;
const MAX_CODE_EM_MM = 1.2;
const SHARED_CODE_CLEARANCE_FACTOR = 1 - 1e-9;
const SAFE_INSET_CLEARANCE_FACTOR = 1 + 1e-9;

export function buildPointCodeArtwork(
  config: DesignConfig,
  geometry: LayoutGeometry,
): PointCodeArtwork {
  const normalizedText = normalizeVoronoiLayoutText(config.text);
  const characters = Array.from(normalizedText);
  const electrodes = geometry.cells
    .slice()
    .sort((first, second) => first.index - second.index);
  const baseSlotCount =
    electrodes.length > 0 ? Math.floor(characters.length / electrodes.length) : 0;
  const remainder =
    electrodes.length > 0 ? characters.length % electrodes.length : 0;
  const slotsPerSubcell = electrodes.map(
    (_, index) => baseSlotCount + (index < remainder ? 1 : 0),
  );
  const drafts: SlotDraft[] = [];
  let slotIndex = 0;

  for (let electrodeIndex = 0; electrodeIndex < electrodes.length; electrodeIndex += 1) {
    const electrode = electrodes[electrodeIndex];
    const parent = insetConvexPolygon(
      electrode.polygon,
      finiteNonnegative(config.bindingWidthMm) / 2,
    );
    const slotPolygons = partitionConvexPolygonRowMajor(
      parent,
      slotsPerSubcell[electrodeIndex],
    );

    for (
      let slotIndexInSubcell = 0;
      slotIndexInSubcell < slotPolygons.length;
      slotIndexInSubcell += 1
    ) {
      const character = characters[slotIndex];
      const slotPolygon = slotPolygons[slotIndexInSubcell];
      const safePolygon = insetConvexPolygon(
        slotPolygon,
        POINT_CODE_RADIUS_MM * SAFE_INSET_CLEARANCE_FACTOR,
      );

      drafts.push({
        slotIndex,
        slotIndexInSubcell,
        subcellIndex: electrode.index,
        character,
        safePolygon,
      });
      slotIndex += 1;
    }
  }

  const codeEmMm =
    drafts.length === 0
      ? 0
      : Math.min(
          MAX_CODE_EM_MM,
          Math.min(
            ...drafts.map(({ safePolygon }) =>
              centeredSquareCapacity(safePolygon),
            ),
          ) * SHARED_CODE_CLEARANCE_FACTOR,
        );
  const placements: PointCodeArtwork["placements"] = drafts.map((draft) => {
    if (draft.character === " ") {
      return {
        slotIndex: draft.slotIndex,
        slotIndexInSubcell: draft.slotIndexInSubcell,
        subcellIndex: draft.subcellIndex,
        character: draft.character,
        sites: [],
      };
    }

    const center = polygonCentroid(draft.safePolygon);
    const canonicalSites = deduplicateCoincidentSites(
      VORONOI_FONT[draft.character].sites,
    );
    const sites =
      codeEmMm > 0 && isUsableConvexPolygon(draft.safePolygon)
        ? canonicalSites.map((site) => ({
            x: center.x + (site.x - 0.5) * codeEmMm,
            y: center.y + (site.y - 0.5) * codeEmMm,
          }))
        : [];

    return {
      slotIndex: draft.slotIndex,
      slotIndexInSubcell: draft.slotIndexInSubcell,
      subcellIndex: draft.subcellIndex,
      character: draft.character,
      sites,
    };
  });

  const spaceCount = characters.filter((character) => character === " ").length;
  return {
    normalizedText,
    slotCount: characters.length,
    letterCount: characters.length - spaceCount,
    spaceCount,
    codeEmMm,
    slotsPerSubcell,
    placements,
  };
}

export function validatePointCodeArtwork(
  config: DesignConfig,
  geometry: LayoutGeometry,
  artwork: PointCodeArtwork,
): DesignWarning[] {
  const warnings: DesignWarning[] = [];
  const addError = (message: string): void => {
    warnings.push({ severity: "error", message });
  };
  const bindingInset = finiteNonnegative(config.bindingWidthMm) / 2;
  const screenRegions = new Map<number, Point[]>();
  let hasUnusableScreenRegion = false;

  for (const cell of geometry.cells) {
    const region = insetConvexPolygon(cell.polygon, bindingInset);
    screenRegions.set(cell.index, region);
    if (!isUsableConvexPolygon(region)) hasUnusableScreenRegion = true;
  }

  if (hasUnusableScreenRegion) {
    addError(
      "至少一個 Screen cell 在 Binding 內縮後沒有可用的 TiO2 印刷區。",
    );
  }

  const characters = Array.from(normalizeVoronoiLayoutText(config.text));
  const placements = Array.isArray(artwork.placements)
    ? artwork.placements
    : [];
  const placementsBySlot = new Map(
    placements.map((placement) => [placement.slotIndex, placement]),
  );
  const nonSpaceCharacters = characters
    .map((character, slotIndex) => ({ character, slotIndex }))
    .filter(({ character }) => character !== " ");
  let hasMissingCharacterArtwork =
    nonSpaceCharacters.length > 0 &&
    (!Number.isFinite(artwork.codeEmMm) || artwork.codeEmMm <= 0);

  for (const expected of nonSpaceCharacters) {
    const placement = placementsBySlot.get(expected.slotIndex);
    if (
      placement === undefined ||
      placement.character !== expected.character ||
      !Array.isArray(placement.sites) ||
      placement.sites.length === 0
    ) {
      hasMissingCharacterArtwork = true;
      break;
    }
  }

  if (hasMissingCharacterArtwork) {
    addError(
      "Point Code 過密，至少一個非空白字元沒有可用點位或共同尺度。",
    );
  }

  let hasCircleOutsideScreenRegion = false;
  let hasInsufficientSiteSeparation = false;
  const minimumSiteDistance =
    POINT_CODE_RADIUS_MM * 2 + POINT_CODE_MIN_GAP_MM;

  for (const placement of placements) {
    const sites = Array.isArray(placement.sites) ? placement.sites : [];
    const region = screenRegions.get(placement.subcellIndex);

    if (region === undefined) {
      if (sites.length > 0) hasCircleOutsideScreenRegion = true;
    } else if (isUsableConvexPolygon(region)) {
      for (const site of sites) {
        if (
          !pointHasClearanceInsideConvexPolygon(
            site,
            region,
            POINT_CODE_RADIUS_MM,
          )
        ) {
          hasCircleOutsideScreenRegion = true;
          break;
        }
      }
    }

    for (let first = 0; first < sites.length; first += 1) {
      for (let second = first + 1; second < sites.length; second += 1) {
        if (
          Math.sqrt(squaredDistance(sites[first], sites[second])) <
          minimumSiteDistance - 1e-10
        ) {
          hasInsufficientSiteSeparation = true;
          break;
        }
      }
      if (hasInsufficientSiteSeparation) break;
    }
  }

  if (hasCircleOutsideScreenRegion) {
    addError(
      "至少一個完整 Point Code 圓孔超出所屬 TiO2 Screen region。",
    );
  }
  if (hasInsufficientSiteSeparation) {
    addError(
      "至少一個 Point Code 無法維持圓孔間的最小製造間距。",
    );
  }

  return warnings;
}

function centeredSquareCapacity(polygon: Point[]): number {
  const target = cleanPolygon(polygon);
  if (!isUsableConvexPolygon(target)) return 0;

  const center = polygonCentroid(target);
  const orientation = polygonSignedArea(target) > 0 ? 1 : -1;
  const tolerance = coordinateTolerance(target);
  let halfSize = Number.POSITIVE_INFINITY;

  for (let index = 0; index < target.length; index += 1) {
    const start = target[index];
    const end = target[(index + 1) % target.length];
    const dx = end.x - start.x;
    const dy = end.y - start.y;
    const length = Math.hypot(dx, dy);
    if (length <= tolerance) continue;

    const inward = {
      x: (orientation * -dy) / length,
      y: (orientation * dx) / length,
    };
    const centerDistance = dot(subtract(center, start), inward);
    const squareSupport = Math.abs(inward.x) + Math.abs(inward.y);
    halfSize = Math.min(
      halfSize,
      Math.max(0, centerDistance) / squareSupport,
    );
  }

  return Number.isFinite(halfSize) ? halfSize * 2 : 0;
}

export function partitionConvexPolygonRowMajor(
  polygon: Point[],
  count: number,
): Point[][] {
  const parent = cleanPolygon(polygon);
  const slotCount = Number.isFinite(count) ? Math.max(0, Math.trunc(count)) : 0;
  if (slotCount === 0 || !isUsableConvexPolygon(parent)) return [];

  const bounds = polygonBounds(parent);
  const width = bounds.maxX - bounds.minX;
  const height = bounds.maxY - bounds.minY;
  const aspectRatio = width / height;
  const columns = Math.min(
    slotCount,
    Math.max(1, Math.ceil(Math.sqrt(slotCount * aspectRatio))),
  );
  const rows = Math.ceil(slotCount / columns);
  const sites: Point[] = [];

  for (let index = 0; index < slotCount; index += 1) {
    const row = Math.floor(index / columns);
    const column = index % columns;
    sites.push(
      mapUnitPointToConvexPolygon(
        {
          x: (column + 0.5) / columns,
          y: (row + 0.5) / rows,
        },
        parent,
      ),
    );
  }

  return partitionPolygonBySites(separateCoincidentSites(sites, parent), parent);
}

export function insetConvexPolygon(
  polygon: Point[],
  marginMm: number,
): Point[] {
  const source = cleanPolygon(polygon);
  const margin = finiteNonnegative(marginMm);
  if (margin === 0) return source.map(copyPoint);
  if (source.length < 3) return shrinkTowardCentroid(source, margin);

  const signedArea = polygonSignedArea(source);
  const scale = polygonScale(source);
  const tolerance = coordinateTolerance(source);
  if (
    Math.abs(signedArea) <= tolerance * scale ||
    !isConvex(source, signedArea, tolerance)
  ) {
    return shrinkTowardCentroid(source, margin);
  }

  const orientation = signedArea > 0 ? 1 : -1;
  let inset = source.map(copyPoint);

  for (let index = 0; index < source.length; index += 1) {
    const start = source[index];
    const end = source[(index + 1) % source.length];
    const dx = end.x - start.x;
    const dy = end.y - start.y;
    const length = Math.hypot(dx, dy);
    if (length <= tolerance) return [];

    const inward = {
      x: (orientation * -dy) / length,
      y: (orientation * dx) / length,
    };
    const threshold = dot(start, inward) + margin;
    inset = clipConvexPolygon(
      inset,
      (point) => dot(point, inward) - threshold,
      0,
    );
    if (inset.length < 3) return [];
  }

  if (!isUsableConvexPolygon(inset)) return [];

  return inset;
}

export function mapUnitPointToConvexPolygon(
  point: Point,
  polygon: Point[],
): Point {
  const target = cleanPolygon(polygon);
  const centroid = polygonCentroid(target);
  if (!isUsableConvexPolygon(target)) return centroid;

  const unitX = Number.isFinite(point.x) ? clamp(point.x, 0, 1) : 0.5;
  const unitY = Number.isFinite(point.y) ? clamp(point.y, 0, 1) : 0.5;
  const offsetX = unitX - 0.5;
  const offsetY = unitY - 0.5;
  const largestOffset = Math.max(Math.abs(offsetX), Math.abs(offsetY));
  if (largestOffset <= Number.EPSILON) return centroid;

  const bounds = polygonBounds(target);
  const direction = {
    x: (offsetX / largestOffset) * (bounds.maxX - bounds.minX),
    y: (offsetY / largestOffset) * (bounds.maxY - bounds.minY),
  };
  const signedArea = polygonSignedArea(target);
  const orientation = signedArea > 0 ? 1 : -1;
  const tolerance = coordinateTolerance(target);
  let boundaryParameter = Number.POSITIVE_INFINITY;

  for (let index = 0; index < target.length; index += 1) {
    const start = target[index];
    const end = target[(index + 1) % target.length];
    const dx = end.x - start.x;
    const dy = end.y - start.y;
    const length = Math.hypot(dx, dy);
    if (length <= tolerance) continue;

    const inward = {
      x: (orientation * -dy) / length,
      y: (orientation * dx) / length,
    };
    const distanceToEdge = dot(subtract(centroid, start), inward);
    const outwardRate = -dot(direction, inward);
    if (outwardRate > tolerance) {
      boundaryParameter = Math.min(
        boundaryParameter,
        Math.max(0, distanceToEdge) / outwardRate,
      );
    }
  }

  if (!Number.isFinite(boundaryParameter)) return centroid;

  const radialFraction = Math.min(1, largestOffset * 2);
  const mapped = {
    x: centroid.x + direction.x * boundaryParameter * radialFraction,
    y: centroid.y + direction.y * boundaryParameter * radialFraction,
  };
  return isFinitePoint(mapped) ? mapped : centroid;
}

function partitionPolygonBySites(sites: Point[], parent: Point[]): Point[][] {
  const scale = polygonScale(parent);
  const tolerance = Math.max(
    scale * scale * 1e-12,
    coordinateMagnitude(parent) * scale * Number.EPSILON * 64,
  );

  return sites.map((site, siteIndex) => {
    let cell = parent.map(copyPoint);

    for (let otherIndex = 0; otherIndex < sites.length; otherIndex += 1) {
      if (otherIndex === siteIndex) continue;

      const other = sites[otherIndex];
      const direction = subtract(other, site);
      const midpoint = {
        x: (site.x + other.x) / 2,
        y: (site.y + other.y) / 2,
      };
      cell = clipConvexPolygon(
        cell,
        (point) => -dot(subtract(point, midpoint), direction),
        tolerance,
      );
      if (cell.length === 0) break;
    }

    return cleanPolygon(cell);
  });
}

function separateCoincidentSites(sites: Point[], parent: Point[]): Point[] {
  const centroid = polygonCentroid(parent);
  const scale = polygonScale(parent);
  const closeDistance = Math.max(
    scale * 1e-9,
    coordinateTolerance(parent) * 4,
  );
  const nudgeDistance = Math.max(
    scale * 1e-7,
    coordinateTolerance(parent) * 32,
  );
  const separated: Point[] = [];

  for (let index = 0; index < sites.length; index += 1) {
    const original = sites[index];
    let candidate = copyPoint(original);
    let attempt = 0;

    while (
      separated.some(
        (other) => squaredDistance(candidate, other) <= closeDistance ** 2,
      ) &&
      attempt < sites.length * 2
    ) {
      let inward = subtract(centroid, candidate);
      let length = Math.hypot(inward.x, inward.y);
      if (length <= closeDistance) {
        const angle =
          (index + 1) * 2.399963229728653 + attempt * 0.7853981633974483;
        inward = { x: Math.cos(angle), y: Math.sin(angle) };
        length = 1;
      }

      const amount = nudgeDistance * (attempt + 1);
      candidate = {
        x: candidate.x + (inward.x / length) * amount,
        y: candidate.y + (inward.y / length) * amount,
      };
      attempt += 1;
    }

    separated.push(candidate);
  }

  return separated;
}

function deduplicateCoincidentSites(sites: Point[]): Point[] {
  const closeDistance = Math.max(
    polygonScale(sites) * 1e-9,
    coordinateTolerance(sites) * 4,
  );
  const unique: Point[] = [];

  for (const site of sites) {
    if (
      !unique.some(
        (other) => squaredDistance(site, other) <= closeDistance ** 2,
      )
    ) {
      unique.push(copyPoint(site));
    }
  }

  return unique;
}

function pointHasClearanceInsideConvexPolygon(
  point: Point,
  polygon: Point[],
  clearanceMm: number,
): boolean {
  if (!isFinitePoint(point) || !isUsableConvexPolygon(polygon)) return false;

  const orientation = polygonSignedArea(polygon) > 0 ? 1 : -1;
  const tolerance = coordinateTolerance(polygon) * 8;
  for (let index = 0; index < polygon.length; index += 1) {
    const start = polygon[index];
    const end = polygon[(index + 1) % polygon.length];
    const dx = end.x - start.x;
    const dy = end.y - start.y;
    const length = Math.hypot(dx, dy);
    if (length <= tolerance) return false;

    const inward = {
      x: (orientation * -dy) / length,
      y: (orientation * dx) / length,
    };
    if (
      dot(subtract(point, start), inward) < clearanceMm - tolerance
    ) {
      return false;
    }
  }

  return true;
}

function shrinkTowardCentroid(polygon: Point[], margin: number): Point[] {
  if (polygon.length === 0) return [];

  const centroid = polygonCentroid(polygon);
  const signedArea = polygonSignedArea(polygon);
  const tolerance = coordinateTolerance(polygon);
  let referenceDistance = Number.POSITIVE_INFINITY;

  if (
    polygon.length >= 3 &&
    Math.abs(signedArea) > tolerance * polygonScale(polygon)
  ) {
    const orientation = signedArea > 0 ? 1 : -1;
    for (let index = 0; index < polygon.length; index += 1) {
      const start = polygon[index];
      const end = polygon[(index + 1) % polygon.length];
      const dx = end.x - start.x;
      const dy = end.y - start.y;
      const length = Math.hypot(dx, dy);
      if (length <= tolerance) continue;

      const inward = {
        x: (orientation * -dy) / length,
        y: (orientation * dx) / length,
      };
      const distance = dot(subtract(centroid, start), inward);
      if (distance > tolerance) {
        referenceDistance = Math.min(referenceDistance, distance);
      }
    }
  }

  if (!Number.isFinite(referenceDistance)) {
    referenceDistance = polygon.reduce(
      (maximum, point) =>
        Math.max(maximum, Math.sqrt(squaredDistance(point, centroid))),
      0,
    );
  }

  const factor =
    referenceDistance > tolerance
      ? clamp(1 - margin / referenceDistance, MIN_SHRINK_FACTOR, 1)
      : MIN_SHRINK_FACTOR;
  return polygon.map((point) => ({
    x: centroid.x + (point.x - centroid.x) * factor,
    y: centroid.y + (point.y - centroid.y) * factor,
  }));
}

function clipConvexPolygon(
  polygon: Point[],
  signedDistance: (point: Point) => number,
  tolerance: number,
): Point[] {
  if (polygon.length === 0) return [];

  const output: Point[] = [];
  let previous = polygon[polygon.length - 1];
  let previousDistance = signedDistance(previous);
  let previousInside = previousDistance >= -tolerance;

  for (const current of polygon) {
    const currentDistance = signedDistance(current);
    const currentInside = currentDistance >= -tolerance;

    if (currentInside !== previousInside) {
      const denominator = previousDistance - currentDistance;
      if (Math.abs(denominator) > Number.EPSILON) {
        const amount = clamp(previousDistance / denominator, 0, 1);
        output.push(interpolate(previous, current, amount));
      }
    }
    if (currentInside) output.push(copyPoint(current));

    previous = current;
    previousDistance = currentDistance;
    previousInside = currentInside;
  }

  return cleanPolygon(output);
}

function isUsableConvexPolygon(polygon: Point[]): boolean {
  if (polygon.length < 3 || !polygon.every(isFinitePoint)) return false;
  const area = polygonSignedArea(polygon);
  const tolerance = coordinateTolerance(polygon);
  return (
    Math.abs(area) > tolerance * polygonScale(polygon) &&
    isConvex(polygon, area, tolerance)
  );
}

function isConvex(
  polygon: Point[],
  signedArea: number,
  tolerance: number,
): boolean {
  if (polygon.length < 3 || signedArea === 0) return false;
  const orientation = signedArea > 0 ? 1 : -1;
  const crossTolerance = tolerance * polygonScale(polygon);

  for (let index = 0; index < polygon.length; index += 1) {
    const previous = polygon[(index + polygon.length - 1) % polygon.length];
    const current = polygon[index];
    const next = polygon[(index + 1) % polygon.length];
    if (
      orientation * cross(subtract(current, previous), subtract(next, current)) <
      -crossTolerance
    ) {
      return false;
    }
  }

  return true;
}

function cleanPolygon(polygon: Point[]): Point[] {
  const finite = polygon.filter(isFinitePoint).map(copyPoint);
  if (finite.length < 2) return finite;

  const tolerance = coordinateTolerance(finite);
  const toleranceSquared = tolerance * tolerance;
  const cleaned: Point[] = [];
  for (const point of finite) {
    if (
      cleaned.length === 0 ||
      squaredDistance(cleaned[cleaned.length - 1], point) > toleranceSquared
    ) {
      cleaned.push(point);
    }
  }
  if (
    cleaned.length > 1 &&
    squaredDistance(cleaned[0], cleaned[cleaned.length - 1]) <= toleranceSquared
  ) {
    cleaned.pop();
  }
  return cleaned;
}

function polygonCentroid(polygon: Point[]): Point {
  if (polygon.length === 0) return { x: 0, y: 0 };

  let crossSum = 0;
  let weightedX = 0;
  let weightedY = 0;
  for (let index = 0; index < polygon.length; index += 1) {
    const current = polygon[index];
    const next = polygon[(index + 1) % polygon.length];
    const edgeCross = cross(current, next);
    crossSum += edgeCross;
    weightedX += (current.x + next.x) * edgeCross;
    weightedY += (current.y + next.y) * edgeCross;
  }

  const tolerance = coordinateTolerance(polygon) * polygonScale(polygon);
  if (Math.abs(crossSum) > tolerance * 2) {
    return {
      x: weightedX / (3 * crossSum),
      y: weightedY / (3 * crossSum),
    };
  }

  const sum = polygon.reduce(
    (total, point) => ({ x: total.x + point.x, y: total.y + point.y }),
    { x: 0, y: 0 },
  );
  return { x: sum.x / polygon.length, y: sum.y / polygon.length };
}

function polygonSignedArea(polygon: Point[]): number {
  let twiceArea = 0;
  for (let index = 0; index < polygon.length; index += 1) {
    twiceArea += cross(polygon[index], polygon[(index + 1) % polygon.length]);
  }
  return twiceArea / 2;
}

function polygonBounds(polygon: Point[]): Bounds {
  if (polygon.length === 0) {
    return { minX: 0, minY: 0, maxX: 0, maxY: 0 };
  }

  let minX = polygon[0].x;
  let minY = polygon[0].y;
  let maxX = polygon[0].x;
  let maxY = polygon[0].y;
  for (let index = 1; index < polygon.length; index += 1) {
    minX = Math.min(minX, polygon[index].x);
    minY = Math.min(minY, polygon[index].y);
    maxX = Math.max(maxX, polygon[index].x);
    maxY = Math.max(maxY, polygon[index].y);
  }
  return { minX, minY, maxX, maxY };
}

function polygonScale(polygon: Point[]): number {
  const bounds = polygonBounds(polygon);
  return Math.max(bounds.maxX - bounds.minX, bounds.maxY - bounds.minY, 1e-12);
}

function coordinateMagnitude(polygon: Point[]): number {
  return polygon.reduce(
    (maximum, point) =>
      Math.max(maximum, Math.abs(point.x), Math.abs(point.y)),
    1,
  );
}

function coordinateTolerance(polygon: Point[]): number {
  return Math.max(
    polygonScale(polygon) * 1e-10,
    coordinateMagnitude(polygon) * Number.EPSILON * 64,
  );
}

function interpolate(start: Point, end: Point, amount: number): Point {
  return {
    x: start.x + (end.x - start.x) * amount,
    y: start.y + (end.y - start.y) * amount,
  };
}

function subtract(first: Point, second: Point): Point {
  return { x: first.x - second.x, y: first.y - second.y };
}

function dot(first: Point, second: Point): number {
  return first.x * second.x + first.y * second.y;
}

function cross(first: Point, second: Point): number {
  return first.x * second.y - first.y * second.x;
}

function squaredDistance(first: Point, second: Point): number {
  const dx = first.x - second.x;
  const dy = first.y - second.y;
  return dx * dx + dy * dy;
}

function copyPoint(point: Point): Point {
  return { x: point.x, y: point.y };
}

function isFinitePoint(point: Point): boolean {
  return Number.isFinite(point.x) && Number.isFinite(point.y);
}

function finiteNonnegative(value: number): number {
  return Number.isFinite(value) ? Math.max(0, value) : 0;
}

function clamp(value: number, minimum: number, maximum: number): number {
  return Math.min(maximum, Math.max(minimum, value));
}
