import {
  lazy,
  Suspense,
  startTransition,
  useDeferredValue,
  useEffect,
  useId,
  useRef,
  useState,
} from "react";

import {
  downloadProjectBundle,
  downloadScreenTiff,
  downloadSvgAsset,
  screenTiffFilename,
} from "./export";
import {
  buildPointCodeArtwork,
  validatePointCodeArtwork,
} from "./point-code";
import { buildGeometry, validateDesign } from "./geometry";
import {
  DEFAULT_CONFIG,
  type DesignConfig,
  type LayoutGeometry,
  type PointCodeArtwork,
  type PreviewMode,
} from "./model";
import { electricalEstimate, migrateGlassHeight, sealProcess, updateProcessConfig } from "./process";
import { zebraContactRegions } from "./contacts";
import { parseReviewSettings, REVIEW_STORAGE_KEY, type ReviewSettings } from "./review-model";
import { ReviewBoundary } from "./ReviewBoundary";
import { Help, HelpProvider } from "./Help";
import { PARAMETER_HELP } from "./parameter-help";
import { useI18n, dictionaries } from "./i18n";
import type { UiKey } from "./locales/en";
import { parameterHelp, parameterLabel } from "./locales/parameters";
import { diagnosticText, resolveDiagnostic } from "./locales/diagnostics";
import { FTO_PRESETS } from "./electrical";
import type { FtoPreset } from "./model";
import { DSSC_REFERENCE, VOLTAGE_OBSERVATIONS } from "./reference-data";
import type { VoltageObservationId } from "./reference-data";
import {
  buildFabricationAssets,
  buildPreviewSvg,
  previewSize,
  type SvgAsset,
} from "./svg";

interface DerivedDesign {
  config: DesignConfig;
  geometry: LayoutGeometry;
  pointCodeArtwork: PointCodeArtwork;
  assets: SvgAsset[];
}

const Review3D = lazy(() => import("./Review3D"));
type AppView = PreviewMode | "review-3d";
function loadReviewSettings() {
  try { return parseReviewSettings(localStorage.getItem(REVIEW_STORAGE_KEY)); }
  catch { return parseReviewSettings(null); }
}

interface ExportProgress {
  completed: number;
  total: number;
  label: string;
}

interface ViewMetadata {
  layer: string;
  description: UiKey;
  legend: Array<{ swatch: string; label: UiKey }>;
}

interface PreviewCamera {
  scale: number;
  x: number;
  y: number;
}

interface PanSession {
  pointerId: number;
  clientX: number;
  clientY: number;
  cameraX: number;
  cameraY: number;
}

const STORAGE_KEY = "w-series-voronoi-layout-v6";
const SCREEN_6066_ASSET_ID = "screen-glass-6066-tio2";
const SCREEN_6060_ASSET_ID = "screen-glass-6060-tio2";
const MIN_PREVIEW_SCALE = 0.25;
const MAX_PREVIEW_SCALE = 8;
const FIT_CAMERA: PreviewCamera = { scale: 1, x: 0, y: 0 };

const VIEWS: Array<{ id: PreviewMode; label: UiKey }> = [
  { id: "assembly", label: "Final Assembly" },
  { id: "circuit", label: "Circuit" },
  { id: "glass-6066", label: "Screen Bigger" },
  { id: "glass-6060", label: "Screen Smaller" },
  { id: "etch-6066", label: "Etch Bigger" },
  { id: "etch-6060", label: "Etch Smaller" },
  { id: "binding", label: "Binding" },
];

const VIEW_METADATA: Record<PreviewMode, ViewMetadata> = {
  assembly: {
    layer: "User.Assembly",
    description: "Coatings and shared AB-313 stage; hatched ± areas mark exposed bigger-electrode FTO for zebra contacts.",
    legend: [
      { swatch: "gray-fill", label: "Top-level TiO2 region" },
      { swatch: "dark-fill", label: "Top-level Pt region" },
      { swatch: "black-fill", label: "AB-313 printed seal" },
      { swatch: "white-fill", label: "Uncoated / no glue" },
      { swatch: "contact-hatch", label: "± Zebra contact FTO" },
    ],
  },
  circuit: {
    layer: "Dwgs.Circuit",
    description: "Dual-plate net map; ordered electron route is always visible.",
    legend: [
      { swatch: "gray-fill", label: "TiO2 cell" },
      { swatch: "hatch-fill", label: "Pt cell" },
      { swatch: "route-line", label: "Electron route" },
    ],
  },
  "glass-6066": {
    layer: "Fab.Screen.Bigger.TiO2",
    description: "Black = active TiO2 after seal, alignment and etch clearance.",
    legend: [
      { swatch: "black-fill", label: "Top-level TiO2 region" },
      { swatch: "white-fill", label: "Pt / no TiO2 print" },
    ],
  },
  "glass-6060": {
    layer: "Fab.Screen.Smaller.TiO2",
    description: "Black = active TiO2 after seal, alignment and etch clearance.",
    legend: [
      { swatch: "black-fill", label: "Top-level TiO2 region" },
      { swatch: "white-fill", label: "Pt / no TiO2 print" },
    ],
  },
  "etch-6066": {
    layer: "FTO.Etch.Bigger",
    description: "Black = canonical FTO removal centerline; white = retained FTO.",
    legend: [
      { swatch: "route-line", label: "FTO removal centerline" },
      { swatch: "white-fill", label: "Retained FTO" },
    ],
  },
  "etch-6060": {
    layer: "FTO.Etch.Smaller",
    description: "Black = canonical FTO removal centerline; white = retained FTO.",
    legend: [
      { swatch: "route-line", label: "FTO removal centerline" },
      { swatch: "white-fill", label: "Retained FTO" },
    ],
  },
  binding: {
    layer: "User.Binding",
    description: "Black = AB-313 print; white slots = top-down fill / vent openings.",
    legend: [
      { swatch: "black-fill", label: "AB-313 printed seal" },
      { swatch: "white-fill", label: "No adhesive" },
    ],
  },
};

function loadInitialConfig(): DesignConfig {
  try {
    const stored = localStorage.getItem(STORAGE_KEY) ?? localStorage.getItem("w-series-voronoi-layout-v5");
    if (!stored) return { ...DEFAULT_CONFIG, bindingWidthMm: Number(sealProcess(DEFAULT_CONFIG).recommendedBindingMm.toFixed(2)) };
    const parsed = JSON.parse(stored) as Partial<DesignConfig> & { glass6066HeightMm?: number; glass6060HeightMm?: number };
    parsed.glassHeightMm = migrateGlassHeight(parsed);
    const loaded = Object.fromEntries(
      (Object.keys(DEFAULT_CONFIG) as Array<keyof DesignConfig>).map((key) => [
        key,
        key === "text" ? "" : typeof parsed[key] === typeof DEFAULT_CONFIG[key] ? parsed[key] : DEFAULT_CONFIG[key],
      ]),
    ) as unknown as DesignConfig;
    if (loaded.electricalBasis !== "reference-cell" && loaded.electricalBasis !== "jsc-input") loaded.electricalBasis = "reference-cell";
    if (!["same-light", "irradiance", "lux-ratio"].includes(loaded.referenceLightMode)) loaded.referenceLightMode = "same-light";
    // Preserve a manually entered voltage. Migrate only the formerly unknown
    // area now explicitly supplied by the user; never replace a custom area.
    if (!parsed.referenceVoltageObservation || !(loaded.referenceVoltageObservation === "manual" || loaded.referenceVoltageObservation in VOLTAGE_OBSERVATIONS)) loaded.referenceVoltageObservation = "manual";
    if (parsed.referenceAreaMm2 === 0) loaded.referenceAreaMm2 = DSSC_REFERENCE.areaMm2;
    for (const key of ["ftoBiggerPreset", "ftoSmallerPreset"] as const) {
      if (loaded[key] !== "custom" && !(loaded[key] in FTO_PRESETS)) loaded[key] = "custom";
    }
    return updateProcessConfig(updateProcessConfig(updateProcessConfig(loaded, "beadDiameterUm", loaded.beadDiameterUm),
      "ftoBiggerPreset", loaded.ftoBiggerPreset), "ftoSmallerPreset", loaded.ftoSmallerPreset);
  } catch {
    return { ...DEFAULT_CONFIG };
  }
}

function deriveDesign(config: DesignConfig): DerivedDesign {
  const geometry = buildGeometry(config);
  const pointCodeArtwork = buildPointCodeArtwork(config, geometry);
  const assets = buildFabricationAssets(config, geometry, pointCodeArtwork);
  return { config, geometry, pointCodeArtwork, assets };
}

