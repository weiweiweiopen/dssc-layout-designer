import { describe, expect, it } from "vitest";
import { minimumSealGap } from "./coating";
import { buildGeometry } from "./geometry";
import { DEFAULT_CONFIG, type Point } from "./model";
import { difference, intersect, offsetPolygons, rectRing, setArea, shape } from "./polygons";

function lineDistance(p: Point, a: Point, b: Point) {
  return Math.abs((b.x - a.x) * (p.y - a.y) - (b.y - a.y) * (p.x - a.x)) / Math.hypot(b.x - a.x, b.y - a.y);
}

describe("maximal uniform-clearance coatings", () => {
  it("independently measures a known gap, overlap, touching and missing coating", () => {
    const seal = difference(shape(rectRing({ x: 0, y: 0, width: 10, height: 10 })),
      shape(rectRing({ x: 1, y: 1, width: 8, height: 8 })));
    expect(minimumSealGap(rectRing({ x: 2, y: 2, width: 6, height: 6 }), seal)).toBe(1);
    expect(minimumSealGap(rectRing({ x: 0.5, y: 0.5, width: 2, height: 2 }), seal)).toBe(0);
    expect(minimumSealGap(rectRing({ x: 1, y: 2, width: 6, height: 6 }), seal)).toBe(0);
    expect(minimumSealGap([], seal)).toBeNull();
  });

  it.each([0, 0.5, 1])("fills every cell to the same offset constraint at balance %s instead of scaling down", (areaBalance) => {
    const c = { ...DEFAULT_CONFIG, glass6066WidthMm: 70, subcellCount: 6, electrodeSeed: 4361322,
      bindingWidthMm: 1, screenMeshPerInch: 140, screenWireUm: 14, areaBalance };
    const g = buildGeometry(c), f = g.fabrication, clear = f.coatingClearance;
    expect(f.errors).toEqual([]);
    for (let i = 0; i < g.cells.length; i++) {
      const cell = g.cells[i].polygon;
      const edges = cell.map((a, k) => ({ a, b: cell[(k + 1) % cell.length] }))
        .filter(({ a, b }) => Math.hypot(a.x - b.x, a.y - b.y) > 1e-8);
      const coating = f.activeRegions[i];
      // Every coating edge is on a limiting inward-offset wall. A centroid-
      // scaled / trimmed polygon would leave at least one edge farther away.
      for (let k = 0; k < coating.length; k++) {
        const a = coating[k], b = coating[(k + 1) % coating.length];
        const middle = { x: (a.x + b.x) / 2, y: (a.y + b.y) / 2 };
        expect(Math.min(...edges.map(({ a, b }) => lineDistance(middle, a, b)))).toBeCloseTo(clear.insetMm, 5);
      }
      expect(clear.perCell[i].printedMm!).toBeGreaterThanOrEqual(clear.printedRequiredMm - 0.00001);
      expect(clear.perCell[i].scenarioMm!).toBeGreaterThanOrEqual(c.coatingSafetyGapMm + c.registrationMm - 0.00001);
      // Independent Minkowski-buffer / polygon intersection feasibility check.
      const buffered = offsetPolygons(shape(coating), c.coatingSafetyGapMm + c.registrationMm - 0.0001);
      expect(setArea(intersect(buffered, f.sealAssembled))).toBeLessThan(1e-7);
    }
    expect(Math.max(...clear.perCell.map((r) => r.printedMm!)) - Math.min(...clear.perCell.map((r) => r.printedMm!)))
      .toBeLessThan(0.00001);
  });

  it("recovers screenshot active area while maintaining the explicit safety gap", () => {
    const g = buildGeometry({ ...DEFAULT_CONFIG, glass6066WidthMm: 70, subcellCount: 6, electrodeSeed: 4361322,
      bindingWidthMm: 1, screenMeshPerInch: 140, screenWireUm: 14 });
    // Historical screenshot: 2136.6 mm² total, minimum 280.09 mm² after trimming.
    expect(g.fabrication.totalActiveMm2).toBeGreaterThan(2136.6);
    expect(Math.min(...g.fabrication.cellAreasMm2)).toBeGreaterThan(280.09);
    expect(g.fabrication.coatingClearance.minimumScenarioMm!).toBeGreaterThan(0.19999);
  });

  it("increases only the required offset when raising the safety target at a fixed partition", () => {
    const c = { ...DEFAULT_CONFIG, areaBalance: 0, measuredWetFilmUm: 15 };
    const narrow = buildGeometry({ ...c, coatingSafetyGapMm: 0.1 });
    const wide = buildGeometry({ ...c, coatingSafetyGapMm: 0.4 });
    expect(wide.etchPaths).toEqual(narrow.etchPaths);
    expect(wide.fabrication.sealPrint).toEqual(narrow.fabrication.sealPrint);
    expect(wide.fabrication.totalActiveMm2).toBeLessThan(narrow.fabrication.totalActiveMm2);
    expect(wide.fabrication.coatingClearance.minimumScenarioMm!).toBeCloseTo(0.5, 5);
    expect(narrow.fabrication.coatingClearance.minimumScenarioMm!).toBeCloseTo(0.2, 5);
  });
});
