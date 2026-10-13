import { describe, expect, it } from "vitest";

import {
  buildPointCodeArtwork,
  insetConvexPolygon,
  mapUnitPointToConvexPolygon,
  partitionConvexPolygonRowMajor,
  validatePointCodeArtwork,
} from "./point-code";
import { buildGeometry } from "./geometry";
import {
  DEFAULT_CONFIG,
  POINT_CODE_MIN_GAP_MM,
  POINT_CODE_RADIUS_MM,
  type DesignConfig,
  type LayoutGeometry,
  type Point,
  type PointCodeArtwork,
  type PointCodePlacement,
} from "./model";
import {
  normalizeVoronoiLayoutText,
  VORONOI_FONT,
} from "./voronoi-font-data";

const NON_SQUARE_POLYGON: Point[] = [
  { x: 0, y: 1 },
  { x: 44, y: 0 },
  { x: 40, y: 10 },
  { x: 2, y: 8 },
];

function design(overrides: Partial<DesignConfig> = {}): DesignConfig {
  return {
    ...DEFAULT_CONFIG,
    bindingWidthMm: 0,
    ...overrides,
  };
}

function translatedPolygon(index: number): Point[] {
  return NON_SQUARE_POLYGON.map((point) => ({
    x: point.x + index * 50,
    y: point.y + (index % 2) * 13,
  }));
}

function geometryFor(
  cellCount: number,
  cellOrder = Array.from({ length: cellCount }, (_, index) => index),
): LayoutGeometry {
  const width = Math.max(50, cellCount * 50);
  const polygons = Array.from({ length: cellCount }, (_, index) =>
    translatedPolygon(index),
  );

  return {
    glass6066: { x: 0, y: 0, width, height: 24 },
    glass6060: { x: 0, y: 0, width, height: 24 },
    overlap: { x: 0, y: 0, width, height: 24 },
    active: { x: 0, y: 0, width: Math.max(44, width - 6), height: 23 },
    bindingOuter: { x: 0, y: 0, width, height: 24 },
    bindingInner: { x: 1, y: 1, width: Math.max(48, width - 2), height: 22 },
    rowCount: 1,
    cells: cellOrder.map((index) => ({
      index,
      site: polygonCentroid(polygons[index]),
      polygon: polygons[index].map((point) => ({ ...point })),
      glass6066Material: index % 2 === 0 ? "tio2" : "pt",
      glass6060Material: index % 2 === 0 ? "pt" : "tio2",
    })),
    boundaries: [],
    activePerimeter: [],
    terminals: [
      {
        polarity: "negative",
        plate: "glass-6066",
        contactStrip: { x: 0, y: 0, width: 1, height: 1 },
        contact: { x: 0.5, y: 0.5 },
        cellIndex: 0,
        gate: {
          polarity: "negative",
          plate: "glass-6066",
          cellIndex: 0,
          side: "left",
          start: { x: 1, y: 0 },
          end: { x: 1, y: 1 },
        },
      },
      {
        polarity: "positive",
        plate: "glass-6066",
        contactStrip: { x: width - 1, y: 23, width: 1, height: 1 },
        contact: { x: width - 0.5, y: 23.5 },
        cellIndex: Math.max(0, cellCount - 1),
        gate: {
          polarity: "positive",
          plate: "glass-6066",
          cellIndex: Math.max(0, cellCount - 1),
          side: "right",
          start: { x: width - 1, y: 23 },
          end: { x: width - 1, y: 24 },
        },
      },
    ],
    etchPaths: { "glass-6066": [], "glass-6060": [] },
    electronPath: [],
  };
}

function signedArea(polygon: Point[]): number {
  return (
    polygon.reduce((sum, point, index) => {
      const next = polygon[(index + 1) % polygon.length];
      return sum + point.x * next.y - point.y * next.x;
    }, 0) / 2
  );
}

function polygonArea(polygon: Point[]): number {
  return Math.abs(signedArea(polygon));
}

