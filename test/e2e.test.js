"use strict";
/*
 * busybar-manager e2e test suite (zero-dependency, plain assertions).
 *
 * Spins up test/mock-bar.js and server.js against a temp config pointed at
 * test/apps/{dummy-lo,dummy-hi}, then exercises the manager API end to end:
 * discovery, enable/disable, priority arbitration + attribution, variation
 * overrides, crash-restart backoff, and config persistence across a manager
 * restart. Polls with timeouts throughout instead of bare sleeps.
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
  const mockPort = await freePort();
  const managerPort = await freePort();
  const tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), "busybar-manager-test-"));
  const configPath = path.join(tmpDir, "config.json");
  const appsDir = path.join(__dirname, "apps");

  fs.writeFileSync(
    configPath,
    JSON.stringify({ listenPort: managerPort, barHost: `127.0.0.1:${mockPort}`, appsDirs: [appsDir], apps: {} }, null, 2)
  );

  log("starting mock-bar");
  spawnLogged("mock-bar", process.execPath, [path.join(__dirname, "mock-bar.js")], { PORT: String(mockPort) });
  await waitFor(async () => (await fetchJson(`http://127.0.0.1:${mockPort}/api/version`)).status === 200, { label: "mock-bar ready" });

  let manager = spawnLogged("manager", process.execPath, [path.join(ROOT, "server.js")], { BUSYBAR_MANAGER_CONFIG: configPath });
  await waitFor(async () => (await fetchJson(`http://127.0.0.1:${managerPort}/health`)).status === 200, { label: "manager ready" });

  const M = `http://127.0.0.1:${managerPort}`;
  const B = `http://127.0.0.1:${mockPort}`;

  log("state lists dummy-lo and dummy-hi with discovered options");
  let state = (await fetchJson(`${M}/api/_manager/state`)).body;
  const lo0 = state.apps.find((a) => a.slug === "dummy-lo");
  const hi0 = state.apps.find((a) => a.slug === "dummy-hi");
  assert.ok(lo0, "dummy-lo not found in state");
  assert.ok(hi0, "dummy-hi not found in state");
  assert.ok(lo0.options.some((o) => o.flag === "--text"), "dummy-lo missing --text option");
  assert.ok(hi0.options.some((o) => o.flag === "--text"), "dummy-hi missing --text option");
  assert.equal(lo0.enabled, false);
  assert.equal(lo0.status, "stopped");

  log("enabling dummy-lo and dummy-hi");
  assert.equal((await fetchJson(`${M}/api/_manager/apps/dummy-lo/enable`, { method: "POST" })).status, 200);
  assert.equal((await fetchJson(`${M}/api/_manager/apps/dummy-hi/enable`, { method: "POST" })).status, 200);

  await waitFor(
    async () => {
      const s = (await fetchJson(`${M}/api/_manager/state`)).body;
      const l = s.apps.find((a) => a.slug === "dummy-lo");
      const h = s.apps.find((a) => a.slug === "dummy-hi");
      return l.status === "running" && h.status === "running";
    },
    { label: "both apps running", timeout: 15000 }
  );

  log("waiting for screenOwner = dummy-hi");
  await waitFor(
    async () => {
      const s = (await fetchJson(`${M}/api/_manager/state`)).body;
      return s.screenOwner && s.screenOwner.applicationName === "dummy-hi";
    },
    { label: "screenOwner = dummy-hi", timeout: 15000 }
  );

  log("waiting for dummy-lo blocked with 409");
  await waitFor(
    async () => {
      const s = (await fetchJson(`${M}/api/_manager/state`)).body;
      const l = s.apps.find((a) => a.slug === "dummy-lo");
      return l.blocked === true && l.lastDraw && l.lastDraw.status === 409;
    },
    { label: "dummy-lo blocked with 409", timeout: 15000 }
  );

  state = (await fetchJson(`${M}/api/_manager/state`)).body;
  assert.equal(state.screenOwner.applicationName, "dummy-hi");
  assert.equal(state.screenOwner.slug, "dummy-hi");

  log("disabling dummy-hi");
  assert.equal((await fetchJson(`${M}/api/_manager/apps/dummy-hi/disable`, { method: "POST" })).status, 200);

  await waitFor(
    async () => {
      const s = (await fetchJson(`${M}/api/_manager/state`)).body;
      return s.screenOwner && s.screenOwner.applicationName === "dummy-lo";
    },
    { label: "screenOwner flips to dummy-lo", timeout: 15000 }
  );

  const mockLog = (await fetchJson(`${B}/_log`)).body.log;
  assert.ok(mockLog.some((e) => e.method === "DELETE" && e.appName === "dummy-hi"), "mock-bar did not receive a DELETE for dummy-hi");

  await waitFor(
    async () => {
      const s = (await fetchJson(`${M}/api/_manager/state`)).body;
      const h = s.apps.find((a) => a.slug === "dummy-hi");
      return h.status === "stopped" && h.enabled === false;
    },
    { label: "dummy-hi stopped+disabled" }
  );

  log("creating + selecting variation 'fast' for dummy-lo (priority 70)");
  let r = await fetchJson(`${M}/api/_manager/apps/dummy-lo/variations/fast`, {
    method: "PUT",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ args: { "--text": "X" }, env: {}, priority: 70 }),
  });
  assert.equal(r.status, 200);
  r = await fetchJson(`${M}/api/_manager/apps/dummy-lo/variation`, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ name: "fast" }),
  });
  assert.equal(r.status, 200);

  await waitFor(
    async () => {
      const s = (await fetchJson(`${M}/api/_manager/state`)).body;
      const l = s.apps.find((a) => a.slug === "dummy-lo");
      return l.status === "running" && l.variation === "fast";
    },
    { label: "dummy-lo restarted on variation 'fast'", timeout: 15000 }
  );

  log("checking the proxy injected the priority-70 override into forwarded draws");
  await waitFor(
    async () => {
      const l2 = (await fetchJson(`${B}/_log`)).body.log;
      return l2.some((e) => e.method === "POST" && e.appName === "dummy-lo" && e.priority === 70 && e.ok);
    },
    { label: "mock-bar sees dummy-lo draw at priority 70", timeout: 15000 }
  );

  await waitFor(
    async () => {
      const s = (await fetchJson(`${M}/api/_manager/state`)).body;
      return s.screenOwner && s.screenOwner.applicationName === "dummy-lo";
    },
    { label: "screenOwner is dummy-lo after priority bump" }
  );

  log("killing dummy-lo's pid to test crash-restart with backoff");
  state = (await fetchJson(`${M}/api/_manager/state`)).body;
  const loEntry = state.apps.find((a) => a.slug === "dummy-lo");
  const oldPid = loEntry.pid;
  assert.ok(oldPid, "dummy-lo has no pid to kill");
  process.kill(oldPid, "SIGKILL");

  await waitFor(
    async () => {
      const s = (await fetchJson(`${M}/api/_manager/state`)).body;
      const l = s.apps.find((a) => a.slug === "dummy-lo");
      return l.status === "running" && l.pid && l.pid !== oldPid;
    },
    { label: "dummy-lo restarted after crash", timeout: 15000 }
  );

  log("restarting the manager process to check config persistence");
  manager.kill("SIGTERM");
  await waitFor(async () => manager.exitCode !== null || manager.signalCode !== null, { label: "manager exited", timeout: 10000 });

  manager = spawnLogged("manager2", process.execPath, [path.join(ROOT, "server.js")], { BUSYBAR_MANAGER_CONFIG: configPath });
  await waitFor(async () => (await fetchJson(`http://127.0.0.1:${managerPort}/health`)).status === 200, { label: "manager restarted+ready", timeout: 10000 });

  await waitFor(
    async () => {
      const s = (await fetchJson(`${M}/api/_manager/state`)).body;
      const l = s.apps.find((a) => a.slug === "dummy-lo");
      return l && l.enabled === true && l.status === "running" && l.variation === "fast";
    },
    { label: "dummy-lo auto-started after manager restart with persisted variation", timeout: 15000 }
  );

  state = (await fetchJson(`${M}/api/_manager/state`)).body;
  const hiAfterRestart = state.apps.find((a) => a.slug === "dummy-hi");
  assert.equal(hiAfterRestart.enabled, false, "dummy-hi should still be disabled after manager restart");

  log("checking the per-app log endpoint");
  const logResp = await fetchJson(`${M}/api/_manager/apps/dummy-lo/log`);
  assert.equal(logResp.status, 200);
  assert.ok(Array.isArray(logResp.body.lines) && logResp.body.lines.length > 0, "log lines empty");

  log("all assertions passed");
}

main()
  .then(() => {
    console.log("\nOK - all busybar-manager e2e tests passed\n");
    killAll();
    process.exit(0);
  })
  .catch((err) => {
    console.error("\nFAIL:", err.stack || err.message, "\n");
    killAll();
    process.exit(1);
  });
