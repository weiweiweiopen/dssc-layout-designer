import { strFromU8, unzipSync } from "fflate";
import { afterEach, describe, expect, it, vi } from "vitest";

import { svgAssetToBilevelTiffBlob } from "./bitmap";

import {
  assetToPdfBlob,
  buildGalvoToolpaths,
  buildManufacturingDxf,
  downloadProjectBundle,
  downloadScreenTiff,
  screenTiffFilename,
  stripNonPrintingGuides,
} from "./export";
import {
  buildPointCodeArtwork,
  insetConvexPolygon,
  validatePointCodeArtwork,
} from "./point-code";
import { buildGeometry } from "./geometry";
import {
  DEFAULT_CONFIG,
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
import {
  buildFabricationAssets,
  type SvgAsset,
} from "./svg";

vi.mock("./bitmap", async (importOriginal) => {
  const actual = await importOriginal<typeof import("./bitmap")>();
  return {
    ...actual,
    svgAssetToBilevelTiffBlob: vi.fn(actual.svgAssetToBilevelTiffBlob),
  };
});

vi.mock("jspdf", () => ({
  jsPDF: class MockJsPdf {
    internal: {
      pageSize: { getWidth: () => number; getHeight: () => number };
    };

    constructor(options: { format: [number, number] }) {
      const [width, height] = options.format;
      this.internal = {
        pageSize: {
          getWidth: () => width,
          getHeight: () => height,
        },
      };
    }

    setProperties(): void {}

    async svg(): Promise<void> {}

    output(): Blob {
      return new Blob(["mock-pdf"], { type: "application/pdf" });
    }
  },
}));

vi.mock("svg2pdf.js", () => ({}));

const SCREEN_6066_REGIONS_LAYER = "SCREEN_6066_TIO2_REGIONS";
const SCREEN_6060_REGIONS_LAYER = "SCREEN_6060_TIO2_REGIONS";
const SCREEN_6066_KNOCKOUTS_LAYER = "SCREEN_6066_POINT_KNOCKOUTS";
const SCREEN_6060_KNOCKOUTS_LAYER = "SCREEN_6060_POINT_KNOCKOUTS";

function design(overrides: Partial<DesignConfig> = {}): DesignConfig {
  return { ...DEFAULT_CONFIG, ...overrides };
}

function fixture(overrides: Partial<DesignConfig> = {}): {
  config: DesignConfig;
  geometry: LayoutGeometry;
  pointCodeArtwork: PointCodeArtwork;
} {
  const config = design(overrides);
  const geometry = buildGeometry(config);
  return {
    config,
    geometry,
    pointCodeArtwork: buildPointCodeArtwork(config, geometry),
  };
}

interface DxfRecord {
  code: string;
  value: string;
}

interface DxfEntity {
  type: string;
  records: DxfRecord[];
}

function dxfRecords(dxf: string): DxfRecord[] {
  const lines = dxf.trim().split(/\r?\n/);
  const records: DxfRecord[] = [];
  for (let index = 0; index < lines.length; index += 2) {
    records.push({ code: lines[index].trim(), value: lines[index + 1].trim() });
  }
  return records;
}

function dxfEntities(dxf: string): DxfEntity[] {
  const records = dxfRecords(dxf);
  const entitiesSection = records.findIndex(
    (record, index) =>
      record.code === "2" &&
      record.value === "ENTITIES" &&
      records[index - 1]?.code === "0" &&
      records[index - 1]?.value === "SECTION",
  );
  const entities: DxfEntity[] = [];
  let current: DxfEntity | undefined;
  for (let index = entitiesSection + 1; index < records.length; index += 1) {
    const record = records[index];
    if (record.code === "0" && record.value === "ENDSEC") break;
    if (
      record.code === "0" &&
      ["LINE", "LWPOLYLINE", "CIRCLE"].includes(record.value)
    ) {
      if (current) entities.push(current);
      current = { type: record.value, records: [] };
    } else if (current) {
      current.records.push(record);
    }
  }
  if (current) entities.push(current);
  return entities;
}

function entityLayer(entity: DxfEntity): string {
  return entity.records.find((record) => record.code === "8")?.value ?? "";
}

function entitiesOn(entities: DxfEntity[], layer: string): DxfEntity[] {
  return entities.filter((entity) => entityLayer(entity) === layer);
}

function entityNumber(entity: DxfEntity, code: string): number {
  const value = entity.records.find((record) => record.code === code)?.value;
  if (value === undefined) throw new Error(`DXF entity is missing group ${code}`);
  return Number(value);
}

function dxfLinePoints(entity: DxfEntity): [Point, Point] {
  expect(entity.type).toBe("LINE");
  return [
    { x: entityNumber(entity, "10"), y: entityNumber(entity, "20") },
    { x: entityNumber(entity, "11"), y: entityNumber(entity, "21") },
  ];
}

function dxfPolylinePoints(entity: DxfEntity): Point[] {
  expect(entity.type).toBe("LWPOLYLINE");
  const points: Point[] = [];
  let x: number | undefined;
  for (const record of entity.records) {
    if (record.code === "10") x = Number(record.value);
    if (record.code === "20" && x !== undefined) {
      points.push({ x, y: Number(record.value) });
      x = undefined;
    }
  }
  return points;
}

function dxfCircleCenter(entity: DxfEntity): Point {
  expect(entity.type).toBe("CIRCLE");
  return {
    x: entityNumber(entity, "10"),
    y: entityNumber(entity, "20"),
  };
}

function dxfCircleId(entity: DxfEntity): string {
  const value = entity.records.find(
    (record) => record.code === "999" && record.value.startsWith("id="),
  )?.value;
  if (!value) throw new Error("DXF circle is missing its point-code ID");
  return value.slice(3);
}

function declaredDxfLayers(dxf: string): string[] {
  const records = dxfRecords(dxf);
  return records.flatMap((record, index) => {
    if (record.code !== "0" || record.value !== "LAYER") return [];
    const name = records.slice(index + 1).find((next) => next.code === "2");
    return name ? [name.value] : [];
  });
}

function rectPoints(rect: Rect): Point[] {
  return [
    { x: rect.x, y: rect.y },
    { x: rect.x + rect.width, y: rect.y },
    { x: rect.x + rect.width, y: rect.y + rect.height },
    { x: rect.x, y: rect.y + rect.height },
  ];
}

function platePoint(
  config: DesignConfig,
  geometry: LayoutGeometry,
  plate: PlateId,
  point: Point,
): Point {
  const rect = plate === "glass-6066" ? geometry.glass6066 : geometry.glass6060;
  const localX = point.x - rect.x;
  return {
    x:
      plate === "glass-6060" && config.mirrorGlass6060
        ? rect.width - localX
        : localX,
    y: point.y - rect.y,
  };
}

function assemblyPoint(geometry: LayoutGeometry, point: Point): Point {
  return {
    x: point.x - geometry.glass6066.x,
    y: point.y - geometry.glass6066.y,
  };
}

function expectPointsClose(actual: Point[], expected: Point[]): void {
  expect(actual).toHaveLength(expected.length);
  actual.forEach((point, index) => {
    expect(point.x).toBeCloseTo(expected[index].x, 9);
    expect(point.y).toBeCloseTo(expected[index].y, 9);
  });
}

function svgGroupContents(svg: string, id: string): string {
  const marker = `<g id="${id}"`;
  const start = svg.indexOf(marker);
  expect(start, `missing SVG group ${id}`).toBeGreaterThanOrEqual(0);
  const openingEnd = svg.indexOf(">", start);
  const tokens = /<g\b[^>]*>|<\/g>/g;
  tokens.lastIndex = openingEnd + 1;
  let depth = 1;
  let token: RegExpExecArray | null;
  while ((token = tokens.exec(svg)) !== null) {
    depth += token[0].startsWith("</") ? -1 : 1;
    if (depth === 0) return svg.slice(openingEnd + 1, token.index);
  }
  throw new Error(`unterminated SVG group ${id}`);
}

function svgPathElements(content: string): string[] {
  return content.match(/<path\b[^>]*\/>/g) ?? [];
}

function svgCircleElements(content: string): string[] {
  return content.match(/<circle\b[^>]*\/>/g) ?? [];
}

function svgAttribute(element: string, name: string): string {
  return element.match(new RegExp(`\\s${name}="([^"]*)"`))?.[1] ?? "";
}

function assetById(assets: SvgAsset[], id: string): SvgAsset {
  const asset = assets.find((candidate) => candidate.id === id);
  expect(asset, `missing asset ${id}`).toBeDefined();
  return asset as SvgAsset;
}

function selectedCells(
  geometry: LayoutGeometry,
  plate: PlateId,
): LayoutGeometry["cells"] {
  return geometry.cells.filter((cell) =>
    plate === "glass-6066"
      ? cell.glass6066Material === "tio2"
      : cell.glass6060Material === "tio2",
  );
}

function usableScreenRegions(
  config: DesignConfig,
  geometry: LayoutGeometry,
  plate: PlateId,
): Array<{ cell: LayoutGeometry["cells"][number]; polygon: Point[] }> {
  const insetMm = Number.isFinite(config.bindingWidthMm)
    ? Math.max(0, config.bindingWidthMm) / 2
    : 0;
  return selectedCells(geometry, plate).flatMap((cell) => {
    const polygon = insetConvexPolygon(cell.polygon, insetMm);
    return polygon.length >= 3 ? [{ cell, polygon }] : [];
  });
}

function expectedKnockouts(
  config: DesignConfig,
  pointCodeArtwork: PointCodeArtwork,
  geometry: LayoutGeometry,
  plate: PlateId,
): Array<{ id: string; point: Point }> {
  const selectedIndexes = new Set(
    usableScreenRegions(config, geometry, plate).map(({ cell }) => cell.index),
  );
  return pointCodeArtwork.placements.flatMap((placement) =>
    placement.character === " " ||
    !selectedIndexes.has(placement.subcellIndex)
      ? []
      : placement.sites.map((point, siteIndex) => ({
          id: `cell-${placement.subcellIndex}-slot-${placement.slotIndex}-site-${siteIndex}`,
          point,
        })),
  );
}

describe("stripNonPrintingGuides", () => {
  it("removes a complete nested guide group without touching operative groups", () => {
    const svg = [
      '<svg xmlns="http://www.w3.org/2000/svg">',
      '<g id="OPERATIVE"><g id="INK"><path d="M 0 0 L 1 1"/></g></g>',
      '<g data-output="non-printing" id="GUIDES_NON_PRINTING">',
      '<g id="OUTLINES"><g><rect width="1" height="1"/></g></g>',
      '<g id="LABELS"><text>remove me</text></g>',
      "</g>",
      '<g id="OPERATIVE_AFTER"><circle r="1"/></g>',
      "</svg>",
    ].join("\n");

    const stripped = stripNonPrintingGuides(svg);
    expect(stripped).toContain('id="OPERATIVE"');
    expect(stripped).toContain('id="INK"');
    expect(stripped).toContain('id="OPERATIVE_AFTER"');
    expect(stripped).not.toContain("GUIDES_NON_PRINTING");
    expect(stripped).not.toContain("remove me");
  });

  it("leaves the already-clean binary screen separations byte-identical", () => {
    const { config, geometry, pointCodeArtwork } = fixture();
    const assets = buildFabricationAssets(config, geometry, pointCodeArtwork);

    for (const id of [
      "screen-glass-6066-tio2",
      "screen-glass-6060-tio2",
    ]) {
      const screen = assetById(assets, id);
      expect(screen.svg).not.toContain("GUIDES_NON_PRINTING");
      expect(stripNonPrintingGuides(screen.svg)).toBe(screen.svg);
    }
  });
});

describe("screen TIFF helpers", () => {
  it("uses the two TiO2 screen names for 1-bit 1200-DPI production", () => {
    const { config, geometry, pointCodeArtwork } = fixture();
    const assets = buildFabricationAssets(config, geometry, pointCodeArtwork);
    const screen6066 = assetById(assets, "screen-glass-6066-tio2");
    const screen6060 = assetById(assets, "screen-glass-6060-tio2");

    expect(screenTiffFilename(screen6066)).toBe(
      "screen-glass-6066-tio2-1bit-1200dpi.tif",
    );
    expect(screenTiffFilename(screen6060)).toBe(
      "screen-glass-6060-tio2-1bit-1200dpi.tif",
    );
    expect(
      screenTiffFilename({ ...screen6066, filename: "nested/SCREEN.SVG" }),
    ).toBe("SCREEN-1bit-1200dpi.tif");
  });
});

describe("buildManufacturingDxf", () => {
  it("exports material-parity TiO2 regions, point circles, circuit references, and binding", () => {
    const { config, geometry, pointCodeArtwork } = fixture({
      bindingWidthMm: 4,
      mirrorGlass6060: true,
    });
    const dxf = buildManufacturingDxf(config, geometry, pointCodeArtwork);
    const records = dxfRecords(dxf);
    const entities = dxfEntities(dxf);
    const unitsIndex = records.findIndex(
      (record) => record.code === "9" && record.value === "$INSUNITS",
    );
    const requiredLayers = [
      SCREEN_6066_REGIONS_LAYER,
      SCREEN_6060_REGIONS_LAYER,
      SCREEN_6066_KNOCKOUTS_LAYER,
      SCREEN_6060_KNOCKOUTS_LAYER,
      "FTO_ETCH_6066",
      "FTO_ETCH_6060",
      "CIRCUIT_REFERENCE",
      "BINDING",
    ];

    expect(records[unitsIndex + 1]).toEqual({ code: "70", value: "4" });
    expect(declaredDxfLayers(dxf)).toEqual(
      expect.arrayContaining(requiredLayers),
    );
    expect(declaredDxfLayers(dxf)).not.toEqual(
      expect.arrayContaining([
        "FONT_VORONOI_REFERENCE",
        "FONT_SITES_REFERENCE",
      ]),
    );
    expect(dxf).not.toMatch(/FONT_VORONOI_REFERENCE|FONT_SITES_REFERENCE/);
    expect(POINT_CODE_RADIUS_MM).toBe(0.03);
    expect(POINT_CODE_RADIUS_MM * 2 + POINT_CODE_MIN_GAP_MM).toBeCloseTo(
      0.07,
      12,
    );

    expect(selectedCells(geometry, "glass-6066").map(({ index }) => index)).toEqual(
      geometry.cells.filter(({ index }) => index % 2 === 0).map(({ index }) => index),
    );
    expect(selectedCells(geometry, "glass-6060").map(({ index }) => index)).toEqual(
      geometry.cells.filter(({ index }) => index % 2 === 1).map(({ index }) => index),
    );

    for (const [plate, regionLayer, knockoutLayer] of [
      [
        "glass-6066",
        SCREEN_6066_REGIONS_LAYER,
        SCREEN_6066_KNOCKOUTS_LAYER,
      ],
      [
        "glass-6060",
        SCREEN_6060_REGIONS_LAYER,
        SCREEN_6060_KNOCKOUTS_LAYER,
      ],
    ] as const) {
      const selected = usableScreenRegions(config, geometry, plate);
      const regions = entitiesOn(entities, regionLayer);
      const expectedCircles = expectedKnockouts(
        config,
        pointCodeArtwork,
        geometry,
        plate,
      );
      const circles = entitiesOn(entities, knockoutLayer);

      expect(regions).toHaveLength(selected.length);
      regions.forEach((region, index) => {
        expect(region.type).toBe("LWPOLYLINE");
        const expectedParent = selected[index].polygon.map((point) =>
          platePoint(config, geometry, plate, point),
        );
        expectPointsClose(dxfPolylinePoints(region), expectedParent);
      });

      expect(circles).toHaveLength(expectedCircles.length);
      circles.forEach((circle, index) => {
        expect(dxfCircleId(circle)).toBe(expectedCircles[index].id);
        expect(entityNumber(circle, "40")).toBe(POINT_CODE_RADIUS_MM);
        expectPointsClose([dxfCircleCenter(circle)], [
          platePoint(config, geometry, plate, expectedCircles[index].point),
        ]);
      });
    }

    for (const placement of pointCodeArtwork.placements) {
      for (let first = 0; first < placement.sites.length; first += 1) {
        for (
          let second = first + 1;
          second < placement.sites.length;
          second += 1
        ) {
          expect(
            Math.hypot(
              placement.sites[first].x - placement.sites[second].x,
              placement.sites[first].y - placement.sites[second].y,
            ),
          ).toBeGreaterThanOrEqual(0.07 - 1e-10);
        }
      }
    }

    expect(entitiesOn(entities, "CIRCUIT_REFERENCE")).toHaveLength(
      geometry.boundaries.length + geometry.activePerimeter.length,
    );
    const binding = entitiesOn(entities, "BINDING");
    expect(binding).toHaveLength(geometry.boundaries.length + 2);
    expectPointsClose(
      dxfPolylinePoints(binding[0]),
      rectPoints(geometry.bindingOuter).map((point) =>
        assemblyPoint(geometry, point),
      ),
    );
    expectPointsClose(
      dxfPolylinePoints(binding[1]),
      rectPoints(geometry.bindingInner).map((point) =>
        assemblyPoint(geometry, point),
      ),
    );
    geometry.boundaries.forEach((boundary, index) => {
      expectPointsClose(dxfLinePoints(binding[index + 2]), [
        assemblyPoint(geometry, boundary.start),
        assemblyPoint(geometry, boundary.end),
      ]);
    });
  });

  it("matches canonical collapsed-region omission for the real 64-cell, 5 mm layout", () => {
    const config = design({
      subcellCount: 64,
      bindingWidthMm: 5,
      text: "A".repeat(64),
      mirrorGlass6060: true,
    });
    const geometry = buildGeometry(config);
    const pointCodeArtwork = buildPointCodeArtwork(config, geometry);
    const collapsedCells = geometry.cells.filter(
      (cell) =>
        insetConvexPolygon(cell.polygon, config.bindingWidthMm / 2).length < 3,
    );
    const orphanPlacements = collapsedCells.map((cell, index) => ({
      slotIndex: 10_000 + index,
      slotIndexInSubcell: 0,
      subcellIndex: cell.index,
      character: "A",
      sites: [cell.site],
    }));
    const artworkWithOrphanCandidates: PointCodeArtwork = {
      ...pointCodeArtwork,
      placements: [...pointCodeArtwork.placements, ...orphanPlacements],
    };
    const dxf = dxfEntities(
      buildManufacturingDxf(config, geometry, artworkWithOrphanCandidates),
    );
    const assets = buildFabricationAssets(
      config,
      geometry,
      artworkWithOrphanCandidates,
    );
    const blockingErrors = validatePointCodeArtwork(
      config,
      geometry,
      pointCodeArtwork,
    ).filter(({ severity }) => severity === "error");

    expect(collapsedCells.length).toBeGreaterThan(0);
    expect(blockingErrors.length).toBeGreaterThan(0);
    expect(
      blockingErrors.some(({ message }) =>
        /Screen cell|TiO2 印刷區/.test(message),
      ),
    ).toBe(true);

    for (const [plate, assetId, regionGroup, regionLayer, knockoutLayer] of [
      [
        "glass-6066",
        "screen-glass-6066-tio2",
        "SCREEN_6066_TIO2_REGIONS",
        SCREEN_6066_REGIONS_LAYER,
        SCREEN_6066_KNOCKOUTS_LAYER,
      ],
      [
        "glass-6060",
        "screen-glass-6060-tio2",
        "SCREEN_6060_TIO2_REGIONS",
        SCREEN_6060_REGIONS_LAYER,
        SCREEN_6060_KNOCKOUTS_LAYER,
      ],
    ] as const) {
      const canonicalRegions = usableScreenRegions(config, geometry, plate);
      const usableIndexes = new Set(
        canonicalRegions.map(({ cell }) => cell.index),
      );
      const collapsedIndexes = new Set(
        selectedCells(geometry, plate)
          .filter(({ index }) => !usableIndexes.has(index))
          .map(({ index }) => index),
      );
      const dxfRegions = entitiesOn(dxf, regionLayer);
      const dxfCircles = entitiesOn(dxf, knockoutLayer);
      const screen = assetById(assets, assetId).svg;
      const svgRegions = svgPathElements(
        svgGroupContents(screen, regionGroup),
      );
      const svgCircles = svgCircleElements(
        svgGroupContents(screen, "SCREEN_POINT_CODE_KNOCKOUTS"),
      );

      expect(collapsedIndexes.size).toBeGreaterThan(0);
      expect(dxfRegions).toHaveLength(canonicalRegions.length);
      expect(svgRegions).toHaveLength(canonicalRegions.length);
      expect(
        svgRegions.map((path) => Number(svgAttribute(path, "data-subcell-index"))),
      ).toEqual(canonicalRegions.map(({ cell }) => cell.index));
      dxfRegions.forEach((region, index) => {
        expectPointsClose(
          dxfPolylinePoints(region),
          canonicalRegions[index].polygon.map((point) =>
            platePoint(config, geometry, plate, point),
          ),
        );
      });

      expect(dxfCircles).toHaveLength(svgCircles.length);
      for (const circle of dxfCircles) {
        const cellIndex = Number(dxfCircleId(circle).match(/^cell-(\d+)-/)?.[1]);
        expect(usableIndexes.has(cellIndex)).toBe(true);
        expect(collapsedIndexes.has(cellIndex)).toBe(false);
      }
      for (const circle of svgCircles) {
        const cellIndex = Number(svgAttribute(circle, "data-subcell-index"));
        expect(usableIndexes.has(cellIndex)).toBe(true);
        expect(collapsedIndexes.has(cellIndex)).toBe(false);
      }
      for (const orphan of orphanPlacements) {
        if (!collapsedIndexes.has(orphan.subcellIndex)) continue;
        const orphanId = `cell-${orphan.subcellIndex}-slot-${orphan.slotIndex}-site-0`;
        expect(dxfCircles.map(dxfCircleId)).not.toContain(orphanId);
        expect(svgCircles.map((circle) => svgAttribute(circle, "id"))).not.toContain(
          orphanId,
        );
      }
    }
  });

  it("preserves every canonical path endpoint and both isolation cuts on each plate", () => {
    const { config, geometry, pointCodeArtwork } = fixture({
      mirrorGlass6060: true,
    });
    const dxf = buildManufacturingDxf(config, geometry, pointCodeArtwork);
    const entities = dxfEntities(dxf);

    for (const plate of ["glass-6066", "glass-6060"] as const) {
      const layer = plate === "glass-6066" ? "FTO_ETCH_6066" : "FTO_ETCH_6060";
      const lines = entitiesOn(entities, layer);
      const paths = geometry.etchPaths[plate];
      expect(lines).toHaveLength(paths.length);
      expect(
        paths.filter((path) => path.source === "terminal-isolation"),
      ).toHaveLength(2);
      paths.forEach((path, index) => {
        expectPointsClose(dxfLinePoints(lines[index]), [
          platePoint(config, geometry, plate, path.start),
          platePoint(config, geometry, plate, path.end),
        ]);
        expect(dxf).toContain(
          `geometry.etchPaths[${plate}][${index}] source=${path.source}`,
        );
        if (path.source === "terminal-isolation") {
          expect(dxf).toContain(
            `source=terminal-isolation isolationIndex=${String(path.isolationIndex)}`,
          );
        }
      });
    }
    expect(dxf.match(/source=terminal-isolation isolationIndex=/g)).toHaveLength(
      4,
    );
  });

  it("keeps region polygons and canonical FTO text-independent while spaces remove all points", () => {
    const { config, geometry, pointCodeArtwork } = fixture({
      subcellCount: 4,
      text: "ABCD",
    });
    const baseline = dxfEntities(
      buildManufacturingDxf(config, geometry, pointCodeArtwork),
    );
    const detachedGeometry: LayoutGeometry = {
      ...geometry,
      boundaries: [],
      activePerimeter: [],
    };
    const detached = dxfEntities(
      buildManufacturingDxf(config, detachedGeometry, pointCodeArtwork),
    );
    const replacementConfig = { ...config, text: "WXYZ" };
    const replacement = dxfEntities(
      buildManufacturingDxf(
        replacementConfig,
        geometry,
        buildPointCodeArtwork(replacementConfig, geometry),
      ),
    );
    const spacesConfig = { ...config, text: "    " };
    const spaces = dxfEntities(
      buildManufacturingDxf(
        spacesConfig,
        geometry,
        buildPointCodeArtwork(spacesConfig, geometry),
      ),
    );

    for (const layer of ["FTO_ETCH_6066", "FTO_ETCH_6060"]) {
      expect(entitiesOn(detached, layer)).toEqual(entitiesOn(baseline, layer));
      expect(entitiesOn(replacement, layer)).toEqual(entitiesOn(baseline, layer));
      expect(entitiesOn(spaces, layer)).toEqual(entitiesOn(baseline, layer));
    }
    for (const layer of [
      SCREEN_6066_REGIONS_LAYER,
      SCREEN_6060_REGIONS_LAYER,
    ]) {
      expect(entitiesOn(replacement, layer)).toEqual(entitiesOn(baseline, layer));
      expect(entitiesOn(spaces, layer)).toEqual(entitiesOn(baseline, layer));
    }
    for (const layer of [
      SCREEN_6066_KNOCKOUTS_LAYER,
      SCREEN_6060_KNOCKOUTS_LAYER,
    ]) {
      expect(entitiesOn(baseline, layer).length).toBeGreaterThan(0);
      expect(entitiesOn(replacement, layer)).not.toEqual(
        entitiesOn(baseline, layer),
      );
      expect(entitiesOn(spaces, layer)).toHaveLength(0);
    }
  });

  it("mirrors only 6060 fabrication layers in plate-local coordinates", () => {
    const base = fixture({ mirrorGlass6060: false });
    const plain = dxfEntities(
      buildManufacturingDxf(
        base.config,
        base.geometry,
        base.pointCodeArtwork,
      ),
    );
    const mirrored = dxfEntities(
      buildManufacturingDxf(
        { ...base.config, mirrorGlass6060: true },
        base.geometry,
        base.pointCodeArtwork,
      ),
    );
    const mirroredLayers = new Set([
      SCREEN_6060_REGIONS_LAYER,
      SCREEN_6060_KNOCKOUTS_LAYER,
      "FTO_ETCH_6060",
    ]);

    expect(mirrored).toHaveLength(plain.length);
    plain.forEach((entity, entityIndex) => {
      const counterpart = mirrored[entityIndex];
      const layer = entityLayer(entity);
      expect(entityLayer(counterpart)).toBe(layer);
      const xValues = entity.records
        .filter((record) => record.code === "10" || record.code === "11")
        .map((record) => Number(record.value));
      const mirroredXValues = counterpart.records
        .filter((record) => record.code === "10" || record.code === "11")
        .map((record) => Number(record.value));
      expect(mirroredXValues).toHaveLength(xValues.length);
      xValues.forEach((x, pointIndex) => {
        expect(mirroredXValues[pointIndex]).toBeCloseTo(
          mirroredLayers.has(layer) ? base.geometry.glass6060.width - x : x,
          9,
        );
      });
    });
  });
});

interface GalvoPoint extends Point {
  normalized: Point;
}

interface GalvoPath {
  id: string;
  source: EtchPath["source"];
  plate: PlateId;
  widthMm: number;
  boundaryIndex?: number;
  cells?: [number, number];
  perimeterIndex?: number;
  pieceIndex?: number;
  isolationIndex?: number;
  points: [GalvoPoint, GalvoPoint];
}

interface GalvoPlate {
  widthMm: number;
  heightMm: number;
  mirroredHorizontally: boolean;
  paths: GalvoPath[];
}

interface GalvoOutput {
  format: string;
  units: string;
  description: string;
  interchange: { neutral: boolean; deviceWireProtocol: boolean };
  normalizedRange: [number, number];
  normalizedCoordinatesAreSupplemental: boolean;
  mirrorGlass6060: boolean;
  plates: Record<PlateId, GalvoPlate>;
}

function parsedGalvo(config: DesignConfig, geometry: LayoutGeometry): GalvoOutput {
  return JSON.parse(buildGalvoToolpaths(config, geometry)) as GalvoOutput;
}

describe("buildGalvoToolpaths", () => {
  it("emits v3 canonical paths with exact source metadata and DXF endpoint parity", () => {
    const { config, geometry, pointCodeArtwork } = fixture({
      mirrorGlass6060: true,
    });
    const raw = buildGalvoToolpaths(config, geometry);
    const output = JSON.parse(raw) as GalvoOutput;
    const dxf = dxfEntities(
      buildManufacturingDxf(config, geometry, pointCodeArtwork),
    );

    expect(output.format).toBe("w-series-dssc-galvo-toolpath-v3");
    expect(output.units).toBe("mm");
    expect(output.description).toContain("terminal-isolation");
    expect(output.interchange).toEqual({
      neutral: true,
      deviceWireProtocol: false,
    });
    expect(output.normalizedRange).toEqual([-1, 1]);
    expect(output.normalizedCoordinatesAreSupplemental).toBe(true);
    expect(raw).not.toMatch(/font|microcell/i);

    for (const plate of ["glass-6066", "glass-6060"] as const) {
      const canonical = geometry.etchPaths[plate];
      const paths = output.plates[plate].paths;
      const dxfLayer =
        plate === "glass-6066" ? "FTO_ETCH_6066" : "FTO_ETCH_6060";
      const dxfPaths = entitiesOn(dxf, dxfLayer);
      expect(paths).toHaveLength(canonical.length);
      expect(paths.filter((path) => path.source === "terminal-isolation")).toHaveLength(
        2,
      );
      expect(
        paths
          .filter((path) => path.source === "terminal-isolation")
          .map((path) => path.isolationIndex),
      ).toEqual([0, 1]);

      canonical.forEach((source, pathIndex) => {
        const path = paths[pathIndex];
        const expectedPoints = [
          platePoint(config, geometry, plate, source.start),
          platePoint(config, geometry, plate, source.end),
        ];
        expect(path.id).toBe(`${plate}-etch-${pathIndex}`);
        expect(path.source).toBe(source.source);
        expect(path.plate).toBe(source.plate);
        expect(path.widthMm).toBe(config.ftoEtchWidthMm);
        expectPointsClose(path.points, expectedPoints);
        expectPointsClose(dxfLinePoints(dxfPaths[pathIndex]), path.points);

        const sourceKeys =
          source.source === "electrode-voronoi"
            ? ["boundaryIndex", "cells"]
            : source.source === "active-perimeter"
              ? ["perimeterIndex", "pieceIndex"]
              : ["isolationIndex"];
        expect(Object.keys(path).sort()).toEqual(
          ["id", "source", "plate", "widthMm", "points", ...sourceKeys].sort(),
        );
        if (source.source === "electrode-voronoi") {
          expect(path.boundaryIndex).toBe(source.boundaryIndex);
          expect(path.cells).toEqual(source.cells);
        } else if (source.source === "active-perimeter") {
          expect(path.perimeterIndex).toBe(source.perimeterIndex);
          expect(path.pieceIndex).toBe(source.pieceIndex);
        } else {
          expect(path.isolationIndex).toBe(source.isolationIndex);
        }

        for (const point of path.points) {
          expect(point.x).toBeGreaterThanOrEqual(0);
          expect(point.x).toBeLessThanOrEqual(output.plates[plate].widthMm);
          expect(point.y).toBeGreaterThanOrEqual(0);
          expect(point.y).toBeLessThanOrEqual(output.plates[plate].heightMm);
          expect(point.normalized.x).toBeGreaterThanOrEqual(-1);
          expect(point.normalized.x).toBeLessThanOrEqual(1);
          expect(point.normalized.y).toBeGreaterThanOrEqual(-1);
          expect(point.normalized.y).toBeLessThanOrEqual(1);
        }
      });
    }
  });

  it("uses only geometry.etchPaths and is text-independent", () => {
    const { config, geometry } = fixture({
      subcellCount: 4,
      text: "SOLAR ORACLE WALKMAN",
    });
    const detachedGeometry: LayoutGeometry = {
      ...geometry,
      boundaries: [],
      activePerimeter: [],
    };

    expect(buildGalvoToolpaths(config, detachedGeometry)).toBe(
      buildGalvoToolpaths(config, geometry),
    );
    expect(buildGalvoToolpaths({ ...config, text: "    " }, geometry)).toBe(
      buildGalvoToolpaths(config, geometry),
    );
  });

  it("preserves the plate-local horizontal mirror for 6060 only", () => {
    const { config, geometry } = fixture({ mirrorGlass6060: false });
    const plain = parsedGalvo(config, geometry);
    const mirrored = parsedGalvo(
      { ...config, mirrorGlass6060: true },
      geometry,
    );

    expect(mirrored.plates["glass-6066"]).toEqual(
      plain.plates["glass-6066"],
    );
    expect(mirrored.mirrorGlass6060).toBe(true);
    expect(mirrored.plates["glass-6060"].mirroredHorizontally).toBe(true);
    plain.plates["glass-6060"].paths.forEach((path, pathIndex) => {
      path.points.forEach((point, pointIndex) => {
        const counterpart =
          mirrored.plates["glass-6060"].paths[pathIndex].points[pointIndex];
        expect(counterpart.x).toBeCloseTo(
          geometry.glass6060.width - point.x,
          10,
        );
        expect(counterpart.y).toBe(point.y);
        expect(counterpart.normalized.x).toBeCloseTo(
          -point.normalized.x,
          10,
        );
        expect(counterpart.normalized.y).toBe(point.normalized.y);
      });
    });
  });
});

describe("browser-independent export behavior", () => {
  it("keeps vector builders pure and validates PDF/TIFF dimensions before browser APIs", async () => {
    const { config, geometry, pointCodeArtwork } = fixture();
    expect(() =>
      buildManufacturingDxf(config, geometry, pointCodeArtwork),
    ).not.toThrow();
    expect(() => buildGalvoToolpaths(config, geometry)).not.toThrow();

    const invalid: SvgAsset = {
      id: "invalid",
      filename: "invalid.svg",
      title: "Invalid",
      widthMm: 0,
      heightMm: 60,
      svg: '<svg xmlns="http://www.w3.org/2000/svg"/>',
    };
    await expect(assetToPdfBlob(invalid)).rejects.toThrow(
      "page dimensions must be finite positive millimetre values",
    );
    await expect(downloadScreenTiff(invalid)).rejects.toThrow(
      "Millimetres must be a finite positive number",
    );
  });
});

describe("downloadProjectBundle", () => {
  afterEach(() => {
    vi.unstubAllGlobals();
    vi.clearAllMocks();
  });

  it("reports 16 complete-export steps before browser PDF/TIFF conversion", async () => {
    const { config, geometry, pointCodeArtwork } = fixture();
    const assets = buildFabricationAssets(config, geometry, pointCodeArtwork).map(
      (asset) =>
        asset.id === "screen-glass-6066-tio2"
          ? { ...asset, widthMm: 0 }
          : asset,
    );
    const progress: Array<[number, number]> = [];

    await expect(
      downloadProjectBundle(
        config,
        geometry,
        pointCodeArtwork,
        assets,
        true,
        (completed, total) => progress.push([completed, total]),
      ),
    ).rejects.toThrow("page dimensions must be finite positive millimetre values");

    expect(progress[0]).toEqual([0, 16]);
    expect(progress.at(-1)).toEqual([7, 16]);
  });

  it("packages the 16-file v4 vector bundle with all seven layered assets", async () => {
    const { config, geometry, pointCodeArtwork } = fixture({
      subcellCount: 4,
      text: "SOLAR ORACLE WALKMAN",
      mirrorGlass6060: true,
    });
    const assets = buildFabricationAssets(config, geometry, pointCodeArtwork);
    let downloaded: Blob | undefined;
    const anchor = {
      href: "",
      download: "",
      style: { display: "" },
      click: vi.fn(),
      remove: vi.fn(),
    };
    vi.stubGlobal("document", {
      createElement: () => anchor,
      body: { append: vi.fn() },
    });
    vi.stubGlobal("URL", {
      createObjectURL: (blob: Blob) => {
        downloaded = blob;
        return "blob:test-bundle";
      },
      revokeObjectURL: vi.fn(),
    });
    const progress: Array<[number, number, string]> = [];

    await downloadProjectBundle(
      config,
      geometry,
      pointCodeArtwork,
      assets,
      false,
      (completed, total, label) => progress.push([completed, total, label]),
    );

    expect(downloaded).toBeInstanceOf(Blob);
    const files = unzipSync(
      new Uint8Array(await (downloaded as Blob).arrayBuffer()),
    );
    const paths = Object.keys(files);
    expect(paths).toHaveLength(16);
    expect(paths.filter((path) => path.startsWith("svg-layered/"))).toHaveLength(
      7,
    );
    expect(
      paths.filter((path) => path.startsWith("svg-production/")),
    ).toHaveLength(5);
    expect(paths.some((path) => path.startsWith("bitmap-production/"))).toBe(
      false,
    );
    expect(paths.some((path) => path.endsWith(".tif"))).toBe(false);
    expect(paths.some((path) => path.endsWith(".pdf"))).toBe(false);
    expect(
      paths.filter((path) => path.startsWith("svg-production/")).sort(),
    ).toEqual(
      [
        "svg-production/binding-mask.svg",
        "svg-production/fto-etch-glass-6060.svg",
        "svg-production/fto-etch-glass-6066.svg",
        "svg-production/screen-glass-6060-tio2.svg",
        "svg-production/screen-glass-6066-tio2.svg",
      ].sort(),
    );
    expect(paths.some((path) => /surlyn/i.test(path))).toBe(false);

    const project = JSON.parse(strFromU8(files["design.json"]));
    expect(project.format).toBe("w-series-dssc-project-v4");
    expect(project.description).toContain("TiO2 regions");
    expect(project.description).toContain("Demaine-site point knockouts");
    expect(project.description).toContain("terminal-isolation");
    expect(project.config.electrodeJitter).toBe(config.electrodeJitter);
    expect(project.config.ftoEtchWidthMm).toBe(0.08);
    expect(project.config).toEqual(config);
    expect(project.pointCodeArtwork).toEqual(pointCodeArtwork);
    expect(project).not.toHaveProperty("fontArtwork");
    expect(project.config).not.toHaveProperty("electrodeGapMm");
    expect(project.config).not.toHaveProperty("surlynWidthMm");
    expect(project.config).not.toHaveProperty("fontMarginMm");
    expect(project.config).not.toHaveProperty("fontEdgeWidthMm");
    expect(project.geometry).toHaveProperty("bindingOuter");
    expect(project.geometry).toHaveProperty("bindingInner");
    expect(project.geometry).not.toHaveProperty("surlynOuter");
    expect(project.geometry).not.toHaveProperty("surlynInner");
    expect(JSON.stringify(project)).not.toMatch(
      /fontArtwork|fontMarginMm|fontEdgeWidthMm|surlyn|electrodeGapMm/i,
    );
    for (const plate of ["glass-6066", "glass-6060"] as const) {
      expect(
        project.geometry.etchPaths[plate].filter(
          (path: EtchPath) => path.source === "terminal-isolation",
        ),
      ).toHaveLength(2);
    }

    const production6066 = strFromU8(
      files["svg-production/screen-glass-6066-tio2.svg"],
    );
    const production6060 = strFromU8(
      files["svg-production/screen-glass-6060-tio2.svg"],
    );
    expect(production6066).toBe(
      assetById(assets, "screen-glass-6066-tio2").svg,
    );
    expect(production6060).toBe(
      assetById(assets, "screen-glass-6060-tio2").svg,
    );
    const regions6066 = svgPathElements(
      svgGroupContents(production6066, "SCREEN_6066_TIO2_REGIONS"),
    );
    const regions6060 = svgPathElements(
      svgGroupContents(production6060, "SCREEN_6060_TIO2_REGIONS"),
    );
    expect(regions6066).toHaveLength(
      usableScreenRegions(config, geometry, "glass-6066").length,
    );
    expect(regions6060).toHaveLength(
      usableScreenRegions(config, geometry, "glass-6060").length,
    );
    expect(
      regions6066.every(
        (path) => svgAttribute(path, "data-material") === "tio2",
      ),
    ).toBe(true);
    expect(
      regions6060.every(
        (path) => svgAttribute(path, "data-material") === "tio2",
      ),
    ).toBe(true);
    expect(production6066).toContain('fill="#000000"');
    expect(production6060).toContain('fill="#000000"');
    expect(production6066).toContain('id="SCREEN_POINT_CODE_KNOCKOUTS"');
    expect(production6060).toContain('id="SCREEN_POINT_CODE_KNOCKOUTS"');
    expect(production6066).not.toMatch(/GUIDES_NON_PRINTING|FONT_/);
    expect(production6060).not.toMatch(/GUIDES_NON_PRINTING|FONT_/);

    for (const filename of [
      "fto-etch-glass-6066.svg",
      "fto-etch-glass-6060.svg",
    ]) {
      const etch = strFromU8(files[`svg-production/${filename}`]);
      expect(etch).not.toContain("GUIDES_NON_PRINTING");
      expect(etch).not.toMatch(/font|microcell|data-slot|data-site|glyph/i);
      expect(etch).toContain("terminal-isolation");
    }
    expect(strFromU8(files["svg-production/binding-mask.svg"])).toContain(
      'id="BINDING_MASK"',
    );

    const readme = strFromU8(files["README.txt"]);
    for (const statement of [
      "串聯電路材料配置",
      "頂層 TiO2 region mask",
      "bindingWidthMm/2",
      "Demaine-site point knockout",
      "固定半徑 0.03 mm、直徑 0.06 mm",
      "最小圓心間距為 0.07 mm",
      "0.01 mm 最小邊緣間隙",
      "radius 0.03 mm, diameter 0.06 mm",
      "minimum site center-to-center spacing is 0.07 mm",
      "0.01 mm edge-to-edge gap",
      "少於三個頂點",
      "validatePointCodeArtwork",
      "blocking error",
      "不是可閱讀字樣",
      "也不是文字負片",
      "1-bit、1200 DPI TIFF",
      "6060 玻璃製造檔水平鏡射：是",
      "zebra 外露接觸條涵蓋玻璃完整高度",
      "完整跨度",
      "terminal-isolation",
      "每片恰好兩條",
      "geometry.etchPaths",
      "binding-mask",
      `bindingWidthMm = ${String(config.bindingWidthMm)} mm`,
      `electrodeJitter = ${String(config.electrodeJitter)}（允許上限 2）`,
      "ftoEtchWidthMm = 0.08 mm（預設 0.08 mm）",
      "pointCodeArtwork",
      "七個完整分層 SVG",
      "校正警告",
    ]) {
      expect(readme).toContain(statement);
    }
    expect(readme).not.toMatch(
      /Dye1|Dye2|glyph|background operation|font-voronoi|字型微胞|文字微胞/i,
    );
    const manufacturingDxf = strFromU8(files["manufacturing-layout.dxf"]);
    expect(manufacturingDxf).toContain("BINDING");
    expect(manufacturingDxf).toContain("SCREEN_6066_POINT_KNOCKOUTS");
    expect(manufacturingDxf).not.toMatch(
      /FONT_VORONOI_REFERENCE|FONT_SITES_REFERENCE/,
    );
    expect(JSON.parse(strFromU8(files["fto-galvo-toolpaths.json"])).format).toBe(
      "w-series-dssc-galvo-toolpath-v3",
    );

    expect(progress[0].slice(0, 2)).toEqual([0, 8]);
    expect(progress.at(-1)?.slice(0, 2)).toEqual([8, 8]);
    expect(anchor.download).toBe("w-series-dssc-project.zip");
    expect(anchor.click).toHaveBeenCalledOnce();
  });

  it("packages exactly 24 files in the complete PDF and TIFF bundle", async () => {
    const { config, geometry, pointCodeArtwork } = fixture();
    const assets = buildFabricationAssets(config, geometry, pointCodeArtwork);
    let downloaded: Blob | undefined;
    const anchor = {
      href: "",
      download: "",
      style: { display: "" },
      click: vi.fn(),
      remove: vi.fn(),
    };
    class MockSvgElement {
      localName = "svg";
      namespaceURI = "http://www.w3.org/2000/svg";
      setAttribute(): void {}
    }
    class MockDomParser {
      parseFromString(): Document {
        return {
          querySelector: () => null,
          documentElement: new MockSvgElement(),
        } as unknown as Document;
      }
    }
    vi.stubGlobal("DOMParser", MockDomParser);
    vi.stubGlobal("document", {
      createElement: () => anchor,
      body: { append: vi.fn() },
    });
    vi.stubGlobal("URL", {
      createObjectURL: (blob: Blob) => {
        downloaded = blob;
        return "blob:test-complete-bundle";
      },
      revokeObjectURL: vi.fn(),
    });
    vi.mocked(svgAssetToBilevelTiffBlob)
      .mockResolvedValueOnce(new Blob(["mock-6066-tiff"], { type: "image/tiff" }))
      .mockResolvedValueOnce(new Blob(["mock-6060-tiff"], { type: "image/tiff" }));
    const progress: Array<[number, number]> = [];

    await downloadProjectBundle(
      config,
      geometry,
      pointCodeArtwork,
      assets,
      true,
      (completed, total) => progress.push([completed, total]),
    );

    const files = unzipSync(
      new Uint8Array(await (downloaded as Blob).arrayBuffer()),
    );
    const paths = Object.keys(files);
    expect(paths).toHaveLength(24);
    expect(paths.filter((path) => path.startsWith("svg-layered/"))).toHaveLength(
      7,
    );
    expect(
      paths.filter((path) => path.startsWith("svg-production/")),
    ).toHaveLength(5);
    expect(paths.filter((path) => path.endsWith(".pdf"))).toHaveLength(6);
    expect(
      paths.filter((path) => path.startsWith("bitmap-production/")).sort(),
    ).toEqual(
      [
        "bitmap-production/screen-glass-6060-tio2-1bit-1200dpi.tif",
        "bitmap-production/screen-glass-6066-tio2-1bit-1200dpi.tif",
      ].sort(),
    );
    expect(paths.filter((path) => !path.includes("/")).sort()).toEqual(
      [
        "README.txt",
        "design.json",
        "fto-galvo-toolpaths.json",
        "manufacturing-layout.dxf",
      ].sort(),
    );
    expect(progress[0]).toEqual([0, 16]);
    expect(progress.at(-1)).toEqual([16, 16]);
    expect(anchor.click).toHaveBeenCalledOnce();
  });
});
