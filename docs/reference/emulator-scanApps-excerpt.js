  try { files = fs.readdirSync(SOUNDS_DIR); } catch (_) { return out; }
  for (const f of files) { if (/\.(wav|mp3|ogg)$/i.test(f)) out[path.basename(f, path.extname(f))] = f; }
  return out;
}
const SOUNDS = scanSounds();

/* --------------------------------- apps ---------------------------------- */
// Hand-written inputs for bundled apps whose args aren't argparse-discoverable.
// Gallery apps in apps/local auto-discover their argparse options at scan time.
const APP_PARAMS = {
  "busy_status.py": [{ key: "theme", label: "Theme", type: "select", positional: true, default: "on_air",
    options: ["keep_out","dnd","meeting","on_call","lunch","back_soon","booked","flow","chill_time","on_air","coding","low_social_battery"] }],
};

// Auto-discover an argparse app's options by parsing its own `--help` output,
// so the Apps tab can render inputs without a hand-written APP_PARAMS entry.
// Only runs for scripts that mention argparse (others might loop on --help),
// cached per file mtime; the runner passes --host itself so it is skipped.
const ARG_SKIP = new Set(["-h", "--help", "--host", "--test"]);
const argCache = {};
function argparseParams(fullPath) {
  let mtime;
  try { mtime = fs.statSync(fullPath).mtimeMs; } catch (_) { return []; }
  const hit = argCache[fullPath];
  if (hit && hit.mtime === mtime) return hit.params;
  let params = [];
  try {
    if (fs.readFileSync(fullPath, "utf8").includes("argparse")) {
      const r = spawnSync(PYTHON, [fullPath, "--help"], { timeout: 3000, encoding: "utf8" });
      if (r.status === 0 && r.stdout) params = parseHelp(r.stdout);
    }
  } catch (_) {}
  argCache[fullPath] = { mtime, params };
  return params;
}
function parseHelp(help) {
  const params = [];
  // option entries look like "  --theme {a,b,c}  help..." or "  --user USER  help..."
  // or "  --test  help..."; continuation lines are indented further.
  const re = /^[ ]{2}(--[\w-]+)(?:[ =](\{[^}]*\}|[A-Z][\w-]*))?(?:[ \t]{2,}(\S.*))?$/gm;
  let m;
  while ((m = re.exec(help)) !== null) {
    const [, flag, meta, rest] = m;
    if (ARG_SKIP.has(flag)) continue;
    const key = flag.replace(/^--/, "");
    const label = key.charAt(0).toUpperCase() + key.slice(1).replace(/-/g, " ");
    // find the help text: trailing same-line text or the indented next line
    let hint = rest || "";
    if (!hint) {
      const after = help.slice(m.index + m[0].length);
      const cont = after.match(/^\n\s{10,}(\S.*)/);
      if (cont) hint = cont[1];
    }
    const def = (hint.match(/\(default:\s*([^)]+)\)/) || [])[1];
    if (meta && meta.startsWith("{")) {
      const options = meta.slice(1, -1).split(",").map((s) => s.trim()).filter(Boolean);
      params.push({ key, label, type: "select", flag, options, default: def || options[0], help: hint });
    } else if (!meta) {
      params.push({ key, label, type: "check", flag, help: hint });
    } else {
      params.push({ key, label, type: "text", flag, placeholder: def || "", help: hint });
    }
  }
  return params;
}

