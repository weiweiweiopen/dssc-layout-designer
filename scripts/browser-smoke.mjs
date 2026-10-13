import { access, mkdtemp, readFile, readdir, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { isDeepStrictEqual } from "node:util";

import { strFromU8, unzipSync } from "fflate";
import puppeteer from "puppeteer-core";

const appUrl = process.env.APP_URL ?? "http://127.0.0.1:5173";
const storageKey = "w-series-voronoi-layout-v4";
const legacyStorageKeys = [
  "w-series-voronoi-layout",
  "w-series-voronoi-layout-v1",
  "w-series-voronoi-layout-v2",
  "w-series-voronoi-layout-v3",
];
const relevantStorageKeys = [...legacyStorageKeys, storageKey];
const defaultText = "SOLAR ORACLE WALKMAN";
const replacementText = "TPMBS PSBDMF XBMLNBO";
const spacesText = " ".repeat(defaultText.length);
const viewLabels = [
  "Final Assembly",
  "Circuit",
  "Screen 6066",
  "Screen 6060",
  "Etch 6066",
  "Etch 6060",
  "Binding",
];
const configKeys = [
  "bindingWidthMm",
  "electrodeJitter",
  "electrodeSeed",
  "ftoEtchWidthMm",
  "glass6060HeightMm",
  "glass6060WidthMm",
  "glass6066HeightMm",
  "glass6066WidthMm",
  "mirrorGlass6060",
  "subcellCount",
  "text",
].sort();
const removedConfigKeys = [
  "dye1Color",
  "dye2Color",
  "electrodeGapMm",
  "fontEdgeWidthMm",
  "fontMarginMm",
  "fontSiteRadiusMm",
  "repeatText",
  "showFontSites",
  "surlynWidthMm",
];
const geometryKeys = [
  "active",
  "activePerimeter",
  "bindingInner",
  "bindingOuter",
  "boundaries",
  "cells",
  "electronPath",
  "etchPaths",
  "glass6060",
  "glass6066",
  "overlap",
  "rowCount",
  "terminals",
].sort();
const pointCodeKeys = [
  "codeEmMm",
  "letterCount",
  "normalizedText",
  "placements",
  "slotCount",
  "slotsPerSubcell",
  "spaceCount",
].sort();
const placementKeys = [
  "character",
  "sites",
  "slotIndex",
  "slotIndexInSubcell",
  "subcellIndex",
].sort();
const expectedBundlePaths = [
  "README.txt",
  "bitmap-production/screen-glass-6060-tio2-1bit-1200dpi.tif",
  "bitmap-production/screen-glass-6066-tio2-1bit-1200dpi.tif",
  "design.json",
  "fto-galvo-toolpaths.json",
  "manufacturing-layout.dxf",
  "pdf-preview/assembly-preview.pdf",
  "pdf-production/binding-mask.pdf",
  "pdf-production/fto-etch-glass-6060.pdf",
  "pdf-production/fto-etch-glass-6066.pdf",
  "pdf-production/screen-glass-6060-tio2.pdf",
  "pdf-production/screen-glass-6066-tio2.pdf",
  "svg-layered/assembly-preview.svg",
  "svg-layered/binding-mask.svg",
  "svg-layered/circuit-reference.svg",
  "svg-layered/fto-etch-glass-6060.svg",
  "svg-layered/fto-etch-glass-6066.svg",
  "svg-layered/screen-glass-6060-tio2.svg",
  "svg-layered/screen-glass-6066-tio2.svg",
  "svg-production/binding-mask.svg",
  "svg-production/fto-etch-glass-6060.svg",
  "svg-production/fto-etch-glass-6066.svg",
  "svg-production/screen-glass-6060-tio2.svg",
  "svg-production/screen-glass-6066-tio2.svg",
].sort();
const tiffPaths = [
  "bitmap-production/screen-glass-6066-tio2-1bit-1200dpi.tif",
  "bitmap-production/screen-glass-6060-tio2-1bit-1200dpi.tif",
];
const popcount = Uint8Array.from({ length: 256 }, (_, value) => {
  let count = 0;
  for (let bits = value; bits !== 0; bits >>>= 1) count += bits & 1;
  return count;
});

function ensure(condition, message) {
  if (!condition) throw new Error(message);
}

function sameArray(actual, expected, message) {
  ensure(isDeepStrictEqual(actual, expected), `${message}: ${JSON.stringify(actual)}`);
}

function sleep(milliseconds) {
  return new Promise((resolve) => setTimeout(resolve, milliseconds));
}

function isGrayscale(color) {
  const hex = color.slice(1);
  const expanded =
    hex.length === 3 || hex.length === 4
      ? [...hex].map((digit) => digit + digit).join("")
      : hex;
  return (
    expanded.length >= 6 &&
    expanded.slice(0, 2).toLowerCase() === expanded.slice(2, 4).toLowerCase() &&
    expanded.slice(2, 4).toLowerCase() === expanded.slice(4, 6).toLowerCase()
  );
}

function ensureGrayscale(colors, label) {
  ensure(colors.length > 0, `${label} contains no hexadecimal colors.`);
  ensure(
    colors.every(isGrayscale),
    `${label} contains a non-grayscale color: ${JSON.stringify(colors)}`,
  );
}

function svgGroupContents(svg, id) {
  const marker = `<g id="${id}"`;
  const start = svg.indexOf(marker);
  ensure(start >= 0, `Missing SVG group ${id}.`);
  const openingEnd = svg.indexOf(">", start);
  const tokens = /<g\b[^>]*>|<\/g>/g;
  tokens.lastIndex = openingEnd + 1;
  let depth = 1;
  let token;
  while ((token = tokens.exec(svg)) !== null) {
    depth += token[0].startsWith("</") ? -1 : 1;
    if (depth === 0) return svg.slice(openingEnd + 1, token.index);
  }
  throw new Error(`Unterminated SVG group ${id}.`);
}

function svgElements(content, tag) {
  return (
    content.match(new RegExp(`<${tag}\\b[^>]*?(?:\/>|>[\\s\\S]*?<\/${tag}>)`, "g")) ??
    []
  );
}

function svgAttribute(element, name) {
  return element.match(new RegExp(`\\s${name}="([^"]*)"`))?.[1] ?? "";
}

function closeNumber(actual, expected, tolerance = 1e-8) {
  return (
    Number.isFinite(actual) &&
    Number.isFinite(expected) &&
    Math.abs(actual - expected) <=
      tolerance * Math.max(1, Math.abs(actual), Math.abs(expected))
  );
}

function samePoint(actual, expected) {
  return closeNumber(actual?.x, expected?.x) && closeNumber(actual?.y, expected?.y);
}

function polygonVertexCount(polygon) {
  return polygon.length > 1 && samePoint(polygon[0], polygon.at(-1))
    ? polygon.length - 1
    : polygon.length;
}

function maximalOwnedSideSpan(polygon, active, side) {
  const vertexCount = polygonVertexCount(polygon);
  const sideX = side === "left" ? active.x : active.x + active.width;
  const scale = Math.max(
    1,
    Math.abs(sideX),
    Math.abs(active.y),
    active.width,
    active.height,
  );
  const tolerance = 1e-9 * scale;
  const intervals = [];
  for (let index = 0; index < vertexCount; index += 1) {
    const start = polygon[index];
    const end = polygon[(index + 1) % vertexCount];
    if (
      Math.abs(start.x - sideX) <= tolerance &&
      Math.abs(end.x - sideX) <= tolerance
    ) {
      const top = Math.min(start.y, end.y);
      const bottom = Math.max(start.y, end.y);
      if (bottom - top > tolerance) intervals.push({ top, bottom });
    }
  }
  intervals.sort((first, second) => first.top - second.top);
  const merged = [];
  for (const interval of intervals) {
    const previous = merged.at(-1);
    if (previous && interval.top <= previous.bottom + tolerance) {
      previous.bottom = Math.max(previous.bottom, interval.bottom);
    } else {
      merged.push({ ...interval });
    }
  }
  const maximal = merged.reduce(
    (longest, interval) =>
      !longest || interval.bottom - interval.top > longest.bottom - longest.top
        ? interval
        : longest,
    null,
  );
  return maximal
    ? {
        start: { x: sideX, y: maximal.top },
        end: { x: sideX, y: maximal.bottom },
      }
    : null;
}

function segmentAmount(segment, point) {
  const width = segment.end.x - segment.start.x;
  const height = segment.end.y - segment.start.y;
  if (Math.abs(width) >= Math.abs(height)) {
    return width === 0 ? 0 : (point.x - segment.start.x) / width;
  }
  return height === 0 ? 0 : (point.y - segment.start.y) / height;
}

function interpolate(start, end, amount) {
  return {
    x: start.x + (end.x - start.x) * amount,
    y: start.y + (end.y - start.y) * amount,
  };
}

function expectedCanonicalEtchPaths(geometry, plate) {
  const selectedBoundaries = geometry.boundaries.flatMap((boundary, boundaryIndex) =>
    boundary.etchPlates.includes(plate)
      ? [
          {
            source: "electrode-voronoi",
            plate,
            boundaryIndex,
            cells: [...boundary.cells],
            start: { ...boundary.start },
            end: { ...boundary.end },
          },
        ]
      : [],
  );
  const perimeterPaths = [];
  geometry.activePerimeter.forEach((segment, perimeterIndex) => {
    const gate =
      plate === "glass-6066"
        ? perimeterIndex === 1
          ? geometry.terminals[1].gate
          : perimeterIndex === 3
            ? geometry.terminals[0].gate
            : undefined
        : undefined;
    const intervals = [];
    if (gate && Math.hypot(gate.end.x - gate.start.x, gate.end.y - gate.start.y) > 0) {
      const first = Math.min(1, Math.max(0, segmentAmount(segment, gate.start)));
      const second = Math.min(1, Math.max(0, segmentAmount(segment, gate.end)));
      const gateStart = Math.min(first, second);
      const gateEnd = Math.max(first, second);
      if (gateStart > 0) intervals.push([0, gateStart]);
      if (gateEnd < 1) intervals.push([gateEnd, 1]);
    } else {
      intervals.push([0, 1]);
    }
    intervals.forEach(([startAmount, endAmount], pieceIndex) => {
      perimeterPaths.push({
        source: "active-perimeter",
        plate,
        perimeterIndex,
        pieceIndex,
        start: interpolate(segment.start, segment.end, startAmount),
        end: interpolate(segment.start, segment.end, endAmount),
      });
    });
  });
  const glass = plate === "glass-6066" ? geometry.glass6066 : geometry.glass6060;
  const centerX = geometry.active.x + geometry.active.width / 2;
  return [
    ...selectedBoundaries,
    ...perimeterPaths,
    {
      source: "terminal-isolation",
      plate,
      isolationIndex: 0,
      start: { x: centerX, y: glass.y },
      end: { x: centerX, y: geometry.active.y },
    },
    {
      source: "terminal-isolation",
      plate,
      isolationIndex: 1,
      start: { x: centerX, y: geometry.active.y + geometry.active.height },
      end: { x: centerX, y: glass.y + glass.height },
    },
  ];
}

function validateProjectGeometry(project) {
  const { config, geometry } = project;
  sameArray(Object.keys(config).sort(), configKeys, "Unexpected design config fields");
  sameArray(Object.keys(geometry).sort(), geometryKeys, "Unexpected design geometry fields");
  ensure(
    geometry.cells.length === config.subcellCount,
    "Exported electrical cell count differs from config.subcellCount.",
  );
  geometry.cells.forEach((cell, index) => {
    ensure(
      cell.index === index &&
        cell.glass6066Material === (index % 2 === 0 ? "tio2" : "pt") &&
        cell.glass6060Material === (index % 2 === 0 ? "pt" : "tio2"),
      `Exported cell ${index} has incorrect material parity.`,
    );
  });

  const expectedPerimeter = [
    {
      start: { x: geometry.active.x, y: geometry.active.y },
      end: { x: geometry.active.x + geometry.active.width, y: geometry.active.y },
    },
    {
      start: { x: geometry.active.x + geometry.active.width, y: geometry.active.y },
      end: {
        x: geometry.active.x + geometry.active.width,
        y: geometry.active.y + geometry.active.height,
      },
    },
    {
      start: {
        x: geometry.active.x + geometry.active.width,
        y: geometry.active.y + geometry.active.height,
      },
      end: { x: geometry.active.x, y: geometry.active.y + geometry.active.height },
    },
    {
      start: { x: geometry.active.x, y: geometry.active.y + geometry.active.height },
      end: { x: geometry.active.x, y: geometry.active.y },
    },
  ];
  ensure(
    isDeepStrictEqual(geometry.activePerimeter, expectedPerimeter),
    "The exported active perimeter is not the canonical full rectangle.",
  );
  ensure(geometry.terminals.length === 2, "Expected exactly two exported terminals.");

  const terminalExpectations = [
    { polarity: "negative", side: "left", cellIndex: 0 },
    { polarity: "positive", side: "right", cellIndex: geometry.cells.length - 1 },
  ];
  const gateLengths = [];
  geometry.terminals.forEach((terminal, index) => {
    const expectation = terminalExpectations[index];
    ensure(
      terminal.polarity === expectation.polarity &&
        terminal.plate === "glass-6066" &&
        terminal.cellIndex === expectation.cellIndex,
      `Terminal ${index} has incorrect identity or plate metadata.`,
    );
    const strip = terminal.contactStrip;
    ensure(
      strip.width > 0 &&
        closeNumber(strip.y, geometry.glass6066.y) &&
        closeNumber(strip.height, geometry.glass6066.height),
      `Terminal ${index} is not a positive-width full-height 6066 contact strip.`,
    );
    const expectedGate = maximalOwnedSideSpan(
      geometry.cells[expectation.cellIndex].polygon,
      geometry.active,
      expectation.side,
    );
    ensure(expectedGate, `Unable to derive the full span for terminal gate ${index}.`);
    ensure(
      terminal.gate.polarity === expectation.polarity &&
        terminal.gate.plate === "glass-6066" &&
        terminal.gate.cellIndex === expectation.cellIndex &&
        terminal.gate.side === expectation.side &&
        samePoint(terminal.gate.start, expectedGate.start) &&
        samePoint(terminal.gate.end, expectedGate.end),
      `Terminal ${index} gate does not cover its endpoint cell's full facing-side span.`,
    );
    const expectedContact = {
      x: strip.x + strip.width / 2,
      y: (expectedGate.start.y + expectedGate.end.y) / 2,
    };
    ensure(samePoint(terminal.contact, expectedContact), `Terminal ${index} contact is misaligned.`);
    gateLengths.push(Math.hypot(
      terminal.gate.end.x - terminal.gate.start.x,
      terminal.gate.end.y - terminal.gate.start.y,
    ));
  });

  const etchCounts = {};
  for (const plate of ["glass-6066", "glass-6060"]) {
    const canonical = expectedCanonicalEtchPaths(geometry, plate);
    ensure(
      isDeepStrictEqual(geometry.etchPaths[plate], canonical),
      `${plate} geometry.etchPaths is not canonical.`,
    );
    const isolation = canonical.filter(({ source }) => source === "terminal-isolation");
    sameArray(
      isolation.map(({ isolationIndex }) => isolationIndex),
      [0, 1],
      `${plate} terminal-isolation indexes are incorrect`,
    );
    etchCounts[plate] = canonical.length;
  }
  return { gateLengths, etchCounts };
}

function validateGalvo(galvo, project) {
  ensure(
    galvo.format === "w-series-dssc-galvo-toolpath-v3",
    `Unexpected Galvo format ${String(galvo.format)}.`,
  );
  ensure(galvo.units === "mm", "Galvo units are not millimetres.");
  ensure(
    /terminal-isolation/.test(galvo.description ?? ""),
    "Galvo description omits terminal isolation.",
  );
  ensure(
    galvo.interchange?.neutral === true &&
      galvo.interchange?.deviceWireProtocol === false,
    "Galvo interchange metadata is not neutral v3 output.",
  );
  ensure(
    !/FONT_|fontArtwork|microcell|data-slot|data-site|glyph-|pointCode|knockout/i.test(
      JSON.stringify(galvo),
    ),
    "Galvo output contains point-code or removed font data.",
  );
  const counts = {};
  for (const plate of ["glass-6066", "glass-6060"]) {
    const sourcePaths = project.geometry.etchPaths[plate];
    const outputPlate = galvo.plates?.[plate];
    const rect =
      plate === "glass-6066"
        ? project.geometry.glass6066
        : project.geometry.glass6060;
    ensure(outputPlate, `Galvo output is missing ${plate}.`);
    ensure(
      outputPlate.widthMm === rect.width && outputPlate.heightMm === rect.height,
      `${plate} Galvo dimensions are incorrect.`,
    );
    ensure(
      outputPlate.mirroredHorizontally ===
        (plate === "glass-6060" && project.config.mirrorGlass6060),
      `${plate} Galvo mirror metadata is incorrect.`,
    );
    ensure(
      outputPlate.paths.length === sourcePaths.length,
      `${plate} Galvo path count differs from canonical geometry.`,
    );
    outputPlate.paths.forEach((path, index) => {
      const source = sourcePaths[index];
      ensure(
        path.id === `${plate}-etch-${index}` &&
          path.source === source.source &&
          path.plate === source.plate &&
          path.widthMm === project.config.ftoEtchWidthMm,
        `${plate} Galvo path ${index} has incorrect canonical metadata.`,
      );
      for (const key of [
        "boundaryIndex",
        "cells",
        "perimeterIndex",
        "pieceIndex",
        "isolationIndex",
      ]) {
        ensure(
          isDeepStrictEqual(path[key], source[key]),
          `${plate} Galvo path ${index} has incorrect ${key}.`,
        );
      }
      [source.start, source.end].forEach((point, pointIndex) => {
        const localX = point.x - rect.x;
        const expected = {
          x:
            plate === "glass-6060" && project.config.mirrorGlass6060
              ? rect.width - localX
              : localX,
          y: point.y - rect.y,
        };
        const actual = path.points[pointIndex];
        ensure(samePoint(actual, expected), `${plate} Galvo path ${index} endpoint is incorrect.`);
        const expectedNormalized = {
          x: Math.min(1, Math.max(-1, (expected.x / rect.width) * 2 - 1)),
          y: Math.min(1, Math.max(-1, (expected.y / rect.height) * 2 - 1)),
        };
        ensure(
          samePoint(actual.normalized, expectedNormalized),
          `${plate} Galvo path ${index} normalized endpoint is incorrect.`,
        );
      });
    });
    const isolation = outputPlate.paths.filter(
      ({ source }) => source === "terminal-isolation",
    );
    sameArray(
      isolation.map(({ isolationIndex }) => isolationIndex),
      [0, 1],
      `${plate} Galvo terminal-isolation paths are incorrect`,
    );
    counts[plate] = outputPlate.paths.length;
  }
  return counts;
}

function parseBilevelTiff(bytes, filename, expectedWidth, expectedHeight) {
  ensure(bytes.byteLength >= 8, `${filename} is too short to be a TIFF.`);
  const view = new DataView(bytes.buffer, bytes.byteOffset, bytes.byteLength);
  ensure(bytes[0] === 0x49 && bytes[1] === 0x49, `${filename} does not have II magic.`);
  ensure(view.getUint16(2, true) === 42, `${filename} does not have TIFF42 magic.`);
  const ifdOffset = view.getUint32(4, true);
  ensure(ifdOffset + 2 <= bytes.byteLength, `${filename} has an invalid IFD offset.`);
  const entryCount = view.getUint16(ifdOffset, true);
  const entries = new Map();
  for (let index = 0; index < entryCount; index += 1) {
    const entryOffset = ifdOffset + 2 + index * 12;
    ensure(entryOffset + 12 <= bytes.byteLength, `${filename} has a truncated IFD.`);
    const tag = view.getUint16(entryOffset, true);
    ensure(!entries.has(tag), `${filename} repeats TIFF tag ${tag}.`);
    entries.set(tag, {
      type: view.getUint16(entryOffset + 2, true),
      count: view.getUint32(entryOffset + 4, true),
      valueOffset: view.getUint32(entryOffset + 8, true),
      entryOffset,
    });
  }
  const expectedTags = [256, 257, 258, 259, 262, 273, 274, 277, 278, 279, 282, 283, 296];
  sameArray([...entries.keys()], expectedTags, `${filename} TIFF tags are incorrect`);
  const nextIfdOffsetPosition = ifdOffset + 2 + entryCount * 12;
  ensure(nextIfdOffsetPosition + 4 <= bytes.byteLength, `${filename} has no next-IFD field.`);
  ensure(view.getUint32(nextIfdOffsetPosition, true) === 0, `${filename} has extra IFDs.`);

  const entry = (tag, type) => {
    const value = entries.get(tag);
    ensure(value, `${filename} is missing TIFF tag ${tag}.`);
    ensure(
      value.type === type && value.count === 1,
      `${filename} TIFF tag ${tag} has the wrong type or count.`,
    );
    return value;
  };
  const short = (tag) => view.getUint16(entry(tag, 3).entryOffset + 8, true);
  const long = (tag) => entry(tag, 4).valueOffset;
  const rational = (tag) => {
    const value = entry(tag, 5);
    ensure(value.valueOffset + 8 <= bytes.byteLength, `${filename} has an invalid rational.`);
    return [
      view.getUint32(value.valueOffset, true),
      view.getUint32(value.valueOffset + 4, true),
    ];
  };

  const width = long(256);
  const height = long(257);
  ensure(width === expectedWidth && height === expectedHeight, `${filename} is ${width}x${height}.`);
  ensure(short(258) === 1, `${filename} BitsPerSample is not 1.`);
  ensure(short(259) === 1, `${filename} Compression is not 1 (uncompressed).`);
  ensure(short(262) === 0, `${filename} Photometric is not WhiteIsZero.`);
  ensure(short(274) === 1, `${filename} Orientation is not top-left (1).`);
  ensure(short(277) === 1, `${filename} SamplesPerPixel is not 1.`);
  ensure(long(278) === height, `${filename} is not stored as one full-height strip.`);
  ensure(short(296) === 2, `${filename} ResolutionUnit is not inch.`);
  sameArray(rational(282), [1200, 1], `${filename} XResolution is not 1200/1`);
  sameArray(rational(283), [1200, 1], `${filename} YResolution is not 1200/1`);

  const stripOffset = long(273);
  const stripByteCount = long(279);
  const rowBytes = Math.ceil(width / 8);
  ensure(
    stripByteCount === rowBytes * height && stripOffset + stripByteCount <= bytes.byteLength,
    `${filename} has an invalid packed strip.`,
  );
  const usedBits = width & 7;
  const validLastByteMask = usedBits === 0 ? 0xff : (0xff << (8 - usedBits)) & 0xff;
  const paddingMask = 0xff ^ validLastByteMask;
  let blackPixels = 0;
  for (let y = 0; y < height; y += 1) {
    const rowOffset = stripOffset + y * rowBytes;
    for (let byteIndex = 0; byteIndex < rowBytes; byteIndex += 1) {
      const mask = byteIndex === rowBytes - 1 ? validLastByteMask : 0xff;
      blackPixels += popcount[bytes[rowOffset + byteIndex] & mask];
    }
    ensure(
      (bytes[rowOffset + rowBytes - 1] & paddingMask) === 0,
      `${filename} has nonzero row-padding bits.`,
    );
  }
  const whitePixels = width * height - blackPixels;
  ensure(blackPixels > 0 && whitePixels > 0, `${filename} lacks black or white valid pixels.`);

  const blackAt = (x, y) => {
    const offset = stripOffset + y * rowBytes + (x >> 3);
    return (bytes[offset] & (0x80 >> (x & 7))) !== 0;
  };
  for (let x = 0; x < width; x += 1) {
    ensure(!blackAt(x, 0), `${filename} has a black top-edge pixel.`);
    ensure(!blackAt(x, height - 1), `${filename} has a black bottom-edge pixel.`);
  }
  for (let y = 0; y < height; y += 1) {
    ensure(!blackAt(0, y), `${filename} has a black left-edge pixel.`);
    ensure(!blackAt(width - 1, y), `${filename} has a black right-edge pixel.`);
  }

  // Each strip byte packs eight bilevel samples; byte values are not grayscale pixels.
  return {
    width,
    height,
    bitsPerSample: 1,
    blackPixels,
    whitePixels,
    rowPaddingBits: usedBits === 0 ? 0 : 8 - usedBits,
  };
}

function validateProductionEtch(svg, suffix, canonicalPaths, expectedWidth) {
  ensure(!/GUIDE/i.test(svg), `Production ${suffix} etch SVG contains guides.`);
  ensure(
    !/FONT_|fontArtwork|microcell|data-slot|data-site|glyph-|POINT_CODE|knockout/i.test(svg),
    `Production ${suffix} etch SVG contains point-code or removed font data.`,
  );
  ensure(!/<text\b|<circle\b/i.test(svg), `Production ${suffix} etch SVG has annotations.`);
  ensure(!/stroke-dasharray/i.test(svg), `Production ${suffix} etch SVG has dashed strokes.`);
  const opening = svg.match(new RegExp(`<g\\b[^>]*\\sid="FTO_ETCH_${suffix}"[^>]*>`))?.[0] ?? "";
  ensure(
    svgAttribute(opening, "stroke-width") === String(expectedWidth),
    `Production ${suffix} etch width is not ${expectedWidth} mm.`,
  );
  const operative = svgElements(svgGroupContents(svg, `FTO_ETCH_${suffix}`), "path");
  ensure(
    operative.length === canonicalPaths.length,
    `Production ${suffix} etch path count is not canonical.`,
  );
  operative.forEach((path, index) => {
    ensure(
      svgAttribute(path, "data-path-index") === String(index) &&
        svgAttribute(path, "data-source") === canonicalPaths[index].source,
      `Production ${suffix} etch path ${index} is out of canonical order.`,
    );
  });
  const isolationCount = operative.filter(
    (path) => svgAttribute(path, "data-source") === "terminal-isolation",
  ).length;
  ensure(isolationCount === 2, `Production ${suffix} etch SVG lacks two isolation paths.`);
  return operative.length;
}

function validatePdf(bytes, filename) {
  ensure(bytes.byteLength > 8, `${filename} is too short to be a PDF.`);
  ensure(
    String.fromCharCode(...bytes.slice(0, 5)) === "%PDF-",
    `${filename} does not have PDF magic.`,
  );
  const trailer = String.fromCharCode(...bytes.slice(Math.max(0, bytes.length - 2048)));
  ensure(trailer.includes("%%EOF"), `${filename} does not have a PDF EOF marker.`);
}

function dxfRecords(dxf) {
  const lines = dxf.trim().split(/\r?\n/);
  ensure(lines.length % 2 === 0, "Manufacturing DXF has an incomplete group pair.");
  return Array.from({ length: lines.length / 2 }, (_, index) => ({
    code: lines[index * 2].trim(),
    value: lines[index * 2 + 1].trim(),
  }));
}

function declaredDxfLayers(records) {
  const layers = [];
  for (let index = 0; index < records.length; index += 1) {
    if (records[index].code !== "0" || records[index].value !== "LAYER") continue;
    for (let next = index + 1; next < records.length && records[next].code !== "0"; next += 1) {
      if (records[next].code === "2") {
        layers.push(records[next].value);
        break;
      }
    }
  }
  return layers;
}

function dxfEntities(records) {
  const sectionStart = records.findIndex(
    (record, index) =>
      record.code === "2" &&
      record.value === "ENTITIES" &&
      records[index - 1]?.code === "0" &&
      records[index - 1]?.value === "SECTION",
  );
  ensure(sectionStart >= 0, "Manufacturing DXF has no ENTITIES section.");
  const entities = [];
  let current = null;
  for (let index = sectionStart + 1; index < records.length; index += 1) {
    const record = records[index];
    if (record.code === "0" && record.value === "ENDSEC") break;
    if (
      record.code === "0" &&
      ["CIRCLE", "LINE", "LWPOLYLINE"].includes(record.value)
    ) {
      if (current) entities.push(current);
      current = { type: record.value, records: [] };
    } else if (current) {
      current.records.push(record);
    }
  }
  if (current) entities.push(current);
  return entities;
}

function dxfEntityLayer(entity) {
  return entity.records.find(({ code }) => code === "8")?.value ?? "";
}

function dxfEntitiesOn(entities, layer) {
  return entities.filter((entity) => dxfEntityLayer(entity) === layer);
}

function dxfEntityValue(entity, code) {
  return entity.records.find((record) => record.code === code)?.value;
}

function dxfCircleId(entity) {
  const comment = entity.records.find(
    ({ code, value }) => code === "999" && value.startsWith("id="),
  )?.value;
  return comment?.slice(3) ?? "";
}

const chromeCandidates = [
  process.env.CHROME_PATH,
  "/Applications/Google Chrome.app/Contents/MacOS/Google Chrome",
  "/Applications/Chromium.app/Contents/MacOS/Chromium",
  "/usr/bin/google-chrome",
  "/usr/bin/chromium",
].filter(Boolean);

let executablePath = "";
for (const candidate of chromeCandidates) {
  try {
    await access(candidate);
    executablePath = candidate;
    break;
  } catch {
    // Try the next common Chrome location.
  }
}
if (!executablePath) {
  throw new Error("Chrome not found. Set CHROME_PATH to run the browser smoke test.");
}

const downloadDirectory = await mkdtemp(join(tmpdir(), "w-dssc-v4-smoke-"));
const runtimeErrors = [];
const browser = await puppeteer.launch({
  executablePath,
  headless: true,
  args: ["--no-sandbox", "--disable-gpu"],
});

try {
  const page = await browser.newPage();
  await page.setViewport({ width: 1440, height: 1000, deviceScaleFactor: 1 });
  page.on("pageerror", (error) => runtimeErrors.push(`page: ${error.message}`));
  page.on("console", (message) => {
    if (message.type() === "error") runtimeErrors.push(`console: ${message.text()}`);
  });

  const client = await page.createCDPSession();
  await client.send("Browser.setDownloadBehavior", {
    behavior: "allow",
    downloadPath: downloadDirectory,
  });
  await client.send("Storage.clearDataForOrigin", {
    origin: new URL(appUrl).origin,
    storageTypes: "local_storage",
  });
  await page.goto(appUrl, { waitUntil: "networkidle2", timeout: 30_000 });
  await page.waitForSelector(".classic-window", { timeout: 30_000 });

  const waitForReady = async () => {
    await page.waitForFunction(
      () =>
        document.querySelector(".title-status")?.textContent?.trim() === "DRC pass" &&
        !document.querySelector(".preview-frame.pending") &&
        document.querySelector(".preview-frame svg") !== null,
      { timeout: 30_000 },
    );
  };
  await waitForReady();

  const clickButton = async (label) => {
    await page.waitForFunction(
      (expected) =>
        [...document.querySelectorAll("button")].some(
          (button) => button.textContent?.trim() === expected && !button.disabled,
        ),
      { timeout: 30_000 },
      label,
    );
    const clicked = await page.evaluate((expected) => {
      const button = [...document.querySelectorAll("button")].find(
        (candidate) => candidate.textContent?.trim() === expected,
      );
      if (!(button instanceof HTMLButtonElement) || button.disabled) return false;
      button.click();
      return true;
    }, label);
    ensure(clicked, `Unable to click exact button label "${label}".`);
  };

  const selectView = async (label, view) => {
    await clickButton(label);
    await page.waitForFunction(
      (expectedLabel, expectedView) => {
        const selected = document.querySelector(".view-toolbar button.selected");
        const svg = document.querySelector(".preview-frame svg");
        return (
          selected?.textContent?.trim() === expectedLabel &&
          svg?.getAttribute("data-view") === expectedView
        );
      },
      { timeout: 30_000 },
      label,
      view,
    );
  };

  const focusNumberField = async (label) => {
    const focused = await page.evaluate((labelText) => {
      const input = [...document.querySelectorAll("label.form-row")]
        .find(
          (row) =>
            row.querySelector(":scope > span")?.textContent?.trim() === labelText,
        )
        ?.querySelector(".number-draft");
      if (!(input instanceof HTMLInputElement)) return false;
      input.focus();
      input.select();
      return document.activeElement === input;
    }, label);
    ensure(focused, `Unable to focus .number-draft for "${label}".`);
  };

  const setNumberField = async (label, value, commit) => {
    await focusNumberField(label);
    await page.keyboard.press("Backspace");
    await page.keyboard.type(value);
    if (commit === "enter") {
      await page.keyboard.press("Enter");
    } else {
      const blurred = await page.evaluate((labelText) => {
        const input = [...document.querySelectorAll("label.form-row")]
          .find(
            (row) =>
              row.querySelector(":scope > span")?.textContent?.trim() === labelText,
          )
          ?.querySelector(".number-draft");
        if (!(input instanceof HTMLInputElement)) return false;
        input.blur();
        return document.activeElement !== input;
      }, label);
      ensure(blurred, `Unable to blur .number-draft for "${label}".`);
    }
  };

  const waitForNumberCommit = async (label, configKey, expected) => {
    await page.waitForFunction(
      (labelText, key, field, value) => {
        const input = [...document.querySelectorAll("label.form-row")]
          .find(
            (row) =>
              row.querySelector(":scope > span")?.textContent?.trim() === labelText,
          )
          ?.querySelector(".number-draft");
        const stored = JSON.parse(localStorage.getItem(key) ?? "null");
        return (
          input instanceof HTMLInputElement &&
          Number(input.value) === value &&
          stored?.[field] === value &&
          document.querySelector(".title-status")?.textContent?.trim() === "DRC pass" &&
          !document.querySelector(".preview-frame.pending")
        );
      },
      { timeout: 30_000 },
      label,
      storageKey,
      configKey,
      expected,
    );
  };

  const initial = await page.evaluate(
    (keys, key, removed) => {
      const textarea = document.querySelector(".point-code-field textarea");
      const tabs = [...document.querySelectorAll(".view-toolbar > button")].map(
        (button) => button.textContent?.trim() ?? "",
      );
      const stored = JSON.parse(localStorage.getItem(key) ?? "null");
      return {
        tabs,
        bodyText: document.body.textContent ?? "",
        stored,
        legacyValues: Object.fromEntries(
          keys.filter((candidate) => candidate !== key).map((candidate) => [
            candidate,
            localStorage.getItem(candidate),
          ]),
        ),
        localStorageKeys: Object.keys(localStorage).sort(),
        sequenceCards: document.querySelectorAll(".sequence-cell").length,
        removedPresent: removed.filter((field) =>
          Object.prototype.hasOwnProperty.call(stored ?? {}, field),
        ),
        textarea:
          textarea instanceof HTMLTextAreaElement
            ? {
                count: document.querySelectorAll(".point-code-field textarea").length,
                rows: textarea.rows,
                fontSizePx: Number.parseFloat(getComputedStyle(textarea).fontSize),
                value: textarea.value,
              }
            : null,
      };
    },
    relevantStorageKeys,
    storageKey,
    removedConfigKeys,
  );
  sameArray(initial.tabs, viewLabels, "Preview tabs are stale");
  ensure(initial.tabs.length === 7, `Expected exactly 7 tabs, received ${initial.tabs.length}.`);
  ensure(!initial.tabs.includes("Font Voronoi"), "Removed Font Voronoi tab is present.");
  ensure(
    !/normalized[\s-]*slot/i.test(initial.bodyText),
    "Removed normalized-slot diagnostics are present.",
  );
  ensure(initial.sequenceCards === 0, "Removed per-cell text allocation cards are present.");
  ensure(
    Object.values(initial.legacyValues).every((value) => value === null),
    `Legacy storage was not cleared: ${JSON.stringify(initial.legacyValues)}.`,
  );
  sameArray(initial.localStorageKeys, [storageKey], "Unexpected localStorage keys after clear");
  sameArray(Object.keys(initial.stored).sort(), configKeys, "Stored v4 config fields are stale");
  sameArray(initial.removedPresent, [], "Removed config fields remain in localStorage");
  ensure(
    initial.textarea?.count === 1 &&
      initial.textarea.rows >= 3 &&
      initial.textarea.fontSizePx >= 14 &&
      initial.textarea.value === defaultText,
    `Point Code Text textarea is not usable: ${JSON.stringify(initial.textarea)}.`,
  );

  const draftBaseline = await page.evaluate((key) => ({
    persisted: JSON.parse(localStorage.getItem(key) ?? "null")?.electrodeJitter,
    svg: document.querySelector(".preview-frame svg")?.outerHTML ?? "",
    status: document.querySelector(".title-status")?.textContent?.trim() ?? "",
  }), storageKey);
  ensure(draftBaseline.persisted === 0.34, "Fresh Cell Jitter default is not 0.34.");

  await focusNumberField("Cell Jitter");
  await page.keyboard.press("Backspace");
  await sleep(80);
  const clearedDraft = await page.evaluate((key) => {
    const input = [...document.querySelectorAll("label.form-row")]
      .find(
        (row) =>
          row.querySelector(":scope > span")?.textContent?.trim() === "Cell Jitter",
      )
      ?.querySelector(".number-draft");
    return {
      value: input instanceof HTMLInputElement ? input.value : null,
      persisted: JSON.parse(localStorage.getItem(key) ?? "null")?.electrodeJitter,
      svg: document.querySelector(".preview-frame svg")?.outerHTML ?? "",
      status: document.querySelector(".title-status")?.textContent?.trim() ?? "",
    };
  }, storageKey);
  ensure(
    clearedDraft.value === "" &&
      clearedDraft.persisted === draftBaseline.persisted &&
      clearedDraft.svg === draftBaseline.svg &&
      clearedDraft.status === "DRC pass",
    "Clearing Cell Jitter committed or regenerated the design immediately.",
  );

  await page.keyboard.type(".");
  await sleep(80);
  const decimalDraft = await page.evaluate((key) => {
    const input = [...document.querySelectorAll("label.form-row")]
      .find(
        (row) =>
          row.querySelector(":scope > span")?.textContent?.trim() === "Cell Jitter",
      )
      ?.querySelector(".number-draft");
    return {
      value: input instanceof HTMLInputElement ? input.value : null,
      persisted: JSON.parse(localStorage.getItem(key) ?? "null")?.electrodeJitter,
      svg: document.querySelector(".preview-frame svg")?.outerHTML ?? "",
    };
  }, storageKey);
  ensure(
    decimalDraft.value === "." &&
      decimalDraft.persisted === draftBaseline.persisted &&
      decimalDraft.svg === draftBaseline.svg,
    "Intermediate decimal Cell Jitter draft committed or regenerated immediately.",
  );
  await page.keyboard.type("5");
  await sleep(80);
  const fractionalDraft = await page.evaluate((key) => {
    const input = [...document.querySelectorAll("label.form-row")]
      .find(
        (row) =>
          row.querySelector(":scope > span")?.textContent?.trim() === "Cell Jitter",
      )
      ?.querySelector(".number-draft");
    return {
      value: input instanceof HTMLInputElement ? input.value : null,
      persisted: JSON.parse(localStorage.getItem(key) ?? "null")?.electrodeJitter,
      svg: document.querySelector(".preview-frame svg")?.outerHTML ?? "",
    };
  }, storageKey);
  ensure(
    fractionalDraft.value === ".5" &&
      fractionalDraft.persisted === draftBaseline.persisted &&
      fractionalDraft.svg === draftBaseline.svg,
    "Fractional Cell Jitter draft committed or regenerated immediately.",
  );

  await setNumberField("Cell Jitter", "1.37", "enter");
  await waitForNumberCommit("Cell Jitter", "electrodeJitter", 1.37);
  const arbitraryCommit = await page.evaluate((key) => ({
    value: JSON.parse(localStorage.getItem(key) ?? "null")?.electrodeJitter,
    status: document.querySelector(".title-status")?.textContent?.trim(),
  }), storageKey);

  await setNumberField("Cell Jitter", "2", "blur");
  await waitForNumberCommit("Cell Jitter", "electrodeJitter", 2);
  await page.reload({ waitUntil: "networkidle2", timeout: 30_000 });
  await page.waitForSelector(".classic-window", { timeout: 30_000 });
  await waitForReady();
  await waitForNumberCommit("Cell Jitter", "electrodeJitter", 2);
  const jitterPersistence = await page.evaluate((key) => ({
    value: JSON.parse(localStorage.getItem(key) ?? "null")?.electrodeJitter,
    status: document.querySelector(".title-status")?.textContent?.trim(),
  }), storageKey);
  ensure(
    jitterPersistence.value === 2 && jitterPersistence.status === "DRC pass",
    "Cell Jitter 2 did not persist across reload with a DRC pass.",
  );

  await clickButton("Reset");
  await page.waitForFunction(
    (key, phrase) => {
      const stored = JSON.parse(localStorage.getItem(key) ?? "null");
      return (
        stored?.subcellCount === 16 &&
        stored?.electrodeJitter === 0.34 &&
        stored?.ftoEtchWidthMm === 0.08 &&
        stored?.bindingWidthMm === 3 &&
        stored?.text === phrase &&
        document.querySelector(".title-status")?.textContent?.trim() === "DRC pass" &&
        !document.querySelector(".preview-frame.pending")
      );
    },
    { timeout: 30_000 },
    storageKey,
    defaultText,
  );

  await setNumberField("Electrical Cells", "64", "enter");
  await page.waitForFunction(
    (key) => JSON.parse(localStorage.getItem(key) ?? "null")?.subcellCount === 64,
    { timeout: 30_000 },
    storageKey,
  );
  await setNumberField("Binding Width", "5", "blur");
  await page.waitForFunction(
    (key) => {
      const stored = JSON.parse(localStorage.getItem(key) ?? "null");
      const complete = [...document.querySelectorAll("button")].find(
        (button) => button.textContent?.trim() === "Complete ZIP: PDF + 1-bit TIFF",
      );
      const saveView = [...document.querySelectorAll("button")].find(
        (button) => button.textContent?.trim() === "Save View SVG",
      );
      return (
        stored?.subcellCount === 64 &&
        stored?.bindingWidthMm === 5 &&
        document.querySelector(".title-status")?.textContent?.trim() === "DRC error" &&
        !document.querySelector(".preview-frame.pending") &&
        complete instanceof HTMLButtonElement &&
        complete.disabled &&
        saveView instanceof HTMLButtonElement &&
        saveView.disabled &&
        /Screen cell/.test(document.querySelector(".warning-stack")?.textContent ?? "")
      );
    },
    { timeout: 30_000 },
    storageKey,
  );
  const denseLayoutBlocked = true;

  await clickButton("Reset");
  await page.waitForFunction(
    (key, phrase) => {
      const stored = JSON.parse(localStorage.getItem(key) ?? "null");
      return (
        stored?.subcellCount === 16 &&
        stored?.bindingWidthMm === 3 &&
        stored?.text === phrase &&
        document.querySelector(".title-status")?.textContent?.trim() === "DRC pass" &&
        !document.querySelector(".preview-frame.pending")
      );
    },
    { timeout: 30_000 },
    storageKey,
    defaultText,
  );
  await setNumberField("Electrical Cells", "4", "enter");
  await waitForNumberCommit("Electrical Cells", "subcellCount", 4);

  const setup = await page.evaluate((key) => {
    const valueFor = (labelText) => {
      const input = [...document.querySelectorAll("label.form-row")]
        .find(
          (row) =>
            row.querySelector(":scope > span")?.textContent?.trim() === labelText,
        )
        ?.querySelector(".number-draft");
      return input instanceof HTMLInputElement ? input.value : "";
    };
    const textarea = document.querySelector(".point-code-field textarea");
    return {
      storedConfig: JSON.parse(localStorage.getItem(key) ?? "null"),
      status: document.querySelector(".title-status")?.textContent?.trim(),
      electricalCells: Number(valueFor("Electrical Cells")),
      bindingWidthMm: Number(valueFor("Binding Width")),
      ftoEtchWidthMm: Number(valueFor("FTO Etch Width")),
      text: textarea instanceof HTMLTextAreaElement ? textarea.value : "",
    };
  }, storageKey);
  ensure(setup.status === "DRC pass", `Unexpected DRC state ${String(setup.status)}.`);
  ensure(setup.electricalCells === 4, "Electrical Cells did not commit to 4.");
  ensure(setup.bindingWidthMm === 3, "Binding Width did not reset to 3 mm.");
  ensure(setup.ftoEtchWidthMm === 0.08, "FTO Etch Width did not reset to 0.08 mm.");
  ensure(setup.text === defaultText, "Default Point Code Text was not retained.");
  sameArray(Object.keys(setup.storedConfig).sort(), configKeys, "Stored fixture config is stale");

  const cameraState = async () =>
    page.evaluate(() => ({
      transform: document.querySelector(".preview-camera")?.style.transform ?? "",
      readout: document.querySelector(".zoom-readout output")?.textContent?.trim() ?? "",
      scrollY: window.scrollY,
      wheelPrevented: Boolean(window.__smokeWheelPrevented),
    }));
  const cameraValues = (transform) => {
    const match = transform.match(
      /^translate\(([-+\d.eE]+)px, ([-+\d.eE]+)px\) scale\(([-+\d.eE]+)\)$/,
    );
    ensure(match, `Unexpected preview camera transform "${transform}".`);
    return { x: Number(match[1]), y: Number(match[2]), scale: Number(match[3]) };
  };
  const workspaceCenter = async () =>
    page.evaluate(() => {
      const bounds = document.querySelector(".preview-workspace")?.getBoundingClientRect();
      return bounds
        ? { x: bounds.left + bounds.width / 2, y: bounds.top + bounds.height / 2 }
        : null;
    });

  const cameraInitial = await cameraState();
  ensure(
    cameraInitial.readout === "100%" &&
      cameraInitial.transform === "translate(0px, 0px) scale(1)",
    `Preview camera did not start fitted: ${JSON.stringify(cameraInitial)}.`,
  );
  await page.evaluate(() => {
    document.body.style.minHeight = "calc(100vh + 240px)";
    window.scrollTo(0, 120);
    window.__smokeWheelPrevented = false;
    document.querySelector(".preview-workspace")?.addEventListener(
      "wheel",
      (event) => {
        window.__smokeWheelPrevented = event.defaultPrevented;
      },
      { once: true },
    );
  });
  await page.waitForFunction(() => window.scrollY > 0, { timeout: 10_000 });
  const scrollBeforeWheel = await page.evaluate(() => window.scrollY);
  const wheelCenter = await workspaceCenter();
  ensure(wheelCenter, "Preview workspace bounds are unavailable for wheel testing.");
  await page.mouse.move(wheelCenter.x, wheelCenter.y);
  await page.mouse.wheel({ deltaY: -240 });
  await page.waitForFunction(
    () => Number.parseInt(document.querySelector(".zoom-readout output")?.textContent ?? "0", 10) > 100,
    { timeout: 10_000 },
  );
  const cameraZoomed = await cameraState();
  const zoomValues = cameraValues(cameraZoomed.transform);
  ensure(
    zoomValues.scale > 1 &&
      Number.parseInt(cameraZoomed.readout, 10) > 100 &&
      cameraZoomed.transform !== cameraInitial.transform &&
      cameraZoomed.wheelPrevented &&
      cameraZoomed.scrollY === scrollBeforeWheel,
    `Wheel zoom did not increase scale without page scrolling: ${JSON.stringify(cameraZoomed)}.`,
  );
  await page.evaluate(() => {
    document.body.style.minHeight = "";
    window.scrollTo(0, 0);
  });

  const panStart = cameraValues(cameraZoomed.transform);
  const panCenter = await workspaceCenter();
  ensure(panCenter, "Preview workspace bounds are unavailable for pan testing.");
  await page.mouse.move(panCenter.x - 40, panCenter.y - 20);
  await page.mouse.down({ button: "left" });
  await page.mouse.move(panCenter.x + 45, panCenter.y + 35, { steps: 5 });
  await page.mouse.up({ button: "left" });
  await page.waitForFunction(
    (previous) => document.querySelector(".preview-camera")?.style.transform !== previous,
    { timeout: 10_000 },
    cameraZoomed.transform,
  );
  const cameraPanned = await cameraState();
  const panValues = cameraValues(cameraPanned.transform);
  ensure(
    panValues.x !== panStart.x || panValues.y !== panStart.y,
    `Left pointer drag did not translate the camera: ${JSON.stringify(cameraPanned)}.`,
  );

  await clickButton("Fit");
  await page.waitForFunction(
    () =>
      document.querySelector(".zoom-readout output")?.textContent?.trim() === "100%" &&
      document.querySelector(".preview-camera")?.style.transform ===
        "translate(0px, 0px) scale(1)",
    { timeout: 10_000 },
  );
  const cameraFit = await cameraState();
  const secondCenter = await workspaceCenter();
  ensure(secondCenter, "Preview workspace bounds are unavailable for tab reset testing.");
  await page.mouse.move(secondCenter.x, secondCenter.y);
  await page.mouse.wheel({ deltaY: -180 });
  await page.waitForFunction(
    () => Number.parseInt(document.querySelector(".zoom-readout output")?.textContent ?? "0", 10) > 100,
    { timeout: 10_000 },
  );
  await selectView("Circuit", "circuit");
  await page.waitForFunction(
    () =>
      document.querySelector(".zoom-readout output")?.textContent?.trim() === "100%" &&
      document.querySelector(".preview-camera")?.style.transform ===
        "translate(0px, 0px) scale(1)",
    { timeout: 10_000 },
  );
  const cameraTabReset = await cameraState();

  const numericSummary = {
    drafts: [clearedDraft.value, decimalDraft.value, fractionalDraft.value],
    enterCommit: arbitraryCommit.value,
    persistedJitter: jitterPersistence.value,
    denseLayoutBlocked,
    fixtureCells: setup.electricalCells,
  };

  await selectView("Final Assembly", "assembly");
  const assembly = await page.evaluate(() => {
    const svg = document.querySelector('.preview-frame svg[data-view="assembly"]');
    if (!(svg instanceof SVGSVGElement)) return null;
    const cells = [
      ...svg.querySelectorAll("#ASSEMBLY_CIRCUIT_MATERIAL_CELLS > path"),
    ];
    const source = svg.outerHTML;
    return {
      cells: cells.length,
      indexes: cells.map((path) => path.getAttribute("data-subcell-index")),
      materials: cells.map((path) => path.getAttribute("data-material")),
      fills: [...new Set(cells.map((path) => path.getAttribute("fill")))],
      text: svg.querySelectorAll("text").length,
      circles: svg.querySelectorAll("circle").length,
      strokes: svg.querySelectorAll("[stroke-width]").length,
      forbidden:
        /POINT_CODE|ELECTRON_(?:PATH|ROUTE)|GUIDES_NON_PRINTING|FTO_ETCH|BINDING_MASK|FONT_|fontArtwork|glyph|microcell/i.test(
          source,
        ),
      colors: [...new Set(
        source.match(/#(?:[0-9a-f]{8}|[0-9a-f]{6}|[0-9a-f]{4}|[0-9a-f]{3})(?![0-9a-f])/gi) ??
          [],
      )].sort(),
    };
  });
  ensure(assembly, "Final Assembly SVG was not found.");
  ensure(assembly.cells === 4, `Final Assembly has ${assembly.cells} material cells.`);
  sameArray(assembly.indexes, ["0", "1", "2", "3"], "Final Assembly cell indexes are wrong");
  sameArray(assembly.materials, ["tio2", "pt", "tio2", "pt"], "Final Assembly material parity is wrong");
  ensure(assembly.fills.length === 2, `Final Assembly has ${assembly.fills.length} material fills.`);
  ensure(
    !assembly.forbidden &&
      assembly.text === 0 &&
      assembly.circles === 0 &&
      assembly.strokes === 0,
    "Final Assembly contains point, route, guide, removed font, annotation, or stroke data.",
  );
  ensureGrayscale(assembly.colors, "Final Assembly SVG");

  await selectView("Circuit", "circuit");
  const circuit = await page.evaluate(() => {
    const svg = document.querySelector('.preview-frame svg[data-view="circuit"]');
    if (!(svg instanceof SVGSVGElement)) return null;
    const plate = (suffix) => {
      const panel = svg.querySelector(`#CIRCUIT_PLATE_${suffix}`);
      const cells = [...svg.querySelectorAll(`#CIRCUIT_${suffix}_MATERIAL_CELLS > path`)];
      const labels = [...svg.querySelectorAll(`#CIRCUIT_${suffix}_ORDER_LABELS > text`)];
      const route = svg.querySelector(`#ELECTRON_ROUTE_${suffix}`);
      const outline = panel?.querySelector(`#CIRCUIT_${suffix}_PLATE_OUTLINE`);
      return {
        present: panel instanceof SVGGElement,
        mirrored: panel?.getAttribute("data-mirrored"),
        outline: outline
          ? {
              x: Number(outline.getAttribute("x")),
              y: Number(outline.getAttribute("y")),
              width: Number(outline.getAttribute("width")),
              height: Number(outline.getAttribute("height")),
            }
          : null,
        cellOrders: cells.map((path) => path.getAttribute("data-electron-order")),
        cellIndexes: cells.map((path) => path.getAttribute("data-subcell-index")),
        materials: cells.map((path) => path.getAttribute("data-material")),
        labels: labels.map((label) => label.textContent?.trim()),
        routeStroke: route?.getAttribute("stroke-width"),
        routePaths: route?.querySelectorAll(":scope > path").length ?? 0,
        routeFill: route?.getAttribute("fill"),
      };
    };
    const contacts = [...svg.querySelectorAll("#CIRCUIT_6066_CONTACT_STRIPS > rect")];
    const source = svg.outerHTML;
    const strokeWidths = [...svg.querySelectorAll("[stroke-width]")].map((element) =>
      Number(element.getAttribute("stroke-width")),
    );
    return {
      width: svg.getAttribute("width"),
      height: svg.getAttribute("height"),
      viewBox: svg.getAttribute("viewBox"),
      plate6066: plate("6066"),
      plate6060: plate("6060"),
      contactRects: contacts.map((rect) => ({
        x: Number(rect.getAttribute("x")),
        y: Number(rect.getAttribute("y")),
        width: Number(rect.getAttribute("width")),
        height: Number(rect.getAttribute("height")),
      })),
      contactHeights: contacts.map((rect) => Number(rect.getAttribute("height"))),
      contactPolarities: contacts.map((rect) => rect.getAttribute("data-polarity")),
      strokeWidths,
      dashed: /stroke-dasharray/i.test(source),
      circles: svg.querySelectorAll("circle").length,
      forbidden:
        /FONT_|fontArtwork|font-voronoi|microcell|glyph|POINT_CODE|data-slot|data-site/i.test(
          source,
        ),
    };
  });
  ensure(circuit, "Circuit SVG was not found.");
  ensure(
    circuit.width === "134mm" && circuit.height === "60mm" && circuit.viewBox === "0 0 134 60",
    `Circuit root is not the default 134 x 60 mm: ${JSON.stringify(circuit)}.`,
  );
  for (const [suffix, plate] of [
    ["6066", circuit.plate6066],
    ["6060", circuit.plate6060],
  ]) {
    ensure(plate.present, `CIRCUIT_PLATE_${suffix} is missing.`);
    sameArray(plate.cellIndexes, ["0", "1", "2", "3"], `Circuit ${suffix} cell order is wrong`);
    sameArray(plate.cellOrders, ["1", "2", "3", "4"], `Circuit ${suffix} electron order is wrong`);
    sameArray(plate.labels, ["1", "2", "3", "4"], `Circuit ${suffix} labels are wrong`);
    sameArray(
      plate.materials,
      suffix === "6066" ? ["tio2", "pt", "tio2", "pt"] : ["pt", "tio2", "pt", "tio2"],
      `Circuit ${suffix} material parity is wrong`,
    );
    ensure(
      plate.routeStroke === "0.1" && plate.routePaths === 1 && plate.routeFill === "none",
      `ELECTRON_ROUTE_${suffix} is not one solid 0.1 mm path.`,
    );
  }
  ensure(
    isDeepStrictEqual(circuit.plate6066.outline, { x: 0, y: 0, width: 66, height: 60 }) &&
      isDeepStrictEqual(circuit.plate6060.outline, { x: 74, y: 0, width: 60, height: 60 }) &&
      circuit.plate6060.mirrored === "true",
    `Circuit plate sizing or 6060 mirror is incorrect: ${JSON.stringify(circuit)}.`,
  );
  sameArray(circuit.contactPolarities, ["negative", "positive"], "6066 contact order is wrong");
  ensure(
    circuit.contactHeights.length === 2 &&
      circuit.contactHeights.every((height) => height === 60) &&
      circuit.contactRects.every(({ y, width }) => y === 0 && width > 0),
    "Circuit does not contain two full-height 60 mm 6066 contact strips.",
  );
  ensure(
    circuit.strokeWidths.filter((width) => width === 0.1).length === 2 &&
      circuit.strokeWidths
        .filter((width) => width !== 0.1)
        .every((width) => Number.isFinite(width) && width <= 0.06) &&
      !circuit.dashed &&
      circuit.circles === 0 &&
      !circuit.forbidden,
    "Circuit drafting strokes, route solidity, or removed point/font data are incorrect.",
  );

  const setPointCodeText = async (value) => {
    const focused = await page.evaluate(() => {
      const textarea = document.querySelector(".point-code-field textarea");
      if (!(textarea instanceof HTMLTextAreaElement)) return false;
      textarea.focus();
      textarea.select();
      return document.activeElement === textarea;
    });
    ensure(focused, "Unable to focus Point Code Text textarea.");
    await page.keyboard.type(value);
    await page.waitForFunction(
      (key, expected) => {
        const textarea = document.querySelector(".point-code-field textarea");
        const stored = JSON.parse(localStorage.getItem(key) ?? "null");
        return (
          textarea instanceof HTMLTextAreaElement &&
          textarea.value === expected &&
          stored?.text === expected &&
          document.querySelector(".title-status")?.textContent?.trim() === "DRC pass" &&
          !document.querySelector(".preview-frame.pending")
        );
      },
      { timeout: 30_000 },
      storageKey,
      value,
    );
  };

  const inspectScreen = async (label, view, suffix) => {
    await selectView(label, view);
    return page.evaluate(
      (expectedView, expectedSuffix) => {
        const svg = document.querySelector(`.preview-frame svg[data-view="${expectedView}"]`);
        if (!(svg instanceof SVGSVGElement)) return null;
        const pageRect = svg.querySelector(":scope > #SCREEN_PAGE_WHITE");
        const regionsGroup = svg.querySelector(
          `:scope > #SCREEN_${expectedSuffix}_TIO2_REGIONS`,
        );
        const knockoutGroup = svg.querySelector(":scope > #SCREEN_POINT_CODE_KNOCKOUTS");
        const paths = regionsGroup
          ? [...regionsGroup.querySelectorAll(":scope > path")]
          : [];
        const circles = knockoutGroup
          ? [...knockoutGroup.querySelectorAll(":scope > circle")]
          : [];
        const inheritedAttribute = (element, name) => {
          for (let current = element; current && current !== svg; current = current.parentElement) {
            const value = current.getAttribute(name);
            if (value !== null) return value;
          }
          return null;
        };
        const source = svg.outerHTML;
        return {
          mirrored: svg.getAttribute("data-mirrored"),
          graphicalChildren: [...svg.children]
            .filter((child) => !["title", "metadata"].includes(child.localName))
            .map((child) => `${child.localName}#${child.id}`),
          pageFill: pageRect?.getAttribute("fill"),
          regionFill: regionsGroup?.getAttribute("fill"),
          knockoutFill: knockoutGroup?.getAttribute("fill"),
          regionIds: paths.map((path) => path.getAttribute("data-region-id")),
          regionIndexes: paths.map((path) => path.getAttribute("data-subcell-index")),
          regionMaterials: paths.map((path) => path.getAttribute("data-material")),
          regionDs: paths.map((path) => path.getAttribute("d") ?? ""),
          regionEffectiveFills: paths.map((path) => inheritedAttribute(path, "fill")),
          regionChildrenOnly:
            regionsGroup !== null &&
            [...regionsGroup.children].every((child) => child.localName === "path"),
          circles: circles.map((circle) => ({
            id: circle.getAttribute("id"),
            regionId: circle.getAttribute("data-region-id"),
            subcellIndex: circle.getAttribute("data-subcell-index"),
            slotIndex: circle.getAttribute("data-slot-index"),
            siteIndex: circle.getAttribute("data-site-index"),
            cx: circle.getAttribute("cx"),
            cy: circle.getAttribute("cy"),
            r: circle.getAttribute("r"),
            fill: inheritedAttribute(circle, "fill"),
          })),
          circleChildrenOnly:
            knockoutGroup !== null &&
            [...knockoutGroup.children].every((child) => child.localName === "circle"),
          textCount: svg.querySelectorAll("text").length,
          hasStroke: /\sstroke(?:-[\w-]+)?=/i.test(source),
          removedData: /FONT_|fontArtwork|font-voronoi|glyph|microcell/i.test(source),
          colors: [...new Set(
            source.match(/#(?:[0-9a-f]{8}|[0-9a-f]{6}|[0-9a-f]{4}|[0-9a-f]{3})(?![0-9a-f])/gi) ??
              [],
          )]
            .map((color) => color.toLowerCase())
            .sort(),
        };
      },
      view,
      suffix,
    );
  };

  const validateScreen = (screen, suffix, indexes, mirrored) => {
    ensure(screen, `Screen ${suffix} SVG was not found.`);
    sameArray(
      screen.graphicalChildren,
      [
        "rect#SCREEN_PAGE_WHITE",
        `g#SCREEN_${suffix}_TIO2_REGIONS`,
        "g#SCREEN_POINT_CODE_KNOCKOUTS",
      ],
      `Screen ${suffix} has extra graphical operations`,
    );
    sameArray(screen.regionIndexes, indexes.map(String), `Screen ${suffix} TiO2 parity is wrong`);
    sameArray(
      screen.regionIds,
      indexes.map((index) => `screen-${suffix}-cell-${index}`),
      `Screen ${suffix} region IDs are wrong`,
    );
    ensure(
      screen.pageFill === "#ffffff" &&
        screen.regionFill === "#000000" &&
        screen.knockoutFill === "#ffffff" &&
        screen.regionMaterials.every((material) => material === "tio2") &&
        screen.regionEffectiveFills.every((fill) => fill === "#000000") &&
        screen.regionChildrenOnly &&
        screen.circleChildrenOnly &&
        screen.mirrored === String(mirrored),
      `Screen ${suffix} does not contain clean top-level TiO2 masks and point knockouts.`,
    );
    const circleIds = screen.circles.map(({ id }) => id);
    ensure(
      screen.circles.length > 0 &&
        new Set(circleIds).size === circleIds.length &&
        screen.circles.every(
          ({ id, regionId, subcellIndex, r, fill }) =>
            id === regionId &&
            /^cell-\d+-slot-\d+-site-\d+$/.test(id ?? "") &&
            indexes.includes(Number(subcellIndex)) &&
            r === "0.03" &&
            fill === "#ffffff",
        ),
      `Screen ${suffix} point knockout IDs, parity, radius, fill, or uniqueness are wrong.`,
    );
    ensure(
      screen.textCount === 0 &&
        !screen.hasStroke &&
        !screen.removedData,
      `Screen ${suffix} contains text, strokes, or removed glyph/microcell data.`,
    );
    sameArray(screen.colors, ["#000000", "#ffffff"], `Screen ${suffix} is not binary black/white`);
  };

  const screen6066 = await inspectScreen("Screen 6066", "glass-6066", "6066");
  const screen6060 = await inspectScreen("Screen 6060", "glass-6060", "6060");
  validateScreen(screen6066, "6066", [0, 2], false);
  validateScreen(screen6060, "6060", [1, 3], true);

  await setPointCodeText(replacementText);
  const replacement6066 = await inspectScreen("Screen 6066", "glass-6066", "6066");
  const replacement6060 = await inspectScreen("Screen 6060", "glass-6060", "6060");
  for (const [suffix, baseline, replacement] of [
    ["6066", screen6066, replacement6066],
    ["6060", screen6060, replacement6060],
  ]) {
    sameArray(replacement.regionDs, baseline.regionDs, `Screen ${suffix} regions changed with text`);
    ensure(
      !isDeepStrictEqual(replacement.circles, baseline.circles),
      `Screen ${suffix} point circles did not change with text.`,
    );
  }

  await setPointCodeText(spacesText);
  const spaces6066 = await inspectScreen("Screen 6066", "glass-6066", "6066");
  const spaces6060 = await inspectScreen("Screen 6060", "glass-6060", "6060");
  for (const [suffix, baseline, spaces] of [
    ["6066", screen6066, spaces6066],
    ["6060", screen6060, spaces6060],
  ]) {
    sameArray(spaces.regionDs, baseline.regionDs, `Screen ${suffix} regions changed for spaces`);
    ensure(spaces.circles.length === 0, `Screen ${suffix} has point circles for all-space text.`);
  }

  await setPointCodeText(defaultText);
  const restored6066 = await inspectScreen("Screen 6066", "glass-6066", "6066");
  const restored6060 = await inspectScreen("Screen 6060", "glass-6060", "6060");
  ensure(
    isDeepStrictEqual(restored6066.circles, screen6066.circles) &&
      isDeepStrictEqual(restored6060.circles, screen6060.circles),
    "Restoring Point Code Text did not restore deterministic point circles.",
  );

  const inspectEtch = async (label, view, suffix) => {
    await selectView(label, view);
    return page.evaluate(
      (expectedView, expectedSuffix) => {
        const svg = document.querySelector(`.preview-frame svg[data-view="${expectedView}"]`);
        if (!(svg instanceof SVGSVGElement)) return null;
        const operativeGroup = svg.querySelector(`#FTO_ETCH_${expectedSuffix}`);
        const operative = operativeGroup
          ? [...operativeGroup.querySelectorAll(":scope > path")]
          : [];
        const guides = svg.querySelector("#GUIDES_NON_PRINTING");
        const inheritedAttribute = (element, name) => {
          for (let current = element; current && current !== guides?.parentElement; current = current.parentElement) {
            const value = current.getAttribute(name);
            if (value !== null) return value;
          }
          return null;
        };
        const guideStrokes = guides
          ? [...guides.querySelectorAll("path, rect, line, polyline, polygon")]
              .map((element) => ({
                stroke: inheritedAttribute(element, "stroke"),
                width: inheritedAttribute(element, "stroke-width"),
              }))
              .filter(({ stroke }) => stroke && stroke !== "none")
          : [];
        const connectivity = svg.querySelector(
          `#ETCH_${expectedSuffix}_TERMINAL_CONNECTIVITY_GUIDE`,
        );
        const strips = connectivity
          ? [...connectivity.querySelectorAll(':scope > rect[data-region-id$="strip-guide"]')]
          : [];
        const source = svg.outerHTML;
        return {
          operativeWidth: operativeGroup?.getAttribute("stroke-width"),
          paths: operative.map((path) => ({
            index: path.getAttribute("data-path-index"),
            source: path.getAttribute("data-source"),
            plate: path.getAttribute("data-plate"),
            boundaryIndex: path.getAttribute("data-boundary-index"),
            cells: path.getAttribute("data-cells"),
            perimeterIndex: path.getAttribute("data-perimeter-index"),
            pieceIndex: path.getAttribute("data-piece-index"),
            isolationIndex: path.getAttribute("data-isolation-index"),
            d: path.getAttribute("d"),
          })),
          guidePresent: guides !== null,
          guideStrokes,
          dashed: /stroke-dasharray/i.test(source),
          circles: svg.querySelectorAll("circle").length,
          removedData:
            /FONT_|fontArtwork|font-voronoi|glyph|microcell|POINT_CODE|knockout|data-slot|data-site/i.test(
              source,
            ),
          stripHeights: strips.map((rect) => Number(rect.getAttribute("height"))),
          stripWidths: strips.map((rect) => Number(rect.getAttribute("width"))),
          corridors:
            connectivity?.querySelectorAll(':scope > path[data-region-id$="corridor-guide"]')
              .length ?? 0,
          gates:
            connectivity?.querySelectorAll(':scope > path[data-region-id$="gate-guide"]')
              .length ?? 0,
          terminalConnectivity:
            svg.querySelector(
              '[id*="TERMINAL_CONNECTIVITY"], [data-region-id$="strip-guide"], [data-region-id$="corridor-guide"], [data-region-id$="gate-guide"]',
            ) !== null,
        };
      },
      view,
      suffix,
    );
  };

  const etch6066 = await inspectEtch("Etch 6066", "etch-6066", "6066");
  const etch6060 = await inspectEtch("Etch 6060", "etch-6060", "6060");
  for (const [suffix, plate, etch] of [
    ["6066", "glass-6066", etch6066],
    ["6060", "glass-6060", etch6060],
  ]) {
    ensure(etch, `Etch ${suffix} SVG was not found.`);
    sameArray(
      etch.paths.map(({ index }) => index),
      etch.paths.map((_, index) => String(index)),
      `Etch ${suffix} path indexes are not canonical`,
    );
    ensure(
      etch.paths.length > 0 &&
        etch.paths.every(
          (path) =>
            path.plate === plate &&
            ["electrode-voronoi", "active-perimeter", "terminal-isolation"].includes(
              path.source,
            ),
        ) &&
        etch.paths.filter(({ source }) => source === "terminal-isolation").length === 2 &&
        etch.operativeWidth === "0.08",
      `Etch ${suffix} operative paths or default width are incorrect.`,
    );
    ensure(
      etch.guidePresent &&
        etch.guideStrokes.length > 0 &&
        etch.guideStrokes.every(({ width }) => width === "0.06") &&
        !etch.dashed &&
        etch.circles === 0 &&
        !etch.removedData,
      `Etch ${suffix} guides are not solid 0.06 mm or contain point/font data.`,
    );
  }
  ensure(
    etch6066.stripHeights.length === 2 &&
      etch6066.stripHeights.every((height) => height === 60) &&
      etch6066.stripWidths.every((width) => width > 0) &&
      etch6066.corridors === 2 &&
      etch6066.gates === 2,
    "Etch 6066 does not have two full-height strips plus two corridor and two gate guides.",
  );
  ensure(
    !etch6060.terminalConnectivity,
    "Etch 6060 unexpectedly contains 6066 terminal connectivity guides.",
  );

  await selectView("Binding", "binding");
  const binding = await page.evaluate(() => {
    const svg = document.querySelector('.preview-frame svg[data-view="binding"]');
    if (!(svg instanceof SVGSVGElement)) return null;
    const mask = svg.querySelector("#BINDING_MASK");
    const ring = mask?.querySelector(':scope > path[data-region-id="binding-outer-ring"]');
    const boundaries = mask
      ? [...mask.querySelectorAll('path[data-region-id^="binding-intercell-"]')]
      : [];
    const boundaryGroup = boundaries[0]?.parentElement;
    return {
      ring: ring !== null,
      ringFillRule: ring?.getAttribute("fill-rule"),
      boundaries: boundaries.length,
      boundaryIds: boundaries.map((path) => path.getAttribute("data-region-id")),
      boundaryIndexes: boundaries.map((path) => Number(path.getAttribute("data-boundary-index"))),
      boundaryCells: boundaries.map((path) => path.getAttribute("data-cells")),
      strokeWidth: boundaryGroup?.getAttribute("stroke-width"),
      dashed: /stroke-dasharray/i.test(svg.outerHTML),
      forbidden:
        /GUIDE|ELECTRON|FONT_|fontArtwork|glyph|microcell|POINT_CODE|TERMINAL/i.test(
          svg.outerHTML,
        ) ||
        svg.querySelectorAll("text, circle").length > 0,
    };
  });
  ensure(binding, "Binding SVG was not found.");
  ensure(binding.ring && binding.ringFillRule === "evenodd", "BINDING_MASK lacks its outer ring.");
  ensure(binding.boundaries > 0, "BINDING_MASK has no inter-cell shared boundaries.");
  sameArray(
    binding.boundaryIndexes,
    Array.from({ length: binding.boundaries }, (_, index) => index),
    "Binding boundary indexes are incomplete",
  );
  ensure(
    binding.boundaryIds.every((id, index) => id === `binding-intercell-${index}`) &&
      binding.boundaryCells.every((cells) => /^\d+,\d+$/.test(cells ?? "")),
    "Binding paths do not identify every inter-cell shared boundary.",
  );
  ensure(
    binding.strokeWidth === "3" && !binding.dashed && !binding.forbidden,
    "Binding contains forbidden references or does not use the UI's 3 mm width.",
  );

  await clickButton("Complete ZIP: PDF + 1-bit TIFF");
  await page.waitForFunction(
    () =>
      document.querySelector(".export-progress") !== null ||
      document.querySelector(".error-well") !== null,
    { timeout: 30_000 },
  );
  await page.waitForFunction(
    () =>
      document.querySelector(".export-progress") === null ||
      document.querySelector(".error-well") !== null,
    { timeout: 240_000 },
  );
  const exportError = await page.evaluate(
    () => document.querySelector(".error-well")?.textContent?.trim() ?? "",
  );
  ensure(!exportError, `Browser export failed: ${exportError}`);

  let zipPath = "";
  const downloadDeadline = Date.now() + 30_000;
  while (Date.now() < downloadDeadline) {
    const filenames = await readdir(downloadDirectory);
    const zipName = filenames.find((name) => name.endsWith(".zip"));
    const partial = filenames.some((name) => name.endsWith(".crdownload"));
    if (zipName && !partial) {
      zipPath = join(downloadDirectory, zipName);
      break;
    }
    await sleep(100);
  }
  ensure(zipPath, "The complete fabrication ZIP was not downloaded.");

  const files = unzipSync(new Uint8Array(await readFile(zipPath)));
  const bundlePaths = Object.keys(files).sort();
  ensure(bundlePaths.length === 24, `Expected 24 bundle files, received ${bundlePaths.length}.`);
  sameArray(bundlePaths, expectedBundlePaths, "Complete bundle paths are stale or incomplete");
  const layeredPaths = bundlePaths.filter((path) => path.startsWith("svg-layered/"));
  const productionPaths = bundlePaths.filter((path) => path.startsWith("svg-production/"));
  const pdfPaths = bundlePaths.filter((path) => path.endsWith(".pdf"));
  const bundledTiffPaths = bundlePaths.filter((path) => path.endsWith(".tif"));
  ensure(
    layeredPaths.length === 7 &&
      productionPaths.length === 5 &&
      pdfPaths.length === 6 &&
      bundledTiffPaths.length === 2,
    "Complete bundle category counts are not 7 layered, 5 production, 6 PDF, and 2 TIFF.",
  );
  ensure(
    !bundlePaths.some((path) => /font-voronoi|dye[12]|glyph|background/i.test(path)),
    "Complete bundle retains a removed operation filename.",
  );

  const designText = strFromU8(files["design.json"]);
  const project = JSON.parse(designText);
  ensure(project.format === "w-series-dssc-project-v4", "design.json is not project v4.");
  sameArray(
    Object.keys(project).sort(),
    ["config", "description", "format", "geometry", "pointCodeArtwork", "units"].sort(),
    "design.json top-level fields are stale",
  );
  ensure(
    /terminal-isolation/.test(project.description ?? ""),
    "design.json does not describe terminal isolation.",
  );
  ensure(
    project.config.subcellCount === 4 &&
      project.config.text === defaultText &&
      project.config.bindingWidthMm === 3 &&
      project.config.electrodeJitter === 0.34 &&
      project.config.ftoEtchWidthMm === 0.08 &&
      project.pointCodeArtwork.slotCount === 20 &&
      project.pointCodeArtwork.placements.length === 20 &&
      project.pointCodeArtwork.codeEmMm > 0,
    "design.json does not contain the tested v4 four-cell point-code design.",
  );
  sameArray(
    Object.keys(project.pointCodeArtwork).sort(),
    pointCodeKeys,
    "pointCodeArtwork fields are stale",
  );
  sameArray(
    project.pointCodeArtwork.slotsPerSubcell,
    [5, 5, 5, 5],
    "design.json slotsPerSubcell is incorrect",
  );
  ensure(
    project.pointCodeArtwork.normalizedText === defaultText &&
      project.pointCodeArtwork.spaceCount === 2,
    "design.json point-code text metadata is incorrect.",
  );
  project.pointCodeArtwork.placements.forEach((placement, index) => {
    sameArray(
      Object.keys(placement).sort(),
      placementKeys,
      `Point-code placement ${index} fields are stale`,
    );
    ensure(
      placement.slotIndex === index &&
        Number.isInteger(placement.slotIndexInSubcell) &&
        Number.isInteger(placement.subcellIndex) &&
        typeof placement.character === "string" &&
        Array.isArray(placement.sites) &&
        placement.sites.every(
          (site) => Number.isFinite(site?.x) && Number.isFinite(site?.y),
        ),
      `Point-code placement ${index} is malformed.`,
    );
  });
  ensure(
    !Object.prototype.hasOwnProperty.call(project, "fontArtwork") &&
      !/fontArtwork|slotPolygon|fontMarginMm|fontEdgeWidthMm|fontSiteRadiusMm|glyph|microcell/i.test(
        designText,
      ),
    "design.json retains removed font or slot-polygon artwork.",
  );
  for (const staleField of [...removedConfigKeys, "surlynOuter", "surlynInner"]) {
    ensure(!designText.includes(`"${staleField}"`), `design.json retains stale field ${staleField}.`);
  }
  const projectGeometry = validateProjectGeometry(project);
  ensure(
    binding.boundaries === project.geometry.boundaries.length,
    "Binding preview omitted an exported inter-cell shared boundary.",
  );
  for (const [plate, etch] of [
    ["glass-6066", etch6066],
    ["glass-6060", etch6060],
  ]) {
    sameArray(
      etch.paths.map(({ source }) => source),
      project.geometry.etchPaths[plate].map(({ source }) => source),
      `${plate} preview sources differ from canonical geometry.etchPaths`,
    );
  }
  const expectedScreenPoints = (parity) =>
    project.pointCodeArtwork.placements
      .filter(
        (placement) =>
          placement.character !== " " && placement.subcellIndex % 2 === parity,
      )
      .reduce((total, placement) => total + placement.sites.length, 0);
  ensure(
    screen6066.circles.length === expectedScreenPoints(0) &&
      screen6060.circles.length === expectedScreenPoints(1),
    "Screen point-circle counts differ from pointCodeArtwork placements.",
  );

  const galvo = JSON.parse(strFromU8(files["fto-galvo-toolpaths.json"]));
  const galvoCounts = validateGalvo(galvo, project);

  const productionEtchCounts = {};
  for (const [plate, suffix] of [
    ["glass-6066", "6066"],
    ["glass-6060", "6060"],
  ]) {
    const productionEtch = strFromU8(
      files[`svg-production/fto-etch-glass-${suffix}.svg`],
    );
    productionEtchCounts[plate] = validateProductionEtch(
      productionEtch,
      suffix,
      project.geometry.etchPaths[plate],
      0.08,
    );
  }

  for (const [suffix, baseline, indexes] of [
    ["6066", screen6066, [0, 2]],
    ["6060", screen6060, [1, 3]],
  ]) {
    const layered = strFromU8(files[`svg-layered/screen-glass-${suffix}-tio2.svg`]);
    const production = strFromU8(files[`svg-production/screen-glass-${suffix}-tio2.svg`]);
    ensure(production === layered, `Production Screen ${suffix} differs from clean layered SVG.`);
    const regionGroup = svgGroupContents(production, `SCREEN_${suffix}_TIO2_REGIONS`);
    const knockoutGroup = svgGroupContents(production, "SCREEN_POINT_CODE_KNOCKOUTS");
    const regions = svgElements(regionGroup, "path");
    const circles = svgElements(knockoutGroup, "circle");
    sameArray(
      regions.map((path) => svgAttribute(path, "d")),
      baseline.regionDs,
      `Bundled Screen ${suffix} region paths differ from preview`,
    );
    sameArray(
      regions.map((path) => svgAttribute(path, "data-subcell-index")),
      indexes.map(String),
      `Bundled Screen ${suffix} region parity is wrong`,
    );
    ensure(
      regions.every((path) => svgAttribute(path, "data-material") === "tio2") &&
        circles.length === baseline.circles.length &&
        circles.every(
          (circle) =>
            /^cell-\d+-slot-\d+-site-\d+$/.test(svgAttribute(circle, "id")) &&
            svgAttribute(circle, "id") === svgAttribute(circle, "data-region-id") &&
            svgAttribute(circle, "r") === "0.03",
        ) &&
        new Set(circles.map((circle) => svgAttribute(circle, "id"))).size ===
          circles.length,
      `Bundled Screen ${suffix} regions or point circles are incorrect.`,
    );
    ensure(
      !/<text\b|\sstroke(?:-[\w-]+)?=/i.test(production) &&
        !/FONT_|fontArtwork|font-voronoi|glyph|microcell/i.test(production) &&
        production.includes(`data-mirrored="${suffix === "6060" ? "true" : "false"}"`),
      `Bundled Screen ${suffix} contains removed data or has incorrect mirroring.`,
    );
  }

  const dxf = strFromU8(files["manufacturing-layout.dxf"]);
  const dxfRecordList = dxfRecords(dxf);
  const dxfEntityList = dxfEntities(dxfRecordList);
  const expectedDxfLayers = [
    "0",
    "SCREEN_6066_TIO2_REGIONS",
    "SCREEN_6060_TIO2_REGIONS",
    "SCREEN_6066_POINT_KNOCKOUTS",
    "SCREEN_6060_POINT_KNOCKOUTS",
    "FTO_ETCH_6066",
    "FTO_ETCH_6060",
    "CIRCUIT_REFERENCE",
    "BINDING",
  ];
  sameArray(declaredDxfLayers(dxfRecordList), expectedDxfLayers, "DXF layers are stale");
  ensure(
    !/FONT_VORONOI|FONT_SITES|fontArtwork|glyph|microcell/i.test(dxf),
    "DXF contains a removed font layer or entity.",
  );
  for (const [suffix, baseline] of [
    ["6066", screen6066],
    ["6060", screen6060],
  ]) {
    const regions = dxfEntitiesOn(dxfEntityList, `SCREEN_${suffix}_TIO2_REGIONS`);
    const circles = dxfEntitiesOn(dxfEntityList, `SCREEN_${suffix}_POINT_KNOCKOUTS`);
    ensure(
      regions.length === 2 && regions.every(({ type }) => type === "LWPOLYLINE"),
      `DXF Screen ${suffix} does not have two TiO2 region polylines.`,
    );
    ensure(
      circles.length === baseline.circles.length &&
        circles.every(
          (entity) =>
            entity.type === "CIRCLE" &&
            Number(dxfEntityValue(entity, "40")) === 0.03 &&
            /^cell-\d+-slot-\d+-site-\d+$/.test(dxfCircleId(entity)),
        ) &&
        new Set(circles.map(dxfCircleId)).size === circles.length,
      `DXF Screen ${suffix} knockout circles are incorrect.`,
    );
    sameArray(
      circles.map(dxfCircleId),
      baseline.circles.map(({ id }) => id),
      `DXF Screen ${suffix} point IDs differ from the screen SVG`,
    );
  }

  for (const path of pdfPaths) {
    validatePdf(files[path], path);
  }

  const tiffs = [
    parseBilevelTiff(files[tiffPaths[0]], tiffPaths[0], 3118, 2835),
    parseBilevelTiff(files[tiffPaths[1]], tiffPaths[1], 2835, 2835),
  ];

  await page.setViewport({ width: 390, height: 844, deviceScaleFactor: 1 });
  await page.waitForFunction(
    () => {
      const split = document.querySelector(".main-split");
      return split && getComputedStyle(split).flexDirection === "column";
    },
    { timeout: 10_000 },
  );
  const mobile = await page.evaluate(async () => {
    await new Promise((resolve) => requestAnimationFrame(() => requestAnimationFrame(resolve)));
    const split = document.querySelector(".main-split");
    const sidebar = document.querySelector(".sidebar-panel")?.getBoundingClientRect();
    const preview = document.querySelector(".preview-panel")?.getBoundingClientRect();
    return {
      display: split ? getComputedStyle(split).display : "",
      flexDirection: split ? getComputedStyle(split).flexDirection : "",
      viewportWidth: window.innerWidth,
      scrollWidth: Math.max(
        document.documentElement.scrollWidth,
        document.body?.scrollWidth ?? 0,
      ),
      stacked: Boolean(sidebar && preview && preview.top >= sidebar.bottom - 1),
    };
  });
  ensure(
    mobile.display === "flex" &&
      mobile.flexDirection === "column" &&
      mobile.stacked &&
      mobile.scrollWidth <= mobile.viewportWidth,
    `Unexpected 390 px mobile layout: ${JSON.stringify(mobile)}.`,
  );

  ensure(
    runtimeErrors.length === 0,
    `Browser runtime errors: ${[...new Set(runtimeErrors)].join(" | ")}`,
  );

  console.log(
    JSON.stringify({
      camera: {
        zoomPercent: Number.parseInt(cameraZoomed.readout, 10),
        zoomScale: Number(zoomValues.scale.toFixed(3)),
        panDelta: [
          Number((panValues.x - panStart.x).toFixed(1)),
          Number((panValues.y - panStart.y).toFixed(1)),
        ],
        fit: cameraFit.readout,
        tabReset: cameraTabReset.readout,
        wheelPrevented: cameraZoomed.wheelPrevented,
      },
      numeric: numericSummary,
      text: {
        rows: initial.textarea.rows,
        fontSizePx: initial.textarea.fontSizePx,
        characters: defaultText.length,
        mutationChecked: true,
      },
      screens: {
        regions: [screen6066.regionDs.length, screen6060.regionDs.length],
        points: [screen6066.circles.length, screen6060.circles.length],
        mirrored6060: screen6060.mirrored === "true",
        spacesPoints: spaces6066.circles.length + spaces6060.circles.length,
      },
      bundle: {
        files: bundlePaths.length,
        layered: layeredPaths.length,
        production: productionPaths.length,
        pdfs: pdfPaths.length,
        tiffs: tiffs.map(({ width, height, bitsPerSample }) => ({
          width,
          height,
          bitsPerSample,
        })),
      },
      mobile,
    }),
  );
} finally {
  await browser.close();
  await rm(downloadDirectory, { recursive: true, force: true });
}
