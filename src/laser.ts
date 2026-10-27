import type { DesignConfig, LayoutGeometry, PlateId, Segment } from "./model";

export interface LaserFillLine extends Segment {
  pathIndex: number;
  scanIndex: number;
}

function clipBeamCentre(s: LaserFillLine, width: number, height: number, radius: number): LaserFillLine | null {
  const dx = s.end.x - s.start.x, dy = s.end.y - s.start.y;
  let lo = 0, hi = 1;
  for (const [p, q] of [[-dx, s.start.x - radius], [dx, width - radius - s.start.x],
    [-dy, s.start.y - radius], [dy, height - radius - s.start.y]]) {
    if (Math.abs(p) < 1e-12) { if (q < 0) return null; continue; }
    const t = q / p;
    if (p < 0) lo = Math.max(lo, t); else hi = Math.min(hi, t);
    if (lo > hi) return null;
  }
  return { ...s, start: { x: s.start.x + lo * dx, y: s.start.y + lo * dy },
    end: { x: s.start.x + hi * dx, y: s.start.y + hi * dy } };
}

/** Parallel beam-centre scans in each butt-ended removal rectangle. Circular
 * spot corners have a residual bounded by spot radius; no machine power assumed. */
export function laserFillLines(c: DesignConfig, g: LayoutGeometry, plate: PlateId): LaserFillLine[] {
  if (!(c.laserHatchMm > 0 && c.laserSpotMm > 0 && c.laserHatchMm <= c.laserSpotMm && c.laserSpotMm <= c.ftoEtchWidthMm)) {
    throw new Error("Laser fill requires 0 < hatch ≤ spot ≤ etch width.");
  }
  const glass = plate === "glass-6066" ? g.glass6066 : g.glass6060;
  const map = (x: number, y: number) => ({
    x: plate === "glass-6060" && c.mirrorGlass6060 ? glass.width - (x - glass.x) : x - glass.x,
    y: y - glass.y,
  });
  return g.etchPaths[plate].flatMap((s, pathIndex) => {
    const dx = s.end.x - s.start.x, dy = s.end.y - s.start.y, l = Math.hypot(dx, dy);
    if (l < c.laserSpotMm) return [];
    const onGlassEdge = (p: { x: number; y: number }) => Math.abs(p.x) < 1e-7 ||
      Math.abs(p.x - glass.width) < 1e-7 || Math.abs(p.y) < 1e-7 || Math.abs(p.y - glass.height) < 1e-7;
    const startAtEdge = onGlassEdge(map(s.start.x, s.start.y));
    const endAtEdge = onGlassEdge(map(s.end.x, s.end.y));
    // Extend the mathematical scan line beyond an edge before clipping it back
    // to the glass. This lets EVERY offset hatch, including diagonal bleeds,
    // reach the physical boundary rather than stopping short after offsetting.
    const overscan = 2 * Math.hypot(glass.width, glass.height) + c.ftoEtchWidthMm;
    const startInset = startAtEdge ? -overscan : c.laserSpotMm / 2;
    const endInset = endAtEdge ? -overscan : c.laserSpotMm / 2;
    const half = (c.ftoEtchWidthMm - c.laserSpotMm) / 2;
    const count = Math.max(1, Math.ceil(2 * half / c.laserHatchMm));
    return Array.from({ length: half > 1e-10 ? count + 1 : 1 }, (_, scanIndex) => {
      const offset = half > 1e-10 ? -half + 2 * half * scanIndex / count : 0;
      const start = map(s.start.x + dx / l * startInset - dy / l * offset,
        s.start.y + dy / l * startInset + dx / l * offset);
      const end = map(s.end.x - dx / l * endInset - dy / l * offset,
        s.end.y - dy / l * endInset + dx / l * offset);
      return { pathIndex, scanIndex, start: scanIndex % 2 ? end : start, end: scanIndex % 2 ? start : end };
    }).flatMap((line) => {
      // Edge isolation must reach the actual substrate edge. Do not retract
      // these cuts by a spot radius; the spot can straddle the glass boundary.
      const clipped = clipBeamCentre(line, glass.width, glass.height, startAtEdge || endAtEdge ? 0 : c.laserSpotMm / 2);
      return clipped ? [clipped] : [];
    });
  });
}

export function laserFillExport(c: DesignConfig, g: LayoutGeometry) {
  return {
    format: "w-series-dssc-laser-fill-v1", units: "mm", origin: "top-left", xDirection: "right", yDirection: "down",
    spotDiameterMm: c.laserSpotMm, maximumHatchPitchMm: c.laserHatchMm,
    removalWidthMm: c.ftoEtchWidthMm,
    interpretation: "Each segment is laser ON; travel between segments is laser OFF. Coordinates are conductive-side plate-local. Edge-reaching isolation scans end at the physical glass edge, with the spot straddling that boundary; internal butt endpoints are radius-compensated. Repeated overlap at junctions needs dose calibration. Circular spot corners may leave residuals up to spot radius; inspect isolation on a coupon. No speed, power, dwell or machine protocol is specified.",
    plates: Object.fromEntries((["glass-6066", "glass-6060"] as const).map((plate) => {
      const r = plate === "glass-6066" ? g.glass6066 : g.glass6060;
      return [plate, { widthMm: r.width, heightMm: r.height,
        mirroredHorizontally: plate === "glass-6060" && c.mirrorGlass6060,
        scans: laserFillLines(c, g, plate) }];
    })),
  };
}

export function laserFillSvg(c: DesignConfig, g: LayoutGeometry, plate: PlateId): string {
  const r = plate === "glass-6066" ? g.glass6066 : g.glass6060;
  const paths = laserFillLines(c, g, plate).map((s) => `<path data-source-path="${s.pathIndex}" d="M ${s.start.x} ${s.start.y} L ${s.end.x} ${s.end.y}"/>`).join("\n");
  return `<svg xmlns="http://www.w3.org/2000/svg" width="${r.width}mm" height="${r.height}mm" viewBox="0 0 ${r.width} ${r.height}"><title>${plate} laser beam-centre fill scans; mm</title><g fill="none" stroke="#000000" stroke-width="0.01">${paths}</g></svg>`;
}
