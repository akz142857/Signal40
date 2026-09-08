#!/usr/bin/env bash
# 备份控制面数据库（以及可选的对象存储清单）。
#
# 数据库用 pg_dump 的 custom 格式，便于按表选择性恢复；
# 对象存储只做清单快照——真正的对象副本应该交给桶的版本控制与跨区复制，
# 而不是靠一个本地脚本搬 TB 级成片。
set -euo pipefail

script_dir="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
# shellcheck source=scripts/lib-pg.sh
source "$script_dir/lib-pg.sh"
require_database_url

backup_root="${1:-backups/$(date -u +%Y%m%dT%H%M%SZ)}"
mkdir -p "$backup_root"
backup_abs="$(cd "$backup_root" && pwd)"

# 容器回退时 dump 路径要写成容器内的挂载路径。
if command -v pg_dump >/dev/null 2>&1; then
  dump_path="$backup_abs/database.dump"
else
  dump_path="/work/database.dump"
fi

PG_WORK_DIR="$backup_abs" pg_run pg_dump \
  --dbname="$(pg_url_for_tool pg_dump "$DATABASE_URL")" \
  --format=custom --no-owner --no-privileges \
  --file="$dump_path"

if [[ -n "${S3_BUCKET:-}" ]] && command -v aws >/dev/null 2>&1; then
  aws ${S3_ENDPOINT:+--endpoint-url "$S3_ENDPOINT"} s3 ls "s3://$S3_BUCKET" --recursive \
    > "$backup_abs/object-inventory.txt" 2>/dev/null \
    || printf '对象清单获取失败，已跳过。\n' >&2
fi

(
  cd "$backup_abs"
  : > SHA256SUMS
  for file in database.dump object-inventory.txt; do
    if [[ -f "$file" ]]; then
      shasum -a 256 "$file" >> SHA256SUMS
    fi
  done
)
printf 'Backup written to %s\n' "$backup_abs"
