#!/usr/bin/env bash
# PostgreSQL 客户端工具的调用封装。
#
# 开发机上不一定装了 pg_dump/pg_restore/psql；装了就直接用，没装就落到
# 与服务端同版本的容器镜像。容器里访问宿主机上的数据库需要把回环地址换成
# host.docker.internal，这一步也在这里统一做掉，调用方不用关心。

set -euo pipefail

# shell 脚本不像 node 那样有 --env-file，这里自己加载仓库根目录的 .env，
# 让 `npm run drill:restore` 只依赖那一个配置文件。已导出的变量优先。
load_repo_env() {
  local root key value
  root="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
  [[ -f "$root/.env" ]] || return 0
  while IFS='=' read -r key value; do
    [[ "$key" =~ ^[A-Za-z_][A-Za-z0-9_]*$ ]] || continue
    # 已经在环境里的变量优先，不被 .env 覆盖。
    [[ -n "${!key:-}" ]] && continue
    value="${value%\"}"; value="${value#\"}"
    value="${value%\'}"; value="${value#\'}"
    export "$key=$value"
  done < <(grep -vE '^[[:space:]]*(#|$)' "$root/.env")
}
load_repo_env

PG_CLIENT_IMAGE="${PG_CLIENT_IMAGE:-postgres:16-alpine}"

# 把宿主机回环地址改写成容器内可达的地址。
container_database_url() {
  printf '%s' "$1" | sed -e 's#@127\.0\.0\.1:#@host.docker.internal:#' -e 's#@localhost:#@host.docker.internal:#'
}

# pg_run <工具名> [参数...]
# 需要读写文件的工具，把宿主目录挂到容器的 /work，参数里用 /work/... 引用。
pg_run() {
  local tool="$1"; shift
  if command -v "$tool" >/dev/null 2>&1; then
    "$tool" "$@"
    return
  fi
  if ! command -v docker >/dev/null 2>&1; then
    printf '%s 不在 PATH 上，且没有 docker 可用作回退。\n' "$tool" >&2
    return 127
  fi
  docker run --rm \
    -e PGPASSWORD \
    -v "${PG_WORK_DIR:-$PWD}:/work" \
    -w /work \
    --add-host host.docker.internal:host-gateway \
    "$PG_CLIENT_IMAGE" "$tool" "$@"
}

# 供调用方使用：容器回退时需要改写过的 URL。
pg_url_for_tool() {
  local tool="$1" url="$2"
  if command -v "$tool" >/dev/null 2>&1; then
    printf '%s' "$url"
  else
    container_database_url "$url"
  fi
}

require_database_url() {
  if [[ -z "${DATABASE_URL:-}" ]]; then
    printf '环境变量 DATABASE_URL 必填。\n' >&2
    exit 2
  fi
}
