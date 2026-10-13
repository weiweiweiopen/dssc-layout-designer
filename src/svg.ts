import {
  POINT_CODE_RADIUS_MM,
  type DesignConfig,
  type EtchPath,
  type LayoutGeometry,
  type Material,
  type PlateId,
  type Point,
  type PointCodeArtwork,
  type PreviewMode,
  type Rect,
} from "./model";
import { insetConvexPolygon } from "./point-code";

export interface SvgAsset {
  id: string;
  filename: string;
  title: string;
  widthMm: number;
  heightMm: number;
  svg: string;
}

export interface PreviewSize {
  widthMm: number;
  heightMm: number;
}

type CoordinateMap = (point: Point) => Point;

interface DocumentOptions {
  title: string;
  view: PreviewMode | "asset";
  plate: PlateId | "assembly" | "circuit" | "none";
  widthMm: number;
  heightMm: number;
  mirrored: boolean;
  outputKind: "preview" | "reference" | "production";
  body: string;
  metadata?: Record<string, string | number | boolean>;
}

const BLACK = "#000000";
const WHITE = "#ffffff";
const ASSEMBLY_TIO2 = "#d5d5d5";
const ASSEMBLY_PT = "#707070";
const GUIDE_STROKE = "#888888";
const DRAFTING_LINE_WIDTH_MM = 0.06;

export const CIRCUIT_PANEL_GAP_MM = 8;
export { POINT_CODE_RADIUS_MM };

function finiteNonnegative(value: number): number {
  return Number.isFinite(value) ? Math.max(0, value) : 0;
}

function number(value: number): string {
  if (!Number.isFinite(value) || Math.abs(value) < 0.0000000005) return "0";
  return value.toFixed(9).replace(/(\.\d*?[1-9])0+$|\.0+$/, "$1");
}

