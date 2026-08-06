"use strict";
/*
 * Zero-dependency mock of the GitHub REST + raw-content APIs used by
 * busybar-manager's app library (docs/CONTRACT-LIBRARY.md, "Config v2").
 * Serves ANY NUMBER of repos from one instance — fixture files live under
 * FIXTURE_DIR/<owner>/<name>/apps/<slug>/<file>, mirroring the "owner/name"
 * repo path directly. Each repo has its own commit counter, so mutating one
 * repo's fixture never affects another's commit/blob shas.
 *
 * Routes (paths match the real GitHub API/raw-content shapes closely enough
 * for server.js's URL-building to work unmodified against this mock):
 *   GET  /repos/:owner/:repo/branches/:branch          -> { commit: { sha } }
 *   GET  /repos/:owner/:repo/git/trees/:sha?recursive=1 -> { sha, tree: [...] }
 *   GET  /:owner/:repo/:sha/apps/:slug/:file            -> raw file bytes
 *   POST /_mutate  { repo, slug, file, content }         -> bump a fixture file (test-only)
 *   POST /_break   { repo, broken }                       -> make a repo's API calls 500 (test-only)
 *   POST /_rate-limit { repo, limited }                   -> make a repo's API calls 403 rate-limit (test-only)
 *   GET  /_state?repo=owner/name                          -> current commitSha + tree (test-only)
 *   GET  /_requests?repo=owner/name                        -> request log for branches/trees calls (test-only;
 *                                                             each entry: { route, repo, status, authorization })
 *
 * The two GitHub API routes (branches, trees) support conditional requests:
 * each response carries an ETag; a matching If-None-Match gets a bare 304
 * (server.js's rate-limit/ETag-cache feature relies on this). Requests also
 * echo back the Authorization header they received, so tests can assert a
 * configured library.token reaches this mock.
 *
 * Usage: node mock-github.js [port]
 *        PORT=8070 GITHUB_FIXTURE_DIR=/tmp/fixture node mock-github.js
 */
const http = require("http");
const fs = require("fs");
const path = require("path");
const crypto = require("crypto");

const PORT = Number(process.env.PORT || process.argv[2] || 8070);
const FIXTURE_DIR = process.env.GITHUB_FIXTURE_DIR || process.argv[3] || path.join(__dirname, ".github-fixture");

fs.mkdirSync(FIXTURE_DIR, { recursive: true });

const commitCounters = new Map(); // repo ("owner/name") -> counter
const brokenRepos = new Set();
const rateLimitedRepos = new Set();
const requestLog = []; // { route: "branches"|"trees", repo, status, authorization } — branches/trees calls only

function etagFor(obj) {
  return `"${crypto.createHash("sha1").update(JSON.stringify(obj)).digest("hex")}"`;
}

// Serves a conditional GET for the two GitHub-API routes: computes the ETag
// for `payload`, honors If-None-Match with a bare 304 (not counted against
// any "rate limit" in real GitHub — this mock doesn't actually meter calls,
// it just needs to prove the 304 path was taken), and logs the request
// (route/repo/status/authorization) for test assertions.
function sendConditional(req, res, route, repo, payload) {
  const authorization = req.headers.authorization || null;
  const etag = etagFor(payload);
  const inm = req.headers["if-none-match"];
  if (inm && inm === etag) {
    requestLog.push({ route, repo, status: 304, authorization });
    res.writeHead(304, { ETag: etag });
    return res.end();
  }
  requestLog.push({ route, repo, status: 200, authorization });
  res.writeHead(200, { "Content-Type": "application/json", ETag: etag });
  res.end(JSON.stringify(payload));
}

function repoAppsDir(repo) {
  return path.join(FIXTURE_DIR, repo, "apps");
}
// Not a real git blob sha (no "blob <len>\0" prefix) — just a stable content
// hash. server.js only ever compares these for equality/change, never
// recomputes or validates them against git's algorithm.
function blobSha(content) {
  return crypto.createHash("sha1").update(content).digest("hex");
}
function currentCommitSha(repo) {
  const n = commitCounters.get(repo) || 1;
  return crypto.createHash("sha1").update(`${repo}#commit-${n}`).digest("hex");
}
function bumpCommit(repo) {
  commitCounters.set(repo, (commitCounters.get(repo) || 1) + 1);
}

function walkTree(repo) {
  const dir = repoAppsDir(repo);
  const tree = [];
  let slugs = [];
  try {
    slugs = fs.readdirSync(dir, { withFileTypes: true }).filter((d) => d.isDirectory()).map((d) => d.name);
  } catch (_) {}
  for (const slug of slugs) {
    const slugDir = path.join(dir, slug);
    let files = [];
    try {
      files = fs.readdirSync(slugDir, { withFileTypes: true }).filter((d) => d.isFile());
    } catch (_) {}
    for (const f of files) {
      const content = fs.readFileSync(path.join(slugDir, f.name));
      tree.push({ path: `apps/${slug}/${f.name}`, mode: "100644", type: "blob", sha: blobSha(content), size: content.length });
    }
  }
  return tree;
}

