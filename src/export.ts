import {
  DEFAULT_BITMAP_DPI,
  svgAssetToBilevelTiffBlob,
} from "./bitmap";
import { insetConvexPolygon } from "./point-code";
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

function rectPoints(rect: Rect): Point[] {
  return [
    { x: rect.x, y: rect.y },
    { x: rect.x + rect.width, y: rect.y },
    { x: rect.x + rect.width, y: rect.y + rect.height },
    { x: rect.x, y: rect.y + rect.height },
  ];
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
  const bindingWidth = Number.isFinite(config.bindingWidthMm)
    ? Math.max(0, config.bindingWidthMm)
    : 0;
  return geometry.cells.flatMap((cell) => {
    const isTio2 =
      plate === "glass-6066"
        ? cell.glass6066Material === "tio2"
        : cell.glass6060Material === "tio2";
    if (!isTio2) return [];

    const polygon = insetConvexPolygon(cell.polygon, bindingWidth / 2);
    return polygon.length >= 3 ? [{ cell, polygon }] : [];
  });
}

function dxfEtchPathComment(path: EtchPath, pathIndex: number): string {
  const metadata = (() => {
    switch (path.source) {
      case "electrode-voronoi":
        return `boundaryIndex=${String(path.boundaryIndex)} cells=${path.cells?.join(",") ?? ""}`;
      case "active-perimeter":
        return `perimeterIndex=${String(path.perimeterIndex)} pieceIndex=${String(path.pieceIndex)}`;
      case "terminal-isolation":
        return `isolationIndex=${String(path.isolationIndex)}`;
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
    "Screen region layers are the black TiO2 operations derived from each plate's circuit materials and inset by bindingWidthMm/2.",
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
    `BINDING contains bindingOuter, bindingInner, and every inter-cell boundary centerline; nominal bindingWidthMm=${String(config.bindingWidthMm)}.`,
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
  for (const perimeter of geometry.activePerimeter) {
    appendLine(
      output,
      "CIRCUIT_REFERENCE",
      perimeter.start,
      perimeter.end,
      referenceMap,
    );
  }
  appendClosedPolyline(
    output,
    "BINDING",
    rectPoints(geometry.bindingOuter),
    referenceMap,
  );
  appendClosedPolyline(
    output,
    "BINDING",
    rectPoints(geometry.bindingInner),
    referenceMap,
  );
  for (const boundary of geometry.boundaries) {
    appendLine(
      output,
      "BINDING",
      boundary.start,
      boundary.end,
      referenceMap,
    );
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
    case "active-perimeter":
      return {
        perimeterIndex: path.perimeterIndex,
        pieceIndex: path.pieceIndex,
      };
    case "terminal-isolation":
      return { isolationIndex: path.isolationIndex };
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
    };
  };

  return `${JSON.stringify(
    {
      format: "w-series-dssc-galvo-toolpath-v3",
      units: "mm",
      description:
        "Neutral interchange for the canonical per-plate FTO etch centerlines, including electrode-voronoi, active-perimeter, and top/bottom terminal-isolation paths; not a device wire protocol.",
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
    "W 型串聯 DSSC 製造輸出 v4",
    "",
    "所有製造尺寸與座標均以毫米（mm）表示。",
    "兩片網版的黑色區域是由串聯電路材料配置直接決定的各片頂層 TiO2 region mask，並由每個 cell 邊界向內縮 bindingWidthMm/2。",
    `白色圓形是 Demaine-site point knockout（不印刷），固定半徑 ${String(POINT_CODE_RADIUS_MM)} mm、直徑 ${(POINT_CODE_RADIUS_MM * 2).toFixed(2)} mm；同一 point-code placement 內任兩 site 的最小圓心間距為 ${(POINT_CODE_RADIUS_MM * 2 + POINT_CODE_MIN_GAP_MM).toFixed(2)} mm，也就是圓直徑加上 ${POINT_CODE_MIN_GAP_MM.toFixed(2)} mm 最小邊緣間隙。它們是點位編碼，不是可閱讀字樣，也不是文字負片。`,
    `Point knockout geometry: radius ${String(POINT_CODE_RADIUS_MM)} mm, diameter ${(POINT_CODE_RADIUS_MM * 2).toFixed(2)} mm; within each point-code placement, minimum site center-to-center spacing is ${(POINT_CODE_RADIUS_MM * 2 + POINT_CODE_MIN_GAP_MM).toFixed(2)} mm, leaving a ${POINT_CODE_MIN_GAP_MM.toFixed(2)} mm edge-to-edge gap.`,
    "若 canonical bindingWidthMm/2 inset 少於三個頂點，SVG 與 DXF 都會省略該 TiO2 region 及其 point knockout；validatePointCodeArtwork 會回報 blocking error，必須修正設計後再製造。",
    "FTO 電極蝕刻層與 point knockout 彼此獨立；point site 不作為 FTO 蝕刻線，也不會進入 Galvo 路徑。",
    "兩片 screen SVG 已是乾淨的黑白二值 TiO2 分色；黑色為 TiO2 操作區，白色為不印刷頁面或 point knockout。製造 PDF 直接使用相同二值 SVG。",
    `bitmap-production/ 內的兩片網版為未壓縮、真正 1-bit、${DEFAULT_BITMAP_DPI} DPI TIFF（uncompressed true 1-bit ${DEFAULT_BITMAP_DPI} DPI TIFF）；檔名以 -1bit-${DEFAULT_BITMAP_DPI}dpi.tif 結尾。`,
    `6060 玻璃製造檔水平鏡射：${config.mirrorGlass6060 ? "是" : "否"}。復原該製造鏡射並加回玻璃局部座標位移後，兩片網版會在組裝座標重合。`,
    "6066 左右 zebra 外露接觸條涵蓋玻璃完整高度；端點 cell gate 使用端點子電池在 facing side 擁有的完整跨度，不是縮短的 bridge。",
    "Terminal geometry: full-height 6066 zebra strips and full cell gates across each endpoint cell's owned facing-side span.",
    "兩片玻璃都包含頂部與底部各一條 terminal-isolation 切線（每片恰好兩條），用來隔離延伸至端子區的 FTO。",
    "Both plates include top/bottom terminal-isolation cuts.",
    "每片的 geometry.etchPaths 是唯一 canonical FTO 路徑來源；SVG、DXF 與 Galvo 必須保持相同順序、端點及 source metadata。",
    `binding-mask 使用 bindingOuter、bindingInner 與全部 inter-cell geometry；名義 bindingWidthMm = ${String(config.bindingWidthMm)} mm。`,
    `design.json 保留實際 electrodeJitter = ${String(config.electrodeJitter)}（允許上限 2）與 ftoEtchWidthMm = ${String(config.ftoEtchWidthMm)} mm（預設 0.08 mm）。`,
    "",
    "design.json：v4 設計參數、binding、端子、canonical etchPaths 與 pointCodeArtwork。",
    "svg-layered/：七個完整分層 SVG，包含參考圖與非印刷導引。",
    "svg-production/：兩片二值網版、兩片已移除 GUIDES_NON_PRINTING 的 FTO 蝕刻中心線與 binding-mask。",
    "pdf-production/：與五個製造 SVG 實體尺寸一致的向量 PDF。",
    "bitmap-production/：兩片二值網版的 1-bit 1200 DPI TIFF。",
    "pdf-preview/assembly-preview.pdf：66 x 60 mm 基準組裝預覽。",
    "manufacturing-layout.dxf：兩片 TiO2 region、白色 point knockout CIRCLE、canonical FTO、circuit reference 與 BINDING 分層資料。",
    "fto-galvo-toolpaths.json：v3 中性交換格式，逐片保存 canonical etchPaths 與 terminal-isolation metadata。",
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
        format: "w-series-dssc-project-v4",
        units: "mm",
        description:
          "Circuit-derived per-plate TiO2 regions use fixed-radius Demaine-site point knockouts; canonical etchPaths include source-specific metadata and terminal-isolation cuts.",
        config,
        geometry,
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