function escapeXml(value: string): string {
  const entities: Record<string, string> = {
    "&": "&amp;",
    "<": "&lt;",
    ">": "&gt;",
    '"': "&quot;",
    "'": "&apos;",
  };
  return value.replace(/[&<>"']/g, (character) => entities[character]);
}

function samePoint(first: Point, second: Point): boolean {
  return first.x === second.x && first.y === second.y;
}

function openRing(points: Point[]): Point[] {
  if (points.length > 1 && samePoint(points[0], points[points.length - 1])) {
    return points.slice(0, -1);
  }
  return points;
}

function ringPath(points: Point[], map: CoordinateMap): string {
  const ring = openRing(points);
  if (ring.length < 3) return "";
  return ring
    .map((point, index) => {
      const mapped = map(point);
      return `${index === 0 ? "M" : "L"} ${number(mapped.x)} ${number(mapped.y)}`;
    })
    .concat("Z")
    .join(" ");
}

function linePath(points: Point[], map: CoordinateMap): string {
  if (points.length < 2) return "";
  return points
    .map((point, index) => {
      const mapped = map(point);
      return `${index === 0 ? "M" : "L"} ${number(mapped.x)} ${number(mapped.y)}`;
    })
    .join(" ");
}

function rectPoints(rect: Rect): Point[] {
  return [
    { x: rect.x, y: rect.y },
    { x: rect.x + rect.width, y: rect.y },
    { x: rect.x + rect.width, y: rect.y + rect.height },
    { x: rect.x, y: rect.y + rect.height },
  ];
}

function rectPath(rect: Rect, map: CoordinateMap): string {
  return ringPath(rectPoints(rect), map);
}

function mappedRect(rect: Rect, map: CoordinateMap): Rect {
  const first = map({ x: rect.x, y: rect.y });
  const second = map({
    x: rect.x + rect.width,
    y: rect.y + rect.height,
  });
  return {
    x: Math.min(first.x, second.x),
    y: Math.min(first.y, second.y),
    width: Math.abs(second.x - first.x),
    height: Math.abs(second.y - first.y),
  };
}

function plateRect(geometry: LayoutGeometry, plate: PlateId): Rect {
  return plate === "glass-6066" ? geometry.glass6066 : geometry.glass6060;
}

function assemblyMap(geometry: LayoutGeometry): CoordinateMap {
  return (point) => ({
    x: point.x - geometry.glass6066.x,
    y: point.y - geometry.glass6066.y,
  });
}

function plateMap(
  config: DesignConfig,
  geometry: LayoutGeometry,
  plate: PlateId,
): CoordinateMap {
  const rect = plateRect(geometry, plate);
  const mirrored = plate === "glass-6060" && config.mirrorGlass6060;
  return (point) => {
    const localX = point.x - rect.x;
    return {
      x: mirrored ? rect.width - localX : localX,
      y: point.y - rect.y,
    };
  };
}

function circuitPanelOrigin(
  geometry: LayoutGeometry,
  plate: PlateId,
): Point {
  const size = previewSize(geometry, "circuit");
  const rect = plateRect(geometry, plate);
  return {
    x:
      plate === "glass-6066"
        ? 0
        : geometry.glass6066.width + CIRCUIT_PANEL_GAP_MM,
    y: (size.heightMm - rect.height) / 2,
  };
}

function circuitMap(
  config: DesignConfig,
  geometry: LayoutGeometry,
  plate: PlateId,
): CoordinateMap {
  const localMap = plateMap(config, geometry, plate);
  const origin = circuitPanelOrigin(geometry, plate);
  return (point) => {
    const local = localMap(point);
    return { x: local.x + origin.x, y: local.y + origin.y };
  };
}

export function previewSize(
  geometry: LayoutGeometry,
  mode: PreviewMode,
): PreviewSize {
  switch (mode) {
    case "circuit":
      return {
        widthMm:
          geometry.glass6066.width +
          CIRCUIT_PANEL_GAP_MM +
          geometry.glass6060.width,
        heightMm: Math.max(
          geometry.glass6066.height,
          geometry.glass6060.height,
        ),
      };
    case "glass-6060":
    case "etch-6060":
      return {
        widthMm: geometry.glass6060.width,
        heightMm: geometry.glass6060.height,
      };
    case "assembly":
    case "glass-6066":
    case "etch-6066":
    case "binding":
      return {
        widthMm: geometry.glass6066.width,
        heightMm: geometry.glass6066.height,
      };
    default:
      throw new Error(`Unsupported preview mode: ${String(mode)}`);
  }
}

function documentSvg(options: DocumentOptions): string {
  const metadata = JSON.stringify({
    title: options.title,
    view: options.view,
    plate: options.plate,
    units: "mm",
    mirroredHorizontally: options.mirrored,
    outputKind: options.outputKind,
    ...options.metadata,
  });
  return [
    `<svg xmlns="http://www.w3.org/2000/svg" version="1.1" width="${number(options.widthMm)}mm" height="${number(options.heightMm)}mm" viewBox="0 0 ${number(options.widthMm)} ${number(options.heightMm)}" data-view="${escapeXml(options.view)}" data-plate="${escapeXml(options.plate)}" data-mirrored="${options.mirrored ? "true" : "false"}" data-output-kind="${options.outputKind}" role="img" aria-labelledby="SVG_TITLE">`,
    `<title id="SVG_TITLE">${escapeXml(options.title)}</title>`,
    `<metadata>${escapeXml(metadata)}</metadata>`,
    options.body,
    "</svg>",
  ].join("\n");
}

function selectedScreenCells(
  geometry: LayoutGeometry,
  plate: PlateId,
): LayoutGeometry["cells"] {
  return geometry.cells.filter((cell) => materialForPlate(cell, plate) === "tio2");
}

function selectedScreenRegions(
  config: DesignConfig,
  geometry: LayoutGeometry,
  plate: PlateId,
): Array<{ cell: LayoutGeometry["cells"][number]; polygon: Point[] }> {
  const insetMm = finiteNonnegative(config.bindingWidthMm) / 2;
  return selectedScreenCells(geometry, plate).flatMap((cell) => {
    const polygon = insetConvexPolygon(cell.polygon, insetMm);
    return polygon.length >= 3 ? [{ cell, polygon }] : [];
  });
}

function renderScreenRegions(
  config: DesignConfig,
  geometry: LayoutGeometry,
  plate: PlateId,
  map: CoordinateMap,
): string {
  const suffix = plate === "glass-6066" ? "6066" : "6060";
  return selectedScreenRegions(config, geometry, plate)
    .flatMap(({ cell, polygon }) => {
      const path = ringPath(polygon, map);
      if (!path) return [];
      return [
        `<path data-region-id="screen-${suffix}-cell-${cell.index}" data-subcell-index="${cell.index}" data-material="tio2" d="${path}"/>`,
      ];
    })
    .join("\n");
}

function renderPointCodeKnockouts(
  config: DesignConfig,
  geometry: LayoutGeometry,
  pointCodeArtwork: PointCodeArtwork,
  plate: PlateId,
  map: CoordinateMap,
): string {
  const selectedIndexes = new Set(
    selectedScreenRegions(config, geometry, plate).map(({ cell }) => cell.index),
  );
  return pointCodeArtwork.placements
    .flatMap((placement) => {
      if (
        placement.character === " " ||
        !selectedIndexes.has(placement.subcellIndex)
      ) {
        return [];
      }
      return placement.sites.map((site, siteIndex) => {
        const mapped = map(site);
        const id = `cell-${placement.subcellIndex}-slot-${placement.slotIndex}-site-${siteIndex}`;
        return `<circle id="${id}" data-region-id="${id}" data-subcell-index="${placement.subcellIndex}" data-slot-index="${placement.slotIndex}" data-slot-index-in-subcell="${placement.slotIndexInSubcell}" data-site-index="${siteIndex}" cx="${number(mapped.x)}" cy="${number(mapped.y)}" r="${number(POINT_CODE_RADIUS_MM)}"/>`;
      });
    })
    .join("\n");
}

function buildScreenSvg(
  config: DesignConfig,
  geometry: LayoutGeometry,
  pointCodeArtwork: PointCodeArtwork,
  plate: PlateId,
): string {
  const rect = plateRect(geometry, plate);
  const map = plateMap(config, geometry, plate);
  const is6066 = plate === "glass-6066";
  const mirrored = !is6066 && config.mirrorGlass6060;
  const suffix = is6066 ? "6066" : "6060";
  const body = [
    `<rect id="SCREEN_PAGE_WHITE" x="0" y="0" width="${number(rect.width)}" height="${number(rect.height)}" fill="${WHITE}" shape-rendering="crispEdges"/>`,
    `<g id="SCREEN_${suffix}_TIO2_REGIONS" data-operation="screen-print" data-material="tio2" fill="${BLACK}" shape-rendering="crispEdges">`,
    renderScreenRegions(config, geometry, plate, map),
    "</g>",
    `<g id="SCREEN_POINT_CODE_KNOCKOUTS" data-operation="no-print-knockout" fill="${WHITE}">`,
    renderPointCodeKnockouts(config, geometry, pointCodeArtwork, plate, map),
    "</g>",
  ].join("\n");
  return documentSvg({
    title: `Glass ${suffix} TiO2 screen${mirrored ? " (fabrication mirror)" : ""}`,
    view: plate,
    plate,
    widthMm: rect.width,
    heightMm: rect.height,
    mirrored,
    outputKind: "production",
    body,
    metadata: {
      coordinateSystem: "conductive-side plate-local",
      binaryArtwork: true,
      operation: "tio2-regions-with-point-code-knockouts",
      pointCodeRadiusMm: POINT_CODE_RADIUS_MM,
    },
  });
}

function buildAssemblyPreview(geometry: LayoutGeometry): string {
  const map = assemblyMap(geometry);
  const cells = geometry.cells
    .map((cell) => {
      const material = cell.glass6066Material;
      const fill = material === "tio2" ? ASSEMBLY_TIO2 : ASSEMBLY_PT;
      return `<path data-region-id="assembly-cell-${cell.index}" data-subcell-index="${cell.index}" data-material="${material}" d="${ringPath(cell.polygon, map)}" fill="${fill}"/>`;
    })
    .join("\n");
  const body = [
    `<rect id="ASSEMBLY_GLASS" x="0" y="0" width="${number(geometry.glass6066.width)}" height="${number(geometry.glass6066.height)}" fill="${WHITE}"/>`,
    `<g id="ASSEMBLY_CIRCUIT_MATERIAL_CELLS">${cells}</g>`,
  ].join("\n");
  return documentSvg({
    title: "Final assembled appearance",
    view: "assembly",
    plate: "assembly",
    widthMm: geometry.glass6066.width,
    heightMm: geometry.glass6066.height,
    mirrored: false,
    outputKind: "preview",
    body,
    metadata: {
      interpretation: "final appearance only",
      materialBasis: "glass-6066",
    },
  });
}

function materialForPlate(
  cell: LayoutGeometry["cells"][number],
  plate: PlateId,
): Material {
  return plate === "glass-6066"
    ? cell.glass6066Material
    : cell.glass6060Material;
}

function circuitPatternId(plate: PlateId): string {
  return plate === "glass-6066"
    ? "CIRCUIT_6066_PT_HATCH"
    : "CIRCUIT_6060_PT_HATCH";
}

function circuitPatternDefinitions(): string {
  return [
    "<defs>",
    ...(["glass-6066", "glass-6060"] as PlateId[]).map(
      (plate) =>
        `<pattern id="${circuitPatternId(plate)}" patternUnits="userSpaceOnUse" width="1.6" height="1.6"><rect x="0" y="0" width="1.6" height="1.6" fill="${WHITE}"/><path d="M -0.4 0.4 L 0.4 -0.4 M 0 1.6 L 1.6 0 M 1.2 2 L 2 1.2" fill="none" stroke="#707070" stroke-width="${number(DRAFTING_LINE_WIDTH_MM)}"/></pattern>`,
    ),
    "</defs>",
  ].join("\n");
}

function renderCircuitContacts(
  geometry: LayoutGeometry,
  map: CoordinateMap,
): string {
  return geometry.terminals
    .map((terminal) => {
      const strip = mappedRect(terminal.contactStrip, map);
      const symbol = terminal.polarity === "negative" ? "-" : "+";
      return [
        `<rect data-region-id="circuit-6066-${terminal.polarity}-contact-strip" data-polarity="${terminal.polarity}" x="${number(strip.x)}" y="${number(strip.y)}" width="${number(strip.width)}" height="${number(strip.height)}" fill="#bcbcbc" stroke="${BLACK}" stroke-width="${number(DRAFTING_LINE_WIDTH_MM)}"/>`,
        `<text data-polarity="${terminal.polarity}" x="${number(strip.x + strip.width / 2)}" y="${number(strip.y + strip.height / 2)}" fill="${BLACK}" stroke="none" font-size="2.8" text-anchor="middle" dominant-baseline="middle">${symbol}</text>`,
      ].join("\n");
    })
    .join("\n");
}

function renderCircuitPanel(
  config: DesignConfig,
  geometry: LayoutGeometry,
  plate: PlateId,
): string {
  const rect = plateRect(geometry, plate);
  const origin = circuitPanelOrigin(geometry, plate);
  const map = circuitMap(config, geometry, plate);
  const suffix = plate === "glass-6066" ? "6066" : "6060";
  const cells = geometry.cells
    .map((cell) => {
      const material = materialForPlate(cell, plate);
      const fill =
        material === "tio2" ? "#d5d5d5" : `url(#${circuitPatternId(plate)})`;
      return `<path data-region-id="circuit-${suffix}-cell-${cell.index}" data-subcell-index="${cell.index}" data-material="${material}" data-electron-order="${cell.index + 1}" d="${ringPath(cell.polygon, map)}" fill="${fill}" stroke="${BLACK}" stroke-width="${number(DRAFTING_LINE_WIDTH_MM)}" stroke-linejoin="round"/>`;
    })
    .join("\n");
  const routePoints =
    plate === "glass-6066"
      ? geometry.electronPath
      : geometry.cells.map(({ site }) => site);
  const labels = geometry.cells
    .map((cell) => {
      const site = map(cell.site);
      return `<text data-region-id="circuit-${suffix}-order-${cell.index + 1}" data-subcell-index="${cell.index}" data-electron-order="${cell.index + 1}" x="${number(site.x)}" y="${number(site.y)}" fill="${BLACK}" stroke="none" font-size="1.6" text-anchor="middle" dominant-baseline="middle">${cell.index + 1}</text>`;
    })
    .join("\n");
  return [
    `<g id="CIRCUIT_PLATE_${suffix}" data-plate="${plate}" data-mirrored="${plate === "glass-6060" && config.mirrorGlass6060 ? "true" : "false"}">`,
    `<rect id="CIRCUIT_${suffix}_PLATE_OUTLINE" x="${number(origin.x)}" y="${number(origin.y)}" width="${number(rect.width)}" height="${number(rect.height)}" fill="${WHITE}" stroke="${BLACK}" stroke-width="${number(DRAFTING_LINE_WIDTH_MM)}"/>`,
    plate === "glass-6066"
      ? `<g id="CIRCUIT_6066_CONTACT_STRIPS">${renderCircuitContacts(geometry, map)}</g>`
      : "",
    `<g id="CIRCUIT_${suffix}_MATERIAL_CELLS">${cells}</g>`,
    `<g id="ELECTRON_ROUTE_${suffix}" data-ordered="true" fill="none" stroke="${BLACK}" stroke-width="0.1" stroke-linecap="round" stroke-linejoin="round"><path data-route-point-count="${routePoints.length}" d="${linePath(routePoints, map)}"/></g>`,
    `<g id="CIRCUIT_${suffix}_ORDER_LABELS">${labels}</g>`,
    `<text x="${number(origin.x + rect.width / 2)}" y="${number(origin.y + 1.6)}" fill="${BLACK}" stroke="none" font-size="1.4" text-anchor="middle">GLASS ${suffix}</text>`,
    "</g>",
  ]
    .filter(Boolean)
    .join("\n");
}

function buildCircuitReference(
  config: DesignConfig,
  geometry: LayoutGeometry,
): string {
  const size = previewSize(geometry, "circuit");
  const body = [
    `<rect id="CIRCUIT_PAGE" x="0" y="0" width="${number(size.widthMm)}" height="${number(size.heightMm)}" fill="${WHITE}"/>`,
    circuitPatternDefinitions(),
    renderCircuitPanel(config, geometry, "glass-6066"),
    renderCircuitPanel(config, geometry, "glass-6060"),
  ].join("\n");
  return documentSvg({
    title: "Dual-plate circuit reference",
    view: "circuit",
    plate: "circuit",
    widthMm: size.widthMm,
    heightMm: size.heightMm,
    mirrored: false,
    outputKind: "reference",
    body,
    metadata: {
      panelGapMm: CIRCUIT_PANEL_GAP_MM,
      glass6060Mirrored: config.mirrorGlass6060,
      routeStrokeMm: 0.1,
    },
  });
}

function etchSourceAttributes(path: EtchPath): string {
  switch (path.source) {
    case "electrode-voronoi":
      return `data-boundary-index="${path.boundaryIndex ?? -1}" data-cells="${path.cells?.join(",") ?? ""}"`;
    case "active-perimeter":
      return `data-perimeter-index="${path.perimeterIndex ?? -1}" data-piece-index="${path.pieceIndex ?? -1}"`;
    case "terminal-isolation":
      return `data-isolation-index="${path.isolationIndex ?? -1}"`;
  }
}

function renderEtchOperative(
  geometry: LayoutGeometry,
  plate: PlateId,
  map: CoordinateMap,
): string {
  const suffix = plate === "glass-6066" ? "6066" : "6060";
  return geometry.etchPaths[plate]
    .map(
      (path, pathIndex) =>
        `<path data-region-id="etch-${suffix}-${path.source}-${pathIndex}" data-path-index="${pathIndex}" data-source="${path.source}" data-plate="${path.plate}" ${etchSourceAttributes(path)} d="${linePath([path.start, path.end], map)}"/>`,
    )
    .join("\n");
}

function terminalCorridorPath(
  terminal: LayoutGeometry["terminals"][number],
  map: CoordinateMap,
): string {
  const stripEdgeX =
    terminal.gate.side === "left"
      ? terminal.contactStrip.x + terminal.contactStrip.width
      : terminal.contactStrip.x;
  return ringPath(
    [
      { x: stripEdgeX, y: terminal.gate.start.y },
      terminal.gate.start,
      terminal.gate.end,
      { x: stripEdgeX, y: terminal.gate.end.y },
    ],
    map,
  );
}

function renderEndpointCellGuides(
  geometry: LayoutGeometry,
  plate: PlateId,
  map: CoordinateMap,
): string {
  const suffix = plate === "glass-6066" ? "6066" : "6060";
  const endpointIndexes = Array.from(
    new Set([0, geometry.cells.length - 1].filter((index) => index >= 0)),
  );
  return endpointIndexes
    .flatMap((cellIndex) => {
      const cell = geometry.cells[cellIndex];
      if (!cell) return [];
      return [
        `<path data-region-id="etch-${suffix}-endpoint-cell-${cell.index}" data-subcell-index="${cell.index}" d="${ringPath(cell.polygon, map)}"/>`,
      ];
    })
    .join("\n");
}

function renderTerminalConnectivityGuides(
  geometry: LayoutGeometry,
  map: CoordinateMap,
): string {
  return geometry.terminals
    .map((terminal) => {
      const strip = mappedRect(terminal.contactStrip, map);
      return [
        `<rect data-region-id="etch-6066-${terminal.polarity}-strip-guide" data-polarity="${terminal.polarity}" x="${number(strip.x)}" y="${number(strip.y)}" width="${number(strip.width)}" height="${number(strip.height)}" fill="none" stroke="${GUIDE_STROKE}" stroke-width="${number(DRAFTING_LINE_WIDTH_MM)}"/>`,
        `<path data-region-id="etch-6066-${terminal.polarity}-corridor-guide" data-polarity="${terminal.polarity}" d="${terminalCorridorPath(terminal, map)}" fill="none" stroke="${GUIDE_STROKE}" stroke-width="${number(DRAFTING_LINE_WIDTH_MM)}" stroke-linejoin="round"/>`,
        `<path data-region-id="etch-6066-${terminal.polarity}-gate-guide" data-polarity="${terminal.polarity}" data-cell-index="${terminal.cellIndex}" d="${linePath([terminal.gate.start, terminal.gate.end], map)}" fill="none" stroke="${GUIDE_STROKE}" stroke-width="${number(DRAFTING_LINE_WIDTH_MM)}"/>`,
      ].join("\n");
    })
    .join("\n");
}

function renderEndpointLabels(
  geometry: LayoutGeometry,
  plate: PlateId,
  map: CoordinateMap,
): string {
  const suffix = plate === "glass-6066" ? "6066" : "6060";
  const endpointIndexes = Array.from(
    new Set([0, geometry.cells.length - 1].filter((index) => index >= 0)),
  );
  return endpointIndexes
    .flatMap((cellIndex) => {
      const cell = geometry.cells[cellIndex];
      if (!cell) return [];
      const site = map(cell.site);
      return [
        `<text data-region-id="etch-${suffix}-cell-label-${cell.index + 1}" data-subcell-index="${cell.index}" x="${number(site.x)}" y="${number(site.y)}" fill="${BLACK}" stroke="none" font-size="1.5" text-anchor="middle" dominant-baseline="middle">${cell.index + 1}</text>`,
      ];
    })
    .join("\n");
}

function renderIsolationGuides(
  geometry: LayoutGeometry,
  plate: PlateId,
  map: CoordinateMap,
): string {
  return geometry.etchPaths[plate]
    .filter((path) => path.source === "terminal-isolation")
    .map(
      (path) =>
        `<path data-source="terminal-isolation" data-isolation-index="${path.isolationIndex ?? -1}" d="${linePath([path.start, path.end], map)}"/>`,
    )
    .join("\n");
}

function renderEtchGuides(
  geometry: LayoutGeometry,
  plate: PlateId,
  map: CoordinateMap,
): string {
  const rect = plateRect(geometry, plate);
  const suffix = plate === "glass-6066" ? "6066" : "6060";
  return [
    `<g id="GUIDES_NON_PRINTING" data-output="non-printing">`,
    `<rect id="ETCH_${suffix}_PLATE_OUTLINE_GUIDE" x="0" y="0" width="${number(rect.width)}" height="${number(rect.height)}" fill="none" stroke="${GUIDE_STROKE}" stroke-width="${number(DRAFTING_LINE_WIDTH_MM)}"/>`,
    `<g id="ETCH_${suffix}_ENDPOINT_CELLS_GUIDE" fill="none" stroke="${GUIDE_STROKE}" stroke-width="${number(DRAFTING_LINE_WIDTH_MM)}" stroke-linejoin="round">${renderEndpointCellGuides(geometry, plate, map)}</g>`,
    plate === "glass-6066"
      ? `<g id="ETCH_6066_TERMINAL_CONNECTIVITY_GUIDE">${renderTerminalConnectivityGuides(geometry, map)}</g>`
      : "",
    `<g id="ETCH_${suffix}_ISOLATION_CUTS_GUIDE" fill="none" stroke="${GUIDE_STROKE}" stroke-width="${number(DRAFTING_LINE_WIDTH_MM)}">${renderIsolationGuides(geometry, plate, map)}</g>`,
    `<g id="ETCH_${suffix}_ENDPOINT_LABELS">${renderEndpointLabels(geometry, plate, map)}</g>`,
    "</g>",
  ]
    .filter(Boolean)
    .join("\n");
}

function buildEtchSvg(
  config: DesignConfig,
  geometry: LayoutGeometry,
  plate: PlateId,
): string {
  const rect = plateRect(geometry, plate);
  const map = plateMap(config, geometry, plate);
  const mirrored = plate === "glass-6060" && config.mirrorGlass6060;
  const suffix = plate === "glass-6066" ? "6066" : "6060";
  const paths = geometry.etchPaths[plate];
  const body = [
    `<rect id="ETCH_${suffix}_PAGE" x="0" y="0" width="${number(rect.width)}" height="${number(rect.height)}" fill="${WHITE}"/>`,
    renderEtchGuides(geometry, plate, map),
    `<g id="FTO_ETCH_${suffix}" data-operation="fto-etch-centerline" data-plate="${plate}" fill="none" stroke="${BLACK}" stroke-width="${number(finiteNonnegative(config.ftoEtchWidthMm))}" stroke-linecap="butt" stroke-linejoin="miter">${renderEtchOperative(geometry, plate, map)}</g>`,
  ].join("\n");
  return documentSvg({
    title: `FTO etch centerlines for ${plate}${mirrored ? " (fabrication mirror)" : ""}`,
    view: plate === "glass-6066" ? "etch-6066" : "etch-6060",
    plate,
    widthMm: rect.width,
    heightMm: rect.height,
    mirrored,
    outputKind: "production",
    body,
    metadata: {
      coordinateSystem: "conductive-side plate-local",
      centerlineWidthMm: finiteNonnegative(config.ftoEtchWidthMm),
      electrodeVoronoiPathCount: paths.filter(
        ({ source }) => source === "electrode-voronoi",
      ).length,
      activePerimeterPathCount: paths.filter(
        ({ source }) => source === "active-perimeter",
      ).length,
      terminalIsolationPathCount: paths.filter(
        ({ source }) => source === "terminal-isolation",
      ).length,
    },
  });
}

function buildBindingSvg(
  config: DesignConfig,
  geometry: LayoutGeometry,
): string {
  const map = assemblyMap(geometry);
  const active = mappedRect(geometry.bindingInner, map);
  const ring = `${rectPath(geometry.bindingOuter, map)} ${rectPath(geometry.bindingInner, map)}`;
  const boundaries = geometry.boundaries
    .map(
      (boundary, index) =>
        `<path data-region-id="binding-intercell-${index}" data-boundary-index="${index}" data-cells="${boundary.cells.join(",")}" d="${linePath([boundary.start, boundary.end], map)}"/>`,
    )
    .join("\n");
  const bindingWidth = finiteNonnegative(config.bindingWidthMm);
  const body = [
    `<rect id="BINDING_PAGE" x="0" y="0" width="${number(geometry.glass6066.width)}" height="${number(geometry.glass6066.height)}" fill="${WHITE}"/>`,
    `<defs><clipPath id="BINDING_ACTIVE_CLIP" clipPathUnits="userSpaceOnUse"><rect x="${number(active.x)}" y="${number(active.y)}" width="${number(active.width)}" height="${number(active.height)}"/></clipPath></defs>`,
    `<g id="BINDING_MASK" data-operation="bonding-mask" fill="${BLACK}">`,
    `<path data-region-id="binding-outer-ring" d="${ring}" fill-rule="evenodd" clip-rule="evenodd"/>`,
    `<g fill="none" stroke="${BLACK}" stroke-width="${number(bindingWidth)}" stroke-linecap="round" stroke-linejoin="round" clip-path="url(#BINDING_ACTIVE_CLIP)">${boundaries}</g>`,
    "</g>",
  ].join("\n");
  return documentSvg({
    title: "Binding mask",
    view: "binding",
    plate: "none",
    widthMm: geometry.glass6066.width,
    heightMm: geometry.glass6066.height,
    mirrored: false,
    outputKind: "production",
    body,
    metadata: { nominalBindingWidthMm: bindingWidth },
  });
}

export function buildPreviewSvg(
  config: DesignConfig,
  geometry: LayoutGeometry,
  pointCodeArtwork: PointCodeArtwork,
  mode: PreviewMode,
): string {
  switch (mode) {
    case "assembly":
      return buildAssemblyPreview(geometry);
    case "circuit":
      return buildCircuitReference(config, geometry);
    case "glass-6066":
      return buildScreenSvg(config, geometry, pointCodeArtwork, "glass-6066");
    case "glass-6060":
      return buildScreenSvg(config, geometry, pointCodeArtwork, "glass-6060");
    case "etch-6066":
      return buildEtchSvg(config, geometry, "glass-6066");
    case "etch-6060":
      return buildEtchSvg(config, geometry, "glass-6060");
    case "binding":
      return buildBindingSvg(config, geometry);
    default:
      throw new Error(`Unsupported preview mode: ${String(mode)}`);
  }
}

function asset(
  id: string,
  filename: string,
  title: string,
  widthMm: number,
  heightMm: number,
  svg: string,
): SvgAsset {
  return { id, filename, title, widthMm, heightMm, svg };
}

export function buildFabricationAssets(
  config: DesignConfig,
  geometry: LayoutGeometry,
  pointCodeArtwork: PointCodeArtwork,
): SvgAsset[] {
  const circuitSize = previewSize(geometry, "circuit");
  return [
    asset(
      "screen-glass-6066-tio2",
      "screen-glass-6066-tio2.svg",
      "Glass 6066 TiO2 screen",
      geometry.glass6066.width,
      geometry.glass6066.height,
      buildScreenSvg(config, geometry, pointCodeArtwork, "glass-6066"),
    ),
    asset(
      "screen-glass-6060-tio2",
      "screen-glass-6060-tio2.svg",
      "Glass 6060 TiO2 screen",
      geometry.glass6060.width,
      geometry.glass6060.height,
      buildScreenSvg(config, geometry, pointCodeArtwork, "glass-6060"),
    ),
    asset(
      "assembly-preview",
      "assembly-preview.svg",
      "Final assembled appearance",
      geometry.glass6066.width,
      geometry.glass6066.height,
      buildAssemblyPreview(geometry),
    ),
    asset(
      "circuit-reference",
      "circuit-reference.svg",
      "Dual-plate circuit reference",
      circuitSize.widthMm,
      circuitSize.heightMm,
      buildCircuitReference(config, geometry),
    ),
    asset(
      "fto-etch-glass-6066",
      "fto-etch-glass-6066.svg",
      "Glass 6066 FTO etch centerlines",
      geometry.glass6066.width,
      geometry.glass6066.height,
      buildEtchSvg(config, geometry, "glass-6066"),
    ),
    asset(
      "fto-etch-glass-6060",
      "fto-etch-glass-6060.svg",
      "Glass 6060 FTO etch centerlines",
      geometry.glass6060.width,
      geometry.glass6060.height,
      buildEtchSvg(config, geometry, "glass-6060"),
    ),
    asset(
      "binding-mask",
      "binding-mask.svg",
      "Binding mask",
      geometry.glass6066.width,
      geometry.glass6066.height,
      buildBindingSvg(config, geometry),
    ),
  ];
}
