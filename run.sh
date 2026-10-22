#!/usr/bin/env bash
# PatchLedger - one-command local startup.
#   ./run.sh            start everything and open the browser
#   ./run.sh --no-open  start without opening a browser
# Everything binds to 127.0.0.1. Ctrl+C stops all services.
set -euo pipefail
cd "$(dirname "$0")"

OPEN_BROWSER=1
for a in "$@"; do
  case "$a" in
    --no-open) OPEN_BROWSER=0 ;;
    -h|--help) sed -n '2,6p' "$0"; exit 0 ;;
    *) echo "Unknown option: $a" >&2; exit 2 ;;
  esac
done
[ "${PL_NO_OPEN:-0}" = "1" ] && OPEN_BROWSER=0

DATA_DIR="${PL_DATA_DIR:-data}"
LOG_DIR="$DATA_DIR/logs"
CHAIN_PID=""
SERVER_PID=""

say()  { printf '\033[1m[patchledger]\033[0m %s\n' "$*"; }
fail() { printf '\033[31m[patchledger] ERROR:\033[0m %s\n' "$*" >&2; exit 1; }

cleanup() {
  trap - INT TERM EXIT
  if [ -n "$SERVER_PID" ] && kill -0 "$SERVER_PID" 2>/dev/null; then kill "$SERVER_PID" 2>/dev/null || true; fi
  if [ -n "$CHAIN_PID" ] && kill -0 "$CHAIN_PID" 2>/dev/null; then kill "$CHAIN_PID" 2>/dev/null || true; fi
  wait 2>/dev/null || true
  say "stopped."
}
trap cleanup EXIT
trap 'cleanup; exit 130' INT
trap 'cleanup; exit 143' TERM

# 1. prerequisites ------------------------------------------------------------
command -v node >/dev/null 2>&1 || fail "Node.js is not installed. Install Node.js 22.18+ (LTS 24 recommended) from https://nodejs.org and re-run."
command -v npm  >/dev/null 2>&1 || fail "npm is not available (it ships with Node.js)."
NODE_OK=$(node -e 'const [a,b]=process.versions.node.split(".").map(Number);console.log(a>22||(a===22&&b>=18)?1:0)')
[ "$NODE_OK" = "1" ] || fail "Node.js $(node -v) is too old. PatchLedger needs Node.js 22.18 or newer (built-in TypeScript execution and node:sqlite)."
say "node $(node -v), npm $(npm -v), $(uname -m)"

# 2. dependencies -------------------------------------------------------------
if [ ! -d node_modules ] || [ package-lock.json -nt node_modules/.package-lock.json ]; then
  say "installing project dependencies locally (npm ci)..."
  npm ci --no-audit --no-fund
fi

mkdir -p "$LOG_DIR"

# 3. compile ------------------------------------------------------------------
say "compiling Solidity contract..."
npx hardhat compile --config hardhat.config.cjs --quiet >"$LOG_DIR/compile.log" 2>&1 || { cat "$LOG_DIR/compile.log"; fail "contract compilation failed (first run needs internet once to download solc 0.8.28)."; }

# ports -----------------------------------------------------------------------
free_port() {
  node -e '
    const net=require("net");
    const tryp=(p)=>new Promise((res,rej)=>{const s=net.createServer();s.once("error",rej);s.listen(p,"127.0.0.1",()=>{const q=s.address().port;s.close(()=>res(q));});});
    tryp(+process.argv[1]).catch(()=>tryp(0)).then((p)=>console.log(p));' "$1"
}
CHAIN_PORT=$(free_port "${PL_CHAIN_PORT:-8545}")
APP_PORT=$(free_port "${PL_PORT:-4600}")
[ "$CHAIN_PORT" = "${PL_CHAIN_PORT:-8545}" ] || say "port ${PL_CHAIN_PORT:-8545} busy; local chain will use $CHAIN_PORT"
[ "$APP_PORT" = "${PL_PORT:-4600}" ] || say "port ${PL_PORT:-4600} busy; application will use $APP_PORT"
RPC_URL="http://127.0.0.1:$CHAIN_PORT"
APP_URL="http://127.0.0.1:$APP_PORT"

# 4. local blockchain ---------------------------------------------------------
say "starting local Hardhat chain on ${RPC_URL}..."
node_modules/.bin/hardhat node --config hardhat.config.cjs --hostname 127.0.0.1 --port "$CHAIN_PORT" >"$LOG_DIR/chain.log" 2>&1 &
CHAIN_PID=$!
for i in $(seq 1 60); do
  if curl -sf -X POST -H 'content-type: application/json' --data '{"jsonrpc":"2.0","id":1,"method":"eth_chainId","params":[]}' "$RPC_URL" >/dev/null 2>&1; then break; fi
  kill -0 "$CHAIN_PID" 2>/dev/null || { tail -20 "$LOG_DIR/chain.log"; fail "the local chain exited during startup."; }
  sleep 0.5
  [ "$i" = 60 ] && fail "the local chain did not respond within 30 s (see $LOG_DIR/chain.log)."
done

# 5. deploy (fresh chain => fresh off-chain store; previous state is archived) --
export PL_DATA_DIR="$DATA_DIR" PL_PORT="$APP_PORT" PL_HOST=127.0.0.1
node scripts/deploy.ts --rpc "$RPC_URL" --fresh

# 6. seed synthetic demo data -------------------------------------------------
node scripts/seed.ts

# 7. frontend + backend -------------------------------------------------------
say "building frontend..."
npx vite build --config web/vite.config.ts --logLevel warn >"$LOG_DIR/web-build.log" 2>&1 || { cat "$LOG_DIR/web-build.log"; fail "frontend build failed."; }
say "starting API + web server..."
node server/index.ts >"$LOG_DIR/server.log" 2>&1 &
SERVER_PID=$!

# 8. wait until responding ------------------------------------------------------
for i in $(seq 1 60); do
  if curl -sf "$APP_URL/api/health" >/dev/null 2>&1; then break; fi
  kill -0 "$SERVER_PID" 2>/dev/null || { tail -20 "$LOG_DIR/server.log"; fail "the server exited during startup."; }
  sleep 0.5
  [ "$i" = 60 ] && fail "the server did not respond within 30 s (see $LOG_DIR/server.log)."
done
curl -sf "$APP_URL/" | grep -q '<div id="root">' || fail "frontend is not being served."

# 9. status -------------------------------------------------------------------
echo
say "PatchLedger is running"
echo "    Application   $APP_URL"
echo "    Public verify $APP_URL/verify"
echo "    Local chain   $RPC_URL  (chain id 31337, in-memory, local only)"
echo "    Contract      $(node -e 'console.log(require(require("path").resolve(process.argv[1])).address)' "$DATA_DIR/deployment.json")"
echo "    Logs          $LOG_DIR/"
echo "    Demo keys are the public Hardhat test keys - never use them on a real network."
echo "    Press Ctrl+C to stop."
echo

# 10. browser -----------------------------------------------------------------
if [ "$OPEN_BROWSER" = "1" ] && command -v open >/dev/null 2>&1; then open "$APP_URL" >/dev/null 2>&1 || true; fi

# keep running until a child exits or the user interrupts
while kill -0 "$CHAIN_PID" 2>/dev/null && kill -0 "$SERVER_PID" 2>/dev/null; do sleep 1; done
kill -0 "$CHAIN_PID" 2>/dev/null || say "the local chain stopped unexpectedly (see $LOG_DIR/chain.log)"
kill -0 "$SERVER_PID" 2>/dev/null || say "the server stopped unexpectedly (see $LOG_DIR/server.log)"
exit 1
