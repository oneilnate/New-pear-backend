/**
 * e2e/reset-pod.ts
 *
 * Resets pod_demo_01 to a clean state so the E2E smoke test can be re-run.
 * Calls the backend's dev-only reset endpoint.
 *
 * Usage:
 *   bun run e2e/reset-pod.ts
 *
 * Environment:
 *   API_BASE        Backend base URL (default: https://pear-sandbox.everbetter.com)
 *   POD_ID          Pod to reset       (default: pod_demo_01)
 *   DEV_TOKEN       Optional X-Dev-Token header value (for production-like environments)
 */

const API_BASE = (process.env.API_BASE ?? 'https://pear-sandbox.everbetter.com').replace(/\/$/, '');
const POD_ID   = process.env.POD_ID   ?? 'pod_demo_01';
const DEV_TOKEN = process.env.DEV_TOKEN ?? '';

async function main(): Promise<void> {
  console.log(`\n🔄 Resetting pod: ${POD_ID} on ${API_BASE}`);

  const headers: Record<string, string> = {
    'Content-Type': 'application/json',
  };
  if (DEV_TOKEN) {
    headers['X-Dev-Token'] = DEV_TOKEN;
  }

  let res: Response;
  try {
    res = await fetch(`${API_BASE}/api/dev/reset-pod/${POD_ID}`, {
      method: 'POST',
      headers,
    });
  } catch (err) {
    console.error(`❌ Network error: ${err}`);
    process.exit(1);
  }

  if (!res.ok) {
    const text = await res.text();
    console.error(`❌ HTTP ${res.status}: ${text}`);
    process.exit(1);
  }

  const body = await res.json() as {
    ok: boolean;
    podId: string;
    deletedImages: number;
    deletedEpisodes: number;
  };

  console.log(`✅ Reset complete`);
  console.log(`   Pod        : ${body.podId}`);
  console.log(`   Images del : ${body.deletedImages}`);
  console.log(`   Episodes del: ${body.deletedEpisodes}`);
  console.log();
}

main().catch((err) => {
  console.error('reset-pod failed:', err);
  process.exit(1);
});

