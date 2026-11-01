import { DEFAULT_CONFIG, type DesignConfig } from './model';
import { parseDesignArtwork } from './artwork-source';
import { sealProcess } from './process';
import type { Artwork } from './studio/geometry';
import type { StudioDocument } from './studio/model';

const PREFIX = 'dssc-vector-transfer-v1-';
type Store = Pick<Storage, 'getItem' | 'setItem' | 'removeItem' | 'key' | 'length'>;
export interface StudioTargets { vocV: number; iscMa: number }

export function createArtworkTrial(art: Artwork, recipe: StudioDocument, targets: StudioTargets, id: string, original: DesignConfig = DEFAULT_CONFIG): DesignConfig {
  const source = parseDesignArtwork({ format: 'dssc-vector-artwork-v1', id, title: recipe.designs[recipe.active].text || recipe.designs[recipe.active].preset,
    widthMm: art.width, heightMm: art.height, regions: art.a, recipeJson: JSON.stringify(recipe),
    targetVocV: targets.vocV, targetIscMa: targets.iscMa, voltageToleranceV: 0.35 });
  const count = Math.min(48, Math.max(2, Math.round(targets.vocV / original.cellVocV / 2) * 2));
  return { ...original, text: '', artwork: source,
    glass6060WidthMm: art.width + 6, glass6066WidthMm: art.width + 12, glassHeightMm: art.height + 6,
    bindingWidthMm: Number(sealProcess(original).recommendedBindingMm.toFixed(2)),
    subcellCount: Number.isFinite(count) ? count : 4,
    electrodeSeed: recipe.designs[recipe.active].seed % 10000000 };
}

export function transferArtwork(art: Artwork, recipe: StudioDocument, targets: StudioTargets, storage: Store = localStorage): string {
  let original = { ...DEFAULT_CONFIG };
  try {
    const saved = JSON.parse(storage.getItem('w-series-voronoi-layout-v6') ?? 'null');
    if (saved && typeof saved === 'object') for (const key of Object.keys(DEFAULT_CONFIG) as Array<keyof DesignConfig>) {
      const value = saved[key];
      if (key !== 'artwork' && typeof value === typeof DEFAULT_CONFIG[key] && (typeof value !== 'number' || Number.isFinite(value))) Object.assign(original, { [key]: value });
    }
  } catch { /* Use defaults when no readable Layout reference exists. */ }
  if (!(original.cellVocV > 0)) original.cellVocV = DEFAULT_CONFIG.cellVocV;
  const id = crypto.randomUUID(), config = createArtworkTrial(art, recipe, targets, id, original);
  try { storage.setItem(`${PREFIX}${id}`, JSON.stringify({ format: 'dssc-studio-transfer-v1', config })); }
  catch { throw new Error('圖案暫存失敗。請先下載配方／幾何 JSON，釋放瀏覽器儲存空間後重試。'); }
  // Keep a few independent trials so opening one does not overwrite Layout or another trial.
  const keys = Array.from({ length: storage.length }, (_, i) => storage.key(i)).filter((k): k is string => !!k && k.startsWith(PREFIX));
  for (const key of keys.filter((k) => k !== `${PREFIX}${id}`).slice(0, Math.max(0, keys.length - 4))) storage.removeItem(key);
  return `?from=type-studio&artwork=${encodeURIComponent(id)}`;
}

export function persistArtworkTrial(config: DesignConfig, storage: Pick<Storage, 'setItem'> = localStorage): void {
  if (!config.artwork) return;
  storage.setItem(`${PREFIX}${config.artwork.id}`, JSON.stringify({ format: 'dssc-studio-transfer-v1', opened: true, config }));
}

export function readArtworkTrial(search: string, storage: Pick<Storage, 'getItem'> = localStorage): { requested: boolean; config: DesignConfig | null; error: string; autoSearch: boolean } {
  const q = new URLSearchParams(search), id = q.get('artwork');
  if (q.get('from') !== 'type-studio' || !q.has('artwork')) return { requested: false, config: null, error: '', autoSearch: false };
  try {
    if (!id || !/^[a-zA-Z0-9-]{1,80}$/.test(id)) throw new Error('無效圖案識別碼。');
    const raw = storage.getItem(`${PREFIX}${id}`);
    if (!raw) throw new Error('此圖案暫存已不存在；請回 Studio 重新送出。');
    const record = JSON.parse(raw), config = record.config as DesignConfig;
    if (record.format !== 'dssc-studio-transfer-v1' || !config) throw new Error('圖案移交格式錯誤。');
    const artwork = parseDesignArtwork(config.artwork);
    if (artwork.id !== id || !Number.isInteger(config.subcellCount) || config.subcellCount < 2 || config.subcellCount > 64 || config.subcellCount % 2) throw new Error('圖案與串聯配置不一致。');
    for (const key of Object.keys(DEFAULT_CONFIG) as Array<keyof DesignConfig>) {
      if (typeof config[key] !== typeof DEFAULT_CONFIG[key] || typeof config[key] === 'number' && !Number.isFinite(config[key])) throw new Error(`移交參數 ${key} 無效。`);
    }
    return { requested: true, config: { ...config, text: '', artwork }, error: '', autoSearch: !record.opened };
  } catch (error) { return { requested: true, config: null, error: error instanceof Error ? error.message : String(error), autoSearch: false }; }
}

/** Explicit transient design transfer; existing localStorage is left intact. */
export function studioConfig(search: string): DesignConfig | null {
  const q = new URLSearchParams(search);
  if (q.get('from') !== 'type-studio') return null;
  const seedText=q.get('seed'), cellsText=q.get('cells'), jitterText=q.get('jitter');
  if (!seedText || !cellsText || !jitterText || !/^\d+$/.test(seedText) || !/^\d+$/.test(cellsText)) return null;
  const seed=Number(seedText),cells=Number(cellsText),jitter=Number(jitterText);
  if (!Number.isInteger(seed) || seed<0 || seed>9999999 || !Number.isInteger(cells) || cells<2 || cells>32 || cells%2!==0 || !Number.isFinite(jitter) || jitter<0 || jitter>0.8) return null;
  return {...DEFAULT_CONFIG,electrodeSeed:seed,subcellCount:cells,electrodeJitter:jitter};
}
export function studioUrl(config: DesignConfig): string {
  const q=new URLSearchParams({from:'type-studio',seed:String(config.electrodeSeed),cells:String(config.subcellCount),jitter:String(config.electrodeJitter)});
  return `?${q.toString()}`;
}
