import type { SvgAsset } from "./svg";

export const DEFAULT_BITMAP_DPI = 1200;
export const DEFAULT_MAX_BITMAP_PIXELS = 40_000_000;
export const BILEVEL_THRESHOLD = 128;

export interface BilevelTiffOptions {
  dpi?: number;
  maxPixels?: number;
}

export interface BitmapSpec {
  width: number;
  height: number;
  pixelCount: number;
  dpi: number;
}

const UINT32_MAX = 0xffffffff;
const TIFF_HEADER_SIZE = 8;
const TIFF_IFD_OFFSET = TIFF_HEADER_SIZE;
const TIFF_ENTRY_COUNT = 13;
const TIFF_IFD_SIZE = 2 + TIFF_ENTRY_COUNT * 12 + 4;
const TIFF_X_RESOLUTION_OFFSET = TIFF_IFD_OFFSET + TIFF_IFD_SIZE;
const TIFF_Y_RESOLUTION_OFFSET = TIFF_X_RESOLUTION_OFFSET + 8;
const TIFF_PIXEL_DATA_OFFSET = TIFF_Y_RESOLUTION_OFFSET + 8;

function assertDpi(dpi: number): void {
  if (!Number.isFinite(dpi) || dpi <= 0 || dpi > UINT32_MAX) {
    throw new RangeError(
      `DPI must be a finite positive number no greater than ${UINT32_MAX}.`,
    );
  }
}

function assertBitmapDimensions(width: number, height: number): void {
  if (
    !Number.isSafeInteger(width) ||
    !Number.isSafeInteger(height) ||
    width <= 0 ||
    height <= 0 ||
    width > UINT32_MAX ||
    height > UINT32_MAX
  ) {
    throw new RangeError(
      "Bitmap width and height must be positive integers representable by TIFF LONG values.",
    );
  }
  if (!Number.isSafeInteger(width * height)) {
    throw new RangeError("Bitmap dimensions contain too many pixels.");
  }
}

export function millimetresToPixels(
  millimetres: number,
  dpi = DEFAULT_BITMAP_DPI,
): number {
  if (!Number.isFinite(millimetres) || millimetres <= 0) {
    throw new RangeError("Millimetres must be a finite positive number.");
  }
  assertDpi(dpi);

  const pixels = Math.round((millimetres * dpi) / 25.4);
  if (!Number.isSafeInteger(pixels) || pixels <= 0 || pixels > UINT32_MAX) {
    throw new RangeError(
      "The physical dimension and DPI do not produce a positive TIFF-compatible pixel dimension.",
    );
  }
  return pixels;
}

export function bitmapSpecForSvgAsset(
  asset: Pick<SvgAsset, "widthMm" | "heightMm">,
  options: BilevelTiffOptions = {},
): BitmapSpec {
  const dpi = options.dpi ?? DEFAULT_BITMAP_DPI;
  const maxPixels = options.maxPixels ?? DEFAULT_MAX_BITMAP_PIXELS;
  assertDpi(dpi);
  if (!Number.isSafeInteger(maxPixels) || maxPixels <= 0) {
    throw new RangeError("Maximum pixel count must be a positive safe integer.");
  }

  const width = millimetresToPixels(asset.widthMm, dpi);
  const height = millimetresToPixels(asset.heightMm, dpi);
  const pixelCount = width * height;
  if (!Number.isSafeInteger(pixelCount) || pixelCount > maxPixels) {
    throw new RangeError(
      `Bitmap size ${width} x ${height} (${pixelCount} pixels) exceeds the ${maxPixels}-pixel limit.`,
    );
  }
  return { width, height, pixelCount, dpi };
}

