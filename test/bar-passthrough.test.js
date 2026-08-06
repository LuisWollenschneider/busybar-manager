"use strict";
/*
 * busybar-manager /api/_bar/* streaming passthrough tests (docs/CONTRACT.md,
 * "Bar-passthrough /api/_bar/*"). Exists because the emulator's own mirror
 * has no /api/status/ws and no /api/screen, only a long-lived GET /events
 * SSE stream — the manager needs a same-origin, GET-only, unbuffered pipe
 * to it so the frontend can EventSource() it without CORS/hop issues.
 *
 * Uses test/mock-bar.js's GET /events (added alongside its draw/version/
 * screen routes) as the fake bar's SSE stream.
 */
const assert = require("assert/strict");
const { spawn } = require("child_process");
const fs = require("fs");
const os = require("os");
const path = require("path");
const net = require("net");

const ROOT = path.join(__dirname, "..");

function freePort() {
  return new Promise((resolve, reject) => {
    const srv = net.createServer();
    srv.listen(0, "127.0.0.1", () => {
      const port = srv.address().port;
      srv.close(() => resolve(port));
    });
    srv.on("error", reject);
  });
}
function sleep(ms) {
  return new Promise((r) => setTimeout(r, ms));
}
async function waitFor(fn, { timeout = 10000, interval = 150, label = "condition" } = {}) {
  const start = Date.now();
  let lastErr;
  while (Date.now() - start < timeout) {
    try {
      const v = await fn();
      if (v) return v;
    } catch (e) {
      lastErr = e;
    }
    await sleep(interval);
  }
  throw new Error(`timed out waiting for ${label}${lastErr ? ` (last error: ${lastErr.message})` : ""}`);
}
async function fetchJson(url, opts) {
  const r = await fetch(url, opts);
  let body = null;
  try {
    body = await r.json();
  } catch (_) {}
  return { status: r.status, body };
}

let step = 0;
function log(msg) {
  console.log(`  [${++step}] ${msg}`);
}

const procs = [];
function spawnLogged(name, cmd, args, env) {
  const child = spawn(cmd, args, { env: Object.assign({}, process.env, env), stdio: ["ignore", "pipe", "pipe"] });
  child.stdout.on("data", (d) => process.stdout.write(`[${name}] ${d}`));
  child.stderr.on("data", (d) => process.stderr.write(`[${name}] ${d}`));
  procs.push(child);
  return child;
}
function killAll() {
  for (const p of procs) {
    if (p.exitCode === null && p.signalCode === null) {
      try {
        p.kill("SIGKILL");
      } catch (_) {}
    }
  }
}
process.on("exit", killAll);

async function main() {
  const mockBarPort = await freePort();
  const managerPort = await freePort();
  const tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), "busybar-manager-barpass-test-"));
  const configPath = path.join(tmpDir, "config.json");

  fs.writeFileSync(
    configPath,
    JSON.stringify({ listenPort: managerPort, barHost: `127.0.0.1:${mockBarPort}`, appsDirs: [], apps: {} }, null, 2)
  );

  log("starting mock-bar");
  spawnLogged("mock-bar", process.execPath, [path.join(__dirname, "mock-bar.js")], { PORT: String(mockBarPort) });
  await waitFor(async () => (await fetchJson(`http://127.0.0.1:${mockBarPort}/api/version`)).status === 200, { label: "mock-bar ready" });

  spawnLogged("manager", process.execPath, [path.join(ROOT, "server.js")], { BUSYBAR_MANAGER_CONFIG: configPath });
  await waitFor(async () => (await fetchJson(`http://127.0.0.1:${managerPort}/health`)).status === 200, { label: "manager ready" });

  const M = `http://127.0.0.1:${managerPort}`;

  log("GET /api/_bar/events streams SSE incrementally (not just at stream end)");
  const controller = new AbortController();
  const resp = await fetch(`${M}/api/_bar/events`, { signal: controller.signal });
  assert.equal(resp.status, 200);
  assert.ok((resp.headers.get("content-type") || "").includes("text/event-stream"), `unexpected content-type: ${resp.headers.get("content-type")}`);

  const reader = resp.body.getReader();
  const decoder = new TextDecoder();
  let buf = "";
  let eventCount = 0;
  const deadline = Date.now() + 8000;
  while (eventCount < 2 && Date.now() < deadline) {
    const { value, done } = await reader.read();
    if (done) break;
    buf += decoder.decode(value, { stream: true });
    eventCount = (buf.match(/event: state/g) || []).length;
  }
  assert.ok(eventCount >= 2, `expected at least 2 incremental SSE events, got ${eventCount}. buf=${JSON.stringify(buf)}`);
  // The stream never ends on its own (a real mirror stays open indefinitely)
  // — abort the client side rather than waiting for upstream to finish.
  controller.abort();
  try {
    await reader.cancel();
  } catch (_) {}

  log("GET /api/_bar/<unknown path> propagates the upstream 404");
  const notFound = await fetch(`${M}/api/_bar/some-404`);
  assert.equal(notFound.status, 404);

  log("nested path + query string are preserved through the passthrough");
  const echoed = await fetchJson(`${M}/api/_bar/_echo-query?foo=bar&a=1`);
  assert.equal(echoed.status, 200);
  assert.deepEqual(echoed.body.query, { foo: "bar", a: "1" });

  log("non-GET methods are rejected (405), not forwarded");
  const posted = await fetch(`${M}/api/_bar/events`, { method: "POST" });
  assert.equal(posted.status, 405);

  log("502 when the bar is unreachable");
  // Point a second manager instance at a port nothing listens on.
  const deadBarPort = await freePort();
  const configPath2 = path.join(tmpDir, "config-dead.json");
  const managerPort2 = await freePort();
  fs.writeFileSync(
    configPath2,
    JSON.stringify({ listenPort: managerPort2, barHost: `127.0.0.1:${deadBarPort}`, appsDirs: [], apps: {} }, null, 2)
  );
  spawnLogged("manager-deadbar", process.execPath, [path.join(ROOT, "server.js")], { BUSYBAR_MANAGER_CONFIG: configPath2 });
  await waitFor(async () => (await fetchJson(`http://127.0.0.1:${managerPort2}/health`)).status === 200, { label: "second manager ready" });
  const deadResp = await fetch(`http://127.0.0.1:${managerPort2}/api/_bar/events`);
  assert.equal(deadResp.status, 502);

  log("all bar-passthrough assertions passed");
}

main()
  .then(() => {
    console.log("\nOK - all busybar-manager bar-passthrough tests passed\n");
    killAll();
    process.exit(0);
  })
  .catch((err) => {
    console.error("\nFAIL:", err.stack || err.message, "\n");
    killAll();
    process.exit(1);
  });
