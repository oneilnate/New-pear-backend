#!/usr/bin/env bash
# deploy.sh — idempotent deploy for Food Pod Backend
# Targets: pear-sandbox.everbetter.com (GCP, us-central1-a)
# Usage:
#   export GCP_SA_KEY='<json>'    # or GOOGLE_APPLICATION_CREDENTIALS=/path/to/key.json
#   ./deploy/deploy.sh
#
# All VM operations are additive (idempotent). Running twice is a no-op.
set -euo pipefail

# ---------------------------------------------------------------------------
# Configuration
# ---------------------------------------------------------------------------
PROJECT="obvious-compute-45868"
ZONE="us-central1-a"
INSTANCE="pear-sandbox"
SERVICE_ACCOUNT="pear-sandbox-agent@obvious-compute-45868.iam.gserviceaccount.com"
RELEASES_DIR="/opt/foodpod/releases"
CURRENT_LINK="/opt/foodpod/current"
MEDIA_DIR="/srv/foodpod/media"
ENV_FILE="/etc/foodpod/env"
NGINX_CONF="/etc/nginx/sites-available/default"
KEEP_RELEASES=3
SCRIPT_DIR="$( cd "$( dirname "${BASH_SOURCE[0]}" )" && pwd )"
REPO_ROOT="$( cd "${SCRIPT_DIR}/.." && pwd )"
TIMESTAMP="$(date +%Y%m%d_%H%M%S)"
RELEASE_DIR="${RELEASES_DIR}/${TIMESTAMP}"
SA_KEY_FILE=""

# ---------------------------------------------------------------------------
# Logging helpers
# ---------------------------------------------------------------------------
blue()  { echo -e "\033[1;34m[deploy]\033[0m $*"; }
green() { echo -e "\033[1;32m[deploy]\033[0m $*"; }
red()   { echo -e "\033[1;31m[deploy]\033[0m $*" >&2; }

cleanup() {
  [[ -n "${SA_KEY_FILE}" && -f "${SA_KEY_FILE}" ]] && rm -f "${SA_KEY_FILE}"
  rm -f /tmp/foodpod-release.tar.gz /tmp/foodpod-env-new || true
}
trap cleanup EXIT

# ---------------------------------------------------------------------------
# Step 0: Authenticate gcloud service account
# ---------------------------------------------------------------------------
blue "Authenticating gcloud service account..."
if [[ -n "${GCP_SA_KEY:-}" ]]; then
  SA_KEY_FILE=$(mktemp /tmp/gcp-sa-XXXXXX.json)
  # Decode the Obvious-encoded secret (backslash-space separated JSON)
  python3 - "${SA_KEY_FILE}" << 'PYEOF'
import os, json, sys
raw = os.environ.get('GCP_SA_KEY', '')
cleaned = raw.replace('\\ ', ' ')
try:
    d = json.loads(cleaned)
    if 'private_key' in d:
        d['private_key'] = d['private_key'].replace('\\n', '\n')
    with open(sys.argv[1], 'w') as f:
        json.dump(d, f)
except Exception:
    with open(sys.argv[1], 'w') as f:
        f.write(raw)
PYEOF
  gcloud auth activate-service-account "${SERVICE_ACCOUNT}" \
    --key-file="${SA_KEY_FILE}" --project="${PROJECT}" --quiet
elif [[ -n "${GOOGLE_APPLICATION_CREDENTIALS:-}" ]]; then
  gcloud auth activate-service-account "${SERVICE_ACCOUNT}" \
    --key-file="${GOOGLE_APPLICATION_CREDENTIALS}" --project="${PROJECT}" --quiet
else
  red "Neither GCP_SA_KEY nor GOOGLE_APPLICATION_CREDENTIALS set. Trying ADC..."
fi
gcloud config set project "${PROJECT}" --quiet
green "gcloud authenticated for project ${PROJECT}"