export function packRgbaToBilevel(
  rgba: Uint8Array | Uint8ClampedArray,
  width: number,
  height: number,
  threshold = BILEVEL_THRESHOLD,
): Uint8Array {
  assertBitmapDimensions(width, height);
  if (!Number.isFinite(threshold) || threshold < 0 || threshold > 255) {
    throw new RangeError("Threshold must be a finite number from 0 to 255.");
  }

  const pixelCount = width * height;
  if (rgba.length !== pixelCount * 4) {
    throw new RangeError(
      `RGBA data length must be exactly ${pixelCount * 4} bytes for a ${width} x ${height} bitmap.`,
    );
  }

  const rowBytes = Math.ceil(width / 8);
  const packed = new Uint8Array(rowBytes * height);
  const thresholdScale = threshold * 255_000;

  for (let y = 0; y < height; y += 1) {
    for (let x = 0; x < width; x += 1) {
      const pixelOffset = (y * width + x) * 4;
      const alpha = rgba[pixelOffset + 3];
      const sourceLuminance =
        299 * rgba[pixelOffset] +
        587 * rgba[pixelOffset + 1] +
        114 * rgba[pixelOffset + 2];
      const whiteCompositedLuminance =
        sourceLuminance * alpha + 255_000 * (255 - alpha);

      if (whiteCompositedLuminance < thresholdScale) {
        const byteOffset = y * rowBytes + (x >> 3);
        packed[byteOffset] |= 0x80 >> (x & 7);
      }
    }
  }

  return packed;
}

function greatestCommonDivisor(left: number, right: number): number {
  while (right !== 0) {
    const remainder = left % right;
    left = right;
    right = remainder;
  }
  return left;
}

function dpiToRational(dpi: number): [number, number] {
  assertDpi(dpi);
  let denominator = 1_000_000;
  let numerator = Math.round(dpi * denominator);
  while (numerator > UINT32_MAX && denominator > 1) {
    denominator /= 10;
    numerator = Math.round(dpi * denominator);
  }
  if (numerator <= 0 || numerator > UINT32_MAX) {
    throw new RangeError("DPI cannot be represented as a TIFF RATIONAL value.");
  }
  const divisor = greatestCommonDivisor(numerator, denominator);
  return [numerator / divisor, denominator / divisor];
}

export function encodeBilevelTiff(
  packedPixels: Uint8Array | Uint8ClampedArray,
  width: number,
  height: number,
  dpi = DEFAULT_BITMAP_DPI,
): Uint8Array {
  assertBitmapDimensions(width, height);
  const [resolutionNumerator, resolutionDenominator] = dpiToRational(dpi);
  const rowBytes = Math.ceil(width / 8);
  const stripByteCount = rowBytes * height;
  if (packedPixels.length !== stripByteCount) {
    throw new RangeError(
      `Packed data length must be exactly ${stripByteCount} bytes for a ${width} x ${height} 1-bit bitmap.`,
    );
  }
  if (
    !Number.isSafeInteger(stripByteCount) ||
    stripByteCount > UINT32_MAX ||
    TIFF_PIXEL_DATA_OFFSET + stripByteCount > UINT32_MAX
  ) {
    throw new RangeError("Packed bitmap is too large for a baseline TIFF strip.");
  }

  const output = new Uint8Array(TIFF_PIXEL_DATA_OFFSET + stripByteCount);
  const view = new DataView(output.buffer);
  output[0] = 0x49;
  output[1] = 0x49;
  view.setUint16(2, 42, true);
  view.setUint32(4, TIFF_IFD_OFFSET, true);
  view.setUint16(TIFF_IFD_OFFSET, TIFF_ENTRY_COUNT, true);

  let entryOffset = TIFF_IFD_OFFSET + 2;
  const writeEntry = (
    tag: number,
    type: number,
    count: number,
    value: number,
  ): void => {
    view.setUint16(entryOffset, tag, true);
    view.setUint16(entryOffset + 2, type, true);
    view.setUint32(entryOffset + 4, count, true);
    if (type === 3 && count === 1) {
      view.setUint16(entryOffset + 8, value, true);
    } else {
      view.setUint32(entryOffset + 8, value, true);
    }
    entryOffset += 12;
  };

  writeEntry(256, 4, 1, width);
  writeEntry(257, 4, 1, height);
  writeEntry(258, 3, 1, 1);
  writeEntry(259, 3, 1, 1);
  writeEntry(262, 3, 1, 0);
  writeEntry(273, 4, 1, TIFF_PIXEL_DATA_OFFSET);
  writeEntry(274, 3, 1, 1);
  writeEntry(277, 3, 1, 1);
  writeEntry(278, 4, 1, height);
  writeEntry(279, 4, 1, stripByteCount);
  writeEntry(282, 5, 1, TIFF_X_RESOLUTION_OFFSET);
  writeEntry(283, 5, 1, TIFF_Y_RESOLUTION_OFFSET);
  writeEntry(296, 3, 1, 2);
  view.setUint32(entryOffset, 0, true);

  view.setUint32(TIFF_X_RESOLUTION_OFFSET, resolutionNumerator, true);
  view.setUint32(
    TIFF_X_RESOLUTION_OFFSET + 4,
    resolutionDenominator,
    true,
  );
  view.setUint32(TIFF_Y_RESOLUTION_OFFSET, resolutionNumerator, true);
  view.setUint32(
    TIFF_Y_RESOLUTION_OFFSET + 4,
    resolutionDenominator,
    true,
  );

  output.set(packedPixels, TIFF_PIXEL_DATA_OFFSET);
  const usedBitsInLastByte = width & 7;
  if (usedBitsInLastByte !== 0) {
    const paddingMask = (0xff << (8 - usedBitsInLastByte)) & 0xff;
    for (let y = 0; y < height; y += 1) {
      const lastByteOffset = TIFF_PIXEL_DATA_OFFSET + (y + 1) * rowBytes - 1;
      output[lastByteOffset] &= paddingMask;
    }
  }

  return output;
}

