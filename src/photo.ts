/**
 * Photos a thread can carry (docs/THREADS.md, Photos, 2026-11-07): JPEG or PNG, at most 4096 px a side,
 * upright, and with nothing in the file but the picture and its colour profile. The CLI runs this before a
 * photo leaves the machine and the receiver runs it again on whatever arrives, so a phone that forgot to
 * drop its location still never has it kept. Stripping walks the file's own structure (JPEG segments, PNG
 * chunks) and copies what draws the picture; nothing is decoded or re-encoded here, so it needs no image
 * library and the pixels are the sender's. Anything it does not recognise is refused, never passed on.
 */
import { crc32 } from 'node:zlib';
import { z } from 'zod';
import { SHA256 } from './glb.js';

export const PHOTO_TYPES = ['image/jpeg', 'image/png'] as const;
export type PhotoType = typeof PHOTO_TYPES[number];
/** The longest side a photo may have: senders scale down to it (Robin, 2026-11-07). */
export const PHOTO_MAX_SIDE = 4096;
/** The hard ceiling on POLYCAP_PHOTO_MAX_BYTES, under the hosted receiver's nginx limit of 64 MB a request. */
export const PHOTO_CEILING_BYTES = 60 * 1024 * 1024;
/** What a receiver keeps by default, and what the CLI sends at most. */
export const PHOTO_MAX_BYTES = 20 * 1000 ** 2;
/** Photos in one message. */
export const MAX_PHOTOS = 10;

/** A photo as a message holds it: its id (the sha256 of the stripped file) and what an app needs to lay it out. */
export const photoSchema = z.strictObject({
  sha256: z.string().regex(SHA256, 'a photo is named by its sha256, 64 lowercase hex digits'),
  type: z.enum(PHOTO_TYPES),
  width: z.number().int().min(1).max(PHOTO_MAX_SIDE), height: z.number().int().min(1).max(PHOTO_MAX_SIDE),
  bytes: z.number().int().positive().max(PHOTO_CEILING_BYTES),
});
export type Photo = z.infer<typeof photoSchema>;

export const photoExtension = (type: PhotoType) => type === 'image/png' ? 'png' : 'jpg';

export interface PhotoFacts { type: PhotoType; width: number; height: number }

/**
 * A stripped photo, or why not. `convert` says an image tool would fix it: another format, turned by a
 * tag, or too big (then `facts` says how big). Otherwise the file is damaged or of a kind nothing here should send.
 */
export type Cleaned = { ok: true; photo: Buffer; facts: PhotoFacts } | { ok: false; problem: string; convert: boolean; facts?: PhotoFacts };

/** What the first bytes say a file is; undefined for anything unrecognised. */
export function sniff(data: Uint8Array): 'jpeg' | 'png' | 'heic' | 'webp' | 'gif' | 'tiff' | undefined {
  const b = Buffer.from(data.buffer, data.byteOffset, data.byteLength);
  if (b.length >= 3 && b[0] === 0xff && b[1] === 0xd8 && b[2] === 0xff) return 'jpeg';
  if (b.length >= 8 && b.subarray(0, 8).equals(PNG_SIGNATURE)) return 'png';
  if (b.length >= 12 && b.toString('latin1', 4, 8) === 'ftyp' && /^(heic|heix|hevc|heim|heis|mif1|msf1|avif)$/.test(b.toString('latin1', 8, 12))) return 'heic';
  if (b.length >= 12 && b.toString('latin1', 0, 4) === 'RIFF' && b.toString('latin1', 8, 12) === 'WEBP') return 'webp';
  if (b.length >= 6 && /^GIF8[79]a$/.test(b.toString('latin1', 0, 6))) return 'gif';
  if (b.length >= 4 && (b.toString('latin1', 0, 4) === 'II*\0' || b.toString('latin1', 0, 4) === 'MM\0*')) return 'tiff';
  return undefined;
}

