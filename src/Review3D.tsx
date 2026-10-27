import { useEffect, useLayoutEffect, useMemo, useRef, useState, type ComponentRef } from "react";
import { Canvas, useThree } from "@react-three/fiber";
import { Html, OrbitControls, OrthographicCamera, PerspectiveCamera } from "@react-three/drei";
import { DoubleSide, MOUSE, OrthographicCamera as ThreeOrthographicCamera, PerspectiveCamera as ThreePerspectiveCamera, Vector3 } from "three";
import type { DesignConfig, LayoutGeometry } from "./model";
import { useI18n } from "./i18n";
import type { UiKey } from "./locales/en";
import { Help } from "./Help";
import { buildReviewFootprints, DEFAULT_REVIEW_SETTINGS, DYE_PRESETS, reviewDyeColor, reviewStack,
  type DyeId, type ReviewFootprint, type ReviewSettings } from "./review-model";
import { reviewMeshGeometry } from "./review-shapes";

type View = "iso" | "top" | "front" | "side";
interface ViewCommand { view: View | "current"; revision: number }
const DIRECTIONS: Record<View, [number, number, number]> = {
  iso: [1, -1.15, 1], top: [0, -0.0001, 1], front: [0, -1, 0.0001], side: [1, 0, 0.0001],
};
const MOUSE_BUTTONS = { LEFT: MOUSE.ROTATE, MIDDLE: MOUSE.ROTATE, RIGHT: MOUSE.PAN };

function CameraRig({ width, height, minZ, maxZ, command, host }: {
  width: number; height: number; minZ: number; maxZ: number; command: ViewCommand;
  host: React.RefObject<HTMLDivElement | null>;
}) {
  const controls = useRef<ComponentRef<typeof OrbitControls>>(null);
  const { camera, size, invalidate } = useThree();
  const direction = useRef(new Vector3(...DIRECTIONS.iso).normalize());
  const lastCommand = useRef<ViewCommand | null>(null);
  const lastFit = useRef<{ camera: typeof camera; command: ViewCommand; width: number; height: number;
    minZ: number; maxZ: number; viewportWidth: number; viewportHeight: number } | null>(null);
  const reportCamera = () => {
    if (!controls.current) return;
    direction.current.copy(camera.position).sub(controls.current.target).normalize();
    if (host.current) host.current.dataset.cameraPose = JSON.stringify({
      position: camera.position.toArray(), target: controls.current.target.toArray(), zoom: camera.zoom,
      projection: camera instanceof ThreeOrthographicCamera ? "orthographic" : "perspective",
    });
  };
  useLayoutEffect(() => {
    const orbit = controls.current;
    if (!orbit || size.width <= 0 || size.height <= 0) return;
    const previous = lastFit.current;
    // Translation can change toolbar/footer height by a pixel. Preserve the
    // exact user pose; still reframe for a substantial viewport or model change.
    if (previous && previous.camera === camera && previous.command === command
      && previous.width === width && previous.height === height && previous.minZ === minZ && previous.maxZ === maxZ
      && Math.abs(previous.viewportWidth - size.width) <= 8 && Math.abs(previous.viewportHeight - size.height) <= 8) return;
    lastFit.current = { camera, command, width, height, minZ, maxZ, viewportWidth: size.width, viewportHeight: size.height };
    if (lastCommand.current !== command && command.view !== "current") direction.current.set(...DIRECTIONS[command.view]).normalize();
    lastCommand.current = command;
    const target = new Vector3(0, 0, (minZ + maxZ) / 2);
    // A sphere fits every preset and orbit angle, including fully exploded layers.
    const radius = Math.hypot(width, height, maxZ - minZ) / 2 * 1.12;
    const aspect = size.width / size.height;
    let distance = radius * 3;
    if (camera instanceof ThreePerspectiveCamera) {
      const vertical = camera.fov * Math.PI / 360;
      const horizontal = Math.atan(Math.tan(vertical) * aspect);
      distance = radius / Math.sin(Math.min(vertical, horizontal));
    } else if (camera instanceof ThreeOrthographicCamera) {
      camera.zoom = Math.min(size.width, size.height) / (2 * radius);
    }
    camera.position.copy(target).addScaledVector(direction.current, distance);
    camera.near = 0.01;
    camera.far = Math.max(1000, distance + radius * 6);
    camera.up.set(0, 0, 1);
    camera.lookAt(target);
    camera.updateProjectionMatrix();
    orbit.target.copy(target);
    orbit.minDistance = radius * 0.15;
    orbit.maxDistance = radius * 30;
    orbit.update();
    reportCamera();
    invalidate();
  }, [camera, size.width, size.height, width, height, minZ, maxZ, command, invalidate]);
  return <OrbitControls ref={controls} makeDefault mouseButtons={MOUSE_BUTTONS}
    enableDamping={false} screenSpacePanning onChange={reportCamera} />;
}

