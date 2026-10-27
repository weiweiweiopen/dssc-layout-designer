import { DEFAULT_CONFIG, type DesignConfig } from "./model";
import { FTO_PRESETS } from "./electrical";
import { voltageObservation } from "./reference-data";
import type { VoltageObservationId } from "./reference-data";
export { electricalEstimate } from "./electrical";

export const umToMm = (v: number) => v / 1000;
/** User's product-label calibration only: 1000 grade ≈ D50 15 µm.
 * NOT a universal sieve opening / particle-size standard. */
const BEAD_GRADE_PRODUCT = 1000 * 15;

/** One canonical height. Legacy mismatches use the bigger plate's height. */
export function migrateGlassHeight(c: Partial<DesignConfig> & { glass6066HeightMm?: number; glass6060HeightMm?: number }): number {
  for (const height of [c.glassHeightMm, c.glass6066HeightMm, c.glass6060HeightMm]) {
    if (typeof height === "number" && Number.isFinite(height) && height > 0) return height;
  }
  return DEFAULT_CONFIG.glassHeightMm;
}

/** A design target plus explicit edge-growth budget, not a verified finished gap. */
export function artworkOpeningWidth(c: DesignConfig, spreadMm: number): number {
  const resolution = Math.max(2 * 25.4 / c.screenMeshPerInch, 3 * umToMm(c.beadD90Um));
  const requiredClear = Math.max(c.minimumOpenMm, 6 * umToMm(c.beadDiameterUm));
  return Math.max(resolution, c.minimumArtworkOpeningMm, requiredClear + 2 * spreadMm + 0.01);
}

export function updateProcessConfig<K extends keyof DesignConfig>(current: DesignConfig, key: K, value: DesignConfig[K]): DesignConfig {
  const next = { ...current, [key]: value };
  if (key === "ftoBiggerPreset" || key === "ftoSmallerPreset") {
    const preset = FTO_PRESETS[value as keyof typeof FTO_PRESETS];
    if (preset) next[key === "ftoBiggerPreset" ? "ftoBiggerOhmSq" : "ftoSmallerOhmSq"] = preset.ohmSq;
  }
  if (key === "ftoBiggerOhmSq") next.ftoBiggerPreset = "custom";
  if (key === "ftoSmallerOhmSq") next.ftoSmallerPreset = "custom";
  if (key === "referenceVoltageObservation") {
    const observation = voltageObservation(value as VoltageObservationId);
    if (observation) next.cellVocV = observation.vocV;
  }
  if (key === "cellVocV") next.referenceVoltageObservation = "manual";
  if (key === "beadDiameterUm" || key === "beadGradeMesh") {
    const diameter = key === "beadGradeMesh" ? BEAD_GRADE_PRODUCT / (value as number) : value as number;
    const ratio = current.beadD90Um / current.beadDiameterUm;
    next.beadDiameterUm = diameter;
    next.beadGradeMesh = BEAD_GRADE_PRODUCT / diameter;
    next.beadD90Um = diameter * Math.max(1, ratio);
  }
  return next;
}