function send(res, code, obj) {
  const body = Buffer.isBuffer(obj) ? obj : Buffer.from(JSON.stringify(obj));
  res.writeHead(code, { "Content-Type": Buffer.isBuffer(obj) ? "application/octet-stream" : "application/json" });
  res.end(body);
}
function readBody(req) {
  return new Promise((resolve) => {
    const chunks = [];
    req.on("data", (c) => chunks.push(c));
    req.on("end", () => resolve(Buffer.concat(chunks)));
  });
}

const server = http.createServer(async (req, res) => {
  let u;
  try {
    u = new URL(req.url, "http://localhost");
  } catch (_) {
    return send(res, 400, { error: "bad request" });
  }
  const p = u.pathname;
  const method = req.method;
  let m;

  if ((m = p.match(/^\/repos\/([^/]+\/[^/]+)\/branches\/([^/]+)$/)) && method === "GET") {
    const repo = m[1];
    if (brokenRepos.has(repo)) return send(res, 500, { message: "mock: repo temporarily broken" });
    if (rateLimitedRepos.has(repo)) {
      requestLog.push({ route: "branches", repo, status: 403, authorization: req.headers.authorization || null });
      return send(res, 403, { message: "API rate limit exceeded for mock" });
    }
    return sendConditional(req, res, "branches", repo, { name: decodeURIComponent(m[2]), commit: { sha: currentCommitSha(repo) } });
  }
  if ((m = p.match(/^\/repos\/([^/]+\/[^/]+)\/git\/trees\/([0-9a-f]+)$/)) && method === "GET") {
    const repo = m[1];
    if (brokenRepos.has(repo)) return send(res, 500, { message: "mock: repo temporarily broken" });
    if (rateLimitedRepos.has(repo)) {
      requestLog.push({ route: "trees", repo, status: 403, authorization: req.headers.authorization || null });
      return send(res, 403, { message: "API rate limit exceeded for mock" });
    }
    return sendConditional(req, res, "trees", repo, { sha: m[2], truncated: false, tree: walkTree(repo) });
  }
  if ((m = p.match(/^\/([^/]+\/[^/]+)\/([0-9a-f]+)\/apps\/([^/]+)\/(.+)$/)) && method === "GET") {
    const [, repo, , slug, file] = m;
    const filePath = path.join(repoAppsDir(repo), slug, file);
    if (!fs.existsSync(filePath)) return send(res, 404, "404: Not Found");
    return send(res, 200, fs.readFileSync(filePath));
  }
  if (p === "/_mutate" && method === "POST") {
    let body;
    try {
      body = JSON.parse((await readBody(req)).toString("utf8") || "{}");
    } catch (_) {
      return send(res, 400, { error: "bad json" });
    }
    const { repo, slug, file, content } = body;
    if (!repo || !slug || !file || content === undefined) return send(res, 400, { error: "repo, slug, file, content required" });
    const dir = path.join(repoAppsDir(repo), slug);
    fs.mkdirSync(dir, { recursive: true });
    fs.writeFileSync(path.join(dir, file), content);
    bumpCommit(repo);
    return send(res, 200, { commitSha: currentCommitSha(repo) });
  }
  if (p === "/_break" && method === "POST") {
    let body;
    try {
      body = JSON.parse((await readBody(req)).toString("utf8") || "{}");
    } catch (_) {
      return send(res, 400, { error: "bad json" });
    }
    const { repo, broken } = body;
    if (!repo || typeof repo !== "string") return send(res, 400, { error: "repo required" });
    if (broken === false) brokenRepos.delete(repo);
    else brokenRepos.add(repo);
    return send(res, 200, { repo, broken: brokenRepos.has(repo) });
  }
  if (p === "/_rate-limit" && method === "POST") {
    let body;
    try {
      body = JSON.parse((await readBody(req)).toString("utf8") || "{}");
    } catch (_) {
      return send(res, 400, { error: "bad json" });
    }
    const { repo, limited } = body;
    if (!repo || typeof repo !== "string") return send(res, 400, { error: "repo required" });
    if (limited === false) rateLimitedRepos.delete(repo);
    else rateLimitedRepos.add(repo);
    return send(res, 200, { repo, limited: rateLimitedRepos.has(repo) });
  }
  if (p === "/_state" && method === "GET") {
    const repo = u.searchParams.get("repo");
    if (!repo) return send(res, 200, { ok: true, brokenRepos: Array.from(brokenRepos), rateLimitedRepos: Array.from(rateLimitedRepos) });
    return send(res, 200, { repo, commitSha: currentCommitSha(repo), tree: walkTree(repo), broken: brokenRepos.has(repo) });
  }
  if (p === "/_requests" && method === "GET") {
    const repo = u.searchParams.get("repo");
    const entries = repo ? requestLog.filter((r) => r.repo === repo) : requestLog.slice();
    return send(res, 200, { requests: entries });
  }

  send(res, 404, { error: `no route for ${method} ${p}` });
});

server.listen(PORT, () => {
  console.log(`mock-github listening on :${PORT} (fixtures: ${FIXTURE_DIR})`);
});
