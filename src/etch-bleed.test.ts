import { describe, expect, it } from "vitest";
import { buildGeometry } from "./geometry";
import { DEFAULT_CONFIG } from "./model";
import { componentAt, center } from "./polygons";
import { laserFillLines } from "./laser";

describe("unframed Voronoi etch bleed", () => {
  it.each([0.3, 1, 3])("bleeds Voronoi boundaries without a rectangle at width %s", (bindingWidthMm) => {
    // Isolate FTO topology from unmeasured thick-film stress scenarios.
    const c = { ...DEFAULT_CONFIG, bindingWidthMm, measuredWetFilmUm: 15 };
    const g = buildGeometry(c);
    expect(g.fabrication.errors).toEqual([]);
    expect(Object.values(g.fabrication.terminalCheck).every(Boolean)).toBe(true);
    for (const plate of ["glass-6066", "glass-6060"] as const) {
      const paths = g.etchPaths[plate];
      const glass = plate === "glass-6066" ? g.glass6066 : g.glass6060;
      expect(paths.every((p) => p.source === "electrode-voronoi" || p.source === "voronoi-bleed")).toBe(true);
      for (const p of paths.filter((p) => p.source === "voronoi-bleed")) {
        const b = g.boundaries[p.boundaryIndex!];
        expect([b.start, b.end]).toContainEqual(p.start);
        expect(Math.min(Math.abs(p.end.x - glass.x), Math.abs(p.end.x - glass.x - glass.width),
          Math.abs(p.end.y - glass.y), Math.abs(p.end.y - glass.y - glass.height))).toBeLessThan(1e-7);
      }
      const islands = g.cells.map((cell) => componentAt(center(g.fabrication.activeRegions[cell.index]), g.fabrication.retainedFto[plate]));
      for (let i = 0; i < islands.length; i++) for (let j = i + 1; j < islands.length; j++) {
        const expected = j === i + 1 && (i % 2 === 0 ? "glass-6060" : "glass-6066") === plate;
        expect(islands[i] === islands[j], `${plate}: cells ${i + 1}/${j + 1}`).toBe(expected);
      }
    }
  });

  it("does not invent an etch frame on the uncut plate of a two-cell module", () => {
    const g = buildGeometry({ ...DEFAULT_CONFIG, subcellCount: 2 });
    expect(g.etchPaths["glass-6060"]).toEqual([]);
    expect(g.fabrication.errors).toEqual([]);
  });

  it("uses one shared line in each marked side band, with all branches forming T junctions", () => {
    const c = { ...DEFAULT_CONFIG, bindingWidthMm: 1, screenMeshPerInch: 140, screenWireUm: 14 };
    const g = buildGeometry(c), paths = g.etchPaths["glass-6066"];
    expect(g.fabrication.errors).toEqual([]);
    const shared = paths.filter((p) => p.sharedSide);
    expect(shared).toHaveLength(2);
    for (const side of ["left", "right"] as const) {
      const own = shared.filter((p) => p.sharedSide === side);
      expect(own).toHaveLength(1);
      const trunk = own[0], x = side === "left" ? g.active.x : g.active.x + g.active.width;
      expect(trunk.start.x).toBe(x); expect(trunk.end.x).toBe(x);
      const lo = Math.min(trunk.start.y, trunk.end.y), hi = Math.max(trunk.start.y, trunk.end.y);
      const tips = g.boundaries.filter((b) => b.etchPlates.includes("glass-6066"))
        .flatMap((b) => [b.start, b.end]).filter((p) => Math.abs(p.x - x) < 1e-7 && p.y > g.active.y + 1e-7 && p.y < g.active.y + g.active.height - 1e-7);
      expect(tips.length).toBeGreaterThan(1);
      tips.forEach((p) => { expect(p.y).toBeGreaterThanOrEqual(lo); expect(p.y).toBeLessThanOrEqual(hi); });
      // At several levels inside the red-marked bands there must be exactly
      // one crossing, rather than several close but distinct parallel rays.
      for (const f of [0.13, 0.37, 0.73]) {
        const y = lo + (hi - lo) * f;
        const stripX = side === "left" ? g.terminals[0].contactStrip.x + g.terminals[0].contactStrip.width : g.terminals[1].contactStrip.x;
        const hits = paths.flatMap((p) => {
          if (y <= Math.min(p.start.y, p.end.y) || y >= Math.max(p.start.y, p.end.y)) return [];
          const at = p.start.x + (p.end.x - p.start.x) * (y - p.start.y) / (p.end.y - p.start.y);
          return at >= Math.min(x, stripX) - 1e-7 && at <= Math.max(x, stripX) + 1e-7 ? [at] : [];
        });
        expect(hits).toHaveLength(1); expect(hits[0]).toBeCloseTo(x, 7);
      }
    }
    const scans = laserFillLines(c, g, "glass-6066");
    const keys = scans.map((s) => [s.start, s.end].map((p) => `${p.x.toFixed(7)},${p.y.toFixed(7)}`).sort().join("/"));
    expect(new Set(keys).size).toBe(scans.length);
  });
});
