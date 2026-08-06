"use strict";
/*
 * busybar-manager v3-aanvullingen e2e tests (docs/CONTRACT-LIBRARY.md,
 * "## v3-aanvullingen: rate limits, token, zip-upload, library-subtabs").
 *
 * Covers the server-relevant parts of that section (UI/subtabs/header are
 * frontend-only, out of scope):
 *   - per-URL ETag cache on the GitHub branches/trees calls: a second check
 *     with no fixture change must hit the mock's 304 path (asserted via
 *     mock-github's /_requests request log), while the catalog stays correct.
 *   - optional library.token: PUT /api/_manager/settings { libraryToken }
 *     reaches api.github.com as `Authorization: Bearer <token>` (asserted via
 *     the same request log), and never leaks back out of any manager API
 *     payload (state, library payload, settings response) - only
 *     `tokenSet: bool` is exposed.
 *   - a 403 "rate limit" response from GitHub is turned into a friendly,
 *     recognizable per-repo error message.
 *   - zip upload: POST /api/_manager/library/upload?slug=... with a
 *     hand-built zip (mixing stored + deflate entries) installs an app with
 *     source "upload", never appears in the catalog, runs/draws against
 *     mock-bar like any other app, and can be uninstalled via
 *     library/uninstall. A zip containing a path-traversal (`../`) entry is
 *     rejected with 400.
 *
 * Installed apps land in the *real* <project>/apps/ directory (fixed
 * location, no config option), so this test always cleans up after itself.
 */
const assert = require("assert/strict");
const { spawn } = require("child_process");
const fs = require("fs");
const os = require("os");
const path = require("path");
const net = require("net");
const zlib = require("zlib");

const ROOT = path.join(__dirname, "..");
const APPS_DIR = path.join(ROOT, "apps");

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
  const text = await r.text();
  try {
    body = JSON.parse(text);
  } catch (_) {
    body = text;
  }
  return { status: r.status, body, rawText: text };
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

function writeFixtureApp(fixtureDir, repo, slug, files) {
  const dir = path.join(fixtureDir, repo, "apps", slug);
  fs.mkdirSync(dir, { recursive: true });
  for (const [name, content] of Object.entries(files)) {
    fs.writeFileSync(path.join(dir, name), content);
  }
}

async function cleanupInstalledDirs(slugs) {
  for (const slug of slugs) {
    try {
      fs.rmSync(path.join(APPS_DIR, slug), { recursive: true, force: true });
    } catch (_) {}
  }
}

/* --------------------------- tiny in-test zip writer ------------------------ */
// Just enough of the zip format (local file headers + central directory +
// EOCD) to exercise server.js's zero-dep unzip. crc32 fields are left as 0 -
// server.js never verifies them, only decompresses (method 0 stored / method
// 8 deflate via zlib.inflateRawSync).
function makeZip(entries) {
  const localParts = [];
  const centralParts = [];
  let offset = 0;
  for (const e of entries) {
    const nameBuf = Buffer.from(e.name, "utf8");
    const raw = Buffer.isBuffer(e.content) ? e.content : Buffer.from(e.content, "utf8");
    const method = e.method || 0;
    const compressed = method === 8 ? zlib.deflateRawSync(raw) : raw;

    const localHeader = Buffer.alloc(30);
    localHeader.writeUInt32LE(0x04034b50, 0);
    localHeader.writeUInt16LE(20, 4);
    localHeader.writeUInt16LE(0, 6);
    localHeader.writeUInt16LE(method, 8);
    localHeader.writeUInt16LE(0, 10);
    localHeader.writeUInt16LE(0, 12);
    localHeader.writeUInt32LE(0, 14); // crc32 (unverified by server.js)
    localHeader.writeUInt32LE(compressed.length, 18);
    localHeader.writeUInt32LE(raw.length, 22);
    localHeader.writeUInt16LE(nameBuf.length, 26);
    localHeader.writeUInt16LE(0, 28);
    const localEntry = Buffer.concat([localHeader, nameBuf, compressed]);
    localParts.push(localEntry);

    const centralHeader = Buffer.alloc(46);
    centralHeader.writeUInt32LE(0x02014b50, 0);
    centralHeader.writeUInt16LE(20, 4);
    centralHeader.writeUInt16LE(20, 6);
    centralHeader.writeUInt16LE(0, 8);
    centralHeader.writeUInt16LE(method, 10);
    centralHeader.writeUInt16LE(0, 12);
    centralHeader.writeUInt16LE(0, 14);
    centralHeader.writeUInt32LE(0, 16);
    centralHeader.writeUInt32LE(compressed.length, 20);
    centralHeader.writeUInt32LE(raw.length, 24);
    centralHeader.writeUInt16LE(nameBuf.length, 28);
    centralHeader.writeUInt16LE(0, 30);
    centralHeader.writeUInt16LE(0, 32);
    centralHeader.writeUInt16LE(0, 34);
    centralHeader.writeUInt16LE(0, 36);
    centralHeader.writeUInt32LE(0, 38); // external attrs (regular file, not a symlink)
    centralHeader.writeUInt32LE(offset, 42);
    centralParts.push(Buffer.concat([centralHeader, nameBuf]));

    offset += localEntry.length;
  }
  const localSection = Buffer.concat(localParts);
  const centralSection = Buffer.concat(centralParts);
  const eocd = Buffer.alloc(22);
  eocd.writeUInt32LE(0x06054b50, 0);
  eocd.writeUInt16LE(0, 4);
  eocd.writeUInt16LE(0, 6);
  eocd.writeUInt16LE(entries.length, 8);
  eocd.writeUInt16LE(entries.length, 10);
  eocd.writeUInt32LE(centralSection.length, 12);
  eocd.writeUInt32LE(localSection.length, 16);
  eocd.writeUInt16LE(0, 20);
  return Buffer.concat([localSection, centralSection, eocd]);
}

