import { afterEach, describe, expect, it } from "vitest";

import {
  DEFAULT_CONFIG,
  type DesignConfig,
  type ElectrodeCell,
  type EtchPath,
  type LayoutGeometry,
  type PlateId,
  type Point,
  type Rect,
  type Segment,
} from "./model";
import {
  buildGeometry,
  pointInConvexPolygon,
  polygonArea,
  validateDesign,
} from "./geometry";

const EPSILON = 1e-8;

// The synchronous 2–64-cell matrix can exceed the worker RPC timeout on CI.
// Yield between cases so Vitest can receive progress acknowledgements.
afterEach(() => new Promise<void>((resolve) => setTimeout(resolve, 0)));

function config(overrides: Partial<DesignConfig> = {}): DesignConfig {
  // Known film/gap fixture: these tests exercise electrical / Voronoi geometry.
  // Unmeasured-process aperture stress cases are checked in process.test.ts.
  return { ...DEFAULT_CONFIG, measuredWetFilmUm: 15, ...overrides };
}

function openPolygon(points: Point[]): Point[] {
  const first = points[0];
  const last = points[points.length - 1];
  return first && last && first.x === last.x && first.y === last.y
    ? points.slice(0, -1)
    : points;
}

function isConvex(points: Point[]): boolean {
  const polygon = openPolygon(points);
  let direction = 0;

  for (let index = 0; index < polygon.length; index += 1) {
    const first = polygon[index];
    const second = polygon[(index + 1) % polygon.length];
    const third = polygon[(index + 2) % polygon.length];
    const cross =
      (second.x - first.x) * (third.y - second.y) -
      (second.y - first.y) * (third.x - second.x);
    if (Math.abs(cross) < EPSILON) continue;
    const nextDirection = Math.sign(cross);
    if (direction !== 0 && direction !== nextDirection) return false;
    direction = nextDirection;
  }

  return polygon.length >= 3 && direction !== 0;
}

function segmentLength(segment: Segment): number {
  return Math.hypot(
    segment.end.x - segment.start.x,
    segment.end.y - segment.start.y,
  );
}

function ownedSideSpan(
  cell: ElectrodeCell,
  active: Rect,
  side: "left" | "right",
): Segment | null {
  const sideX = side === "left" ? active.x : active.x + active.width;
  const sidePoints = openPolygon(cell.polygon).filter(
    ({ x }) => Math.abs(x - sideX) <= EPSILON,
  );
  if (sidePoints.length < 2) return null;
  const top = Math.min(...sidePoints.map(({ y }) => y));
  const bottom = Math.max(...sidePoints.map(({ y }) => y));
  return bottom - top > EPSILON
    ? {
        start: { x: sideX, y: top },
        end: { x: sideX, y: bottom },
      }
    : null;
}

function gateOwners(
  geometry: LayoutGeometry,
  side: "left" | "right",
  gate: Segment,
): number[] {
  const gateTop = Math.min(gate.start.y, gate.end.y);
  const gateBottom = Math.max(gate.start.y, gate.end.y);
  return geometry.cells.flatMap((cell) => {
    const span = ownedSideSpan(cell, geometry.active, side);
    if (!span) return [];
    const overlap =
      Math.min(gateBottom, Math.max(span.start.y, span.end.y)) -
      Math.max(gateTop, Math.min(span.start.y, span.end.y));
    return overlap > EPSILON ? [cell.index] : [];
  });
}

function sourcePaths(
  geometry: LayoutGeometry,
  plate: PlateId,
  source: EtchPath["source"],
): EtchPath[] {
  return geometry.etchPaths[plate].filter((path) => path.source === source);
}

function plateRect(geometry: LayoutGeometry, plate: PlateId): Rect {
  return plate === "glass-6066" ? geometry.glass6066 : geometry.glass6060;
}

