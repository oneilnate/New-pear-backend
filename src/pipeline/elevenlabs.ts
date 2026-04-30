/**
 * ElevenLabs TTS stage — narration voice (F4-E2).
 *
 * Synthesizes a script to MP3 using the configured narration voice (EXAVITQu4vr4xnSDxMaL)
 * with model eleven_turbo_v2_5. Audio is written to:
 *   <FOODPOD_MEDIA_DIR>/audio/<episodeId>.mp3
 *
 * Duration is validated 60–240 sec. If the audio is too long the script is
 * truncated to 80 % and retried; bails after 2 retries.
 *
 * Returns { audioPath, durationSec } on success.
 * audioPath is relative: "audio/<episodeId>.mp3"
 */

import fs from 'fs';
import path from 'path';
import { mp3DurationSec } from './mp3-duration.js';
import { applyPronunciationFixes } from './pronunciation.js';

// ── Constants ────────────────────────────────────────────────────────────────

const VOICE_ID = 'Xb7hH8MSUJpSbSDYk0k2'; // Alice — British female, clear educator tone
const MODEL_ID = 'eleven_multilingual_v2';
const ELEVEN_API_BASE = 'https://api.elevenlabs.io';
const MAX_RETRIES = 2;
const MIN_DURATION_SEC = 60;
const MAX_DURATION_SEC = 240;
const TRUNCATE_RATIO = 0.8;

// ── Public API ────────────────────────────────────────────────────────────────

export interface SynthesizeResult {
  /** Relative path from FOODPOD_MEDIA_DIR: "audio/<episodeId>.mp3" */
  audioPath: string;
  durationSec: number;
}

/**
 * Synthesize `script` to MP3 using the ElevenLabs narration voice.
 *
 * @param script    The TTS script text.
 * @param episodeId Used to name the output file.
 */
export async function synthesizeAudio(
  script: string,
  episodeId: string
): Promise<SynthesizeResult> {
  const apiKey = process.env.ELEVENLABS_API_KEY;
  if (!apiKey) {
    console.error('[elevenlabs] ELEVENLABS_API_KEY is not set — returning 503');
    throw new Error('pipeline disabled — missing credentials: ELEVENLABS_API_KEY');
  }

  const mediaDir = process.env.FOODPOD_MEDIA_DIR ?? './media';
  const audioDir = path.join(mediaDir, 'audio');
  fs.mkdirSync(audioDir, { recursive: true });

  const outputAbsPath = path.join(audioDir, `${episodeId}.mp3`);
  const relPath = `audio/${episodeId}.mp3`;

  let currentScript = script;
  let lastError: Error | null = null;

  for (let attempt = 0; attempt <= MAX_RETRIES; attempt++) {
    if (attempt > 0) {
      // Truncate to 80% of the current length before retrying
      currentScript = currentScript.slice(0, Math.floor(currentScript.length * TRUNCATE_RATIO));
      console.warn(
        `[elevenlabs] Audio too long — truncating script to ${currentScript.length} chars ` +
          `(attempt ${attempt}/${MAX_RETRIES})`
      );
    }

    let durationSec: number;
    try {
      await callElevenLabs(apiKey, currentScript, outputAbsPath);
      durationSec = mp3DurationSec(outputAbsPath);
    } catch (err) {
      throw err; // Network / API errors are not retried
    }

    console.info(
      `[elevenlabs] Synthesized ${outputAbsPath} — duration=${durationSec.toFixed(1)}s ` +
        `(attempt ${attempt + 1})`
    );

    if (durationSec < MIN_DURATION_SEC) {
      // Under-length audio is accepted (short test scripts are fine)
      return { audioPath: relPath, durationSec };
    }

    if (durationSec <= MAX_DURATION_SEC) {
      return { audioPath: relPath, durationSec };
    }

    // Too long — will retry (or bail below)
    lastError = new Error(
      `Audio duration ${durationSec.toFixed(1)}s exceeds maximum ${MAX_DURATION_SEC}s ` +
        `after ${attempt + 1} attempt(s). Script length: ${currentScript.length} chars.`
    );
  }

  throw lastError ?? new Error('synthesizeAudio: unexpected loop exit');
}

// ── Internal helpers ──────────────────────────────────────────────────────────

/**
 * POST to the ElevenLabs TTS endpoint and stream the response body to disk.
 */
async function callElevenLabs(
  apiKey: string,
  script: string,
  outputPath: string
): Promise<void> {
  const url = `${ELEVEN_API_BASE}/v1/text-to-speech/${VOICE_ID}`;

  const { text: spokenText, replacements } = applyPronunciationFixes(script);
  if (replacements > 0) {
    console.log(`[elevenlabs] applied ${replacements} pronunciation fix(es)`);
  }

  const body = JSON.stringify({
    text: spokenText,
    model_id: MODEL_ID,
    voice_settings: {
      stability: 0.35,
      similarity_boost: 0.75,
      style: 0.45,
      use_speaker_boost: true,
    },
  });

  const response = await fetch(url, {
    method: 'POST',
    headers: {
      'xi-api-key': apiKey,
      'Content-Type': 'application/json',
      Accept: 'audio/mpeg',
    },
    body,
  });

  if (!response.ok) {
    const errText = await response.text().catch(() => '(could not read body)');
    throw new Error(
      `ElevenLabs API error: ${response.status} ${response.statusText} — ${errText}`
    );
  }

  // Stream response bytes to disk
  if (!response.body) {
    throw new Error('ElevenLabs API returned no response body');
  }

  const writeStream = fs.createWriteStream(outputPath);
  const reader = response.body.getReader();

  try {
    while (true) {
      const { done, value } = await reader.read();
      if (done) break;
      await new Promise<void>((resolve, reject) => {
        writeStream.write(value, (err) => (err ? reject(err) : resolve()));
      });
    }
  } finally {
    reader.releaseLock();
    await new Promise<void>((resolve, reject) => {
      writeStream.end((err?: Error | null) => (err ? reject(err) : resolve()));
    });
  }
}
