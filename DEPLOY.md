# Deploy Guide — Food Pod Backend

This document describes how to deploy the Food Pod Backend to the `pear-sandbox.everbetter.com` VM.

---

## VM Basics

| Property | Value |
|----------|-------|
| Host | `pear-sandbox.everbetter.com` |
| GCP Project | `obvious-compute-45868` |
| Zone | `us-central1-a` |
| Instance name | `pear-sandbox` |
| Service account | `pear-sandbox-agent@obvious-compute-45868.iam.gserviceaccount.com` |
| TLS cert | Let's Encrypt, valid through 2026-07-20 (auto-renews) |
| Service port | `127.0.0.1:8787` (nginx reverse-proxies public → private) |
| Systemd unit | `foodpod-backend.service` |
| Releases dir | `/opt/foodpod/releases/` (keeps last 3) |
| Current symlink | `/opt/foodpod/current` |
| Media dir | `/srv/foodpod/media/` |
| Env file | `/etc/foodpod/env` (chmod 0600, owner foodpod) |

---

## Prerequisites

### 1. Add `GCP_SA_KEY` to GitHub repo secrets

The deploy workflow needs a JSON service account key to authenticate with GCP. Run this from your local machine:

```bash
# Obtain the GCP SA key JSON (from 1Password / GCP Console)
# Then:
gh secret set GCP_SA_KEY \
  --repo oneilnate/New-pear-backend \
  --body "$(cat /path/to/pear-sandbox-agent-key.json)"
```

To also seed the env file with API keys on first deploy:

```bash
gh secret set GEMINI_API_KEY \
  --repo oneilnate/New-pear-backend \
  --body "<your-gemini-key>"

gh secret set ELEVENLABS_API_KEY \
  --repo oneilnate/New-pear-backend \
  --body "<your-elevenlabs-key>"
```

> **Note:** `GEMINI_API_KEY` and `ELEVENLABS_API_KEY` are optional. If not set, the env file will
> be written with empty strings as placeholders. The F4 pipeline will return 503 until they are set.
> The health endpoint (`/api/health`) works regardless.

### 2. Verify gcloud is installed locally (for local deploys)

```bash
gcloud version
# Should be 400+
```

---

## Deploying

### Option A: GitHub Actions (recommended)

1. Go to **Actions** → **Deploy to pear-sandbox VM** → **Run workflow**
2. Enter an optional reason (e.g., "F5 initial deploy")
3. Click **Run workflow**
4. Watch the logs — the final step verifies health at `https://pear-sandbox.everbetter.com/api/health`

### Option B: Local deploy

```bash
# Export the GCP service account key (JSON string)
export GCP_SA_KEY='<paste-json-here>'
# OR point to a key file:
export GOOGLE_APPLICATION_CREDENTIALS=/path/to/pear-sandbox-agent-key.json

# Optional — will be written to /etc/foodpod/env on first deploy only:
export GEMINI_API_KEY='<key>'
export ELEVENLABS_API_KEY='<key>'

# Run from repo root
chmod +x deploy/deploy.sh
./deploy/deploy.sh
```

---

## What `deploy.sh` does

1. **Authenticates** gcloud with the service account key
2. **Creates** `foodpod` OS user, `/opt/foodpod/releases/`, `/srv/foodpod/media/`, `/etc/foodpod/` (idempotent)
3. **Writes** `/etc/foodpod/env` — only on first deploy; preserves manual edits thereafter
4. **Installs Bun** at `/usr/local/bin/bun` if not present
5. **Uploads** the repo tarball (excluding `.git`, `node_modules`) to a timestamped release dir
6. **Extracts** and runs `bun install --production`
7. **Symlinks** `/opt/foodpod/current` → new release
8. **Installs** `foodpod-backend.service` systemd unit, enables and restarts it
9. **Injects** nginx location blocks for `/api/`, `/media/`, and `/media/audio/` (idempotent, uses `BEGIN_FOODPOD_NGINX` / `END_FOODPOD_NGINX` markers — re-running **replaces** the block, not duplicates it)
10. **Runs** `nginx -t && systemctl reload nginx` (zero-downtime; reload only if config test passes)
11. **Smoke-tests** `https://pear-sandbox.everbetter.com/api/health` — exits 1 if `{ok:true}` not returned
12. **Cleans up** releases older than 3