function expectAnnulusSplit(
  geometry: LayoutGeometry,
  plate: PlateId,
): void {
  const glass = plateRect(geometry, plate);
  expect(geometry.fabrication.bleedCheck[plate].allReachGlass).toBe(true);
  expect(geometry.fabrication.bleedCheck[plate].noPerimeter).toBe(true);
  expect(geometry.etchPaths[plate].every((p) => p.source === "electrode-voronoi" || p.source === "voronoi-bleed")).toBe(true);
  for (const p of sourcePaths(geometry, plate, "voronoi-bleed")) {
    expect(Math.min(Math.abs(p.end.x - glass.x), Math.abs(p.end.x - glass.x - glass.width),
      Math.abs(p.end.y - glass.y), Math.abs(p.end.y - glass.y - glass.height))).toBeLessThan(1e-7);
  }
  if (plate === "glass-6066") expect(geometry.fabrication.isolationRoutes[plate].every((r) => r.continuousTopToBottom)).toBe(true);
}

function errorMessages(
  design: DesignConfig,
  geometry = buildGeometry(design),
): string[] {
  return validateDesign(design, geometry)
    .filter(({ severity }) => severity === "error")
    .map(({ message }) => message);
}

// Electrical topology is independent of whether a dense artwork can accommodate
// physical seal / fill slots. Those constraints are exercised in fabrication.test.
function topologyErrors(design: DesignConfig, geometry: LayoutGeometry): string[] {
  return errorMessages(design, geometry).filter((m) => !/通道|active area|製程幾何範圍|雷射填滿/.test(m));
}