function Section({
  title,
  children,
}: {
  title: UiKey;
  children: React.ReactNode;
}) {
  const { t } = useI18n();
  return (
    <section className="form-section">
      <h2>{t(title)}</h2>
      {children}
    </section>
  );
}

function NumberRow({
  label,
  value,
  min,
  max,
  step,
  unit = "mm",
  onChange,
}: {
  label: keyof typeof PARAMETER_HELP;
  value: number;
  min: number;
  max: number;
  step: number;
  unit?: string;
  onChange: (value: number) => void;
}) {
  const { locale, t } = useI18n();
  const focused = useRef(false);
  const helpId = useId();
  const [draft, setDraft] = useState(() => String(value));

  useEffect(() => {
    if (!focused.current) setDraft(String(value));
  }, [value]);

  const commit = () => {
    const next = draft.trim();
    setDraft(String(value));
    if (next === "") return;

    const parsed = Number(next);
    if (Number.isFinite(parsed)) onChange(Math.min(max, Math.max(min, parsed)));
  };

  return (
    <Help as="label" className="form-row" id={helpId} content={parameterHelp(label, locale)} data-parameter={label}>
      <span>{parameterLabel(label, locale)}</span>
      <span className="input-with-unit">
        <input
          className="number-draft"
          type="text"
          inputMode="decimal"
          autoComplete="off"
          aria-describedby={helpId}
          value={draft}
          data-min={min}
          data-max={max}
          data-step={step}
          onFocus={() => {
            focused.current = true;
          }}
          onChange={(event) => setDraft(event.target.value)}
          onBlur={() => {
            focused.current = false;
            commit();
          }}
          onKeyDown={(event) => {
            if (event.key === "Enter") {
              event.preventDefault();
              event.currentTarget.blur();
            } else if (event.key === "Escape") {
              event.preventDefault();
              setDraft(String(value));
            }
          }}
        />
        <small>{unit === "even" ? t("unitsEven") : unit === "ratio" ? t("unitsRatio") : unit === "grade mesh" ? t("unitsGrade") : unit === "µm/edge" ? t("unitsPerEdge") : unit}</small>
      </span>
    </Help>
  );
}

function SelectRow({ label, value, options, onChange }: {
  label: keyof typeof PARAMETER_HELP;
  value: string;
  options: Array<{ value: string; label: string }>;
  onChange: (value: string) => void;
}) {
  const helpId = useId();
  const { locale, t } = useI18n();
  const optionText = (text: string) => text === "A · early baseline" ? t("earlyBaseline")
    : text in dictionaries.en ? t(text as UiKey) : text.replace(/ typ\.$/, ` ${t("typical")}`);
  return <Help as="label" className="form-row" id={helpId} content={parameterHelp(label, locale)} data-parameter={label}>
    <span>{parameterLabel(label, locale)}</span>
    <select className="number-draft" value={value} aria-describedby={helpId} onChange={(event) => onChange(event.target.value)}>
      {options.map((option) => <option key={option.value} value={option.value}>{optionText(option.label)}</option>)}
    </select>
  </Help>;
}

const FTO_OPTIONS = [
  ...Object.entries(FTO_PRESETS).map(([value, preset]) => ({ value, label: `${preset.name} · ${preset.ohmSq} Ω/□ typ.` })),
  { value: "custom", label: "Custom / measured" },
];