function LayerMesh({ layer, geometry, z, depth, settings }: {
  layer: ReviewFootprint; geometry: LayoutGeometry; z: number; depth: number; settings: ReviewSettings;
}) {
  const mesh = useMemo(() => reviewMeshGeometry(layer.polygons, {
    x: geometry.glass6066.x + geometry.glass6066.width / 2,
    y: geometry.glass6066.y + geometry.glass6066.height / 2,
  }, depth), [layer.polygons, geometry.glass6066, depth]);
  useEffect(() => () => mesh.dispose(), [mesh]);
  const kind = layer.kind;
  const color = kind === "glass" ? "#bbd9da" : kind === "fto" ? "#91b5bf"
    : kind === "tio2" ? reviewDyeColor(settings, layer.plate!) : kind === "pt" ? "#4c5159"
    : kind === "seal" ? "#18191c" : layer.id === "negative" ? "#69c6e1" : "#e9ae62";
  const opacity = kind === "glass" ? 0.055 : kind === "fto" ? 0.06 : kind === "pt" ? 0.32 : kind === "tio2" ? 0.9 : kind === "contacts" ? 0.9 : 1;
  return <mesh geometry={mesh} position={[0, 0, z]} renderOrder={kind === "glass" ? 3 : kind === "contacts" ? 2 : 0}>
    <meshStandardMaterial color={color} roughness={kind === "glass" ? 0.18 : 0.65}
      metalness={kind === "pt" ? 0.2 : 0} opacity={opacity} transparent={opacity < 1}
      depthWrite={opacity === 1} side={DoubleSide} forceSinglePass />
  </mesh>;
}