function scanApps() {
  const isApp = (f) => f.endsWith(".py") && f !== "busybar.py" && !f.startsWith("_");
  const describe = (fullPath, fallback) => {
    try {
      const head = fs.readFileSync(fullPath, "utf8").slice(0, 2048);
      const m = head.match(/"""[\s\n]*([^\n"]+)/);
      if (m) return m[1].trim();
    } catch (_) {}
    return fallback;
  };
  // rel is the path under apps/ used to spawn the script; slug (its basename or
  // folder name) is the display name and the APP_PARAMS key.
  const make = (rel, slug, script, prefix) => {
    const full = path.join(APPS_DIR, rel);
    const entry = { name: prefix ? `${prefix}/${slug}` : slug, file: rel,
      description: describe(full, slug), params: APP_PARAMS[script] || argparseParams(full) };
    if (prefix) entry.local = true;
    return entry;
  };
  const scan = (dir, prefix = "") => {
    let ents = [];
    try { ents = fs.readdirSync(dir, { withFileTypes: true }); } catch (_) { return []; }
    const out = [];
    for (const d of ents) {
      const rel = prefix ? `${prefix}/${d.name}` : d.name;
      // Flat single-file app: apps/local/foo.py
      if (d.isFile() && isApp(d.name)) { out.push(make(rel, d.name.replace(".py", ""), d.name, prefix)); continue; }
      // Foldered app (local only): apps/local/<slug>/<slug>.py, else app.py, else the lone .py
      if (prefix && d.isDirectory() && !d.name.startsWith("_") && !d.name.startsWith(".")) {
        let subFiles = [];
        try { subFiles = fs.readdirSync(path.join(dir, d.name)).filter(isApp); } catch (_) {}
        const script = subFiles.includes(`${d.name}.py`) ? `${d.name}.py`
          : subFiles.includes("app.py") ? "app.py"
          : subFiles.length === 1 ? subFiles[0] : null;
        if (script) out.push(make(`${rel}/${script}`, d.name, script, prefix));
      }
    }
    return out;
  };
  return scan(APPS_DIR).concat(scan(path.join(APPS_DIR, "local"), "local"));
}

let appProc = null;  // { child, name, pid, startedAt, exitCode, error, output, buf }
let appOpChain = Promise.resolve();
let appBcastTimer = null;

function appStatus() {
  if (!appProc) return { running: false, name: null, pid: null, startedAt: null, exitCode: null, error: null, output: [] };
  return { running: appProc.exitCode === undefined && !appProc.error, name: appProc.name, pid: appProc.pid || null, startedAt: appProc.startedAt, exitCode: appProc.exitCode !== undefined ? appProc.exitCode : null, error: appProc.error || null, output: appProc.output };
}

// rec-scoped so a late exit from a replaced child can't touch the current app's state
function pushLine(rec, s, line) {
  if (line.length > 300) line = line.slice(0, 300) + "…";
  rec.output.push({ t: Date.now(), s, line });
  if (rec.output.length > 50) rec.output.shift();
  if (rec !== appProc || appBcastTimer) return;
  appBcastTimer = setTimeout(() => { appBcastTimer = null; broadcast(); }, 50);
}

// Wire stdout/stderr of a child process into rec's line buffers via pushLine.
function wireStreams(child, rec) {
  function lineBuffer(stream, s) {
    child[stream].on("data", (chunk) => {
      rec.buf[s] += chunk.toString("utf8");
      let nl;
      while ((nl = rec.buf[s].indexOf("\n")) !== -1) {
        pushLine(rec, s, rec.buf[s].slice(0, nl));
        rec.buf[s] = rec.buf[s].slice(nl + 1);
      }
    });
  }
  lineBuffer("stdout", "out");
  lineBuffer("stderr", "err");
}

// Run a setup child (venv create or pip install) with its streams wired into rec.
// Resolves on exit code 0, rejects with "venv setup failed (exit N)" otherwise.
// The child is assigned to rec.child while running so stopApp() can kill it.
function runSetup(rec, cmd, args) {
  return new Promise((resolve, reject) => {
    const child = spawn(cmd, args, {
      env: Object.assign({}, process.env, { PYTHONUNBUFFERED: "1" }),
      stdio: ["ignore", "pipe", "pipe"],
      detached: true,
    });
    rec.child = child;
    wireStreams(child, rec);
    child.on("error", (err) => { rec.child = null; reject(new Error(`venv setup failed (${err.message})`)); });
    child.on("exit", (code) => {
      // flush trailing partial lines from this setup child's streams
      if (rec.buf.out) { pushLine(rec, "out", rec.buf.out); rec.buf.out = ""; }
      if (rec.buf.err) { pushLine(rec, "err", rec.buf.err); rec.buf.err = ""; }
      rec.child = null;
      const n = code !== null ? code : -1;
      if (n !== 0) reject(new Error(`venv setup failed (exit ${n})`));
      else resolve();
    });
  });
}

async function startApp(entry, userArgs) {
  const rec = { child: null, name: entry.name, pid: null, startedAt: Date.now(), exitCode: undefined, error: null, output: [], buf: { out: "", err: "" } };
  appProc = rec;
  broadcast();

  // Determine whether this is a foldered app that needs a venv.
  const fileDir = path.dirname(entry.file);
  const isFoldered = fileDir !== "." && fileDir !== "local";
  const folder = path.join(APPS_DIR, fileDir);
  const reqFile = path.join(folder, "requirements.txt");
  let pyBin = PYTHON;

  if (isFoldered && fs.existsSync(reqFile)) {
    const venvDir = path.join(folder, ".venv");
