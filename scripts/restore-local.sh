#!/usr/bin/env bash
set -euo pipefail

backup_dir="${1:-}"
restore_state="${RESTORE_PERSIST_TO:-}"
if [[ -z "$backup_dir" || ! -f "$backup_dir/d1-data.sql" ]]; then
  printf 'Usage: CONFIRM_RESTORE=isolated RESTORE_PERSIST_TO=/private/tmp/signal40-restore %s <backup-directory>\n' "$0" >&2
  exit 2
fi
if [[ "${CONFIRM_RESTORE:-}" != "isolated" || -z "$restore_state" ]]; then
  printf 'Restore refused. Set CONFIRM_RESTORE=isolated and an explicit RESTORE_PERSIST_TO.\n' >&2
  exit 3
fi
case "$restore_state" in
  /private/tmp/signal40-*|/tmp/signal40-*) ;;
  *) printf 'Restore target must be an explicit signal40-* directory under /private/tmp or /tmp.\n' >&2; exit 4 ;;
esac
if find "$restore_state" -name '*.sqlite' -print -quit 2>/dev/null | grep -q .; then
  printf 'Restore target already contains a database; refusing to overwrite it.\n' >&2
  exit 5
fi
(cd "$backup_dir" && shasum -a 256 -c SHA256SUMS)
WRANGLER_WRITE_LOGS=false WRANGLER_LOG_PATH=.wrangler/logs MINIFLARE_REGISTRY_PATH=.wrangler/registry \
  npx wrangler d1 migrations apply DB --local --config wrangler.local.jsonc --persist-to "$restore_state"
filtered_data="$restore_state/d1-data-without-managed-internals.sql"
grep -v \
  -e 'INSERT INTO "d1_migrations"' \
  -e 'INSERT INTO "sqlite_stat1"' \
  "$backup_dir/d1-data.sql" > "$filtered_data"
WRANGLER_WRITE_LOGS=false WRANGLER_LOG_PATH=.wrangler/logs MINIFLARE_REGISTRY_PATH=.wrangler/registry \
  npx wrangler d1 execute DB --local --config wrangler.local.jsonc --persist-to "$restore_state" --file "$filtered_data"
printf 'Isolated local D1 restore completed from %s into %s. R2 archive is intentionally not auto-overwritten.\n' "$backup_dir" "$restore_state"