export default function Review3D({ config, geometry, compressionEnvelope, settings, onChange }: {
  config: DesignConfig; geometry: LayoutGeometry; compressionEnvelope: boolean;
  settings: ReviewSettings; onChange: (settings: ReviewSettings) => void;
}) {
  const { t } = useI18n();
  const host = useRef<HTMLDivElement>(null);
  const [ready, setReady] = useState(false);
  const [command, setCommand] = useState<ViewCommand>({ view: "iso", revision: 0 });
  const footprints = useMemo(() => buildReviewFootprints(geometry, compressionEnvelope), [geometry, compressionEnvelope]);
  const stack = reviewStack(config, settings);
  const bigger = geometry.glass6066, smaller = geometry.glass6060;
  const change = <K extends keyof ReviewSettings>(key: K, value: ReviewSettings[K]) => onChange({ ...settings, [key]: value });
  const visible = (layer: ReviewFootprint) => {
    if (layer.plate === "glass-6066" && !settings.bigger || layer.plate === "glass-6060" && !settings.smaller) return false;
    return layer.polygons.length > 0 && (layer.kind === "tio2" || layer.kind === "pt" ? settings.coatings : settings[layer.kind]);
  };
  const setView = (view: View | "current") => setCommand((current) => ({ view, revision: current.revision + 1 }));
  const toggle = (key: "bigger" | "smaller" | "glass" | "fto" | "coatings" | "seal" | "contacts" | "labels", label: UiKey) =>
    <label key={key} className="review-checkbox"><input type="checkbox" data-review-toggle={key} checked={settings[key]}
      onChange={(event) => change(key, event.target.checked)} />{t(label)}</label>;
  const dyeSelect = (plate: "bigger" | "smaller") => {
    const key = plate === "bigger" ? "biggerDye" : "smallerDye";
    const colorKey = plate === "bigger" ? "biggerColor" : "smallerColor";
    return <div className="review-dye" key={plate}>
      <Help as="label" content={t("reviewDyeHelp")}>
        <span>{t(plate === "bigger" ? "reviewBiggerDye" : "reviewSmallerDye")}</span>
        <select data-review-dye={plate} value={settings[key]} onChange={(event) => change(key, event.target.value as DyeId)}>
          {Object.entries(DYE_PRESETS).map(([value, preset]) => <option key={value} value={value}>{t(preset.label)}</option>)}
        </select>
      </Help>
      <input type="color" aria-label={t(plate === "bigger" ? "reviewBiggerDye" : "reviewSmallerDye")}
        data-review-color={plate} value={reviewDyeColor(settings, plate === "bigger" ? "glass-6066" : "glass-6060")}
        onChange={(event) => onChange({ ...settings, [key]: "custom", [colorKey]: event.target.value })} />
    </div>;
  };
  return <div className="review-layout" data-testid="review-3d">
    <div className="review-stage">
      <div className="review-camera-toolbar" role="group" aria-label={t("reviewCamera")}>
        {(["iso", "top", "front", "side"] as const).map((view) => <button type="button" key={view} data-review-view={view}
          onClick={() => setView(view)}>{t(({ iso: "reviewIso", top: "reviewTop", front: "reviewFront", side: "reviewSide" } as const)[view])}</button>)}
        <button type="button" data-testid="review-fit" onClick={() => setView("current")}>{t("Fit")}</button>
        <button type="button" data-testid="review-projection" aria-pressed={settings.orthographic}
          onClick={() => change("orthographic", !settings.orthographic)}>{t(settings.orthographic ? "reviewOrthographic" : "reviewPerspective")}</button>
      </div>
      <div ref={host} className="review-canvas" data-testid="review-canvas" data-state={ready ? "ready" : "loading"}
        data-layer-count={footprints.filter(visible).length}
        onContextMenu={(event) => event.preventDefault()}>
        <Canvas frameloop="demand" dpr={[1, 2]} gl={{ antialias: true, alpha: false }}
          onCreated={() => setReady(true)} fallback={<div className="review-placeholder">{t("reviewUnavailable")}</div>}>
          <color attach="background" args={["#292d34"]} />
          {settings.orthographic
            ? <OrthographicCamera makeDefault position={[100, -115, 100]} up={[0, 0, 1]} near={0.01} far={2000} />
            : <PerspectiveCamera makeDefault fov={38} position={[100, -115, 100]} up={[0, 0, 1]} near={0.01} far={2000} />}
          <ambientLight intensity={0.65} />
          <hemisphereLight args={["#e5edff", "#68717d", 0.7]} />
          <directionalLight position={[40, -70, 120]} intensity={2} />
          <directionalLight position={[-80, 50, 30]} intensity={0.5} />
          <gridHelper args={[Math.ceil(Math.max(bigger.width, bigger.height) / 10) * 20, Math.ceil(Math.max(bigger.width, bigger.height) / 10) * 2, "#555c66", "#3c434c"]}
            rotation={[Math.PI / 2, 0, 0]} position={[0, 0, stack.minZ - 0.5]} />
          {footprints.filter(visible).map((layer) => <LayerMesh key={layer.id} layer={layer} geometry={geometry}
            {...stack.position(layer)} settings={settings} />)}
          {settings.labels && <>
            {settings.bigger && <Html position={[-bigger.width / 2, bigger.height / 2 + 2, stack.minZ]} zIndexRange={[10, 0]} style={{ pointerEvents: "none" }}>
              <span className="review-label">{t("reviewBigger")} · {bigger.width} × {bigger.height} mm</span>
            </Html>}
            {settings.smaller && <Html position={[-smaller.width / 2, smaller.height / 2 + 2, stack.maxZ]} zIndexRange={[10, 0]} style={{ pointerEvents: "none" }}>
              <span className="review-label">{t("reviewSmaller")} · {smaller.width} × {smaller.height} mm</span>
            </Html>}
            {settings.contacts && settings.bigger && geometry.terminals.filter((terminal) => terminal.contactStrip.width > 0).map((terminal) =>
              <Html key={terminal.polarity} center zIndexRange={[10, 0]} style={{ pointerEvents: "none" }} position={[
                terminal.contactStrip.x + terminal.contactStrip.width / 2 - bigger.x - bigger.width / 2,
                bigger.height / 2 - terminal.contactStrip.height / 2,
                stack.position(footprints.find((layer) => layer.id === terminal.polarity)!).z + 0.05,
              ]}><b className={`review-contact-label ${terminal.polarity}`}>{terminal.polarity === "negative" ? "−" : "+"}</b></Html>)}
          </>}
          <CameraRig width={bigger.width} height={bigger.height} minZ={stack.minZ} maxZ={stack.maxZ} command={command} host={host} />
        </Canvas>
      </div>
      <div className="review-navigation">{t("reviewNavigation")}<br /><small>{t("reviewAlternateNavigation")}</small></div>
    </div>
    <aside className="review-settings" aria-label={t("reviewSettings")}>
      <h2>{t("reviewAppearance")}</h2>
      {dyeSelect("bigger")}{dyeSelect("smaller")}
      <small className="review-note">{t("reviewAppearanceNote")}</small>
      <h2>{t("reviewStack")}</h2>
      <Help as="label" className="review-range" content={t("reviewExplodeHelp")}>
        <span>{t("reviewExplode")} <output>{settings.explodeMm.toFixed(1)} mm</output></span>
        <input type="range" data-testid="review-explode" min="0" max="15" step="0.5" value={settings.explodeMm}
          onChange={(event) => change("explodeMm", Number(event.target.value))} />
      </Help>
      <Help as="label" className="review-range" content={t("reviewThicknessHelp")}>
        <span>{t("reviewThinScale")} <output>×{settings.thinLayerScale}</output></span>
        <input type="range" data-testid="review-thin-scale" min="1" max="100" step="1" value={settings.thinLayerScale}
          onChange={(event) => change("thinLayerScale", Number(event.target.value))} />
      </Help>
      <Help as="label" className="review-glass-thickness" content={t("reviewGlassHelp")}>
        <span>{t("reviewGlassThickness")}</span>
        <span><input type="number" data-testid="review-glass-thickness" min="0.5" max="5" step="0.1" value={settings.glassThicknessMm}
          onChange={(event) => { const n = event.target.valueAsNumber; if (Number.isFinite(n)) change("glassThicknessMm", Math.min(5, Math.max(0.5, n))); }} /> mm</span>
      </Help>
      <div className="review-thickness-readout" data-testid="review-thickness-readout">
        <strong>{t("reviewAssumedThickness")}</strong>
        <span>FTO 0.5 µm · TiO₂ 10 µm · Pt 0.01 µm</span>
        <span>{t("reviewGap")} {config.beadDiameterUm} µm</span>
        <small>{t("reviewThicknessNote")}</small>
      </div>
      <h2>{t("reviewLayers")}</h2>
      <div className="review-toggles">
        {toggle("bigger", "reviewBigger")}{toggle("smaller", "reviewSmaller")}
        {toggle("glass", "reviewGlass")}{toggle("fto", "Retained FTO")}
        {toggle("coatings", "reviewCoatings")}{toggle("seal", "reviewSeal")}
        {toggle("contacts", "± Zebra contact FTO")}{toggle("labels", "reviewLabels")}
      </div>
      <button type="button" className="review-reset" data-testid="review-reset" onClick={() => {
        onChange({ ...DEFAULT_REVIEW_SETTINGS }); setView("iso");
      }}>{t("reviewReset")}</button>
    </aside>
  </div>;
}
