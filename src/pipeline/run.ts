/**
 * Pipeline orchestrator stub.
 * Real Gemini + ElevenLabs pipeline wired in F4.
 */
export function runPipeline(podId: string): void {
  console.log(`[pipeline] pod=${podId} — F4 will wire real pipeline here`);
  // F4: call runVisionAndScript(podId) then synthesizeAudio(...)
}

