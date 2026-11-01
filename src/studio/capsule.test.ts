import { readFileSync } from "node:fs";
import { parse } from "opentype.js";
import { describe, expect, it } from "vitest";
import { difference, intersect, offsetPolygons, setArea, union } from "../polygons";
import { generateArtwork, pathData } from "./geometry";
import { capsuleDefaults, clone, newDocument, parseDocument, recipeFor, variantOf, type Recipe } from "./model";
import { artworkSvg, geometryJson, projectJson } from "./export";

function fontFrom(file: string) {
  const bytes = readFileSync(new URL(`../../node_modules/@fontsource/${file}`, import.meta.url));
  return parse(bytes.buffer.slice(bytes.byteOffset, bytes.byteOffset + bytes.byteLength) as ArrayBuffer);
}
const font = fontFrom("anybody/files/anybody-latin-900-normal.woff");
const anton = fontFrom("anton/files/anton-latin-400-normal.woff");
function fitted() {
  const r = recipeFor("capsules"); r.text = "SOLAR ORACLE\nWALKMAN RADIO\nBIG SUN"; r.capsule.lanes = 2;
  return r;
}
const shapePath = (r: Recipe) => pathData(generateArtwork(r, font).a);

describe("Capsule Rhythm typography and layout", () => {
  it("fits actual glyphs into carriers and resolves the exact text knockout", () => {
    const r = fitted(), art = generateArtwork(r, font);
    const carriers = art.elements.filter((e) => e.kind === "geometry"), glyphs = art.elements.filter((e) => e.kind === "glyph");
    expect(carriers).toHaveLength(3); expect(glyphs.length).toBeGreaterThan(15);
    expect(glyphs.every((e) => e.groupId && carriers.some((c) => c.groupId === e.groupId))).toBe(true);
    const shape = union(...carriers.map((e) => e.polygons)), text = union(...glyphs.map((e) => e.polygons));
    expect(setArea(art.a)).toBeCloseTo(setArea(difference(shape, text)), 5);
    // Compare interiors: exact re-clipping of thousands of coincident outline
    // edges is unnecessarily ill-conditioned at Clipper's integer rounding grid.
    expect(setArea(intersect(art.a, offsetPolygons(text, -0.002)))).toBeLessThan(1e-6);
    expect(art.stats.areaA + art.stats.areaB).toBeCloseTo(r.width * r.height, 5);
  });

  it("makes text and font changes affect both the lettering and word-length allocation", () => {
    const r = fitted(); r.capsule.proportion = 1;
    const a = generateArtwork(r, font), b = generateArtwork(r, anton);
    expect(a.a).not.toEqual(b.a);
    expect(a.elements.find((e) => e.id === "capsule:0:0")!.bounds).not.toEqual(b.elements.find((e) => e.id === "capsule:0:0")!.bounds);
    r.text = "HI\nEXTRAORDINARY\nSUN";
    const edited = generateArtwork(r, font);
    expect(edited.a).not.toEqual(a.a);
    expect(edited.elements.find((e) => e.id === "capsule:0:0")!.bounds.width).toBeLessThan(edited.elements.find((e) => e.id === "capsule:0:1")!.bounds.width);
  });

  it("reflows word units into selectable lanes and creates the correct row dividers", () => {
    const r = recipeFor("capsules"); r.text = "MAKE IT HAPPEN NOW";
    expect(generateArtwork(r, font).elements.filter((e) => e.kind === "geometry")).toHaveLength(1);
    r.capsule.units = "words"; r.capsule.lanes = 2;
    const art = generateArtwork(r, font);
    expect(art.elements.filter((e) => e.kind === "geometry").map((e) => e.label)).toEqual(["MAKE", "IT", "HAPPEN", "NOW"]);
    expect(art.dividers).toHaveLength(1); expect(art.dividers[0].rows).toBe(2);
    r.capsule.direction = "vertical";
    const vertical = generateArtwork(r, font);
    expect(vertical.dividers[0].axis).toBe("x"); expect(vertical.dividers[0].direction).toBe(-1);
    expect(vertical.stats.areaA + vertical.stats.areaB).toBeCloseTo(r.width * r.height, 5);
  });

  const controls: Array<[string, (r: Recipe) => void]> = [
    ["direction", (r) => { r.capsule.direction = "vertical"; }],
    ["lanes", (r) => { r.capsule.lanes = 1; }],
    ["gap", (r) => { r.capsule.gap = 2.4; }],
    ["stagger", (r) => { r.capsule.stagger = -0.7; }],
    ["length variation", (r) => { r.capsule.variation = 0.85; }],
    ["roundness", (r) => { r.capsule.roundness = 0.3; }],
    ["text padding", (r) => { r.capsule.padding = 0.23; }],
    ["end following", (r) => { r.capsule.follow = 0; }],
    ["word proportions", (r) => { r.capsule.proportion = 0; }],
    ["rhythm seed", (r) => { r.capsule.seed += 57; }],
    ["row heights", (r) => { r.rowWeights[0] = 1.7; }],
    ["line gap", (r) => { r.lineGap = 1.7; }],
    ["tracking", (r) => { r.tracking = 0.12; }],
  ];
  it.each(controls)("%s changes resolved geometry, not only a preview guide", (_, change) => {
    const r = fitted(), before = shapePath(r); change(r);
    expect(shapePath(r)).not.toBe(before);
  });

  it("moves a fitted capsule and its complete text as a group, leaving other groups intact", () => {
    const r = fitted(), before = generateArtwork(r, font);
    r.capsule.edits["0:0"] = { x: 1.25, y: -0.7, scale: 1, angle: 0 };
    const after = generateArtwork(r, font);
    for (const e of before.elements) {
      const changed = after.elements.find((v) => v.id === e.id)!;
      if (e.groupId === "0:0") {
        expect(changed.bounds.x).toBeCloseTo(e.bounds.x + 1.25, 6);
        expect(changed.bounds.y).toBeCloseTo(e.bounds.y - 0.7, 6);
      } else expect(changed).toEqual(e);
    }
    r.capsule.edits["0:0"].angle = 18;
    expect(generateArtwork(r, font).a).not.toEqual(after.a);
  });

  it("weaves a real headline with controlled strip and segment counts", () => {
    const r = recipeFor("capsules"); r.capsule.layout = "weave"; r.capsule.direction = "vertical";
    r.capsule.lanes = 4; r.capsule.segments = 3; r.capsule.operation = "xor";
    const art = generateArtwork(r, font);
    expect(art.elements.filter((e) => e.kind === "geometry")).toHaveLength(12);
    expect(art.elements.filter((e) => e.kind === "glyph").length).toBeGreaterThan(10);
    const glyphs = art.elements.filter((e) => e.kind === "glyph");
    for (const change of [
      (v: Recipe) => { v.capsule.segments = 2; },
      (v: Recipe) => { v.capsule.lanes = 3; },
      (v: Recipe) => { v.capsule.gap = 2.4; },
      (v: Recipe) => { v.capsule.stagger = -0.8; },
    ]) {
      const next = clone(r); change(next); const changed = generateArtwork(next, font);
      expect(changed.a).not.toEqual(art.a);
      expect(changed.elements.filter((e) => e.kind === "glyph")).toEqual(glyphs);
    }
    const a = shapePath(r); r.capsule.operation = "outline";
    expect(shapePath(r)).not.toBe(a);
    r.capsule.operation = "intersect";
    expect(shapePath(r)).not.toBe(a);
  });

  it("round-trips capsule controls / transforms and migrates earlier v1 recipes without mutating them", () => {
    const doc = newDocument(); doc.designs.fluid = fitted(); doc.designs.fluid.capsule.edits["0:0"] = { x: 1, y: 2, scale: 0.8, angle: 12 };
    const restored = parseDocument(JSON.parse(projectJson(doc)));
    expect(restored).toEqual(doc);
    expect(shapePath(restored.designs.fluid)).toBe(shapePath(doc.designs.fluid));
    const old = JSON.parse(projectJson(doc)); delete old.designs.fluid.capsule; delete old.designs.pixel.capsule;
    const migrated = parseDocument(old);
    expect(migrated.designs.fluid.capsule).toEqual(capsuleDefaults(doc.designs.fluid.seed));
    expect(old.designs.fluid.capsule).toBeUndefined();
    for (const bad of [
      { ...doc.designs.fluid.capsule, lanes: 0 },
      { ...doc.designs.fluid.capsule, gap: NaN },
      { ...doc.designs.fluid.capsule, operation: "paste-text" },
      { ...doc.designs.fluid.capsule, edits: { "wrong-id": { x: 0, y: 0, scale: 1, angle: 0 } } },
    ]) {
      const invalid = clone(doc); invalid.designs.fluid.capsule = bad as Recipe["capsule"];
      expect(() => parseDocument(invalid)).toThrow();
    }
  });

  it("keeps character independent and locks the capsule rhythm during variant generation", () => {
    const r = fitted(), initial = generateArtwork(r, font);
    r.character.enabled = true;
    expect(generateArtwork(r, font).elements).toEqual(initial.elements);
    r.character.enabled = false;
    const locked = variantOf(r, 98765, { layout: true, mask: true });
    expect(shapePath(locked)).toBe(shapePath(r)); expect(locked.capsule).toEqual(r.capsule);
    const variant = variantOf(r, 98765, { layout: false, mask: true });
    expect(shapePath(variant)).not.toBe(shapePath(r)); expect(variant.text).toBe(r.text);
  });

  it("exports the combined letter / capsule shapes without editable guides or live text", () => {
    const doc = newDocument(); doc.designs.fluid = fitted();
    const art = generateArtwork(doc.designs.fluid, font), svg = artworkSvg(art, doc);
    expect(svg).toContain(pathData(art.a)); expect(svg).not.toMatch(/<text|<image|editor-only|data-capsule-target/);
    const geometry = JSON.parse(geometryJson(art, doc));
    expect(geometry.recipe.designs.fluid.capsule).toEqual(doc.designs.fluid.capsule);
    expect(geometry.sets.A).toEqual(art.a);
  });

  it("reports impossible carrier layouts and excessive word rows without dropping text", () => {
    const r = fitted(); r.width = 20; r.margin = 5; r.capsule.lanes = 3; r.capsule.gap = 5;
    expect(() => generateArtwork(r, font)).toThrow("膠囊");
    r.width = 50; r.capsule.units = "words"; r.capsule.lanes = 1; r.text = "A B C D E F G H";
    expect(() => generateArtwork(r, font)).toThrow("最多 6 排");
  });
});
