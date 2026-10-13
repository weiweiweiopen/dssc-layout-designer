import { describe, expect, it } from "vitest";

import { buildGeometry, pointInConvexPolygon } from "./geometry";
import {
  DEFAULT_CONFIG,
  POINT_CODE_MIN_GAP_MM,
  POINT_CODE_RADIUS_MM,
  type DesignConfig,
  type LayoutGeometry,
  type PlateId,
  type Point,
  type PointCodeArtwork,
  type PreviewMode,
} from "./model";
import { buildPointCodeArtwork, insetConvexPolygon } from "./point-code";
import {
  buildFabricationAssets,
  buildPreviewSvg,
  CIRCUIT_PANEL_GAP_MM,
  previewSize,
  type SvgAsset,
} from "./svg";

function design(overrides: Partial<DesignConfig> = {}): DesignConfig {
  return { ...DEFAULT_CONFIG, ...overrides };
}

function fixture(overrides: Partial<DesignConfig> = {}): {
  config: DesignConfig;
  geometry: LayoutGeometry;
  pointCodes: PointCodeArtwork;
  assets: SvgAsset[];
} {
  const config = design(overrides);
  const geometry = buildGeometry(config);
  const pointCodes = buildPointCodeArtwork(config, geometry);
  return {
    config,
    geometry,
    pointCodes,
    assets: buildFabricationAssets(config, geometry, pointCodes),
  };
}

function assetById(assets: SvgAsset[], id: string): SvgAsset {
  const asset = assets.find((candidate) => candidate.id === id);
  expect(asset, `missing asset ${id}`).toBeDefined();
  return asset as SvgAsset;
}

function groupOpening(svg: string, id: string): string {
  const match = svg.match(new RegExp(`<g\\b[^>]*\\sid="${id}"[^>]*>`));
  expect(match, `missing SVG group ${id}`).not.toBeNull();
  return match?.[0] ?? "";
}

