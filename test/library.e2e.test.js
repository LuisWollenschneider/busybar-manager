"use strict";
/*
 * busybar-manager library e2e tests (docs/CONTRACT-LIBRARY.md, "Config v2").
 *
 * Spins up test/mock-github.js (as both the GitHub API and raw-content host,
 * via BUSYBAR_LIBRARY_API_BASE / BUSYBAR_LIBRARY_RAW_BASE) and test/mock-bar.js,
 * then a manager instance linked to TWO repos plus a local appsDirs (reusing
 * test/apps, which already has a "dummy-lo" app — used here to exercise the
 * local/library slug-collision rule). Installed apps land in the *real*
 * <project>/apps/ directory (CONTRACT-LIBRARY.md: fixed location, no config
 * option), so this test always cleans up after itself, including on failure.
 *
 * Covers: merged multi-repo catalog with `repo` fields, slug collision
 * across repos (install without repo -> 400, with repo -> ok, second repo
 * install of the same slug -> 409), a broken repo never blocking/emptying
 * another repo's catalog, unlinking a repo (installed app keeps running,
 * loses its catalog entry + updateAvailable), and old-config migration to
 * `library.repos`.
 */
const assert = require("assert/strict");
const { spawn } = require("child_process");
const fs = require("fs");
const os = require("os");
const path = require("path");
const net = require("net");

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

function dummyLibSource(appName, version, priority) {
  return `#!/usr/bin/env python3
"""Dummy library-installed test app (${appName}), v${version}."""
import argparse
import json
import time
import urllib.error
import urllib.request

APP = "${appName}"
PRIORITY = ${priority}
VERSION = "${version}"


def parse_args():
    p = argparse.ArgumentParser(description="Dummy library test app")
    p.add_argument("--host", default="10.0.4.20")
    p.add_argument("--text", default="${appName.toUpperCase()}-${version}")
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
    print(f"{APP} v{VERSION} -> {_base(args.host)}  (Ctrl-C to stop)")
    try:
        while True:
            status = draw(args.host, args.text)
            print(f"drew '{args.text}' v{VERSION} (status {status})")
            time.sleep(0.5)
    except KeyboardInterrupt:
        print("\\nstopped.")


if __name__ == "__main__":
    main()
`;
}

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

const REPO_A = "acme/apps-one";
const REPO_B = "acme/apps-two";
const INSTALLED_SLUGS = ["dummy-lib", "shared-app", "repob-only"];