function polygonCentroid(polygon: Point[]): Point {
  const area = signedArea(polygon);
  let x = 0;
  let y = 0;
  for (let index = 0; index < polygon.length; index += 1) {
    const point = polygon[index];
    const next = polygon[(index + 1) % polygon.length];
    const weight = point.x * next.y - point.y * next.x;
    x += (point.x + next.x) * weight;
    y += (point.y + next.y) * weight;
  }
  return { x: x / (6 * area), y: y / (6 * area) };
}

function pointDistance(first: Point, second: Point): number {
  return Math.hypot(first.x - second.x, first.y - second.y);
}

function uniqueCanonicalSites(sites: Point[]): Point[] {
  return sites.filter(
    (site, index) =>
      sites.findIndex((other) => pointDistance(site, other) <= 1e-9) === index,
  );
}

function pointInConvexPolygon(
  point: Point,
  polygon: Point[],
  tolerance = 1e-7,
): boolean {
  const orientation = signedArea(polygon) >= 0 ? 1 : -1;
  return polygon.every((start, index) => {
    const end = polygon[(index + 1) % polygon.length];
    const cross =
      (end.x - start.x) * (point.y - start.y) -
      (end.y - start.y) * (point.x - start.x);
    return orientation * cross >= -tolerance;
  });
}

function isConvex(polygon: Point[], tolerance = 1e-7): boolean {
  const orientation = signedArea(polygon) >= 0 ? 1 : -1;
  return polygon.every((point, index) => {
    const next = polygon[(index + 1) % polygon.length];
    const after = polygon[(index + 2) % polygon.length];
    const cross =
      (next.x - point.x) * (after.y - next.y) -
      (next.y - point.y) * (after.x - next.x);
    return orientation * cross >= -tolerance;
  });
}

function expectPolygonsTile(parent: Point[], polygons: Point[][]): void {
  for (const polygon of polygons) {
    expect(polygon.length).toBeGreaterThanOrEqual(3);
    expect(isConvex(polygon)).toBe(true);
    expect(
      polygon.every(
        (point) =>
          Number.isFinite(point.x) &&
          Number.isFinite(point.y) &&
          pointInConvexPolygon(point, parent),
      ),
    ).toBe(true);
  }
  expect(polygons.reduce((sum, polygon) => sum + polygonArea(polygon), 0)).toBeCloseTo(
    polygonArea(parent),
    7,
  );
}

function expectedSlotPolygons(
  config: DesignConfig,
  geometry: LayoutGeometry,
  slotsPerSubcell: number[],
): Point[][] {
  const bindingInset =
    (Number.isFinite(config.bindingWidthMm)
      ? Math.max(0, config.bindingWidthMm)
      : 0) / 2;
  return geometry.cells
    .slice()
    .sort((first, second) => first.index - second.index)
    .flatMap((electrode, electrodeIndex) =>
      partitionConvexPolygonRowMajor(
        insetConvexPolygon(electrode.polygon, bindingInset),
        slotsPerSubcell[electrodeIndex] ?? 0,
      ),
    );
}

function expectCurrentPointCodeShape(artwork: PointCodeArtwork): void {
  expect(Object.keys(artwork).sort()).toEqual([
    "codeEmMm",
    "letterCount",
    "normalizedText",
    "placements",
    "slotCount",
    "slotsPerSubcell",
    "spaceCount",
  ]);
  for (const placement of artwork.placements) {
    expect(Object.keys(placement).sort()).toEqual([
      "character",
      "sites",
      "slotIndex",
      "slotIndexInSubcell",
      "subcellIndex",
    ]);
    expect(placement).not.toHaveProperty("cells");
    expect(placement).not.toHaveProperty("edges");
    expect(placement).not.toHaveProperty("slotPolygon");
  }
}

