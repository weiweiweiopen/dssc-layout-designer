import type { VoltageObservationId } from "./reference-data";

export type PlateId = "glass-6066" | "glass-6060";
export type Material = "tio2" | "pt";
export type FtoPreset = "tec7" | "tec8" | "tec10" | "tec15" | "tec20" | "custom";

export const POINT_CODE_RADIUS_MM = 0.03;
export const POINT_CODE_MIN_GAP_MM = 0.01;

export interface Point {
  x: number;
  y: number;
}

export interface Rect {
  x: number;
  y: number;
  width: number;
  height: number;
}

export interface Segment {
  start: Point;
  end: Point;
}

export interface DesignConfig {
  glass6066WidthMm: number;
  glassHeightMm: number;
  glass6060WidthMm: number;
  bindingWidthMm: number;
  subcellCount: number;
  electrodeSeed: number;
  electrodeJitter: number;
  ftoEtchWidthMm: number;
  text: string;
  mirrorGlass6060: boolean;
  screenMeshPerInch: number;
  screenWireUm: number;
  emulsionUm: number;
  transferEfficiency: number;
  sealantViscosityMpas: number;
  beadDiameterUm: number;
  beadD90Um: number;
  beadGradeMesh: number;
  pressPressureKpa: number;
  pressTimeS: number;
  registrationMm: number;
  coatingSafetyGapMm: number;
  minimumOpenMm: number;
  minimumArtworkOpeningMm: number;
  areaBalance: number;
  cellVocV: number;
  jscMaCm2: number;
  irradianceMwCm2: number;
  electricalBasis: "reference-cell" | "jsc-input";
  referenceIscMa: number;
  referenceIscRangeMa: number;
  referenceAreaMm2: number;
  referenceLightMode: "same-light" | "irradiance" | "lux-ratio";
  referenceLux: number;
  illuminanceLux: number;
  referenceVoltageObservation: VoltageObservationId;
  referenceIrradianceMwCm2: number;
  referenceSeriesOhm: number;
  diodeVoltageMv: number;
  ftoBiggerPreset: FtoPreset;
  ftoSmallerPreset: FtoPreset;
  ftoBiggerOhmSq: number;
  ftoSmallerOhmSq: number;
  laserSpotMm: number;
  laserHatchMm: number;
  targetSealWidthMm: number;
  measuredWetFilmUm: number;
  edgeBleedUm: number;
  printEdgeToleranceUm: number;
}

/** Polygon -> rings -> points; first ring is exterior, subsequent rings are holes. */
export type PolygonSet = Point[][][];

export interface FillPort extends Rect {
  from: number | "top";
  to: number | "bottom";
  finalWidthMm: number;
  printedWidthMm: number;
}

export interface IsolationRoute {
  side: "left" | "right";
  points: Point[];
  /** References to existing canonical cuts; not additional laser operations. */
  pathIndices: number[];
  continuousTopToBottom: boolean;
}

export interface FabricationGeometry {
  activeRegions: Point[][];
  cellAreasMm2: number[];
  totalActiveMm2: number;
  areaCv: number;
  coatingClearance: {
    targetMm: number;
    registrationMm: number;
    scenarioSpreadMm: number;
    insetMm: number;
    printedRequiredMm: number;
    scenarioRequiredMm: number;
    minimumPrintedMm: number | null;
    minimumScenarioMm: number | null;
    perCell: Array<{ cellNumber: number; printedMm: number | null; scenarioMm: number | null }>;
    method: "parallel-wall-offset-no-trimming";
  };
  sealPrint: PolygonSet;
  sealAssembled: PolygonSet;
  ports: FillPort[];
  retainedFto: Record<PlateId, PolygonSet>;
  sealPrintAreaMm2: number;
  volumeSpreadMm: number | null;
  envelopeSpreadMm: number;
  minimumChannelMm: number;
  minimumPrintedChannelMm: number;
  openingScenario: {
    filmUm: number;
    source: "measured-wet-film" | "unmeasured-screen-charge";
    volumeSpreadMm: number | null;
    valid: boolean;
  };
  compressionValid: boolean;
  isolationRoutes: Record<PlateId, IsolationRoute[]>;
  bleedCheck: Record<PlateId, { count: number; allReachGlass: boolean; noPerimeter: boolean }>;
  terminalCheck: {
    negativeConnected: boolean;
    positiveConnected: boolean;
    negativeStripContinuous: boolean;
    positiveStripContinuous: boolean;
    isolated: boolean;
    fullHeightIsolation: boolean;
  };
  errors: string[];
}

