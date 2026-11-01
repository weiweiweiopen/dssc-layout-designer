import type { DesignConfig, LayoutGeometry, PointCodeArtwork } from './model';
import { buildGeometry } from './geometry';
import { buildPointCodeArtwork, validatePointCodeArtwork } from './point-code';
import { buildFabricationAssets, type SvgAsset } from './svg';
import { validateDesign } from './geometry';
import { electricalEstimate } from './electrical';

export interface DerivedDesign { config: DesignConfig; geometry: LayoutGeometry; pointCodeArtwork: PointCodeArtwork; assets: SvgAsset[] }
export function deriveDesign(config: DesignConfig): DerivedDesign {
  const geometry = buildGeometry(config), pointCodeArtwork = buildPointCodeArtwork(config, geometry);
  return { config, geometry, pointCodeArtwork, assets: buildFabricationAssets(config, geometry, pointCodeArtwork) };
}

export interface SearchResult { config: DesignConfig; tested: number; errors: number; vocV: number; iscMa: number | null; areaCv: number; targetMet: boolean }
export function searchArtworkConfiguration(config: DesignConfig, progress: (completed: number, total: number) => void): SearchResult {
  if (!config.artwork) throw new Error('沒有可搜尋的圖案來源。');
  const source = config.artwork;
  const counts = Array.from({ length: 24 }, (_, i) => 2 * (i + 1)).sort((a, b) => Math.abs(a * config.cellVocV - source.targetVocV) - Math.abs(b * config.cellVocV - source.targetVocV));
  const near = counts.filter((n) => Math.abs(n * config.cellVocV - source.targetVocV) <= source.voltageToleranceV);
  const selected = (near.length ? near : counts.slice(0, 1)).slice(0, 3);
  let best: SearchResult | null = null, bestScore = Infinity, tested = 0;
  const strengths = [...new Set([config.areaBalance, 1])];
  const total = selected.length * 3 * strengths.length;
  for (const count of selected) for (let i = 0; i < 3; i++) for (const strength of strengths) {
    const candidate = { ...config, subcellCount: count, areaBalance: strength, electrodeSeed: (config.electrodeSeed + i * 7919) % 10000000 };
    try {
      const g = buildGeometry(candidate), code = buildPointCodeArtwork(candidate, g);
      const errors = [...validateDesign(candidate, g), ...validatePointCodeArtwork(candidate, g, code)].filter((w) => w.severity === 'error').length;
      const e = electricalEstimate(candidate, g.fabrication.cellAreasMm2, g);
      const voltageError = Math.abs(e.vocV - source.targetVocV), deficit = Math.max(0, source.targetIscMa - (e.iscMa ?? 0));
      const targetMet = !errors && voltageError <= source.voltageToleranceV && e.iscMa !== null && e.iscMa >= source.targetIscMa;
      const score = errors * 1000 + voltageError / Math.max(0.01, source.voltageToleranceV) + deficit / Math.max(0.1, source.targetIscMa) * 5 + g.fabrication.areaCv * 2;
      if (score < bestScore) { bestScore = score; best = { config: candidate, tested: 0, errors, vocV: e.vocV, iscMa: e.iscMa, areaCv: g.fabrication.areaCv, targetMet }; }
    } catch { /* A failed topology candidate does not masquerade as a valid result. */ }
    progress(++tested, total);
  }
  if (!best) throw new Error('沒有可建立的圖案串聯配置，請減少目標電壓／子電池數或簡化圖案。');
  return { ...best, tested };
}