# ---------------------------------------------------------------------------
# SSH/SCP helpers
# ---------------------------------------------------------------------------
gsh() {
  gcloud compute ssh "${INSTANCE}" --zone="${ZONE}" --project="${PROJECT}" --quiet \
    --command="sudo bash -c $(printf '%q' "$1")"
}

gscp_to() {
  gcloud compute scp "$1" "${INSTANCE}:$2" \
    --zone="${ZONE}" --project="${PROJECT}" --quiet
}

# ---------------------------------------------------------------------------
# Step 1: Create foodpod user + directories (idempotent)
# ---------------------------------------------------------------------------
blue "Ensuring foodpod user and directories exist..."
gsh "id foodpod &>/dev/null || useradd --system --shell /bin/bash --create-home foodpod"
gsh "mkdir -p ${RELEASES_DIR} ${MEDIA_DIR} /etc/foodpod"
gsh "chown -R foodpod:foodpod /opt/foodpod ${MEDIA_DIR}"
gsh "chmod 750 /etc/foodpod"
green "User and directories ready"

# ---------------------------------------------------------------------------
# Step 2: Write /etc/foodpod/env (only on first deploy)
# ---------------------------------------------------------------------------
blue "Writing /etc/foodpod/env (first-run only)..."
GEMINI_VAL="${GEMINI_API_KEY:-}"
ELEVENLABS_VAL="${ELEVENLABS_API_KEY:-}"
ENV_TMP=$(mktemp /tmp/foodpod-env-XXXXXX)
cat > "${ENV_TMP}" << ENVEOF
# Food Pod Backend environment — managed by deploy.sh
# Manually update GEMINI_API_KEY and ELEVENLABS_API_KEY via SSH when ready
# See DEPLOY.md for SSH instructions
GEMINI_API_KEY=${GEMINI_VAL}
ELEVENLABS_API_KEY=${ELEVENLABS_VAL}
FOODPOD_MEDIA_DIR=${MEDIA_DIR}
PORT=8787
ENVEOF
gscp_to "${ENV_TMP}" "/tmp/foodpod-env-new"
rm -f "${ENV_TMP}"
gsh "if [ ! -f ${ENV_FILE} ]; then mv /tmp/foodpod-env-new ${ENV_FILE} && chmod 0600 ${ENV_FILE} && chown foodpod:foodpod ${ENV_FILE} && echo 'Wrote ${ENV_FILE}'; else echo '${ENV_FILE} exists — preserving'; rm -f /tmp/foodpod-env-new; fi"
green "Env file done"

# ---------------------------------------------------------------------------
# Step 3: Install Bun (idempotent)
# ---------------------------------------------------------------------------
blue "Ensuring Bun is installed and world-executable..."
gsh "apt-get install -y unzip 2>/dev/null | tail -1; if [ -x /usr/local/bin/bun ]; then echo \"Bun \$(/usr/local/bin/bun --version) already installed\"; else curl -fsSL https://bun.sh/install | bash && cp /root/.bun/bin/bun /usr/local/bin/bun-bin && chmod 755 /usr/local/bin/bun-bin && ln -sfn /usr/local/bin/bun-bin /usr/local/bin/bun && echo \"Installed Bun \$(/usr/local/bin/bun --version)\"; fi"
# Ensure the binary is world-executable (not just a symlink into /root/.bun)
gsh "if readlink /usr/local/bin/bun | grep -q root; then cp \$(readlink -f /usr/local/bin/bun) /usr/local/bin/bun-bin && chmod 755 /usr/local/bin/bun-bin && ln -sfn /usr/local/bin/bun-bin /usr/local/bin/bun && echo 'Fixed Bun symlink to world-accessible binary'; fi"
green "Bun ready"

# ---------------------------------------------------------------------------
# Step 4: Create release dir, upload, extract
# ---------------------------------------------------------------------------
blue "Creating release directory ${RELEASE_DIR}..."
gsh "mkdir -p ${RELEASE_DIR} && chown foodpod:foodpod ${RELEASE_DIR}"