/** Printing estimates and explicit design allowances; no datasheet-derived optimum. */
export function sealProcess(c: DesignConfig) {
  const pitchUm = 25400 / c.screenMeshPerInch;
  const apertureUm = pitchUm - c.screenWireUm;
  const openFraction = Math.max(0, apertureUm / pitchUm) ** 2;
  const screenChargeUm = 2 * c.screenWireUm * openFraction + c.emulsionUm;
  const estimatedDepositUm = c.transferEfficiency * screenChargeUm;
  const depositUm = c.measuredWetFilmUm > 0 ? c.measuredWetFilmUm : estimatedDepositUm;
  const depositSource = c.measuredWetFilmUm > 0 ? "user-measured wet film" : "UNMEASURED screen-volume estimate (EOM / transfer assumptions)";
  const gapUm = c.beadDiameterUm;
  const volumeRatio = depositUm / gapUm; // Keep underfill visible; NEVER clamp to 1.
  const compressionValid = Number.isFinite(volumeRatio) && volumeRatio >= 1;
  // An unmeasured transfer example must not size the aperture as if it were
  // calibrated. Use a full single-pass screen-charge STRESS SCENARIO instead.
  // This is still a geometric assumption, not a certified process upper bound.
  const openingFilmUm = c.measuredWetFilmUm > 0 ? c.measuredWetFilmUm : screenChargeUm;
  const openingFilmSource = c.measuredWetFilmUm > 0 ? "measured-wet-film" as const : "unmeasured-screen-charge" as const;
  const openingVolumeRatio = openingFilmUm / gapUm;
  const openingScenarioValid = Number.isFinite(openingVolumeRatio) && openingVolumeRatio >= 1;
  // SI dimensional check: m * sqrt(Pa * s / (Pa*s)) -> m. Diagnostic only;
  // slow flow cannot make excess deposited volume disappear at the target gap.
  const flowMm = Math.sqrt(c.pressPressureKpa * 1000 * (gapUm * 1e-6) ** 2 * c.pressTimeS /
    (6 * c.sealantViscosityMpas * 1e-3)) * 1000;
  const volumeSpreadMm = compressionValid ? c.bindingWidthMm * (volumeRatio - 1) / 2 : null;
  const openingVolumeSpreadMm = openingScenarioValid ? c.bindingWidthMm * (openingVolumeRatio - 1) / 2 : null;
  const allowanceMm = umToMm(c.edgeBleedUm + c.printEdgeToleranceUm);
  // Keep the nominal electrode-layout basis stable. Aperture stress sizing
  // must not silently change an already-generated Voronoi / FTO pattern.
  const spreadMm = (volumeSpreadMm ?? 0) + allowanceMm;
  const openingSpreadMm = (openingVolumeSpreadMm ?? 0) + allowanceMm;
  // Two screen pitches is an explicit printability starting rule, not a seal-strength specification.
  const printResolutionMm = Math.max(2 * umToMm(pitchUm), 3 * umToMm(c.beadD90Um));
  const targetScenarioClearMm = Math.max(c.minimumOpenMm, 6 * umToMm(gapUm));
  // Screen resolution constrains ARTWORK, not the final squeezed channel.
  // Plate-to-plate registration does not shrink two edges on the same stencil.
  const localOpeningEstimateMm = artworkOpeningWidth(c, openingSpreadMm);
  const minBindingMm = printResolutionMm;
  const maxBindingMm = Math.min(5, Math.min(c.glass6060WidthMm,
    c.glass6066WidthMm, c.glassHeightMm) / (2 + Math.sqrt(c.subcellCount)));
  const recommendedBindingMm = Math.min(maxBindingMm, Math.ceil(Math.max(minBindingMm,
    c.targetSealWidthMm / (compressionValid ? volumeRatio : 1)) * 100) / 100);
  const errors: string[] = [];
  if (apertureUm <= 0) errors.push("網版線徑必須小於 mesh pitch。");
  if (c.beadD90Um < c.beadDiameterUm) errors.push("玻璃珠 D90 不可小於 D50。");
  if (apertureUm < 3 * c.beadD90Um) errors.push("網版開目小於 3 × 玻璃珠 D90，可能濾珠／堵網。");
  if (!compressionValid) errors.push(`濕膜 ${depositUm.toFixed(2)} µm 小於假設間隙 ${gapUm.toFixed(2)} µm：膠量不足，壓合孔寬預測不成立；不可將它解讀成零擴散。`);
  if (minBindingMm > maxBindingMm) errors.push("此網版解析度與電池數無法容納膠線下限。");
  return { pitchUm, apertureUm, openFraction, screenChargeUm, estimatedDepositUm, depositUm, depositSource,
    openingFilmUm, openingFilmSource, openingVolumeRatio, openingScenarioValid, openingVolumeSpreadMm, openingSpreadMm,
    gapUm, volumeRatio, compressionValid, volumeSpreadMm, allowanceMm, flowMm, spreadMm,
    printResolutionMm, targetScenarioClearMm, localOpeningEstimateMm, minBindingMm, maxBindingMm, recommendedBindingMm,
    nominalFinalSealMm: compressionValid ? c.bindingWidthMm * volumeRatio : null,
    sources: { viscosity: "AB-313 TDS p1: 38000 ± 8000 mPa.s at 25°C; mixture viscosity must be measured",
      EOM: "SCREEN-MAKING input; NOT in AB-313 TDS. Default 10 µm is an unmeasured example",
      transfer: "UNMEASURED example 0.32; NOT in AB-313 TDS",
      gap: "Assumed from bead D50, not a measured assembled gap",
      beadGrade: "Linked product-label approximation: 1000 grade ≈ 15 µm; not screen mesh",
      allowances: "User design assumptions for lateral bleed and stencil-edge error; not measured squeeze data",
      opening: "Measured wet film when available; otherwise full single-pass screen-charge geometric stress scenario, NOT a verified post-press prediction or material specification",
      targetSeal: "User geometric target, not a material-derived optimum" }, errors };
}
