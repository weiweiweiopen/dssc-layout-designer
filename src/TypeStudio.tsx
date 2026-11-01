import { useCallback, useDeferredValue, useEffect, useRef, useState, type PointerEvent as ReactPointerEvent } from "react";
import { componentAt } from "./polygons";
import { capsuleTexts, clone, clamp, newDocument, parseDocument, PRESETS, recipeFor, STORAGE_KEY, variantOf, type Flavor, type Recipe, type StudioDocument } from "./studio/model";
import { FONT_OPTIONS, importFont, loadFont } from "./studio/fonts";
import { bounds, pathData, type Artwork, type LayoutDivider } from "./studio/geometry";
import { StudioEngine, Superseded } from "./studio/engine";
import { artworkSvg, download, downloadPng, geometryJson, projectJson } from "./studio/export";
import { transferArtwork, type StudioTargets } from "./studio-handoff";
import "./type-studio.css";

type Tool = "pan" | "cage" | "glyph" | "mask" | "character" | "rows" | "capsule";
type History = { past: StudioDocument[]; present: StudioDocument; future: StudioDocument[] };
function initialDocument() {
  try { const raw = localStorage.getItem(STORAGE_KEY); if (raw) return parseDocument(JSON.parse(raw)); } catch { /* Recover with a clean Studio, never touch Layout settings. */ }
  return newDocument();
}
function Numeric({ label, value, min, max, step = 0.1, onChange }: { label: string; value: number; min: number; max: number; step?: number; onChange: (value: number) => void }) {
  const [draft, setDraft] = useState(String(value));
  const cancelled = useRef(false);
  useEffect(() => setDraft(String(Number(value.toFixed(3)))), [value]);
  const commit = () => {
    if (cancelled.current) { cancelled.current = false; return; }
    const n = Number(draft);
    if (draft.trim() && Number.isFinite(n)) onChange(clamp(n, min, max));
    else setDraft(String(value));
  };
  return <label className="tg-number"><span>{label}</span><input aria-label={label} inputMode="decimal" type="number" min={min} max={max} step={step}
    value={draft} onChange={(e) => setDraft(e.target.value)} onBlur={commit}
    onKeyDown={(e) => { if (e.key === "Enter") e.currentTarget.blur(); if (e.key === "Escape") { cancelled.current = true; setDraft(String(value)); e.currentTarget.blur(); } }}/></label>;
}
function Range({ label, value, min, max, step = 0.01, onChange }: { label: string; value: number; min: number; max: number; step?: number; onChange: (value: number) => void }) {
  return <label className="tg-range"><span>{label}<output>{Number(value.toFixed(2))}</output></span><input type="range" aria-label={label} min={min} max={max} step={step} value={value} onChange={(e) => onChange(Number(e.target.value))}/></label>;
}

