#!/usr/bin/env bash
# 恢复演练：备份 → 恢复到隔离库 → 逐表比对行数 → 清理隔离库。
# 全程不触碰源库。
set -euo pipefail

script_dir="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
# shellcheck source=scripts/lib-pg.sh
source "$script_dir/lib-pg.sh"
require_database_url

drill_root="$(mktemp -d "${TMPDIR:-/tmp}/signal40-restore-drill.XXXXXX")"
target_db="signal40_restore_drill_$(date -u +%Y%m%d%H%M%S)"
maintenance_url="${DATABASE_URL%/*}/postgres"

cleanup() {
  PG_WORK_DIR="$drill_root" pg_run psql \
    --dbname="$(pg_url_for_tool psql "$maintenance_url")" \
    -c "DROP DATABASE IF EXISTS \"$target_db\"" >/dev/null 2>&1 || true
  rm -rf "$drill_root"
}
trap cleanup EXIT

backup_dir="$drill_root/backup"
"$script_dir/backup-local.sh" "$backup_dir"
(cd "$backup_dir" && shasum -a 256 -c SHA256SUMS)

CONFIRM_RESTORE=isolated RESTORE_TARGET_DB="$target_db" "$script_dir/restore-local.sh" "$backup_dir"

node --experimental-strip-types "$script_dir/verify-restored-pg.ts" \
  "$DATABASE_URL" "${DATABASE_URL%/*}/$target_db"

printf '隔离恢复演练通过；源库未被修改。\n'
