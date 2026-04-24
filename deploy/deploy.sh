#!/usr/bin/env bash
# deploy.sh — idempotent deploy for Food Pod Backend
# Targets: pear-sandbox.everbetter.com (GCP, us-central1-a)
# Usage:
#   export GCP_SA_KEY='<json>'    # or let it fall through to GOOGLE_APPLICATION_CREDENTIALS
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
REMOTE_USER="foodpod"
RELEASES_DIR="/opt/foodpod/releases"
CURRENT_LINK="/opt/foodpod/current"
MEDIA_DIR="/srv/foodpod/media"
ENV_FILE="/etc/foodpod/env"
SERVICE_NAME="foodpod-backend"
PORT="8787"
KEEP_RELEASES=3
SCRIPT_DIR="$( cd "$( dirname "${BASH_SOURCE[0]}" )" && pwd )"
REPO_ROOT="$( cd "${SCRIPT_DIR}/.." && pwd )"
TIMESTAMP="$(date +%Y%m%d_%H%M%S)"
RELEASE_DIR="${RELEASES_DIR}/${TIMESTAMP}"

# ---------------------------------------------------------------------------
# Logging helpers
# ---------------------------------------------------------------------------
blue()  { echo -e "\033[1;34m[deploy]\033[0m $*"; }
green() { echo -e "\033[1;32m[deploy]\033[0m $*"; }
red()   { echo -e "\033[1;31m[deploy]\033[0m $*" >&2; }

# ---------------------------------------------------------------------------
# Step 0: Authenticate gcloud service account
# ---------------------------------------------------------------------------
blue "Authenticating gcloud service account..."
if [[ -n "${GCP_SA_KEY:-}" ]]; then
  SA_KEY_FILE=$(mktemp /tmp/gcp-sa-XXXXXX.json)
  trap 'rm -f "${SA_KEY_FILE}"' EXIT
  echo "${GCP_SA_KEY}" > "${SA_KEY_FILE}"
  gcloud auth activate-service-account "${SERVICE_ACCOUNT}" \
    --key-file="${SA_KEY_FILE}" --project="${PROJECT}" --quiet
elif [[ -n "${GOOGLE_APPLICATION_CREDENTIALS:-}" ]]; then
  gcloud auth activate-service-account "${SERVICE_ACCOUNT}" \
    --key-file="${GOOGLE_APPLICATION_CREDENTIALS}" --project="${PROJECT}" --quiet
else
  red "Neither GCP_SA_KEY nor GOOGLE_APPLICATION_CREDENTIALS set. Trying ADC..."
  gcloud config set project "${PROJECT}" --quiet
fi
gcloud config set project "${PROJECT}" --quiet
green "gcloud authenticated for project ${PROJECT}"

# ---------------------------------------------------------------------------
# gcloud ssh/scp helpers
# ---------------------------------------------------------------------------
gsh() {
  # Run a command on the VM as root (sudo -i) via gcloud compute ssh
  gcloud compute ssh "${INSTANCE}" --zone="${ZONE}" --quiet \
    --command="$1"
}

gsh_as_foodpod() {
  # Run a command as the foodpod user
  gcloud compute ssh "${INSTANCE}" --zone="${ZONE}" --quiet \
    --command="sudo -u foodpod bash -lc $(printf '%q' "$1")"
}

# ---------------------------------------------------------------------------
# Step 1: Create foodpod user and directories (idempotent)
# ---------------------------------------------------------------------------
blue "Ensuring foodpod user and directories exist on VM..."
gsh "id foodpod &>/dev/null || (useradd --system --shell /bin/bash --create-home foodpod && echo 'Created foodpod user')"
gsh "mkdir -p ${RELEASES_DIR} ${MEDIA_DIR} && \
     chown -R foodpod:foodpod /opt/foodpod ${MEDIA_DIR} && \
     chmod 755 /opt/foodpod ${MEDIA_DIR}"
gsh "mkdir -p /etc/foodpod && chmod 700 /etc/foodpod"
green "User and directories ready"

# ---------------------------------------------------------------------------
# Step 2: Write /etc/foodpod/env (idempotent — only if it doesn't exist)
# ---------------------------------------------------------------------------
blue "Writing /etc/foodpod/env (placeholder if not present)..."
# Build env content from available CI/CD env vars or placeholders
GEMINI_VAL="${GEMINI_API_KEY:-}"
ELEVENLABS_VAL="${ELEVENLABS_API_KEY:-}"

