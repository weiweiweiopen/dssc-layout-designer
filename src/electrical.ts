import type { DesignConfig, FtoPreset, LayoutGeometry, PlateId } from "./model";
import { DSSC_REFERENCE, voltageObservation } from "./reference-data";

export const TEC_SOURCE = "https://assetmanager-ws.pilkington.com/fileserver.aspx?cmd=get_file&ref=GL058&cd=cd";
export const SERIES_RESISTANCE_SOURCE = "https://www.pveducation.org/pvcdrom/solar-cell-operation/series-resistance";
export const FTO_PRESETS: Record<Exclude<FtoPreset, "custom">, { name: string; ohmSq: number; upperExclusiveOhmSq: number }> = {
  tec7: { name: "TEC7", ohmSq: 7, upperExclusiveOhmSq: 8 },
  tec8: { name: "TEC8", ohmSq: 8, upperExclusiveOhmSq: 9 },
  tec10: { name: "TEC10", ohmSq: 10, upperExclusiveOhmSq: 11 },
  tec15: { name: "TEC15", ohmSq: 13, upperExclusiveOhmSq: 14 },
  tec20: { name: "TEC20", ohmSq: 19, upperExclusiveOhmSq: 20 },
};

/** Exact for a uniformly generating rectangular strip with a full-width edge
 * collector and an unilluminated lead. Voronoi cells are equivalent strips,
 * NOT a 2-D solution on retained FTO. Both plates' contributions are required. */
export function stripCollectionSquares(areaMm2: number, collectorWidthMm: number, leadMm = 0) {
  return areaMm2 >= 0 && collectorWidthMm > 0 && leadMm >= 0
    ? areaMm2 / (3 * collectorWidthMm ** 2) + leadMm / collectorWidthMm : null;
}

export function ftoResistance(c: DesignConfig, g: LayoutGeometry) {
  const paths = g.cells.flatMap((cell) => (["glass-6066", "glass-6060"] as const).map((plate: PlateId) => {
    const edge = g.boundaries.find((b) => b.seriesConnection && b.connectionPlate === plate && b.cells.includes(cell.index));
    const terminal = g.terminals.find((t) => t.plate === plate && t.cellIndex === cell.index);
    const collector = edge ?? terminal?.gate;
    const region = g.fabrication.activeRegions[cell.index];
    const sheetOhmSq = plate === "glass-6066" ? c.ftoBiggerOhmSq : c.ftoSmallerOhmSq;
    if (!collector || !region.length) return { cellNumber: cell.index + 1, plate, sheetOhmSq, widthMm: 0, leadMm: 0, squares: null, ohm: null };
    const dx = collector.end.x - collector.start.x, dy = collector.end.y - collector.start.y;
    const length = Math.hypot(dx, dy);
    const distance = (p: { x: number; y: number }) => length > 0
      ? Math.abs(dx * (p.y - collector.start.y) - dy * (p.x - collector.start.x)) / length : 0;
    const widthMm = Math.max(0, length - c.ftoEtchWidthMm);
    const leadMm = Math.min(...region.map(distance)) + (terminal ? distance(terminal.contact) : 0);
    const squares = stripCollectionSquares(g.fabrication.cellAreasMm2[cell.index], widthMm, leadMm);
    return { cellNumber: cell.index + 1, plate, sheetOhmSq, widthMm, leadMm, squares,
      ohm: squares === null ? null : squares * sheetOhmSq };
  }));
  const connected = Object.values(g.fabrication.terminalCheck).every(Boolean) &&
    !g.fabrication.errors.some((e) => /導通|FTO|接觸條|串聯|隔離/.test(e));
  const valid = connected && paths.length === 2 * g.cells.length && paths.every((p) => p.ohm !== null && Number.isFinite(p.ohm) && p.ohm >= 0);
  return {
    totalOhm: valid ? paths.reduce((sum, p) => sum + p.ohm!, 0) : null,
    paths,
    model: "equivalent-uniform-strip-collection" as const,
    confidence: "heuristic" as const,
    basis: "Per cell and plate: R = Rsheet * (A / (3 W²) + lead / W); W is the series-edge / terminal-gate length minus etch width. Uniform generation, full-edge ideal collector. No 2-D constriction, busbar/contact, electrolyte, Pt or interfacial resistance. Both plates summed; not a measured module Rs.",
    source: "https://www.pveducation.org/pvcdrom/design-of-silicon-cells/emitter-resistance",
  };
}

/** Forward-branch single-diode scenario. Solve sum(Vcell) - I R = 0 when
 * bracketed below min(Iph); otherwise return that weakest-photocurrent cap.
 * Reverse bias / shunts need measured I-V data and are deliberately not invented. */
