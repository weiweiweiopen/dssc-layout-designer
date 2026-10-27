import { beforeAll, describe, expect, it } from "vitest";
import { buildGeometry } from "./geometry";
import { DEFAULT_CONFIG, type LayoutGeometry } from "./model";
import { setArea } from "./polygons";
import { buildReviewFootprints, DEFAULT_REVIEW_SETTINGS, parseReviewSettings, reviewDyeColor, reviewStack } from "./review-model";
import { reviewMeshGeometry, reviewShapes } from "./review-shapes";

describe("canonical 3D review geometry", () => {
  let geometry: LayoutGeometry;
  beforeAll(() => { geometry = buildGeometry(DEFAULT_CONFIG); });

  it("uses exact retained FTO, shared seal and assigned coating polygons on both plates", () => {
    const layers = buildReviewFootprints(geometry, false);
    for (const plate of ["glass-6066", "glass-6060"] as const) {
      expect(layers.find((l) => l.id === `${plate}-fto`)!.polygons).toBe(geometry.fabrication.retainedFto[plate]);
      for (const kind of ["tio2", "pt"] as const) {
        const expected = geometry.cells.filter((cell) => (plate === "glass-6066" ? cell.glass6066Material : cell.glass6060Material) === kind)
          .map((cell) => geometry.fabrication.activeRegions[cell.index]);
        expect(layers.find((l) => l.id === `${plate}-${kind}`)!.polygons.map(([ring]) => ring)).toEqual(expected);
      }
      const coatings = layers.filter((l) => l.plate === plate && (l.kind === "tio2" || l.kind === "pt"));
      expect(coatings.reduce((sum, l) => sum + setArea(l.polygons), 0)).toBeCloseTo(geometry.fabrication.totalActiveMm2, 5);
    }
    expect(layers.find((l) => l.kind === "seal")!.polygons).toBe(geometry.fabrication.sealPrint);
    expect(buildReviewFootprints(geometry, true).find((l) => l.kind === "seal")!.polygons).toBe(geometry.fabrication.sealAssembled);
    expect(layers.filter((l) => l.kind === "contacts").map((l) => setArea(l.polygons))).toEqual([180, 180]);
  });

  it("registers unequal glass widths once in centered assembly coordinates", () => {
    const layers = buildReviewFootprints(geometry, false);
    const [small] = reviewShapes(layers.find((l) => l.id === "glass-6060-glass")!.polygons, { x: 33, y: 30 });
    const xy = small.getPoints().map((p) => [p.x, p.y]);
    expect(xy).toContainEqual([-30, 30]);
    expect(xy).toContainEqual([30, -30]);
    expect(Math.min(...xy.map(([x]) => x))).toBe(-30);
    expect(Math.max(...xy.map(([x]) => x))).toBe(30);
  });

  it("triangulates holes as empty space rather than filled glue or FTO", () => {
    const ring = (a: number, b: number) => [{ x: a, y: a }, { x: b, y: a }, { x: b, y: b }, { x: a, y: b }, { x: a, y: a }];
    const polygons = [[ring(0, 4), ring(1, 3)]];
    expect(reviewShapes(polygons, { x: 0, y: 0 })[0].holes).toHaveLength(1);
    const mesh = reviewMeshGeometry(polygons, { x: 0, y: 0 }, 0);
    const position = mesh.getAttribute("position"), index = mesh.index!;
    let area = 0;
    for (let i = 0; i < index.count; i += 3) {
      const [a, b, c] = [index.getX(i), index.getX(i + 1), index.getX(i + 2)];
      area += Math.abs((position.getX(b) - position.getX(a)) * (position.getY(c) - position.getY(a))
        - (position.getY(b) - position.getY(a)) * (position.getX(c) - position.getX(a))) / 2;
    }
    expect(area).toBeCloseTo(12, 6);
    mesh.dispose();
    const solid = reviewMeshGeometry(polygons, { x: 0, y: 0 }, 0.015);
    solid.computeBoundingBox();
    expect(solid.boundingBox!.max.z).toBeCloseTo(0.015, 6);
    expect([...solid.getAttribute("position").array].every(Number.isFinite)).toBe(true);
    solid.dispose();
  });

  it("puts conductive faces inward and scales films / gap together without scaling glass", () => {
    const layers = buildReviewFootprints(geometry, false);
    const at = (id: string, scale: number, explode = 0) => reviewStack(DEFAULT_CONFIG,
      { ...DEFAULT_REVIEW_SETTINGS, thinLayerScale: scale, explodeMm: explode }).position(layers.find((l) => l.id === id)!);
    const lowerGlass = at("glass-6066-glass", 1), lowerFto = at("glass-6066-fto", 1);
    const seal = at("ab-313", 1), upperFto = at("glass-6060-fto", 1), upperGlass = at("glass-6060-glass", 1);
    expect(lowerGlass.z + lowerGlass.depth).toBeCloseTo(lowerFto.z, 9);
    expect(lowerFto.z + lowerFto.depth).toBeCloseTo(seal.z, 9);
    expect(seal.z + seal.depth).toBeCloseTo(upperFto.z, 9);
    expect(upperFto.z + upperFto.depth).toBeCloseTo(upperGlass.z, 9);
    expect(seal.depth).toBeCloseTo(DEFAULT_CONFIG.beadDiameterUm / 1000, 9);
    expect(at("glass-6066-tio2", 40).depth / at("glass-6066-tio2", 1).depth).toBe(40);
    expect(at("ab-313", 40).depth / seal.depth).toBe(40);
    expect(at("glass-6066-glass", 40).depth).toBe(lowerGlass.depth);
    expect(at("glass-6066-glass", 40, 5).z).toBe(at("glass-6066-glass", 40).z - 15);
    expect(at("glass-6060-glass", 40, 5).z).toBe(at("glass-6060-glass", 40).z + 15);
  });

  it("keeps electrode dyes independent and rejects malformed stored appearance", () => {
    const settings = parseReviewSettings(JSON.stringify({ biggerDye: "blue", smallerDye: "custom", smallerColor: "#007733",
      thinLayerScale: 10000, explodeMm: -10, glassThicknessMm: 0, glass: false, fto: "false", biggerColor: "url(bad)" }));
    expect(reviewDyeColor(settings, "glass-6066")).toBe("#376c9d");
    expect(reviewDyeColor(settings, "glass-6060")).toBe("#007733");
    expect(settings).toMatchObject({ thinLayerScale: 100, explodeMm: 0, glassThicknessMm: 0.5, glass: false, fto: true, biggerColor: "#812f40" });
    expect(parseReviewSettings("{")).toEqual(DEFAULT_REVIEW_SETTINGS);
    expect(parseReviewSettings('{"biggerDye":"constructor","smallerDye":"unknown"}')).toEqual(DEFAULT_REVIEW_SETTINGS);
  });
});