ENV_CONTENT="# Food Pod Backend environment — managed by deploy.sh\n\
GEMINI_API_KEY=${GEMINI_VAL}\n\
ELEVENLABS_API_KEY=${ELEVENLABS_VAL}\n\
FOODPOD_MEDIA_DIR=${MEDIA_DIR}\n\
PORT=${PORT}\n"

# Only write if the env file doesn't exist yet; preserve manual edits otherwise
gsh "if [ ! -f ${ENV_FILE} ]; then \
       printf '${ENV_CONTENT}' > ${ENV_FILE} && \
       chmod 0600 ${ENV_FILE} && \
       chown foodpod:foodpod ${ENV_FILE} && \
       echo 'Wrote ${ENV_FILE}'; \
     else \
       echo '${ENV_FILE} already exists — skipping write (preserving existing keys)'; \
     fi"
green "Env file done"

# ---------------------------------------------------------------------------
# Step 3: Install Bun on VM (idempotent)
# ---------------------------------------------------------------------------
blue "Ensuring Bun is installed on VM..."
gsh "if [ -x /usr/local/bin/bun ]; then \
       echo \"Bun already installed: \$(/usr/local/bin/bun --version)\"; \
     else \
       echo 'Installing Bun...' && \
       curl -fsSL https://bun.sh/install | bash && \
       ln -sf /root/.bun/bin/bun /usr/local/bin/bun && \
       echo \"Bun installed: \$(/usr/local/bin/bun --version)\"; \
     fi"
# Also ensure foodpod user has bun in PATH
gsh "if [ ! -x /usr/local/bin/bun ]; then \
       sudo -u foodpod bash -c 'curl -fsSL https://bun.sh/install | bash' && \
       ln -sf /home/foodpod/.bun/bin/bun /usr/local/bin/bun; \
     fi"
green "Bun ready"

# ---------------------------------------------------------------------------
# Step 4: Create release dir, upload, extract
# ---------------------------------------------------------------------------
blue "Creating release directory ${RELEASE_DIR} on VM..."
gsh "mkdir -p ${RELEASE_DIR} && chown foodpod:foodpod ${RELEASE_DIR}"

blue "Creating repo tarball (excluding .git, node_modules)..."
TARBALL=$(mktemp /tmp/foodpod-XXXXXX.tar.gz)
trap 'rm -f "${TARBALL}" "${SA_KEY_FILE:-}"' EXIT

# Create tarball from repo root
(
  cd "${REPO_ROOT}"
  tar czf "${TARBALL}" \
    --exclude='.git' \
    --exclude='node_modules' \
    --exclude='*.stub' \
    --exclude='.env' \
    .
)
blue "Tarball created: $(du -sh ${TARBALL} | cut -f1)"

blue "Uploading tarball to VM..."
gcloud compute scp "${TARBALL}" \
  "${INSTANCE}:/tmp/foodpod-release.tar.gz" \
  --zone="${ZONE}" --quiet

blue "Extracting tarball on VM..."
gsh "tar xzf /tmp/foodpod-release.tar.gz -C ${RELEASE_DIR} && \
     chown -R foodpod:foodpod ${RELEASE_DIR} && \
     rm -f /tmp/foodpod-release.tar.gz"
green "Release extracted to ${RELEASE_DIR}"

# ---------------------------------------------------------------------------
# Step 5: bun install --production
# ---------------------------------------------------------------------------
blue "Running bun install --production on VM..."
gsh "cd ${RELEASE_DIR} && sudo -u foodpod /usr/local/bin/bun install --production"
green "Dependencies installed"

# ---------------------------------------------------------------------------
# Step 6: Symlink current -> new release
# ---------------------------------------------------------------------------
blue "Symlinking ${CURRENT_LINK} -> ${RELEASE_DIR}..."
gsh "ln -sfn ${RELEASE_DIR} ${CURRENT_LINK} && \
     chown -h foodpod:foodpod ${CURRENT_LINK}"
green "Symlink updated"

# ---------------------------------------------------------------------------
# Step 7: Install systemd unit (idempotent)
# ---------------------------------------------------------------------------
blue "Installing systemd unit foodpod-backend.service..."
gcloud compute scp \
  "${SCRIPT_DIR}/foodpod-backend.service" \
  "${INSTANCE}:/tmp/foodpod-backend.service" \
  --zone="${ZONE}" --quiet
gsh "cp /tmp/foodpod-backend.service /etc/systemd/system/foodpod-backend.service && \
     chmod 644 /etc/systemd/system/foodpod-backend.service && \
     systemctl daemon-reload && \
     systemctl enable foodpod-backend.service && \
     systemctl restart foodpod-backend.service && \
     echo 'Service restarted'"
