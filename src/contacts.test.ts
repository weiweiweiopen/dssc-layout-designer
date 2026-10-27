import { describe, expect, it } from "vitest";
import { zebraContactRegions } from "./contacts";
import { buildGeometry, validateDesign } from "./geometry";
import { DEFAULT_CONFIG } from "./model";
import { difference, rectRing, shape } from "./polygons";
import { migrateGlassHeight } from "./process";

describe("shared-height glass and exposed zebra contacts", () => {
  it.each([
    [66, 60, 60, 3, 180],
    [70, 58, 64, 6, 384],
    [80, 60, 70, 10, 700],
  ])("places two correct full-height exposed contacts for %s / %s × %s mm", (bigger, smaller, height, width, area) => {
    const g = buildGeometry({ ...DEFAULT_CONFIG, glass6066WidthMm: bigger, glass6060WidthMm: smaller, glassHeightMm: height });
    expect(g.glass6066.height).toBe(height);
    expect(g.glass6060.height).toBe(height);
    expect(g.glass6060.y).toBe(0);
    const contacts = zebraContactRegions(g);
    expect(contacts.map((c) => c.polarity)).toEqual(["negative", "positive"]);
    expect(contacts.map((c) => c.strip.x)).toEqual([0, (bigger + smaller) / 2]);
    for (const contact of contacts) {
      expect(contact.strip.width).toBe(width);
      expect(contact.strip.height).toBe(height);
      expect(contact.areaMm2).toBeCloseTo(area, 6);
      expect(contact.connected && contact.continuous).toBe(true);
    }
  });

  it("counts retained FTO rather than including removed material in the exposed rectangle", () => {
    const g = buildGeometry(DEFAULT_CONFIG);
    const before = zebraContactRegions(g);
    g.fabrication.retainedFto["glass-6066"] = difference(g.fabrication.retainedFto["glass-6066"],
      shape(rectRing({ ...before[0].strip, width: 1 })));
    const after = zebraContactRegions(g);
    expect(after[0].areaMm2).toBeCloseTo(before[0].areaMm2 - DEFAULT_CONFIG.glassHeightMm, 6);
    expect(after[1].areaMm2).toBeCloseTo(before[1].areaMm2, 6);
  });

  it("rejects equal widths instead of inventing contact area", () => {
    const c = { ...DEFAULT_CONFIG, glass6060WidthMm: DEFAULT_CONFIG.glass6066WidthMm };
    const g = buildGeometry(c);
    expect(zebraContactRegions(g).every((r) => r.areaMm2 === 0)).toBe(true);
    expect(validateDesign(c, g).some((w) => w.severity === "error" && w.message.includes("斑馬條接觸區"))).toBe(true);
  });

  it("migrates to a single canonical height with a deterministic legacy preference", () => {
    expect(migrateGlassHeight({ glassHeightMm: 72, glass6066HeightMm: 64, glass6060HeightMm: 54 })).toBe(72);
    expect(migrateGlassHeight({ glass6066HeightMm: 64, glass6060HeightMm: 54 })).toBe(64);
    expect(migrateGlassHeight({ glass6060HeightMm: 54 })).toBe(54);
    expect(migrateGlassHeight({})).toBe(60);
  });
});
