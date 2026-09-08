#!/usr/bin/env bash
set -euo pipefail

drill_root="$(mktemp -d /private/tmp/signal40-restore-drill.XXXXXX)"
cleanup() { rm -rf "$drill_root"; }
trap cleanup EXIT

backup_dir="$drill_root/backup"
restore_state="$drill_root/restored-state"
./scripts/backup-local.sh "$backup_dir"
(cd "$backup_dir" && shasum -a 256 -c SHA256SUMS)

CONFIRM_RESTORE=isolated RESTORE_PERSIST_TO="$restore_state" ./scripts/restore-local.sh "$backup_dir"

source_db="$(find .wrangler/state/v3/d1 -name '*.sqlite' ! -name 'metadata.sqlite' -print -quit)"
restored_db="$(find "$restore_state/v3/d1" -name '*.sqlite' ! -name 'metadata.sqlite' -print -quit)"
if [[ -z "$source_db" || -z "$restored_db" ]]; then
  printf 'Restore drill could not locate source or restored D1 database.\n' >&2
  exit 4
fi

node --experimental-strip-types scripts/verify-restored-d1.ts "$source_db" "$restored_db"
if [[ -f "$backup_dir/local-r2-state.tar.gz" ]]; then
  mkdir -p "$drill_root/restored-r2"
  tar -xzf "$backup_dir/local-r2-state.tar.gz" -C "$drill_root/restored-r2"
fi
printf 'Isolated D1/R2 restore drill passed; production state was not modified.\n'
