import {
  DEFAULT_BITMAP_DPI,
  svgAssetToBilevelTiffBlob,
} from "./bitmap";
import { laserFillExport, laserFillSvg } from "./laser";
import { electricalEstimate, sealProcess } from "./process";
import { zebraContactRegions } from "./contacts";
import {
  POINT_CODE_MIN_GAP_MM,
  POINT_CODE_RADIUS_MM,
  type DesignConfig,
  type EtchPath,
  type LayoutGeometry,
  type PlateId,
  type Point,
  type PointCodeArtwork,
  type Rect,
} from "./model";
import type { SvgAsset } from "./svg";

type ProgressCallback = (
  completed: number,
  total: number,
  label: string,
) => void;

type CoordinateMap = (point: Point) => Point;

const SVG_NAMESPACE = "http://www.w3.org/2000/svg";
const NON_PRINTING_GUIDE_ID = "GUIDES_NON_PRINTING";
const SCREEN_6066_REGIONS_DXF_LAYER = "SCREEN_6066_TIO2_REGIONS";
const SCREEN_6060_REGIONS_DXF_LAYER = "SCREEN_6060_TIO2_REGIONS";
const SCREEN_6066_KNOCKOUTS_DXF_LAYER = "SCREEN_6066_POINT_KNOCKOUTS";
const SCREEN_6060_KNOCKOUTS_DXF_LAYER = "SCREEN_6060_POINT_KNOCKOUTS";
const DXF_LAYERS = [
  SCREEN_6066_REGIONS_DXF_LAYER,
  SCREEN_6060_REGIONS_DXF_LAYER,
  SCREEN_6066_KNOCKOUTS_DXF_LAYER,
  SCREEN_6060_KNOCKOUTS_DXF_LAYER,
  "FTO_ETCH_6066",
  "FTO_ETCH_6060",
  "CIRCUIT_REFERENCE",
  "BINDING",
] as const;
const SCREEN_ASSET_IDS = new Set([
  "screen-glass-6066-tio2",
  "screen-glass-6060-tio2",
]);
const PRODUCTION_ASSET_IDS = new Set([
  "screen-glass-6066-tio2",
  "screen-glass-6060-tio2",
  "fto-etch-glass-6066",
  "fto-etch-glass-6060",
  "binding-mask",
]);

function errorMessage(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}

function downloadBlob(blob: Blob, filename: string): void {
  if (
    typeof document === "undefined" ||
    typeof URL === "undefined" ||
    typeof URL.createObjectURL !== "function" ||
    typeof URL.revokeObjectURL !== "function"
  ) {
    throw new Error("File downloads require a browser with object URL support.");
  }

  const objectUrl = URL.createObjectURL(blob);
  const anchor = document.createElement("a");
  anchor.href = objectUrl;
  anchor.download = filename;
  anchor.style.display = "none";
  try {
    document.body.append(anchor);
    anchor.click();
  } finally {
    anchor.remove();
    URL.revokeObjectURL(objectUrl);
  }
}

export function downloadSvgAsset(asset: SvgAsset): void {
  downloadBlob(
    new Blob([asset.svg], { type: "image/svg+xml;charset=utf-8" }),
    asset.filename,
  );
}

interface GroupFrame {
  start: number;
  remove: boolean;
  coveredByRemovedAncestor: boolean;
}

function groupId(tag: string): string | undefined {
  const match = tag.match(
    /\sid\s*=\s*(?:"([^"]*)"|'([^']*)'|([^\s"'=<>`/]+))/i,
  );
  return match?.[1] ?? match?.[2] ?? match?.[3];
}

function groupHasNonPrintingId(tag: string): boolean {
  return groupId(tag) === NON_PRINTING_GUIDE_ID;
}

