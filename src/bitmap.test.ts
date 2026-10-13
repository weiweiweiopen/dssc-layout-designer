import { afterEach, describe, expect, it, vi } from "vitest";

import {
  BILEVEL_THRESHOLD,
  DEFAULT_BITMAP_DPI,
  bitmapSpecForSvgAsset,
  encodeBilevelTiff,
  millimetresToPixels,
  packRgbaToBilevel,
  svgAssetToBilevelTiffBlob,
} from "./bitmap";
import type { SvgAsset } from "./svg";

interface IfdEntry {
  type: number;
  count: number;
  valueOffset: number;
  entryOffset: number;
}

interface ParsedTiff {
  bytes: Uint8Array;
  view: DataView;
  entries: Map<number, IfdEntry>;
  nextIfdOffset: number;
}

function parseTiff(bytes: Uint8Array): ParsedTiff {
  const view = new DataView(bytes.buffer, bytes.byteOffset, bytes.byteLength);
  expect(String.fromCharCode(bytes[0], bytes[1])).toBe("II");
  expect(view.getUint16(2, true)).toBe(42);
  const ifdOffset = view.getUint32(4, true);
  const entryCount = view.getUint16(ifdOffset, true);
  const entries = new Map<number, IfdEntry>();
  for (let index = 0; index < entryCount; index += 1) {
    const entryOffset = ifdOffset + 2 + index * 12;
    entries.set(view.getUint16(entryOffset, true), {
      type: view.getUint16(entryOffset + 2, true),
      count: view.getUint32(entryOffset + 4, true),
      valueOffset: view.getUint32(entryOffset + 8, true),
      entryOffset,
    });
  }
  return {
    bytes,
    view,
    entries,
    nextIfdOffset: view.getUint32(ifdOffset + 2 + entryCount * 12, true),
  };
}

function entry(tiff: ParsedTiff, tag: number): IfdEntry {
  const result = tiff.entries.get(tag);
  expect(result, `missing TIFF tag ${tag}`).toBeDefined();
  return result as IfdEntry;
}

function scalar(tiff: ParsedTiff, tag: number): number {
  const tagEntry = entry(tiff, tag);
  expect(tagEntry.count).toBe(1);
  if (tagEntry.type === 3) {
    return tiff.view.getUint16(tagEntry.entryOffset + 8, true);
  }
  expect(tagEntry.type).toBe(4);
  return tagEntry.valueOffset;
}

function rational(tiff: ParsedTiff, tag: number): number {
  const tagEntry = entry(tiff, tag);
  expect(tagEntry.type).toBe(5);
  expect(tagEntry.count).toBe(1);
  const numerator = tiff.view.getUint32(tagEntry.valueOffset, true);
  const denominator = tiff.view.getUint32(tagEntry.valueOffset + 4, true);
  expect(denominator).toBeGreaterThan(0);
  return numerator / denominator;
}

function setPixel(
  rgba: Uint8ClampedArray,
  width: number,
  x: number,
  y: number,
  red: number,
  green: number,
  blue: number,
  alpha = 255,
): void {
  const offset = (y * width + x) * 4;
  rgba.set([red, green, blue, alpha], offset);
}

function whiteRgba(width: number, height: number): Uint8ClampedArray {
  const rgba = new Uint8ClampedArray(width * height * 4);
  for (let offset = 0; offset < rgba.length; offset += 4) {
    rgba.set([255, 255, 255, 255], offset);
  }
  return rgba;
}

function asset(overrides: Partial<SvgAsset> = {}): SvgAsset {
  return {
    id: "test",
    filename: "test.svg",
    title: "Test",
    widthMm: 60,
    heightMm: 60,
    svg: '<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 1 1"/>',
    ...overrides,
  };
}

