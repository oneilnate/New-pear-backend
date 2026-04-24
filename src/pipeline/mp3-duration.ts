/**
 * Lightweight MP3 duration estimator.
 *
 * Strategy:
 *  1. Try `ffprobe` (most accurate) — skipped silently if not installed.
 *  2. Parse MPEG frame headers from the first 256 KB of the file (fast, handles
 *     VBR poorly but fine for ElevenLabs CBR output).
 *  3. Fall back to a byte-rate estimate using the CBR bit-rate read from the
 *     first valid frame header (or a conservative 128 kbps default).
 */

import { spawnSync } from 'child_process';
import fs from 'fs';

// MPEG1 bit-rate table (layer III) — kbps indexed by 4-bit header value
const MPEG1_LAYER3_BITRATES: readonly number[] = [
  0, 32, 40, 48, 56, 64, 80, 96, 112, 128, 160, 192, 224, 256, 320, 0,
];

// MPEG1 sample-rate table — Hz indexed by 2-bit header value
const MPEG1_SAMPLE_RATES: readonly number[] = [44100, 48000, 32000, 0];

/** Samples per frame for MPEG1 Layer III */
const SAMPLES_PER_FRAME = 1152;

interface FrameInfo {
  bitrateKbps: number;
  sampleRateHz: number;
  frameBytes: number;
}

/**
 * Attempt to parse one MPEG1 Layer-III frame header at `offset`.
 * Returns null if the bytes at that position don't look like a valid frame.
 */
function parseFrameHeader(buf: Buffer, offset: number): FrameInfo | null {
  if (offset + 4 > buf.length) return null;

  const b0 = buf[offset];
  const b1 = buf[offset + 1];
  const b2 = buf[offset + 2];

  // Sync word: 11 set bits
  if (b0 !== 0xff || (b1 & 0xe0) !== 0xe0) return null;

  // MPEG version: bits 4-3 of b1 — must be MPEG1 (0b11)
  const mpegVersion = (b1 >> 3) & 0x03;
  if (mpegVersion !== 0x03) return null;

  // Layer: bits 2-1 of b1 — must be Layer III (0b01)
  const layer = (b1 >> 1) & 0x03;
  if (layer !== 0x01) return null;

  const bitrateIdx = (b2 >> 4) & 0x0f;
  const sampleRateIdx = (b2 >> 2) & 0x03;

  const bitrateKbps = MPEG1_LAYER3_BITRATES[bitrateIdx];
  const sampleRateHz = MPEG1_SAMPLE_RATES[sampleRateIdx];

  if (bitrateKbps === 0 || sampleRateHz === 0) return null;

  const padding = (b2 >> 1) & 0x01;
  // MPEG1 Layer III frame size formula
  const frameBytes = Math.floor((144 * bitrateKbps * 1000) / sampleRateHz) + padding;

  return { bitrateKbps, sampleRateHz, frameBytes };
}

/**
 * Skip over an ID3v2 tag at the start of the buffer, if present.
 * Returns the byte offset of the first non-ID3 data.
 */
function skipId3(buf: Buffer): number {
  if (buf.length < 10) return 0;
  if (buf[0] !== 0x49 || buf[1] !== 0x44 || buf[2] !== 0x33) return 0; // 'ID3'

  // ID3v2 tag size is a 28-bit synchsafe integer in bytes 6-9
  const size =
    ((buf[6] & 0x7f) << 21) |
    ((buf[7] & 0x7f) << 14) |
    ((buf[8] & 0x7f) << 7) |
    (buf[9] & 0x7f);

  return 10 + size; // 10-byte header + declared payload
}

/** Try ffprobe; returns duration in seconds or null if unavailable/failed. */
function tryFfprobe(filePath: string): number | null {
  try {
    const result = spawnSync(
      'ffprobe',
      [
        '-v', 'error',
        '-show_entries', 'format=duration',
        '-of', 'default=noprint_wrappers=1:nokey=1',
        filePath,
      ],
      { encoding: 'utf8', timeout: 5000 }
    );
    if (result.status !== 0 || !result.stdout) return null;
    const d = parseFloat(result.stdout.trim());
    return isFinite(d) && d > 0 ? d : null;
  } catch {
    return null;
  }
}

/**
 * Estimate MP3 duration from frame headers in the first 256 KB.
 * Returns duration in seconds, or null if no valid frames found.
 */
function estimateFromHeaders(filePath: string): number | null {
  const READ_BYTES = 256 * 1024;
  let fd: number | null = null;
  try {
    fd = fs.openSync(filePath, 'r');
    const stat = fs.fstatSync(fd);
    const totalBytes = stat.size;
    if (totalBytes < 4) return null;

    const toRead = Math.min(READ_BYTES, totalBytes);
    const buf = Buffer.allocUnsafe(toRead);
    fs.readSync(fd, buf, 0, toRead, 0);
    fs.closeSync(fd);
    fd = null;

    let offset = skipId3(buf);
    let frameCount = 0;
    let firstBitrateKbps = 0;
    let firstSampleRateHz = 0;

    // Scan up to 64 frames to compute average
    while (offset < buf.length - 4 && frameCount < 64) {
      const frame = parseFrameHeader(buf, offset);
      if (!frame) {
        offset++;
        continue;
      }
      frameCount++;
      if (frameCount === 1) {
        firstBitrateKbps = frame.bitrateKbps;
        firstSampleRateHz = frame.sampleRateHz;
      }
      offset += frame.frameBytes;
    }

    if (frameCount === 0 || firstSampleRateHz === 0) return null;

    // Use first frame's sample rate + byte-rate for full-file estimate
    const bytesPerSec = (firstBitrateKbps * 1000) / 8;
    return totalBytes / bytesPerSec;
  } catch {
    return null;
  } finally {
    if (fd !== null) {
      try { fs.closeSync(fd); } catch { /* ignore */ }
    }
  }
}

/**
 * Last-resort: assume 128 kbps CBR.
 */
function estimateFromFileSize(filePath: string): number {
  const DEFAULT_BITRATE_KBPS = 128;
  const totalBytes = fs.statSync(filePath).size;
  return totalBytes / ((DEFAULT_BITRATE_KBPS * 1000) / 8);
}

/**
 * Return the duration of an MP3 file in seconds.
 *
 * Tries ffprobe first (most accurate), then frame-header estimation,
 * then a plain byte-rate fallback.
 */
export function mp3DurationSec(filePath: string): number {
  // 1. ffprobe
  const ffprobe = tryFfprobe(filePath);
  if (ffprobe !== null) return ffprobe;

  // 2. Frame-header scan
  const fromHeaders = estimateFromHeaders(filePath);
  if (fromHeaders !== null) return fromHeaders;

  // 3. Byte-rate fallback
  return estimateFromFileSize(filePath);
}