function zipAppSource(appName, priority) {
  return `#!/usr/bin/env python3
"""Dummy zip-uploaded test app (${appName})."""
import argparse
import json
import time
import urllib.error
import urllib.request

APP = "${appName}"
PRIORITY = ${priority}


def parse_args():
    p = argparse.ArgumentParser(description="Dummy zip-uploaded test app")
    p.add_argument("--host", default="10.0.4.20")
    p.add_argument("--text", default="ZIP")
    return p.parse_args()


def _base(host):
    host = host.replace("http://", "").replace("https://", "").rstrip("/")
    return "http://" + host


def draw(host, text):
    body = {
        "application_name": APP,
        "priority": PRIORITY,
        "elements": [{"id": "t", "type": "text", "text": text, "x": 0, "y": 0, "font": "small", "color": "#FFFFFFFF"}],
    }
    data = json.dumps(body).encode("utf-8")
    req = urllib.request.Request(_base(host) + "/api/display/draw", data=data, method="POST",
                                  headers={"Content-Type": "application/json"})
    try:
        with urllib.request.urlopen(req, timeout=5) as r:
            return r.getcode()
    except urllib.error.HTTPError as e:
        return e.code


def main():
    args = parse_args()
    print(f"{APP} -> {_base(args.host)}  (Ctrl-C to stop)")
    try:
        while True:
            status = draw(args.host, args.text)
            print(f"drew '{args.text}' (status {status})")
            time.sleep(0.5)
    except KeyboardInterrupt:
        print("\\nstopped.")


if __name__ == "__main__":
    main()
`;
}

const REPO_V3 = "acme/v3-repo";
const TOKEN = "test-secret-token-abc123";
const UPLOAD_SLUG = "zip-test-app";

