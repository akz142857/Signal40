#!/usr/bin/env bash
set -euo pipefail

backup_root="${1:-backups/$(date -u +%Y%m%dT%H%M%SZ)}"
mkdir -p "$backup_root"
WRANGLER_WRITE_LOGS=false WRANGLER_LOG_PATH=.wrangler/logs MINIFLARE_REGISTRY_PATH=.wrangler/registry \
  npx wrangler d1 export DB --local --config wrangler.local.jsonc --output "$backup_root/d1.sql"
WRANGLER_WRITE_LOGS=false WRANGLER_LOG_PATH=.wrangler/logs MINIFLARE_REGISTRY_PATH=.wrangler/registry \
  npx wrangler d1 export DB --local --config wrangler.local.jsonc --no-schema --output "$backup_root/d1-data.sql"
tar -czf "$backup_root/local-r2-state.tar.gz" .wrangler/state/v3/r2 2>/dev/null || true
shasum -a 256 "$backup_root/d1.sql" > "$backup_root/SHA256SUMS"
shasum -a 256 "$backup_root/d1-data.sql" >> "$backup_root/SHA256SUMS"
if [[ -f "$backup_root/local-r2-state.tar.gz" ]]; then shasum -a 256 "$backup_root/local-r2-state.tar.gz" >> "$backup_root/SHA256SUMS"; fi
printf 'Backup written to %s\n' "$backup_root"
