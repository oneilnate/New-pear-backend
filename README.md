# New-pear-backend

**Food Pod Backend** — Bun + Hono + SQLite single-process service.

> This is **Buzz ONeil's** personal build. Paired with [oneilnate/New-pear-Expo](https://github.com/oneilnate/New-pear-Expo).

---

## Overview

Lightweight backend for the Food Pod prototype. One Bun process, no Docker, no Redis, no external DB — just SQLite on disk.

---

## Pipeline Flow (F4-E3)

```
POST /api/pods/:id/complete
        │
        ├─ 503 if GEMINI_API_KEY or ELEVENLABS_API_KEY missing
        ├─ 400 if captured_count < target_count
        │
        └─► runPipeline(podId)
                │
                ├─ Step 1: Load pod from SQLite, validate captured_count >= target_count
                ├─ Step 2: pod.status → 'generating'
                │
                ├─ Step 3: runVisionAndScript(podId)  [Gemini 1.5 Pro]
                │         └─ All meal images attached as inline base64 JPEG parts
                │         └─ Returns { title, summary, script, highlights[] }
                │         └─ suggestSwaps(detectedGaps) enriches script with swap tips
                │
                ├─ Step 4: synthesizeAudio(script, episodeId)  [ElevenLabs Sarah]
                │         └─ Writes MP3 to <FOODPOD_MEDIA_DIR>/audio/<episodeId>.mp3
                │         └─ Duration enforced 60–240 s (retry up to 2x with truncated script)
                │
                ├─ Step 5: INSERT INTO episodes {id, pod_id, title, summary_text, script_text,
                │                               audio_path, duration_sec, highlights, created_at}
                ├─ Step 6: pod.status → 'ready', ready_at = now
                └─ Return { episodeId, audioPath, durationSec, title, summary }

        └► 200 { episodeId, audioUrl, durationSec, title, summary }
```

### State Machine

```
  collecting
      │  (captured_count reaches target)
      ▼
  ready_to_generate   (set by image upload — informational transition)
      │  (POST /complete called)
      ▼
  generating
     │   \
     ▼     ▼
  ready   failed
          (failure_reason set)
```

### Failure Modes

| Scenario | HTTP | pod.status | pod.failure_reason |
|----------|------|------------|--------------------|
| Missing GEMINI_API_KEY or ELEVENLABS_API_KEY | 503 | unchanged | null |
| captured_count < target_count | 400 | unchanged | null |
| Gemini API error (rate limit, quota, etc.) | 500 | `failed` | error message |
| ElevenLabs API error (network, auth, etc.) | 500 | `failed` | error message |
| All images missing from disk | 500 | `failed` | error message |
| Audio > 240 s after 2 retries | 500 | `failed` | error message |

In all failure cases, the pod remains recoverable — POST /complete can be retried once the underlying issue is resolved. The `failureReason` field is returned by `GET /api/pods/:id` when status is `failed`.