/** Checks a photo and returns it with nothing but the picture and its colour profile; `name` only colours the messages. */
export function cleanPhoto(data: Uint8Array, name = 'the photo'): Cleaned {
  const kind = sniff(data);
  const fail = (problem: string, convert = false, facts?: PhotoFacts): Cleaned => ({ ok: false, problem: `${name}: ${problem}`, convert, ...(facts ? { facts } : {}) });
  if (kind === 'heic') return fail('is HEIC, which the headset and agents cannot read; send it as JPEG (polycap thread reply --photo converts it, or sips -s format jpeg in.heic --out out.jpg)', true);
  if (kind === 'webp' || kind === 'gif' || kind === 'tiff') return fail(`is ${kind.toUpperCase()}; photos are JPEG or PNG`, true);
  if (kind !== 'jpeg' && kind !== 'png') return fail('is not a JPEG or PNG image');
  const buffer = Buffer.from(data.buffer, data.byteOffset, data.byteLength);
  const read = kind === 'jpeg' ? stripJpeg(buffer) : stripPng(buffer);
  if ('problem' in read) return fail(read.problem, read.convert ?? false);
  const { photo, facts, orientation } = read;
  if (orientation !== 1) return fail('is tagged as turned (EXIF orientation), and the headset would draw it on its side; turn the pixels upright before sending (polycap thread reply --photo does)', true, facts);
  if (facts.width > PHOTO_MAX_SIDE || facts.height > PHOTO_MAX_SIDE) return fail(`is ${facts.width}×${facts.height}; photos are at most ${PHOTO_MAX_SIDE} px a side, so scale it down first (polycap thread reply --photo does)`, true, facts);
  return { ok: true, photo, facts };
}

// ---- JPEG

type Read = { photo: Buffer; facts: PhotoFacts; orientation: number } | { problem: string; convert?: boolean };

/** Frames this keeps: baseline, extended and progressive, the kinds every decoder reads. */
const SOF_KEPT = new Set([0xc0, 0xc1, 0xc2]);
/** Every other start of frame: lossless, hierarchical, arithmetic. Readable by few decoders, so converted. */
const SOF_OTHER = new Set([0xc3, 0xc5, 0xc6, 0xc7, 0xc9, 0xca, 0xcb, 0xcd, 0xce, 0xcf]);
/** Tables and markers that draw the picture: Huffman, quantisation, restart interval, arithmetic conditioning, line count, expansion. */
const TABLES = new Set([0xc4, 0xdb, 0xdd, 0xcc, 0xdc, 0xdf]);

function stripJpeg(data: Buffer): Read {
  const parts: Buffer[] = [data.subarray(0, 2)];
  let pos = 2, facts: PhotoFacts | undefined, orientation = 1, scans = 0;
  const cut = { problem: 'is cut short or damaged: it ends before the image does' };
  while (pos < data.length) {
    if (data[pos] !== 0xff) return { problem: 'is damaged: a JPEG segment does not start where one should' };
    while (data[pos] === 0xff) pos++; // fill bytes
    if (pos >= data.length) return cut;
    const marker = data[pos], start = pos - 1;
    pos++;
    if (marker === 0xd9) {
      if (!facts || !scans) return { problem: 'is damaged: it ends before its picture' };
      parts.push(Buffer.from([0xff, 0xd9]));
      // Anything after the end is left behind: a phone's second images (MPF, gain maps) or a trailer.
      return { photo: Buffer.concat(parts), facts, orientation };
    }
    if (marker === 0xd8 || marker === 0x01 || (marker >= 0xd0 && marker <= 0xd7)) return { problem: 'is damaged: a marker is out of place' };
    if (pos + 2 > data.length) return cut;
    const length = data.readUInt16BE(pos);
    const end = pos + length;
    if (length < 2 || end > data.length) return cut;
    const body = data.subarray(pos + 2, end);
    pos = end;
    if (marker >= 0xe0 && marker <= 0xef) {
      // APP segments: keep JFIF (without its thumbnail, which can show what was cropped away), the ICC profile and Adobe's colour transform.
      if (marker === 0xe0 && body.toString('latin1', 0, 5) === 'JFIF\0' && body.length >= 14) parts.push(jfif(body));
      else if (marker === 0xe2 && body.toString('latin1', 0, 12) === 'ICC_PROFILE\0') parts.push(data.subarray(start, end));
      else if (marker === 0xee && body.toString('latin1', 0, 5) === 'Adobe') parts.push(data.subarray(start, end));
      else if (marker === 0xe1 && body.toString('latin1', 0, 6) === 'Exif\0\0') orientation = tiffOrientation(body.subarray(6));
      continue;
    }
    if (marker === 0xfe) continue; // a comment
    if (SOF_OTHER.has(marker)) return { problem: 'is an unusual kind of JPEG (lossless, hierarchical or arithmetic) that few decoders read', convert: true };
    if (SOF_KEPT.has(marker)) {
      if (facts) return { problem: 'is damaged: it has two frames' };
      if (body.length < 6) return cut;
      const precision = body[0], height = body.readUInt16BE(1), width = body.readUInt16BE(3), components = body[5];
      if (precision !== 8) return { problem: `has ${precision}-bit samples, which few decoders read`, convert: true };
      if (!width || !height) return { problem: 'does not say its size in its frame' };
      if (![1, 3, 4].includes(components)) return { problem: `has ${components} colour components` };
      facts = { type: 'image/jpeg', width, height };
      parts.push(data.subarray(start, end));
      continue;
    }
    if (TABLES.has(marker)) { parts.push(data.subarray(start, end)); continue; }
    if (marker === 0xda) {
      if (!facts) return { problem: 'is damaged: its picture comes before its frame' };
      // The entropy-coded data runs to the next marker that is not a stuffed 0xFF00 or a restart.
      let next = pos;
      while (next + 1 < data.length && !(data[next] === 0xff && data[next + 1] !== 0x00 && !(data[next + 1] >= 0xd0 && data[next + 1] <= 0xd7))) next++;
      if (next + 1 >= data.length) return cut;
      parts.push(data.subarray(start, next));
      scans++;
      pos = next;
      continue;
    }
    return { problem: `has a JPEG marker this receiver does not know (0xFF${marker.toString(16).toUpperCase()})` };
  }
  return cut;
}

