import type { DesignConfig, ElectrodeCell, LayoutGeometry, Material, PlateId } from './model';

/** User-specified paste identities; these labels do not calibrate film or I–V properties. */
export const PASTES = {
  tio2: { productCode: '18NR-T', material: 'TiO2', function: 'photoanode-paste' },
  pt: { productCode: 'PT-1', material: 'Pt', function: 'counterelectrode-paste' },
} as const;

export function materialForPlate(cell: ElectrodeCell, plate: PlateId): Material {
  return plate === 'glass-6066' ? cell.glass6066Material : cell.glass6060Material;
}

export function pasteAssignment(config: DesignConfig, geometry: LayoutGeometry) {
  return {
    format: 'w-series-paste-assignment-v1', units: 'mm', products: PASTES,
    geometrySource: geometry.fabrication.activeShapes ? 'fabrication.activeShapes' : 'fabrication.activeRegions',
    basis: 'Co-registered opposing footprints; W-series order swaps 18NR-T / PT-1 between plates. Paste names are identifiers, not measured optical/electrical parameters.',
    plates: (['glass-6066', 'glass-6060'] as const).map((plate) => ({
      plate, role: plate === 'glass-6066' ? 'bigger' : 'smaller',
      fabricationMirrorX: plate === 'glass-6060' && config.mirrorGlass6060,
      areasMm2: Object.fromEntries((['tio2', 'pt'] as const).map((kind) => [PASTES[kind].productCode,
        geometry.cells.filter((cell) => materialForPlate(cell, plate) === kind).reduce((sum, cell) => sum + geometry.fabrication.cellAreasMm2[cell.index], 0)])),
    })),
    cells: geometry.cells.map((cell) => ({ cellNumber: cell.index + 1, activeAreaMm2: geometry.fabrication.cellAreasMm2[cell.index],
      bigger: PASTES[materialForPlate(cell, 'glass-6066')].productCode,
      smaller: PASTES[materialForPlate(cell, 'glass-6060')].productCode,
    })),
  };
}
