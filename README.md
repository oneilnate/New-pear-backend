# New-pear-backend

**Food Pod Backend** — Bun + Hono + SQLite single-process service.

> This is **Buzz ONeil's** personal build. Paired with [oneilnate/New-pear-Expo](https://github.com/oneilnate/New-pear-Expo).

---

## Overview

Lightweight backend for the Food Pod prototype. One Bun process, no Docker, no Redis, no external DB — just SQLite on disk.

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
  pipeline/
    gemini.ts        — Gemini vision+script stub (F4)
    elevenlabs.ts    — ElevenLabs audio stub (F4)
    run.ts           — Pipeline orchestrator stub
tests/
  server.test.ts     — Vitest tests for all endpoints
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