- **Runtime:** [Bun](https://bun.sh) 1.x
- **Framework:** [Hono](https://hono.dev)
- **Database:** [bun:sqlite](https://bun.sh/docs/api/sqlite) (Bun's built-in synchronous SQLite — not the `better-sqlite3` npm package; see Stack Note below)
- **Binds:** `127.0.0.1:8787` (nginx reverse proxies from public port)
- **Media:** `/srv/foodpod/media/` on the VM (images + audio MP3s on disk)

---

## Local Development

```bash
# Install dependencies
bun install

# Start dev server with hot reload
bun run dev
# → listening on 127.0.0.1:8787

# Run tests
bun test

# Start production server
bun run start
```

### Environment Variables

| Variable | Default | Description |
|----------|---------|-------------|
| `PORT` | `8787` | Port the server binds to |
| `FOODPOD_DB_PATH` | `<cwd>/foodpod.db` | Path to the SQLite database file |
| `FOODPOD_MEDIA_DIR` | `<cwd>/media` | Root directory for media storage (images + audio). In production set to `/srv/foodpod/media`. Subdirectories `images/` and `audio/` are created automatically. |
| `GEMINI_API_KEY` | _(required for F4 pipeline)_ | Google Gemini 1.5 Pro API key. If unset, `POST /api/pods/:id/complete` returns `503 pipeline disabled`. |
| `ELEVENLABS_API_KEY` | _(required for F4 pipeline)_ | ElevenLabs API key for Sarah voice TTS (F4-E2). If unset, pipeline returns `503`. |
| `ELEVENLABS_VOICE_ID` | _(required for F4 pipeline)_ | ElevenLabs voice ID (Sarah = `EXAVITQu4vr4xnSDxMaL`). |

### Getting a Gemini API Key (F4 pipeline)

1. Go to [Google AI Studio](https://aistudio.google.com/app/apikey) and create a key.
2. Add it to your local `.env`:
   ```bash
   echo 'GEMINI_API_KEY=your-key-here' >> .env
   ```
3. On the VM, update `/etc/foodpod/env` and restart:
   ```bash
   sudo nano /etc/foodpod/env  # add GEMINI_API_KEY=...
   sudo systemctl restart foodpod-backend
   ```

If `GEMINI_API_KEY` is **not** set, the server still starts and all endpoints except `POST /complete` work normally. `POST /complete` returns `503 pipeline disabled — missing credentials`.

Copy `.env.example` to `.env` and fill in any env vars you need locally:

```bash
cp .env.example .env
```

---

## Endpoints

| Method | Path | Description |
|--------|------|-------------|
| GET | `/api/health` | Health check |
| GET | `/api/pods/:id` | Get pod + recent snaps (last 5) + episode |
| POST | `/api/pods/:id/images` | Upload a meal image (multipart/form-data, field `image`) |
| POST | `/api/pods/:id/complete` | Trigger episode generation |
| GET | `/api/pods/:id/episode` | Get generated episode for pod |
| GET | `/media/images/:filename` | Serve uploaded image from disk |
| GET | `/media/audio/:filename` | Serve generated MP3 audio from disk |

### Image Upload

`POST /api/pods/:id/images` accepts `multipart/form-data` with a single field `image` (File).

- **Content-Type** must start with `image/` — returns `415` otherwise.
- **Max size** is 10 MB — returns `413` for larger payloads.
- Successful upload returns `{ imageId, sequenceNumber, capturedCount }`.

```bash
curl -X POST http://127.0.0.1:8787/api/pods/pod_demo_01/images \
  -F image=@/path/to/meal.jpg
```

### Demo data (seeded on first boot)

- `usr_demo_01` — Sarah Chen (`demo@everbetter.com`)
- `pod_demo_01` — Week Pod, target=7, status=collecting

```bash
curl 127.0.0.1:8787/api/health
curl 127.0.0.1:8787/api/pods/pod_demo_01
```

---

## Schema

Four tables: `users`, `pods`, `meal_images`, `episodes`.  
Schema is created automatically on startup via `src/db.ts`.

---

## E2E Smoke Test

The smoke test exercises the full stack: 7 fixture JPEGs → live VM backend → real MP3 validated.
It is the canary that catches drift before a demo.

### Quick Start

```bash
# 1. (Optional) Reset pod to a clean state
bun run e2e:reset

# 2. Run the full smoke test
bun run e2e:smoke
```

Exit 0 = all steps pass (or partial pass when pipeline keys are not yet set)  
Exit 1 = hard failure — investigate the step summary printed to stdout

### Environment Variables

| Variable | Default | Description |
|---|---|---|
| `API_BASE` | `https://pear-sandbox.everbetter.com` | Backend base URL |
| `POD_ID` | `pod_demo_01` | Pod to use for the smoke run |
| `DEV_TOKEN` | _(empty)_ | `X-Dev-Token` header for the reset endpoint (required if `NODE_ENV=production` on the VM) |

### Local dev / staging

```bash
# Target local dev server
API_BASE=http://localhost:8787 bun run e2e:smoke

# Reset against local server
API_BASE=http://localhost:8787 bun run e2e:reset
```

### What the smoke test verifies

| Step | Assertion |
|---|---|
| 1. GET /api/health | `{ok: true}` |
| 2. Load 7 fixtures | 7 JPEGs found in `e2e/fixtures/meals/` |
| 3. POST 7 images | Each returns HTTP 200 + `capturedCount` |
| 4. GET /api/pods/:id | `capturedCount === 7`, status is valid |
| 5. POST /complete | 200 with `{episodeId, audioUrl, durationSec, title, summary}` (503 → partial pass) |
| 6. Download MP3 | Size > 10 KB, valid MP3 header, duration 60–240 s |
| 7. GET /episode | Returns same `episodeId` |

### Regenerating fixtures

```bash
bun run e2e:generate
```

Generates 7 placeholder 640×480 JPEG swatches (Meal 1–7) using `sharp`.  
The generated files are committed to the repo — regeneration is only needed if they are lost.

### Nightly CI

A GitHub Actions workflow (`.github/workflows/nightly-smoke.yml`) runs `bun run e2e:reset` +  
`bun run e2e:smoke` daily at 09:00 UTC against the live VM.  
Results appear in the GitHub Actions workflow summary.

---

## Deploy

> **deploy.sh** will be added in F5 (VM provisioning + systemd setup).

The service runs as a systemd unit on `pear-sandbox.everbetter.com`.  
Secrets are loaded from `/etc/foodpod/env` (EnvironmentFile, 0600):

```
GEMINI_API_KEY=...
ELEVENLABS_API_KEY=...
ELEVENLABS_VOICE_ID=...
```

---

## Swap Library

The nutrient-gap swap library lives in `src/data/`:

| File | Purpose |
|------|---------|
| `src/data/swap-library.json` | 25 curated swap entries (fiber, sugar, protein, sodium, saturated_fat, produce) |
| `src/data/swap-library.ts` | TypeScript helper — `suggestSwaps(gaps)` returns top 3 swaps per gap category |

### Usage

```ts
import { suggestSwaps } from './data/swap-library';

// Returns up to 3 swap suggestions for each supplied gap category
const swaps = suggestSwaps(['fiber', 'protein']);
// → [{ id, category, from, to, why, impact }, ...]
```

Each swap entry has the shape:
```ts
{
  id: string;           // 'swap_01' … 'swap_25'
  category: string;     // 'fiber' | 'sugar' | 'protein' | 'sodium' | 'saturated_fat' | 'produce'
  from: string;         // food being replaced
  to: string;           // recommended swap
  why: string;          // one-line evidence-based reason
  impact: string;       // concrete numeric change (e.g. '+6g fiber per serving')
}
```

To add a new entry: append an object to `swap-library.json` following the same shape; `suggestSwaps` picks it up automatically.

---

## Project Structure

```
src/
  server.ts          — Hono app, binds 127.0.0.1:8787
  db.ts              — better-sqlite3 connection + schema
  seed.ts            — idempotent seed (usr_demo_01, pod_demo_01)
  routes/
    health.ts        — GET /api/health
    pods.ts          — Pod endpoints
    meals.ts         — POST /api/pods/:id/images + GET /media/images/:filename
  data/
    swap-library.json — 25 nutrient-gap swap entries (F2-E3)
    swap-library.ts  — suggestSwaps() helper + SwapEntry type
  pipeline/
    gemini.ts        — Gemini 1.5 Pro vision+script stage (F4-E1)
    elevenlabs.ts    — ElevenLabs Sarah TTS stage (F4-E2)
    mp3-duration.ts  — MP3 duration parser
    run.ts           — Pipeline orchestrator + state machine (F4-E3)
  data/
    swap-library.json — 25 nutrient-gap swap entries (F2-E3)
    swap-library.ts  — suggestSwaps() helper + SwapEntry type
tests/
  server.test.ts       — Vitest tests for all endpoints
  swap-library.test.ts — 12 tests for swap data + suggestSwaps()
  gemini.test.ts       — Unit + integration tests for Gemini stage
  elevenlabs.test.ts   — Unit + integration tests for ElevenLabs stage
  pipeline.test.ts     — Unit + integration tests for pipeline orchestrator (F4-E3)
  routes.test.ts       — Route-level tests for /complete, /episode, /media/audio (F4-E3)
.github/workflows/
  ci.yml             — bun install + bun test on every PR
```

---

## Initiative

Part of the **Food Pod — Standalone Expo + VM Backend** initiative.  
Companion frontend: [oneilnate/New-pear-Expo](https://github.com/oneilnate/New-pear-Expo)

Built by **Buzz ONeil** @ EverBetter.

---

## Stack Note

`bun:sqlite` is used instead of the `better-sqlite3` npm package. The
`better-sqlite3` npm package ships a Node.js native addon (`.node` binary)
which Bun does not load ([bun#4290](https://github.com/oven-sh/bun/issues/4290)).
`bun:sqlite` is Bun's built-in SQLite module with an equivalent synchronous
API — the intent of the locked decision is a synchronous SQLite driver,
which `bun:sqlite` fulfils exactly.