function App() {
  const { locale, setLocale, t } = useI18n();
  const msg = (message: string) => diagnosticText(message, locale);
  const [config, setConfig] = useState<DesignConfig>(loadInitialConfig);
  const [derived, setDerived] = useState<DerivedDesign>(() =>
    deriveDesign(config),
  );
  const [mode, setMode] = useState<AppView>("assembly");
  const is3D = mode === "review-3d";
  const svgMode: PreviewMode = is3D ? "assembly" : mode;
  const [reviewSettings, setReviewSettings] = useState<ReviewSettings>(loadReviewSettings);
  const [compressionEnvelope, setCompressionEnvelope] = useState(false);
  const [previewSvg, setPreviewSvg] = useState(() =>
    buildPreviewSvg(
      derived.config,
      derived.geometry,
      derived.pointCodeArtwork,
      "assembly",
    ),
  );
  const [previewCamera, setPreviewCamera] = useState<PreviewCamera>(FIT_CAMERA);
  const [isPanning, setIsPanning] = useState(false);
  const [generationError, setGenerationError] = useState("");
  const [exportError, setExportError] = useState("");
  const [exportProgress, setExportProgress] = useState<ExportProgress | null>(
    null,
  );
  const exportLock = useRef(false);
  const previewWorkspaceRef = useRef<HTMLDivElement>(null);
  const panSession = useRef<PanSession | null>(null);
  const deferredConfig = useDeferredValue(config);
  const pending = deferredConfig !== config || derived.config !== config;

  useEffect(() => {
    try {
      localStorage.setItem(STORAGE_KEY, JSON.stringify(config));
    } catch {
      // Local persistence is optional.
    }
  }, [config]);

  useEffect(() => {
    try { localStorage.setItem(REVIEW_STORAGE_KEY, JSON.stringify(reviewSettings)); }
    catch { /* Visual preferences are optional. */ }
  }, [reviewSettings]);

  useEffect(() => {
    const timer = window.setTimeout(() => {
      try {
        const next = deriveDesign(deferredConfig);
        startTransition(() => {
          setDerived(next);
          setGenerationError("");
        });
      } catch (error) {
        setGenerationError(
          error instanceof Error ? error.message : "Geometry generation failed.",
        );
      }
    }, 35);
    return () => window.clearTimeout(timer);
  }, [deferredConfig]);

  useEffect(() => {
    if (is3D) return;
    startTransition(() => {
      setPreviewSvg(
        buildPreviewSvg(
          derived.config,
          derived.geometry,
          derived.pointCodeArtwork,
          svgMode,
          compressionEnvelope,
        ),
      );
    });
  }, [derived, mode, compressionEnvelope]);

  useEffect(() => {
    setPreviewCamera({ ...FIT_CAMERA });
  }, [mode]);

  useEffect(() => {
    if (is3D) return;
    const workspace = previewWorkspaceRef.current;
    if (!workspace) return;

    const handleWheel = (event: WheelEvent) => {
      event.preventDefault();
      const bounds = workspace.getBoundingClientRect();
      const deltaMultiplier =
        event.deltaMode === 1 ? 16 : event.deltaMode === 2 ? bounds.height : 1;
      const delta = event.deltaY * deltaMultiplier;
      const pointerX = event.clientX - bounds.left - bounds.width / 2;
      const pointerY = event.clientY - bounds.top - bounds.height / 2;

      setPreviewCamera((current) => {
        const nextScale = Math.min(
          MAX_PREVIEW_SCALE,
          Math.max(
            MIN_PREVIEW_SCALE,
            current.scale * Math.exp(-delta * 0.0015),
          ),
        );
        const scaleChange = nextScale / current.scale;
        return {
          scale: nextScale,
          x: pointerX - (pointerX - current.x) * scaleChange,
          y: pointerY - (pointerY - current.y) * scaleChange,
        };
      });
    };

    workspace.addEventListener("wheel", handleWheel, { passive: false });
    return () => workspace.removeEventListener("wheel", handleWheel);
  }, [is3D]);

  const fitPreview = () => setPreviewCamera({ ...FIT_CAMERA });

  const beginPan = (event: React.PointerEvent<HTMLDivElement>) => {
    if (event.button !== 0) return;
    event.preventDefault();
    event.currentTarget.setPointerCapture(event.pointerId);
    panSession.current = {
      pointerId: event.pointerId,
      clientX: event.clientX,
      clientY: event.clientY,
      cameraX: previewCamera.x,
      cameraY: previewCamera.y,
    };
    setIsPanning(true);
  };

  const panPreview = (event: React.PointerEvent<HTMLDivElement>) => {
    const session = panSession.current;
    if (!session || session.pointerId !== event.pointerId) return;
    event.preventDefault();
    setPreviewCamera((current) => ({
      ...current,
      x: session.cameraX + event.clientX - session.clientX,
      y: session.cameraY + event.clientY - session.clientY,
    }));
  };

  const endPan = (event: React.PointerEvent<HTMLDivElement>) => {
    const session = panSession.current;
    if (!session || session.pointerId !== event.pointerId) return;
    if (event.currentTarget.hasPointerCapture(event.pointerId)) {
      event.currentTarget.releasePointerCapture(event.pointerId);
    }
    panSession.current = null;
    setIsPanning(false);
  };

  const update = <K extends keyof DesignConfig>(
    key: K,
    value: DesignConfig[K],
  ) => setConfig((current) => {
    return updateProcessConfig(current, key, value);
  });

  const process = sealProcess(config);
  const estimated = electricalEstimate(derived.config, derived.geometry.fabrication.cellAreasMm2, derived.geometry);
  const zebraContacts = zebraContactRegions(derived.geometry);

  const warnings = [
    ...validateDesign(derived.config, derived.geometry),
    ...validatePointCodeArtwork(
      derived.config,
      derived.geometry,
      derived.pointCodeArtwork,
    ),
  ];
  const blocking = warnings.some(({ severity }) => severity === "error");
  const currentPreviewSize = previewSize(derived.geometry, svgMode);
  const sealView = mode === "assembly" || mode === "binding" || is3D;
  const viewMetadata = is3D ? { layer: "User.Review3D", description: t("reviewDescription"), legend: [] } : { ...VIEW_METADATA[svgMode],
    description: sealView && compressionEnvelope ? t("scenarioDescription") : t(VIEW_METADATA[svgMode].description),
    legend: VIEW_METADATA[svgMode].legend.map((item) => ({ ...item,
      label: sealView && compressionEnvelope && item.swatch === "black-fill" ? t("scenarioSeal") : t(item.label) })),
  };

  const assetById = (id: string) =>
    derived.assets.find((asset) => asset.id === id);
  const screen6066Asset = assetById(SCREEN_6066_ASSET_ID);
  const screen6060Asset = assetById(SCREEN_6060_ASSET_ID);

  const downloadCurrentView = () => {
    if (is3D || blocking || generationError || pending || exportLock.current) return;
    downloadSvgAsset({
      id: `preview-${mode}`,
      filename: `preview-${mode}.svg`,
      title: VIEWS.find((view) => view.id === mode)?.label ?? mode,
      widthMm: currentPreviewSize.widthMm,
      heightMm: currentPreviewSize.heightMm,
      svg: previewSvg,
    });
  };

  const downloadScreen = async (id: string) => {
    if (exportLock.current) return;
    const asset = assetById(id);
    if (!asset) {
      setExportError(`Screen asset "${id}" is unavailable.`);
      return;
    }

    exportLock.current = true;
    setExportError("");
    setExportProgress({ completed: 0, total: 1, label: "Preparing 1-bit TIFF" });
    try {
      const filename = screenTiffFilename(asset);
      setExportProgress({
        completed: 0,
        total: 1,
        label: `Rendering ${filename} at 1200 DPI`,
      });
      await downloadScreenTiff(asset);
    } catch (error) {
      setExportError(
        error instanceof Error ? error.message : "Screen TIFF export failed.",
      );
    } finally {
      exportLock.current = false;
      setExportProgress(null);
    }
  };

  const exportBundle = async (includePdfs: boolean) => {
    if (exportLock.current) return;
    exportLock.current = true;
    setExportError("");
    setExportProgress({ completed: 0, total: 1, label: "Preparing output" });
    try {
      await downloadProjectBundle(
        derived.config,
        derived.geometry,
        derived.pointCodeArtwork,
        derived.assets,
        includePdfs,
        (completed, total, label) =>
          setExportProgress({ completed, total, label }),
      );
    } catch (error) {
      setExportError(error instanceof Error ? error.message : "Export failed.");
    } finally {
      exportLock.current = false;
      setExportProgress(null);
    }
  };

  const outputDisabled =
    blocking || Boolean(generationError) || pending || exportProgress !== null;

  return (
    <HelpProvider><div className="classic-window">
      <header className="title-bar">
        <span className="close-box" aria-hidden="true" />
        <h1>{t("title")}</h1>
        <div className="title-actions">
          <div className="language-switch" role="group" aria-label="Language / 語言">
            <button type="button" lang="zh-TW" data-testid="language-zh-TW" aria-pressed={locale === "zh-TW"}
              onMouseDown={(event) => event.preventDefault()} onClick={() => setLocale("zh-TW")}>繁中</button>
            <button type="button" lang="en" data-testid="language-en" aria-pressed={locale === "en"}
              onMouseDown={(event) => event.preventDefault()} onClick={() => setLocale("en")}>EN</button>
          </div>
        <span className="title-status" data-state={exportProgress ? "exporting" : pending ? "pending" : blocking || generationError ? "error" : "pass"}>
          {exportProgress
            ? t("exporting")
            : pending
              ? t("pending")
              : blocking || generationError
                ? t("error")
                : t("pass")}
        </span>
        </div>
      </header>

      <main className="main-split">
        <aside className="sidebar-panel">
          <div className="button-row top-actions">
            <Help content="隨機產生新的 Voronoi 種子；其餘參數保留。形狀、最小有效面積與串聯 Isc 可能隨新版型改變。">
            <button
              disabled={exportProgress !== null}
              onClick={() =>
                update("electrodeSeed", Math.floor(Math.random() * 9_999_999))
              }
            >
              {t("New Seed")}
            </button>
            </Help>
            <Help content="將設計參數恢復預設，並回到印刷膠版預覽。自訂尺寸與製程輸入也會重設。">
            <button
              disabled={exportProgress !== null}
              onClick={() => {
                setConfig({ ...DEFAULT_CONFIG, bindingWidthMm: Number(sealProcess(DEFAULT_CONFIG).recommendedBindingMm.toFixed(2)) });
                setCompressionEnvelope(false);
              }}
            >
              {t("Reset")}
            </button>
            </Help>
            <Help content="儲存目前分頁及所選膠體階段的參考 SVG；壓合情境屬預覽。正式製造檔請用 ZIP，Binding 一律使用印刷膠版。">
            <button
              disabled={outputDisabled || is3D}
              title={is3D ? t("reviewSvgNote") : undefined}
              onClick={downloadCurrentView}
            >
              {t("Save View SVG")}
            </button>
            </Help>
          </div>

          <Section title="Electrode Glass">
            <NumberRow
              label="Shared Glass Height"
              value={config.glassHeightMm}
              min={20}
              max={300}
              step={0.1}
              onChange={(value) => update("glassHeightMm", value)}
            />
            <NumberRow
              label="Bigger Electrode W"
              value={config.glass6066WidthMm}
              min={20}
              max={300}
              step={0.1}
              onChange={(value) => update("glass6066WidthMm", value)}
            />
            <NumberRow
              label="Smaller Electrode W"
              value={config.glass6060WidthMm}
              min={10}
              max={300}
              step={0.1}
              onChange={(value) => update("glass6060WidthMm", value)}
            />
            <div className="info-well" data-testid="glass-dimensions" data-shared-height-mm={derived.config.glassHeightMm}>
              <Help tabIndex={0} content="兩片共用高度、上下齊平，小片沿水平方向置中。左右各自外露寬度=(大片寬度−小片寬度)/2；這些外露保留 FTO 是斑馬條可接觸區。實際可接觸面積與正負極位置標在 Final Assembly。寬度沒有正差時不能形成兩側接點，會由 DRC 報錯。">
                {t("sideExposure", { width: zebraContacts[0].strip.width.toFixed(2) })}<br />
                {t("glasses", { bw: derived.geometry.glass6066.width.toFixed(2), sw: derived.geometry.glass6060.width.toFixed(2), h: derived.config.glassHeightMm.toFixed(2) })}
              </Help>
            </div>
          </Section>

          <Section title="Binding">
            <NumberRow label="Coating Safety Gap" value={config.coatingSafetyGapMm} min={0} max={5} step={0.01}
              onChange={(v) => update("coatingSafetyGapMm", v)} />
            <NumberRow
              label="Binding Width"
              value={config.bindingWidthMm}
              min={process.minBindingMm}
              max={process.maxBindingMm}
              step={0.01}
              onChange={(value) =>
                update("bindingWidthMm", value)
              }
            />
            <NumberRow label="Opening Clear Target" value={config.minimumOpenMm} min={0.1} max={3} step={0.1}
              onChange={(v) => update("minimumOpenMm", v)} />
            <NumberRow label="Print Gap Floor" value={config.minimumArtworkOpeningMm} min={0} max={5} step={0.1}
              onChange={(v) => update("minimumArtworkOpeningMm", v)} />
            <div className="info-well" data-testid="binding-aperture"
              data-print-gap-mm={derived.geometry.fabrication.minimumPrintedChannelMm}
              data-sizing-film-um={derived.geometry.fabrication.openingScenario.filmUm}
              data-sizing-source={derived.geometry.fabrication.openingScenario.source}>
              <Help tabIndex={0} content={`印刷膠版多邊形的最小槽寬，不是壓合後量測。${(derived.geometry.fabrication.minimumPrintedChannelMm * 1000).toFixed(0)} µm，約 ${(derived.geometry.fabrication.minimumPrintedChannelMm / (process.pitchUm / 1000)).toFixed(1)} 個網距；開口可受 Print Gap Floor、網版解析度與膨脹情境限制。`}
                contentEn={`Minimum generated printed slot, not a pressed measurement: ${(derived.geometry.fabrication.minimumPrintedChannelMm * 1000).toFixed(0)} µm, about ${(derived.geometry.fabrication.minimumPrintedChannelMm / (process.pitchUm / 1000)).toFixed(1)} screen pitches. Print Gap Floor, resolution or scenario growth can set the limit.`}>
                <strong>{t("printGap")} {derived.geometry.fabrication.minimumPrintedChannelMm.toFixed(3)} mm</strong>
              </Help>
              <Help tabIndex={0} content={`由情境膠體多邊形求出的通道淨寬。厚度輸入 ${derived.geometry.fabrication.openingScenario.filmUm.toFixed(2)} µm，來源：${derived.geometry.fabrication.openingScenario.source === "measured-wet-film" ? "實測濕膜" : "未量測的滿載網版幾何情境"}。求解 Area(offset(print,s)) × gap = Area(print) × film，再加單邊溢膠與製版餘量；不是經驗證最壞上界或實測成品。`}
                contentEn={`Clearance measured on scenario polygons. Film ${derived.geometry.fabrication.openingScenario.filmUm.toFixed(2)} µm: ${derived.geometry.fabrication.openingScenario.source === "measured-wet-film" ? "measured wet film" : "unmeasured full-screen-charge scenario"}. Solve Area(offset(print,s)) × gap = Area(print) × film, then add growth/fabrication allowances. Not a verified worst-case bound or a measured finished part.`}>
                {t("scenario")} {derived.geometry.fabrication.openingScenario.valid ? `${derived.geometry.fabrication.minimumChannelMm.toFixed(3)} mm` : t("invalidFilm")}
              </Help>
              <Help tabIndex={0} content="實際壓合後的通道寬度需由試片量測。這裡的情境只檢查指定假設下的幾何，不代表已驗證注液或沒有氣泡。">{t("pressedUnknown")}</Help>
              {!process.compressionValid ? <><br /><strong>{t("underfill", { film: process.depositUm.toFixed(2), gap: process.gapUm.toFixed(2) })}</strong></> : null}
            </div>
            {derived.geometry.fabrication.errors.filter((message) => /通道|開口設計|壓合包絡|製版開口/.test(message)).map((message) =>
              <div className="error-well" role="alert" key={message}>{msg(message)}</div>)}
            <Help content={`以目標成品膠寬除以名義厚度比，並受網版解析度限制，估算印刷膠寬。當前允許範圍 ${process.minBindingMm.toFixed(3)}–${process.maxBindingMm.toFixed(2)} mm。只有按下此按鈕才會覆寫 Binding Width；這不是材料最佳值，膠量不足時此估算也不能驗證配方。`}
              contentEn={`Estimate printed width from the final-width target divided by nominal film/gap ratio, subject to screen resolution. Allowed range ${process.minBindingMm.toFixed(3)}–${process.maxBindingMm.toFixed(2)} mm. Only this button overwrites Binding Width. Not a material optimum; an underfilled estimate does not validate the recipe.`}>
              <button onClick={() => update("bindingWidthMm", Number(process.recommendedBindingMm.toFixed(2)))}>
              {t("applyEstimate", { width: process.recommendedBindingMm.toFixed(2) })}
              </button>
            </Help>
            <div className="info-well" data-testid="active-area" data-area-cv={derived.geometry.fabrication.areaCv}>
              <Help tabIndex={0} content="所有子電池的有效塗層面積加總，已扣除封膠安全距離、擴散情境、蝕刻與對位退讓。每個分區使用相同法向內縮，不再為面積平衡裁小塗層。此總面積不拿來乘 Jsc 作串聯輸出電流。">{t("activeArea")} {derived.geometry.fabrication.totalActiveMm2.toFixed(1)} mm²</Help>
              <Help tabIndex={0} content="最小／最大子電池的有效面積。相同 Jsc 且均勻受光時，最小者限制整串 Isc；查看 Voc / Isc Estimate 的限制 cell 與計算明細。">{t("minMax")} {Math.min(...derived.geometry.fabrication.cellAreasMm2).toFixed(2)} / {Math.max(...derived.geometry.fabrication.cellAreasMm2).toFixed(2)} mm²</Help>
              <Help tabIndex={0} content="面積變異係數 = 面積標準差 ÷ 平均面積。越小表示各子電池面積越一致，0% 為等面積；不代表所有 cell 的實際 Jsc 或照明也相同。">{t("areaCv")} {(derived.geometry.fabrication.areaCv * 100).toFixed(1)}%</Help>
            </div>
            <div className="info-well" data-testid="coating-clearance"
              data-target-mm={derived.config.coatingSafetyGapMm}
              data-printed-mm={derived.geometry.fabrication.coatingClearance.minimumPrintedMm ?? ""}
              data-scenario-mm={derived.geometry.fabrication.coatingClearance.minimumScenarioMm ?? ""}
              data-total-active-mm2={derived.geometry.fabrication.totalActiveMm2}>
              <Help tabIndex={0} content={`所有塗層從同一膠牆分區作平行內縮，沒有逐cell等比縮小。要求情境淨距離 ${derived.config.coatingSafetyGapMm.toFixed(3)} mm，加對位餘量 ${derived.config.registrationMm.toFixed(3)} mm；再預留情境單邊膠體成長 ${derived.geometry.fabrication.coatingClearance.scenarioSpreadMm.toFixed(3)} mm。印刷膠邊到塗層的要求至少 ${derived.geometry.fabrication.coatingClearance.printedRequiredMm.toFixed(3)} mm。較大的蝕刻退讓仍可能主導局部白邊；開槽、轉角與結點的外觀不代表每處法向距離相同。`}
                contentEn={`All coatings use one parallel wall offset, without per-cell scaling. Scenario clearance target ${derived.config.coatingSafetyGapMm.toFixed(3)} mm + registration ${derived.config.registrationMm.toFixed(3)} mm + one-edge scenario growth ${derived.geometry.fabrication.coatingClearance.scenarioSpreadMm.toFixed(3)} mm requires at least ${derived.geometry.fabrication.coatingClearance.printedRequiredMm.toFixed(3)} mm printed clearance. Wider etches may dominate. Slots, corners and junctions can look different even with a shared normal clearance.`}>
                {t("minCoatingGap")}<br />
                {t("print")} {derived.geometry.fabrication.coatingClearance.minimumPrintedMm?.toFixed(3) ?? t("unknown")} mm · {t("scenario")} {derived.geometry.fabrication.coatingClearance.minimumScenarioMm?.toFixed(3) ?? t("unknown")} mm<br />
                {t("afterAlignment")} {derived.geometry.fabrication.coatingClearance.minimumScenarioMm === null ? t("unknown") : `${(derived.geometry.fabrication.coatingClearance.minimumScenarioMm - derived.config.registrationMm).toFixed(3)} mm`} {t("scenarioNote")}
              </Help>
            </div>
          </Section>

          <Section title="AB-313 / Screen / Glass Beads">
            {([
              ["screenMeshPerInch", "Screen Mesh", 40, 500, 1, "threads/in"],
              ["screenWireUm", "Wire Diameter", 10, 150, 1, "µm"],
              ["emulsionUm", "Screen EOM (assumed)", 0, 100, 1, "µm"],
              ["transferEfficiency", "Transfer (assumed)", 0.05, 1, 0.01, "ratio"],
              ["measuredWetFilmUm", "Measured Wet Film", 0, 200, 1, "µm"],
              ["sealantViscosityMpas", "AB-313 Viscosity", 1000, 200000, 1000, "mPa·s"],
              ["beadDiameterUm", "Bead D50 / Gap", 5, 150, 1, "µm"],
              ["beadD90Um", "Bead D90 (assumed)", 5, 300, 1, "µm"],
              ["beadGradeMesh", "Bead Grade (linked)", 100, 3000, 1, "grade mesh"],
              ["targetSealWidthMm", "Target Final Seal", 0.05, 3, 0.01, "mm"],
              ["edgeBleedUm", "Lateral Bleed Allowance", 0, 500, 5, "µm/edge"],
              ["printEdgeToleranceUm", "Stencil Edge Error", 0, 200, 5, "µm/edge"],
              ["pressPressureKpa", "Press Pressure", 0, 200, 1, "kPa"],
              ["pressTimeS", "Before UV / Flow", 0, 300, 1, "s"],
              ["registrationMm", "Alignment Tolerance", 0.01, 1, 0.01, "mm"],
            ] as const).map(([key, label, min, max, step, unit]) => <NumberRow key={key} label={label} value={config[key]} min={min} max={max} step={step} unit={unit} onChange={(v) => update(key, v)} />)}
            <div className="info-well">
              <Help tabIndex={0} content="開孔 = 網距 − 線徑；開口率 = (開孔 ÷ 網距)²。過網起始規則暫採開孔 ≥ 3 × D90，不是 AB-313 規格。">{t("aperture")} {process.apertureUm.toFixed(1)} µm · {t("openFraction")} {(process.openFraction * 100).toFixed(1)}%</Help>
              <Help tabIndex={0} content={`濕膜來源：${config.measuredWetFilmUm > 0 ? "使用者實測" : "未量測的 EOM／轉移率示例估算：transfer × (2 × wire × open fraction + EOM)"}。假設 gap = 同批玻璃珠 D50 = ${process.gapUm.toFixed(2)} µm = ${(process.gapUm / 1000).toFixed(5)} mm；不是實測壓合間隙。`}
                contentEn={`Film source: ${config.measuredWetFilmUm > 0 ? "user measurement" : "unmeasured EOM/transfer estimate: transfer × (2 × wire × open fraction + EOM)"}. Assumed gap = same-batch D50 = ${process.gapUm.toFixed(2)} µm = ${(process.gapUm / 1000).toFixed(5)} mm, not a measured pressed gap.`}>
                {t("wetFilm")} {process.depositUm.toFixed(2)} µm · {t("gap")} {process.gapUm.toFixed(2)} µm {config.measuredWetFilmUm > 0 ? t("measuredFilm") : t("assumed")}
              </Help>
              <Help tabIndex={0} content={`名義體積邊緣成長：${derived.geometry.fabrication.volumeSpreadMm === null ? "未知，膠量不足" : `${(derived.geometry.fabrication.volumeSpreadMm * 1000).toFixed(1)} µm`}。均勻膠條近似 Bfinal ≈ Bprint × film/gap，僅厚度比 ≥ 1 有效。壓力／黏度／時間只作流動尺度診斷 ${process.flowMm.toFixed(3)} mm，不截小體積膨脹。CONDITIONAL 表示假設下可算，並非製程已驗證。`}
                contentEn={`Nominal volume edge growth: ${derived.geometry.fabrication.volumeSpreadMm === null ? "unknown / underfilled" : `${(derived.geometry.fabrication.volumeSpreadMm * 1000).toFixed(1)} µm`}. Uniform-strip approximation Bfinal ≈ Bprint × film/gap requires a ratio ≥1. Pressure/viscosity/time give a ${process.flowMm.toFixed(3)} mm flow diagnostic only; they do not truncate volume growth. CONDITIONAL means computable under assumptions, not a validated process.`}>
                {t("nominalCompression")} {derived.geometry.fabrication.compressionValid ? t("conditional") : t("invalidCompression")}
              </Help>
              <Help tabIndex={0} content={`開口設計另用 ${process.openingFilmSource === "measured-wet-film" ? "實測濕膜" : "滿載網版未量測情境"}，情境邊緣成長含餘量 ${(derived.geometry.fabrication.envelopeSpreadMm * 1000).toFixed(1)} µm。槽寬起始值取 max(製版口下限、2 個網距、情境目標淨寬 + 2 × 單邊成長 + 0.01 mm)，並從生成多邊形重新量測。`}
                contentEn={`Opening design uses ${process.openingFilmSource === "measured-wet-film" ? "measured wet film" : "an unmeasured full-screen-charge scenario"}, with ${(derived.geometry.fabrication.envelopeSpreadMm * 1000).toFixed(1)} µm edge growth including allowances. Start with max(print floor, 2 screen pitches, requested scenario clear + 2 × growth + 0.01 mm), then remeasure the generated polygons.`}>
                {t("openingFilm")} {process.openingFilmUm.toFixed(2)} µm ({process.openingFilmSource === "measured-wet-film" ? t("measured") : t("scenario")})
              </Help>
              <Help tabIndex={0} content="生成連接各腔室、供上進下出注液／排氣的必要開槽。數量由幾何決定，不是另一種玻璃珠或電氣接點；流動可雙向，尚未模擬氣泡。">{t("fillSlots", { count: derived.geometry.fabrication.ports.length })}</Help>
            </div>
            {process.errors.length ? <div className="error-well" role="alert">{process.errors.map(msg).join(" ")}</div> : null}
          </Section>

          <Section title="Circuit / FTO">
            <NumberRow
              label="Electrical Cells"
              value={config.subcellCount}
              min={2}
              max={64}
              step={2}
              unit="even"
              onChange={(value) =>
                update(
                  "subcellCount",
                  Math.min(64, Math.max(2, Math.round(value / 2) * 2)),
                )
              }
            />
            <NumberRow
              label="Seed"
              value={config.electrodeSeed}
              min={0}
              max={9_999_999}
              step={1}
              unit="#"
              onChange={(value) => update("electrodeSeed", Math.round(value))}
            />
            <NumberRow
              label="Cell Jitter"
              value={config.electrodeJitter}
              min={0}
              max={2}
              step={0.01}
              unit="ratio"
              onChange={(value) =>
                update("electrodeJitter", Math.min(2, Math.max(0, value)))
              }
            />
            <NumberRow
              label="FTO Etch Width"
              value={config.ftoEtchWidthMm}
              min={0.02}
              max={5}
              step={0.01}
              onChange={(value) =>
                update("ftoEtchWidthMm", Math.min(5, Math.max(0.02, value)))
              }
            />
            <NumberRow label="Area Balance" value={config.areaBalance} min={0} max={1} step={0.05} unit="0–1" onChange={(v) => update("areaBalance", v)} />
            <NumberRow label="Laser Spot / Kerf" value={config.laserSpotMm} min={0.005} max={1} step={0.005} onChange={(v) => update("laserSpotMm", v)} />
            <NumberRow label="Laser Hatch Pitch" value={config.laserHatchMm} min={0.005} max={1} step={0.005} onChange={(v) => update("laserHatchMm", v)} />
          </Section>

          <Section title="FTO / Sheet Resistance">
            <SelectRow label="Bigger FTO Grade" value={config.ftoBiggerPreset} options={FTO_OPTIONS} onChange={(v) => update("ftoBiggerPreset", v as FtoPreset)} />
            <NumberRow label="Bigger FTO Rs" value={config.ftoBiggerOhmSq} min={0} max={1000} step={0.1} unit="Ω/□" onChange={(v) => update("ftoBiggerOhmSq", v)} />
            <SelectRow label="Smaller FTO Grade" value={config.ftoSmallerPreset} options={FTO_OPTIONS} onChange={(v) => update("ftoSmallerPreset", v as FtoPreset)} />
            <NumberRow label="Smaller FTO Rs" value={config.ftoSmallerOhmSq} min={0} max={1000} step={0.1} unit="Ω/□" onChange={(v) => update("ftoSmallerOhmSq", v)} />
            <div className="info-well" data-testid="fto-resistance" data-total-ohm={estimated.fto?.totalOhm ?? ""}>
              <Help tabIndex={0} content="原廠 TEC 數值是方塊電阻；這裡是雙片、逐 cell 串聯集流的等效 Ω。每段 R=Rsheet×(A/(3W²)+lead/W)，W為實際串聯共邊／端子gate扣除切寬。假設均勻發電、整邊理想集流；未計入窄頸 2D、busbar／接觸、Pt與電解液損失，屬幾何近似。"
                contentEn={`${estimated.fto?.basis ?? "Equivalent strip collection geometry"} TEC values are sheet resistance; this readout is both plates' per-cell collection resistance in Ω. It is a geometric scenario, not measured module resistance.`}>
                {t("ftoRs")} {estimated.fto?.totalOhm == null ? t("disconnected") : `${estimated.fto.totalOhm.toFixed(2)} Ω`}
              </Help>
            </div>
          </Section>

          <Section title="Voc / Isc Estimate">
            <Help content="套用使用者確認的 55×55 mm 有效面積、38–40 mA 通常電流範圍及較早 A 樣品的電壓觀測基準。電流採同參考光照的面積縮放；網站只有 Voc／lux，沒有與 38–40 mA 配對的照度或 I–V，因此不做 lux→mW/cm² 或電流老化換算。">
              <button onClick={() => setConfig((current) => ({ ...current, electricalBasis: "reference-cell",
                referenceAreaMm2: DSSC_REFERENCE.areaMm2, referenceIscMa: 39, referenceIscRangeMa: 1,
                referenceLightMode: "same-light", referenceVoltageObservation: "a-baseline", cellVocV: VOLTAGE_OBSERVATIONS["a-baseline"].vocV }))}>
                {t("Use DSSC 55×55 A reference")}
              </button>
            </Help>
            <SelectRow label="Current Basis" value={config.electricalBasis} options={[
              { value: "reference-cell", label: "Reference cell (mA)" },
              { value: "jsc-input", label: "Intrinsic Jsc (mA/cm²)" },
            ]} onChange={(v) => update("electricalBasis", v as DesignConfig["electricalBasis"])} />
            <SelectRow label="Voltage Observation" value={config.referenceVoltageObservation} options={[
              ...Object.entries(VOLTAGE_OBSERVATIONS).map(([value, observation]) => ({ value, label: observation.label })),
              { value: "manual", label: "Manual / matched I–V" },
            ]} onChange={(v) => update("referenceVoltageObservation", v as VoltageObservationId)} />
            <NumberRow label="Reference Cell Voc" value={config.cellVocV} min={0.01} max={1.2} step={0.01} unit="V" onChange={(v) => update("cellVocV", v)} />
            {estimated.voltageObservation ? <div className="info-well" data-testid="voltage-observation" data-current-paired="false">
              <Help tabIndex={0} content={`採較早的 A（開始 ${DSSC_REFERENCE.firstObservedAt}），不是 B。選定 ${estimated.voltageObservation.date}，匹配 ${estimated.voltageObservation.matchedSamples} 筆有效觀測。Voc 的比較條件是 ${DSSC_REFERENCE.referenceLux} lux ±10%、${DSSC_REFERENCE.referenceTemperatureC}°C ±2°C；完整日先取每小時中位數，再取日中位數，不是逐筆平均或全日照度中位數。資料快照 ${DSSC_REFERENCE.generatedAt}；拔除期間已依來源排除，未內插。`}
                contentEn={`Older sample A, observed from ${DSSC_REFERENCE.firstObservedAt}. Selected ${estimated.voltageObservation.date}: ${estimated.voltageObservation.matchedSamples} matched valid observations. Voc comparison uses ${DSSC_REFERENCE.referenceLux} lux ±10% and ${DSSC_REFERENCE.referenceTemperatureC}°C ±2°C. Complete days use the median of hourly medians, not the all-day lux median. Snapshot ${DSSC_REFERENCE.generatedAt}; disconnected intervals are excluded without interpolation.`}>
                A · {estimated.voltageObservation.date} · {(estimated.voltageObservation.vocV * 1000).toFixed(2)} mV
              </Help>
              <Help tabIndex={0} content="這是網站的電壓保留率，不代表 Isc、最大功率或效率保留率；不會拿它乘以 38–40 mA。該電流是使用者提供的通常值，沒有與網站觀測同步量測的紀錄。">
                {t("voltageRetained", { value: estimated.voltageObservation.retentionPct.toFixed(1) })}
              </Help>
              <a href={DSSC_REFERENCE.statusUrl} target="_blank" rel="noreferrer">{t("sourceVoltage")}</a>
            </div> : null}
            {config.electricalBasis === "reference-cell" ? <>
              <NumberRow label="Reference Isc" value={config.referenceIscMa} min={0} max={10000} step={0.1} unit="mA" onChange={(v) => update("referenceIscMa", v)} />
              <NumberRow label="Reference Isc ±" value={config.referenceIscRangeMa} min={0} max={10000} step={0.1} unit="mA" onChange={(v) => update("referenceIscRangeMa", v)} />
              <NumberRow label="Reference Active Area" value={config.referenceAreaMm2} min={0} max={1000000} step={1} unit="mm²" onChange={(v) => update("referenceAreaMm2", v)} />
              <SelectRow label="Reference Light Mode" value={config.referenceLightMode} options={[
                { value: "same-light", label: "Same as Isc reference" },
                { value: "irradiance", label: "Measured mW/cm² ratio" },
                { value: "lux-ratio", label: "Lux ratio · same spectrum" },
              ]} onChange={(v) => update("referenceLightMode", v as DesignConfig["referenceLightMode"])} />
              {config.referenceLightMode === "irradiance" ? <NumberRow label="Reference Irradiance" value={config.referenceIrradianceMwCm2} min={0.1} max={200} step={1} unit="mW/cm²" onChange={(v) => update("referenceIrradianceMwCm2", v)} /> : null}
              {config.referenceLightMode === "lux-ratio" ? <>
                <NumberRow label="Isc Reference Lux" value={config.referenceLux} min={0} max={200000} step={1} unit="lux" onChange={(v) => update("referenceLux", v)} />
                <NumberRow label="Target Illuminance" value={config.illuminanceLux} min={0} max={200000} step={1} unit="lux" onChange={(v) => update("illuminanceLux", v)} />
              </> : null}
            </> : <NumberRow label="Cell Jsc @100" value={config.jscMaCm2} min={0} max={40} step={0.1} unit="mA/cm²" onChange={(v) => update("jscMaCm2", v)} />}
            {config.electricalBasis === "jsc-input" || config.referenceLightMode === "irradiance" ? <NumberRow label="Irradiance" value={config.irradianceMwCm2} min={0} max={200} step={1} unit="mW/cm²" onChange={(v) => update("irradianceMwCm2", v)} /> : null}
            {config.referenceVoltageObservation === "manual" ? <>
              {config.electricalBasis === "reference-cell" ? <NumberRow label="Reference Series Rs" value={config.referenceSeriesOhm} min={0} max={10000} step={0.1} unit="Ω" onChange={(v) => update("referenceSeriesOhm", v)} /> : null}
              <NumberRow label="Diode Voltage (assumed)" value={config.diodeVoltageMv} min={10} max={200} step={1} unit="mV" onChange={(v) => update("diodeVoltageMv", v)} />
            </> : null}
            <div className="info-well" data-testid="electrical-estimate"
              data-isc-ma={estimated.iscMa ?? ""} data-fto-isc-ma={estimated.scenario?.iscMa ?? ""}
              data-low-ma={estimated.range?.lowMa ?? ""} data-high-ma={estimated.range?.highMa ?? ""}
              data-basis={derived.config.electricalBasis} data-min-area-mm2={estimated.minimumAreaMm2}
              data-limiting-cell={estimated.limitingCellNumber}>
              <Help tabIndex={0} content={`${derived.geometry.cells.length} 個串聯子電池 × ${derived.config.cellVocV} V/cell ≈ ${estimated.vocV.toFixed(2)} V，為參考照明下的電壓總和。含 FTO 情境使用 a·ln(1+(Iph−I)/I0) 算逐 cell 電壓，照度改變時其情境 Voc 也會改變；仍需實際 I–V 校正。`}
                contentEn={`${derived.geometry.cells.length} series cells × ${derived.config.cellVocV} V/cell ≈ ${estimated.vocV.toFixed(2)} V at reference light. The FTO scenario sums a·ln(1+(Iph−I)/I0) per cell, so its Voc also responds to light. Actual I–V calibration is still needed.`}>{t("referenceVoc")} ≈ {estimated.vocV.toFixed(2)} V</Help>
              <Help tabIndex={0} content={estimated.iscMa === null ? estimated.issues.join(" ") : derived.config.electricalBasis === "reference-cell"
                ? `最小 cell ${estimated.minimumAreaMm2.toFixed(4)} ÷ 參考 ${derived.config.referenceAreaMm2} mm² × ${derived.config.referenceIscMa} mA × 光照比 ${estimated.calibration.lightScale} = ${estimated.iscMa.toFixed(4)} mA。參考電流密度 ${estimated.referenceCurrentDensityMaCm2?.toFixed(4)} mA/cm²，僅適用該 Isc 的光照；${estimated.effectiveJscMaCm2 === null ? "未知 100 mW/cm² 下的 Jsc，不會從 lux 補算。" : `正規化 Jsc@100=${estimated.effectiveJscMaCm2.toFixed(4)} mA/cm²。`} 網站 Voc 老化不縮放此電流；不是 FTO 修正後量測。`
                : `${estimated.minimumAreaMm2.toFixed(4)} mm² ÷ 100 × ${derived.config.jscMaCm2} mA/cm² × (${derived.config.irradianceMwCm2}/100) = ${estimated.iscMa.toFixed(4)} mA。這是忽略 FTO 的理想面積限制，不是成品輸出。`}
                contentEn={estimated.iscMa === null ? estimated.issues.map(msg).join(" ") : derived.config.electricalBasis === "reference-cell"
                  ? `Minimum area ${estimated.minimumAreaMm2.toFixed(4)} / reference ${derived.config.referenceAreaMm2} mm² × ${derived.config.referenceIscMa} mA × light ratio ${estimated.calibration.lightScale} = ${estimated.iscMa.toFixed(4)} mA. Reference density ${estimated.referenceCurrentDensityMaCm2?.toFixed(4)} mA/cm² applies only at that current reference's light. ${estimated.effectiveJscMaCm2 === null ? "Jsc at 100 mW/cm² is unknown; it is not derived from lux." : `Normalized Jsc@100=${estimated.effectiveJscMaCm2.toFixed(4)} mA/cm².`} Online voltage aging does not scale Isc. Not an FTO-corrected measurement.`
                  : `${estimated.minimumAreaMm2.toFixed(4)} mm² / 100 × ${derived.config.jscMaCm2} mA/cm² × (${derived.config.irradianceMwCm2}/100) = ${estimated.iscMa.toFixed(4)} mA. Ideal area limit without FTO, not finished-device output.`}>
                {estimated.iscMa === null ? t("inputsNeeded") : `${derived.config.electricalBasis === "reference-cell" ? t("areaScaled") : t("idealLimit")} ≈ ${estimated.iscMa.toFixed(2)} mA`}
              </Help>
              {estimated.range ? <Help tabIndex={0} content={`將對照通常電流 ${Math.max(0, derived.config.referenceIscMa - derived.config.referenceIscRangeMa)}–${derived.config.referenceIscMa + derived.config.referenceIscRangeMa} mA 依最小 cell 面積縮放。這是使用者回報範圍，不是統計信賴區間。光照模式 ${derived.config.referenceLightMode}；同參考光照指的是量到 38–40 mA 的條件，不是自動指網站的 942.5 lux。`}
                contentEn={`Scale the reported ${Math.max(0, derived.config.referenceIscMa - derived.config.referenceIscRangeMa)}–${derived.config.referenceIscMa + derived.config.referenceIscRangeMa} mA range to the smallest cell. A user-reported interval, not statistical confidence. Light mode: ${derived.config.referenceLightMode}. Same reference light means the 38–40 mA measurement conditions, not automatically the website's 942.5 lux.`}>
                {t("range")} {estimated.range.lowMa.toFixed(2)}–{estimated.range.highMa.toFixed(2)} mA · {derived.config.referenceLightMode === "same-light" ? t("sameLight") : t("lightAssumption")}
              </Help> : null}
              <Help tabIndex={0} content={estimated.scenarioUnavailableReason ?? `含 FTO 的未校正情境：逐 cell 電壓相加後扣 I×ΣR，數值求 V=0；若需要超過最弱光電流才有解，停在該上限並標記，不虛構逆偏特性。另算 MPP 以呈現 FTO 對功率的影響。a=${derived.config.diodeVoltageMv} mV 尚未擬合。${estimated.calibration.referenceSeriesAssumedZero ? "對照 Rs=0：暫忽略對照損失，可能重複計入既有電阻損失，不能當實測校正結果。" : "對照模式會以獨立輸入的對照 Rs 去嵌入；不能由一個 Isc 值驗證模型。"}`}
                contentEn={estimated.scenarioUnavailableReason ? msg(estimated.scenarioUnavailableReason) : `Unfitted FTO scenario: sum per-cell voltages, subtract I×ΣR and solve V=0. If a solution would exceed the weakest photocurrent, return and mark that cap instead of inventing reverse-bias behavior. MPP is also computed. a=${derived.config.diodeVoltageMv} mV is unfitted. ${estimated.calibration.referenceSeriesAssumedZero ? "Reference Rs=0 ignores existing reference losses, which may then be counted twice; not a calibrated prediction." : "Reference mode de-embeds the independently entered reference Rs; one Isc cannot validate the model."}`}>
                {t("ftoIsc")} {estimated.scenario ? `≈ ${estimated.scenario.iscMa.toFixed(2)} mA${estimated.scenario.photocurrentCapped ? ` ${t("weakCap")}` : ""}` : t("pendingInputs")}
              </Help>
              {estimated.scenarioUnavailableReason ? <Help tabIndex={0} content={msg(estimated.scenarioUnavailableReason)}>{t("unpairedFit")}</Help> : null}
              {estimated.scenario ? <Help tabIndex={0} content={`同一單二極體情境中，無 FTO 最大功率 ${estimated.scenario.zeroFtoMpp.powerMw.toFixed(3)} mW；含 FTO 最大功率 ${estimated.scenario.mpp.powerMw.toFixed(3)} mW（${estimated.scenario.mpp.currentMa.toFixed(3)} mA × ${estimated.scenario.mpp.voltageV.toFixed(3)} V）。串聯電阻常先降低填充因子／功率，未必讓 Isc 大幅下降。情境未擬合，不是成品規格。`}
                contentEn={`Same diode scenario: zero-FTO maximum power ${estimated.scenario.zeroFtoMpp.powerMw.toFixed(3)} mW; with FTO ${estimated.scenario.mpp.powerMw.toFixed(3)} mW (${estimated.scenario.mpp.currentMa.toFixed(3)} mA × ${estimated.scenario.mpp.voltageV.toFixed(3)} V). Series resistance often lowers fill factor/power before strongly reducing Isc. Unfitted scenario, not a device specification.`}>
                {t("mpp")} {estimated.scenario.mpp.powerMw.toFixed(2)} mW · {t("unfitted")}
              </Help> : null}
              {estimated.scenario && estimated.calibration.referenceSeriesAssumedZero ? <Help tabIndex={0} content={parameterHelp("Reference Series Rs", locale)}>{t("refRsZero")}</Help> : null}
              <Help tabIndex={0} content="限制電流的最小有效面積子電池，編號對應 Circuit 的串聯順序。相同面積時列第一個；實際 Jsc 或受光不同時，最小電流者才是限制者。">{t("minCell")} {estimated.limitingCellNumber} · {estimated.minimumAreaMm2.toFixed(2)} mm²</Help>
            </div>
            {estimated.issues.length ? <div className="info-well" role="status">{estimated.issues.map(msg).join(" ")}</div> : null}
          </Section>

          <Section title="TiO2 Screens">
            <div className="button-column">
              <Help content="較大電極的 TiO₂ 網版：1200 DPI、實際尺寸、true 1-bit TIFF。黑色印 TiO₂，白色是 Pt／封膠退讓／不印刷區。">
              <button
                className="important-button"
                disabled={outputDisabled || !screen6066Asset}
                onClick={() => void downloadScreen(SCREEN_6066_ASSET_ID)}
              >
                {t("Download Bigger Electrode TiO2 TIFF")}
              </button>
              </Help>
              <Help content="較小電極的 TiO₂ 網版：1200 DPI、實際尺寸、true 1-bit TIFF。黑色印 TiO₂，白色不印；預設製造座標含水平鏡射，勿再重複鏡射。">
              <button
                className="important-button"
                disabled={outputDisabled || !screen6060Asset}
                onClick={() => void downloadScreen(SCREEN_6060_ASSET_ID)}
              >
                {t("Download Smaller Electrode TiO2 TIFF")}
              </button>
              </Help>
              <Help content="完整製造 ZIP：含向量 PDF、SVG、1200 DPI 1-bit TIFF、DXF、雷射填掃 SVG／JSON、設定與估算明細。正式膠版固定為印刷幾何；壓合預覽不會改動它。">
              <button
                disabled={outputDisabled}
                onClick={() => void exportBundle(true)}
              >
                {t("Complete ZIP: PDF + 1-bit TIFF")}
              </button>
              </Help>
              <Help content="向量製造 ZIP：不含 PDF／TIFF；含 SVG、DXF、雷射填掃 SVG／JSON 與設定。process-estimates.json 保留逐 cell 面積、Isc 與限制 cell，便於核查。">
              <button
                disabled={outputDisabled}
                onClick={() => void exportBundle(false)}
              >
                {t("Export Vector ZIP")}
              </button>
              </Help>
            </div>
            {exportProgress ? (
              <div className="info-well export-progress" role="status" aria-live="polite">
                {msg(exportProgress.label)} ({exportProgress.completed}/
                {exportProgress.total})
              </div>
            ) : null}
            {exportError ? (
              <div className="error-well" role="alert">{msg(exportError)}</div>
            ) : null}
          </Section>

          <Section title="DRC / Design Check">
            <div className="warning-stack">
              {warnings.map((warning, index) => (
                <div className={`notice ${warning.severity}`} data-code={resolveDiagnostic(warning.message).code} key={`${index}-${warning.message}`}>
                  {t(warning.severity === "error" ? "ERROR" : warning.severity === "warning" ? "WARNING" : "INFO")}: {msg(warning.message)}
                </div>
              ))}
              {generationError ? (
                <div className="notice error">{t("ERROR")}: {msg(generationError)}</div>
              ) : null}
            </div>
          </Section>
        </aside>

        <section className="preview-panel">
          <nav className="view-toolbar" aria-label={t("previewLayers")}>
            {VIEWS.map((view) => (
              <Help as="span" key={view.id} content={t(VIEW_METADATA[view.id].description)}>
              <button
                className={mode === view.id ? "selected" : ""}
                type="button"
                data-view-mode={view.id}
                onClick={() => setMode(view.id)}
              >
                {t(view.label)}
              </button>
              </Help>
            ))}
            <Help as="span" content={t("reviewDescription")}>
              <button className={is3D ? "selected" : ""} type="button" data-view-mode="review-3d"
                onClick={() => setMode("review-3d")}>{t("reviewTab")}</button>
            </Help>
            {sealView ? <>
              <Help as="label" id="seal-stage-help" content={t("sharedSealHelp")}><input aria-describedby="seal-stage-help" data-testid="seal-stage-toggle" type="checkbox" checked={compressionEnvelope} onChange={(e) => setCompressionEnvelope(e.target.checked)} /> {t("compressionToggle")}</Help>
              <strong data-testid="seal-stage" data-seal-stage={compressionEnvelope ? "compression-scenario" : "printed"}>
                {compressionEnvelope ? t("sealScenario") : t("sealPrinted")}
              </strong>
            </> : null}
          </nav>

          {is3D ? <ReviewBoundary fallback={<div className="review-placeholder" role="alert">{t("reviewUnavailable")}</div>}>
            <Suspense fallback={<div className="review-placeholder" role="status">{t("reviewLoading")}</div>}>
              <Review3D config={derived.config} geometry={derived.geometry} compressionEnvelope={compressionEnvelope}
                settings={reviewSettings} onChange={setReviewSettings} />
            </Suspense>
          </ReviewBoundary> : <div
            ref={previewWorkspaceRef}
            className={`preview-workspace ${isPanning ? "panning" : ""}`}
            aria-label={t("panZoom")}
            onPointerDown={beginPan}
            onPointerMove={panPreview}
            onPointerUp={endPan}
            onPointerCancel={endPan}
            onLostPointerCapture={() => {
              panSession.current = null;
              setIsPanning(false);
            }}
            onDoubleClick={fitPreview}
            onDragStart={(event) => event.preventDefault()}
          >
            <div
              className="preview-camera"
              style={{
                transform: `translate(${previewCamera.x}px, ${previewCamera.y}px) scale(${previewCamera.scale})`,
                transformOrigin: "center",
              }}
            >
              <div
                className={`preview-frame ${pending ? "pending" : ""}`}
                style={
                  {
                    aspectRatio: `${currentPreviewSize.widthMm} / ${currentPreviewSize.heightMm}`,
                    "--preview-width-from-height": `${(currentPreviewSize.widthMm / currentPreviewSize.heightMm) * 100}cqh`,
                  } as React.CSSProperties
                }
                dangerouslySetInnerHTML={{ __html: previewSvg }}
              />
            </div>
            <div
              className="preview-controls"
              onPointerDown={(event) => event.stopPropagation()}
              onDoubleClick={(event) => event.stopPropagation()}
            >
              <div className="zoom-readout">
                <output>{Math.round(previewCamera.scale * 100)}%</output>
                <button type="button" onClick={fitPreview}>{t("Fit")}</button>
              </div>
              <small>{t("cameraHelp")}</small>
            </div>
          </div>}

          <div className="preview-info">
            {is3D ? <span>{t("reviewFooter")}</span> : <>
            {mode === "assembly" ? <div className="assembly-contact-readout" data-testid="assembly-contacts">
              <strong>{t("zebraContacts")}<br /><small>{t("exposedFto")}</small></strong>
              {zebraContacts.map((region) => <Help key={region.polarity} tabIndex={0} className="contact-readout"
                data-testid={`zebra-contact-${region.polarity}`} data-area-mm2={region.areaMm2}
                data-width-mm={region.strip.width} data-height-mm={region.strip.height}
                content={`大片玻璃${region.polarity === "negative" ? "左側負極" : "右側正極"}的外露區，接 cell ${region.cellNumber}。矩形外露尺寸 ${region.strip.width.toFixed(3)} × ${region.strip.height.toFixed(3)} mm；可接觸面積 ${region.areaMm2.toFixed(3)} mm² 由外露矩形與實際保留 FTO 多邊形求交，未把蝕刻掉的部分計入。斜線只是接觸位置參考，不是膠或加工圖樣。斑馬條實際壓接尺寸需放在這個區域內。`}
                contentEn={`Exposed bigger-glass ${region.polarity === "negative" ? "left negative" : "right positive"} contact to cell ${region.cellNumber}. Exposure ${region.strip.width.toFixed(3)} × ${region.strip.height.toFixed(3)} mm; usable ${region.areaMm2.toFixed(3)} mm² is the intersection with actual retained FTO, excluding removed material. Hatching is a contact reference, not glue or fabrication artwork. Fit the zebra compression footprint inside this region.`}>
                <b>{region.polarity === "negative" ? t("leftNegative") : t("rightPositive")}</b>{" · "}
                {region.strip.width.toFixed(2)} × {region.strip.height.toFixed(2)} mm{" · "}
                <b>{region.areaMm2.toFixed(2)} mm²</b>
                {!region.connected || !region.continuous || region.areaMm2 <= 0 ? ` · ${t("openUnavailable")}` : ""}
              </Help>)}
            </div> : null}
            {mode === "binding" ? <div className="preview-stats" data-testid="opening-readout">
              <strong>{t("printGap")} {derived.geometry.fabrication.minimumPrintedChannelMm.toFixed(3)} mm</strong> ·{" "}
              {t("scenario")} {derived.geometry.fabrication.openingScenario.valid ? `${derived.geometry.fabrication.minimumChannelMm.toFixed(3)} mm` : t("invalid")} ·{" "}
              {derived.geometry.fabrication.openingScenario.source === "measured-wet-film" ? t("measuredOpeningNote") : t("unmeasuredOpeningNote")}
            </div> : null}
            {mode === "etch-6066" || mode === "circuit" ? <div className="preview-stats" data-testid="terminal-check"
              data-isolated={derived.geometry.fabrication.terminalCheck.isolated ? "true" : "false"}>
              <strong>{t("biggerFto")}:</strong>{" "}
              − → {t("cell")} 1 {derived.geometry.fabrication.terminalCheck.negativeConnected ? t("ok") : t("open")} ·{" "}
              + → {t("cell")} {derived.geometry.cells.length} {derived.geometry.fabrication.terminalCheck.positiveConnected ? t("ok") : t("open")} ·{" "}
              − / + {derived.geometry.fabrication.terminalCheck.isolated ? t("isolated") : t("short")} ·{" "}
              {t("strips")} {derived.geometry.fabrication.terminalCheck.negativeStripContinuous && derived.geometry.fabrication.terminalCheck.positiveStripContinuous ? t("continuous") : t("broken")}
            </div> : null}
            {mode !== "circuit" ? <div className="preview-stats" data-testid="glass-boundary">
              {t("glassBoundary", { w: currentPreviewSize.widthMm.toFixed(1), h: currentPreviewSize.heightMm.toFixed(1) })}
              {mode === "etch-6066" || mode === "etch-6060" ? ` · ${t("bleed", { count: derived.geometry.fabrication.bleedCheck[mode === "etch-6066" ? "glass-6066" : "glass-6060"].count })}` : ""}
            </div> : null}
            <Help className="layer-readout" tabIndex={0} content={viewMetadata.description}>
              <strong>{t("layer")} {viewMetadata.layer}</strong>
            </Help>
            <div className="legend-group">
              {viewMetadata.legend.map((item) => (
                <span key={item.label}>
                  <i className={item.swatch} />
                  {item.label}
                </span>
              ))}
            </div>
            </>}
          </div>
        </section>
      </main>

      <footer className="status-bar">
        <span>
          {viewMetadata.layer}
        </span>
        <span>
          {t("coords")} {derived.config.mirrorGlass6060 ? t("on") : t("off")}
        </span>
        <span>
          {exportProgress
            ? t("statusExport")
            : pending
              ? t("statusPending")
              : blocking || generationError
                ? t("statusError")
                : t("statusPass")}
        </span>
      </footer>
    </div></HelpProvider>
  );
}

export default App;