describe("buildGeometry", () => {
  it("uses bindingWidthMm for the exact default active and binding rectangles", () => {
    const geometry = buildGeometry(config());

    expect(geometry.glass6066).toEqual({ x: 0, y: 0, width: 66, height: 60 });
    expect(geometry.glass6060).toEqual({ x: 3, y: 0, width: 60, height: 60 });
    expect(geometry.overlap).toEqual({ x: 3, y: 0, width: 60, height: 60 });
    expect(geometry.bindingOuter).toEqual(geometry.overlap);
    expect(geometry.active).toEqual({ x: 3.15, y: 0.15, width: 59.7, height: 59.7 });
    expect(geometry.bindingInner).toEqual(geometry.active);
    expect(geometry.active.x - geometry.bindingOuter.x).toBeCloseTo(0.15);
    expect(geometry.active.y - geometry.bindingOuter.y).toBeCloseTo(0.15);
    expect(
      geometry.bindingOuter.x +
        geometry.bindingOuter.width -
        (geometry.active.x + geometry.active.width),
    ).toBeCloseTo(0.15);
    expect(
      geometry.bindingOuter.y +
        geometry.bindingOuter.height -
        (geometry.active.y + geometry.active.height),
    ).toBeCloseTo(0.15);
  });

  it("is deterministic, covers active with convex cells, and keeps sites inside", () => {
    const first = buildGeometry(config({ electrodeSeed: 834_721 }));
    const second = buildGeometry(config({ electrodeSeed: 834_721 }));
    const right = first.active.x + first.active.width;
    const bottom = first.active.y + first.active.height;

    expect(first).toEqual(second);
    expect(
      first.cells.reduce((area, cell) => area + polygonArea(cell.polygon), 0),
    ).toBeCloseTo(first.active.width * first.active.height, 7);
    for (const cell of first.cells) {
      expect(isConvex(cell.polygon)).toBe(true);
      expect(pointInConvexPolygon(cell.site, cell.polygon)).toBe(true);
      expect(cell.site.x).toBeGreaterThan(first.active.x);
      expect(cell.site.x).toBeLessThan(right);
      expect(cell.site.y).toBeGreaterThan(first.active.y);
      expect(cell.site.y).toBeLessThan(bottom);
    }
  });

  it.each([2, 8, 16, 32, 64].flatMap((n) => [0, 1, 834_721].map((seed) => [n, seed])))("keeps jitter 2 deterministic for %i cells, seed %i", (subcellCount, electrodeSeed) => {
        const design = config({
          electrodeJitter: 2,
          electrodeSeed,
          subcellCount,
        });
        const first = buildGeometry(design);
        const second = buildGeometry(design);
        const right = first.active.x + first.active.width;
        const bottom = first.active.y + first.active.height;
        const [negative, positive] = first.terminals;
        const label = `count ${subcellCount}, seed ${electrodeSeed}`;

        expect(first, label).toEqual(second);
        expect(
          first.cells.reduce((area, cell) => area + polygonArea(cell.polygon), 0),
          label,
        ).toBeCloseTo(first.active.width * first.active.height, 7);
        for (const cell of first.cells) {
          expect(
            isConvex(cell.polygon),
            `${label}, cell ${cell.index}`,
          ).toBe(true);
          expect(
            pointInConvexPolygon(cell.site, cell.polygon),
            `${label}, cell ${cell.index}`,
          ).toBe(true);
          expect(cell.site.x, `${label}, cell ${cell.index}`).toBeGreaterThan(
            first.active.x,
          );
          expect(cell.site.x, `${label}, cell ${cell.index}`).toBeLessThan(
            right,
          );
          expect(cell.site.y, `${label}, cell ${cell.index}`).toBeGreaterThan(
            first.active.y,
          );
          expect(cell.site.y, `${label}, cell ${cell.index}`).toBeLessThan(
            bottom,
          );
        }

        expect(negative.gate.side, label).toBe("left");
        expect(positive.gate.side, label).toBe("right");
        expect(gateOwners(first, "left", negative.gate), label).toEqual([0]);
        expect(gateOwners(first, "right", positive.gate), label).toEqual([
          subcellCount - 1,
        ]);
        expectAnnulusSplit(first, "glass-6066");
        expectAnnulusSplit(first, "glass-6060");
        expect(topologyErrors(design, first), label).toEqual([]);
  });

  it("produces byte-identical electrical and etch geometry for different text", () => {
    const designs = [
      config({ electrodeSeed: 71_933, text: "A" }),
      config({
        electrodeSeed: 71_933,
        text: "SOLAR ORACLE WALKMAN 0123456789 !@#$%^&*() ".repeat(100),
      }),
      config({ electrodeSeed: 71_933, text: " ".repeat(4_096) }),
    ];
    const serialized = designs.map((design) =>
      JSON.stringify(buildGeometry(design)),
    );

    expect(serialized[1]).toBe(serialized[0]);
    expect(serialized[2]).toBe(serialized[0]);
  });

  it("creates exact full-height default contact strips and full owned gates", () => {
    const geometry = buildGeometry(config());
    const [negative, positive] = geometry.terminals;
    const negativeSpan = ownedSideSpan(
      geometry.cells[0],
      geometry.active,
      "left",
    );
    const positiveSpan = ownedSideSpan(
      geometry.cells[geometry.cells.length - 1],
      geometry.active,
      "right",
    );

    expect(negative.contactStrip).toEqual({
      x: 0,
      y: 0,
      width: 3,
      height: 60,
    });
    expect(positive.contactStrip).toEqual({
      x: 63,
      y: 0,
      width: 3,
      height: 60,
    });
    expect(negative.gate).toEqual({
      polarity: "negative",
      plate: "glass-6066",
      cellIndex: 0,
      side: "left",
      ...negativeSpan,
    });
    expect(positive.gate).toEqual({
      polarity: "positive",
      plate: "glass-6066",
      cellIndex: geometry.cells.length - 1,
      side: "right",
      ...positiveSpan,
    });
    expect(segmentLength(negative.gate)).toBeGreaterThan(0);
    expect(segmentLength(positive.gate)).toBeGreaterThan(0);
    expect(negative.contact).toEqual({
      x: 1.5,
      y: (negative.gate.start.y + negative.gate.end.y) / 2,
    });
    expect(positive.contact).toEqual({
      x: 64.5,
      y: (positive.gate.start.y + positive.gate.end.y) / 2,
    });
    expect(geometry.electronPath).toEqual([
      negative.contact,
      ...geometry.cells.map(({ site }) => site),
      positive.contact,
    ]);
  });

  it("uses selected Voronoi boundaries as canonical electrode etch paths", () => {
    const geometry = buildGeometry(config());

    for (const plate of ["glass-6066", "glass-6060"] as const) {
      const expected = geometry.boundaries.flatMap((boundary, boundaryIndex) =>
        boundary.etchPlates.includes(plate)
          ? [
              {
                source: "electrode-voronoi",
                plate,
                boundaryIndex,
                cells: boundary.cells,
                start: boundary.start,
                end: boundary.end,
              },
            ]
          : [],
      );
      expect(sourcePaths(geometry, plate, "electrode-voronoi")).toEqual(
        expected,
      );
    }
  });

  it("does not etch an active perimeter on either glass", () => {
    const geometry = buildGeometry(config());

    expect(sourcePaths(geometry, "glass-6060", "active-perimeter")).toEqual([]);
    expect(sourcePaths(geometry, "glass-6066", "active-perimeter")).toEqual([]);
  });

  it("continues 6060 Voronoi edges in their original direction to the glass edge", () => {
    const geometry = buildGeometry(config());
    const paths = sourcePaths(geometry, "glass-6060", "voronoi-bleed");
    expect(paths.length).toBeGreaterThan(0);
    for (const p of paths) {
      const b = geometry.boundaries[p.boundaryIndex!];
      const cross = (b.end.x - b.start.x) * (p.end.y - p.start.y) - (b.end.y - b.start.y) * (p.end.x - p.start.x);
      expect(Math.abs(cross)).toBeLessThan(1e-6);
    }
  });

  it("extends both isolation boundaries to the real glass top and bottom", () => {
    const geometry = buildGeometry(config());

    expectAnnulusSplit(geometry, "glass-6066");
    expectAnnulusSplit(geometry, "glass-6060");
    expect(geometry.terminals[0].contact.x).toBeLessThan(33);
    expect(geometry.terminals[1].contact.x).toBeGreaterThan(33);
    expect(sourcePaths(geometry, "glass-6060", "active-perimeter")).toHaveLength(0);
  });

  it.each(Array.from({ length: 32 }, (_, i) => (i + 1) * 2))("preserves terminal ownership and W-series topology for %i cells", (subcellCount) => {
      const design = config({ subcellCount });
      const geometry = buildGeometry(design);
      const [negative, positive] = geometry.terminals;
      const label = `count ${subcellCount}`;

      expect(geometry.cells, label).toHaveLength(subcellCount);
      expect(geometry.rowCount % 2, label).toBe(1);
      expect(segmentLength(negative.gate), label).toBeGreaterThan(0);
      expect(segmentLength(positive.gate), label).toBeGreaterThan(0);
      expect(gateOwners(geometry, "left", negative.gate), label).toEqual([0]);
      expect(gateOwners(geometry, "right", positive.gate), label).toEqual([
        subcellCount - 1,
      ]);
      expectAnnulusSplit(geometry, "glass-6066");
      expectAnnulusSplit(geometry, "glass-6060");

      for (let index = 0; index < subcellCount - 1; index += 1) {
        const boundary = geometry.boundaries.find(
          ({ cells, seriesConnection }) =>
            seriesConnection && cells[0] === index && cells[1] === index + 1,
        );
        const connectionPlate = index % 2 === 0 ? "glass-6060" : "glass-6066";
        expect(boundary, `${label}, cells ${index}-${index + 1}`).toBeDefined();
        expect(boundary?.connectionPlate).toBe(connectionPlate);
        expect(boundary?.etchPlates).toEqual([
          connectionPlate === "glass-6060" ? "glass-6066" : "glass-6060",
        ]);
      }

      expect(topologyErrors(design, geometry), label).toEqual([]);
  });
});

