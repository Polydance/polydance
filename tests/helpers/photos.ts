/**
 * Photos for the tests: two tiny real JPEGs (24×16, made once with Pillow on 2026-11-07: a baseline with a
 * restart marker, and a progressive one with ten scans), and builders that add the metadata a phone or
 * camera writes, so stripping can be seen to remove it. PNGs are built here from scratch.
 */
import { crc32, deflateSync } from 'node:zlib';

export const BASELINE_JPEG = Buffer.from('/9j/4AAQSkZJRgABAQAAAQABAAD/2wBDAAYEBQYFBAYGBQYHBwYIChAKCgkJChQODwwQFxQYGBcUFhYaHSUfGhsjHBYWICwgIyYnKSopGR8tMC0oMCUoKSj/2wBDAQcHBwoIChMKChMoGhYaKCgoKCgoKCgoKCgoKCgoKCgoKCgoKCgoKCgoKCgoKCgoKCgoKCgoKCgoKCgoKCgoKCj/wAARCAAQABgDASIAAhEBAxEB/8QAHwAAAQUBAQEBAQEAAAAAAAAAAAECAwQFBgcICQoL/8QAtRAAAgEDAwIEAwUFBAQAAAF9AQIDAAQRBRIhMUEGE1FhByJxFDKBkaEII0KxwRVS0fAkM2JyggkKFhcYGRolJicoKSo0NTY3ODk6Q0RFRkdISUpTVFVWV1hZWmNkZWZnaGlqc3R1dnd4eXqDhIWGh4iJipKTlJWWl5iZmqKjpKWmp6ipqrKztLW2t7i5usLDxMXGx8jJytLT1NXW19jZ2uHi4+Tl5ufo6erx8vP09fb3+Pn6/8QAHwEAAwEBAQEBAQEBAQAAAAAAAAECAwQFBgcICQoL/8QAtREAAgECBAQDBAcFBAQAAQJ3AAECAxEEBSExBhJBUQdhcRMiMoEIFEKRobHBCSMzUvAVYnLRChYkNOEl8RcYGRomJygpKjU2Nzg5OkNERUZHSElKU1RVVldYWVpjZGVmZ2hpanN0dXZ3eHl6goOEhYaHiImKkpOUlZaXmJmaoqOkpaanqKmqsrO0tba3uLm6wsPExcbHyMnK0tPU1dbX2Nna4uPk5ebn6Onq8vP09fb3+Pn6/90ABAAB/9oADAMBAAIRAxEAPwDx+x8P9Pk/SugsvD/T5P0rvrHw/wBPk/SugsfD/T5P0r0MTnXmeRkvEO2p/9DnrHw/0+T9KK9fsfD/AE+T9KK5amde9ufcYPiH92tT/9k=', 'base64');
export const PROGRESSIVE_JPEG = Buffer.from('/9j/4AAQSkZJRgABAQAAAQABAAD/2wBDAAYEBQYFBAYGBQYHBwYIChAKCgkJChQODwwQFxQYGBcUFhYaHSUfGhsjHBYWICwgIyYnKSopGR8tMC0oMCUoKSj/2wBDAQcHBwoIChMKChMoGhYaKCgoKCgoKCgoKCgoKCgoKCgoKCgoKCgoKCgoKCgoKCgoKCgoKCgoKCgoKCgoKCgoKCj/wgARCAAQABgDASIAAhEBAxEB/8QAFgABAQEAAAAAAAAAAAAAAAAABQYA/8QAFQEBAQAAAAAAAAAAAAAAAAAABAb/2gAMAwEAAhADEAAAAY9B9BA5/WGFUf/EABYQAAMAAAAAAAAAAAAAAAAAAAACBP/aAAgBAQABBQJJxJxJxJxJxJz/xAAYEQACAwAAAAAAAAAAAAAAAAAABQMEIv/aAAgBAwEBPwGkwIWGT//EABgRAAIDAAAAAAAAAAAAAAAAAAAEAgMh/9oACAECAQE/AbHSTun/xAAUEAEAAAAAAAAAAAAAAAAAAAAg/9oACAEBAAY/Al//xAAVEAEBAAAAAAAAAAAAAAAAAAAAYf/aAAgBAQABPyGSCSSST//aAAwDAQACAAMAAAAQBw//xAAWEQEBAQAAAAAAAAAAAAAAAAAhADH/2gAIAQMBAT8QxYTf/8QAFhEBAQEAAAAAAAAAAAAAAAAAAFFh/9oACAECAQE/ENlD/8QAFhAAAwAAAAAAAAAAAAAAAAAAADHB/9oACAEBAAE/EESKkRIiREiJP//Z', 'base64');

/** One JPEG segment: marker and body, with its length. */
export function segment(marker: number, body: Buffer | string): Buffer {
  const data = typeof body === 'string' ? Buffer.from(body, 'latin1') : body;
  const head = Buffer.from([0xff, marker, 0, 0]);
  head.writeUInt16BE(data.length + 2, 2);
  return Buffer.concat([head, data]);
}