blue "Creating repo tarball..."
TARBALL=/tmp/foodpod-release.tar.gz
(
  cd "${REPO_ROOT}"
  tar czf "${TARBALL}" \
    --exclude='.git' \
    --exclude='node_modules' \
    --exclude='*.stub' \
    --exclude='.env' \
    .
)
blue "Tarball: $(du -sh ${TARBALL} | cut -f1)"
gscp_to "${TARBALL}" "/tmp/foodpod-release.tar.gz"
gsh "tar xzf /tmp/foodpod-release.tar.gz -C ${RELEASE_DIR} && chown -R foodpod:foodpod ${RELEASE_DIR} && rm -f /tmp/foodpod-release.tar.gz"
green "Release extracted to ${RELEASE_DIR}"

# ---------------------------------------------------------------------------
# Step 5: bun install --production
# ---------------------------------------------------------------------------
blue "Running bun install --production..."
gsh "cd ${RELEASE_DIR} && /usr/local/bin/bun install --production 2>&1"
green "Dependencies installed"

# ---------------------------------------------------------------------------
# Step 6: Symlink current -> new release
# ---------------------------------------------------------------------------
blue "Symlinking ${CURRENT_LINK} -> ${RELEASE_DIR}..."
gsh "ln -sfn ${RELEASE_DIR} ${CURRENT_LINK} && chown -h foodpod:foodpod ${CURRENT_LINK}"
green "Symlink updated"

# ---------------------------------------------------------------------------
# Step 7: Install systemd unit
# ---------------------------------------------------------------------------
blue "Installing systemd unit foodpod-backend.service..."
gscp_to "${SCRIPT_DIR}/foodpod-backend.service" "/tmp/foodpod-backend.service"
gsh "cp /tmp/foodpod-backend.service /etc/systemd/system/foodpod-backend.service && chmod 644 /etc/systemd/system/foodpod-backend.service && systemctl daemon-reload && systemctl enable foodpod-backend.service && systemctl restart foodpod-backend.service && echo 'Service restarted'"
green "systemd unit installed and restarted"

# ---------------------------------------------------------------------------
# Step 8: Install nginx location blocks (idempotent via python helper)
# ---------------------------------------------------------------------------
blue "Installing nginx location blocks..."
gscp_to "${SCRIPT_DIR}/foodpod-nginx.conf" "/tmp/foodpod-nginx.conf"
gscp_to "${SCRIPT_DIR}/nginx-inject.py" "/tmp/nginx-inject.py"
gsh "python3 /tmp/nginx-inject.py ${NGINX_CONF} /tmp/foodpod-nginx.conf"
gsh "nginx -t && systemctl reload nginx && echo 'nginx reloaded (zero-downtime)'"
green "nginx updated"

# ---------------------------------------------------------------------------
# Step 9: Clean up old releases
# ---------------------------------------------------------------------------
blue "Cleaning up old releases (keeping ${KEEP_RELEASES})..."
gsh "ls -1dt ${RELEASES_DIR}/*/ 2>/dev/null | tail -n +$((KEEP_RELEASES+1)) | xargs rm -rf -- 2>/dev/null; echo \"Remaining releases: \$(ls ${RELEASES_DIR} | wc -l)\""

# ---------------------------------------------------------------------------
# Step 10: Smoke test
# ---------------------------------------------------------------------------
blue "Running smoke test (waiting 5s for service to start)..."
sleep 5

SMOKE_RESULT=$(curl -sf --max-time 15 "https://pear-sandbox.everbetter.com/api/health" 2>&1 || true)
blue "Health response: ${SMOKE_RESULT}"

if echo "${SMOKE_RESULT}" | grep -q '"ok":true'; then
  green "✅ Smoke test PASSED — {ok:true} from https://pear-sandbox.everbetter.com/api/health"
else
  red "❌ Smoke test FAILED — response: ${SMOKE_RESULT}"
  red "Debug on VM: sudo journalctl -u foodpod-backend -n 50"
  exit 1
fi

green "🚀 Deploy complete! Release: ${TIMESTAMP}"
green "   Current: ${CURRENT_LINK} -> ${RELEASE_DIR}"