describe("validateDesign", () => {
  it("is text-independent and accepts the canonical default", () => {
    const designs = [
      config({ text: "" }),
      config({ text: " ".repeat(4_096) }),
      config({ text: "1234 !@#$ LONG-TEXT\n".repeat(100) }),
    ];
    const warningSets = designs.map((design) =>
      validateDesign(design, buildGeometry(design)),
    );

    expect(warningSets[1]).toEqual(warningSets[0]);
    expect(warningSets[2]).toEqual(warningSets[0]);
    expect(
      warningSets.flat().filter(({ severity }) => severity !== "info"),
    ).toEqual([]);
  });

  it("enforces process-dependent binding limits and the 5 mm ceiling", () => {
    for (const bindingWidthMm of [Number.NaN, Number.POSITIVE_INFINITY, 0, -1]) {
      expect(
        errorMessages(config({ bindingWidthMm })).some((message) =>
          message.includes("Binding"),
        ),
      ).toBe(true);
    }

    for (const bindingWidthMm of [0.1, 5.5]) {
      const design = config({ bindingWidthMm });
      const warnings = validateDesign(design, buildGeometry(design));
      expect(
        warnings.some(
          ({ severity, message }) =>
            severity === "error" && message.includes("Binding"),
        ),
      ).toBe(true);
    }

    for (const bindingWidthMm of [1, 5]) {
      const design = config({ bindingWidthMm });
      expect(
        validateDesign(design, buildGeometry(design)).some(
          ({ severity, message }) => severity === "error" && message.includes("Binding 寬度"),
        ),
      ).toBe(false);
    }
  });

  it("accepts electrodeJitter from 0 through 2 and rejects only values outside it", () => {
    for (const electrodeJitter of [0, 0.45, 1, 2]) {
      const design = config({ electrodeJitter });
      expect(errorMessages(design), `jitter ${electrodeJitter}`).toEqual([]);
    }

    for (const electrodeJitter of [
      -Number.EPSILON,
      2 + 1e-12,
      Number.NaN,
      Number.NEGATIVE_INFINITY,
      Number.POSITIVE_INFINITY,
    ]) {
      const design = config({ electrodeJitter });
      expect(
        errorMessages(design).some(
          (message) =>
            message.includes("electrodeJitter") &&
            message.includes("0") &&
            message.includes("2"),
        ),
        `jitter ${String(electrodeJitter)}`,
      ).toBe(true);
    }
  });

  it("rejects odd counts and a binding width that removes active area", () => {
    expect(
      errorMessages(config({ subcellCount: 15 })).some((message) =>
        message.includes("偶數"),
      ),
    ).toBe(true);

    const design = config({ bindingWidthMm: 61 });
    const geometry = buildGeometry(design);
    expect(geometry.active.width).toBe(0);
    expect(geometry.active.height).toBe(0);
    expect(
      errorMessages(design, geometry).some((message) =>
        message.includes("有效區"),
      ),
    ).toBe(true);
  });

  it("detects non-full-height strips and incomplete or misaligned gates", () => {
    const design = config();
    const stripGeometry = buildGeometry(design);
    stripGeometry.terminals[0].contactStrip.height -= 1;
    expect(
      errorMessages(design, stripGeometry).some((message) =>
        message.includes("完整高度"),
      ),
    ).toBe(true);

    const gateGeometry = buildGeometry(design);
    gateGeometry.terminals[1].gate.start.y += 0.25;
    expect(
      errorMessages(design, gateGeometry).some((message) =>
        message.includes("gate"),
      ),
    ).toBe(true);
  });

  it("detects any non-canonical etch source, metadata, order, or isolation count", () => {
    const design = config();
    const variants = [
      buildGeometry(design),
      buildGeometry(design),
      buildGeometry(design),
      buildGeometry(design),
    ];
    variants[0].etchPaths["glass-6060"].pop();
    variants[1].etchPaths["glass-6066"][0].plate = "glass-6060";
    variants[2].etchPaths["glass-6060"].reverse();
    Object.assign(variants[3].etchPaths["glass-6066"][0], {
      perimeterIndex: 99,
    });

    for (const geometry of variants) {
      expect(
        errorMessages(design, geometry).some((message) =>
          message.includes("canonical etchPaths"),
        ),
      ).toBe(true);
    }
  });
});