async function runMultiRepoScenario() {
  const mockBarPort = await freePort();
  const githubPort = await freePort();
  const managerPort = await freePort();
  const tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), "busybar-manager-lib-test-"));
  const fixtureDir = path.join(tmpDir, "github-fixture");
  const localAppsDir = path.join(__dirname, "apps"); // reuse test/apps (has "dummy-lo") for the local-collision test

  // repo A: dummy-lib (install/update flow), shared-app (cross-repo collision),
  //         dummy-lo (collides with the LOCAL test/apps/dummy-lo app)
  writeFixtureApp(fixtureDir, REPO_A, "dummy-lib", {
    "app.py": dummyLibSource("dummy-lib", "1", 40),
    "manifest.yaml": "name: Dummy Lib\nauthor: busybar-manager-tests\ndescription: Library-installed dummy test app.\ntags:\n  - test\npreview: ./preview.gif\n",
    "preview.gif": "not-a-real-gif",
  });
  writeFixtureApp(fixtureDir, REPO_A, "shared-app", {
    "app.py": dummyLibSource("shared-app", "a1", 35),
    "manifest.yaml": "name: Shared App (repo A)\ndescription: Exists in both linked repos.\ntags:\n  - test\n",
  });
  writeFixtureApp(fixtureDir, REPO_A, "dummy-lo", {
    "app.py": "#!/usr/bin/env python3\nprint('this should never be installed - collides with local app')\n",
    "manifest.yaml": "name: Dummy Lo (upstream)\ndescription: Should collide with the local app of the same slug.\n",
  });
  // repo B: shared-app (same slug, different repo/content), repob-only (unlink test)
  writeFixtureApp(fixtureDir, REPO_B, "shared-app", {
    "app.py": dummyLibSource("shared-app", "b1", 35),
    "manifest.yaml": "name: Shared App (repo B)\ndescription: Exists in both linked repos.\ntags:\n  - test\n",
  });
  writeFixtureApp(fixtureDir, REPO_B, "repob-only", {
    "app.py": dummyLibSource("repob-only", "1", 45),
    "manifest.yaml": "name: Repo B Only\ndescription: Only exists in repo B, for the unlink test.\ntags:\n  - test\n",
  });

  const configPath = path.join(tmpDir, "config.json");
  fs.writeFileSync(
    configPath,
    JSON.stringify(
      {
        listenPort: managerPort,
        barHost: `127.0.0.1:${mockBarPort}`,
        appsDirs: [localAppsDir],
        apps: {},
        library: { checkIntervalHours: 6, repos: [{ repo: REPO_A, branch: "main" }, { repo: REPO_B, branch: "main" }] },
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

  log("two repos linked -> merged catalog with repo fields");
  let lib = (await fetchJson(`${M}/api/_manager/library?refresh=1`)).body;
  assert.equal(lib.repos.length, 2);
  const repoAState = lib.repos.find((r) => r.repo === REPO_A);
  const repoBState = lib.repos.find((r) => r.repo === REPO_B);
  assert.ok(repoAState && repoAState.lastCheck && repoAState.error === null, "repo A should have checked successfully");
  assert.ok(repoBState && repoBState.lastCheck && repoBState.error === null, "repo B should have checked successfully");

  const sharedEntries = lib.catalog.filter((c) => c.slug === "shared-app");
  assert.equal(sharedEntries.length, 2, "shared-app should appear once per repo");
  assert.deepEqual(new Set(sharedEntries.map((c) => c.repo)), new Set([REPO_A, REPO_B]));

  const catDummyLo = lib.catalog.find((c) => c.slug === "dummy-lo");
  assert.ok(catDummyLo, "dummy-lo missing from catalog");
  assert.equal(catDummyLo.source, "local", "dummy-lo should be flagged local (collides with the appsDirs app)");

  log("install slug that collides with a LOCAL appsDirs app -> 409");
  let r = await fetchJson(`${M}/api/_manager/library/install`, {
    method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify({ slug: "dummy-lo" }),
  });
  assert.equal(r.status, 409);

  log("install an ambiguous cross-repo slug without 'repo' -> 400");
  r = await fetchJson(`${M}/api/_manager/library/install`, {
    method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify({ slug: "shared-app" }),
  });
  assert.equal(r.status, 400);

  log("install the same slug WITH 'repo' -> ok");
  r = await fetchJson(`${M}/api/_manager/library/install`, {
    method: "POST", headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ slug: "shared-app", repo: REPO_A }),
  });
  assert.equal(r.status, 200, JSON.stringify(r.body));
  const sharedStamp = JSON.parse(fs.readFileSync(path.join(APPS_DIR, "shared-app", ".busybar-library.json"), "utf8"));
  assert.equal(sharedStamp.repo, REPO_A);

  log("installing the same slug from the OTHER repo -> 409 (already installed elsewhere)");
  r = await fetchJson(`${M}/api/_manager/library/install`, {
    method: "POST", headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ slug: "shared-app", repo: REPO_B }),
  });
  assert.equal(r.status, 409);

  log("installing dummy-lib and repob-only (unambiguous, no repo needed)");
  r = await fetchJson(`${M}/api/_manager/library/install`, {
    method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify({ slug: "dummy-lib" }),
  });
  assert.equal(r.status, 200, JSON.stringify(r.body));
  r = await fetchJson(`${M}/api/_manager/library/install`, {
    method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify({ slug: "repob-only" }),
  });
  assert.equal(r.status, 200, JSON.stringify(r.body));

  log("enabling dummy-lib and repob-only, waiting for them to run against mock-bar");
  await fetchJson(`${M}/api/_manager/apps/dummy-lib/enable`, { method: "POST" });
  await fetchJson(`${M}/api/_manager/apps/repob-only/enable`, { method: "POST" });
  await waitFor(
    async () => {
      const s = (await fetchJson(`${M}/api/_manager/state`)).body;
      const a = s.apps.find((x) => x.slug === "dummy-lib");
      const b = s.apps.find((x) => x.slug === "repob-only");
      return a && a.status === "running" && a.lastDraw && a.lastDraw.status === 200 && b && b.status === "running";
    },
    { label: "dummy-lib and repob-only running", timeout: 20000 }
  );

  let state = (await fetchJson(`${M}/api/_manager/state`)).body;
  const oldPid = state.apps.find((a) => a.slug === "dummy-lib").pid;

  log("mutating repo A's dummy-lib fixture (new commit) and checking for an update");
  r = await fetchJson(`http://127.0.0.1:${githubPort}/_mutate`, {
    method: "POST", headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ repo: REPO_A, slug: "dummy-lib", file: "app.py", content: dummyLibSource("dummy-lib", "2", 40) }),
  });
  assert.equal(r.status, 200);

  r = await fetchJson(`${M}/api/_manager/library/check`, { method: "POST" });
  assert.equal(r.status, 200);
  assert.equal(r.body.catalog.find((c) => c.slug === "dummy-lib" && c.repo === REPO_A).updateAvailable, true);

  await waitFor(
    async () => {
      const s = (await fetchJson(`${M}/api/_manager/state`)).body;
      const a = s.apps.find((x) => x.slug === "dummy-lib");
      return a && a.updateAvailable === true && s.library.updatesAvailable === 1;
    },
    { label: "state reflects updateAvailable + library.updatesAvailable=1" }
  );

  log("updating dummy-lib");
  r = await fetchJson(`${M}/api/_manager/library/update`, {
    method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify({ slug: "dummy-lib" }),
  });
  assert.equal(r.status, 200, JSON.stringify(r.body));

  const newContent = fs.readFileSync(path.join(APPS_DIR, "dummy-lib", "app.py"), "utf8");
  assert.ok(newContent.includes('VERSION = "2"'), "app.py on disk was not updated to the new fixture content");

  await waitFor(
    async () => {
      const s = (await fetchJson(`${M}/api/_manager/state`)).body;
      const a = s.apps.find((x) => x.slug === "dummy-lib");
      return a && a.status === "running" && a.pid && a.pid !== oldPid;
    },
    { label: "dummy-lib restarted (new pid) after update", timeout: 20000 }
  );

  state = (await fetchJson(`${M}/api/_manager/state`)).body;
  assert.equal(state.apps.find((a) => a.slug === "dummy-lib").updateAvailable, false);
  assert.equal(state.library.updatesAvailable, 0);

  log("breaking repo B (mock 500) -> repo A's catalog stays intact, repo B gets a per-repo error");
  r = await fetchJson(`http://127.0.0.1:${githubPort}/_break`, {
    method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify({ repo: REPO_B, broken: true }),
  });
  assert.equal(r.status, 200);

  r = await fetchJson(`${M}/api/_manager/library/check`, { method: "POST" });
  assert.equal(r.status, 200);
  const brokenRepoState = r.body.repos.find((x) => x.repo === REPO_B);
  const okRepoState = r.body.repos.find((x) => x.repo === REPO_A);
  assert.ok(brokenRepoState.error, "repo B should have a recorded error while broken");
  assert.equal(okRepoState.error, null, "repo A must not be affected by repo B being broken");
  assert.ok(r.body.catalog.some((c) => c.slug === "dummy-lib" && c.repo === REPO_A), "repo A catalog entries must survive repo B breaking");
  assert.ok(r.body.catalog.some((c) => c.slug === "shared-app" && c.repo === REPO_A), "repo A's shared-app entry must survive");

  log("unlinking repo B -> catalog shrinks, repob-only keeps running, updateAvailable=false");
  r = await fetchJson(`${M}/api/_manager/library/repos`, {
    method: "DELETE", headers: { "Content-Type": "application/json" }, body: JSON.stringify({ repo: REPO_B }),
  });
  assert.equal(r.status, 200, JSON.stringify(r.body));
  assert.equal(r.body.repos.length, 1);
  assert.ok(!r.body.catalog.some((c) => c.repo === REPO_B), "repo B entries must be gone from the catalog");
  assert.ok(r.body.catalog.some((c) => c.slug === "shared-app" && c.repo === REPO_A), "repo A's shared-app entry must remain");

  state = (await fetchJson(`${M}/api/_manager/state`)).body;
  const repoBOnlyApp = state.apps.find((a) => a.slug === "repob-only");
  assert.ok(repoBOnlyApp, "repob-only should still be present in state (still installed on disk)");
  assert.equal(repoBOnlyApp.status, "running", "repob-only must keep running after its repo is unlinked");
  assert.equal(repoBOnlyApp.updateAvailable, false, "updateAvailable must be false once the stamped repo is unlinked");

  log("all multi-repo assertions passed");
}

