import { useEffect, useRef, useState } from 'react';
import type { DesignConfig, LayoutGeometry } from './model';
import type { SearchResult } from './design';
import { electricalEstimate } from './electrical';
import { diagnosticText } from './locales/diagnostics';

function TargetInput({ label, value, min, max, change }: { label: string; value: number; min: number; max: number; change: (n: number) => void }) {
  const [draft, setDraft] = useState(String(value));
  useEffect(() => setDraft(String(value)), [value]);
  return <label className="pattern-target"><span>{label}</span><input aria-label={label} type="text" inputMode="decimal" value={draft} onChange={(e) => setDraft(e.target.value)}
    onBlur={() => { const n = Number(draft); if (draft.trim() && Number.isFinite(n)) change(Math.max(min, Math.min(max, n))); else setDraft(String(value)); }}
    onKeyDown={(e) => { if (e.key === 'Enter') e.currentTarget.blur(); }}/></label>;
}

export function PatternPanel({ config, geometry, locale, pending, autoSearch, onConfig, onBusy }: {
  config: DesignConfig; geometry: LayoutGeometry; locale: 'zh-TW' | 'en'; pending: boolean; autoSearch: boolean;
  onConfig: (c: DesignConfig) => void; onBusy: (busy: boolean) => void;
}) {
  const zh = locale === 'zh-TW', source = config.artwork!, pattern = geometry.fabrication.pattern;
  const [progress, setProgress] = useState<[number, number] | null>(null), [message, setMessage] = useState<{ config: DesignConfig; text: string; result?: SearchResult } | null>(null);
  const worker = useRef<Worker | null>(null), automatic = useRef(false);
  const callbacks = useRef({ onBusy, onConfig }); callbacks.current = { onBusy, onConfig };
  useEffect(() => () => { worker.current?.terminate(); worker.current = null; setProgress(null); callbacks.current.onBusy(false); }, [config]);
  const start = () => {
    worker.current?.terminate();
    const current = new Worker(new URL('./layout.worker.ts', import.meta.url), { type: 'module' });
    worker.current = current; setProgress([0, 0]); setMessage(null); callbacks.current.onBusy(true);
    const finish = () => { current.terminate(); if (worker.current === current) worker.current = null; setProgress(null); callbacks.current.onBusy(false); };
    current.onmessage = (event: MessageEvent<{ kind: string; completed: number; total: number; result: SearchResult; error: string }>) => {
      if (worker.current !== current) return;
      if (event.data.kind === 'progress') { setProgress([event.data.completed, event.data.total]); return; }
      if (event.data.kind === 'error') { setMessage({ config, text: event.data.error }); finish(); return; }
      const result = event.data.result;
      setMessage({ config: result.config, text: '', result });
      finish(); callbacks.current.onConfig(result.config);
    };
    current.onerror = (event) => { if (worker.current === current) { setMessage({ config, text: event.message }); finish(); } };
    current.postMessage({ kind: 'search', config });
  };
  useEffect(() => {
    if (!autoSearch || automatic.current) return;
    const timer = setTimeout(() => { automatic.current = true; start(); }, 60);
    return () => clearTimeout(timer);
  }, [autoSearch, config]);
  const e = electricalEstimate(config, geometry.fabrication.cellAreasMm2, geometry);
  const fit = !pending && !progress && pattern?.scenarioValid && geometry.fabrication.errors.length === 0 &&
    Math.abs(e.vocV - source.targetVocV) <= source.voltageToleranceV && e.iscMa !== null && e.iscMa >= source.targetIscMa;
  const updateTarget = (key: 'targetVocV' | 'targetIscMa', value: number) => onConfig({ ...config, artwork: { ...source, [key]: value } });
  return <section className="form-section pattern-panel" data-testid="pattern-panel" data-source-id={source.id} data-busy={Boolean(progress)} data-film-source={geometry.fabrication.openingScenario.source}>
    <h2>{zh ? 'STUDIO 圖案 → W 型電極' : 'STUDIO ARTWORK → W-SERIES'}</h2>
    <strong className="pattern-title">{source.title}</strong>
    <p>{zh ? '已載入真正輪廓與孔洞。A 為塗層候選；留白補膠並保留注液／排氣通道。每個 cell 的 TiO₂／Pt 依序在雙片交換。' : 'Resolved contours and holes loaded. A supplies patterned coating; background adhesive preserves fill / vent routes. TiO₂/Pt alternate between plates by cell order.'}</p>
    <TargetInput label={zh ? '目標 Voc V' : 'Target Voc V'} value={source.targetVocV} min={0.1} max={40} change={(v) => updateTarget('targetVocV', v)}/>
    <TargetInput label={zh ? '目標 Isc mA' : 'Target Isc mA'} value={source.targetIscMa} min={0} max={100} change={(v) => updateTarget('targetIscMa', v)}/>
    <button data-testid="search-pattern" disabled={Boolean(progress) || pending} onClick={start}>{progress ? `${zh ? '搜尋中' : 'Searching'} ${progress[0]}/${progress[1] || '…'}` : zh ? '搜尋串聯數與圖案面積平衡' : 'Search series count / patterned-area balance'}</button>
    {progress && <button onClick={() => { worker.current?.terminate(); worker.current = null; setProgress(null); callbacks.current.onBusy(false); }}>{zh ? '取消搜尋' : 'Cancel search'}</button>}
    <div className="pattern-summary" data-testid="pattern-summary">
      <b>{progress ? zh ? '正在比較實際製版幾何' : 'Comparing actual fabrication geometry' : pending ? zh ? '正在重算圖案' : 'Rebuilding pattern' : fit ? zh ? '估算達標／幾何檢查通過' : 'Estimated target met / geometry checks pass' : zh ? '已轉換；仍有目標差距或 DRC 項目' : 'Converted; target gaps or DRC items remain'}</b>
      <span>Voc {e.vocV.toFixed(3)} V · Isc {e.iscMa === null ? '—' : e.iscMa.toFixed(3)} mA</span>
      <span>{zh ? '電壓差／電流不足' : 'Voltage gap / current deficit'} {Math.abs(e.vocV - source.targetVocV).toFixed(3)} V / {Math.max(0, source.targetIscMa - (e.iscMa ?? 0)).toFixed(3)} mA</span>
      <span>{zh ? '圖案保留／縮放' : 'Pattern retained / scale'} {pattern ? (pattern.retainedAreaFraction * 100).toFixed(1) : '—'}% / ×{pattern?.scale.toFixed(3) ?? '—'}</span>
      <span>{zh ? '腔室連通' : 'Chambers reachable'} {pattern?.flow.reachableChambers ?? 0}/{pattern?.flow.chambers ?? 0} · {pattern?.flow.pass ? 'PASS' : 'CHECK'}</span>
      <span>{zh ? '補膠情境／圖案 FTO' : 'Adhesive scenario / pattern FTO'} {pattern?.scenarioValid ? 'PASS' : 'CHECK'} / {pattern?.ftoFragmentsValid ? 'PASS' : 'CHECK'}</span>
    </div>
    {pattern && <table className="pattern-cell-table"><thead><tr><th>Cell</th><th>mm²</th><th>mA</th><th>{zh ? '可達分量' : 'Wet fragments'}</th></tr></thead><tbody>{geometry.cells.map((cell) => {
      const flow = pattern.flow.cells[cell.index];
      return <tr key={cell.index}><td>{cell.index + 1}</td><td>{geometry.fabrication.cellAreasMm2[cell.index].toFixed(2)}</td><td>{e.cellIscMa[cell.index]?.toFixed(3) ?? '—'}</td><td>{flow?.reachableFragments ?? 0}/{flow?.fragments ?? 0}</td></tr>;
    })}</tbody></table>}
    {pattern && !pattern.scenarioValid && <button className="pattern-film-link" onClick={() => {
      const input = document.querySelector<HTMLInputElement>('[data-parameter="Measured Wet Film"] input'); input?.scrollIntoView({ block: 'center', behavior: 'smooth' }); input?.focus({ preventScroll: true });
    }}>{zh ? '檢查實測濕膜／膠量參數 ↓' : 'Inspect measured film / adhesive inputs ↓'}</button>}
    <p>{zh ? '以圖案密度引導分區，最後用補膠與安全退讓後的向量面積重算。流道目前檢查連通與淨寬；尚未驗證每個腔室的單調向下路徑、毛細填充或無氣泡。圖案 ZIP 另含雙片 Pt 網版。' : 'Density guides partitions; final areas use exact post-adhesive polygons. Flow checks cover connectivity and clearance, not strictly downward reachability for every chamber, capillary kinetics or bubble-free filling. Pattern ZIPs also include both Pt screens.'}</p>
    {message?.config === config && <p role="status">{message.result
      ? zh ? `已比較 ${message.result.tested} 個配置。${message.result.targetMet ? '面積基準估算達到目標，仍需試片量測。' : '保留最接近的候選；請核對目標差距及 DRC。'}`
        : `Compared ${message.result.tested} configurations. ${message.result.targetMet ? 'Area-based estimate meets the target; measurements are still required.' : 'Closest candidate retained; inspect target gaps and DRC.'}`
      : diagnosticText(message.text, locale)}</p>}
    <a href="?studio=type">{zh ? '← 回 Studio 調整圖案' : '← Edit artwork in Studio'}</a>
  </section>;
}
