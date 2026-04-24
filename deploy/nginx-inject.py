#!/usr/bin/env python3
"""
nginx-inject.py — Idempotently inject foodpod location blocks into nginx config.
Usage: python3 nginx-inject.py <nginx_conf_path> <snippet_path>
"""
import sys, os, shutil, re

conf_path = sys.argv[1]
snippet_path = sys.argv[2]

with open(conf_path, 'r') as f:
    content = f.read()

# Already injected?
if 'BEGIN_FOODPOD_NGINX' in content:
    print(f"Foodpod nginx blocks already present in {conf_path} — skipping")
    sys.exit(0)

with open(snippet_path, 'r') as f:
    snippet = f.read()

# Find the server block that has pear-sandbox.everbetter.com AND ssl
# We look for "server_name pear-sandbox.everbetter.com;" in the HTTPS server block
# Insert the snippet right after that line
pattern = r'(server_name pear-sandbox\.everbetter\.com;[^\n]*\n)'
# Find the last occurrence (the HTTPS block, not the redirect block)
matches = list(re.finditer(pattern, content))
if not matches:
    print(f"ERROR: Could not find 'server_name pear-sandbox.everbetter.com;' in {conf_path}", file=sys.stderr)
    sys.exit(1)

# Use the first match that is in an SSL server block (has 'listen 443')
target_match = None
for m in matches:
    # Check if this server block contains ssl
    # Look backwards for the opening { of this server block
    before = content[:m.start()]
    last_open = before.rfind('{')
    block_start_context = content[max(0, last_open-100):m.end()+500]
    if 'listen 443' in block_start_context or 'ssl' in block_start_context:
        target_match = m
        break

if target_match is None:
    # Fall back to last match
    target_match = matches[-1]

# Backup original
shutil.copy(conf_path, conf_path + '.bak')

# Insert snippet after the matched line
insert_pos = target_match.end()
new_content = content[:insert_pos] + snippet + '\n' + content[insert_pos:]

with open(conf_path, 'w') as f:
    f.write(new_content)

print(f"Injected foodpod nginx blocks into {conf_path}")
