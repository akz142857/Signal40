#!/usr/bin/env bash
# 一条命令拉起本机全套常驻进程：控制面、来源 Worker、渲染 Worker、调度器。
#
# 少起一个 Worker 不会报错，只会让作业永远没人领（来源 Worker 只领 ingestion，
# 渲染 Worker 只领 voice/preview/render/publish），所以这里把四个进程绑在一起：
# 要么都活着，要么一起退出，避免出现「半套系统在跑」这种不易察觉的状态。
#
# 用法：
#   make up                 # 开发模式（vinext dev，改代码热更）
#   make up MODE=start      # 跑已构建产物（先 make build）
#   HOST=0.0.0.0 SIGNAL40_ALLOW_LOCAL_ROLE_HEADERS=false make up   # 对外监听必须关掉角色伪造

set -euo pipefail

ROOT="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
cd "$ROOT"

# shellcheck source=scripts/lib-pg.sh
source "$ROOT/scripts/lib-pg.sh"

MODE="${MODE:-dev}"
HOST="${HOST:-127.0.0.1}"
PORT="${PORT:-3001}"
# 控制面地址由本次实际监听的地址决定，并覆盖 .env 里的值导出给 Worker 和调度器——
# 否则用 PORT=<其他端口> 起的这一套，Worker 会去连 .env 里写死的那一套。
CONTROL_URL="http://$HOST:$PORT"
export SIGNAL40_CONTROL_URL="$CONTROL_URL"
HEALTH_TIMEOUT_SECONDS="${HEALTH_TIMEOUT_SECONDS:-90}"

if [[ "$MODE" != "dev" && "$MODE" != "start" ]]; then
  echo "MODE 只能是 dev 或 start，收到：$MODE" >&2
  exit 2
fi

# 监听非回环地址会把控制面暴露到局域网，而本机开发模式默认允许用
# x-signal-role 请求头伪造角色，且 isLocalRequest 判的是 Host 头而不是对端地址——
# 同网段任何人发一个 Host: localhost 加一个角色头就是管理员。
# 所以要往外监听就必须显式关掉角色伪造。
if [[ "${HOST}" != "127.0.0.1" && "${HOST}" != "localhost" && "${HOST}" != "::1" ]]; then
  if [[ "${SIGNAL40_ALLOW_LOCAL_ROLE_HEADERS:-true}" != "false" ]]; then
    echo "HOST=${HOST} 会把控制面暴露到回环之外，而本机角色伪造仍然开着。" >&2
    echo "要这么做请显式设置 SIGNAL40_ALLOW_LOCAL_ROLE_HEADERS=false 再重试。" >&2
    exit 1
  fi
fi

# 端口被占着通常意味着已经有一套在跑；直接起会得到一个连不上控制面的 Worker 群。
if nc -z "$HOST" "$PORT" >/dev/null 2>&1; then
  echo "$HOST:$PORT 已被占用——可能已经有一套控制面在跑。先停掉它，或用 PORT=<其他端口> 重试。" >&2
  exit 1
fi

if [[ "$MODE" == "start" && ! -d "$ROOT/.vinext" ]]; then
  echo "MODE=start 需要已构建产物，但 .vinext 不存在。先运行 make build。" >&2
  exit 1
fi

if [[ -z "${SIGNAL40_AUTOMATION_ACTOR_ID:-}" ]]; then
  echo "提示：SIGNAL40_AUTOMATION_ACTOR_ID 未设置，调度器会照常运行但不写入任何内容。" >&2
fi

# 所有子进程放进同一个进程组，Ctrl-C 或任一进程退出时整组带走。
PIDS=()
NAMES=()
shutting_down=0

shutdown() {
  [[ "$shutting_down" == 1 ]] && return
  shutting_down=1
  trap '' INT TERM
  echo ""
  echo "[dev-up] 正在停止全部进程…"
  if (( ${#PIDS[@]} > 0 )); then
    for pid in "${PIDS[@]}"; do
      kill -TERM "-$pid" 2>/dev/null || kill -TERM "$pid" 2>/dev/null || true
    done
  fi
  wait 2>/dev/null || true
  echo "[dev-up] 已全部停止。"
}
trap shutdown INT TERM EXIT

# 带前缀转发子进程输出，方便在一个终端里分辨是谁在说话。
# 用 awk 而不是 sed -u：行缓冲的 sed 是 GNU 扩展，BSD sed 上拼不出来。
# set -m 让每个后台任务自成进程组，停止时可以按组带走 npm 和它 fork 的 node。
spawn() {
  local name="$1"; shift
  set -m
  ( "$@" 2>&1 | awk -v prefix="[$name] " '{print prefix $0; fflush()}' ) &
  local pid=$!
  set +m
  PIDS[${#PIDS[@]}]="$pid"
  NAMES[${#NAMES[@]}]="$name"
}

echo "[dev-up] 迁移数据库…"
npm run db:migrate

echo "[dev-up] 启动控制面（${MODE}，$HOST:${PORT}）…"
if [[ "$MODE" == "dev" ]]; then
  spawn control npm run dev -- --hostname "$HOST" --port "$PORT"
else
  spawn control npm run start -- --hostname "$HOST" --port "$PORT"
fi

# Worker 和调度器都依赖控制面；控制面没起来就先等，省得刷一屏连接失败。
echo "[dev-up] 等待 $CONTROL_URL/api/v1/health …"
deadline=$((SECONDS + HEALTH_TIMEOUT_SECONDS))
until curl -fsS --max-time 2 "$CONTROL_URL/api/v1/health" >/dev/null 2>&1; do
  if (( SECONDS >= deadline )); then
    echo "[dev-up] 控制面在 ${HEALTH_TIMEOUT_SECONDS}s 内没有就绪，退出。" >&2
    exit 1
  fi
  # 控制面已经死了就不用再等了。
  if ! kill -0 "${PIDS[0]}" 2>/dev/null; then
    echo "[dev-up] 控制面进程已退出，退出。" >&2
    exit 1
  fi
  sleep 1
done
echo "[dev-up] 控制面已就绪。"

spawn source-worker npm run worker:source
spawn render-worker npm run worker:render
spawn scheduler npm run scheduler

echo "[dev-up] 全部就绪：控制面 ${CONTROL_URL}、来源 Worker、渲染 Worker、调度器。Ctrl-C 停止全部。"

# 任一进程退出就整组停下——半套系统跑着比直接挂掉更难排查。
# 这里轮询而不是 `wait -n`：后者要 bash 4.3+，而 macOS 自带的仍是 3.2。
while :; do
  for i in "${!PIDS[@]}"; do
    if ! kill -0 "${PIDS[$i]}" 2>/dev/null; then
      echo "[dev-up] ${NAMES[$i]} 已退出，停止其余进程。" >&2
      exit 1
    fi
  done
  sleep 1
done