async function main() {
  const mockBarPort = await freePort();
  const githubPort = await freePort();
  const managerPort = await freePort();
  const tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), "busybar-manager-v3-test-"));
  const fixtureDir = path.join(tmpDir, "github-fixture");

  writeFixtureApp(fixtureDir, REPO_V3, "etag-app", {
    "app.py": "#!/usr/bin/env python3\nprint('unused in this test')\n",
    "manifest.yaml": "name: Etag App\ndescription: Used for the ETag/token/rate-limit tests.\ntags:\n  - test\n",
  });

  const configPath = path.join(tmpDir, "config.json");
  fs.writeFileSync(
    configPath,
    JSON.stringify(
      {
        listenPort: managerPort,
        barHost: `127.0.0.1:${mockBarPort}`,
        appsDirs: [],
        apps: {},
        library: { checkIntervalHours: 6, repos: [{ repo: REPO_V3, branch: "main" }] },
      },
      null,
      2
    )
  );

  log("starting mock-bar and mock-github");
  spawnLogged("mock-bar", process.execPath, [path.join(__dirname, "mock-bar.js")], { PORT: String(mockBarPort) });
  spawnLogged("mock-github", process.execPath, [path.join(__dirname, "mock-github.js")], {
    PORT: String(githubPort),
    GITHUB_FIXTURE_DIR: fixtureDir,
  });
  await waitFor(async () => (await fetchJson(`http://127.0.0.1:${mockBarPort}/api/version`)).status === 200, { label: "mock-bar ready" });
  await waitFor(async () => (await fetchJson(`http://127.0.0.1:${githubPort}/_state`)).status === 200, { label: "mock-github ready" });

  spawnLogged("manager", process.execPath, [path.join(ROOT, "server.js")], {
    BUSYBAR_MANAGER_CONFIG: configPath,
    BUSYBAR_LIBRARY_API_BASE: `http://127.0.0.1:${githubPort}`,
    BUSYBAR_LIBRARY_RAW_BASE: `http://127.0.0.1:${githubPort}`,
  });
  await waitFor(async () => (await fetchJson(`http://127.0.0.1:${managerPort}/health`)).status === 200, { label: "manager ready" });

  const M = `http://127.0.0.1:${managerPort}`;
  const G = `http://127.0.0.1:${githubPort}`;

  log("first library check -> catalog populated, requests logged as fresh 200s");
  let r = await fetchJson(`${M}/api/_manager/library/check`, { method: "POST" });
  assert.equal(r.status, 200, JSON.stringify(r.body));
  assert.ok(r.body.catalog.some((c) => c.slug === "etag-app"));

  let reqLog = (await fetchJson(`${G}/_requests?repo=${encodeURIComponent(REPO_V3)}`)).body.requests;
  assert.ok(reqLog.length >= 2, "expected at least a branches + trees request");
  const firstBranches = reqLog.filter((x) => x.route === "branches");
  const firstTrees = reqLog.filter((x) => x.route === "trees");
  assert.equal(firstBranches[firstBranches.length - 1].status, 200);
  assert.equal(firstTrees[firstTrees.length - 1].status, 200);

  log("second library check (nothing changed) -> ETag cache hits, mock serves 304s");
  r = await fetchJson(`${M}/api/_manager/library/check`, { method: "POST" });
  assert.equal(r.status, 200, JSON.stringify(r.body));
  assert.ok(r.body.catalog.some((c) => c.slug === "etag-app"), "catalog must stay correct across a 304-served check");
  const repoState = r.body.repos.find((x) => x.repo === REPO_V3);
  assert.equal(repoState.error, null);

  reqLog = (await fetchJson(`${G}/_requests?repo=${encodeURIComponent(REPO_V3)}`)).body.requests;
  const branchesAfter = reqLog.filter((x) => x.route === "branches");
  const treesAfter = reqLog.filter((x) => x.route === "trees");
  assert.equal(branchesAfter[branchesAfter.length - 1].status, 304, "second branches check should have been a 304 (ETag cache hit)");
  assert.equal(treesAfter[treesAfter.length - 1].status, 304, "second trees check should have been a 304 (ETag cache hit)");

  log("configuring a library token -> never echoed back, reaches mock-github as Authorization header");
  r = await fetchJson(`${M}/api/_manager/settings`, {
    method: "PUT", headers: { "Content-Type": "application/json" }, body: JSON.stringify({ libraryToken: TOKEN }),
  });
  assert.equal(r.status, 200, JSON.stringify(r.body));
  assert.ok(!r.rawText.includes(TOKEN), "PUT /settings response must never echo the token");

  r = await fetchJson(`${M}/api/_manager/library/check`, { method: "POST" });
  assert.equal(r.status, 200, JSON.stringify(r.body));
  assert.ok(!r.rawText.includes(TOKEN), "library/check response must never echo the token");
  assert.equal(r.body.tokenSet, true, "library payload should expose tokenSet:true, never the token itself");

  reqLog = (await fetchJson(`${G}/_requests?repo=${encodeURIComponent(REPO_V3)}`)).body.requests;
  const withAuth = reqLog.filter((x) => x.authorization === `Bearer ${TOKEN}`);
  assert.ok(withAuth.length >= 1, "mock-github should have received the Authorization: Bearer <token> header");

  const stateBody = (await fetchJson(`${M}/api/_manager/state`)).rawText;
  assert.ok(!stateBody.includes(TOKEN), "GET /api/_manager/state must never contain the token");
  const libBody = (await fetchJson(`${M}/api/_manager/library`)).rawText;
  assert.ok(!libBody.includes(TOKEN), "GET /api/_manager/library must never contain the token");

  log("clearing the token (empty string) -> tokenSet flips back to false");
  r = await fetchJson(`${M}/api/_manager/settings`, {
    method: "PUT", headers: { "Content-Type": "application/json" }, body: JSON.stringify({ libraryToken: "" }),
  });
  assert.equal(r.status, 200);
  r = await fetchJson(`${M}/api/_manager/library`);
  assert.equal(r.body.tokenSet, false);

  log("GitHub 403 rate-limit -> friendly, recognizable per-repo error message");
  r = await fetchJson(`${G}/_rate-limit`, {
    method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify({ repo: REPO_V3, limited: true }),
  });
  assert.equal(r.status, 200);
  r = await fetchJson(`${M}/api/_manager/library/check`, { method: "POST" });
  assert.equal(r.status, 200, JSON.stringify(r.body));
  const rlState = r.body.repos.find((x) => x.repo === REPO_V3);
  assert.equal(rlState.error, "GitHub rate limit — add a token in Library settings or retry later");
  assert.ok(r.body.catalog.some((c) => c.slug === "etag-app"), "last known good catalog must be kept across a rate-limit failure");
  await fetchJson(`${G}/_rate-limit`, {
    method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify({ repo: REPO_V3, limited: false }),
  });

  log("zip upload: building a zip (deflate app.py + stored manifest.yaml) and posting it");
  const zipBuf = makeZip([
    { name: "app.py", content: zipAppSource(UPLOAD_SLUG, 50), method: 8 },
    { name: "manifest.yaml", content: "name: Zip Test App\ndescription: Installed from a zip upload.\ntags:\n  - test\n", method: 0 },
  ]);
  r = await fetchJson(`${M}/api/_manager/library/upload?slug=${UPLOAD_SLUG}`, {
    method: "POST", headers: { "Content-Type": "application/zip" }, body: zipBuf,
  });
  assert.equal(r.status, 200, JSON.stringify(r.body));
  assert.equal(r.body.slug, UPLOAD_SLUG);

  const stamp = JSON.parse(fs.readFileSync(path.join(APPS_DIR, UPLOAD_SLUG, ".busybar-library.json"), "utf8"));
  assert.equal(stamp.source, "upload");
  assert.ok(stamp.files["app.py"], "stamp should record a sha256 for app.py");
  assert.ok(stamp.installedAt);

  let state = (await fetchJson(`${M}/api/_manager/state`)).body;
  let uploadedApp = state.apps.find((a) => a.slug === UPLOAD_SLUG);
  assert.ok(uploadedApp, "uploaded app should appear in state");
  assert.equal(uploadedApp.source, "upload");
  assert.equal(uploadedApp.updateAvailable, false);
  assert.equal(uploadedApp.enabled, false, "uploaded apps must not auto-start");

  const libPayload = (await fetchJson(`${M}/api/_manager/library`)).body;
  assert.ok(!libPayload.catalog.some((c) => c.slug === UPLOAD_SLUG), "upload-installed apps must never appear in the library catalog");

  log("uploading the same slug again -> 409 (collision)");
  r = await fetchJson(`${M}/api/_manager/library/upload?slug=${UPLOAD_SLUG}`, {
    method: "POST", headers: { "Content-Type": "application/zip" }, body: zipBuf,
  });
  assert.equal(r.status, 409);

  log("enabling the uploaded app and waiting for it to draw against mock-bar");
  r = await fetchJson(`${M}/api/_manager/apps/${UPLOAD_SLUG}/enable`, { method: "POST" });
  assert.equal(r.status, 200, JSON.stringify(r.body));
  await waitFor(
    async () => {
      const s = (await fetchJson(`${M}/api/_manager/state`)).body;
      const a = s.apps.find((x) => x.slug === UPLOAD_SLUG);
      return a && a.status === "running" && a.lastDraw && a.lastDraw.status === 200;
    },
    { label: "uploaded app running and drawing", timeout: 20000 }
  );

  log("uninstalling the uploaded app via library/uninstall");
  r = await fetchJson(`${M}/api/_manager/library/uninstall`, {
    method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify({ slug: UPLOAD_SLUG }),
  });
  assert.equal(r.status, 200, JSON.stringify(r.body));
  assert.ok(!fs.existsSync(path.join(APPS_DIR, UPLOAD_SLUG)), "uploaded app dir should be removed");
  state = (await fetchJson(`${M}/api/_manager/state`)).body;
  assert.ok(!state.apps.some((a) => a.slug === UPLOAD_SLUG), "uninstalled uploaded app should be gone from state");

  log("malicious zip with a path-traversal entry -> 400, nothing installed");
  const maliciousZip = makeZip([
    { name: "app.py", content: "#!/usr/bin/env python3\nprint('ok')\n", method: 0 },
    { name: "../evil.py", content: "print('escape attempt')\n", method: 0 },
  ]);
  r = await fetchJson(`${M}/api/_manager/library/upload?slug=evil-app`, {
    method: "POST", headers: { "Content-Type": "application/zip" }, body: maliciousZip,
  });
  assert.equal(r.status, 400, JSON.stringify(r.body));
  assert.ok(!fs.existsSync(path.join(APPS_DIR, "evil-app")), "malicious zip must never be installed");

  log("all v3-aanvullingen assertions passed");
}

main()
  .then(async () => {
    console.log("\nOK - all busybar-manager v3-aanvullingen e2e tests passed\n");
    killAll();
    await cleanupInstalledDirs([UPLOAD_SLUG, "evil-app", "etag-app"]);
    process.exit(0);
  })
  .catch(async (err) => {
    console.error("\nFAIL:", err.stack || err.message, "\n");
    killAll();
    await cleanupInstalledDirs([UPLOAD_SLUG, "evil-app", "etag-app"]);
    process.exit(1);
  });