describe("point-code text and slot layout", () => {
  it("preserves uppercase A-Z and every normalized layout space", () => {
    expect(normalizeVoronoiLayoutText(" a  z\t\tB\n\nC\r\nD!ss-e_ ")).toBe(
      " A  Z  B  C DSSE ",
    );
    expect(normalizeVoronoiLayoutText("A   B")).toHaveLength(5);
  });

  it("reports the exact phrase metadata and four-cell allocation", () => {
    const artwork = buildPointCodeArtwork(
      design({ text: "solar oracle walkman" }),
      geometryFor(4),
    );

    expect(artwork.normalizedText).toBe("SOLAR ORACLE WALKMAN");
    expect(artwork.slotCount).toBe(20);
    expect(artwork.letterCount).toBe(18);
    expect(artwork.spaceCount).toBe(2);
    expect(artwork.slotsPerSubcell).toEqual([5, 5, 5, 5]);
    expect(artwork.placements).toHaveLength(20);
    expect(artwork.codeEmMm).toBeGreaterThan(0);
    expect(artwork.codeEmMm).toBeLessThanOrEqual(1.2);
    expectCurrentPointCodeShape(artwork);
  });

  it.each([
    ["ABCDEFGHIJKLMNOPQR", [5, 5, 4, 4]],
    ["ABC", [1, 1, 1, 0]],
  ])("distributes %s evenly over electrical cells", (text, expected) => {
    const artwork = buildPointCodeArtwork(design({ text }), geometryFor(4));

    expect(artwork.slotsPerSubcell).toEqual(expected);
    expect(artwork.placements).toHaveLength(text.length);
  });

  it("uses sorted electrical order and row-major local slot indexes", () => {
    const artwork = buildPointCodeArtwork(
      design({ text: "a  b\nc" }),
      geometryFor(4, [2, 0, 3, 1]),
    );

    expect(artwork.normalizedText).toBe("A  B C");
    expect(artwork.placements.map(({ character }) => character).join("")).toBe(
      artwork.normalizedText,
    );
    expect(artwork.placements.map(({ slotIndex }) => slotIndex)).toEqual([
      0, 1, 2, 3, 4, 5,
    ]);
    expect(artwork.placements.map(({ subcellIndex }) => subcellIndex)).toEqual([
      0, 0, 1, 1, 2, 3,
    ]);
    expect(
      artwork.placements.map(({ slotIndexInSubcell }) => slotIndexInSubcell),
    ).toEqual([0, 1, 0, 1, 0, 0]);
  });

  it("tiles each electrode inset by exactly half the binding width", () => {
    const config = design({
      text: "SOLAR ORACLE WALKMAN",
      bindingWidthMm: 0.8,
    });
    const geometry = geometryFor(4);
    const artwork = buildPointCodeArtwork(config, geometry);
    const slots = expectedSlotPolygons(
      config,
      geometry,
      artwork.slotsPerSubcell,
    );
    const electrodes = geometry.cells
      .slice()
      .sort((first, second) => first.index - second.index);
    let firstSlotIndex = 0;

    for (let electrodeIndex = 0; electrodeIndex < electrodes.length; electrodeIndex += 1) {
      const electrode = electrodes[electrodeIndex];
      const parent = insetConvexPolygon(
        electrode.polygon,
        config.bindingWidthMm / 2,
      );
      const slotCount = artwork.slotsPerSubcell[electrodeIndex];
      const electrodeSlots = slots.slice(
        firstSlotIndex,
        firstSlotIndex + slotCount,
      );
      expect(electrodeSlots).toHaveLength(5);
      expectPolygonsTile(parent, electrodeSlots);
      firstSlotIndex += slotCount;
    }
  });

  it("partitions top-left to right, then continues on the lower row", () => {
    const parent: Point[] = [
      { x: 0, y: 0 },
      { x: 12, y: 0 },
      { x: 12, y: 8 },
      { x: 0, y: 8 },
    ];
    const slots = partitionConvexPolygonRowMajor(parent, 6);
    const centers = slots.map(polygonCentroid);

    expect(centers).toHaveLength(6);
    expect(centers[0].x).toBeLessThan(centers[1].x);
    expect(centers[1].x).toBeLessThan(centers[2].x);
    expect(centers[3].x).toBeLessThan(centers[4].x);
    expect(centers[4].x).toBeLessThan(centers[5].x);
    expect(Math.max(...centers.slice(0, 3).map(({ y }) => y))).toBeLessThan(
      Math.min(...centers.slice(3).map(({ y }) => y)),
    );
    expectPolygonsTile(parent, slots);
    expect(mapUnitPointToConvexPolygon({ x: 0.5, y: 0.5 }, parent)).toEqual(
      polygonCentroid(parent),
    );
  });

  it("returns an empty polygon when a convex inset reaches or exceeds capacity", () => {
    const square: Point[] = [
      { x: 0, y: 0 },
      { x: 1, y: 0 },
      { x: 1, y: 1 },
      { x: 0, y: 1 },
    ];

    expect(insetConvexPolygon(square, 0.49).length).toBeGreaterThanOrEqual(3);
    expect(insetConvexPolygon(square, 0.5)).toEqual([]);
    expect(insetConvexPolygon(square, 1)).toEqual([]);
  });
});

