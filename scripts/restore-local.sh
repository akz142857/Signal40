#!/usr/bin/env bash
# 把备份恢复到一个隔离的数据库里。
#
# 恢复是破坏性操作，这里的守卫刻意做得很硬：必须显式 CONFIRM_RESTORE=isolated，
# 必须指定目标库名，且库名必须以 signal40_restore_ 开头——
# 不可能因为少设一个变量就把生产库覆盖掉。
set -euo pipefail

script_dir="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
# shellcheck source=scripts/lib-pg.sh
source "$script_dir/lib-pg.sh"
require_database_url

backup_dir="${1:-}"
target_db="${RESTORE_TARGET_DB:-}"

if [[ -z "$backup_dir" || ! -f "$backup_dir/database.dump" ]]; then
  printf '用法：CONFIRM_RESTORE=isolated RESTORE_TARGET_DB=signal40_restore_drill %s <backup-directory>\n' "$0" >&2
  exit 2
fi
if [[ "${CONFIRM_RESTORE:-}" != "isolated" || -z "$target_db" ]]; then
  printf '拒绝恢复。必须同时设置 CONFIRM_RESTORE=isolated 和 RESTORE_TARGET_DB。\n' >&2
  exit 3
fi
case "$target_db" in
  signal40_restore_*) ;;
  *) printf '恢复目标库名必须以 signal40_restore_ 开头，拿到的是 %s。\n' "$target_db" >&2; exit 4 ;;
esac

(cd "$backup_dir" && shasum -a 256 -c SHA256SUMS)

backup_abs="$(cd "$backup_dir" && pwd)"
admin_url="$(pg_url_for_tool psql "$DATABASE_URL")"
# 连到 postgres 维护库来建目标库；目标库已存在就拒绝，不覆盖任何东西。
maintenance_url="${admin_url%/*}/postgres"

exists="$(PG_WORK_DIR="$backup_abs" pg_run psql --dbname="$maintenance_url" -tAc \
  "SELECT 1 FROM pg_database WHERE datname = '$target_db'")"
if [[ -n "$exists" ]]; then
  printf '目标库 %s 已存在，拒绝覆盖。\n' "$target_db" >&2
  exit 5
fi
PG_WORK_DIR="$backup_abs" pg_run psql --dbname="$maintenance_url" -c "CREATE DATABASE \"$target_db\""

restore_url="${admin_url%/*}/$target_db"
dump_path="$(command -v pg_restore >/dev/null 2>&1 && printf '%s' "$backup_abs/database.dump" || printf '/work/database.dump')"
# 新版 pg_dump 会写入旧服务端尚不认识的会话参数（例如 PG18 dump → PG16 的
# transaction_timeout）。先生成 SQL 并只删除这个向后不兼容的 SET，再让 psql
# 以 ON_ERROR_STOP 恢复；真实 DDL/DML 的任何错误仍会立即失败。
PG_WORK_DIR="$backup_abs" pg_run pg_restore --no-owner --no-privileges --file=- "$dump_path" \
  | sed '/^SET transaction_timeout =/d' \
  | PG_WORK_DIR="$backup_abs" pg_run psql --set=ON_ERROR_STOP=1 --dbname="$restore_url"

printf '已从 %s 恢复到隔离库 %s。对象存储未被自动覆盖。\n' "$backup_dir" "$target_db"
