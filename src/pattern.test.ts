import { describe, expect, it } from "vitest";
import { DEFAULT_CONFIG, type DesignConfig } from "./model";
import { buildGeometry, validateDesign } from "./geometry";
import { difference, intersect, offsetPolygons, rectRing, setArea, shape, union } from "./polygons";
import { cellCoating, interiorPoint } from "./artwork-source";
import { buildFabricationAssets } from "./svg";
import { buildPointCodeArtwork } from "./point-code";
import { applyArtworkPattern, checkPatternFlow } from "./pattern-fabrication";
import { electricalEstimate } from "./electrical";
import { buildReviewFootprints } from "./review-model";
import { buildManufacturingDxf, downloadProjectBundle } from "./export";

export function patternedConfig(): DesignConfig {
  return { ...DEFAULT_CONFIG, glass6066WidthMm: 62, glass6060WidthMm: 56, glassHeightMm: 66, subcellCount: 4, areaBalance: 0,
    measuredWetFilmUm: 15,
    artwork: { format: "dssc-vector-artwork-v1", id: "pattern-test", title: "O", widthMm: 50, heightMm: 60,
      regions: [[rectRing({ x: 5, y: 5, width: 40, height: 50 }), rectRing({ x: 15, y: 15, width: 20, height: 30 })]],
      targetVocV: 2, targetIscMa: 1, voltageToleranceV: 0.35 } };
}
describe("patterned W-type fabrication", () => {
  it("uses actual patterned regions for cell area and both material masks", () => {
    const c = patternedConfig(), g = buildGeometry(c), f = g.fabrication;
    expect(f.pattern?.sourceId).toBe(c.artwork!.id);
    expect(f.cellAreasMm2).toEqual(g.cells.map((_, i) => setArea(cellCoating(f, i))));
    expect(f.totalActiveMm2).toBeLessThan(2000);
    expect(f.pattern?.ftoFragmentsValid).toBe(true);
    const assets = buildFabricationAssets(c, g, buildPointCodeArtwork(c, g));
    expect(assets.filter((a) => a.id.endsWith("-pt"))).toHaveLength(2);
    expect(assets.find((a) => a.id === "screen-glass-6066-tio2")?.svg).toContain("piece-");
    expect(validateDesign(c, g).filter((w) => w.severity === "error")).toEqual([]);
  }, 30000);

  it("balances the density of the artwork, and reports exact post-glue areas", () => {
    const c = patternedConfig(), baseline = buildGeometry(c), balanced = buildGeometry({ ...c, areaBalance: 1 });
    expect(balanced.fabrication.areaCv).toBeLessThan(baseline.fabrication.areaCv);
    expect(Math.min(...balanced.fabrication.cellAreasMm2)).toBeGreaterThan(Math.min(...baseline.fabrication.cellAreasMm2));
    expect(balanced.fabrication.cellAreasMm2).toEqual(balanced.cells.map((_, i) => setArea(cellCoating(balanced.fabrication, i))));
    const e = electricalEstimate(c, balanced.fabrication.cellAreasMm2, balanced);
    expect(e.iscMa).toBeCloseTo(Math.min(...balanced.fabrication.cellAreasMm2) / 3025 * 39, 8);
  }, 30000);

  it("retains holes in the 3D and DXF production sources and swaps material by electrical order", () => {
    const c = patternedConfig(), g = buildGeometry(c), codes = buildPointCodeArtwork(c, g);
    const footprints = buildReviewFootprints(g, false);
    for (const plate of ["glass-6066", "glass-6060"] as const) for (const material of ["tio2", "pt"] as const) {
      const expected = g.cells.filter((cell) => (plate === "glass-6066" ? cell.glass6066Material : cell.glass6060Material) === material)
        .flatMap((cell) => cellCoating(g.fabrication, cell.index));
      expect(footprints.find((p) => p.id === `${plate}-${material}`)!.polygons).toEqual(expected);
    }
    const dxf = buildManufacturingDxf(c, g, codes);
    expect(dxf).toContain("SCREEN_6066_PT_REGIONS"); expect(dxf).toContain("SCREEN_6060_PT_REGIONS");
    expect(dxf).toContain("AcDbHatch");
    expect(g.cells.map((v) => v.glass6066Material)).toEqual(["tio2", "pt", "tio2", "pt"]);
  });

  it("does not invent a wet-film calibration to make a high-volume glue scenario pass", async () => {
    const c = { ...patternedConfig(), measuredWetFilmUm: 0 }, g = buildGeometry(c);
    expect(c.measuredWetFilmUm).toBe(0);
    expect(g.fabrication.pattern!.scenarioValid).toBe(false);
    expect(g.fabrication.errors.join(" ")).toContain("體積");
    await expect(downloadProjectBundle(c, g, buildPointCodeArtwork(c, g), [], false)).rejects.toThrow("不能匯出");
  });

  it("rejects sealed pockets and sub-width connections even when total free area is large", () => {
    const outer = shape(rectRing({ x: 0, y: 0, width: 20, height: 20 }));
    const corridor = shape(rectRing({ x: 3, y: 0, width: 2, height: 20 }));
    const pocket = shape(rectRing({ x: 10, y: 7, width: 5, height: 5 }));
    const coating = [[rectRing({ x: 11, y: 8, width: 3, height: 3 })]];
    const sealed = checkPatternFlow(outer, difference(outer, union(corridor, pocket)), [coating], 0.3);
    expect(sealed.chambers).toBe(2); expect(sealed.reachableChambers).toBe(1); expect(sealed.pass).toBe(false);
    const thin = shape(rectRing({ x: 4, y: 9, width: 7, height: 0.1 }));
    expect(checkPatternFlow(outer, difference(outer, union(corridor, pocket, thin)), [coating], 0.3).pass).toBe(false);
    const wide = shape(rectRing({ x: 4, y: 9, width: 7, height: 1 }));
    expect(checkPatternFlow(outer, difference(outer, union(corridor, pocket, wide)), [coating], 0.3).pass).toBe(true);
  });

  it("flags empty electrical cells instead of treating the convex envelope as active coating", () => {
    const c = patternedConfig(); c.artwork!.regions = [[rectRing({ x: 2, y: 2, width: 3, height: 3 })]];
    const g = buildGeometry(c);
    expect(g.fabrication.cellAreasMm2.some((a) => a === 0)).toBe(true);
    expect(g.fabrication.errors.join(" ")).toContain("沒有有效塗層");
  });

  it("checks complete coating fragments, not just a generator / centroid sample", () => {
    const c = patternedConfig(), g = buildGeometry(c), base = buildGeometry({ ...c, artwork: undefined });
    const removed = cellCoating(g.fabrication, 0);
    base.fabrication.retainedFto["glass-6066"] = difference(base.fabrication.retainedFto["glass-6066"], offsetPolygons(removed, 0.01));
    const corrupted = applyArtworkPattern(c, base, base.fabrication);
    expect(corrupted.pattern!.ftoFragmentsValid).toBe(false);
    expect(corrupted.errors.join(" ")).toContain("FTO 導體島");
    const hollow = c.artwork!.regions[0], sample = interiorPoint(hollow);
    expect(sample.x < 15 || sample.x > 35 || sample.y < 15 || sample.y > 45).toBe(true);
  });
});
