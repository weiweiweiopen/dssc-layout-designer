import { describe, expect, it } from "vitest";
import { DEFAULT_CONFIG } from "./model";
import { electricalEstimate } from "./process";
import { FTO_PRESETS, ftoResistance, solveSeriesScenario, stripCollectionSquares } from "./electrical";
import { buildGeometry } from "./geometry";
import { updateProcessConfig } from "./process";
import { DSSC_REFERENCE, VOLTAGE_OBSERVATIONS } from "./reference-data";

const densityConfig = { ...DEFAULT_CONFIG, electricalBasis: "jsc-input" as const, referenceVoltageObservation: "manual" as const, cellVocV: 0.65 };

describe("W-type series current estimate", () => {
  it("uses the weakest active cell, retaining its identity and correct area units", () => {
    const e = electricalEstimate({ ...densityConfig, jscMaCm2: 15, irradianceMwCm2: 100 }, [300, 100, 200]);
    // 100 mm² = 1 cm²: 15 mA, rather than sum 90 mA or mean 30 mA.
    expect(e.iscMa).toBe(15);
    expect(e.minimumAreaMm2).toBe(100);
    expect(e.limitingCellNumber).toBe(2);
    expect(e.cellIscMa).toEqual([45, 15, 30]);
  });

  it("adding equally sized series cells raises voltage without multiplying current", () => {
    const c = { ...densityConfig, cellVocV: 0.7, jscMaCm2: 15, irradianceMwCm2: 100 };
    const pair = electricalEstimate(c, [100, 100]);
    const six = electricalEstimate(c, [100, 100, 100, 100, 100, 100]);
    expect(pair.iscMa).toBe(15);
    expect(six.iscMa).toBe(pair.iscMa);
    expect(six.vocV).toBeCloseTo(4.2);
    expect(six.vocV).toBeCloseTo(pair.vocV * 3);
    expect(electricalEstimate({ ...c, irradianceMwCm2: 50 }, [100, 100]).iscMa).toBe(7.5);
  });

  it("a missing active cell limits the string to zero; an empty layout has no limiting cell", () => {
    expect(electricalEstimate(densityConfig, [100, 0, 100]).iscMa).toBe(0);
    expect(electricalEstimate(densityConfig, []).iscMa).toBe(0);
    expect(electricalEstimate(DEFAULT_CONFIG, []).limitingCellNumber).toBeNull();
  });
});

describe("measured-reference calibration", () => {
  it("does not invent the reference active area or fall back to old Jsc", () => {
    const e = electricalEstimate({ ...DEFAULT_CONFIG, referenceAreaMm2: 0, jscMaCm2: 15 }, [280.09, 350]);
    expect(e.iscMa).toBeNull();
    expect(e.scenario).toBeNull();
    expect(e.issues.length).toBeGreaterThan(0);
  });

  it("normalizes a 39 mA whole-cell reference by its area and illumination", () => {
    const c = { ...DEFAULT_CONFIG, referenceLightMode: "irradiance" as const, referenceAreaMm2: 3600, referenceIrradianceMwCm2: 50, irradianceMwCm2: 50 };
    const e = electricalEstimate(c, [280.09, 350]);
    expect(e.iscMa).toBeCloseTo(39 * 280.09 / 3600, 10);
    expect(e.effectiveJscMaCm2).toBeCloseTo(39 / 36 * 2, 10);
    expect(electricalEstimate({ ...c, irradianceMwCm2: 100 }, [280.09, 350]).iscMa).toBeCloseTo(e.iscMa! * 2, 10);
  });

  it("de-embeds reference Rs and reproduces the independently specified reference Isc", () => {
    const c = { ...DEFAULT_CONFIG, referenceVoltageObservation: "manual" as const, referenceAreaMm2: 3600, referenceSeriesOhm: 5, cellVocV: 0.7 };
    const e = electricalEstimate(c, [3600]);
    const photo = e.calibration.referencePhotoMa!;
    const dark = photo / Math.expm1(0.7 / 0.05);
    expect(photo).toBeGreaterThan(39);
    expect(solveSeriesScenario([photo], [dark], 0.05, 5)!.iscMa).toBeCloseTo(39, 10);
    expect(electricalEstimate({ ...c, ftoBiggerOhmSq: 7 }, [3600]).calibration.referencePhotoMa).toBe(photo);
    expect(electricalEstimate({ ...c, referenceSeriesOhm: 100 }, [3600]).calibration.referenceFitValid).toBe(false);
  });

  it("uses the regenerated six-cell active areas without confusing intrinsic Jsc with a whole-cell reference", () => {
    const c = { ...densityConfig, subcellCount: 6, electrodeSeed: 4361322,
      bindingWidthMm: 1, screenMeshPerInch: 140, screenWireUm: 14, cellVocV: 0.7, jscMaCm2: 15 };
    const g = buildGeometry(c);
    const raw = electricalEstimate(c, g.fabrication.cellAreasMm2, g);
    const ref = electricalEstimate({ ...c, electricalBasis: "reference-cell", referenceAreaMm2: 3025 }, g.fabrication.cellAreasMm2, g);
    expect(raw.minimumAreaMm2).toBeGreaterThan(280.09);
    expect(raw.iscMa! / ref.iscMa!).toBeCloseTo(15 * 30.25 / 39, 10);
    expect(ref.scenario).not.toBeNull();
    expect(ref.scenario!.iscMa).toBeLessThanOrEqual(ref.iscMa! + 1e-9);
  });
});