describe("millimetresToPixels", () => {
  it("exports 1200 DPI and rounds physical dimensions to final pixels", () => {
    expect(DEFAULT_BITMAP_DPI).toBe(1200);
    expect(millimetresToPixels(66)).toBe(3118);
    expect(millimetresToPixels(60)).toBe(2835);
    expect(millimetresToPixels(25.4, 300)).toBe(300);
    expect(bitmapSpecForSvgAsset(asset({ widthMm: 66 }))).toMatchObject({
      width: 3118,
      height: 2835,
      dpi: 1200,
      pixelCount: 3118 * 2835,
    });
  });

  it("rejects invalid physical dimensions and DPI", () => {
    for (const dimension of [0, -1, Number.NaN, Number.POSITIVE_INFINITY]) {
      expect(() => millimetresToPixels(dimension)).toThrow(/finite positive/);
    }
    for (const dpi of [0, -1200, Number.NaN, Number.POSITIVE_INFINITY]) {
      expect(() => millimetresToPixels(60, dpi)).toThrow(/DPI/);
    }
    expect(() => millimetresToPixels(0.000001, 1)).toThrow(
      /positive TIFF-compatible pixel dimension/,
    );
  });
});

describe("packRgbaToBilevel", () => {
  it("thresholds white-composited RGBA into WhiteIsZero MSB-first rows", () => {
    const width = 10;
    const rgba = whiteRgba(width, 2);
    setPixel(rgba, width, 0, 0, 0, 0, 0);
    setPixel(rgba, width, 2, 0, 0, 0, 0);
    setPixel(rgba, width, 9, 0, 0, 0, 0);
    setPixel(rgba, width, 0, 1, 0, 0, 0, 0);
    setPixel(rgba, width, 1, 1, 127, 127, 127);
    setPixel(rgba, width, 2, 1, 128, 128, 128);
    setPixel(rgba, width, 8, 1, 0, 0, 0, 128);

    expect(BILEVEL_THRESHOLD).toBe(128);
    expect([...packRgbaToBilevel(rgba, width, 2)]).toEqual([
      0xa0, 0x40, 0x40, 0x80,
    ]);
  });

  it("validates dimensions, input length, and threshold", () => {
    expect(() => packRgbaToBilevel(new Uint8Array(), 0, 1)).toThrow(
      /positive integers/,
    );
    expect(() => packRgbaToBilevel(new Uint8Array(4), 2, 1)).toThrow(
      /exactly 8 bytes/,
    );
    expect(() =>
      packRgbaToBilevel(new Uint8Array(4), 1, 1, 256),
    ).toThrow(/Threshold/);
  });
});

describe("encodeBilevelTiff", () => {
  it("writes a baseline little-endian one-strip TIFF and clears row padding", () => {
    const source = new Uint8Array([0xa0, 0x7f, 0x40, 0xbf]);
    const tiff = parseTiff(encodeBilevelTiff(source, 10, 2));

    expect([...tiff.entries.keys()]).toEqual([
      256, 257, 258, 259, 262, 273, 274, 277, 278, 279, 282, 283, 296,
    ]);
    expect(scalar(tiff, 256)).toBe(10);
    expect(scalar(tiff, 257)).toBe(2);
    expect(scalar(tiff, 258)).toBe(1);
    expect(scalar(tiff, 259)).toBe(1);
    expect(scalar(tiff, 262)).toBe(0);
    expect(scalar(tiff, 274)).toBe(1);
    expect(scalar(tiff, 277)).toBe(1);
    expect(scalar(tiff, 278)).toBe(2);
    expect(scalar(tiff, 279)).toBe(4);
    expect(scalar(tiff, 296)).toBe(2);
    expect(rational(tiff, 282)).toBe(1200);
    expect(rational(tiff, 283)).toBe(1200);
    expect(tiff.nextIfdOffset).toBe(0);

    const stripOffset = scalar(tiff, 273);
    expect([...tiff.bytes.slice(stripOffset, stripOffset + 4)]).toEqual([
      0xa0, 0x40, 0x40, 0x80,
    ]);
    expect([...source]).toEqual([0xa0, 0x7f, 0x40, 0xbf]);
  });

  it("stores matching fractional X and Y resolution rationals", () => {
    const tiff = parseTiff(
      encodeBilevelTiff(new Uint8Array([0]), 1, 1, 300.5),
    );
    expect(rational(tiff, 282)).toBe(300.5);
    expect(rational(tiff, 283)).toBe(300.5);
  });

  it("rejects invalid dimensions, data length, and DPI", () => {
    expect(() => encodeBilevelTiff(new Uint8Array(), 0, 1)).toThrow(
      /positive integers/,
    );
    expect(() => encodeBilevelTiff(new Uint8Array(), 1, 1)).toThrow(
      /exactly 1 bytes/,
    );
    for (const dpi of [0, -1, Number.NaN, Number.POSITIVE_INFINITY]) {
      expect(() => encodeBilevelTiff(new Uint8Array([0]), 1, 1, dpi)).toThrow(
        /DPI/,
      );
    }
  });
});

