import { describe, expect, it } from "vitest";
import { buildGeometry } from "./geometry";
import { DEFAULT_CONFIG, type DesignConfig, type PlateId, type Point } from "./model";
import { buildFabricationGeometry } from "./fabrication-geometry";
import { center, componentAt } from "./polygons";
import { buildFabricationAssets } from "./svg";
import { buildPointCodeArtwork } from "./point-code";
import { stripNonPrintingGuides } from "./export";
import { laserFillLines } from "./laser";

function components(c: DesignConfig, plate: PlateId = "glass-6066") {
  const g = buildGeometry(c);
  const fto = g.fabrication.retainedFto[plate];
  return { g, at: (p: Point) => componentAt(p, fto) };
}

describe("6066 complete-plate terminal isolation", () => {
  it("has continuous glass-top to glass-bottom cuts that go around the endpoint cells", () => {
    const c = { ...DEFAULT_CONFIG, bindingWidthMm: 1, screenMeshPerInch: 140, screenWireUm: 14 };
    const { g, at } = components(c);
    const cuts = g.etchPaths["glass-6066"].filter((p) => p.source === "voronoi-bleed");
    expect(cuts.length).toBeGreaterThan(0);
    for (const [i, terminal] of g.terminals.entries()) {
      const x = i === 0 ? g.active.x : g.active.x + g.active.width;
      const route = g.fabrication.isolationRoutes["glass-6066"][i];
      expect(route.points[0].y).toBe(g.glass6066.y);
      expect(route.points.at(-1)!.y).toBe(g.glass6066.y + g.glass6066.height);
      expect(route.continuousTopToBottom).toBe(true);
      // Each intermediate portion is removed FTO too, not just the four stubs.
      route.points.slice(1).forEach((p, n) => {
        const a = route.points[n];
        for (const t of [0.1, 0.5, 0.9]) expect(at({ x: a.x + (p.x - a.x) * t, y: a.y + (p.y - a.y) * t })).toBe(-1);
      });
      expect(at(terminal.contact)).toBe(at(center(g.fabrication.activeRegions[terminal.cellIndex])));
      expect(at(terminal.contact)).toBeGreaterThanOrEqual(0);
      expect(at({ x, y: (terminal.gate.start.y + terminal.gate.end.y) / 2 })).toBe(at(terminal.contact));
    }
    expect(at(g.terminals[0].contact)).not.toBe(at(g.terminals[1].contact));
    expect(Object.values(g.fabrication.terminalCheck).every(Boolean)).toBe(true);
    expect(g.fabrication.isolationRoutes["glass-6060"]).toEqual([]);
    const svg = stripNonPrintingGuides(buildFabricationAssets(c, g, buildPointCodeArtwork(c, g))
      .find((a) => a.id === "fto-etch-glass-6066")!.svg);
    expect(svg.match(/data-source="voronoi-bleed"/g)).toHaveLength(cuts.length);
    expect(svg).not.toMatch(/data-source="active-perimeter"|data-source="terminal-isolation"/);
  });

  it.each([0.3, 1, 3])("has no top/bottom bypass with binding width %s mm", (bindingWidthMm) => {
    const { g, at } = components({ ...DEFAULT_CONFIG, bindingWidthMm });
    expect(at(g.terminals[0].contact)).not.toBe(at(g.terminals[1].contact));
    for (const t of g.terminals) for (const amount of [0.01, 0.25, 0.5, 0.75, 0.99]) {
      const p = { x: t.contactStrip.x + t.contactStrip.width / 2, y: amount * g.glass6066.height };
      expect(at(p)).toBe(at(t.contact));
    }
  });

  it("detects an actual annular short if the top and bottom crosscuts are omitted", () => {
    const c = { ...DEFAULT_CONFIG, bindingWidthMm: 1 };
    const g = buildGeometry(c);
    g.etchPaths["glass-6066"] = g.etchPaths["glass-6066"].filter((p) => p.source !== "voronoi-bleed");
    const f = buildFabricationGeometry(c, g);
    expect(componentAt(g.terminals[0].contact, f.retainedFto["glass-6066"]))
      .toBe(componentAt(g.terminals[1].contact, f.retainedFto["glass-6066"]));
    expect(f.errors.some((e) => e.includes("接觸條") && e.includes("短路"))).toBe(true);
    expect(f.terminalCheck.isolated).toBe(false);
  });

  it("rejects isolation that stops 0.1 mm short of the real glass edge", () => {
    const c = { ...DEFAULT_CONFIG, bindingWidthMm: 1 };
    const g = buildGeometry(c);
    for (const path of g.etchPaths["glass-6066"]) {
      if (path.source === "voronoi-bleed" && path.glassEdge === "top") path.end.y += 0.1;
    }
    const f = buildFabricationGeometry(c, g);
    expect(f.terminalCheck.fullHeightIsolation).toBe(false);
    expect(f.terminalCheck.isolated).toBe(false);
    expect(f.errors.some((e) => e.includes("隔離路徑未連續貫穿"))).toBe(true);
  });

  it("also isolates the full margins of resized shared-height plates", () => {
    const { g, at } = components({ ...DEFAULT_CONFIG, glass6066WidthMm: 70, glassHeightMm: 66,
      glass6060WidthMm: 58 });
    expect(Object.values(g.fabrication.terminalCheck).every(Boolean)).toBe(true);
    expect(at(g.terminals[0].contact)).not.toBe(at(g.terminals[1].contact));
    for (const t of g.terminals) for (const y of [0.1, 33, 65.9]) {
      expect(at({ x: t.contact.x, y })).toBe(at(t.contact));
    }
  });

  it("does not retract laser scans from either physical glass edge", () => {
    const c = { ...DEFAULT_CONFIG, bindingWidthMm: 1 };
    const g = buildGeometry(c);
    for (const plate of ["glass-6066", "glass-6060"] as const) {
      const scans = laserFillLines(c, g, plate);
      const glass = plate === "glass-6066" ? g.glass6066 : g.glass6060;
      g.etchPaths[plate].forEach((path, pathIndex) => {
        if (path.source !== "voronoi-bleed") return;
        const own = scans.filter((s) => s.pathIndex === pathIndex);
        expect(own.length).toBeGreaterThan(0);
        for (const scan of own) expect([scan.start, scan.end].some((p) =>
          Math.min(Math.abs(p.x), Math.abs(p.x - glass.width), Math.abs(p.y), Math.abs(p.y - glass.height)) < 1e-7)).toBe(true);
      });
    }
  });
});