export function solveSeriesScenario(photoMa: number[], darkMa: number[], diodeVoltageV: number, resistanceOhm: number) {
  const limitMa = photoMa.length ? Math.min(...photoMa) : 0;
  if (!photoMa.length || photoMa.length !== darkMa.length ||
    photoMa.some((v) => !Number.isFinite(v) || v < 0) || darkMa.some((v) => !Number.isFinite(v) || v <= 0) ||
    !Number.isFinite(diodeVoltageV) || diodeVoltageV <= 0 || !Number.isFinite(resistanceOhm) || resistanceOhm < 0) return null;
  const voltage = (currentMa: number, r: number) => photoMa.reduce((sum, photo, i) =>
    sum + diodeVoltageV * Math.log1p(Math.max(0, photo - currentMa) / darkMa[i]), 0) - currentMa / 1000 * r;
  const current = (r: number) => {
    if (limitMa === 0 || voltage(limitMa, r) >= 0) return limitMa;
    let lo = 0, hi = limitMa;
    for (let k = 0; k < 70; k++) {
      const mid = (lo + hi) / 2;
      if (voltage(mid, r) > 0) lo = mid; else hi = mid;
    }
    return (lo + hi) / 2;
  };
  const mpp = (r: number) => {
    let lo = 0, hi = current(r);
    const power = (i: number) => i * Math.max(0, voltage(i, r)); // mA * V = mW
    for (let k = 0; k < 70; k++) {
      const a = lo + (hi - lo) / 3, b = hi - (hi - lo) / 3;
      if (power(a) < power(b)) lo = a; else hi = b;
    }
    const currentMa = (lo + hi) / 2;
    return { currentMa, voltageV: Math.max(0, voltage(currentMa, r)), powerMw: power(currentMa) };
  };
  const iscMa = current(resistanceOhm);
  return { iscMa, vocV: voltage(0, resistanceOhm), mpp: mpp(resistanceOhm), zeroFtoMpp: mpp(0),
    confidence: "unfitted-scenario" as const,
    photocurrentCapped: limitMa > 0 && voltage(limitMa, resistanceOhm) > 1e-9,
    voltageResidualAtIscV: voltage(iscMa, resistanceOhm),
    model: "single-diode-forward-branch-with-weak-cell-cap" as const };
}