/** A JFIF segment as it was, but with no thumbnail. */
function jfif(body: Buffer): Buffer {
  const kept = Buffer.from(body.subarray(0, 14));
  kept[12] = 0; kept[13] = 0;
  const head = Buffer.from([0xff, 0xe0, 0, 0]);
  head.writeUInt16BE(kept.length + 2, 2);
  return Buffer.concat([head, kept]);
}

/** The orientation an EXIF (TIFF) block gives its picture, 1 to 8; 1 when it says none or cannot be read. */
export function tiffOrientation(tiff: Buffer): number {
  if (tiff.length < 8) return 1;
  const order = tiff.toString('latin1', 0, 2);
  if (order !== 'II' && order !== 'MM') return 1;
  const u16 = (at: number) => order === 'II' ? tiff.readUInt16LE(at) : tiff.readUInt16BE(at);
  const u32 = (at: number) => order === 'II' ? tiff.readUInt32LE(at) : tiff.readUInt32BE(at);
  if (u16(2) !== 42) return 1;
  const ifd = u32(4);
  if (ifd + 2 > tiff.length) return 1;
  const count = u16(ifd);
  for (let i = 0; i < count; i++) {
    const entry = ifd + 2 + i * 12;
    if (entry + 12 > tiff.length) return 1;
    if (u16(entry) === 0x0112 && u16(entry + 2) === 3) {
      const value = u16(entry + 8);
      return value >= 1 && value <= 8 ? value : 1;
    }
  }
  return 1;
}

// ---- PNG

const PNG_SIGNATURE = Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]);
/** The picture and how to colour it; text, time, EXIF, animation and anything unknown are left behind. */
const PNG_KEPT = new Set(['IHDR', 'PLTE', 'IDAT', 'IEND', 'tRNS', 'gAMA', 'cHRM', 'sRGB', 'iCCP', 'sBIT', 'pHYs']);

function stripPng(data: Buffer): Read {
  const parts: Buffer[] = [PNG_SIGNATURE];
  let pos = 8, facts: PhotoFacts | undefined, orientation = 1, idat = false;
  while (pos + 12 <= data.length) {
    const length = data.readUInt32BE(pos), type = data.toString('latin1', pos + 4, pos + 8), end = pos + 12 + length;
    if (end > data.length) break;
    if (!/^[A-Za-z]{4}$/.test(type)) return { problem: 'is damaged: a PNG chunk has no name' };
    if (crc32(data.subarray(pos + 4, pos + 8 + length)) !== data.readUInt32BE(pos + 8 + length)) return { problem: `is damaged: its ${type} chunk does not match its checksum` };
    const body = data.subarray(pos + 8, pos + 8 + length);
    if (!facts && type !== 'IHDR') return { problem: 'is damaged: its first chunk is not IHDR' };
    if (type === 'IHDR') {
      if (facts || length !== 13) return { problem: 'is damaged: its header chunk is wrong' };
      const width = body.readUInt32BE(0), height = body.readUInt32BE(4);
      if (!width || !height) return { problem: 'does not say its size' };
      facts = { type: 'image/png', width, height };
    }
    if (type === 'IDAT') idat = true;
    if (type === 'eXIf') orientation = tiffOrientation(body);
    if (PNG_KEPT.has(type)) parts.push(data.subarray(pos, end));
    pos = end;
    if (type === 'IEND') {
      if (!idat) return { problem: 'is damaged: it has no picture data' };
      return { photo: Buffer.concat(parts), facts: facts!, orientation };
    }
  }
  return { problem: 'is cut short or damaged: it ends before the image does' };
}