export default function TypeStudio() {
  const [history, setHistory] = useState<History>(() => ({ past: [], present: initialDocument(), future: [] }));
  const doc = history.present, recipe = doc.designs[doc.active], docRef = useRef(doc);
  docRef.current = doc;
  const checkpoint = useRef<StudioDocument | null>(null);
  const begin = () => { checkpoint.current ??= clone(docRef.current); };
  const end = () => {
    const before = checkpoint.current; checkpoint.current = null;
    if (before) setHistory((h) => JSON.stringify(before) === JSON.stringify(h.present) ? h : ({ ...h, past: [...h.past.slice(-39), before], future: [] }));
  };
  const editDoc = useCallback((fn: (d: StudioDocument) => void) => {
    const grouped = checkpoint.current !== null;
    setHistory((h) => {
      const next = clone(h.present); fn(next);
      if (JSON.stringify(next) === JSON.stringify(h.present)) return h;
      return { past: grouped ? h.past : [...h.past.slice(-39), h.present], present: next, future: [] };
    });
  }, []);
  const update = (fn: (r: Recipe) => void) => editDoc((d) => fn(d.designs[d.active]));
  const undo = useCallback(() => { checkpoint.current = null; setHistory((h) => !h.past.length ? h : ({ past: h.past.slice(0, -1), present: h.past.at(-1)!, future: [h.present, ...h.future] })); }, []);
  const redo = useCallback(() => { checkpoint.current = null; setHistory((h) => !h.future.length ? h : ({ past: [...h.past, h.present], present: h.future[0], future: h.future.slice(1) })); }, []);
  const [storageError, setStorageError] = useState("");
  useEffect(() => {
    const timeout = setTimeout(() => {
      try { localStorage.setItem(STORAGE_KEY, projectJson(doc)); setStorageError(""); }
      catch { setStorageError("瀏覽器儲存空間不足，請下載配方保存。"); }
    }, 500);
    return () => clearTimeout(timeout);
  }, [doc]);
  useEffect(() => {
    const onKey = (e: KeyboardEvent) => {
      if ((e.target as HTMLElement)?.closest("input, textarea, select")) return;
      if ((e.metaKey || e.ctrlKey) && e.key.toLowerCase() === "z") { e.preventDefault(); e.shiftKey ? redo() : undo(); }
    };
    window.addEventListener("keydown", onKey); return () => window.removeEventListener("keydown", onKey);
  }, [undo, redo]);

  const [error, setError] = useState(""), [message, setMessage] = useState("");
  const [pngBusy, setPngBusy] = useState(false);
  const engine = useRef<StudioEngine | null>(null);
  useEffect(() => {
    const current = new StudioEngine(); engine.current = current;
    return () => { current.dispose(); engine.current = null; };
  }, []);
  const deferred = useDeferredValue(recipe);
  const [resolved, setResolved] = useState<{ recipe: Recipe; art: Artwork } | null>(null);
  useEffect(() => {
    let cancelled = false;
    const timeout = setTimeout(() => {
      engine.current?.run(deferred, doc.customFont).then((art) => {
        if (!cancelled) { setResolved({ recipe: deferred, art }); setError(""); }
      }).catch((e) => { if (!cancelled && !(e instanceof Superseded)) setError(e instanceof Error ? e.message : String(e)); });
    }, 30);
    return () => { cancelled = true; clearTimeout(timeout); };
  }, [deferred, doc.customFont]);
  const art = resolved?.art, pending = resolved?.recipe !== recipe;
  const canExport = !!art && !pending && !error;
  const [targets, setTargets] = useState<StudioTargets>(() => {
    try {
      const saved = JSON.parse(localStorage.getItem("dssc-studio-targets-v1") ?? "null");
      if (saved && Number.isFinite(saved.vocV) && saved.vocV >= 0.1 && saved.vocV <= 40 && Number.isFinite(saved.iscMa) && saved.iscMa >= 0 && saved.iscMa <= 100) return saved;
    } catch { /* Independent optional target preference. */ }
    return { vocV: 2, iscMa: 2 };
  });
  useEffect(() => { try { localStorage.setItem("dssc-studio-targets-v1", JSON.stringify(targets)); } catch { /* Recipe export remains available. */ } }, [targets]);
  const sendToLayout = () => {
    if (!canExport) return;
    try { window.location.assign(transferArtwork(art!, doc, targets)); }
    catch (e) { setMessage(e instanceof Error ? e.message : String(e)); }
  };
  const [tool, setTool] = useState<Tool>("cage"), [selected, setSelected] = useState<string | null>(null), [showB, setShowB] = useState(false);
  const [selectedCapsule, setSelectedCapsule] = useState<string | null>(null);
  useEffect(() => {
    setSelectedCapsule(null);
    if (recipe.preset !== "capsules") setTool((current) => current === "capsule" ? "cage" : current);
  }, [recipe.preset, recipe.capsule.layout, recipe.capsule.units, recipe.capsule.lanes, recipe.capsule.direction]);
  const [settingsOpen, setSettingsOpen] = useState(false);
  const [camera, setCamera] = useState({ x: 0, y: 0, zoom: 1 });
  const svgRef = useRef<SVGSVGElement>(null);
  const fit = () => setCamera({ x: 0, y: 0, zoom: 1 });
  useEffect(() => { fit(); setSelected(null); }, [doc.active, recipe.width, recipe.height]);
  const getPoint = (clientX: number, clientY: number) => {
    const matrix = svgRef.current?.getScreenCTM();
    return matrix ? new DOMPoint(clientX, clientY).matrixTransform(matrix.inverse()) : new DOMPoint();
  };
  const drag = useRef<{ kind: Tool; index?: number; id?: string; x: number; y: number; source: Recipe; camera: typeof camera; divider?: LayoutDivider } | null>(null);
  const startDrag = (e: ReactPointerEvent<SVGElement>, kind: Tool, index?: number, id?: string) => {
    if (e.button !== 0 && e.button !== 1) return;
    e.preventDefault(); e.stopPropagation();
    const p = getPoint(e.clientX, e.clientY);
    drag.current = { kind, index, id, x: p.x, y: p.y, source: clone(recipe), camera: { ...camera }, divider: art?.dividers.find((d) => d.index === index) };
    if (kind !== "pan") begin();
    svgRef.current!.setPointerCapture(e.pointerId);
  };
  const moveDrag = (e: ReactPointerEvent<SVGSVGElement>) => {
    const d = drag.current; if (!d) return;
    if (d.kind === "pan") {
      // Screen delta, converted using the initial camera scale; avoid feedback as the view moves.
      const svg = svgRef.current!, rect = svg.getBoundingClientRect();
      const scale = Math.min(rect.width / recipe.width, rect.height / recipe.height) * d.camera.zoom;
      const last = (svg as SVGSVGElement & { panStart?: { x: number; y: number } }).panStart;
      if (last) setCamera({ ...d.camera, x: d.camera.x - (e.clientX - last.x) / scale, y: d.camera.y - (e.clientY - last.y) / scale });
      return;
    }
    const p = getPoint(e.clientX, e.clientY), dx = p.x - d.x, dy = p.y - d.y;
    update((r) => {
      if (d.kind === "cage") r.warp.cage[d.index!] = { x: clamp(d.source.warp.cage[d.index!].x + dx / r.width, -0.1, 0.1), y: clamp(d.source.warp.cage[d.index!].y + dy / r.height, -0.1, 0.1) };
      if (d.kind === "mask") { r.mask.x = clamp(d.source.mask.x + dx / r.width, 0, 1); r.mask.y = clamp(d.source.mask.y + dy / r.height, 0, 1); }
      if (d.kind === "character") { r.character.x = clamp(d.source.character.x + dx / r.width, 0, 1); r.character.y = clamp(d.source.character.y + dy / r.height, 0, 1); }
      if (d.kind === "glyph") {
        const edit = d.source.edits[d.id!] ?? { x: 0, y: 0, scale: 1, angle: 0 };
        r.edits[d.id!] = { ...edit, x: clamp(edit.x + dx, -50, 50), y: clamp(edit.y + dy, -50, 50) };
      }
      if (d.kind === "capsule") {
        const edit = d.source.capsule.edits[d.id!] ?? { x: 0, y: 0, scale: 1, angle: 0 };
        r.capsule.edits[d.id!] = { ...edit, x: clamp(edit.x + dx, -50, 50), y: clamp(edit.y + dy, -50, 50) };
      }
      if (d.kind === "rows" && d.divider) {
        const i = d.index!, sum = d.source.rowWeights[i] + d.source.rowWeights[i + 1];
        const delta = (d.divider.axis === "x" ? dx : dy) * d.divider.direction / d.divider.span * d.source.rowWeights.slice(0, d.divider.rows).reduce((s, v) => s + v, 0);
        const first = clamp(d.source.rowWeights[i] + delta, Math.max(0.4, sum - 2), Math.min(2, sum - 0.4));
        r.rowWeights[i] = first; r.rowWeights[i + 1] = sum - first;
      }
    });
  };
  const finishDrag = (e: ReactPointerEvent<SVGSVGElement>) => {
    if (drag.current) { drag.current = null; end(); }
    if (e.currentTarget.hasPointerCapture(e.pointerId)) e.currentTarget.releasePointerCapture(e.pointerId);
  };
  // Native non-passive listener permits cursor-anchored zoom without scrolling the page.
  useEffect(() => {
    const svg = svgRef.current;
    if (!svg) return;
    const wheel = (e: WheelEvent) => {
      e.preventDefault(); if (drag.current) return;
      const p = getPoint(e.clientX, e.clientY);
      setCamera((c) => {
        const zoom = clamp(c.zoom * Math.exp(-e.deltaY * 0.0015), 0.5, 8), ratio = c.zoom / zoom;
        return { zoom, x: p.x - (p.x - c.x) * ratio, y: p.y - (p.y - c.y) * ratio };
      });
    };
    svg.addEventListener("wheel", wheel, { passive: false });
    return () => svg.removeEventListener("wheel", wheel);
  }, []);

  const [variants, setVariants] = useState<Array<{ recipe: Recipe; art: Artwork }>>([]), [makingVariants, setMakingVariants] = useState(false);
  const [locks, setLocks] = useState({ layout: false, mask: false });
  const variantRun = useRef(0);
  useEffect(() => { variantRun.current++; setVariants([]); setMakingVariants(false); }, [doc.active, recipe.font, recipe.preset, recipe.text, recipe.width, recipe.height, doc.customFont]);
  useEffect(() => () => { variantRun.current++; }, []);
  const makeVariants = async () => {
    if (!engine.current || pending || error) return;
    const run = ++variantRun.current, source = clone(recipe), results: typeof variants = [];
    setMakingVariants(true); setVariants([]);
    try {
      for (let i = 0; i < 6; i++) {
        await new Promise((resolve) => setTimeout(resolve, 15));
        if (run !== variantRun.current) return;
        const candidate = variantOf(source, (source.seed + (i + 1) * 7919) >>> 0, locks);
        const art = await engine.current!.run(candidate, doc.customFont, "variant");
        if (run !== variantRun.current) return;
        results.push({ recipe: candidate, art });
        setVariants([...results]);
      }
    } catch (e) { setMessage(`變體生成失敗：${e instanceof Error ? e.message : e}`); }
    finally { if (run === variantRun.current) setMakingVariants(false); }
  };
  const fileInput = useRef<HTMLInputElement>(null), fontInput = useRef<HTMLInputElement>(null);
  const readProject = async (file?: File) => {
    if (!file) return;
    try {
      if (file.size > 4_500_000) throw new Error("配方檔案超過 4.5 MB。");
      const restored = parseDocument(JSON.parse(await file.text()));
      if (restored.customFont) await loadFont("custom", restored.customFont);
      editDoc((d) => { Object.keys(d).forEach((key) => delete (d as unknown as Record<string, unknown>)[key]); Object.assign(d, restored); });
      setMessage("配方已載入，兩種風味與字型資料皆保留。");
    } catch (e) { setMessage(e instanceof Error ? e.message : String(e)); }
  };
  const pickFont = async (file?: File) => {
    if (!file) return;
    try { const customFont = await importFont(file); editDoc((d) => { d.customFont = customFont; d.designs[d.active].font = "custom"; }); setMessage(`已載入 ${customFont.name}`); }
    catch (e) { setMessage(e instanceof Error ? e.message : String(e)); }
  };
  const setFlavor = (flavor: Flavor) => editDoc((d) => { d.active = flavor; });
  const changePreset = (preset: Recipe["preset"]) => { update((r) => Object.assign(r, recipeFor(preset, r))); setSelected(null); };
  const selectedElement = art?.elements.find((e) => e.id === selected);
  const selection = selectedElement?.bounds;
  const selectedEdit = selected ? recipe.edits[selected] ?? { x: 0, y: 0, scale: 1, angle: 0 } : null;
  const charBounds = art?.character.length ? bounds(art.character) : null;
  const capsuleElement = art?.elements.find((e) => e.kind === "geometry" && e.groupId === selectedCapsule);
  const capsuleEdit = selectedCapsule ? recipe.capsule.edits[selectedCapsule] ?? { x: 0, y: 0, scale: 1, angle: 0 } : null;
  const currentPreset = PRESETS.find((p) => p.id === recipe.preset)!;
  const capsulePreset = recipe.preset === "capsules", cap = recipe.capsule;
  const capsuleStyle = (style: "lines" | "words" | "weave") => {
    update((r) => {
      r.capsule.layout = style === "weave" ? "weave" : "fit";
      r.capsule.units = style === "words" ? "words" : "lines";
      r.capsule.direction = style === "weave" ? "vertical" : "horizontal";
      r.capsule.lanes = style === "lines" ? 1 : style === "words" ? 2 : 4;
      r.capsule.segments = 3;
      r.capsule.operation = style === "weave" ? "xor" : "knockout";
      r.capsule.edits = {}; r.edits = {}; r.rowWeights = [1, 1, 1, 1, 1, 1];
    });
    setSelected(null); setSelectedCapsule(null); setTool("capsule");
  };

  return <main className="tg-studio">
    <header className="tg-header"><a className="tg-brand" href="?studio=type">TYPE <span>×</span> GEOMETRY</a><span className="tg-stage">01 / 圖案幾何研究</span><nav><button className="tg-settings-toggle" aria-expanded={settingsOpen} onClick={() => setSettingsOpen(!settingsOpen)}>參數</button><button onClick={() => fileInput.current?.click()}>開啟配方</button><button onClick={() => download(projectJson(doc), "type-geometry-recipe.json", "application/json")}>保存配方</button><button aria-label="送往 DSSC Layout" disabled={!canExport} onClick={sendToLayout}>DSSC Layout ↗</button></nav></header>
    <input ref={fileInput} type="file" accept=".json,application/json" hidden aria-label="匯入配方" onChange={(e) => { void readProject(e.target.files?.[0]); e.target.value = ""; }}/>
    <input ref={fontInput} type="file" accept=".otf,.ttf,.woff" hidden aria-label="匯入字型" onChange={(e) => { void pickFont(e.target.files?.[0]); e.target.value = ""; }}/>
    <div className="tg-layout">
      <aside className={`tg-sidebar ${settingsOpen ? "is-open" : ""}`} onPointerDownCapture={(e) => { if ((e.target as HTMLInputElement).type === "range") begin(); }} onPointerUpCapture={end} onPointerCancelCapture={end}>
        <div className="tg-intro"><span className="tg-kicker">BLACK / WHITE · VECTOR LAB</span><h1>字形與幾何<br/>共同構成。</h1><p>先形成圖案，再進行電極配置。每個控制都作用在輪廓上。</p></div>
        <div className="tg-flavors" role="group" aria-label="視覺風味"><button data-flavor="fluid" aria-pressed={doc.active === "fluid"} onClick={() => setFlavor("fluid")}>A 自由形變</button><button data-flavor="pixel" aria-pressed={doc.active === "pixel"} onClick={() => setFlavor("pixel")}>B Pixel / Glitch</button></div>
        <fieldset><legend>01 / 配方</legend><div className="tg-presets">{PRESETS.filter((p) => p.flavor === doc.active).map((p) => <button key={p.id} data-preset={p.id} aria-pressed={recipe.preset === p.id} onClick={() => changePreset(p.id)}><b>{p.name}</b><small>{p.description}</small></button>)}</div></fieldset>
        <fieldset><legend>02 / 字形與排版</legend>
          <label className="tg-label">標題文字 <small>英文／數字／標點 · 最多 6 行</small><textarea aria-label="標題文字" spellCheck={false} rows={3} value={recipe.text} maxLength={120} onChange={(e) => {
            const input = e.target.value;
            if (/[^\x20-\x7e\n]/.test(input)) setMessage("第一版接受英文、數字與標點；不加入 Unicode combining marks。");
            update((r) => { r.text = input.replace(/[^\x20-\x7e\n]/g, "").split("\n").slice(0, 6).join("\n"); r.edits = {}; r.capsule.edits = {}; });
          }}/></label>
          <label className="tg-label">字型輪廓<select aria-label="字型" value={recipe.font} onChange={(e) => update((r) => { r.font = e.target.value as Recipe["font"]; r.edits = {}; })}>{FONT_OPTIONS.map((f) => <option key={f.id} value={f.id}>{f.label}</option>)}{doc.customFont && <option value="custom">{doc.customFont.name}</option>}</select></label>
          <button className="tg-subtle" onClick={() => fontInput.current?.click()}>＋ 載入 OTF / TTF / WOFF</button>
          <div className="tg-pair"><Numeric label="寬 mm" value={recipe.width} min={20} max={150} step={1} onChange={(v) => update((r) => { r.width = v; r.margin = Math.min(r.margin, v / 4); })}/><Numeric label="高 mm" value={recipe.height} min={20} max={150} step={1} onChange={(v) => update((r) => { r.height = v; r.margin = Math.min(r.margin, v / 4); })}/></div>
          <Range label="外邊距 mm" value={recipe.margin} min={0.5} max={Math.min(recipe.width, recipe.height) / 4} step={0.1} onChange={(v) => update((r) => { r.margin = v; })}/>
          <Range label="行間距 mm" value={recipe.lineGap} min={0} max={3} step={0.1} onChange={(v) => update((r) => { r.lineGap = v; })}/>
          <Range label="字距" value={recipe.tracking} min={-0.08} max={0.15} step={0.005} onChange={(v) => update((r) => { r.tracking = v; })}/>
        </fieldset>
        {capsulePreset && <fieldset className="tg-capsule-controls"><legend>CAPSULE / 字形與膠囊共排</legend>
          <div className="tg-capsule-styles" role="group" aria-label="膠囊構圖方式">
            <button data-capsule-style="lines" aria-pressed={cap.layout === "fit" && cap.units === "lines"} onClick={() => capsuleStyle("lines")}>字行包覆</button>
            <button data-capsule-style="words" aria-pressed={cap.layout === "fit" && cap.units === "words"} onClick={() => capsuleStyle("words")}>字詞拼版</button>
            <button data-capsule-style="weave" aria-pressed={cap.layout === "weave"} onClick={() => capsuleStyle("weave")}>條帶交織</button>
          </div>
          <small>{cap.layout === "fit" ? "字面按膠囊的可用空間排版；圓端順形、字長比例與錯位共同決定構圖。" : "完整標題與膠囊條帶共同生成正負形；條帶可旋轉、錯位與逐顆移動。"}</small>
          <label className="tg-label">膠囊方向<select aria-label="膠囊方向" value={cap.direction} onChange={(e) => update((r) => { r.capsule.direction = e.target.value as typeof cap.direction; r.capsule.edits = {}; })}><option value="horizontal">橫向節奏</option><option value="vertical">直向節奏</option></select></label>
          <label className="tg-label">字形／膠囊組合<select aria-label="膠囊文字組合" value={cap.operation} onChange={(e) => update((r) => { r.capsule.operation = e.target.value as typeof cap.operation; })}><option value="knockout">膠囊挖空文字</option><option value="xor">XOR 正負形交織</option><option value="intersect">只留文字交集</option><option value="outline">字形＋膠囊線框</option></select></label>
          {cap.layout === "fit" && <small>目前 {capsuleTexts(recipe).length} 個文字塊；每塊文字各有一個膠囊，依每排上限流動排列。</small>}
          <Range label={cap.layout === "fit" ? "每排膠囊數" : "節奏條數"} value={cap.lanes} min={1} max={6} step={1} onChange={(v) => update((r) => { r.capsule.lanes = v; r.capsule.edits = {}; r.edits = {}; })}/>
          {cap.layout === "weave" && <Range label="每條段數" value={cap.segments} min={1} max={6} step={1} onChange={(v) => update((r) => { r.capsule.segments = v; r.capsule.edits = {}; })}/>}
          <Range label="膠囊間距 mm" value={cap.gap} min={0} max={5} step={0.1} onChange={(v) => update((r) => { r.capsule.gap = v; })}/>
          <Range label="交錯位移" value={cap.stagger} min={-1} max={1} onChange={(v) => update((r) => { r.capsule.stagger = v; })}/>
          <Range label="長短變化" value={cap.variation} min={0} max={1} onChange={(v) => update((r) => { r.capsule.variation = v; })}/>
          <Range label="端部圓度" value={cap.roundness} min={0.1} max={1} onChange={(v) => update((r) => { r.capsule.roundness = v; })}/>
          {cap.layout === "fit" && <>
            <Range label="字面內留白" value={cap.padding} min={0.03} max={0.25} onChange={(v) => update((r) => { r.capsule.padding = v; })}/>
            <Range label="圓端順形" value={cap.follow} min={0} max={1} onChange={(v) => update((r) => { r.capsule.follow = v; })}/>
            {cap.lanes > 1 && <Range label="按字長分配寬度" value={cap.proportion} min={0} max={1} onChange={(v) => update((r) => { r.capsule.proportion = v; })}/>}
          </>}
          <Numeric label="節奏 Seed" value={cap.seed} min={0} max={4294967295} step={1} onChange={(v) => update((r) => { r.capsule.seed = Math.trunc(v); })}/>
          <button className="tg-subtle" onClick={() => update((r) => { r.capsule.seed = (r.capsule.seed + 7919) >>> 0; })}>↻ 只改長短節奏</button>
          <button className="tg-subtle" onClick={() => { setTool("capsule"); setSelected(null); }}>在畫布拖曳單顆膠囊 ↗</button>
          <button className="tg-subtle" onClick={() => update((r) => { r.capsule.edits = {}; })}>重設單顆位置／旋轉</button>
          {selectedCapsule && capsuleElement && capsuleEdit && <div className="tg-capsule-selection"><b>選取膠囊 / {capsuleElement.label}</b>
            <Range label="膠囊旋轉 °" value={capsuleEdit.angle} min={-60} max={60} step={1} onChange={(v) => update((r) => { r.capsule.edits[selectedCapsule] = { ...capsuleEdit, angle: v }; })}/>
            <Range label="膠囊整組比例" value={capsuleEdit.scale} min={0.5} max={1.5} onChange={(v) => update((r) => { r.capsule.edits[selectedCapsule] = { ...capsuleEdit, scale: v }; })}/>
            <small>{cap.layout === "fit" ? "此膠囊與內部字形會一起移動、旋轉和縮放。" : "移動條帶即重新計算與整幅標題的交織區域。"}</small>
          </div>}
        </fieldset>}
        <fieldset><legend>03 / {doc.active === "fluid" ? "連續形變" : "階梯與故障"}</legend>
          {doc.active === "fluid" ? <>
            <Range label="收腰／膨脹" value={recipe.warp.squeeze} min={-0.8} max={0.8} onChange={(v) => update((r) => { r.warp.squeeze = v; })}/>
            <Range label="波浪" value={recipe.warp.wave} min={-0.8} max={0.8} onChange={(v) => update((r) => { r.warp.wave = v; })}/>
            <Range label="傾斜" value={recipe.warp.slant} min={-0.6} max={0.6} onChange={(v) => update((r) => { r.warp.slant = v; })}/>
            <button className="tg-subtle" onClick={() => update((r) => { r.warp.cage = r.warp.cage.map(() => ({ x: 0, y: 0 })); })}>重設拖曳控制點</button>
          </> : <>
            <Range label="階梯尺寸 mm" value={recipe.pixel.pitch} min={0.3} max={2.5} step={0.05} onChange={(v) => update((r) => { r.pixel.pitch = v; })}/>
            <Range label="格點相位" value={recipe.pixel.phase} min={0} max={1} onChange={(v) => update((r) => { r.pixel.phase = v; })}/>
            <Range label="切帶數量" value={recipe.pixel.bands} min={0} max={12} step={1} onChange={(v) => update((r) => { r.pixel.bands = v; })}/>
            <Range label="錯位距離 mm" value={recipe.pixel.shift} min={0} max={4} step={0.1} onChange={(v) => update((r) => { r.pixel.shift = v; })}/>
            <Range label="局部缺口" value={recipe.pixel.damage} min={0} max={0.35} onChange={(v) => update((r) => { r.pixel.damage = v; })}/>
            <label className="tg-check"><input type="checkbox" aria-label="階梯底板" checked={recipe.pixel.backing} onChange={(e) => update((r) => { r.pixel.backing = e.target.checked; })}/>階梯底板／字面挖空</label>
          </>}
        </fieldset>
        <fieldset><legend>04 / 幾何正負形</legend>
          <label className="tg-check"><input type="checkbox" aria-label="幾何遮罩" checked={recipe.mask.enabled} onChange={(e) => update((r) => { r.mask.enabled = e.target.checked; })}/>啟用幾何遮罩</label>
          <div className="tg-pair"><select aria-label="遮罩形狀" value={recipe.mask.shape} onChange={(e) => update((r) => { r.mask.shape = e.target.value as Recipe["mask"]["shape"]; })}><option value="ellipse">橢圓</option><option value="star">星形</option><option value="diamond">菱形</option><option value="band">帶狀</option></select><select aria-label="布林運算" value={recipe.mask.operation} onChange={(e) => update((r) => { r.mask.operation = e.target.value as Recipe["mask"]["operation"]; })}><option value="xor">XOR 反相</option><option value="subtract">差集／切除</option><option value="intersect">交集</option><option value="union">聯集</option></select></div>
          <Range label="遮罩寬度" value={recipe.mask.width} min={0.1} max={1.3} onChange={(v) => update((r) => { r.mask.width = v; })}/>
          <Range label="遮罩高度" value={recipe.mask.height} min={0.1} max={1.3} onChange={(v) => update((r) => { r.mask.height = v; })}/>
          <Range label="遮罩角度 °" value={recipe.mask.angle} min={-180} max={180} step={1} onChange={(v) => update((r) => { r.mask.angle = v; })}/>
          <label className="tg-check"><input type="checkbox" aria-label="交換正負形" checked={recipe.inverted} onChange={(e) => update((r) => { r.inverted = e.target.checked; })}/>交換 A／B 正負形</label>
        </fieldset>
        <fieldset><legend>05 / 可選角色</legend>
          <label className="tg-check"><input type="checkbox" aria-label="加入角色" checked={recipe.character.enabled} onChange={(e) => update((r) => { r.character.enabled = e.target.checked; })}/>加入原創幾何角色</label>
          <Numeric label="角色 Seed" value={recipe.character.seed} min={0} max={4294967295} step={1} onChange={(v) => update((r) => { r.character.seed = Math.trunc(v); })}/>
          <button className="tg-subtle" onClick={() => update((r) => { r.character.seed = (r.character.seed + 104729) >>> 0; })}>↻ 只重新生成角色</button>
          <Range label="角色大小" value={recipe.character.size} min={0.08} max={0.4} onChange={(v) => update((r) => { r.character.size = v; })}/>
          <select aria-label="角色組合方式" value={recipe.character.operation} onChange={(e) => update((r) => { r.character.operation = e.target.value as "union" | "xor"; })}><option value="xor">XOR／反相加入</option><option value="union">聯集加入 A</option></select>
          <small>獨立 seed；開關不重新排字。啟用時角色會進入實際圖案輪廓。</small>
        </fieldset>
        <fieldset><legend>06 / DSSC 配置目標</legend>
          <Numeric label="目標 Voc V" value={targets.vocV} min={0.1} max={40} onChange={(vocV) => setTargets((v) => ({ ...v, vocV }))}/>
          <Numeric label="目標 Isc mA" value={targets.iscMa} min={0} max={100} onChange={(iscMa) => setTargets((v) => ({ ...v, iscMa }))}/>
          <p className="tg-note">送出已解析的 A 集合、孔洞與配方。Layout 依 W 串聯交換兩片材料，重新產生補膠／流道與有效面積；A 不是固定屬於某一片玻璃。</p>
          <button className="tg-subtle" disabled={!canExport} onClick={sendToLayout}>將目前圖案送往 DSSC ↗</button>
          <small>會建立暫存試作，保留原 Layout 的參考電性與製程輸入。目標不是成品保證；請在 Layout 檢查製程及搜尋結果。</small>
        </fieldset>
        {selected && selectedEdit && <fieldset><legend>選取字母 / {selectedElement?.label}</legend><Range label="字母旋轉 °" value={selectedEdit.angle} min={-60} max={60} step={1} onChange={(v) => update((r) => { r.edits[selected] = { ...selectedEdit, angle: v }; })}/><Range label="字母比例" value={selectedEdit.scale} min={0.5} max={1.5} onChange={(v) => update((r) => { r.edits[selected] = { ...selectedEdit, scale: v }; })}/><button className="tg-subtle" onClick={() => update((r) => { delete r.edits[selected]; })}>重設此字母</button></fieldset>}
      </aside>
      <section className="tg-work">
        <div className="tg-toolbar"><div className="tg-tools" role="group" aria-label="畫布工具">{([ ["pan", "拖移"], ["cage", "整體變形"], ["rows", "行高"], ["glyph", "字母"], ["mask", "遮罩"], ["character", "角色"], ...(capsulePreset ? [["capsule", "膠囊"] as const] : []) ] as const).map(([id, label]) => <button key={id} data-tool={id} aria-pressed={tool === id} onClick={() => setTool(id)}>{label}</button>)}</div><div className="tg-tools"><button aria-label="復原" disabled={!history.past.length} onClick={undo}>↶</button><button aria-label="重做" disabled={!history.future.length} onClick={redo}>↷</button><button onClick={fit}>Fit</button><span>{Math.round(camera.zoom * 100)}%</span></div></div>
        <div className="tg-canvas-area">
          <div className="tg-art-label"><span>{doc.active === "fluid" ? "A / CONTINUOUS FORM" : "B / STEPPED GEOMETRY"}</span><span>{currentPreset.name} · {recipe.width} × {recipe.height} mm</span></div>
          <svg ref={svgRef} className={`tg-canvas tool-${tool}`} viewBox={`${camera.x} ${camera.y} ${recipe.width / camera.zoom} ${recipe.height / camera.zoom}`} role="img" aria-label="黑白字形與幾何畫布" data-stage="resolved-artwork-not-fabrication" data-pending={pending} data-flavor={doc.active}
            onDoubleClick={fit} onPointerMove={moveDrag} onPointerUp={finishDrag} onPointerCancel={finishDrag} onLostPointerCapture={() => { if (drag.current) { drag.current = null; end(); } }}
            onPointerDown={(e) => {
              if (e.button === 1 || tool === "pan") {
                (e.currentTarget as SVGSVGElement & { panStart?: { x: number; y: number } }).panStart = { x: e.clientX, y: e.clientY };
                startDrag(e, "pan"); return;
              }
              if (tool === "mask" && recipe.mask.enabled) startDrag(e, "mask");
              if (tool === "character" && recipe.character.enabled) startDrag(e, "character");
              if (tool === "glyph" && art) {
                const p = getPoint(e.clientX, e.clientY);
                const target = [...art.elements].reverse().find((el) => el.kind === "glyph" && componentAt(p, el.polygons) >= 0);
                setSelected(target?.id ?? null); if (target) startDrag(e, "glyph", undefined, target.id);
              }
            }}>
            <rect x={0} y={0} width={recipe.width} height={recipe.height} fill="white"/>
            {art && <path data-set="A" d={pathData(showB ? art.b : art.a)} fill="black" fillRule="evenodd"/>}
            <g className="tg-guides" data-layer="editor-only" fill="none" stroke="#777" strokeWidth={0.09 / camera.zoom}>
              {tool === "cage" && recipe.warp.cage.map((p, i) => {
                const x = (i % 3) * recipe.width / 2 + p.x * recipe.width, y = Math.floor(i / 3) * recipe.height / 2 + p.y * recipe.height;
                // Inset outer handles for easier picking at the physical page edge.
                return <circle key={i} data-handle={`cage-${i}`} cx={clamp(x, 0.8, recipe.width - 0.8)} cy={clamp(y, 0.8, recipe.height - 0.8)} r={0.6 / camera.zoom} fill="white" stroke="black" onPointerDown={(e) => startDrag(e, "cage", i)}/>;
              })}
              {tool === "mask" && recipe.mask.enabled && art && <><path d={pathData(art.mask)} pointerEvents="none"/><circle data-handle="mask" cx={recipe.mask.x * recipe.width} cy={recipe.mask.y * recipe.height} r={0.65 / camera.zoom} fill="white" stroke="black" onPointerDown={(e) => startDrag(e, "mask")}/></>}
              {tool === "character" && charBounds && <rect data-handle="character" x={charBounds.x - 0.4} y={charBounds.y - 0.4} width={charBounds.width + 0.8} height={charBounds.height + 0.8} onPointerDown={(e) => startDrag(e, "character")}/>}
              {tool === "glyph" && selection && <rect x={selection.x - 0.3} y={selection.y - 0.3} width={selection.width + 0.6} height={selection.height + 0.6} pointerEvents="none"/>}
              {tool === "capsule" && art?.elements.filter((e) => e.kind === "geometry").map((element) => <path key={element.id} data-capsule-target={element.groupId} d={pathData(element.polygons)} fill="transparent" stroke={element.groupId === selectedCapsule ? "black" : "#888"} strokeWidth={(element.groupId === selectedCapsule ? 0.16 : 0.06) / camera.zoom} style={{ cursor: "move" }} onPointerDown={(e) => { if (e.button === 1) return; setSelectedCapsule(element.groupId!); setSelected(null); startDrag(e, "capsule", undefined, element.groupId); }}/>) }
              {tool === "rows" && art?.dividers.map((d) => {
                const x = (d.from.x + d.to.x) / 2, y = (d.from.y + d.to.y) / 2;
                return <g key={d.index}><line x1={d.from.x} y1={d.from.y} x2={d.to.x} y2={d.to.y}/><rect data-handle={`row-${d.index}`} x={x - 1} y={y - 0.4} width={2} height={0.8} fill="white" stroke="black" onPointerDown={(e) => startDrag(e, "rows", d.index)}/></g>;
              })}
            </g>
          </svg>
          <div className="tg-canvas-caption"><span>{tool === "cage" ? "拖曳 9 個控制點，連續改變整組輪廓" : tool === "glyph" ? "點選字母並拖曳；旋轉與比例在左側" : tool === "rows" ? "拖動排版分界，重新分配字面與膠囊空間" : tool === "capsule" ? "拖曳單顆膠囊；包覆模式的內部字形一起移動" : tool === "mask" ? "拖動畫布移動遮罩；尺寸與角度在左側" : tool === "character" ? "拖動畫布移動角色；其他元素保持不變" : "拖動畫布平移"} · 滾輪縮放</span><label><input type="checkbox" checked={showB} onChange={(e) => setShowB(e.target.checked)}/>檢視 B 集合</label></div>
        </div>
        <section className="tg-results" aria-label="幾何結果">
          <div className="tg-result-heading"><span className={`tg-status ${error ? "is-error" : ""}`} role="status">{error ? "幾何未解析" : pending ? "正在解析輪廓…" : "已解析圖案幾何"}</span><span>尚未進行 W-type／電性／流道檢查</span></div>
          {error && <p role="alert">{error}</p>}
          {art && <div className="tg-stats"><div><small>A · 黑</small><b data-stat="area-a">{art.stats.areaA.toFixed(2)} <em>mm²</em></b></div><div><small>B · 白</small><b data-stat="area-b">{art.stats.areaB.toFixed(2)} <em>mm²</em></b></div><div><small>A 占比</small><b>{(art.stats.coverage * 100).toFixed(1)}%</b></div><div><small>分量／孔洞</small><b>{art.stats.components} / {art.stats.holes}</b></div></div>}
          {art?.warnings.map((w) => <p className="tg-warning" key={w}>{w}</p>)}
          <div className="tg-exports"><button disabled={!canExport} onClick={() => download(artworkSvg(art!, doc), `artwork-${doc.active}-${recipe.seed}.svg`, "image/svg+xml")}>圖案 SVG ↓</button><button disabled={!canExport} onClick={() => download(geometryJson(art!, doc), `artwork-geometry-${doc.active}.json`, "application/json")}>幾何 JSON ↓</button><button onClick={() => download(projectJson(doc), "type-geometry-recipe.json", "application/json")}>配方 JSON ↓</button><button disabled={!canExport || pngBusy} onClick={() => {
            setPngBusy(true); void downloadPng(art!, doc).catch((e) => setMessage(String(e.message ?? e))).finally(() => setPngBusy(false));
          }}>{pngBusy ? "轉換中…" : "預覽 PNG ↓"}</button></div>
          <p className="tg-note">黑白是 A／B 形狀集合，尚未分配 TiO₂／Pt。SVG 只含已解析輪廓與孔洞；不含控制點、字型依賴或螢幕疊層。右上 DSSC Layout 會把這份幾何送入電極、補膠與流道流程；Studio 匯出本身不是製造包。</p>
          {(message || storageError) && <p className="tg-message" role="status" onClick={() => setMessage("")}>{storageError || message}</p>}
        </section>
        <section className="tg-variations"><div className="tg-variation-head"><div><span className="tg-kicker">EXPLORE / 保留設計規則</span><h2>同一配方，不同節奏。</h2></div><div><Numeric label="版型 Seed" value={recipe.seed} min={0} max={4294967295} step={1} onChange={(v) => update((r) => { r.seed = Math.trunc(v); })}/><button disabled={!canExport || makingVariants} onClick={() => void makeVariants()}>{makingVariants ? "生成中…" : "生成 6 個變體 ↗"}</button></div></div>
          <div className="tg-locks"><span>保留字型與文字</span><label><input type="checkbox" checked={locks.layout} onChange={(e) => setLocks({ ...locks, layout: e.target.checked })}/>鎖定排版／形變</label><label><input type="checkbox" checked={locks.mask} onChange={(e) => setLocks({ ...locks, mask: e.target.checked })}/>鎖定遮罩</label><span>角色始終獨立</span></div>
          <div className="tg-variant-grid">{variants.length ? variants.map((v) => <button key={v.recipe.seed} className="tg-variant" data-variant={v.recipe.seed} onClick={() => { update((r) => { const character = r.character; Object.assign(r, clone(v.recipe)); r.character = character; }); setSelected(null); }}><svg viewBox={`0 0 ${v.art.width} ${v.art.height}`}><rect width={v.art.width} height={v.art.height} fill="white"/><path d={pathData(v.art.a)} fill="black" fillRule="evenodd"/></svg><span>{v.recipe.seed} <small>{(v.art.stats.coverage * 100).toFixed(0)}% A</small></span></button>) : <div className="tg-empty">從同一份字形與幾何規則產生候選，選一張繼續編輯。</div>}</div>
        </section>
      </section>
    </div>
  </main>;
}
