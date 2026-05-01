/**
 * Pipeline orchestrator — F4-E3.
 *
 * Wires Gemini vision+script → ElevenLabs TTS.
 * All operations run inline (no queue, no worker) awaited from POST /complete.
 *
 * State machine:
 *   collecting → ready_to_generate (when captured_count >= target_count, set by image upload auto-trigger)
 *   ready_to_generate → generating (when runPipeline is called)
 *   generating → ready (on success)
 *   generating → failed (on error, with failure_reason stored)
 */
import crypto from 'crypto';
import db from '../db.js';
import { runVisionAndScript } from './gemini.js';
import { synthesizeAudio } from './elevenlabs.js';

// ── Public return type ────────────────────────────────────────────────────────

export interface PipelineResult {
  episodeId: string;
  audioPath: string;
  durationSec: number;
  title: string;
  summary: string;
}

// ── Error sentinel ────────────────────────────────────────────────────────────

/** Thrown when the pod is not yet ready to generate (captured < target). */
export class PodNotReadyError extends Error {
  constructor(captured: number, target: number) {
    super(`POD_NOT_READY: captured=${captured} target=${target}`);
    this.name = 'PodNotReadyError';
  }
}

/**
 * Run the full episode pipeline for a pod.
 *
 * Steps:
 *  1. Load pod + validate captured_count >= target_count
 *  2. Transition pod.status → 'generating'
 *  3. Call Gemini vision+script
 *  4. Synthesize MP3 via ElevenLabs
 *  5. Insert episodes row
 *  6. Transition pod.status → 'ready'
 *  7. Return episode metadata
 *
 * On any pipeline error:
 *  - pod.status = 'failed', pod.failure_reason = error.message
 *  - error re-thrown to the route handler
 *
 * @param podId - The pod to generate an episode for.
 */
export async function runPipeline(podId: string): Promise<PipelineResult> {
  // ── Guard: check both API keys up front ──────────────────────────────────
  const missingKeys: string[] = [];
  if (!process.env.GEMINI_API_KEY) missingKeys.push('GEMINI_API_KEY');
  if (!process.env.ELEVENLABS_API_KEY) missingKeys.push('ELEVENLABS_API_KEY');
  if (missingKeys.length > 0) {
    const msg = `pipeline disabled — missing credentials: ${missingKeys.join(', ')}`;
    console.error(`[pipeline] pod=${podId} 503 — ${msg}`);
    throw Object.assign(new Error(msg), { code: 'MISSING_CREDENTIALS' });
  }

  // ── Step 1: Load pod + validate ───────────────────────────────────────────
  const pod = db.query(`
    SELECT id, status, target_count, captured_count
    FROM pods WHERE id = ?
  `).get(podId) as {
    id: string;
    status: string;
    target_count: number;
    captured_count: number;
  } | undefined | null;

  if (!pod) {
    throw new Error(`[pipeline] pod not found: ${podId}`);
  }

  if (pod.captured_count < pod.target_count) {
    throw new PodNotReadyError(pod.captured_count, pod.target_count);
  }

  // ── Step 2: Transition to 'generating' ───────────────────────────────────
  db.query(`UPDATE pods SET status = 'generating', failure_reason = NULL WHERE id = ?`).run(podId);
  console.info(`[pipeline] pod=${podId} status=generating`);

  try {
    // ── Step 3: Gemini vision+script ────────────────────────────────────────
    console.info(`[pipeline] pod=${podId} calling Gemini vision+script`);
    const geminiResult = await runVisionAndScript(podId);

    // ── Step 4: ElevenLabs TTS ──────────────────────────────────────────────
    const episodeId = `ep_${crypto.randomUUID().replace(/-/g, '').slice(0, 12)}`;
    console.info(`[pipeline] pod=${podId} synthesizing audio episodeId=${episodeId}`);
    const { audioPath, durationSec } = await synthesizeAudio(geminiResult.script, episodeId);

    // ── Step 5: Insert episodes row ─────────────────────────────────────────
    const now = new Date().toISOString();
    db.query(`
      INSERT INTO episodes
        (id, pod_id, title, summary_text, script_text, audio_path, duration_sec, highlights, created_at)
      VALUES
        (?1, ?2, ?3, ?4, ?5, ?6, ?7, ?8, ?9)
    `).run(
      episodeId,
      podId,
      geminiResult.title,
      geminiResult.summary,
      geminiResult.script,
      audioPath,
      Math.round(durationSec),
      JSON.stringify(geminiResult.highlights),
      now
    );
    console.info(`[pipeline] pod=${podId} episodes row inserted episodeId=${episodeId}`);

    // ── Step 6: Transition to 'ready' ───────────────────────────────────────
    db.query(`UPDATE pods SET status = 'ready', ready_at = ? WHERE id = ?`).run(now, podId);
    console.info(`[pipeline] pod=${podId} status=ready`);

    // ── Step 7: Return metadata ─────────────────────────────────────────────
    return {
      episodeId,
      audioPath,
      durationSec: Math.round(durationSec),
      title: geminiResult.title,
      summary: geminiResult.summary,
    };
  } catch (err: unknown) {
    // ── Error: transition to 'failed' ────────────────────────────────────────
    const message = err instanceof Error ? err.message : String(err);
    console.error(`[pipeline] pod=${podId} FAILED: ${message}`);
    db.query(
      `UPDATE pods SET status = 'failed', failure_reason = ? WHERE id = ?`
    ).run(message, podId);
    throw err; // re-throw so the route handler can respond with 500/503
  }
}