describe("DSSC 55×55 A observation calibration", () => {
  it("uses the confirmed active area and the user's current interval at the same reference light", () => {
    const e = electricalEstimate(DEFAULT_CONFIG, [280.09, 350]);
    expect(DEFAULT_CONFIG.referenceAreaMm2).toBe(3025);
    expect(e.iscMa).toBeCloseTo(39 * 280.09 / 3025, 12);
    expect(e.range!.lowMa).toBeCloseTo(38 * 280.09 / 3025, 12);
    expect(e.range!.highMa).toBeCloseTo(40 * 280.09 / 3025, 12);
    expect(e.referenceCurrentDensityMaCm2).toBeCloseTo(39 / 30.25, 12);
    expect(e.effectiveJscMaCm2).toBeNull();
    expect(e.calibration.referenceIrradianceMwCm2).toBeNull();
  });

  it("keeps older A's voltage aging separate from Isc and unpaired I–V fits", () => {
    const early = electricalEstimate(DEFAULT_CONFIG, [280.09, 350]);
    const aged = electricalEstimate(updateProcessConfig(DEFAULT_CONFIG, "referenceVoltageObservation", "a-2026-10-25"), [280.09, 350]);
    expect(early.vocV).toBeCloseTo(2 * 0.4971, 12);
    expect(aged.vocV).toBeCloseTo(2 * 0.328625, 12);
    expect(aged.iscMa).toBe(early.iscMa);
    expect(aged.range).toEqual(early.range);
    expect(aged.scenario).toBeNull();
    expect(aged.calibration.referencePhotoMa).toBeNull();
    expect(aged.calibration.referenceFitValid).toBe(false);
    expect(aged.calibration.currentAgingDerivedFromVoc).toBe(false);
    expect(aged.voltageObservation!.retentionPct).toBe(66.108);
    expect(DSSC_REFERENCE.firstObservedAt < DSSC_REFERENCE.comparison.firstObservedAt).toBe(true);
    expect(Object.values(VOLTAGE_OBSERVATIONS).every((r) => r.quality === "complete" || r.quality === "fixed-baseline")).toBe(true);
  });

  it("requires an Isc-paired lux input and never uses the online Voc baseline as a substitute", () => {
    const c = { ...DEFAULT_CONFIG, referenceLightMode: "lux-ratio" as const, illuminanceLux: 942.5 };
    expect(electricalEstimate(c, [280.09, 350]).iscMa).toBeNull();
    const measured = { ...c, referenceLux: 1000, illuminanceLux: 500 };
    const e = electricalEstimate(measured, [280.09, 350]);
    expect(e.iscMa).toBeCloseTo(39 * 280.09 / 3025 * 0.5, 12);
    expect(e.effectiveJscMaCm2).toBeNull();
    expect(e.calibration.referenceIrradianceMwCm2).toBeNull();
    expect(electricalEstimate({ ...DEFAULT_CONFIG, irradianceMwCm2: 1 }, [280.09, 350]).iscMa)
      .toBe(electricalEstimate(DEFAULT_CONFIG, [280.09, 350]).iscMa);
  });
});

