#!/usr/bin/env bash
# Best-effort smoke test against Max's real busybar-emulator (not part of
# `npm test` / run-tests.sh — the emulator lives outside this repo).
#
# Builds the emulator's web UI if needed, starts it as the "bar", points a
# manager instance at it with the real `clock` app copied into a temp
# appsDir, enables it, and checks that a 200 draw lands (screenOwner=clock).
set -euo pipefail

EMULATOR_DIR="${BUSYBAR_EMULATOR_DIR:-/tmp/busybar-emulator}"
APPS_SRC="${BUSYBAR_APPS_DIR:-/tmp/busybar-apps/apps}"
ROOT="$(cd "$(dirname "$0")/.." && pwd)"

if [ ! -d "$EMULATOR_DIR" ]; then
  echo "smoke-emulator: $EMULATOR_DIR not found, skipping." >&2
  exit 0
fi
if [ ! -d "$APPS_SRC/clock" ]; then
  echo "smoke-emulator: $APPS_SRC/clock not found, skipping." >&2
  exit 0
fi

if [ ! -f "$EMULATOR_DIR/web/dist/index.html" ]; then
  echo "smoke-emulator: building emulator web UI..."
  (cd "$EMULATOR_DIR/web" && npm install && npm run build)
fi

TMP_DIR="$(mktemp -d)"
cleanup() {
  [ -n "${MANAGER_PID:-}" ] && kill -9 "$MANAGER_PID" 2>/dev/null || true
  [ -n "${EMULATOR_PID:-}" ] && kill -9 "$EMULATOR_PID" 2>/dev/null || true
  rm -rf "$TMP_DIR"
}
trap cleanup EXIT

APPS_DIR="$TMP_DIR/apps"
mkdir -p "$APPS_DIR"
cp -r "$APPS_SRC/clock" "$APPS_DIR/clock"

EMULATOR_PORT=18080
MANAGER_PORT=18321

echo "smoke-emulator: starting emulator on :$EMULATOR_PORT"
PORT="$EMULATOR_PORT" node "$EMULATOR_DIR/server.js" >"$TMP_DIR/emulator.log" 2>&1 &
EMULATOR_PID=$!

for i in $(seq 1 50); do
  curl -sf "http://127.0.0.1:$EMULATOR_PORT/api/version" >/dev/null 2>&1 && break
  sleep 0.2
done
curl -sf "http://127.0.0.1:$EMULATOR_PORT/api/version" >/dev/null || { echo "emulator did not come up"; cat "$TMP_DIR/emulator.log"; exit 1; }

CONFIG_PATH="$TMP_DIR/config.json"
cat > "$CONFIG_PATH" <<JSON
{
  "listenPort": $MANAGER_PORT,
  "barHost": "127.0.0.1:$EMULATOR_PORT",
  "appsDirs": ["$APPS_DIR"],
  "apps": {}
}
JSON

echo "smoke-emulator: starting manager on :$MANAGER_PORT"
BUSYBAR_MANAGER_CONFIG="$CONFIG_PATH" node "$ROOT/server.js" >"$TMP_DIR/manager.log" 2>&1 &
MANAGER_PID=$!

for i in $(seq 1 50); do
  curl -sf "http://127.0.0.1:$MANAGER_PORT/health" >/dev/null 2>&1 && break
  sleep 0.2
done
curl -sf "http://127.0.0.1:$MANAGER_PORT/health" >/dev/null || { echo "manager did not come up"; cat "$TMP_DIR/manager.log"; exit 1; }

echo "smoke-emulator: enabling clock"
curl -sf -X POST "http://127.0.0.1:$MANAGER_PORT/api/_manager/apps/clock/enable" >/dev/null

OK=""
for i in $(seq 1 40); do
  OWNER="$(curl -sf "http://127.0.0.1:$MANAGER_PORT/api/_manager/state" | node -e '
    let d=""; process.stdin.on("data",c=>d+=c); process.stdin.on("end",()=>{
      try { const s=JSON.parse(d); console.log(s.screenOwner ? s.screenOwner.applicationName : ""); } catch(e){ console.log(""); }
    });
  ')"
  if [ "$OWNER" = "clock" ]; then OK=1; break; fi
  sleep 0.5
done

if [ -z "$OK" ]; then
  echo "smoke-emulator: FAIL — screenOwner never became 'clock'"
  echo "--- manager log ---"; tail -40 "$TMP_DIR/manager.log"
  echo "--- emulator log ---"; tail -40 "$TMP_DIR/emulator.log"
  exit 1
fi

echo "smoke-emulator: OK — clock owns the screen on the real emulator"