export function stripNonPrintingGuides(svg: string): string {
  const groupTokens =
    /<!--[\s\S]*?-->|<!\[CDATA\[[\s\S]*?\]\]>|<\?[\s\S]*?\?>|<\s*\/\s*g\s*>|<\s*g\b(?:[^>"']|"[^"]*"|'[^']*')*>/gi;
  const stack: GroupFrame[] = [];
  const removals: Array<{ start: number; end: number }> = [];
  let match: RegExpExecArray | null;

  while ((match = groupTokens.exec(svg)) !== null) {
    const tag = match[0];
    if (!/^<\s*\/?\s*g\b/i.test(tag)) continue;
    if (/^<\s*\//.test(tag)) {
      const frame = stack.pop();
      if (frame?.remove && !frame.coveredByRemovedAncestor) {
        removals.push({ start: frame.start, end: groupTokens.lastIndex });
      }
      continue;
    }

    const parent = stack[stack.length - 1];
    const frame: GroupFrame = {
      start: match.index,
      remove: groupHasNonPrintingId(tag),
      coveredByRemovedAncestor: Boolean(
        parent && (parent.remove || parent.coveredByRemovedAncestor),
      ),
    };
    if (/\/\s*>$/.test(tag)) {
      if (frame.remove && !frame.coveredByRemovedAncestor) {
        removals.push({ start: frame.start, end: groupTokens.lastIndex });
      }
    } else {
      stack.push(frame);
    }
  }

  for (const frame of stack) {
    if (frame.remove && !frame.coveredByRemovedAncestor) {
      removals.push({ start: frame.start, end: svg.length });
      break;
    }
  }
  if (removals.length === 0) return svg;

  removals.sort((first, second) => first.start - second.start);
  let result = "";
  let cursor = 0;
  for (const removal of removals) {
    if (removal.start < cursor) continue;
    result += svg.slice(cursor, removal.start);
    cursor = removal.end;
  }
  return result + svg.slice(cursor);
}

function dxfNumber(value: number): string {
  if (!Number.isFinite(value)) {
    throw new Error(
      `Unable to build manufacturing DXF: non-finite value ${String(value)}.`,
    );
  }
  if (Math.abs(value) < 0.0000000000005) return "0";
  return value.toFixed(12).replace(/(\.\d*?[1-9])0+$|\.0+$/, "$1");
}

function appendDxfPair(
  output: string[],
  code: number | string,
  value: number | string,
): void {
  output.push(String(code), String(value));
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

function appendClosedPolyline(
  output: string[],
  layer: string,
  points: Point[],
  map: CoordinateMap,
): void {
  const ring = openRing(points);
  if (ring.length < 3) return;
  appendDxfPair(output, 0, "LWPOLYLINE");
  appendDxfPair(output, 100, "AcDbEntity");
  appendDxfPair(output, 8, layer);
  appendDxfPair(output, 100, "AcDbPolyline");
  appendDxfPair(output, 90, ring.length);
  appendDxfPair(output, 70, 1);
  for (const point of ring) {
    const mapped = map(point);
    appendDxfPair(output, 10, dxfNumber(mapped.x));
    appendDxfPair(output, 20, dxfNumber(mapped.y));
  }
}

function appendLine(
  output: string[],
  layer: string,
  start: Point,
  end: Point,
  map: CoordinateMap,
): void {
  const mappedStart = map(start);
  const mappedEnd = map(end);
  appendDxfPair(output, 0, "LINE");
  appendDxfPair(output, 100, "AcDbEntity");
  appendDxfPair(output, 8, layer);
  appendDxfPair(output, 100, "AcDbLine");
  appendDxfPair(output, 10, dxfNumber(mappedStart.x));
  appendDxfPair(output, 20, dxfNumber(mappedStart.y));
  appendDxfPair(output, 30, 0);
  appendDxfPair(output, 11, dxfNumber(mappedEnd.x));
  appendDxfPair(output, 21, dxfNumber(mappedEnd.y));
  appendDxfPair(output, 31, 0);
}

function appendCircle(
  output: string[],
  layer: string,
  center: Point,
  radius: number,
  id: string,
  map: CoordinateMap,
): void {
  const mapped = map(center);
  appendDxfPair(output, 0, "CIRCLE");
  appendDxfPair(output, 100, "AcDbEntity");
  appendDxfPair(output, 8, layer);
  appendDxfPair(output, 100, "AcDbCircle");
  appendDxfPair(output, 10, dxfNumber(mapped.x));
  appendDxfPair(output, 20, dxfNumber(mapped.y));
  appendDxfPair(output, 30, 0);
  appendDxfPair(output, 40, dxfNumber(radius));
  appendDxfPair(output, 999, `id=${id}`);
}

function plateRect(geometry: LayoutGeometry, plate: PlateId): Rect {
  return plate === "glass-6066" ? geometry.glass6066 : geometry.glass6060;
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

function assemblyMap(geometry: LayoutGeometry): CoordinateMap {
  return (point) => ({
    x: point.x - geometry.glass6066.x,
    y: point.y - geometry.glass6066.y,
  });
}

function selectedScreenRegions(
  config: DesignConfig,
  geometry: LayoutGeometry,
  plate: PlateId,
): Array<{ cell: LayoutGeometry["cells"][number]; polygon: Point[] }> {
  void config;
  return geometry.cells.flatMap((cell) => {
    const isTio2 =
      plate === "glass-6066"
        ? cell.glass6066Material === "tio2"
        : cell.glass6060Material === "tio2";
    if (!isTio2) return [];

    const polygon = geometry.fabrication.activeRegions[cell.index];
    return polygon.length >= 3 ? [{ cell, polygon }] : [];
  });
}

function dxfEtchPathComment(path: EtchPath, pathIndex: number): string {
  const metadata = (() => {
    switch (path.source) {
      case "electrode-voronoi":
        return `boundaryIndex=${String(path.boundaryIndex)} cells=${path.cells?.join(",") ?? ""}`;
      case "voronoi-bleed":
        return `boundaryIndex=${path.boundaryIndex} cells=${path.cells?.join(",")} pieceIndex=${path.pieceIndex} glassEdge=${path.glassEdge}${path.sharedSide ? ` sharedSide=${path.sharedSide}` : ""}`;
      case "active-perimeter":
        return `perimeterIndex=${String(path.perimeterIndex)} pieceIndex=${String(path.pieceIndex)}`;
      case "terminal-isolation":
        return `isolationIndex=${String(path.isolationIndex)}`;
      case "contact-strip-isolation":
        return `polarity=${path.polarity} pieceIndex=${String(path.pieceIndex)}`;
    }
  })();
  return `geometry.etchPaths[${path.plate}][${pathIndex}] source=${path.source} ${metadata}`;
}

export function buildManufacturingDxf(
  config: DesignConfig,
  geometry: LayoutGeometry,
  pointCodeArtwork: PointCodeArtwork,
): string {
  const output: string[] = [];
  const width = Math.max(geometry.glass6066.width, geometry.glass6060.width);
  const height = Math.max(geometry.glass6066.height, geometry.glass6060.height);

  appendDxfPair(output, 0, "SECTION");
  appendDxfPair(output, 2, "HEADER");
  appendDxfPair(output, 9, "$ACADVER");
  appendDxfPair(output, 1, "AC1015");
  appendDxfPair(output, 9, "$INSUNITS");
  appendDxfPair(output, 70, 4);
  appendDxfPair(output, 9, "$MEASUREMENT");
  appendDxfPair(output, 70, 1);
  appendDxfPair(output, 9, "$EXTMIN");
  appendDxfPair(output, 10, 0);
  appendDxfPair(output, 20, 0);
  appendDxfPair(output, 30, 0);
  appendDxfPair(output, 9, "$EXTMAX");
  appendDxfPair(output, 10, dxfNumber(width));
  appendDxfPair(output, 20, dxfNumber(height));
  appendDxfPair(output, 30, 0);
  appendDxfPair(output, 0, "ENDSEC");

  appendDxfPair(output, 0, "SECTION");
  appendDxfPair(output, 2, "TABLES");
  appendDxfPair(output, 0, "TABLE");
  appendDxfPair(output, 2, "LAYER");
  appendDxfPair(output, 100, "AcDbSymbolTable");
  appendDxfPair(output, 70, DXF_LAYERS.length + 1);
  appendDxfPair(output, 0, "LAYER");
  appendDxfPair(output, 100, "AcDbSymbolTableRecord");
  appendDxfPair(output, 100, "AcDbLayerTableRecord");
  appendDxfPair(output, 2, "0");
  appendDxfPair(output, 70, 0);
  appendDxfPair(output, 62, 7);
  appendDxfPair(output, 6, "CONTINUOUS");
  DXF_LAYERS.forEach((layer, index) => {
    appendDxfPair(output, 0, "LAYER");
    appendDxfPair(output, 100, "AcDbSymbolTableRecord");
    appendDxfPair(output, 100, "AcDbLayerTableRecord");
    appendDxfPair(output, 2, layer);
    appendDxfPair(output, 70, 0);
    appendDxfPair(output, 62, (index % 6) + 1);
    appendDxfPair(output, 6, "CONTINUOUS");
  });
  appendDxfPair(output, 0, "ENDTAB");
  appendDxfPair(output, 0, "ENDSEC");

  appendDxfPair(output, 0, "SECTION");
  appendDxfPair(output, 2, "ENTITIES");
  appendDxfPair(output, 999, "Units: millimetres.");
  appendDxfPair(
    output,
    999,
    "Screen region layers are actual TiO2 coating operations after seal-envelope, registration and etch clearance; coating trim is not extra adhesive.",
  );
  appendDxfPair(
    output,
    999,
    `Point knockout layers contain white no-print CIRCLE operations at Demaine sites; radius=${String(POINT_CODE_RADIUS_MM)} mm, diameter=${(POINT_CODE_RADIUS_MM * 2).toFixed(2)} mm, and minimum within-code center spacing=${(POINT_CODE_RADIUS_MM * 2 + POINT_CODE_MIN_GAP_MM).toFixed(2)} mm.`,
  );
  appendDxfPair(
    output,
    999,
    "Glass 6060 screen and etch layers use conductive-side local coordinates and the configured horizontal fabrication mirror.",
  );
  appendDxfPair(
    output,
    999,
    "FTO layers preserve the exact order and endpoints of geometry.etchPaths, including terminal-isolation paths.",
  );
  appendDxfPair(
    output,
    999,
    `BINDING contains opened SOLID HATCH stencil polygons; printed normal wall width bindingWidthMm=${String(config.bindingWidthMm)} mm; not compression-envelope artwork.`,
  );

  const map6066 = plateMap(config, geometry, "glass-6066");
  const map6060 = plateMap(config, geometry, "glass-6060");
  for (const {
    plate,
    regionLayer,
    knockoutLayer,
    map,
  } of [
    {
      plate: "glass-6066",
      regionLayer: SCREEN_6066_REGIONS_DXF_LAYER,
      knockoutLayer: SCREEN_6066_KNOCKOUTS_DXF_LAYER,
      map: map6066,
    },
    {
      plate: "glass-6060",
      regionLayer: SCREEN_6060_REGIONS_DXF_LAYER,
      knockoutLayer: SCREEN_6060_KNOCKOUTS_DXF_LAYER,
      map: map6060,
    },
  ] as const) {
    const selectedRegions = selectedScreenRegions(config, geometry, plate);
    const selectedIndexes = new Set(
      selectedRegions.map(({ cell }) => cell.index),
    );
    for (const { polygon } of selectedRegions) {
      appendClosedPolyline(output, regionLayer, polygon, map);
    }
    for (const placement of pointCodeArtwork.placements) {
      if (
        placement.character === " " ||
        !selectedIndexes.has(placement.subcellIndex)
      ) {
        continue;
      }
      placement.sites.forEach((site, siteIndex) => {
        const id = `cell-${placement.subcellIndex}-slot-${placement.slotIndex}-site-${siteIndex}`;
        appendCircle(
          output,
          knockoutLayer,
          site,
          POINT_CODE_RADIUS_MM,
          id,
          map,
        );
      });
    }
  }

  for (const plate of ["glass-6066", "glass-6060"] as const) {
    const layer = plate === "glass-6066" ? "FTO_ETCH_6066" : "FTO_ETCH_6060";
    const map = plate === "glass-6066" ? map6066 : map6060;
    geometry.etchPaths[plate].forEach((path, pathIndex) => {
      appendLine(output, layer, path.start, path.end, map);
      appendDxfPair(output, 999, dxfEtchPathComment(path, pathIndex));
    });
  }

  const referenceMap = assemblyMap(geometry);
  for (const boundary of geometry.boundaries) {
    appendLine(
      output,
      "CIRCUIT_REFERENCE",
      boundary.start,
      boundary.end,
      referenceMap,
    );
  }
  // SOLID HATCH with explicit hole loops: same opened glue polygons as SVG/PDF.
  for (const polygon of geometry.fabrication.sealPrint) {
    appendDxfPair(output, 0, "HATCH");
    appendDxfPair(output, 100, "AcDbEntity");
    appendDxfPair(output, 8, "BINDING");
    appendDxfPair(output, 100, "AcDbHatch");
    for (const [code, value] of [[10, 0], [20, 0], [30, 0], [210, 0], [220, 0], [230, 1], [2, "SOLID"], [70, 1], [71, 0], [91, polygon.length]] as const) appendDxfPair(output, code, value);
    polygon.forEach((ring, index) => {
      const points = openRing(ring);
      for (const [code, value] of [[92, index === 0 ? 3 : 2], [72, 0], [73, 1], [93, points.length]] as const) appendDxfPair(output, code, value);
      points.forEach((p) => { const v = referenceMap(p); appendDxfPair(output, 10, dxfNumber(v.x)); appendDxfPair(output, 20, dxfNumber(v.y)); });
      appendDxfPair(output, 97, 0);
    });
    appendDxfPair(output, 75, 0);
    appendDxfPair(output, 76, 1);
    appendDxfPair(output, 98, 0);
  }

  appendDxfPair(output, 0, "ENDSEC");
  appendDxfPair(output, 0, "EOF");
  return `${output.join("\r\n")}\r\n`;
}

function finiteGalvoNumber(value: number, label: string): number {
  if (!Number.isFinite(value)) {
    throw new Error(
      `Unable to build galvo toolpaths: ${label} is not a finite number.`,
    );
  }
  return Object.is(value, -0) ? 0 : value;
}

function clamp(value: number, minimum: number, maximum: number): number {
  return Math.min(maximum, Math.max(minimum, value));
}

function galvoSourceMetadata(path: EtchPath): Record<string, unknown> {
  switch (path.source) {
    case "electrode-voronoi":
      return {
        boundaryIndex: path.boundaryIndex,
        cells: path.cells,
      };
    case "voronoi-bleed":
      return { boundaryIndex: path.boundaryIndex, cells: path.cells, pieceIndex: path.pieceIndex, glassEdge: path.glassEdge,
        ...(path.sharedSide ? { sharedSide: path.sharedSide } : {}) };
    case "active-perimeter":
      return {
        perimeterIndex: path.perimeterIndex,
        pieceIndex: path.pieceIndex,
      };
    case "terminal-isolation":
      return { isolationIndex: path.isolationIndex };
    case "contact-strip-isolation":
      return { polarity: path.polarity, pieceIndex: path.pieceIndex };
  }
}

export function buildGalvoToolpaths(
  config: DesignConfig,
  geometry: LayoutGeometry,
): string {
  const buildPlate = (plate: PlateId) => {
    const rect = plateRect(geometry, plate);
    const widthMm = finiteGalvoNumber(rect.width, `${plate}.widthMm`);
    const heightMm = finiteGalvoNumber(rect.height, `${plate}.heightMm`);
    if (widthMm <= 0 || heightMm <= 0) {
      throw new Error(
        `Unable to build galvo toolpaths: ${plate} must have positive dimensions.`,
      );
    }
    const map = plateMap(config, geometry, plate);
    const point = (source: Point) => {
      const mapped = map(source);
      const x = finiteGalvoNumber(mapped.x, `${plate}.point.x`);
      const y = finiteGalvoNumber(mapped.y, `${plate}.point.y`);
      return {
        x,
        y,
        normalized: {
          x: finiteGalvoNumber(
            clamp((x / widthMm) * 2 - 1, -1, 1),
            `${plate}.point.normalized.x`,
          ),
          y: finiteGalvoNumber(
            clamp((y / heightMm) * 2 - 1, -1, 1),
            `${plate}.point.normalized.y`,
          ),
        },
      };
    };
    return {
      widthMm,
      heightMm,
      origin: "top-left",
      xDirection: "right",
      yDirection: "down",
      mirroredHorizontally:
        plate === "glass-6060" && config.mirrorGlass6060,
      paths: geometry.etchPaths[plate].map((path, pathIndex) => ({
        id: `${plate}-etch-${pathIndex}`,
        source: path.source,
        plate: path.plate,
        widthMm: finiteGalvoNumber(config.ftoEtchWidthMm, "path.widthMm"),
        ...galvoSourceMetadata(path),
        points: [point(path.start), point(path.end)],
      })),
      isolationRoutes: geometry.fabrication.isolationRoutes[plate].map((route) => ({
        side: route.side, points: route.points.map(point), pathIndices: route.pathIndices,
        continuousTopToBottom: route.continuousTopToBottom, referenceOnly: true,
      })),
    };
  };

  return `${JSON.stringify(
    {
      format: "w-series-dssc-galvo-toolpath-v4",
      units: "mm",
      description:
        "Unframed Voronoi FTO centerlines: electrode-voronoi core cuts plus voronoi-bleed extensions to physical glass edges. No active-perimeter / rectangular etch frame. 6066 side bleed protects zebra contact faces. isolationRoutes are reference-only existing cuts. Not a device wire protocol.",
      interchange: {
        neutral: true,
        deviceWireProtocol: false,
      },
      normalizedRange: [-1, 1],
      normalizedCoordinatesAreSupplemental: true,
      mirrorGlass6060: config.mirrorGlass6060,
      plates: {
        "glass-6066": buildPlate("glass-6066"),
        "glass-6060": buildPlate("glass-6060"),
      },
    },
    null,
    2,
  )}\n`;
}

function parseSvgElement(svg: string, filename: string): Element {
  if (typeof DOMParser === "undefined") {
    throw new Error(
      `Unable to convert "${filename}" to PDF: DOMParser is unavailable; PDF conversion must run in a browser.`,
    );
  }

  let parsed: Document;
  try {
    parsed = new DOMParser().parseFromString(svg, "image/svg+xml");
  } catch (error) {
    throw new Error(
      `Unable to parse SVG "${filename}" for PDF conversion: ${errorMessage(error)}`,
      { cause: error },
    );
  }
  const parserError = parsed.querySelector("parsererror");
  if (parserError) {
    const detail = parserError.textContent?.replace(/\s+/g, " ").trim();
    throw new Error(
      `Unable to parse SVG "${filename}" for PDF conversion${detail ? `: ${detail}` : "."}`,
    );
  }
  const root = parsed.documentElement;
  if (
    root.localName.toLowerCase() !== "svg" ||
    root.namespaceURI !== SVG_NAMESPACE
  ) {
    throw new Error(
      `Unable to convert "${filename}" to PDF: the source root is not an SVG element.`,
    );
  }
  return root;
}

export async function assetToPdfBlob(
  asset: SvgAsset,
  production = false,
): Promise<Blob> {
  if (
    !Number.isFinite(asset.widthMm) ||
    !Number.isFinite(asset.heightMm) ||
    asset.widthMm <= 0 ||
    asset.heightMm <= 0
  ) {
    throw new Error(
      `Unable to convert "${asset.filename}" to PDF: page dimensions must be finite positive millimetre values.`,
    );
  }

  const source = production ? productionSvg(asset) : asset.svg;
  const svgElement = parseSvgElement(source, asset.filename);
  svgElement.setAttribute("width", `${asset.widthMm}mm`);
  svgElement.setAttribute("height", `${asset.heightMm}mm`);

  let jspdfModule: typeof import("jspdf");
  try {
    jspdfModule = await import("jspdf");
    await import("svg2pdf.js");
  } catch (error) {
    throw new Error(
      `Unable to load PDF conversion libraries for "${asset.filename}": ${errorMessage(error)}`,
      { cause: error },
    );
  }

  try {
    const pdf = new jspdfModule.jsPDF({
      orientation:
        asset.widthMm > asset.heightMm ? "landscape" : "portrait",
      unit: "mm",
      format: [asset.widthMm, asset.heightMm],
      compress: true,
      precision: 12,
      putOnlyUsedFonts: true,
    });
    const pageWidth = pdf.internal.pageSize.getWidth();
    const pageHeight = pdf.internal.pageSize.getHeight();
    if (
      Math.abs(pageWidth - asset.widthMm) > 0.000001 ||
      Math.abs(pageHeight - asset.heightMm) > 0.000001
    ) {
      throw new Error(
        `jsPDF created a ${pageWidth} x ${pageHeight} mm page instead of ${asset.widthMm} x ${asset.heightMm} mm.`,
      );
    }
    pdf.setProperties({
      title: asset.title,
      subject: production ? "Production artwork" : "Layered artwork preview",
      creator: "W-series DSSC Layout Designer",
    });
    if (typeof pdf.svg !== "function") {
      throw new Error("svg2pdf.js did not augment the jsPDF instance.");
    }
    await pdf.svg(svgElement, {
      x: 0,
      y: 0,
      width: asset.widthMm,
      height: asset.heightMm,
      loadExternalStyleSheets: false,
    });
    return pdf.output("blob");
  } catch (error) {
    throw new Error(
      `Unable to convert "${asset.filename}" to a vector PDF: ${errorMessage(error)}`,
      { cause: error },
    );
  }
}

function isAssemblyPreview(asset: SvgAsset): boolean {
  return (
    asset.id === "assembly-preview" ||
    /\bdata-view\s*=\s*(["'])assembly\1/.test(asset.svg)
  );
}

function isProductionAsset(asset: SvgAsset): boolean {
  return PRODUCTION_ASSET_IDS.has(asset.id);
}

function isScreenAsset(asset: SvgAsset): boolean {
  return SCREEN_ASSET_IDS.has(asset.id);
}

function productionSvg(asset: SvgAsset): string {
  return isScreenAsset(asset) ? asset.svg : stripNonPrintingGuides(asset.svg);
}

function safeAssetFilename(asset: SvgAsset): string {
  const filename = asset.filename.replace(/\\/g, "/").split("/").pop()?.trim();
  if (!filename || filename === "." || filename === "..") {
    throw new Error(`Asset "${asset.id}" has an invalid filename.`);
  }
  return filename.replace(/[\u0000-\u001f\u007f]/g, "_");
}

function pdfFilename(filename: string): string {
  return `${filename.replace(/\.svg$/i, "")}.pdf`;
}

export function screenTiffFilename(asset: SvgAsset): string {
  const filename = safeAssetFilename(asset).replace(/\.svg$/i, "");
  return `${filename}-1bit-${DEFAULT_BITMAP_DPI}dpi.tif`;
}

export async function downloadScreenTiff(asset: SvgAsset): Promise<void> {
  const blob = await svgAssetToBilevelTiffBlob(asset, {
    dpi: DEFAULT_BITMAP_DPI,
  });
  downloadBlob(blob, screenTiffFilename(asset));
}

function readme(config: DesignConfig): string {
  return [
    "W 型串聯 DSSC 製造輸出 v9.1 — uniform coating clearance / no centroid trimming",
    "",
    "所有製造尺寸與座標均以毫米（mm）表示。",
    "TiO2 網版的黑色為 active region，已扣除 Binding、估計膠體擴散、對位與 FTO 切寬；白色不印刷。",
    "Area Balance只約束移動Voronoi sites以改善分區面積，不再按比例裁小塗層。每個cell以相同法向安全距離內縮，填滿固定分區可用凸形範圍；局部搜尋不保證精確等面積或全域最佳。",
    "Coating Safety Gap是壓合設計情境中的最小淨距離目標，另加對位餘量與情境膠體成長量得到印刷膠邊退讓；較大蝕刻寬度可能主導。預設0.10mm是未驗證設計起點，非材料安全規格。",
    "Point Code Text 已從 v5 介面移除，v5 新設計文字為空。",
    `bitmap-production/ 內的兩片網版為未壓縮、真正 1-bit、${DEFAULT_BITMAP_DPI} DPI TIFF（uncompressed true 1-bit ${DEFAULT_BITMAP_DPI} DPI TIFF）；檔名以 -1bit-${DEFAULT_BITMAP_DPI}dpi.tif 結尾。`,
    `6060 玻璃製造檔水平鏡射：${config.mirrorGlass6060 ? "是" : "否"}。復原該製造鏡射並加回玻璃局部座標位移後，兩片網版會在組裝座標重合。`,
    "6066 左右 zebra 外露接觸條涵蓋玻璃完整高度；端點 cell gate 使用端點子電池在 facing side 擁有的完整跨度，不是縮短的 bridge。",
    "Terminal geometry: full-height 6066 zebra strips and full cell gates across each endpoint cell's owned facing-side span.",
    "FTO只包含electrode-voronoi與voronoi-bleed：選中的Voronoi邊界在生成區邊緣直接出血到實際玻璃邊，完全不生成active-perimeter、矩形蝕刻框、獨立fence或四角stub。",
    "6060依邊界方向出血；6066每側同方向的端點共用一條直線，其他Voronoi邊以T接點相接，取消平行扇形出血與重複掃描；保留完整zebra接觸面。每段出血都接在選定的Voronoi端點，並非外框。",
    "Galvo isolationRoutes是現有切線的可追蹤參考路徑，不是要重複曝光的額外操作。白色SVG頁面就是實際玻璃範圍，沒有額外artboard邊框。",
    "每片的 geometry.etchPaths 是唯一 canonical FTO 路徑來源；SVG、DXF 與 Galvo 必須保持相同順序、端點及 source metadata。",
    `binding-mask 使用已扣除垂直注液／排氣槽的實體多邊形；名義 bindingWidthMm = ${String(config.bindingWidthMm)} mm。`,
    "DXF BINDING 是帶孔 SOLID HATCH，與 binding-mask.svg 的實體封膠相同。",
    "注液網路從上到下覆蓋所有子電池，刪除任何一個槽都會失去完整上下通路；不是流體止回閥，不能消除長期離子遷移。",
    "封膠模型：p=25.4/mesh；a=p-wire；f=(a/p)^2；td=transfer*(2*wire*f+EOM)；h=beadD50。",
    "開口模型：在實際膠版求 Area(offset(print,s))*h=Area(print)*td；再加使用者側向溢膠及製版邊緣誤差餘量。通道剩餘淨寬由膠體膨脹後的幾何實測，不是直接指定。",
    "EOM=Emulsion Over Mesh，來自網版製程，不是 AB-313 TDS。預設10µm和轉移率0.32皆為未量測假設。TDS 200µm 是膠層測試厚度，不是 EOM。非零 measuredWetFilmUm 覆寫網版體積估算。",
    "開口尺寸使用實測濕膜；未量測時改用單次網版滿載幾何估算(transfer=1)的壓合情境，不以未量測0.32當成確定厚度。這不是已驗證最壞上界。minimumArtworkOpeningMm可設定製版孔寬下限。",
    "printedWidthMm是實際印刷多邊形開口；finalWidthMm/minimumChannelMm是設計情境包絡的幾何淨寬，不是實測成品孔寬。實際壓合後仍未量測。",
    "Binding與Assembly預設共用sealPrint印刷膠版，預覽可同步切換sealAssembled壓合情境。膠以黑色標示，白色是未塗層／無膠留空。製造檔與assembly-preview參考檔固定使用印刷膠版，不受情境開關影響。",
    "濕膜小於假設玻璃間隙時壓合預測不成立，不能視為零擴散。壓力／黏度只作流動時間尺度診斷，不能截去多餘膠量。",
    "玻璃珠商品對照1000目≈15µm連動D50與假設gap；不是通用篩網換算，也不是印刷網版mesh。",
    "AB-313 TDS 20180206 V.1 p1: viscosity 38000 ± 8000 mPa.s at 25°C；其餘模型係數及 D90 須實測校正。沒有唯一可由黏度求得的最佳孔寬。",
    `design.json 保留實際 electrodeJitter = ${String(config.electrodeJitter)}（允許上限 2）與 ftoEtchWidthMm = ${String(config.ftoEtchWidthMm)} mm（預設 0.08 mm）。`,
    "",
    "design.json：v9 設計參數，以glassHeightMm作兩片共同高度，僅寬度不同；舊高度欄位匯入時遷移，不再匯出。geometry保留端子、canonical etchPaths與fabrication activeRegions／sealPrint／sealAssembled／ports／retainedFto／openingScenario。activePerimeter不可用作蝕刻操作。",
    "zebraContactReference／process-estimates.zebraContacts：大片左右外露區與保留FTO的實際交集、可接觸面積與導通狀態。Assembly斜線及±標號屬GUIDES_NON_PRINTING參考，不是塗層／膠／蝕刻圖樣。",
    "process-estimates.json：製程中間值、逐 cell 面積、電流基準、雙片 FTO 等效串聯電阻、未擬合 I–V／MPP 情境及來源。",
    "electrical.iscMa 是面積縮放的最弱 cell 基準，不是成品輸出。reference-cell 模式以整片對照 Isc／有效面積／照度換算；面積未知時為 null，絕不回退舊 Jsc。",
    "使用者確認參考有效面積55×55=3025 mm²、通常電流38–40 mA；預設同於此電流參考的光照，以min(Ai)/3025縮放，range不是統計信賴區間。",
    "網站較早的DSSC55×55 A只有Voc／lux／環境，與38–40 mA沒有同條件配對。voltageObservation保留2026-10-26快照、日期、匹配條件、排除期、URL，並分開保存網站聲明的logger雜湊與獨立下載核對的公開CSV雜湊。完整日Voc依匹配後的每小時中位數再取日中位數。",
    "早期A基準497.1mV、942.5lux；10/25可比Voc328.625mV，66.108%是電壓保留率，不用來縮放Isc／功率。不把全日lux中位數當作可比Voc子集的同步照度。",
    "Same-light模式不假定942.5lux或100mW/cm²；effectiveJscMaCm2與參考mW/cm²為null。Lux-ratio需電流同步照度、同光譜／幾何，無通用lux→mW/cm²換算。",
    "選線上電壓觀測時scenario=null，因Voc與Isc未配對，不混合反推FTO I–V／MPP；FTO幾何電阻仍保留。電壓日期選擇不推算電流老化。",
    "TEC7/8/10/15/20 典型方塊電阻 7/8/10/13/19 Ω/□，來源 NSG GL058 March 2024 p11；可自訂兩片實測值。TEC15 不等於恰好 15 Ω/□，且品級的透光／haze 影響未建模。",
    "FTO 等效 R=Rsheet*(A/(3W²)+lead/W)，逐 cell／雙片相加，僅為均勻整邊集流的等效條帶近似，不是 retained-FTO 2D 求解、也不含接觸／電解液／Pt 電阻。",
    "electrical.scenario 以 a*ln(1+(Iph-I)/I0) 逐 cell 電壓相加扣 I*R 求 Isc／MPP；超出 forward branch 時以弱光電流截斷並標記，不聲稱求出逆偏 I–V。",
    "a 預設 50 mV 未擬合。對照 Rs 是獨立歷史輸入，用於去嵌入；預設 0 暫忽略對照損失，可能重複計入既有 FTO 損失。情境不是校正後成品預測。",
    "Bigger / Smaller Electrode 分別對應相容檔名 glass-6066 / glass-6060；不再以固定尺寸命名介面。",
    "electrical.cellIscMa 是逐 cell 的面積電流基準；limitingCellNumber 為最小有效面積 cell（從 1 起算）。含 FTO 的 Isc 在 scenario.iscMa，切勿把兩者當同一量測。",
    "laser-fill/：toolpaths.json 及兩片 beam-centre fill SVG；laser ON 僅在每段內，段間移動 OFF。需設備校正 power/speed/kerf。",
    "雷射圓形光斑角點可殘留約半徑尺度，交會區重複曝光需校正；檔案不是機台控制協定。",
    "svg-layered/：七個完整分層 SVG，包含參考圖與非印刷導引。",
    "svg-production/：兩片二值網版、兩片已移除 GUIDES_NON_PRINTING 的 FTO 蝕刻中心線與 binding-mask。",
    "pdf-production/：與五個製造 SVG 實體尺寸一致的向量 PDF。",
    "bitmap-production/：兩片二值網版的 1-bit 1200 DPI TIFF。",
    `pdf-preview/assembly-preview.pdf：${config.glass6066WidthMm} x ${config.glassHeightMm} mm 組裝參考，含斑馬條接觸位置標示。`,
    "manufacturing-layout.dxf：兩片 TiO2 region、canonical FTO、circuit reference 與 BINDING 分層資料。",
    "fto-galvo-toolpaths.json：v4 中性交換格式，逐片保存canonical etchPaths與voronoi-bleed metadata。",
    "",
    "校正警告：製造前必須依材料、binding、網印、TIFF RIP 與雷射設備試片，重新校正線寬、實際尺寸、鏡射方向及對位；不可直接把名義值視為設備校正值。",
    "",
  ].join("\n");
}

function copyArrayBuffer(bytes: Uint8Array): ArrayBuffer {
  const copy = new Uint8Array(bytes.byteLength);
  copy.set(bytes);
  return copy.buffer;
}

export async function downloadProjectBundle(
  config: DesignConfig,
  geometry: LayoutGeometry,
  pointCodeArtwork: PointCodeArtwork,
  assets: SvgAsset[],
  includePdfs: boolean,
  onProgress?: ProgressCallback,
): Promise<void> {
  let fflate: typeof import("fflate");
  try {
    fflate = await import("fflate");
  } catch (error) {
    throw new Error(`Unable to load the ZIP library: ${errorMessage(error)}`, {
      cause: error,
    });
  }

  const exportAssets = assets;
  const productionAssets = exportAssets.filter(isProductionAsset);
  const screenAssets = productionAssets.filter(isScreenAsset);
  const assemblyPreviews = exportAssets.filter(isAssemblyPreview).slice(0, 1);
  const pdfCount = includePdfs
    ? productionAssets.length + assemblyPreviews.length
    : 0;
  const tiffCount = includePdfs ? screenAssets.length : 0;
  const total = 2 + productionAssets.length + pdfCount + tiffCount + 1;
  let completed = 0;
  const report = (label: string): void => {
    completed += 1;
    onProgress?.(completed, total, label);
  };
  onProgress?.(0, total, "準備匯出檔案");

  const files: Record<string, Uint8Array> = {};
  const addFile = (path: string, data: Uint8Array): void => {
    if (Object.prototype.hasOwnProperty.call(files, path)) {
      throw new Error(`Unable to create project bundle: duplicate path "${path}".`);
    }
    files[path] = data;
  };
  const addText = (path: string, text: string): void => {
    addFile(path, fflate.strToU8(text));
  };

  addText(
    "design.json",
    `${JSON.stringify(
      {
        format: "w-series-dssc-project-v9",
        units: "mm",
        description:
          "Active-area-balanced DSSC; unframed Voronoi bleed etch, shared seal, fill ports and retained-FTO geometry. Process and electrical values are estimates.",
        config,
        geometry,
        zebraContactReference: zebraContactRegions(geometry),
        pointCodeArtwork,
      },
      null,
      2,
    )}\n`,
  );
  addText("README.txt", readme(config));
  addText(
    "manufacturing-layout.dxf",
    buildManufacturingDxf(config, geometry, pointCodeArtwork),
  );
  report("建立製造 DXF");
  addText("fto-galvo-toolpaths.json", buildGalvoToolpaths(config, geometry));
  addText("laser-fill/toolpaths.json", `${JSON.stringify(laserFillExport(config, geometry), null, 2)}\n`);
  for (const plate of ["glass-6066", "glass-6060"] as const) {
    addText(`laser-fill/${plate}-fill.svg`, laserFillSvg(config, geometry, plate));
  }
  addText("process-estimates.json", `${JSON.stringify({
    seal: sealProcess(config), electrical: electricalEstimate(config, geometry.fabrication.cellAreasMm2, geometry),
    cellAreasMm2: geometry.fabrication.cellAreasMm2, areaCv: geometry.fabrication.areaCv,
    coatingClearance: geometry.fabrication.coatingClearance,
    zebraContacts: zebraContactRegions(geometry),
    actualStencil: { areaMm2: geometry.fabrication.sealPrintAreaMm2,
      nominalVolumeSpreadMm: geometry.fabrication.volumeSpreadMm, scenarioEnvelopeSpreadMm: geometry.fabrication.envelopeSpreadMm,
      minimumScenarioClearMm: geometry.fabrication.minimumChannelMm, compressionValid: geometry.fabrication.compressionValid },
    apertureDesign: { minimumPrintedOpeningMm: geometry.fabrication.minimumPrintedChannelMm,
      scenario: geometry.fabrication.openingScenario, minimumScenarioClearMm: geometry.fabrication.minimumChannelMm,
      pressedOpeningMeasured: false },
    fto6066Terminals: geometry.fabrication.terminalCheck,
    isolationRoutes: geometry.fabrication.isolationRoutes,
    voronoiBleedCheck: geometry.fabrication.bleedCheck,
    ports: geometry.fabrication.ports,
    provenance: { viscosity: "Everlight Eversolar AB-313 TDS 20180206 V.1, p1: 38000 ± 8000 mPa.s at 25°C", beadD50: "User: median 15 µm, grade 1000 mesh", other: "User-adjustable engineering assumptions; see PROCESS_MODEL.md" },
  }, null, 2)}\n`);
  report("建立 Galvo 蝕刻路徑");

  for (const item of exportAssets) {
    addText(`svg-layered/${safeAssetFilename(item)}`, item.svg);
  }
  for (const item of productionAssets) {
    const filename = safeAssetFilename(item);
    addText(`svg-production/${filename}`, productionSvg(item));
    report(`建立製造 SVG：${filename}`);
  }

  if (includePdfs) {
    for (const item of productionAssets) {
      const filename = pdfFilename(safeAssetFilename(item));
      const pdf = await assetToPdfBlob(item, true);
      addFile(
        `pdf-production/${filename}`,
        new Uint8Array(await pdf.arrayBuffer()),
      );
      report(`建立製造 PDF：${filename}`);
    }
    for (const item of assemblyPreviews) {
      const filename = pdfFilename(safeAssetFilename(item));
      const pdf = await assetToPdfBlob(item, false);
      addFile(
        `pdf-preview/${filename}`,
        new Uint8Array(await pdf.arrayBuffer()),
      );
      report(`建立組裝預覽 PDF：${filename}`);
    }
    for (const item of screenAssets) {
      const filename = screenTiffFilename(item);
      const tiff = await svgAssetToBilevelTiffBlob(item, {
        dpi: DEFAULT_BITMAP_DPI,
      });
      addFile(
        `bitmap-production/${filename}`,
        new Uint8Array(await tiff.arrayBuffer()),
      );
      report(`建立 1-bit ${DEFAULT_BITMAP_DPI} DPI TIFF：${filename}`);
    }
  }

  let zipBytes: Uint8Array;
  try {
    zipBytes = fflate.zipSync(files, { level: 6 });
  } catch (error) {
    throw new Error(
      `Unable to create project ZIP: ${errorMessage(error)}`,
      { cause: error },
    );
  }
  downloadBlob(
    new Blob([copyArrayBuffer(zipBytes)], { type: "application/zip" }),
    "w-series-dssc-project.zip",
  );
  report("完成專案 ZIP");
}
