import { describe, expect, it } from "vitest";
import { buildGeometry, validateDesign } from "./geometry";
import { DEFAULT_CONFIG } from "./model";
import { area, componentAt, intersect, rectRing, setArea, shape } from "./polygons";
import { electricalEstimate, sealProcess } from "./process";
import { laserFillLines } from "./laser";

describe("manufacturing geometry", () => {
  it("keeps the default electrically connected and fills every cavity top-to-bottom", () => {
    const c = { ...DEFAULT_CONFIG, bindingWidthMm: sealProcess(DEFAULT_CONFIG).recommendedBindingMm };
    const g = buildGeometry(c);
    expect(g.fabrication.errors).toEqual([]);
    expect(validateDesign(c, g).filter((w) => w.severity === "error")).toEqual([]);
    for (const terminal of g.terminals) {
      const fto = g.fabrication.retainedFto["glass-6066"];
      expect(componentAt(terminal.contact, fto)).toBe(componentAt(g.cells[terminal.cellIndex].site, fto));
      expect(componentAt(terminal.contact, fto)).toBeGreaterThanOrEqual(0);
    }
    const ports = g.fabrication.ports;
    const reachesAll = (edges: typeof ports) => {
      const covered = new Set<number>();
      const walk = (edge: typeof ports[number], cells: number[]) => {
        if (edge.to === "bottom") { cells.forEach((i) => covered.add(i)); return; }
        const cell = edge.to;
        for (const next of edges) if (next.from === cell && next.y >= edge.y + edge.height - 1e-7) {
          walk(next, [...cells, cell]);
        }
      };
      edges.filter((e) => e.from === "top").forEach((e) => walk(e, []));
      return covered.size === g.cells.length;
    };
    expect(reachesAll(ports)).toBe(true);
    ports.forEach((p) => {
      expect(reachesAll(ports.filter((e) => e !== p))).toBe(false);
      expect(setArea(intersect(g.fabrication.sealPrint, shape(rectRing(p))))).toBeCloseTo(0, 8);
      expect(p.width).toBeGreaterThan(p.finalWidthMm);
    });
  });

  it("balances partitions without trimming larger coatings to force exact equality", () => {
    const g0 = buildGeometry({ ...DEFAULT_CONFIG, areaBalance: 0 });
    const g1 = buildGeometry({ ...DEFAULT_CONFIG, areaBalance: 1 });
    expect(g1.fabrication.areaCv).toBeLessThan(g0.fabrication.areaCv);
    expect(g1.fabrication.coatingClearance.method).toBe("parallel-wall-offset-no-trimming");
    expect(Math.min(...g1.fabrication.cellAreasMm2)).toBeGreaterThan(Math.min(...g0.fabrication.cellAreasMm2));
    g1.fabrication.activeRegions.forEach((r, i) => {
      expect(area(r)).toBeCloseTo(g1.fabrication.cellAreasMm2[i], 7);
      expect(setArea(intersect(shape(r), g1.fabrication.sealAssembled))).toBeLessThan(1e-4);
    });
    const e = electricalEstimate({ ...DEFAULT_CONFIG, electricalBasis: "jsc-input", cellVocV: 0.65, referenceVoltageObservation: "manual" }, g1.fabrication.cellAreasMm2);
    expect(e.vocV).toBeCloseTo(16 * 0.65);
    expect(e.iscMa).toBeCloseTo(Math.min(...g1.fabrication.cellAreasMm2) / 100 * 10);
  });

  it("uses screen mesh, bead D90 and pressure / viscosity independently", () => {
    const p = sealProcess(DEFAULT_CONFIG);
    expect(p.pitchUm).toBe(127);
    expect(p.apertureUm).toBe(87);
    expect(sealProcess({ ...DEFAULT_CONFIG, beadGradeMesh: 1200 }).localOpeningEstimateMm).toBe(p.localOpeningEstimateMm);
    expect(sealProcess({ ...DEFAULT_CONFIG, screenMeshPerInch: 400 }).errors.length).toBeGreaterThan(0);
    const thick = { ...DEFAULT_CONFIG, emulsionUm: 70, pressPressureKpa: 1, pressTimeS: 1 };
    expect(sealProcess({ ...thick, sealantViscosityMpas: 46000 }).spreadMm)
      .toBeLessThanOrEqual(sealProcess({ ...thick, sealantViscosityMpas: 30000 }).spreadMm);
  });

  it("fills broad etches with mirrored, alternating scans at bounded pitch", () => {
    const c = { ...DEFAULT_CONFIG, ftoEtchWidthMm: 1, laserSpotMm: 0.04, laserHatchMm: 0.03 };
    const g = buildGeometry(c);
    const lines = laserFillLines(c, g, "glass-6060");
    expect(lines.length).toBeGreaterThan(g.etchPaths["glass-6060"].length * 10);
    const unmirrored = laserFillLines({ ...c, mirrorGlass6060: false }, g, "glass-6060");
    lines.forEach((s, i) => {
      expect(s.start.x + unmirrored[i].start.x).toBeCloseTo(g.glass6060.width);
      expect(s.start.y).toBeCloseTo(unmirrored[i].start.y);
    });
  });
});