/**
 * An EXIF block as a camera writes one: IFD0 with the orientation, the make ("SecretCam") and a GPS IFD
 * whose latitude reference is a marker string, so a test can look for either in what is kept.
 */
export function exifBody(orientation = 1, order: 'II' | 'MM' = 'II'): Buffer {
  const le = order === 'II';
  const tiff = Buffer.alloc(120);
  const u16 = (v: number, at: number) => le ? tiff.writeUInt16LE(v, at) : tiff.writeUInt16BE(v, at);
  const u32 = (v: number, at: number) => le ? tiff.writeUInt32LE(v, at) : tiff.writeUInt32BE(v, at);
  tiff.write(order, 0, 'latin1'); u16(42, 2); u32(8, 4);
  u16(3, 8);
  // Make (ASCII, 10 bytes at 80), Orientation (SHORT), GPSInfo (LONG, the GPS IFD at 50).
  u16(0x010f, 10); u16(2, 12); u32(10, 14); u32(80, 18);
  u16(0x0112, 22); u16(3, 24); u32(1, 26); u16(orientation, 30);
  u16(0x8825, 34); u16(4, 36); u32(1, 38); u32(50, 42);
  u32(0, 46);
  u16(1, 50); u16(0x0001, 52); u16(2, 54); u32(16, 56); u32(96, 60); u32(0, 64);
  tiff.write('SecretCam\0', 80, 'latin1');
  tiff.write('GPS-51.5074N-x\0\0', 96, 'latin1');
  return Buffer.concat([Buffer.from('Exif\0\0', 'latin1'), tiff]);
}

/** A JFIF APP0 with a 2×1 thumbnail of the bytes "THUMB!", which can show what a crop took away. */
export const JFIF_WITH_THUMBNAIL = segment(0xe0, Buffer.concat([Buffer.from('JFIF\0\x01\x02\x00\x00\x01\x00\x01\x02\x01', 'latin1'), Buffer.from('THUMB!', 'latin1')]));

/** The JPEG with these segments after its start, and `trailer` after its end. */
export function withSegments(jpeg: Buffer, segments: Buffer[], trailer: Buffer = Buffer.alloc(0)): Buffer {
  return Buffer.concat([jpeg.subarray(0, 2), ...segments, jpeg.subarray(2), trailer]);
}

/** Everything a phone or camera might leave in a JPEG, around a real picture. */
export function phoneJpeg(orientation = 1, base: Buffer = BASELINE_JPEG): Buffer {
  return withSegments(base, [
    segment(0xe1, exifBody(orientation)),
    segment(0xe1, 'http://ns.adobe.com/xap/1.0/\0<x:xmpmeta>XMP-SECRET</x:xmpmeta>'),
    segment(0xe2, 'ICC_PROFILE\0\x01\x01fake-profile-bytes'),
    segment(0xe2, 'MPF\0MPF-SECRET'),
    segment(0xed, 'Photoshop 3.0\0IPTC-SECRET'),
    segment(0xfe, 'COMMENT-SECRET'),
  ], Buffer.from('\xff\xd8GAINMAP-SECRET\xff\xd9', 'latin1'));
}

/** A PNG chunk with its CRC. */
export function chunk(type: string, data: Buffer | string = Buffer.alloc(0)): Buffer {
  const body = typeof data === 'string' ? Buffer.from(data, 'latin1') : data;
  const head = Buffer.alloc(8);
  head.writeUInt32BE(body.length, 0); head.write(type, 4, 'latin1');
  const crc = Buffer.alloc(4);
  crc.writeUInt32BE(crc32(Buffer.concat([head.subarray(4), body])), 0);
  return Buffer.concat([head, body, crc]);
}

/** An RGB PNG of a gradient, with `extra` chunks before its data. */
export function makePng(width: number, height: number, extra: Buffer[] = []): Buffer {
  const ihdr = Buffer.alloc(13);
  ihdr.writeUInt32BE(width, 0); ihdr.writeUInt32BE(height, 4); ihdr[8] = 8; ihdr[9] = 2;
  const rows = Buffer.alloc((width * 3 + 1) * height);
  for (let y = 0; y < height; y++) for (let x = 0; x < width; x++) {
    const at = y * (width * 3 + 1) + 1 + x * 3;
    rows[at] = x % 256; rows[at + 1] = y % 256; rows[at + 2] = 128;
  }
  return Buffer.concat([Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]), chunk('IHDR', ihdr), ...extra, chunk('IDAT', deflateSync(rows)), chunk('IEND')]);
}

/** An eXIf chunk body: the TIFF block without the "Exif\0\0" a JPEG puts before it. */
export const exifChunk = (orientation: number) => chunk('eXIf', exifBody(orientation).subarray(6));

export const SECRETS = ['SecretCam', 'GPS-51', 'XMP-SECRET', 'MPF-SECRET', 'IPTC-SECRET', 'COMMENT-SECRET', 'GAINMAP-SECRET', 'THUMB!', 'TEXT-SECRET', 'Lavc'];
export const leaks = (data: Buffer) => SECRETS.filter(s => data.includes(Buffer.from(s, 'latin1')));