Running `deploy.sh` twice is a **no-op** — all steps check before acting.

---

## SSH to VM for manual key update

To update API keys on the VM after the first deploy:

```bash
# Authenticate gcloud locally first
gcloud auth activate-service-account \
  pear-sandbox-agent@obvious-compute-45868.iam.gserviceaccount.com \
  --key-file=/path/to/key.json \
  --project=obvious-compute-45868

# SSH in
gcloud compute ssh pear-sandbox \
  --zone=us-central1-a \
  --project=obvious-compute-45868

# Once on VM — edit the env file
sudo nano /etc/foodpod/env
# Set GEMINI_API_KEY and ELEVENLABS_API_KEY

# Restart the service to pick up new keys
sudo systemctl restart foodpod-backend
sudo systemctl status foodpod-backend

# Verify
curl https://pear-sandbox.everbetter.com/api/health
```

---

## Checking service status

```bash
# SSH to VM (see above), then:
sudo systemctl status foodpod-backend
sudo journalctl -u foodpod-backend -n 100 --no-pager

# Check nginx
sudo nginx -t
sudo systemctl status nginx

# Smoke test from anywhere
curl https://pear-sandbox.everbetter.com/api/health
# Expected: {"ok":true,"service":"food-pod-backend","ts":"<ISO>"}
```

---

## Rollback

The last 3 releases are preserved in `/opt/foodpod/releases/`. To roll back:

```bash
# SSH to VM
gcloud compute ssh pear-sandbox --zone=us-central1-a --project=obvious-compute-45868

# List releases
ls -lt /opt/foodpod/releases/

# Symlink to a previous release
sudo ln -sfn /opt/foodpod/releases/<previous-timestamp> /opt/foodpod/current
sudo chown -h foodpod:foodpod /opt/foodpod/current
sudo systemctl restart foodpod-backend

# Verify
curl https://pear-sandbox.everbetter.com/api/health
```

---

## File layout on VM

```
/opt/foodpod/
  releases/
    20260424_120000/    ← previous release
    20260424_130000/    ← current release
  current -> releases/20260424_130000  (symlink)

/srv/foodpod/
  media/               ← audio + image files written by F4 pipeline

/etc/foodpod/
  env                  ← 0600, owner foodpod

/etc/systemd/system/
  foodpod-backend.service
```

---

---

## Media Routes (F5-E2)

| Route | Served By | MIME | Notes |
|-------|-----------|------|-------|
| `GET /media/images/:filename` | Hono backend → nginx `/media/` block | `image/jpeg` | Range requests supported (206) |
| `GET /media/audio/:filename` | Hono backend → nginx `/media/audio/` block | `audio/mpeg` | Range requests + no buffering for seeking |

### Cache Policy

All media files use `Cache-Control: public, max-age=604800, immutable` (7 days, aggressively cached).
This is safe because filenames are episode-id scoped and never recycled.

### CORS Policy

CORS headers are sent for the following origins (Expo web preview):
- `https://localhost:8081` — Metro local dev server
- `https://127.0.0.1:8081` — Metro local dev server (IP form)
- `https://*.expo.dev` — Expo tunnel/preview URLs

Headers exposed: `Content-Length`, `Content-Range`, `Accept-Ranges` (required for audio seeking in `<audio>` elements).

### Range Requests

Both `/media/images/` and `/media/audio/` support HTTP Range requests (`206 Partial Content`).
The backend (Hono, `src/routes/meals.ts`) handles range slicing and returns:
- `Accept-Ranges: bytes`
- `Content-Range: bytes <start>-<end>/<total>`
- `Content-Length: <chunk-size>`

### nginx inject idempotency

`deploy/nginx-inject.py` now **replaces** the existing `BEGIN_FOODPOD_NGINX`…`END_FOODPOD_NGINX` block
on every deploy (instead of skipping if present). This ensures config updates land without manual SSH.
Run `python3 deploy/nginx-inject.test.py` to verify idempotency behaviour locally.

---

*Built by Buzz ONeil @ EverBetter. Part of the Food Pod initiative (ini_JE3NE5Yz).*

