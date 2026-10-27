import type { DesignConfig, FabricationGeometry, LayoutGeometry, PlateId, Point, PolygonSet } from "./model";
import { center, componentAt, difference, intersect, rectRing, setArea, shape, strokeRect, union } from "./polygons";

type ConductiveGeometry = Pick<LayoutGeometry, "cells" | "terminals">;

export function buildRetainedFto(c: DesignConfig, g: Pick<LayoutGeometry, "glass6066" | "glass6060" | "etchPaths">) {
  return Object.fromEntries((["glass-6066", "glass-6060"] as const).map((plate) => {
    const glass = plate === "glass-6066" ? g.glass6066 : g.glass6060;
    const retained = difference(shape(rectRing(glass)), union(...g.etchPaths[plate].map((s) => strokeRect(s, c.ftoEtchWidthMm))));
    // Normalize retraced zero-area joins before treating contours as islands.
    return [plate, union(retained)];
  })) as Record<PlateId, PolygonSet>;
}

/** Shared finite-kerf check for optimizer acceptance and final fabrication DRC. */
export function checkFtoConnectivity(g: ConductiveGeometry, activeRegions: Point[][], retainedFto: Record<PlateId, PolygonSet>): {
  errors: string[];
  terminalCheck: FabricationGeometry["terminalCheck"];
} {
  const errors: string[] = [];
  for (const plate of ["glass-6066", "glass-6060"] as const) {
    const retained = retainedFto[plate];
    const islands = g.cells.map((cell) => componentAt(activeRegions[cell.index].length ? center(activeRegions[cell.index]) : cell.site, retained));
    if (islands.some((v) => v < 0)) errors.push(`${plate} 蝕刻已移除子電池有效區，請縮小 FTO Etch Width。`);
    for (let i = 0; i < islands.length; i++) for (let j = i + 1; j < islands.length; j++) {
      const expected = j === i + 1 && (i % 2 === 0 ? "glass-6060" : "glass-6066") === plate;
      if ((islands[i] >= 0 && islands[i] === islands[j]) !== expected) {
        errors.push(`${plate} 有限蝕刻寬度下 cell ${i + 1}/${j + 1} 的導通不符合 W 串聯。`);
      }
    }
  }
  const stripIslands = g.terminals.map((t) => componentAt(t.contact, retainedFto["glass-6066"]));
  const terminalConnections = g.terminals.map((t, i) => {
    const stripIsland = stripIslands[i];
    const electrodePoint = activeRegions[t.cellIndex]?.length ? center(activeRegions[t.cellIndex]) : g.cells[t.cellIndex]?.site ?? t.contact;
    const connected = stripIsland >= 0 && stripIsland === componentAt(electrodePoint, retainedFto["glass-6066"]);
    if (!connected) errors.push(`Cell ${t.cellIndex + 1} 未與 ${t.polarity} zebra 接觸條連通。`);
    const stripPieces = intersect(shape(rectRing(t.contactStrip)), retainedFto["glass-6066"]);
    const continuous = stripPieces.length === 1 && setArea(stripPieces) > 1e-8 && stripIsland >= 0;
    if (!continuous) errors.push(`${t.polarity} 接觸條的保留 FTO 被切斷／移除，無法形成連續接觸面。`);
    return { connected, continuous };
  });
  const isolated = stripIslands[0] >= 0 && stripIslands[1] >= 0 && stripIslands[0] !== stripIslands[1];
  if (!isolated && stripIslands[0] >= 0 && stripIslands[1] >= 0) errors.push("6066 正負接觸條存在 FTO 直通短路（包括玻璃外圈旁路）。");
  return { errors, terminalCheck: { negativeConnected: terminalConnections[0].connected,
    positiveConnected: terminalConnections[1].connected, negativeStripContinuous: terminalConnections[0].continuous,
    positiveStripContinuous: terminalConnections[1].continuous, isolated,
    // The caller adds the separate full-height cut-route tracing result.
    fullHeightIsolation: false } };
}