function loadImage(url: string, filename: string): Promise<HTMLImageElement> {
  return new Promise((resolve, reject) => {
    const image = new Image();
    image.onload = () => {
      image.onload = null;
      image.onerror = null;
      resolve(image);
    };
    image.onerror = () => {
      image.onload = null;
      image.onerror = null;
      reject(new Error(`Unable to load SVG image "${filename}".`));
    };
    image.src = url;
  });
}

export async function svgAssetToBilevelTiffBlob(
  asset: SvgAsset,
  options: BilevelTiffOptions = {},
): Promise<Blob> {
  const spec = bitmapSpecForSvgAsset(asset, options);
  if (
    typeof document === "undefined" ||
    typeof document.createElement !== "function" ||
    typeof Image === "undefined" ||
    typeof Blob === "undefined" ||
    typeof URL === "undefined" ||
    typeof URL.createObjectURL !== "function" ||
    typeof URL.revokeObjectURL !== "function"
  ) {
    throw new Error("SVG to TIFF conversion requires browser image and canvas APIs.");
  }

  const source = new Blob([asset.svg], {
    type: "image/svg+xml;charset=utf-8",
  });
  const sourceUrl = URL.createObjectURL(source);
  try {
    const image = await loadImage(sourceUrl, asset.filename);
    const canvas = document.createElement("canvas");
    canvas.width = spec.width;
    canvas.height = spec.height;
    const context = canvas.getContext("2d", {
      alpha: false,
      willReadFrequently: true,
    });
    if (!context) {
      throw new Error(`Unable to create a canvas context for "${asset.filename}".`);
    }

    context.fillStyle = "#ffffff";
    context.fillRect(0, 0, spec.width, spec.height);
    context.drawImage(image, 0, 0, spec.width, spec.height);
    const rgba = context.getImageData(0, 0, spec.width, spec.height).data;
    const packed = packRgbaToBilevel(
      rgba,
      spec.width,
      spec.height,
      BILEVEL_THRESHOLD,
    );
    const tiff = encodeBilevelTiff(packed, spec.width, spec.height, spec.dpi);
    const tiffBuffer = new ArrayBuffer(tiff.byteLength);
    new Uint8Array(tiffBuffer).set(tiff);
    return new Blob([tiffBuffer], { type: "image/tiff" });
  } finally {
    URL.revokeObjectURL(sourceUrl);
  }
}
