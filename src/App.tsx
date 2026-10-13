import {
  startTransition,
  useDeferredValue,
  useEffect,
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
  POINT_CODE_RADIUS_MM,
  type DesignConfig,
  type LayoutGeometry,
  type PointCodeArtwork,
  type PreviewMode,
} from "./model";
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

interface ExportProgress {
  completed: number;
  total: number;
  label: string;
}

interface ViewMetadata {
  layer: string;
  description: string;
  legend: Array<{ swatch: string; label: string }>;
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

const STORAGE_KEY = "w-series-voronoi-layout-v4";
const SCREEN_6066_ASSET_ID = "screen-glass-6066-tio2";
const SCREEN_6060_ASSET_ID = "screen-glass-6060-tio2";
const MIN_PREVIEW_SCALE = 0.25;
const MAX_PREVIEW_SCALE = 8;
const FIT_CAMERA: PreviewCamera = { scale: 1, x: 0, y: 0 };

const VIEWS: Array<{ id: PreviewMode; label: string }> = [
  { id: "assembly", label: "Final Assembly" },
  { id: "circuit", label: "Circuit" },
  { id: "glass-6066", label: "Screen 6066" },
  { id: "glass-6060", label: "Screen 6060" },
  { id: "etch-6066", label: "Etch 6066" },
  { id: "etch-6060", label: "Etch 6060" },
  { id: "binding", label: "Binding" },
];

const VIEW_METADATA: Record<PreviewMode, ViewMetadata> = {
  assembly: {
    layer: "User.Assembly",
    description: "Top-level 6066 material regions; reference only, not a fabrication layer.",
    legend: [
      { swatch: "gray-fill", label: "Top-level TiO2 region" },
      { swatch: "dark-fill", label: "Top-level Pt region" },
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
    layer: "Fab.Screen.6066.TiO2",
    description: "Black is the top-level TiO2 region; white dots are point knockouts.",
    legend: [
      { swatch: "black-fill", label: "Top-level TiO2 region" },
      { swatch: "white-fill", label: "Pt / no TiO2 print" },
      {
        swatch: "point-knockout",
        label: `${POINT_CODE_RADIUS_MM.toFixed(2)} mm radius point knockout`,
      },
    ],
  },
  "glass-6060": {
    layer: "Fab.Screen.6060.TiO2",
    description: "Black is the top-level TiO2 region; white dots are point knockouts.",
    legend: [
      { swatch: "black-fill", label: "Top-level TiO2 region" },
      { swatch: "white-fill", label: "Pt / no TiO2 print" },
      {
        swatch: "point-knockout",
        label: `${POINT_CODE_RADIUS_MM.toFixed(2)} mm radius point knockout`,
      },
    ],
  },
  "etch-6066": {
    layer: "FTO.Etch.6066",
    description: "Black = canonical FTO removal centerline; white = retained FTO.",
    legend: [
      { swatch: "route-line", label: "FTO removal centerline" },
      { swatch: "white-fill", label: "Retained FTO" },
    ],
  },
  "etch-6060": {
    layer: "FTO.Etch.6060",
    description: "Black = canonical FTO removal centerline; white = retained FTO.",
    legend: [
      { swatch: "route-line", label: "FTO removal centerline" },
      { swatch: "white-fill", label: "Retained FTO" },
    ],
  },
  binding: {
    layer: "User.Binding",
    description: "Black = perimeter and inter-cell seal/glue; white = no adhesive.",
    legend: [
      { swatch: "black-fill", label: "Seal / glue deposition" },
      { swatch: "white-fill", label: "No adhesive" },
    ],
  },
};

function loadInitialConfig(): DesignConfig {
  try {
    const stored = localStorage.getItem(STORAGE_KEY);
    if (!stored) return { ...DEFAULT_CONFIG };
    const parsed = JSON.parse(stored) as Partial<DesignConfig>;
    return Object.fromEntries(
      (Object.keys(DEFAULT_CONFIG) as Array<keyof DesignConfig>).map((key) => [
        key,
        parsed[key] ?? DEFAULT_CONFIG[key],
      ]),
    ) as unknown as DesignConfig;
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
  title: string;
  children: React.ReactNode;
}) {
  return (
    <section className="form-section">
      <h2>{title}</h2>
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
  label: string;
  value: number;
  min: number;
  max: number;
  step: number;
  unit?: string;
  onChange: (value: number) => void;
}) {
  const focused = useRef(false);
  const [draft, setDraft] = useState(() => String(value));

  useEffect(() => {
    if (!focused.current) setDraft(String(value));
  }, [value]);

  const commit = () => {
    const next = draft.trim();
    setDraft(String(value));
    if (next === "") return;

    const parsed = Number(next);
    if (Number.isFinite(parsed)) onChange(parsed);
  };

  return (
    <label className="form-row">
      <span>{label}</span>
      <span className="input-with-unit">
        <input
          className="number-draft"
          type="text"
          inputMode="decimal"
          autoComplete="off"
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
        <small>{unit}</small>
      </span>
    </label>
  );
}

function App() {
  const [config, setConfig] = useState<DesignConfig>(loadInitialConfig);
  const [derived, setDerived] = useState<DerivedDesign>(() =>
    deriveDesign(config),
  );
  const [mode, setMode] = useState<PreviewMode>("assembly");
  const [previewSvg, setPreviewSvg] = useState(() =>
    buildPreviewSvg(
      derived.config,
      derived.geometry,
      derived.pointCodeArtwork,
      mode,
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
    startTransition(() => {
      setPreviewSvg(
        buildPreviewSvg(
          derived.config,
          derived.geometry,
          derived.pointCodeArtwork,
          mode,
        ),
      );
    });
  }, [derived, mode]);

  useEffect(() => {
    setPreviewCamera({ ...FIT_CAMERA });
  }, [mode]);

  useEffect(() => {
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
  }, []);

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
  ) => setConfig((current) => ({ ...current, [key]: value }));

  const warnings = [
    ...validateDesign(derived.config, derived.geometry),
    ...validatePointCodeArtwork(
      derived.config,
      derived.geometry,
      derived.pointCodeArtwork,
    ),
  ];
  const blocking = warnings.some(({ severity }) => severity === "error");
  const currentPreviewSize = previewSize(derived.geometry, mode);
  const viewMetadata = VIEW_METADATA[mode];
  const screenPlate =
    mode === "glass-6066" || mode === "glass-6060" ? mode : null;
  const visiblePointCount = screenPlate
    ? derived.pointCodeArtwork.placements.reduce((sum, placement) => {
        const cell = derived.geometry.cells[placement.subcellIndex];
        const material =
          screenPlate === "glass-6066"
            ? cell?.glass6066Material
            : cell?.glass6060Material;
        return material === "tio2" ? sum + placement.sites.length : sum;
      }, 0)
    : 0;

  const assetById = (id: string) =>
    derived.assets.find((asset) => asset.id === id);
  const screen6066Asset = assetById(SCREEN_6066_ASSET_ID);
  const screen6060Asset = assetById(SCREEN_6060_ASSET_ID);

  const downloadCurrentView = () => {
    if (blocking || generationError || pending || exportLock.current) return;
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
    <div className="classic-window">
      <header className="title-bar">
        <span className="close-box" aria-hidden="true" />
        <h1>W-Series Voronoi DSSC Layout</h1>
        <span className="title-status">
          {exportProgress
            ? "exporting..."
            : pending
              ? "routing..."
              : blocking || generationError
                ? "DRC error"
                : "DRC pass"}
        </span>
      </header>

      <main className="main-split">
        <aside className="sidebar-panel">
          <div className="button-row top-actions">
            <button
              disabled={exportProgress !== null}
              onClick={() =>
                update("electrodeSeed", Math.floor(Math.random() * 9_999_999))
              }
            >
              New Seed
            </button>
            <button
              disabled={exportProgress !== null}
              onClick={() => setConfig({ ...DEFAULT_CONFIG })}
            >
              Reset
            </button>
            <button
              disabled={outputDisabled}
              onClick={downloadCurrentView}
            >
              Save View SVG
            </button>
          </div>

          <Section title="Glass / Binding">
            <NumberRow
              label="Glass 6066 W"
              value={config.glass6066WidthMm}
              min={20}
              max={300}
              step={1}
              onChange={(value) => update("glass6066WidthMm", value)}
            />
            <NumberRow
              label="Glass 6066 H"
              value={config.glass6066HeightMm}
              min={20}
              max={300}
              step={1}
              onChange={(value) => update("glass6066HeightMm", value)}
            />
            <NumberRow
              label="Glass 6060 W"
              value={config.glass6060WidthMm}
              min={10}
              max={300}
              step={1}
              onChange={(value) => update("glass6060WidthMm", value)}
            />
            <NumberRow
              label="Glass 6060 H"
              value={config.glass6060HeightMm}
              min={10}
              max={300}
              step={1}
              onChange={(value) => update("glass6060HeightMm", value)}
            />
            <NumberRow
              label="Binding Width"
              value={config.bindingWidthMm}
              min={1}
              max={5}
              step={0.1}
              onChange={(value) =>
                update("bindingWidthMm", Math.min(5, Math.max(1, value)))
              }
            />
            <p className="parameter-note">
              Binding Width controls the 6060-inset perimeter ring and every
              inter-cell seal/glue corridor. It sets the active area and each
              cell&apos;s printable area.
            </p>
            <div className="info-well">
              OVERLAP {derived.geometry.overlap.width.toFixed(1)} ×{" "}
              {derived.geometry.overlap.height.toFixed(1)} mm<br />
              ACTIVE {derived.geometry.active.width.toFixed(1)} ×{" "}
              {derived.geometry.active.height.toFixed(1)} mm
            </div>
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
              max={0.2}
              step={0.01}
              onChange={(value) =>
                update("ftoEtchWidthMm", Math.min(0.2, Math.max(0.02, value)))
              }
            />
            <p className="parameter-note">
              Circuit always shows the ordered electron route. Etch layers
              contain only canonical FTO removal centerlines.
            </p>
          </Section>

          <Section title="Point Code Text">
            <label className="point-code-field">
              <span>Point Code Text</span>
              <textarea
                value={config.text}
                rows={4}
                spellCheck={false}
                onChange={(event) => update("text", event.target.value.toUpperCase())}
              />
            </label>
            <p className="point-code-note">
              Text is encoded as tiny {POINT_CODE_RADIUS_MM.toFixed(2)} mm radius
              screen knockout dots, not readable lettering.
            </p>
          </Section>

          <Section title="TiO2 Screens">
            <div className="screen-definition">
              <span><b>BLACK</b> = top-level TiO2 print region</span>
              <span><b>WHITE</b> = Pt / no print or point knockout</span>
              <small>1-bit bilevel TIFF · 1200 DPI · physical size</small>
            </div>
            <div className="button-column">
              <button
                className="important-button"
                disabled={outputDisabled || !screen6066Asset}
                onClick={() => void downloadScreen(SCREEN_6066_ASSET_ID)}
              >
                Download 6066 TiO2 1-bit TIFF
              </button>
              <button
                className="important-button"
                disabled={outputDisabled || !screen6060Asset}
                onClick={() => void downloadScreen(SCREEN_6060_ASSET_ID)}
              >
                Download 6060 TiO2 1-bit TIFF
              </button>
              <button
                disabled={outputDisabled}
                onClick={() => void exportBundle(true)}
              >
                Complete ZIP: PDF + 1-bit TIFF
              </button>
              <button
                disabled={outputDisabled}
                onClick={() => void exportBundle(false)}
              >
                Export Vector ZIP
              </button>
            </div>
            {exportProgress ? (
              <div className="info-well export-progress" role="status" aria-live="polite">
                {exportProgress.label} ({exportProgress.completed}/
                {exportProgress.total})
              </div>
            ) : null}
            {exportError ? (
              <div className="error-well" role="alert">{exportError}</div>
            ) : null}
          </Section>

          <Section title="DRC / Design Check">
            <div className="warning-stack">
              {warnings.map((warning, index) => (
                <div className={`notice ${warning.severity}`} key={`${index}-${warning.message}`}>
                  {warning.severity.toUpperCase()}: {warning.message}
                </div>
              ))}
              {generationError ? (
                <div className="notice error">ERROR: {generationError}</div>
              ) : null}
            </div>
          </Section>
        </aside>

        <section className="preview-panel">
          <nav className="view-toolbar" aria-label="Preview layers">
            {VIEWS.map((view) => (
              <button
                key={view.id}
                className={mode === view.id ? "selected" : ""}
                type="button"
                onClick={() => setMode(view.id)}
              >
                {view.label}
              </button>
            ))}
          </nav>

          <div
            ref={previewWorkspaceRef}
            className={`preview-workspace ${isPanning ? "panning" : ""}`}
            aria-label="Pan and zoom preview"
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
                <button type="button" onClick={fitPreview}>Fit</button>
              </div>
              <small>Wheel zoom · Drag pan</small>
            </div>
          </div>

          <div className="preview-info">
            <div className="layer-readout">
              <strong>LAYER {viewMetadata.layer}</strong>
              <span>{viewMetadata.description}</span>
            </div>
            <div className="legend-group">
              {viewMetadata.legend.map((item) => (
                <span key={item.label}>
                  <i className={item.swatch} />
                  {item.label}
                </span>
              ))}
            </div>
            {screenPlate ? (
              <div className="preview-stats">
                {visiblePointCount} knockout points · code scale{" "}
                {derived.pointCodeArtwork.codeEmMm.toFixed(2)} mm
              </div>
            ) : null}
          </div>
        </section>
      </main>

      <footer className="status-bar">
        <span>
          {viewMetadata.layer} · {viewMetadata.description}
        </span>
        <span>
          COORD mm · conductive-side plate-local · 6060 FAB MIRROR {derived.config.mirrorGlass6060 ? "ON" : "OFF"}
        </span>
        <span>
          {exportProgress
            ? "EXPORT"
            : pending
              ? "DRC RUN"
              : blocking || generationError
                ? "DRC ERR"
                : "DRC PASS"}
        </span>
      </footer>
    </div>
  );
}

export default App;
