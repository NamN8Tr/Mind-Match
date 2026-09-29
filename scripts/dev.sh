#!/usr/bin/env bash
#
# Launch the whole Smart Rot dev stack:
#   C++ Spider solver worker (tools/spider-solver)
#   -> Postgres + Redis (docker compose, or whatever is already listening)
#   -> Prisma client + migrations
#   -> Fastify REST :4000 + Colyseus WS :4001
#   -> Next.js :3000
#
# Sign in as a fixed Clerk test user, e.g. smartrot-player-one+clerk_test@example.com
# (or player-two), with verification code 424242. See docs/PROJECT_CONTEXT.md.
#
# Ctrl-C stops everything it started.
#
#   ./scripts/dev.sh                  full launch
#   ./scripts/dev.sh --skip-migrate   don't touch the database schema
#   ./scripts/dev.sh --skip-install   don't run pnpm install
#   ./scripts/dev.sh --server-only    no Next.js
#   ./scripts/dev.sh --web-only       no backend
#   ./scripts/dev.sh --restart        take over ports already in use
#
# PORT / COLYSEUS_PORT / WEB_PORT from the environment override apps/server/.env.
set -euo pipefail

ROOT="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
cd "$ROOT"

SKIP_INSTALL=0
SKIP_MIGRATE=0
RUN_SERVER=1
RUN_WEB=1
RESTART=0
ENV_PORT=${PORT-}; ENV_COLYSEUS_PORT=${COLYSEUS_PORT-}; ENV_WEB_PORT=${WEB_PORT-}

while [[ $# -gt 0 ]]; do
  case "$1" in
    --skip-install) SKIP_INSTALL=1 ;;
    --skip-migrate) SKIP_MIGRATE=1 ;;
    --server-only)  RUN_WEB=0 ;;
    --web-only)     RUN_SERVER=0; SKIP_MIGRATE=1 ;;
    --restart)      RESTART=1 ;;
    -h|--help)      awk 'NR>1 && /^#/ { sub(/^# ?/, ""); print; next } NR>1 { exit }' "$0"; exit 0 ;;
    *) echo "unknown option: $1 (try --help)" >&2; exit 2 ;;
  esac
  shift
done

if [[ -t 1 ]]; then
  C_RESET=$'\033[0m'; C_DIM=$'\033[2m'; C_BOLD=$'\033[1m'
  C_RED=$'\033[31m'; C_GREEN=$'\033[32m'; C_YELLOW=$'\033[33m'
  C_BLUE=$'\033[34m'; C_MAGENTA=$'\033[35m'
else
  C_RESET=''; C_DIM=''; C_BOLD=''; C_RED=''; C_GREEN=''; C_YELLOW=''; C_BLUE=''; C_MAGENTA=''
fi

step() { printf '%s==>%s %s\n' "$C_BOLD$C_BLUE" "$C_RESET" "$*"; }
ok()   { printf '  %s✓%s %s\n' "$C_GREEN" "$C_RESET" "$*"; }
warn() { printf '  %s!%s %s\n' "$C_YELLOW" "$C_RESET" "$*"; }
die()  { printf '  %s✗%s %s\n' "$C_RED" "$C_RESET" "$*" >&2; exit 1; }

# ---------------------------------------------------------------- child procs
PIDS=()  # every dev server started here, for cleanup

kill_tree() { # kill a pid and everything it spawned (tsx/next fork children)
  local pid=$1 child
  for child in $(pgrep -P "$pid" 2>/dev/null || true); do kill_tree "$child"; done
  kill -TERM "$pid" 2>/dev/null || true
}

