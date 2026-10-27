import type { LayoutGeometry } from "./model";
import { intersect, rectRing, setArea, shape } from "./polygons";

/** Exposed bigger-plate FTO outside the smaller plate. Display and reference
 * exports share the actual retained-FTO intersection, not a second layout. */
export function zebraContactRegions(geometry: LayoutGeometry) {
  return geometry.terminals.map((terminal) => {
    const strip = terminal.contactStrip;
    const polygons = strip.width > 0 && strip.height > 0
      ? intersect(shape(rectRing(strip)), geometry.fabrication.retainedFto[terminal.plate]) : [];
    const check = geometry.fabrication.terminalCheck;
    return {
      polarity: terminal.polarity,
      plate: terminal.plate,
      cellNumber: terminal.cellIndex + 1,
      strip,
      polygons,
      areaMm2: setArea(polygons),
      connected: terminal.polarity === "negative" ? check.negativeConnected : check.positiveConnected,
      continuous: terminal.polarity === "negative" ? check.negativeStripContinuous : check.positiveStripContinuous,
    };
  });
}
