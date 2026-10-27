/** Public observation snapshot; voltage/lux records are not current measurements.
 * Reviewed against status.json on 2026-10-26. Active area and 38–40 mA are
 * separately user-reported, with no timestamp/spectrum pairing in this archive. */
export const DSSC_REFERENCE = {
  sampleId: "green_proofs_are_not_always_about_tax_write-offs_1",
  name: "DSSC 55×55 A",
  areaMm2: 55 * 55,
  userCurrentMa: { low: 38, middle: 39, high: 40, source: "User-reported typical whole-cell Isc; measurement light / date not paired to website Voc records" },
  statusUrl: "https://weiweiweiopen.github.io/solar-oracle-walkman/data/green_proofs_are_not_always_about_tax_write-offs_1/status.json",
  rawUrl: "https://weiweiweiopen.github.io/solar-oracle-walkman/data/green_proofs_are_not_always_about_tax_write-offs_1/readings.csv",
  generatedAt: "2026-10-26T00:15:07+08:00",
  firstObservedAt: "2026-09-03T20:49:35+08:00",
  validSamples: 10127,
  excludedSamples: 3390,
  // The publisher hashes its input logger file; the public CSV adds quality /
  // sample metadata, so its bytes have a different independently checked hash.
  reportedSourceCsvSha256: "c5ad49bd52c792ce30b8225124682c3699e6b537e1b63861c1ac1e7989c25323",
  publishedCsvSha256: "1daa31a88cd5b0a5c990f57f7df2ad41186d35a41a2405b3910062af2e0fde3b",
  dailyAggregation: "median of hourly voltage medians after light / temperature / quality filtering",
  comparison: { sample: "DSSC 55×55 B", firstObservedAt: "2026-10-13T22:00:15+08:00", validSamples: 4410 },
  referenceLux: 942.5,
  referenceTemperatureC: 29.73,
  lightTolerancePct: 10,
  temperatureToleranceC: 2,
  excludedPeriod: { from: "2026-10-03", confirmedReconnectedAt: "2026-10-14T18:33:00+08:00", reason: "User-reported disconnection; confirmation is not an exact physical reconnect time" },
  voltageOnly: true,
  irradianceMwCm2: null,
  pairedIscMa: null,
} as const;

export const VOLTAGE_OBSERVATIONS = {
  "a-baseline": { label: "A · early baseline", vocV: 0.4971, date: "2026-09-03–06", retentionPct: 100, matchedSamples: 200, quality: "fixed-baseline" },
  "a-2026-09-04": { label: "A · 09/04", vocV: 0.4974, date: "2026-09-04", retentionPct: 100.060, matchedSamples: 153, quality: "complete" },
  "a-2026-10-01": { label: "A · 10/01", vocV: 0.491675, date: "2026-10-01", retentionPct: 98.909, matchedSamples: 63, quality: "complete" },
  "a-2026-10-24": { label: "A · 10/24", vocV: 0.332, date: "2026-10-24", retentionPct: 66.787, matchedSamples: 207, quality: "complete" },
  "a-2026-10-25": { label: "A · 10/25", vocV: 0.328625, date: "2026-10-25", retentionPct: 66.108, matchedSamples: 572, quality: "complete" },
} as const;

export type VoltageObservationId = keyof typeof VOLTAGE_OBSERVATIONS | "manual";

export function voltageObservation(id: VoltageObservationId) {
  return id === "manual" ? null : VOLTAGE_OBSERVATIONS[id] ?? null;
}