async function runMigrationTest() {
  const mockBarPort = await freePort();
  const managerPort = await freePort();
  const tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), "busybar-manager-lib-migrate-"));
  const configPath = path.join(tmpDir, "config.json");

  // Old-style (pre-v2) config: `repo`/`branch` directly on `library`.
  fs.writeFileSync(
    configPath,
    JSON.stringify(
      { listenPort: managerPort, barHost: `127.0.0.1:${mockBarPort}`, appsDirs: [], apps: {}, library: { repo: "solo/repo", branch: "dev", checkIntervalHours: 3 } },
      null,
      2
    )
  );

  log("starting a manager against an old-style single-repo config to check migration");
  spawnLogged("mock-bar-migrate", process.execPath, [path.join(__dirname, "mock-bar.js")], { PORT: String(mockBarPort) });
  await waitFor(async () => (await fetchJson(`http://127.0.0.1:${mockBarPort}/api/version`)).status === 200, { label: "mock-bar (migration test) ready" });

  spawnLogged("manager-migrate", process.execPath, [path.join(ROOT, "server.js")], { BUSYBAR_MANAGER_CONFIG: configPath });
  await waitFor(async () => (await fetchJson(`http://127.0.0.1:${managerPort}/health`)).status === 200, { label: "manager (migration test) ready" });

  const lib = (await fetchJson(`http://127.0.0.1:${managerPort}/api/_manager/library`)).body;
  assert.equal(lib.repos.length, 1);
  assert.equal(lib.repos[0].repo, "solo/repo");
  assert.equal(lib.repos[0].branch, "dev");
  assert.equal(lib.checkIntervalHours, 3);

  await waitFor(
    () => {
      const onDisk = JSON.parse(fs.readFileSync(configPath, "utf8"));
      return (
        Array.isArray(onDisk.library.repos) &&
        onDisk.library.repos.length === 1 &&
        onDisk.library.repos[0].repo === "solo/repo" &&
        onDisk.library.repos[0].branch === "dev" &&
        onDisk.library.repo === undefined &&
        onDisk.library.branch === undefined
      );
    },
    { label: "config.json on disk migrated to library.repos" }
  );

  log("migration assertions passed");
}

async function main() {
  await runMultiRepoScenario();
  killAll();
  await sleep(300); // let the previous instances' file handles/processes fully release
  await runMigrationTest();
}

main()
  .then(async () => {
    console.log("\nOK - all busybar-manager library e2e tests passed\n");
    killAll();
    await cleanupInstalledDirs(INSTALLED_SLUGS);
    process.exit(0);
  })
  .catch(async (err) => {
    console.error("\nFAIL:", err.stack || err.message, "\n");
    killAll();
    await cleanupInstalledDirs(INSTALLED_SLUGS);
    process.exit(1);
  });
