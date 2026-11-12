/**
 * Pure-JS captcha solver — no node-canvas, no WASM.
 *
 * The image is decoded with jpeg-js / pngjs (pure JS, Workers-safe), the same
 * 40x200 RGB layout the original canvas produced is fed to the same tiny MLP
 * (`bitmaps.ts`, unchanged). Runtime is well under 1 ms of CPU.
 */
import jpeg from "jpeg-js";
import { PNG } from "pngjs";
import { Buffer } from "node:buffer";
import { bitmaps } from "./bitmaps";

type Matrix = number[][];
type Vector = number[];

interface DecodedImage {
  data: Uint8ClampedArray | Uint8Array;
  width: number;
  height: number;
}

function decodeDataUri(dataUri: string): DecodedImage {
  const match = /^data:(image\/[a-zA-Z0-9.+-]+);base64,(.*)$/s.exec(dataUri);
  if (!match) throw new Error("Unsupported captcha image data URI");
  const [, mime, b64] = match;

  const binary = atob(b64!);
  const bytes = new Uint8Array(binary.length);
  for (let i = 0; i < binary.length; i++) bytes[i] = binary.charCodeAt(i);

  if (mime === "image/png") {
    const png = PNG.sync.read(Buffer.from(bytes));
    return { data: png.data, width: png.width, height: png.height };
  }
  if (mime === "image/jpeg" || mime === "image/jpg") {
    const raw = jpeg.decode(Buffer.from(bytes), { useTArray: true, formatAsRGBA: true });
    return { data: raw.data, width: raw.width, height: raw.height };
  }
  throw new Error(`Unsupported captcha image type: ${mime}`);
}

function getImageBlocks(pixelData: Uint8ClampedArray | Uint8Array): Matrix[] {
  const saturate: Vector = new Array(pixelData.length / 4);
  for (let i = 0; i < pixelData.length; i += 4) {
    const r = pixelData[i]!, g = pixelData[i + 1]!, b = pixelData[i + 2]!;
    const min = Math.min(r, g, b);
    const max = Math.max(r, g, b);
    saturate[i / 4] = max === 0 ? 0 : Math.round(((max - min) * 255) / max);
  }

  const img: Matrix = Array.from({ length: 40 }, () => Array(200).fill(0));
  for (let i = 0; i < 40; i++) {
    for (let j = 0; j < 200; j++) {
      img[i]![j] = saturate[i * 200 + j] ?? 0;
    }
  }

  const blocks: Matrix[] = new Array(6);
  for (let i = 0; i < 6; i++) {
    const x1 = (i + 1) * 25 + 2;
    const y1 = 7 + 5 * (i % 2) + 1;
    const x2 = (i + 2) * 25 + 1;
    const y2 = 35 - 5 * ((i + 1) % 2);
    blocks[i] = img.slice(y1, y2).map((row) => row.slice(x1, x2));
  }
  return blocks;
}

function binarizeImage(charImg: Matrix): Matrix {
  let avg = 0;
  charImg.forEach((row) => row.forEach((pixel) => (avg += pixel)));
  avg /= charImg.length * (charImg[0] || []).length;
  const bits: Matrix = new Array(charImg.length);
  for (let i = 0; i < charImg.length; i++) {
    bits[i] = new Array((charImg[0] || []).length);
    for (let j = 0; j < (charImg[0] || []).length; j++) {
      bits[i]![j] = (charImg[i]![j] || 0) > avg ? 1 : 0;
    }
  }
  return bits;
}

function flatten(matrix: Matrix): Vector {
  return matrix.flat();
}

function matMul(a: Matrix, b: Matrix): Matrix {
  const x = a.length, z = a[0]?.length ?? 0, y = b[0]?.length ?? 0;
  const product = Array(x).fill(0).map(() => Array(y).fill(0));
  for (let i = 0; i < x; i++) {
    for (let j = 0; j < y; j++) {
      for (let k = 0; k < z; k++) {
        product[i]![j] += (a[i]![k] ?? 0) * (b[k]![j] ?? 0);
      }
    }
  }
  return product;
}

function matAdd(a: Vector, b: Vector): Vector {
  return a.map((val, i) => val + (b[i] ?? 0));
}

function softmax(vec: Vector): Vector {
  const exps = vec.map((x) => Math.exp(x));
  const sumExps = exps.reduce((a, b) => a + b);
  return exps.map((e) => e / sumExps);
}

export function solveCaptcha(base64: string): string {
  const LABEL_TEXT = "ABCDEFGHJKLMNPQRSTUVWXYZ23456789";
  const img = decodeDataUri(base64);

  const charBlocks = getImageBlocks(img.data);

  let result = "";
  for (const block of charBlocks) {
    let inputVector: Matrix = binarizeImage(block);
    inputVector = [flatten(inputVector)];

    const output: Matrix = matMul(inputVector, bitmaps.weights);
    const logits: Vector = matAdd(output[0] ?? [], bitmaps.biases);

    const probabilities = softmax(logits);
    const maxProbIndex = probabilities.indexOf(Math.max(...probabilities));
    result += LABEL_TEXT[maxProbIndex];
  }

  return result;
}