cleanup() {
  trap - INT TERM EXIT
  if [[ ${#PIDS[@]-0} -gt 0 ]]; then
    printf '\n%s==>%s shutting down\n' "$C_BOLD$C_BLUE" "$C_RESET"
    for pid in ${PIDS[@]+"${PIDS[@]}"}; do kill_tree "$pid"; done
    wait 2>/dev/null || true
  fi
}
trap cleanup INT TERM EXIT

# Run a command with every output line tagged, so two dev servers in one
# terminal stay readable.
run_tagged() {
  local label=$1 color=$2; shift 2
  ( "$@" 2>&1 | awk -v p="${color}[${label}]${C_RESET} " '{ print p $0; fflush() }' ) &
  PIDS[${#PIDS[@]-0}]=$!
}

port_busy() { lsof -nP -iTCP:"$1" -sTCP:LISTEN >/dev/null 2>&1; }

wait_for_http() { # url, label, timeout seconds
  local url=$1 label=$2 timeout=${3:-60} waited=0
  while ! curl -fsS -o /dev/null --max-time 2 "$url" 2>/dev/null; do
    sleep 1; waited=$((waited + 1))
    if [[ $waited -ge $timeout ]]; then warn "$label did not answer $url within ${timeout}s"; return 1; fi
    # a dev server that died takes its tag process with it
    for pid in ${PIDS[@]+"${PIDS[@]}"}; do
      kill -0 "$pid" 2>/dev/null || { warn "$label exited during startup"; return 1; }
    done
  done
  ok "$label ready — $url"
}

# ------------------------------------------------------------------ toolchain
step "Checking toolchain"
command -v node >/dev/null || die "node not found (need >= 20)"
command -v pnpm >/dev/null || die "pnpm not found — npm i -g pnpm@11"
node_major=$(node -p 'process.versions.node.split(".")[0]')
[[ $node_major -ge 20 ]] || die "node >= 20 required, found $(node -v)"
ok "node $(node -v), pnpm $(pnpm -v)"

if [[ $RUN_SERVER -eq 1 ]]; then
  command -v c++ >/dev/null || die "C++17 compiler not found — required for the Spider board worker"
  step "Building Spider solver worker"
  sh tools/spider-solver/build.sh
  ok "Spider solver worker ready"
fi

# ------------------------------------------------------------------------ env
step "Checking env files"
for pair in "apps/server/.env:apps/server/.env.example" "apps/web/.env.local:apps/web/.env.example"; do
  target=${pair%%:*}; example=${pair##*:}
  if [[ ! -f $target ]]; then
    cp "$example" "$target"
    warn "created $target from $example — fill in real Clerk keys before signing in"
  fi
done
if grep -q 'xxxxxxxx' apps/server/.env apps/web/.env.local 2>/dev/null; then
  warn "placeholder Clerk keys still present; auth will fail until they are replaced"
else
  ok "apps/server/.env and apps/web/.env.local present"
fi

# Read the handful of settings this script needs out of apps/server/.env.
# (Deliberately not `source`-ing the file: macOS ships bash 3.2, and the server
# itself loads .env through dotenv anyway.)
env_value() {
  local key=$1 line value
  line=$(grep -E "^[[:space:]]*${key}=" apps/server/.env 2>/dev/null | tail -1) || true
  value=${line#*=}
  value=${value%$'\r'}
  value=${value%\"}; value=${value#\"}
  value=${value%\'}; value=${value#\'}
  printf '%s' "$value"
}

DATABASE_URL=$(env_value DATABASE_URL)
REDIS_URL=$(env_value REDIS_URL)
PORT=$(env_value PORT)
COLYSEUS_PORT=$(env_value COLYSEUS_PORT)
WEB_ORIGIN=$(env_value WEB_ORIGIN)
DATABASE_URL=${DATABASE_URL:-postgresql://smartrot:smartrot@localhost:5432/smartrot}
REDIS_URL=${REDIS_URL:-redis://localhost:6379}
PORT=${ENV_PORT:-${PORT:-4000}}
COLYSEUS_PORT=${ENV_COLYSEUS_PORT:-${COLYSEUS_PORT:-4001}}
WEB_PORT=$(printf '%s' "${WEB_ORIGIN:-http://localhost:3000}" | sed -E 's#.*:([0-9]+).*#\1#')
[[ $WEB_PORT =~ ^[0-9]+$ ]] || WEB_PORT=3000
WEB_PORT=${ENV_WEB_PORT:-$WEB_PORT}

# The child processes inherit these; dotenv leaves an already-set variable alone,
# so an override here beats the value in .env.
export PORT COLYSEUS_PORT

# ----------------------------------------------------------------- infra deps
if [[ $RUN_SERVER -eq 1 ]]; then
  step "Checking Postgres and Redis"

  pg_host=$(printf '%s' "$DATABASE_URL" | sed -E 's#.*@([^:/]+).*#\1#'); pg_host=${pg_host:-localhost}
  pg_port=$(printf '%s' "$DATABASE_URL" | sed -E 's#.*@[^:]+:([0-9]+).*#\1#'); [[ $pg_port =~ ^[0-9]+$ ]] || pg_port=5432
  redis_port=$(printf '%s' "${REDIS_URL:-redis://localhost:6379}" | sed -E 's#.*:([0-9]+).*#\1#'); [[ $redis_port =~ ^[0-9]+$ ]] || redis_port=6379

  pg_up()    { pg_isready -h "$pg_host" -p "$pg_port" >/dev/null 2>&1 || port_busy "$pg_port"; }
  redis_up() { [[ "$(redis-cli -p "$redis_port" ping 2>/dev/null)" == PONG ]] || port_busy "$redis_port"; }

  if ! pg_up || ! redis_up; then
    if docker compose version >/dev/null 2>&1; then
      step "Starting Postgres + Redis via docker compose"
      docker compose up -d
    elif command -v brew >/dev/null 2>&1; then
      pg_up    || brew services start postgresql@14 >/dev/null 2>&1 || true
      redis_up || brew services start redis >/dev/null 2>&1 || true
    fi
    waited=0
    until pg_up && redis_up; do
      sleep 1; waited=$((waited + 1))
      [[ $waited -ge 45 ]] && die "Postgres ($pg_host:$pg_port) and/or Redis (:$redis_port) never came up — start them and re-run"
    done
  fi
  ok "Postgres $pg_host:$pg_port, Redis :$redis_port"
fi

# -------------------------------------------------------------------- install
if [[ $SKIP_INSTALL -eq 0 ]]; then
  step "Installing dependencies"
  pnpm install
else
  warn "skipping pnpm install"
fi

# ----------------------------------------------------------- prisma + schema
if [[ $RUN_SERVER -eq 1 && $SKIP_MIGRATE -eq 0 ]]; then
  step "Applying migrations and generating the Prisma client"
  pnpm --filter @smart-rot/server exec prisma migrate deploy
  pnpm --filter @smart-rot/server exec prisma generate
  ok "database schema up to date"
elif [[ $RUN_SERVER -eq 1 ]]; then
  warn "skipping migrations — generating the Prisma client only"
  pnpm --filter @smart-rot/server exec prisma generate >/dev/null
fi

# --------------------------------------------------------------- port checks
for p in $([[ $RUN_SERVER -eq 1 ]] && echo "$PORT $COLYSEUS_PORT") $([[ $RUN_WEB -eq 1 ]] && echo "$WEB_PORT"); do
  port_busy "$p" || continue
  if [[ $RESTART -eq 1 ]]; then
    warn "port $p in use — stopping the process holding it"
    lsof -t -nP -iTCP:"$p" -sTCP:LISTEN | while read -r stale; do kill_tree "$stale"; done
    waited=0
    while port_busy "$p"; do
      sleep 1; waited=$((waited + 1))
      [[ $waited -ge 10 ]] && die "port $p still held after 10s"
    done
  else
    die "port $p is already in use — re-run with --restart, or stop it yourself (lsof -nP -iTCP:$p -sTCP:LISTEN)"
  fi
done

# -------------------------------------------------------------- dev servers
step "Starting dev servers"
FAILED=0
if [[ $RUN_SERVER -eq 1 ]]; then
  run_tagged server "$C_MAGENTA" pnpm --filter @smart-rot/server dev
  wait_for_http "http://localhost:${PORT}/health" "REST API" 60 || FAILED=1
  printf '  %s·%s Colyseus WS — ws://localhost:%s\n' "$C_DIM" "$C_RESET" "$COLYSEUS_PORT"
fi
if [[ $RUN_WEB -eq 1 ]]; then
  run_tagged web "$C_BLUE" pnpm --filter @smart-rot/web dev --port "$WEB_PORT"
  wait_for_http "http://localhost:${WEB_PORT}" "Next.js" 90 || FAILED=1
fi

if [[ $FAILED -eq 0 ]]; then
  printf '\n%sSmart Rot is up%s  →  %shttp://localhost:%s%s   %s(Ctrl-C stops everything)%s\n\n' \
    "$C_BOLD$C_GREEN" "$C_RESET" "$C_BOLD" "$WEB_PORT" "$C_RESET" "$C_DIM" "$C_RESET"
else
  printf '\n%sSomething did not come up%s — see the tagged output above. %s(Ctrl-C to stop the rest.)%s\n' \
    "$C_BOLD$C_YELLOW" "$C_RESET" "$C_DIM" "$C_RESET"
  printf '%sA dev server already running elsewhere is the usual cause; --restart takes the ports over.%s\n\n' \
    "$C_DIM" "$C_RESET"
fi

wait