describe("Demaine-site point codes", () => {
  it("caps one shared isotropic metric at 1.2 mm", () => {
    const config = design({ text: "AAAAA" });
    const geometry = geometryFor(1);
    const artwork = buildPointCodeArtwork(config, geometry);
    const slots = expectedSlotPolygons(
      config,
      geometry,
      artwork.slotsPerSubcell,
    );
    const canonicalSites = VORONOI_FONT.A.sites;

    expect(artwork.codeEmMm).toBe(1.2);
    for (const placement of artwork.placements) {
      expect(placement.sites).toHaveLength(canonicalSites.length);
      for (let first = 0; first < canonicalSites.length; first += 1) {
        for (
          let second = first + 1;
          second < canonicalSites.length;
          second += 1
        ) {
          const canonicalDistance = pointDistance(
            canonicalSites[first],
            canonicalSites[second],
          );
          expect(
            pointDistance(placement.sites[first], placement.sites[second]) /
              canonicalDistance,
          ).toBeCloseTo(artwork.codeEmMm, 9);
        }
      }
    }

    const localSites = (placement: PointCodePlacement, slotPolygon: Point[]) => {
      const center = polygonCentroid(
        insetConvexPolygon(slotPolygon, POINT_CODE_RADIUS_MM),
      );
      return placement.sites.map((site) => ({
        x: site.x - center.x,
        y: site.y - center.y,
      }));
    };
    const reference = localSites(artwork.placements[0], slots[0]);
    for (const placement of artwork.placements.slice(1)) {
      const local = localSites(placement, slots[placement.slotIndex]);
      for (let index = 0; index < local.length; index += 1) {
        expect(local[index].x).toBeCloseTo(reference[index].x, 9);
        expect(local[index].y).toBeCloseTo(reference[index].y, 9);
      }
    }
  });

  it("uses a smaller shared capacity when every slot cannot hold 1.2 mm", () => {
    const geometry = geometryFor(1);
    geometry.cells[0].polygon = [
      { x: 0, y: 0 },
      { x: 2, y: 0 },
      { x: 2, y: 1 },
      { x: 0, y: 1 },
    ];
    const codes = buildPointCodeArtwork(design({ text: "AA" }), geometry);
    const withSpace = buildPointCodeArtwork(design({ text: "A " }), geometry);

    expect(codes.codeEmMm).toBeGreaterThan(0);
    expect(codes.codeEmMm).toBeLessThan(1.2);
    expect(withSpace.codeEmMm).toBeCloseTo(codes.codeEmMm, 12);
    expect(withSpace.placements[1].sites).toEqual([]);
  });

  it("maps every canonical site uniformly about 0.5 and keeps it in its slot", () => {
    const config = design({ text: "ABCDEFGHIJKLMNOPQRSTUVWXYZ" });
    const geometry = geometryFor(4);
    const artwork = buildPointCodeArtwork(config, geometry);
    const slots = expectedSlotPolygons(
      config,
      geometry,
      artwork.slotsPerSubcell,
    );

    for (const placement of artwork.placements) {
      const canonicalSites = uniqueCanonicalSites(
        VORONOI_FONT[placement.character].sites,
      );
      const slotPolygon = slots[placement.slotIndex];
      const safeSlot = insetConvexPolygon(slotPolygon, POINT_CODE_RADIUS_MM);
      const center = polygonCentroid(safeSlot);
      expect(placement.sites).toHaveLength(canonicalSites.length);
      for (let index = 0; index < canonicalSites.length; index += 1) {
        const mapped = placement.sites[index];
        const canonical = canonicalSites[index];
        expect((mapped.x - center.x) / artwork.codeEmMm).toBeCloseTo(
          canonical.x - 0.5,
          5,
        );
        expect((mapped.y - center.y) / artwork.codeEmMm).toBeCloseTo(
          canonical.y - 0.5,
          5,
        );
        expect(pointInConvexPolygon(mapped, safeSlot)).toBe(true);
      }
    }
  });

  it("deduplicates coincident G sites in first-occurrence order deterministically", () => {
    const config = design({ text: "GG" });
    const geometry = geometryFor(1);
    const first = buildPointCodeArtwork(config, geometry);
    const second = buildPointCodeArtwork(config, geometry);
    const slots = expectedSlotPolygons(
      config,
      geometry,
      first.slotsPerSubcell,
    );
    const canonicalSites = uniqueCanonicalSites(VORONOI_FONT.G.sites);

    expect(VORONOI_FONT.G.sites).toHaveLength(13);
    expect(canonicalSites).toHaveLength(11);
    expect(second).toEqual(first);
    for (const placement of first.placements) {
      const safeSlot = insetConvexPolygon(
        slots[placement.slotIndex],
        POINT_CODE_RADIUS_MM,
      );
      const center = polygonCentroid(safeSlot);

      expect(placement.sites).toHaveLength(canonicalSites.length);
      for (let index = 0; index < canonicalSites.length; index += 1) {
        expect(placement.sites[index].x).toBeCloseTo(
          center.x + (canonicalSites[index].x - 0.5) * first.codeEmMm,
          8,
        );
        expect(placement.sites[index].y).toBeCloseTo(
          center.y + (canonicalSites[index].y - 0.5) * first.codeEmMm,
          8,
        );
      }
      expect(
        placement.sites.every((site) =>
          pointInConvexPolygon(site, safeSlot),
        ),
      ).toBe(true);
    }
  });

  it("keeps spaces empty without changing shared capacity or neighboring codes", () => {
    const config = design({ text: "AAAAA" });
    const geometry = geometryFor(1);
    const allCodes = buildPointCodeArtwork(config, geometry);
    const allCodeSlots = expectedSlotPolygons(
      config,
      geometry,
      allCodes.slotsPerSubcell,
    );

    for (let spaceIndex = 0; spaceIndex < allCodes.slotCount; spaceIndex += 1) {
      const characters = Array.from("AAAAA");
      characters[spaceIndex] = " ";
      const withSpaceConfig = design({ text: characters.join("") });
      const withSpace = buildPointCodeArtwork(withSpaceConfig, geometry);
      const withSpaceSlots = expectedSlotPolygons(
        withSpaceConfig,
        geometry,
        withSpace.slotsPerSubcell,
      );

      expect(withSpace.codeEmMm).toBeCloseTo(allCodes.codeEmMm, 12);
      expect(withSpaceSlots).toEqual(allCodeSlots);
      for (let index = 0; index < allCodes.placements.length; index += 1) {
        expect(withSpace.placements[index]).toMatchObject({
          slotIndex: allCodes.placements[index].slotIndex,
          slotIndexInSubcell: allCodes.placements[index].slotIndexInSubcell,
          subcellIndex: allCodes.placements[index].subcellIndex,
        });
        expect(withSpace.placements[index].sites).toEqual(
          index === spaceIndex ? [] : allCodes.placements[index].sites,
        );
      }
    }
  });

  it.each([
    ["default", { ...DEFAULT_CONFIG }],
    ["four-cell", { ...DEFAULT_CONFIG, subcellCount: 4 }],
  ])(
    "keeps complete circles and 0.07 mm site spacing safe for %s geometry",
    (_, config) => {
      const geometry = buildGeometry(config);
      const artwork = buildPointCodeArtwork(config, geometry);
      const cellsByIndex = new Map(
        geometry.cells.map((cell) => [cell.index, cell]),
      );
      const minimumDistance =
        POINT_CODE_RADIUS_MM * 2 + POINT_CODE_MIN_GAP_MM;

      expect(artwork.codeEmMm).toBeLessThanOrEqual(1.2);
      for (const placement of artwork.placements) {
        const cell = cellsByIndex.get(placement.subcellIndex);
        expect(cell).toBeDefined();
        const screenRegion = insetConvexPolygon(
          cell!.polygon,
          config.bindingWidthMm / 2,
        );
        const safeRegion = insetConvexPolygon(
          screenRegion,
          POINT_CODE_RADIUS_MM,
        );
        expect(
          placement.sites.every((site) =>
            pointInConvexPolygon(site, safeRegion),
          ),
        ).toBe(true);

        for (let first = 0; first < placement.sites.length; first += 1) {
          for (
            let second = first + 1;
            second < placement.sites.length;
            second += 1
          ) {
            expect(
              pointDistance(placement.sites[first], placement.sites[second]),
            ).toBeGreaterThanOrEqual(minimumDistance);
          }
        }
      }

      expect(
        validatePointCodeArtwork(config, geometry, artwork).filter(
          ({ severity }) => severity === "error",
        ),
      ).toEqual([]);
    },
  );
});

