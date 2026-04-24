#!/usr/bin/env python3
"""
nginx-inject.py — Idempotently inject (or REPLACE) foodpod location blocks
into an existing nginx server config.

Usage:
    python3 nginx-inject.py <nginx_conf_path> <snippet_path>

Behaviour:
  - If BEGIN_FOODPOD_NGINX / END_FOODPOD_NGINX markers are already present,
    the existing block is REPLACED with the current snippet (idempotent update).
  - If the markers are absent, the snippet is INSERTED after the
    "server_name pear-sandbox.everbetter.com;" line in the SSL server block.
  - A .bak backup of the original file is always created before any write.
"""
import sys, os, shutil, re

conf_path   = sys.argv[1]
snippet_path = sys.argv[2]

with open(conf_path, 'r') as f:
    content = f.read()

with open(snippet_path, 'r') as f:
    snippet = f.read().rstrip('\n')

BEGIN_MARKER = 'BEGIN_FOODPOD_NGINX'
END_MARKER   = 'END_FOODPOD_NGINX'

# ── Case 1: markers already present — REPLACE the block ───────────────────────
if BEGIN_MARKER in content:
    # Match everything from the comment line containing BEGIN_FOODPOD_NGINX
    # up to and including the comment line containing END_FOODPOD_NGINX.
    pattern = r'#\s*' + re.escape(BEGIN_MARKER) + r'.*?#\s*' + re.escape(END_MARKER)
    match = re.search(pattern, content, flags=re.DOTALL)
    if not match:
        print(
            f"ERROR: BEGIN_FOODPOD_NGINX found but END_FOODPOD_NGINX missing — "
            f"cannot safely replace. Fix manually.",
            file=sys.stderr,
        )
        sys.exit(1)

    shutil.copy(conf_path, conf_path + '.bak')
    new_content = content[:match.start()] + snippet + content[match.end():]
    with open(conf_path, 'w') as f:
        f.write(new_content)
    print(f"Replaced foodpod nginx block in {conf_path} (backup: {conf_path}.bak)")
    sys.exit(0)

# ── Case 2: no markers yet — INSERT after server_name line ────────────────────
pattern = r'(server_name pear-sandbox\.everbetter\.com;[^\n]*\n)'
matches = list(re.finditer(pattern, content))
if not matches:
    print(
        f"ERROR: Could not find 'server_name pear-sandbox.everbetter.com;' in {conf_path}",
        file=sys.stderr,
    )
    sys.exit(1)

# Prefer the match inside an SSL/443 server block
target_match = None
for m in matches:
    before = content[:m.start()]
    last_open = before.rfind('{')
    block_ctx = content[max(0, last_open - 100):m.end() + 500]
    if 'listen 443' in block_ctx or 'ssl' in block_ctx:
        target_match = m
        break

if target_match is None:
    target_match = matches[-1]   # fall back to last match

shutil.copy(conf_path, conf_path + '.bak')
insert_pos = target_match.end()
new_content = content[:insert_pos] + snippet + '\n' + content[insert_pos:]

with open(conf_path, 'w') as f:
    f.write(new_content)

print(f"Injected foodpod nginx blocks into {conf_path} (backup: {conf_path}.bak)")