describe("FTO electrical scenarios", () => {
  it("uses source typical values rather than treating TEC names as exact resistance", () => {
    expect(FTO_PRESETS.tec15.ohmSq).toBe(13);
    const c = updateProcessConfig(DEFAULT_CONFIG, "ftoBiggerPreset", "tec7");
    expect(c.ftoBiggerOhmSq).toBe(7);
    expect(c.ftoSmallerOhmSq).toBe(13);
    expect(updateProcessConfig(c, "ftoBiggerOhmSq", 9).ftoBiggerPreset).toBe("custom");
  });

  it("matches distributed-strip collection and length/width scaling, including the lead", () => {
    expect(stripCollectionSquares(100, 10)).toBeCloseTo(1 / 3, 12);
    expect(stripCollectionSquares(200, 10)).toBeCloseTo(2 / 3, 12);
    expect(stripCollectionSquares(100, 10, 2)).toBeCloseTo(1 / 3 + 0.2, 12);
    expect(stripCollectionSquares(100, 0)).toBeNull();
  });

  it("counts both plates, responds independently to each sheet resistance, and preserves artwork", () => {
    const g = buildGeometry(DEFAULT_CONFIG);
    const r13 = ftoResistance(DEFAULT_CONFIG, g);
    const r7 = ftoResistance({ ...DEFAULT_CONFIG, ftoBiggerOhmSq: 7, ftoSmallerOhmSq: 7 }, g);
    expect(r13.paths).toHaveLength(2 * g.cells.length);
    expect(r13.totalOhm).toBeGreaterThan(0);
    expect(r7.totalOhm! / r13.totalOhm!).toBeCloseTo(7 / 13, 12);
    const c = { ...densityConfig, jscMaCm2: 30, ftoBiggerOhmSq: 500, ftoSmallerOhmSq: 500 };
    const highR = electricalEstimate(c, g.fabrication.cellAreasMm2, g);
    const lowR = electricalEstimate({ ...c, ftoBiggerOhmSq: 7, ftoSmallerOhmSq: 7 }, g.fabrication.cellAreasMm2, g);
    expect(highR.scenario!.iscMa).toBeLessThan(lowR.scenario!.iscMa);
    expect(highR.scenario!.mpp.powerMw).toBeLessThan(lowR.scenario!.mpp.powerMw);
    expect(buildGeometry(c).etchPaths).toEqual(g.etchPaths);
  });

  it("solves a known diode operating point; zero Rs and Voc behave physically", () => {
    // At I=50 mA, Vdiode=50 mV*ln(51); selecting R=V/0.05 A puts that at short circuit.
    const r = 0.05 * Math.log(51) / 0.05;
    const e = solveSeriesScenario([100], [1], 0.05, r)!;
    expect(e.iscMa).toBeCloseTo(50, 10);
    expect(e.voltageResidualAtIscV).toBeCloseTo(0, 12);
    const ideal = solveSeriesScenario([100], [1], 0.05, 0)!;
    expect(ideal.iscMa).toBe(100);
    expect(e.vocV).toBe(ideal.vocV);
    expect(e.mpp.powerMw).toBeLessThan(ideal.mpp.powerMw);
    expect(solveSeriesScenario([0], [1], 0.05, 20)!.iscMa).toBe(0);
    expect(solveSeriesScenario([100], [1], 0.05, -1)).toBeNull();
  });
});