export interface ElectrodeCell {
  index: number;
  site: Point;
  polygon: Point[];
  glass6066Material: Material;
  glass6060Material: Material;
}

export interface ElectrodeBoundary extends Segment {
  cells: [number, number];
  seriesConnection: boolean;
  connectionPlate: PlateId | null;
  etchPlates: PlateId[];
}

export interface Terminal {
  polarity: "negative" | "positive";
  plate: "glass-6066";
  contactStrip: Rect;
  contact: Point;
  cellIndex: number;
  gate: TerminalGate;
}

export interface TerminalGate extends Segment {
  polarity: "negative" | "positive";
  plate: "glass-6066";
  cellIndex: number;
  side: "left" | "right";
}

export type EtchPathSource =
  | "electrode-voronoi"
  | "voronoi-bleed"
  | "active-perimeter"
  | "terminal-isolation"
  | "contact-strip-isolation";

export interface EtchPath extends Segment {
  source: EtchPathSource;
  plate: PlateId;
  boundaryIndex?: number;
  cells?: [number, number];
  perimeterIndex?: number;
  pieceIndex?: number;
  isolationIndex?: number;
  polarity?: "negative" | "positive";
  glassEdge?: "top" | "bottom" | "left" | "right";
  sharedSide?: "left" | "right";
}

export interface LayoutGeometry {
  glass6066: Rect;
  glass6060: Rect;
  overlap: Rect;
  active: Rect;
  bindingOuter: Rect;
  bindingInner: Rect;
  rowCount: number;
  cells: ElectrodeCell[];
  boundaries: ElectrodeBoundary[];
  activePerimeter: Segment[];
  terminals: [Terminal, Terminal];
  etchPaths: Record<PlateId, EtchPath[]>;
  electronPath: Point[];
  fabrication: FabricationGeometry;
}

export interface PointCodePlacement {
  slotIndex: number;
  slotIndexInSubcell: number;
  subcellIndex: number;
  character: string;
  sites: Point[];
}

export interface PointCodeArtwork {
  normalizedText: string;
  slotCount: number;
  letterCount: number;
  spaceCount: number;
  codeEmMm: number;
  slotsPerSubcell: number[];
  placements: PointCodePlacement[];
}

export type PreviewMode =
  | "assembly"
  | "circuit"
  | "glass-6066"
  | "glass-6060"
  | "etch-6066"
  | "etch-6060"
  | "binding";

export interface DesignWarning {
  severity: "error" | "warning" | "info";
  message: string;
}

export const DEFAULT_CONFIG: DesignConfig = {
  glass6066WidthMm: 66,
  glassHeightMm: 60,
  glass6060WidthMm: 60,
  bindingWidthMm: 0.3,
  subcellCount: 16,
  electrodeSeed: 6066,
  electrodeJitter: 0.34,
  ftoEtchWidthMm: 0.08,
  text: "",
  mirrorGlass6060: true,
  screenMeshPerInch: 200,
  screenWireUm: 40,
  emulsionUm: 10,
  transferEfficiency: 0.32,
  sealantViscosityMpas: 38000,
  beadDiameterUm: 15,
  beadD90Um: 20,
  beadGradeMesh: 1000,
  pressPressureKpa: 10,
  pressTimeS: 5,
  registrationMm: 0.1,
  coatingSafetyGapMm: 0.1,
  minimumOpenMm: 0.3,
  minimumArtworkOpeningMm: 0,
  areaBalance: 0.5,
  cellVocV: 0.4971,
  jscMaCm2: 10,
  irradianceMwCm2: 100,
  electricalBasis: "reference-cell",
  referenceIscMa: 39,
  referenceIscRangeMa: 1,
  referenceAreaMm2: 3025,
  referenceLightMode: "same-light",
  referenceLux: 0,
  illuminanceLux: 0,
  referenceVoltageObservation: "a-baseline",
  referenceIrradianceMwCm2: 100,
  referenceSeriesOhm: 0,
  diodeVoltageMv: 50,
  ftoBiggerPreset: "tec15",
  ftoSmallerPreset: "tec15",
  ftoBiggerOhmSq: 13,
  ftoSmallerOhmSq: 13,
  laserSpotMm: 0.04,
  laserHatchMm: 0.03,
  targetSealWidthMm: 0.3,
  measuredWetFilmUm: 0,
  edgeBleedUm: 100,
  printEdgeToleranceUm: 25,
};
