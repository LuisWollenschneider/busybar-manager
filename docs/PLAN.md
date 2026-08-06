# busybar-manager: plan

## Context

Max has a BUSY Bar and a collection of standalone Python apps (repo `maxswinkels/busybar-apps`; each app POSTs to `/api/display/draw`, USB bar always at `10.0.4.20`, each app accepts `--host`). He wants a manager on his Mac that: can turn multiple apps on/off at once, shows which one is running and which one owns the bar's screen, can set and save named "variations" (presets of argparse options + custom env vars) per app, and automatically starts everything again after a reboot.

Decisions from the round of questions: **new, standalone project** `busybar-manager` (not in the emulator), screen mirror via **firmware streaming** (the bar's own web UI mirrors the screen; firmware: `/api/status/ws` WebSocket streams frames among other things, `/api/screen?display=0` returns a single frame as base64), variations = argparse presets **+ env vars**, deliver to `~/Developer/busybar-manager` on his Mac.

Research (firmware `busy-app/busybar-firmware`) confirms: there is **no** HTTP endpoint that returns the current screen owner (application_name). `canvas_get_app_id` exists but is not exposed via HTTP; the status ws streams frames/power/wifi/etc. but no canvas owner. The firmware returns draw conflicts as `409 "Not drawn due to low priority"`. Therefore:

- **Pixels (what is on the bar)**: ws mirror of the firmware, as Max indicated; also shows the bar's own screens (BUSY timer priority 90, ON CALL priority 50).
- **Owner attribution (which managed app draws)**: the manager runs as a local proxy; apps start with `--host 127.0.0.1:<port>` and the manager forwards to the bar. This way, per `application_name`, he sees which draw got 200 (owner) and which got 409 (blocked). If all managed apps get 409, then a firmware app owns the screen (the mirror shows which one).

## Architecture

```
apps/*.py (python, --host 127.0.0.1:8321)
        │ HTTP
        ▼
  busybar-manager server.js (zero-dep Node ≥22)
        │ proxy /api/* ────────────────▶  BUSY Bar (10.0.4.20 or Wi-Fi host)
        │ ws-client /api/status/ws ◀──── frames (protobuf, BSB_State)
        │ SSE /events
        ▼
  browser: Vue 3 dashboard (web/, Vite)
```

Conventions mirror `busybar-emulator` (Max's own project): single-file zero-dependency Node server, Vue 3 + Vite frontend, SSE to the browser.

## Project structure (`~/Developer/busybar-manager`)

```
server.js            # zero-dep Node: supervisor + proxy + ws-mirror-client + SSE + manager-API
config.json          # (generated) bar-host, apps-dirs, per app: enabled, chosen variation, variations
web/                 # Vite + Vue 3 dashboard (dep: @busy-app/busy-lib for framedecoding/LEDRenderer)
launchd/nl.backspaced.busybar-manager.plist
scripts/install.sh   # launchctl bootstrap gui/$UID …  (RunAtLoad + KeepAlive)
scripts/uninstall.sh
test/mock-bar.js     # mini-bar for tests: draw+priority/409, /api/screen, /api/status/ws
test/run-tests.sh    # end-to-end tests against mock-bar and busybar-emulator
README.md
```

## Components

### 1. server.js (zero-dep, Node ≥22; global `WebSocket` client present)

- **Config** (`config.json`, written atomically): `{ barHost, listenPort, appsDirs: [], apps: { <slug>: { enabled, variation, variations: { <name>: { args: {..}, env: {..}, priority? } }, restart: "always" } } }`. Default `appsDirs` points to Max's clone of `busybar-apps/apps`.
- **Scanner**: find apps in `appsDirs` (directory with `app.py` + `manifest.yaml`, or standalone `.py` file). Auto-detect argparse options the way the emulator does (port of `scanApps` from `busybar-emulator/server.js`, line ±66–160: spawn `python3 - <<parse-script>>` or regex on `add_argument`). The manifest provides name/description/tags.
- **Supervisor**: per enabled app `spawn(python, [app.py, --host, 127.0.0.1:<port>, ...variation-args], { env })`. Per-app venv management with `requirements.txt` carried over from the emulator (sha256 stamp). Restart with exponential backoff; ring buffer (±500 lines) stdout/stderr per app; status: running / stopped / crashed / blocked(409).
- **Proxy**: forward all `/api/*` (except `/api/_manager/*`) to `barHost`. On `POST /api/display/draw`: register `application_name` + result → `screenOwner` = last successful draw (expires after ~10 s without a new draw); inject an optional `priority` override per variation into the payload. Simply pass through 409 responses (the apps already handle that).
- **Mirror**: ws client to `ws://<barHost>/api/status/ws`, send `{"enable": true}` after connect; forward binary protobuf messages as base64 over SSE (`frame` events, throttled ~10 fps). Reconnect with backoff. Fallback: poll `GET /api/screen?display=0` at 1 fps. Decoding happens in the frontend.
- **Manager API**: `GET /api/_manager/state` (apps + status + screenOwner + bar connection), `POST /api/_manager/apps/:slug/enable|disable|restart`, `PUT /api/_manager/apps/:slug/variations[/:name]` (CRUD + selection; switching = restart app), `GET /api/_manager/apps/:slug/log`, `GET /events` (SSE), `PUT /api/_manager/settings` (barHost etc.).

### 2. web/ dashboard (Vue 3 + Vite, style/patterns from the emulator UI)

- At the top: **live mirror** of the bar (canvas 72×16; decode with `@busy-app/busy-lib`: `BSB_Frame`/`LEDRenderer`, same approach as the firmware's `StateScreenStream.vue`) + badge of the current screen owner ("flightradar is drawing" / "firmware app (timer?) owns the screen").
- App list: per app a card with status dot (running/crashed/stopped), "has the screen" highlight, on/off toggle, variation dropdown, button to variation editor and logs.
- Variation editor: form generated from the detected argparse options (type/default/choices), plus free env var lines (key/value) and optional priority override; save as a named preset.
- Logs panel per app (live via SSE).

### 3. Autostart (macOS)

- `launchd/nl.busybar-manager.plist`: `RunAtLoad`, `KeepAlive`, `WorkingDirectory` = project directory, `ProgramArguments` = node + server.js, logs to `logs/`. `install.sh` copies to `~/Library/LaunchAgents/` and runs `launchctl bootstrap gui/$(id -u)`; `uninstall.sh` does the reverse. The manager starts at login/boot → itself starts all enabled apps with their chosen variation.

### 4. Verification

1. **Cloud, mock bar** (`test/mock-bar.js`: draw with firmware-faithful priority rules/409, `/api/screen`, `/api/status/ws` that streams test frames): e2e script starts manager + 2 dummy apps with different priorities → assert: both running, correct `screenOwner`, 409 attribution, variation switch restarts with new args/env, crash → restart with backoff, config survives a restart of the manager.
2. **Cloud, real emulator**: run `busybar-emulator` (already cloned in /tmp; zero-dep) as the bar host, run `clock` + `pixel-fire` from busybar-apps against it via the manager → validate priority/409 behavior against Max's own firmware-faithful implementation (the emulator has no ws/screen endpoint; there the mirror falls back to "no mirror available").
3. **At Max's**: delivery to `~/Developer/busybar-manager` (request folder access to `~/Developer`), run `scripts/install.sh`, open the dashboard, check mirror + owner detection against the real bar; reboot test by Max.

## Execution (after approval)

- Request folder access to `~/Developer` (exists; contains busybar-apps and busybar-emulator) to deliver the project.
- Implementation delegated to **cheaper models** (sonnet subagents): (1) server.js + mock-bar + tests, (2) web/ dashboard, (3) launchd + scripts + README, with Fable 5 as orchestrator/reviewer; e2e tests run in the cloud before delivery.
- Reference code is cloned: `/tmp/busybar-apps`, `/tmp/busybar-emulator` (scanner/venv/SSE patterns to reuse), `/tmp/busybar-firmware` (API source of truth: `applications/services/web_server/openapi/*.yaml`, `state_publisher/`).