describe("svgAssetToBilevelTiffBlob", () => {
  afterEach(() => {
    vi.unstubAllGlobals();
  });

  it("validates dimensions, DPI, and the pixel limit before browser APIs", async () => {
    await expect(
      svgAssetToBilevelTiffBlob(asset({ widthMm: 0 })),
    ).rejects.toThrow(/finite positive/);
    await expect(
      svgAssetToBilevelTiffBlob(asset(), { dpi: 0 }),
    ).rejects.toThrow(/DPI/);
    await expect(
      svgAssetToBilevelTiffBlob(asset(), { maxPixels: 8_000_000 }),
    ).rejects.toThrow(/exceeds the 8000000-pixel limit/);
    await expect(
      svgAssetToBilevelTiffBlob(asset(), { maxPixels: 0 }),
    ).rejects.toThrow(/Maximum pixel count/);
  });

  it("renders at final resolution over white and returns a bilevel TIFF Blob", async () => {
    const width = 9;
    const height = 2;
    const dpi = 100;
    const rgba = whiteRgba(width, height);
    setPixel(rgba, width, 0, 0, 0, 0, 0);
    setPixel(rgba, width, 1, 0, 0, 0, 0, 0);
    setPixel(rgba, width, 2, 0, 127, 127, 127);
    setPixel(rgba, width, 3, 0, 128, 128, 128);
    setPixel(rgba, width, 8, 1, 0, 0, 0);

    const context = {
      fillStyle: "",
      fillRect: vi.fn(),
      drawImage: vi.fn(),
      getImageData: vi.fn(() => ({ data: rgba })),
    };
    const canvas = {
      width: 0,
      height: 0,
      getContext: vi.fn(() => context),
    };
    class FakeImage {
      onload: (() => void) | null = null;
      onerror: (() => void) | null = null;

      set src(_url: string) {
        queueMicrotask(() => this.onload?.());
      }
    }
    const createObjectURL = vi.fn(() => "blob:test-svg");
    const revokeObjectURL = vi.fn();
    vi.stubGlobal("Image", FakeImage);
    vi.stubGlobal("document", {
      createElement: vi.fn(() => canvas),
    });
    vi.stubGlobal("URL", { createObjectURL, revokeObjectURL });

    const blob = await svgAssetToBilevelTiffBlob(
      asset({
        widthMm: (width * 25.4) / dpi,
        heightMm: (height * 25.4) / dpi,
      }),
      { dpi, maxPixels: width * height },
    );

    expect(blob.type).toBe("image/tiff");
    expect(canvas).toMatchObject({ width, height });
    expect(context.fillStyle).toBe("#ffffff");
    expect(context.fillRect).toHaveBeenCalledWith(0, 0, width, height);
    expect(context.drawImage).toHaveBeenCalledWith(
      expect.any(FakeImage),
      0,
      0,
      width,
      height,
    );
    expect(context.getImageData).toHaveBeenCalledWith(0, 0, width, height);
    expect(createObjectURL).toHaveBeenCalledOnce();
    expect(revokeObjectURL).toHaveBeenCalledWith("blob:test-svg");

    const tiff = parseTiff(new Uint8Array(await blob.arrayBuffer()));
    expect(scalar(tiff, 256)).toBe(width);
    expect(scalar(tiff, 257)).toBe(height);
    expect(rational(tiff, 282)).toBe(dpi);
    const stripOffset = scalar(tiff, 273);
    expect([...tiff.bytes.slice(stripOffset)]).toEqual([0xa0, 0, 0, 0x80]);
  });
});
