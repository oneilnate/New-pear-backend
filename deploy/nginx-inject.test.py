#!/usr/bin/env python3
"""
nginx-inject.test.py — Test suite for deploy/nginx-inject.py

Tests:
  1. Fresh inject: snippet inserted after server_name line.
  2. Idempotent re-inject: running twice produces exactly one block, no duplication.
  3. Idempotent replace: updated snippet replaces old block cleanly.
  4. Missing server_name: exits with code 1.
  5. Malformed markers (BEGIN without END): exits with code 1.

Usage:
    python3 deploy/nginx-inject.test.py
    # exits 0 on all pass, non-zero on any failure
"""
import subprocess, sys, tempfile, os, textwrap

INJECT_SCRIPT = os.path.join(os.path.dirname(__file__), "nginx-inject.py")
SNIPPET_FILE  = os.path.join(os.path.dirname(__file__), "foodpod-nginx.conf")

# ── Minimal valid nginx config that mimics the real one ───────────────────────
FAKE_NGINX_CONF = textwrap.dedent("""\
    server {
        listen 80;
        server_name pear-sandbox.everbetter.com;
        return 301 https://$host$request_uri;
    }

    server {
        listen 443 ssl;
        server_name pear-sandbox.everbetter.com;
        ssl_certificate /etc/letsencrypt/live/pear-sandbox.everbetter.com/fullchain.pem;
        ssl_certificate_key /etc/letsencrypt/live/pear-sandbox.everbetter.com/privkey.pem;

        root /var/www/html;
        index index.html;
    }
""")

SNIPPET_V1 = textwrap.dedent("""\
    # BEGIN_FOODPOD_NGINX
        location /api/ { proxy_pass http://127.0.0.1:8787; }
    # END_FOODPOD_NGINX
""")

SNIPPET_V2 = textwrap.dedent("""\
    # BEGIN_FOODPOD_NGINX
        location /api/ { proxy_pass http://127.0.0.1:8787; }
        location /media/audio/ { proxy_pass http://127.0.0.1:8787; }
    # END_FOODPOD_NGINX
""")

PASS = "\033[32mPASS\033[0m"
FAIL = "\033[31mFAIL\033[0m"
failures = 0


def run_inject(conf_content: str, snippet_content: str) -> tuple[int, str, str, str]:
    """Run nginx-inject.py, return (exit_code, stdout, stderr, resulting_conf_content)."""
    with tempfile.TemporaryDirectory() as tmpdir:
        conf_path    = os.path.join(tmpdir, "default")
        snippet_path = os.path.join(tmpdir, "snippet.conf")
        with open(conf_path, "w") as f:
            f.write(conf_content)
        with open(snippet_path, "w") as f:
            f.write(snippet_content)
        result = subprocess.run(
            [sys.executable, INJECT_SCRIPT, conf_path, snippet_path],
            capture_output=True, text=True,
        )
        try:
            with open(conf_path, "r") as f:
                out_content = f.read()
        except FileNotFoundError:
            out_content = ""
        return result.returncode, result.stdout, result.stderr, out_content


def check(name: str, condition: bool, detail: str = ""):
    global failures
    if condition:
        print(f"  {PASS}  {name}")
    else:
        print(f"  {FAIL}  {name}" + (f"\n         {detail}" if detail else ""))
        failures += 1


# ── Test 1: Fresh inject ───────────────────────────────────────────────────────
print("Test 1: Fresh inject into clean config")
rc, stdout, stderr, out = run_inject(FAKE_NGINX_CONF, SNIPPET_V1)
check("exit code 0",           rc == 0,                           f"got {rc}")
check("snippet inserted",      "BEGIN_FOODPOD_NGINX" in out,      "marker not found")
check("single BEGIN marker",   out.count("BEGIN_FOODPOD_NGINX") == 1, f"count={out.count('BEGIN_FOODPOD_NGINX')}")
check("not in http-only block", "return 301" not in out.split("BEGIN_FOODPOD_NGINX")[0].split("server {")[-1],
      "snippet ended up in the redirect block")

# ── Test 2: Idempotent re-inject (same snippet twice) ─────────────────────────
print("Test 2: Idempotent re-inject (run twice, expect one block)")
# First pass
rc1, _, _, after_first = run_inject(FAKE_NGINX_CONF, SNIPPET_V1)
# Second pass — re-run on the already-injected config
rc2, stdout2, stderr2, after_second = run_inject(after_first, SNIPPET_V1)
check("first inject exit 0",  rc1 == 0,                           f"got {rc1}")
check("second inject exit 0", rc2 == 0,                           f"got {rc2}")
check("only one BEGIN marker", after_second.count("BEGIN_FOODPOD_NGINX") == 1,
      f"count={after_second.count('BEGIN_FOODPOD_NGINX')}")
check("only one END marker",   after_second.count("END_FOODPOD_NGINX") == 1,
      f"count={after_second.count('END_FOODPOD_NGINX')}")

# ── Test 3: Replace (updated snippet replaces old one) ────────────────────────
print("Test 3: Replace — updated snippet replaces old block")
_, _, _, after_v1 = run_inject(FAKE_NGINX_CONF, SNIPPET_V1)
rc3, _, stderr3, after_v2 = run_inject(after_v1, SNIPPET_V2)
check("replace exit 0",         rc3 == 0,                         f"got {rc3}, stderr={stderr3}")
check("new block present",      "media/audio" in after_v2,        "audio location missing")
check("old api block replaced", after_v2.count("BEGIN_FOODPOD_NGINX") == 1,
      f"count={after_v2.count('BEGIN_FOODPOD_NGINX')}")
check("no duplication",         after_v2.count("location /api/") == 1,
      f"count={after_v2.count('location /api/')}")

# ── Test 4: Missing server_name → exit 1 ──────────────────────────────────────
print("Test 4: Missing server_name → exit 1")
NO_SERVER_NAME_CONF = "server { listen 443 ssl; root /var/www/html; }\n"
rc4, _, stderr4, _ = run_inject(NO_SERVER_NAME_CONF, SNIPPET_V1)
check("exit code 1",   rc4 == 1, f"got {rc4}")
check("error on stderr", len(stderr4.strip()) > 0, "no error message printed")

# ── Test 5: Malformed markers (BEGIN without END) → exit 1 ────────────────────
print("Test 5: BEGIN without END → exit 1")
BROKEN_CONF = FAKE_NGINX_CONF + "\n# BEGIN_FOODPOD_NGINX\n    location /api/ {}\n"
rc5, _, stderr5, _ = run_inject(BROKEN_CONF, SNIPPET_V1)
check("exit code 1",   rc5 == 1, f"got {rc5}")
check("error on stderr", len(stderr5.strip()) > 0, "no error message printed")

# ── Summary ───────────────────────────────────────────────────────────────────
print()
if failures == 0:
    print(f"\033[32mAll tests passed.\033[0m")
    sys.exit(0)
else:
    print(f"\033[31m{failures} test(s) failed.\033[0m")
    sys.exit(1)
