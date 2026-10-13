export type PlateId = "glass-6066" | "glass-6060";
export type Material = "tio2" | "pt";

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
  glass6066HeightMm: number;
  glass6060WidthMm: number;
  glass6060HeightMm: number;
  bindingWidthMm: number;
  subcellCount: number;
  electrodeSeed: number;
  electrodeJitter: number;
  ftoEtchWidthMm: number;
  text: string;
  mirrorGlass6060: boolean;
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
  | "active-perimeter"
  | "terminal-isolation";

export interface EtchPath extends Segment {
  source: EtchPathSource;
  plate: PlateId;
  boundaryIndex?: number;
  cells?: [number, number];
  perimeterIndex?: number;
  pieceIndex?: number;
  isolationIndex?: number;
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
  glass6066HeightMm: 60,
  glass6060WidthMm: 60,
  glass6060HeightMm: 60,
  bindingWidthMm: 3,
  subcellCount: 16,
  electrodeSeed: 6066,
  electrodeJitter: 0.34,
  ftoEtchWidthMm: 0.08,
  text: "SOLAR ORACLE WALKMAN",
  mirrorGlass6060: true,
};