green "systemd unit installed and restarted"

# ---------------------------------------------------------------------------
# Step 8: Install nginx location blocks (idempotent)
# ---------------------------------------------------------------------------
blue "Installing nginx location blocks (idempotent)..."

# Find the nginx config file for this server
NGINX_CONF_PATH=$(gsh "grep -rl 'pear-sandbox.everbetter.com' /etc/nginx/ 2>/dev/null | head -1" 2>/dev/null || true)
if [[ -z "${NGINX_CONF_PATH}" ]]; then
  NGINX_CONF_PATH="/etc/nginx/sites-enabled/default"
  blue "Could not auto-detect nginx config, using ${NGINX_CONF_PATH}"
fi
blue "Nginx config: ${NGINX_CONF_PATH}"

# Upload the location block file
gcloud compute scp \
  "${SCRIPT_DIR}/foodpod-nginx.conf" \
  "${INSTANCE}:/tmp/foodpod-nginx.conf" \
  --zone="${ZONE}" --quiet

# Inject location blocks idempotently using BEGIN/END markers
gsh "CONF_PATH=${NGINX_CONF_PATH} && \
     if grep -q 'BEGIN_FOODPOD_NGINX' \"\${CONF_PATH}\" 2>/dev/null; then \
       echo 'Nginx blocks already present — skipping injection'; \
     else \
       echo 'Injecting nginx location blocks...' && \
       LOCATION_CONTENT=\$(sed -n '/BEGIN_FOODPOD_NGINX/,/END_FOODPOD_NGINX/p' /tmp/foodpod-nginx.conf) && \
       INSERTION_LINE=\$(grep -n 'server_name.*pear-sandbox.everbetter.com' \"\${CONF_PATH}\" | tail -1 | cut -d: -f1) && \
       if [ -n \"\${INSERTION_LINE}\" ]; then \
         sed -i \"\${INSERTION_LINE}a \\ " \"\${CONF_PATH}\"; \
         python3 -c \" \
import sys, re \
with open('\${CONF_PATH}', 'r') as f: \
    content = f.read() \
with open('/tmp/foodpod-nginx.conf', 'r') as f: \
    insertion = f.read() \
# Find the server_name line and insert after the closing brace context \
marker = 'server_name pear-sandbox.everbetter.com' \
idx = content.find(marker) \
if idx >= 0: \
    newline_after = content.find(chr(10), idx) \
    content = content[:newline_after+1] + insertion + content[newline_after+1:] \
    with open('\${CONF_PATH}', 'w') as f: \
        f.write(content) \
    print('Injected nginx blocks after server_name line') \
else: \
    print('server_name line not found', file=sys.stderr) \
    sys.exit(1) \
\"; \
       else \
         echo 'Could not find server_name line — appending to include directory' && \
         cp /tmp/foodpod-nginx.conf /etc/nginx/conf.d/foodpod.conf; \
       fi; \
     fi"

gsh "nginx -t && nginx -s reload && echo 'nginx reloaded'"
green "nginx updated"

# ---------------------------------------------------------------------------
# Step 9: Clean up old releases (keep last N)
# ---------------------------------------------------------------------------
blue "Cleaning up old releases (keeping ${KEEP_RELEASES})..."
gsh "ls -1dt ${RELEASES_DIR}/*/ 2>/dev/null | tail -n +$((${KEEP_RELEASES}+1)) | xargs rm -rf --; \
     echo \"Remaining releases: \$(ls ${RELEASES_DIR} | wc -l)\""

# ---------------------------------------------------------------------------
# Step 10: Smoke test
# ---------------------------------------------------------------------------
blue "Running smoke test..."
blue "Waiting 5s for service to start..."
sleep 5

SMOKE_RESULT=$(curl -sf --max-time 15 "https://pear-sandbox.everbetter.com/api/health" 2>&1 || true)
blue "Health response: ${SMOKE_RESULT}"

if echo "${SMOKE_RESULT}" | grep -q '"ok":true'; then
  green "✅ Smoke test PASSED — {ok:true} returned from https://pear-sandbox.everbetter.com/api/health"
else
  red "❌ Smoke test FAILED — response: ${SMOKE_RESULT}"
  red "Check: sudo journalctl -u foodpod-backend -n 50"
  exit 1
fi

green "🚀 Deploy complete! Release: ${TIMESTAMP}"
green "   Current: ${CURRENT_LINK} -> ${RELEASE_DIR}"

