import { readFileSync } from "node:fs";
import { parse, type Font } from "opentype.js";
import { describe, expect, it } from "vitest";
import { componentAt, intersect, setArea } from "../polygons";
import { generateArtwork, pathData, pixelate } from "./geometry";
import { clone, newDocument, parseDocument, recipeFor, variantOf } from "./model";
import { artworkSvg, geometryJson, projectJson } from "./export";

const bytes = readFileSync(new URL("../../node_modules/@fontsource/anybody/files/anybody-latin-900-normal.woff", import.meta.url));
const font: Font = parse(bytes.buffer.slice(bytes.byteOffset, bytes.byteOffset + bytes.byteLength) as ArrayBuffer);
function plain() {
  const r = recipeFor("tall");
  r.text = "O\nB"; r.font = "anybody";
  return r;
}

describe("resolved artwork, independent of W-type partitions", () => {
  it("preserves real O/B counters and partitions the physical frame with no overlaps", () => {
    const r = plain(), art = generateArtwork(r, font);
    expect(art.stats.holes).toBeGreaterThanOrEqual(3);
    expect(art.stats.areaA + art.stats.areaB).toBeCloseTo(r.width * r.height, 5);
    expect(setArea(intersect(art.a, art.b))).toBeLessThan(1e-7);
    const o = art.elements[0].bounds;
    expect(componentAt({ x: o.x + o.width / 2, y: o.y + o.height / 2 }, art.a)).toBe(-1);
    expect(art.elements.map((e) => e.label)).toEqual(["O", "B"]);
  });

  it("resolves true XOR geometry, including the overlap area identity", () => {
    const r = plain(), base = generateArtwork(r, font);
    r.mask.enabled = true; r.mask.shape = "ellipse";
    const flipped = generateArtwork(r, font);
    const inFrameMaskArea = setArea(intersect(flipped.mask, [...base.a, ...base.b]));
    const overlap = setArea(intersect(base.a, flipped.mask));
    expect(flipped.stats.areaA).toBeCloseTo(base.stats.areaA + inFrameMaskArea - 2 * overlap, 4);
    r.mask.operation = "subtract";
    expect(generateArtwork(r, font).stats.areaA).toBeCloseTo(base.stats.areaA - overlap, 4);
    r.mask.operation = "intersect";
    expect(generateArtwork(r, font).stats.areaA).toBeCloseTo(overlap, 4);
  });

  it("pixelizes into merged orthogonal regions rather than thousands of independent cells", () => {
    const base = generateArtwork(plain(), font);
    const stepped = pixelate(base.a, 0.4);
    expect(stepped.length).toBeLessThan(10);
    expect(stepped.reduce((n, p) => n + p.length - 1, 0)).toBeGreaterThanOrEqual(3);
    for (const polygon of stepped) for (const ring of polygon) ring.forEach((p, i) => {
      const q = ring[(i + 1) % ring.length];
      expect(Math.abs(p.x - q.x) < 1e-6 || Math.abs(p.y - q.y) < 1e-6).toBe(true);
    });
  });

  it("reports counters lost to a coarse pixel grid instead of claiming preservation", () => {
    const r = plain(); r.flavor = "pixel"; r.preset = "steps"; r.pixel.pitch = 0.8;
    expect(generateArtwork(r, font).warnings.join(" ")).toContain("孔洞／字腔");
  });

  it("makes seeded cuts / damage reproducible without changing text into Unicode noise", () => {
    const r = recipeFor("cuts"); r.text = "SOLAR\nORACLE"; r.pixel.damage = 0.2;
    const a = generateArtwork(r, font), b = generateArtwork(clone(r), font);
    expect(a.a).toEqual(b.a);
    r.seed += 171;
    const changed = generateArtwork(r, font);
    expect(pathData(changed.a)).not.toBe(pathData(a.a));
    expect(r.text).toBe("SOLAR\nORACLE");
  });

  it("keeps original glyphs and placement unchanged when only the character is toggled / reseeded", () => {
    const r = plain(), before = generateArtwork(r, font);
    r.character.enabled = true;
    const on = generateArtwork(r, font);
    expect(on.elements).toEqual(before.elements);
    expect(on.character.length).toBeGreaterThan(0);
    expect(on.a).not.toEqual(before.a);
    r.character.seed++;
    expect(generateArtwork(r, font).character).not.toEqual(on.character);
    r.character.enabled = false;
    expect(generateArtwork(r, font).a).toEqual(before.a);
  });

  it("deforms from source geometry and supports independent glyph edits", () => {
    const r = plain(), base = generateArtwork(r, font);
    r.warp.cage[4] = { x: 0.08, y: -0.06 };
    expect(generateArtwork(r, font).a).not.toEqual(base.a);
    r.warp.cage[4] = { x: 0, y: 0 };
    expect(generateArtwork(r, font).a).toEqual(base.a);
    r.edits["0:0"] = { x: 1, y: 0.5, angle: 12, scale: 0.8 };
    const edited = generateArtwork(r, font);
    expect(edited.elements[1]).toEqual(base.elements[1]);
    expect(edited.elements[0]).not.toEqual(base.elements[0]);
  });

  it("supports empty lines, space slots, and geometry-only capsule composition", () => {
    const r = plain(); r.text = "O O\n\nB";
    const art = generateArtwork(r, font);
    expect(art.elements.filter((e) => e.kind === "glyph")).toHaveLength(3);
    r.text = ""; r.preset = "capsules";
    expect(generateArtwork(r, font).stats.areaA).toBeGreaterThan(100);
  });

  it("rejects impossible line spacing rather than silently flipping glyph geometry", () => {
    const r = plain(); r.height = 20; r.margin = 5; r.lineGap = 3; r.text = "A\nB\nC\nD\nE\nF";
    expect(() => generateArtwork(r, font)).toThrow("字面高度");
  });

  it("exports two actual outlined sets with no text, guides, masks or external font references", () => {
    const doc = newDocument(); doc.designs.fluid = plain();
    const art = generateArtwork(doc.designs.fluid, font), svg = artworkSvg(art, doc);
    expect(svg).toContain('width="50mm"');
    expect(svg).toContain('id="SET_A"'); expect(svg).toContain('id="SET_B"');
    expect(svg).not.toMatch(/<text|<mask|<clipPath|<image|<use|editor-only|font-family|href=/);
    expect(svg).toContain(pathData(art.a));
    const data = JSON.parse(geometryJson(art, doc));
    expect(data.stage).toBe("resolved-artwork-not-fabrication");
    expect(data.materialMapping).toBeNull(); expect(data.electricalChecks).toBeNull();
    expect(data.sets.A).toEqual(art.a);
  });

  it("round-trips both flavors and rejects invalid / excessive imported recipes", () => {
    const doc = newDocument(); doc.designs.pixel.pixel.damage = 0.12;
    expect(parseDocument(JSON.parse(projectJson(doc)))).toEqual(doc);
    for (const corrupt of [
      (d: typeof doc) => { d.designs.fluid.warp.cage = []; },
      (d: typeof doc) => { d.designs.pixel.pixel.pitch = 0.0001; },
      (d: typeof doc) => { d.designs.fluid.text = "A\u0301"; },
      (d: typeof doc) => { d.designs.fluid.width = Infinity; },
      (d: typeof doc) => { d.designs.pixel.font = "custom"; },
    ]) { const bad = clone(doc); corrupt(bad); expect(() => parseDocument(bad)).toThrow(); }
  });

  it("generates variants from independent streams and respects locks", () => {
    const r = recipeFor("squeeze");
    const a = variantOf(r, 54, { layout: false, mask: false });
    expect(a).toEqual(variantOf(r, 54, { layout: false, mask: false }));
    expect(a.text).toBe(r.text); expect(a.font).toBe(r.font); expect(a.character).toEqual(r.character);
    expect(a.warp).not.toEqual(r.warp);
    const locked = variantOf(r, 54, { layout: true, mask: true });
    expect(locked.warp).toEqual(r.warp); expect(locked.rowWeights).toEqual(r.rowWeights); expect(locked.mask).toEqual(r.mask);
  });
});