export function electricalEstimate(c: DesignConfig, areas: number[], geometry?: LayoutGeometry) {
  const minimumAreaMm2 = areas.length ? Math.min(...areas) : 0;
  const useReference = c.electricalBasis === "reference-cell";
  const observation = voltageObservation(c.referenceVoltageObservation);
  const scale = !useReference ? c.irradianceMwCm2 / 100 : c.referenceLightMode === "same-light" ? 1
    : c.referenceLightMode === "lux-ratio" ? c.referenceLux > 0 && c.illuminanceLux >= 0 ? c.illuminanceLux / c.referenceLux : null
    : c.referenceIrradianceMwCm2 > 0 && c.irradianceMwCm2 >= 0 ? c.irradianceMwCm2 / c.referenceIrradianceMwCm2 : null;
  const referenceValid = Number.isFinite(c.referenceAreaMm2) && c.referenceAreaMm2 > 0 &&
    scale !== null && Number.isFinite(scale) && scale >= 0 && Number.isFinite(c.referenceIscMa) && c.referenceIscMa >= 0;
  const referenceCurrentDensityMaCm2 = referenceValid ? c.referenceIscMa / (c.referenceAreaMm2 / 100) : null;
  const effectiveJscMaCm2 = useReference
    ? referenceValid && c.referenceLightMode === "irradiance" ? referenceCurrentDensityMaCm2! * 100 / c.referenceIrradianceMwCm2 : null
    : c.jscMaCm2;
  const cellIscMa = useReference ? !referenceValid ? [] : areas.map((area) => area / c.referenceAreaMm2 * c.referenceIscMa * scale!)
    : areas.map((area) => area / 100 * c.jscMaCm2 * scale!);
  const iscMa = useReference && !referenceValid ? null : cellIscMa.length ? Math.min(...cellIscMa) : 0;
  // User's 38–40 mA is a reported interval, not a fitted confidence interval.
  // Voltage retention NEVER enters the current scaling calculation.
  const range = useReference && referenceValid ? {
    lowMa: minimumAreaMm2 / c.referenceAreaMm2 * Math.max(0, c.referenceIscMa - c.referenceIscRangeMa) * scale!,
    highMa: minimumAreaMm2 / c.referenceAreaMm2 * (c.referenceIscMa + c.referenceIscRangeMa) * scale!,
  } : null;
  const fto = geometry ? ftoResistance(c, geometry) : null;
  const a = c.diodeVoltageMv / 1000;
  const exponent = Math.expm1(c.cellVocV / a);
  const referenceDropV = c.referenceIscMa / 1000 * c.referenceSeriesOhm;
  const referenceFitCompatible = !useReference || referenceValid && Number.isFinite(c.referenceSeriesOhm) &&
    c.referenceSeriesOhm >= 0 && referenceDropV < c.cellVocV;
  const referenceFitValid = referenceFitCompatible && !observation;
  // De-embed the independently specified REFERENCE resistance, never the
  // current layout's TEC grade. At zero reference R this is only a scenario:
  // measured terminal Isc is used as an Iph proxy, not certified intrinsic Jsc.
  const referencePhotoMa = useReference && referenceFitValid
    ? c.referenceIscMa / (1 - Math.expm1(referenceDropV / a) / exponent) : null;
  const referencePhotoJ = useReference ? referencePhotoMa === null ? null : referencePhotoMa / (c.referenceAreaMm2 / 100) : c.jscMaCm2;
  const photoMa = referencePhotoJ === null || scale === null ? [] : areas.map((area) => area / 100 * referencePhotoJ * scale);
  const darkMa = referencePhotoJ === null ? [] : areas.map((area) => area / 100 * referencePhotoJ / exponent);
  // The website's Voc/lux and user's typical Isc are not a same-session I–V
  // measurement. Do not quietly combine them to fit diode/FTO parameters.
  const scenario = !observation && fto?.totalOhm !== null && fto?.totalOhm !== undefined && referenceFitValid && a > 0
    ? solveSeriesScenario(photoMa, darkMa, a, fto.totalOhm) : null;
  const issues: string[] = [];
  if (useReference && !referenceValid) issues.push("請填有效面積與所選光照模式的參考量測；lux 不能直接當 mW/cm²，未配對的 Isc 不會套用網站照度。");
  if (useReference && !referenceFitCompatible && referenceValid) issues.push("對照 Isc × Rs 已達／超過 Voc，無法以此單二極體情境反推光電流；請核對量測與參數。");
  return {
    vocV: areas.every((v) => v > 0) ? areas.length * c.cellVocV : 0,
    iscMa, // Area-scaled weakest-cell baseline, NOT the FTO scenario / measured output.
    minimumAreaMm2,
    limitingCellNumber: areas.length ? areas.indexOf(minimumAreaMm2) + 1 : null,
    cellIscMa, effectiveJscMaCm2, referenceCurrentDensityMaCm2, range,
    currentModel: "minimum-cell-current" as const,
    calibration: { basis: c.electricalBasis, referenceValid, referenceFitValid, referenceFitCompatible,
      referenceIscMa: c.referenceIscMa, referenceAreaMm2: c.referenceAreaMm2,
      lightMode: c.referenceLightMode, lightScale: scale,
      referenceLux: useReference && c.referenceLightMode === "lux-ratio" ? c.referenceLux : null,
      illuminanceLux: useReference && c.referenceLightMode === "lux-ratio" ? c.illuminanceLux : null,
      referenceIscRangeMa: c.referenceIscRangeMa,
      referenceIrradianceMwCm2: useReference && c.referenceLightMode === "irradiance" ? c.referenceIrradianceMwCm2 : null,
      referenceSeriesOhm: c.referenceSeriesOhm,
      referenceSeriesAssumedZero: useReference && c.referenceSeriesOhm === 0,
      currentAgingDerivedFromVoc: false,
      voltageCurrentPairing: observation ? "unpaired-online-voltage" : "manual-assumed",
      referencePhotoMa, diodeVoltageMv: c.diodeVoltageMv },
    voltageObservation: observation ? { ...observation, ...DSSC_REFERENCE,
      interpretedAs: "Voltage-only observation; no pairing to user-reported Isc. No lux-to-irradiance conversion or Voc-retention-to-Isc conversion." } : null,
    fto, scenario, issues,
    scenarioUnavailableReason: observation ? "網站 Voc/lux 與 38–40 mA 沒有同條件 I–V 配對，暫不混合擬合 FTO／MPP；可用面積縮放基準與 FTO 幾何電阻。" : null,
    basis: "Area baseline: min area / reference area * reference Isc * explicit light ratio, never a sum. Same-light mode assumes the unknown conditions of the current reference, NOT the website's lux conditions. Lux ratios require unchanged spectrum and sensor geometry; no conversion to mW/cm². Website voltage retention does not scale Isc; unpaired online Voc is not used to fit FTO I–V/MPP. Manual FTO scenario remains an unfitted equivalent-strip / single-diode model.",
    reference: "https://www.pveducation.org/pvcdrom/modules-and-arrays/mismatch-for-cells-connected-in-series",
    sources: { tec: `${TEC_SOURCE} — March 2024, p11, typical sheet resistance, not product-number-as-resistance`, seriesResistance: SERIES_RESISTANCE_SOURCE,
      userReference: "55×55 mm active area and typical 38–40 mA supplied by user; no same-session current/illumination pairing published",
      voltageObservations: DSSC_REFERENCE.statusUrl },
  };
}