function groupContents(svg: string, id: string): string {
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

function elements(content: string, tag: string): string[] {
  return (
    content.match(
      new RegExp(`<${tag}\\b[^>]*?(?:/>|>[\\s\\S]*?</${tag}>)`, "g"),
    ) ?? []
  );
}

function pathElements(content: string): string[] {
  return elements(content, "path");
}

function rectElements(content: string): string[] {
  return elements(content, "rect");
}

function circleElements(content: string): string[] {
  return elements(content, "circle");
}

function textElements(content: string): string[] {
  return elements(content, "text");
}

function attribute(element: string, name: string): string {
  return element.match(new RegExp(`\\s${name}="([^"]*)"`))?.[1] ?? "";
}

function textContent(element: string): string {
  return element.match(/<text\b[^>]*>([\s\S]*?)<\/text>/)?.[1] ?? "";
}

function pointsFromPathData(data: string): Point[] {
  const values =
    data.match(/-?(?:\d+\.?\d*|\.\d+)(?:e[+-]?\d+)?/gi)?.map(Number) ?? [];
  const points: Point[] = [];
  for (let index = 0; index < values.length; index += 2) {
    points.push({ x: values[index], y: values[index + 1] });
  }
  return points;
}

function pathPoints(element: string): Point[] {
  return pointsFromPathData(attribute(element, "d"));
}

function pathLoops(element: string): Point[][] {
  return attribute(element, "d")
    .split(/(?=M\s)/)
    .filter((part) => part.startsWith("M"))
    .map(pointsFromPathData);
}

function expectPointsClose(actual: Point[], expected: Point[]): void {
  expect(actual).toHaveLength(expected.length);
  actual.forEach((point, index) => {
    expect(point.x).toBeCloseTo(expected[index].x, 7);
    expect(point.y).toBeCloseTo(expected[index].y, 7);
  });
}

function mappedPlatePoint(
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

function selectedCells(geometry: LayoutGeometry, plate: PlateId) {
  return geometry.cells.filter((cell) =>
    plate === "glass-6066"
      ? cell.glass6066Material === "tio2"
      : cell.glass6060Material === "tio2",
  );
}

function expectedScreenRegions(
  config: DesignConfig,
  geometry: LayoutGeometry,
  plate: PlateId,
) {
  const bindingWidth = Number.isFinite(config.bindingWidthMm)
    ? Math.max(0, config.bindingWidthMm)
    : 0;
  return selectedCells(geometry, plate).flatMap((cell) => {
    const polygon = insetConvexPolygon(
      cell.polygon,
      bindingWidth / 2,
    );
    return polygon.length >= 3 ? [{ cell, polygon }] : [];
  });
}

function expectedKnockouts(
  config: DesignConfig,
  geometry: LayoutGeometry,
  pointCodes: PointCodeArtwork,
  plate: PlateId,
) {
  const indexes = new Set(
    expectedScreenRegions(config, geometry, plate).map(({ cell }) => cell.index),
  );
  return pointCodes.placements.flatMap((placement) =>
    placement.character === " " || !indexes.has(placement.subcellIndex)
      ? []
      : placement.sites.map((site, siteIndex) => ({
          id: `cell-${placement.subcellIndex}-slot-${placement.slotIndex}-site-${siteIndex}`,
          point: mappedPlatePoint(config, geometry, plate, site),
          subcellIndex: placement.subcellIndex,
          slotIndex: placement.slotIndex,
        })),
  );
}

function hexColors(svg: string): string[] {
  return [...new Set(svg.match(/#[0-9a-f]{6}/gi) ?? [])].sort();
}

function expectGrayscale(svg: string): void {
  for (const color of hexColors(svg)) {
    expect(color.slice(1, 3)).toBe(color.slice(3, 5));
    expect(color.slice(3, 5)).toBe(color.slice(5, 7));
  }
}

describe("fabrication assets and preview dimensions", () => {
  it("returns exactly seven layered assets with exact millimetre roots", () => {
    const { assets } = fixture();
    const expected: Array<[string, string, number, number]> = [
      ["screen-glass-6066-tio2", "screen-glass-6066-tio2.svg", 66, 60],
      ["screen-glass-6060-tio2", "screen-glass-6060-tio2.svg", 60, 60],
      ["assembly-preview", "assembly-preview.svg", 66, 60],
      ["circuit-reference", "circuit-reference.svg", 134, 60],
      ["fto-etch-glass-6066", "fto-etch-glass-6066.svg", 66, 60],
      ["fto-etch-glass-6060", "fto-etch-glass-6060.svg", 60, 60],
      ["binding-mask", "binding-mask.svg", 66, 60],
    ];

    expect(assets).toHaveLength(7);
    expect(
      assets.map(({ id, filename, widthMm, heightMm }) => [
        id,
        filename,
        widthMm,
        heightMm,
      ]),
    ).toEqual(expected);
    assets.forEach((asset) => {
      expect(asset.svg).toContain(`width="${asset.widthMm}mm"`);
      expect(asset.svg).toContain(`height="${asset.heightMm}mm"`);
      expect(asset.svg).toContain(
        `viewBox="0 0 ${asset.widthMm} ${asset.heightMm}"`,
      );
      expect(asset.svg).not.toContain("stroke-dasharray");
      expect(asset.svg).not.toMatch(/FONT_|font-voronoi|glyph|microcell/i);
      expectGrayscale(asset.svg);
    });
    expect(assets.map(({ id }) => id)).not.toContain("font-voronoi-reference");
  });

  it("reports seven view sizes, preserves the circuit gap, and rejects the removed view", () => {
    const { config, geometry, pointCodes } = fixture({
      glass6066WidthMm: 70,
      glass6066HeightMm: 64,
      glass6060WidthMm: 58,
      glass6060HeightMm: 54,
    });

    expect(CIRCUIT_PANEL_GAP_MM).toBe(8);
    expect(previewSize(geometry, "circuit")).toEqual({
      widthMm: 136,
      heightMm: 64,
    });
    for (const mode of [
      "assembly",
      "glass-6066",
      "etch-6066",
      "binding",
    ] as const) {
      expect(previewSize(geometry, mode)).toEqual({ widthMm: 70, heightMm: 64 });
    }
    for (const mode of ["glass-6060", "etch-6060"] as const) {
      expect(previewSize(geometry, mode)).toEqual({ widthMm: 58, heightMm: 54 });
    }
    expect(() => previewSize(geometry, "font" as PreviewMode)).toThrow(
      "Unsupported preview mode",
    );
    expect(() =>
      buildPreviewSvg(config, geometry, pointCodes, "font" as PreviewMode),
    ).toThrow("Unsupported preview mode");
  });
});

describe("assembly and circuit references", () => {
  it("renders only top-level 6066 material blocks in the final assembly", () => {
    const { config, geometry, pointCodes } = fixture();
    const assembly = buildPreviewSvg(config, geometry, pointCodes, "assembly");
    const cells = pathElements(
      groupContents(assembly, "ASSEMBLY_CIRCUIT_MATERIAL_CELLS"),
    );

    expect(cells).toHaveLength(geometry.cells.length);
    cells.forEach((path, index) => {
      const cell = geometry.cells[index];
      expect(attribute(path, "data-subcell-index")).toBe(String(cell.index));
      expect(attribute(path, "data-material")).toBe(cell.glass6066Material);
      expectPointsClose(
        pathPoints(path),
        cell.polygon.slice(0, -1).map((point) => assemblyPoint(geometry, point)),
      );
    });
    const fills = new Set(cells.map((path) => attribute(path, "fill")));
    expect(fills.size).toBe(2);
    expect(assembly).not.toMatch(
      /POINT_CODE|ELECTRON_ROUTE|GUIDES_NON_PRINTING|FTO_ETCH|BINDING_MASK/,
    );
    expect(assembly).not.toContain("<circle");
    expect(assembly).not.toMatch(/<text\b/);
    expect(assembly).not.toContain("stroke-width");
    expectGrayscale(assembly);
  });

  it("keeps both true-size circuit plates, material blocks, contacts, labels, and solid routes", () => {
    const { config, geometry, pointCodes } = fixture();
    const circuit = buildPreviewSvg(config, geometry, pointCodes, "circuit");
    const panel6066 = groupContents(circuit, "CIRCUIT_PLATE_6066");
    const panel6060 = groupContents(circuit, "CIRCUIT_PLATE_6060");
    const outline6066 = rectElements(panel6066).find((element) =>
      element.includes('id="CIRCUIT_6066_PLATE_OUTLINE"'),
    );
    const outline6060 = rectElements(panel6060).find((element) =>
      element.includes('id="CIRCUIT_6060_PLATE_OUTLINE"'),
    );

    expect(circuit).toContain('viewBox="0 0 134 60"');
    expect(Number(attribute(outline6066 ?? "", "width"))).toBe(66);
    expect(Number(attribute(outline6066 ?? "", "height"))).toBe(60);
    expect(Number(attribute(outline6060 ?? "", "x"))).toBe(74);
    expect(Number(attribute(outline6060 ?? "", "width"))).toBe(60);
    expect(attribute(outline6066 ?? "", "stroke-width")).toBe("0.06");
    expect(attribute(outline6060 ?? "", "stroke-width")).toBe("0.06");

    for (const [suffix, plate] of [
      ["6066", "glass-6066"],
      ["6060", "glass-6060"],
    ] as const) {
      const cells = pathElements(
        groupContents(circuit, `CIRCUIT_${suffix}_MATERIAL_CELLS`),
      );
      const labels = textElements(
        groupContents(circuit, `CIRCUIT_${suffix}_ORDER_LABELS`),
      );
      const routeOpening = groupOpening(circuit, `ELECTRON_ROUTE_${suffix}`);
      const route = pathElements(
        groupContents(circuit, `ELECTRON_ROUTE_${suffix}`),
      );

      expect(cells).toHaveLength(geometry.cells.length);
      expect(cells.every((path) => attribute(path, "stroke-width") === "0.06")).toBe(
        true,
      );
      expect(cells.map((path) => attribute(path, "data-material"))).toEqual(
        geometry.cells.map((cell) =>
          plate === "glass-6066"
            ? cell.glass6066Material
            : cell.glass6060Material,
        ),
      );
      expect(labels.map(textContent)).toEqual(
        geometry.cells.map(({ index }) => String(index + 1)),
      );
      expect(attribute(routeOpening, "stroke-width")).toBe("0.1");
      expect(route).toHaveLength(1);

      const routeSource =
        plate === "glass-6066"
          ? geometry.electronPath
          : geometry.cells.map(({ site }) => site);
      const originX = plate === "glass-6066" ? 0 : 74;
      expectPointsClose(
        pathPoints(route[0]),
        routeSource.map((point) => {
          const local = mappedPlatePoint(config, geometry, plate, point);
          return { x: local.x + originX, y: local.y };
        }),
      );
    }

    const contacts = rectElements(
      groupContents(circuit, "CIRCUIT_6066_CONTACT_STRIPS"),
    );
    expect(contacts).toHaveLength(2);
    expect(contacts.every((contact) => attribute(contact, "stroke-width") === "0.06")).toBe(
      true,
    );
    contacts.forEach((contact, index) => {
      expect(Number(attribute(contact, "height"))).toBe(
        geometry.terminals[index].contactStrip.height,
      );
    });

    const widths = [...circuit.matchAll(/\sstroke-width="([^"]+)"/g)].map(
      (match) => Number(match[1]),
    );
    expect(widths.filter((width) => width === 0.1)).toHaveLength(2);
    expect(widths.filter((width) => width !== 0.1).every((width) => width === 0.06)).toBe(
      true,
    );
    expect(circuit).not.toContain("stroke-dasharray");
    expect(circuit).not.toContain("<circle");
    expect(circuit).not.toMatch(/POINT_CODE|glyph|microcell/i);
    expectGrayscale(circuit);
  });
});

describe("binary TiO2 screen pages", () => {
  it("selects plate materials and emits fixed-radius mirrored point-code knockouts", () => {
    const { config, geometry, pointCodes, assets } = fixture({
      bindingWidthMm: 2.4,
      mirrorGlass6060: true,
    });
    const screen6066 = assetById(assets, "screen-glass-6066-tio2").svg;
    const screen6060 = assetById(assets, "screen-glass-6060-tio2").svg;
    let totalKnockouts = 0;

    expect(POINT_CODE_RADIUS_MM).toBe(0.03);
    for (const [screen, plate, suffix] of [
      [screen6066, "glass-6066", "6066"],
      [screen6060, "glass-6060", "6060"],
    ] as const) {
      const regions = pathElements(
        groupContents(screen, `SCREEN_${suffix}_TIO2_REGIONS`),
      );
      const selected = expectedScreenRegions(config, geometry, plate);
      const safeRegions = new Map(
        selected.map(({ cell, polygon }) => [
          cell.index,
          insetConvexPolygon(polygon, POINT_CODE_RADIUS_MM),
        ]),
      );
      const circles = circleElements(
        groupContents(screen, "SCREEN_POINT_CODE_KNOCKOUTS"),
      );
      const expectedCircles = expectedKnockouts(
        config,
        geometry,
        pointCodes,
        plate,
      );
      const page = rectElements(screen).find((rect) =>
        rect.includes('id="SCREEN_PAGE_WHITE"'),
      );

      expect(attribute(page ?? "", "fill")).toBe("#ffffff");
      expect(attribute(groupOpening(screen, `SCREEN_${suffix}_TIO2_REGIONS`), "fill")).toBe(
        "#000000",
      );
      expect(attribute(groupOpening(screen, "SCREEN_POINT_CODE_KNOCKOUTS"), "fill")).toBe(
        "#ffffff",
      );
      expect(regions).toHaveLength(selected.length);
      regions.forEach((path, index) => {
        const { cell, polygon } = selected[index];
        expect(attribute(path, "data-region-id")).toBe(
          `screen-${suffix}-cell-${cell.index}`,
        );
        expect(attribute(path, "data-material")).toBe("tio2");
        expect(pathLoops(path)).toHaveLength(1);
        expectPointsClose(
          pathPoints(path),
          polygon.map((point) =>
            mappedPlatePoint(config, geometry, plate, point),
          ),
        );
      });

      expect(circles).toHaveLength(expectedCircles.length);
      circles.forEach((circle, index) => {
        const expected = expectedCircles[index];
        const center = {
          x: Number(attribute(circle, "cx")),
          y: Number(attribute(circle, "cy")),
        };
        const safeRegion = safeRegions.get(expected.subcellIndex) ?? [];
        expect(attribute(circle, "id")).toBe(expected.id);
        expect(attribute(circle, "data-region-id")).toBe(expected.id);
        expect(attribute(circle, "r")).toBe("0.03");
        expect(center.x).toBeCloseTo(expected.point.x, 7);
        expect(center.y).toBeCloseTo(expected.point.y, 7);
        expect(safeRegion.length).toBeGreaterThanOrEqual(3);
        expect(
          pointInConvexPolygon(
            center,
            safeRegion.map((point) =>
              mappedPlatePoint(config, geometry, plate, point),
            ),
          ),
        ).toBe(true);
      });
      totalKnockouts += circles.length;

      const spaceSlots = new Set(
        pointCodes.placements
          .filter(({ character }) => character === " ")
          .map(({ slotIndex }) => String(slotIndex)),
      );
      expect(
        circles.every((circle) => !spaceSlots.has(attribute(circle, "data-slot-index"))),
      ).toBe(true);
      expect(hexColors(screen)).toEqual(["#000000", "#ffffff"]);
      expect(screen).not.toMatch(/<text\b|\sstroke(?:-width)?=|fill-rule/i);
      expect(screen).not.toMatch(/glyph|microcell|slot-outline|FONT_/i);
    }

    expect(screen6060).toContain('data-mirrored="true"');
    expect(selectedCells(geometry, "glass-6066").map(({ index }) => index)).toEqual(
      geometry.cells.filter(({ index }) => index % 2 === 0).map(({ index }) => index),
    );
    expect(selectedCells(geometry, "glass-6060").map(({ index }) => index)).toEqual(
      geometry.cells.filter(({ index }) => index % 2 === 1).map(({ index }) => index),
    );
    expect(totalKnockouts).toBe(
      pointCodes.placements.reduce(
        (total, placement) => total + placement.sites.length,
        0,
      ),
    );

    const sites = pointCodes.placements.flatMap((placement) => placement.sites);
    const minimumDistance = POINT_CODE_RADIUS_MM * 2 + POINT_CODE_MIN_GAP_MM;
    expect(minimumDistance).toBeCloseTo(0.07, 12);
    for (let first = 0; first < sites.length; first += 1) {
      for (let second = first + 1; second < sites.length; second += 1) {
        expect(
          Math.hypot(
            sites[first].x - sites[second].x,
            sites[first].y - sites[second].y,
          ),
        ).toBeGreaterThanOrEqual(minimumDistance - 1e-9);
      }
    }
  });

  it("omits collapsed canonical insets without microscopic fallback regions", () => {
    const config = design({ subcellCount: 64, bindingWidthMm: 5 });
    const geometry = buildGeometry(config);
    const pointCodes = buildPointCodeArtwork(config, geometry);
    const assets = buildFabricationAssets(config, geometry, pointCodes);
    let collapsedCount = 0;

    for (const [id, plate, suffix] of [
      ["screen-glass-6066-tio2", "glass-6066", "6066"],
      ["screen-glass-6060-tio2", "glass-6060", "6060"],
    ] as const) {
      const screen = assetById(assets, id).svg;
      const regionContent = groupContents(
        screen,
        `SCREEN_${suffix}_TIO2_REGIONS`,
      );
      const regions = pathElements(regionContent);
      const selected = selectedCells(geometry, plate);
      const expected = expectedScreenRegions(config, geometry, plate);
      const expectedIds = expected.map(
        ({ cell }) => `screen-${suffix}-cell-${cell.index}`,
      );
      const collapsed = selected.filter(
        (cell) =>
          insetConvexPolygon(cell.polygon, config.bindingWidthMm / 2).length < 3,
      );

      expect(regions).toHaveLength(expected.length);
      expect(regions.map((path) => attribute(path, "data-region-id"))).toEqual(
        expectedIds,
      );
      regions.forEach((path, index) => {
        expectPointsClose(
          pathPoints(path),
          expected[index].polygon.map((point) =>
            mappedPlatePoint(config, geometry, plate, point),
          ),
        );
      });
      collapsed.forEach((cell) => {
        expect(regionContent).not.toContain(
          `data-region-id="screen-${suffix}-cell-${cell.index}"`,
        );
      });
      const collapsedIndexes = new Set(collapsed.map(({ index }) => String(index)));
      expect(
        circleElements(
          groupContents(screen, "SCREEN_POINT_CODE_KNOCKOUTS"),
        ).every(
          (circle) =>
            !collapsedIndexes.has(attribute(circle, "data-subcell-index")),
        ),
      ).toBe(true);
      collapsedCount += collapsed.length;
    }

    expect(collapsedCount).toBeGreaterThan(0);
  });

  it("changes only knockout positions when text changes and leaves spaces empty", () => {
    const first = fixture({ text: "SOLAR ORACLE WALKMAN" });
    const replacementText = Array.from(first.config.text)
      .map((character) =>
        character === " " ? " " : String.fromCharCode(character.charCodeAt(0) + 1),
      )
      .join("");
    const replacementConfig = { ...first.config, text: replacementText };
    const replacementCodes = buildPointCodeArtwork(
      replacementConfig,
      first.geometry,
    );
    const replacementAssets = buildFabricationAssets(
      replacementConfig,
      first.geometry,
      replacementCodes,
    );
    const spaces = " ".repeat(first.config.text.length);
    const spacesConfig = { ...first.config, text: spaces };
    const spacesCodes = buildPointCodeArtwork(spacesConfig, first.geometry);
    const spacesAssets = buildFabricationAssets(
      spacesConfig,
      first.geometry,
      spacesCodes,
    );

    for (const [id, suffix] of [
      ["screen-glass-6066-tio2", "6066"],
      ["screen-glass-6060-tio2", "6060"],
    ] as const) {
      const original = assetById(first.assets, id).svg;
      const replacement = assetById(replacementAssets, id).svg;
      const spacesScreen = assetById(spacesAssets, id).svg;

      expect(groupContents(replacement, `SCREEN_${suffix}_TIO2_REGIONS`)).toBe(
        groupContents(original, `SCREEN_${suffix}_TIO2_REGIONS`),
      );
      expect(groupContents(spacesScreen, `SCREEN_${suffix}_TIO2_REGIONS`)).toBe(
        groupContents(original, `SCREEN_${suffix}_TIO2_REGIONS`),
      );
      expect(groupContents(replacement, "SCREEN_POINT_CODE_KNOCKOUTS")).not.toBe(
        groupContents(original, "SCREEN_POINT_CODE_KNOCKOUTS"),
      );
      expect(
        circleElements(groupContents(spacesScreen, "SCREEN_POINT_CODE_KNOCKOUTS")),
      ).toHaveLength(0);
    }
  });
});

describe("canonical etch views", () => {
  it("emits geometry.etchPaths exactly with 0.06 mm solid guides", () => {
    const { config, geometry, pointCodes } = fixture({ ftoEtchWidthMm: 0.33 });

    for (const [mode, plate, suffix] of [
      ["etch-6066", "glass-6066", "6066"],
      ["etch-6060", "glass-6060", "6060"],
    ] as const) {
      const svg = buildPreviewSvg(config, geometry, pointCodes, mode);
      const operativeOpening = groupOpening(svg, `FTO_ETCH_${suffix}`);
      const operative = pathElements(groupContents(svg, `FTO_ETCH_${suffix}`));
      const canonical = geometry.etchPaths[plate];
      const guides = groupContents(svg, "GUIDES_NON_PRINTING");
      const guideWidths = [...guides.matchAll(/\sstroke-width="([^"]+)"/g)].map(
        (match) => Number(match[1]),
      );

      expect(attribute(operativeOpening, "stroke-width")).toBe("0.33");
      expect(operative).toHaveLength(canonical.length);
      operative.forEach((path, index) => {
        const source = canonical[index];
        expect(attribute(path, "data-path-index")).toBe(String(index));
        expect(attribute(path, "data-source")).toBe(source.source);
        expect(attribute(path, "data-plate")).toBe(source.plate);
        expectPointsClose(pathPoints(path), [
          mappedPlatePoint(config, geometry, plate, source.start),
          mappedPlatePoint(config, geometry, plate, source.end),
        ]);
        if (source.source === "electrode-voronoi") {
          expect(attribute(path, "data-boundary-index")).toBe(
            String(source.boundaryIndex),
          );
          expect(attribute(path, "data-cells")).toBe(source.cells?.join(","));
        } else if (source.source === "active-perimeter") {
          expect(attribute(path, "data-perimeter-index")).toBe(
            String(source.perimeterIndex),
          );
          expect(attribute(path, "data-piece-index")).toBe(
            String(source.pieceIndex),
          );
        } else {
          expect(attribute(path, "data-isolation-index")).toBe(
            String(source.isolationIndex),
          );
        }
      });
      expect(
        operative.filter(
          (path) => attribute(path, "data-source") === "terminal-isolation",
        ),
      ).toHaveLength(2);
      expect(guideWidths.length).toBeGreaterThan(0);
      expect(guideWidths.every((width) => width === 0.06)).toBe(true);
      expect(svg).not.toContain("stroke-dasharray");
      expect(svg).not.toContain("<circle");
      expect(svg).not.toMatch(/glyph|microcell|FONT_/i);
      expectGrayscale(svg);
    }
  });

  it("keeps full-height 6066 connectivity guides and no terminal guides on 6060", () => {
    const { config, geometry, pointCodes } = fixture();
    const etch6066 = buildPreviewSvg(config, geometry, pointCodes, "etch-6066");
    const etch6060 = buildPreviewSvg(config, geometry, pointCodes, "etch-6060");
    const connectivity = groupContents(
      etch6066,
      "ETCH_6066_TERMINAL_CONNECTIVITY_GUIDE",
    );
    const strips = rectElements(connectivity);
    const corridors = pathElements(connectivity).filter((path) =>
      attribute(path, "data-region-id").endsWith("corridor-guide"),
    );
    const gates = pathElements(connectivity).filter((path) =>
      attribute(path, "data-region-id").endsWith("gate-guide"),
    );

    expect(strips).toHaveLength(2);
    expect(corridors).toHaveLength(2);
    expect(gates).toHaveLength(2);
    strips.forEach((strip, index) => {
      expect(Number(attribute(strip, "height"))).toBe(
        geometry.terminals[index].contactStrip.height,
      );
      expect(attribute(strip, "stroke-width")).toBe("0.06");
    });
    expect(corridors.every((path) => attribute(path, "stroke-width") === "0.06")).toBe(
      true,
    );
    expect(gates.every((path) => attribute(path, "stroke-width") === "0.06")).toBe(
      true,
    );
    expect(etch6060).not.toMatch(
      /TERMINAL_CONNECTIVITY|corridor-guide|gate-guide|strip-guide/,
    );
  });
});

describe("binding mask", () => {
  it("uses the exact binding ring and every geometry.boundaries centerline", () => {
    const { config, geometry, pointCodes, assets } = fixture({ bindingWidthMm: 4 });
    const binding = buildPreviewSvg(config, geometry, pointCodes, "binding");
    const asset = assetById(assets, "binding-mask");
    const mask = groupContents(binding, "BINDING_MASK");
    const paths = pathElements(mask);
    const ring = paths.find(
      (path) => attribute(path, "data-region-id") === "binding-outer-ring",
    );
    const boundaries = paths.filter((path) =>
      attribute(path, "data-region-id").startsWith("binding-intercell-"),
    );
    const boundaryGroup = mask.match(
      /<g\s+fill="none"[^>]*clip-path="url\(#BINDING_ACTIVE_CLIP\)"[^>]*>/,
    )?.[0];

    expect(asset.filename).toBe("binding-mask.svg");
    expect(paths).toHaveLength(geometry.boundaries.length + 1);
    expect(ring).toBeDefined();
    expect(attribute(ring ?? "", "fill-rule")).toBe("evenodd");
    expect(pathLoops(ring ?? "")).toHaveLength(2);
    expectPointsClose(
      pathLoops(ring ?? "")[0],
      [
        { x: geometry.bindingOuter.x, y: geometry.bindingOuter.y },
        {
          x: geometry.bindingOuter.x + geometry.bindingOuter.width,
          y: geometry.bindingOuter.y,
        },
        {
          x: geometry.bindingOuter.x + geometry.bindingOuter.width,
          y: geometry.bindingOuter.y + geometry.bindingOuter.height,
        },
        {
          x: geometry.bindingOuter.x,
          y: geometry.bindingOuter.y + geometry.bindingOuter.height,
        },
      ].map((point) => assemblyPoint(geometry, point)),
    );
    expectPointsClose(
      pathLoops(ring ?? "")[1],
      [
        { x: geometry.bindingInner.x, y: geometry.bindingInner.y },
        {
          x: geometry.bindingInner.x + geometry.bindingInner.width,
          y: geometry.bindingInner.y,
        },
        {
          x: geometry.bindingInner.x + geometry.bindingInner.width,
          y: geometry.bindingInner.y + geometry.bindingInner.height,
        },
        {
          x: geometry.bindingInner.x,
          y: geometry.bindingInner.y + geometry.bindingInner.height,
        },
      ].map((point) => assemblyPoint(geometry, point)),
    );
    expect(boundaries).toHaveLength(geometry.boundaries.length);
    boundaries.forEach((path, index) => {
      expect(attribute(path, "data-boundary-index")).toBe(String(index));
      expect(attribute(path, "data-cells")).toBe(
        geometry.boundaries[index].cells.join(","),
      );
      expectPointsClose(
        pathPoints(path),
        [geometry.boundaries[index].start, geometry.boundaries[index].end].map(
          (point) => assemblyPoint(geometry, point),
        ),
      );
    });
    expect(attribute(boundaryGroup ?? "", "stroke-width")).toBe("4");
    expect(binding).not.toContain("stroke-dasharray");
    expect(binding).not.toMatch(/GUIDES_NON_PRINTING|ELECTRON_ROUTE|<text\b|<circle/);
    expect(hexColors(binding)).toEqual(["#000000", "#ffffff"]);
  });
});
