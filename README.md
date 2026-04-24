# New-pear-backend

**Food Pod Backend** — Bun + Hono + SQLite single-process service.

> This is **Buzz ONeil's** personal build. Paired with [oneilnate/New-pear-Expo](https://github.com/oneilnate/New-pear-Expo).

---

## Overview

Lightweight backend for the Food Pod prototype. One Bun process, no Docker, no Redis, no external DB — just SQLite on disk.

- **Runtime:** [Bun](https://bun.sh) 1.x
- **Framework:** [Hono](https://hono.dev)
- **Database:** [better-sqlite3](https://github.com/WiseLibs/better-sqlite3)
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

Copy `.env.example` to `.env` and fill in any env vars you need locally:

```bash
cp .env.example .env
```

---

## Endpoints

| Method | Path | Description |
|--------|------|-------------|
| GET | `/api/health` | Health check |
| GET | `/api/pods/:id` | Get pod + recent snaps + episode |
| POST | `/api/pods/:id/images` | Upload a meal image (stub — F2-E2) |
| POST | `/api/pods/:id/complete` | Trigger episode generation |
| GET | `/api/pods/:id/episode` | Get generated episode for pod |

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
    meals.ts         — POST /api/pods/:id/images (stub)
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