describe("point-code manufacturing validation", () => {
  it("allows empty and all-space text when screen regions remain usable", () => {
    for (const text of ["", "    "]) {
      const config = { ...DEFAULT_CONFIG, text };
      const geometry = buildGeometry(config);
      const artwork = buildPointCodeArtwork(config, geometry);

      expect(artwork.placements.flatMap(({ sites }) => sites)).toEqual([]);
      expect(validatePointCodeArtwork(config, geometry, artwork)).toEqual([]);
    }
  });

  it("reports collapsed screen regions for the real 64-cell, 5 mm build", () => {
    const config = {
      ...DEFAULT_CONFIG,
      subcellCount: 64,
      bindingWidthMm: 5,
    };
    const geometry = buildGeometry(config);
    const artwork = buildPointCodeArtwork(config, geometry);
    const errors = validatePointCodeArtwork(config, geometry, artwork).filter(
      ({ severity }) => severity === "error",
    );

    expect(errors.length).toBeGreaterThan(0);
    expect(
      errors.some(({ message }) => /Screen cell|TiO2 印刷區/.test(message)),
    ).toBe(true);
  });

  it("reports text too dense to preserve containment and site separation", () => {
    const config = { ...DEFAULT_CONFIG, text: "A".repeat(2_048) };
    const geometry = buildGeometry(config);
    const artwork = buildPointCodeArtwork(config, geometry);
    const errors = validatePointCodeArtwork(config, geometry, artwork).filter(
      ({ severity }) => severity === "error",
    );

    expect(errors.length).toBeGreaterThan(0);
    expect(
      errors.some(({ message }) =>
        /Point Code 過密|最小製造間距/.test(message),
      ),
    ).toBe(true);
  });
});
