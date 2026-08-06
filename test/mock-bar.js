"use strict";
/*
 * Zero-dependency mock of the BUSY Bar HTTP API, for busybar-manager tests.
 *
 * Implements just enough of the real firmware to exercise the manager's
 * proxy and draw-attribution logic: POST/DELETE /api/display/draw with
 * firmware-faithful priority arbitration (canvas_draw_rejected rule: the
 * current owner may redraw at equal priority, a different app needs
 * strictly higher priority), GET /api/version, GET /api/screen (a tiny
 * synthesized 72x16 24-bit BMP), and a minimal GET /events SSE stream (like
 * busybar-emulator's) emitting a couple of `state` events, so the manager's
 * streaming /api/_bar/* passthrough has something to pipe. A couple of
 * "/_*" debug routes let tests inspect what the manager actually sent (e.g.
 * DELETE calls on disable).
 *
 * Usage: node mock-bar.js [port]   (or PORT=nnnn node mock-bar.js)
 */
const http = require("http");

const PORT = Number(process.env.PORT || process.argv[2] || 8090);

let frame = { applicationName: null, priority: 0, color: [20, 20, 20] };
const drawLog = [];

function colorFor(appName) {
  let h = 0;
  for (const c of String(appName)) h = (h * 31 + c.charCodeAt(0)) >>> 0;
  return [h & 0xff, (h >> 8) & 0xff, (h >> 16) & 0xff];
}

// Firmware rule (canvas_draw_rejected): the current owner may redraw at
// equal priority; a different app needs strictly higher priority.
function tryDraw(appName, priority) {
  if (frame.applicationName) {
    const sameApp = appName === frame.applicationName;
    if (sameApp ? priority < frame.priority : priority <= frame.priority) return false;
  }
  frame = { applicationName: appName, priority, color: colorFor(appName) };
  return true;
}

// Hand-rolled ~54-byte BITMAPFILEHEADER + BITMAPINFOHEADER, 24-bit BGR pixel
// data, bottom-up rows padded to a 4-byte boundary.
function bmp72x16(rgb) {
  const w = 72, h = 16;
  const rowSize = Math.ceil((w * 3) / 4) * 4;
  const pixelDataSize = rowSize * h;
  const fileSize = 54 + pixelDataSize;
  const buf = Buffer.alloc(fileSize);
  buf.write("BM", 0, "ascii");
  buf.writeUInt32LE(fileSize, 2);
  buf.writeUInt32LE(0, 6);
  buf.writeUInt32LE(54, 10);
  buf.writeUInt32LE(40, 14);
  buf.writeInt32LE(w, 18);
  buf.writeInt32LE(h, 22);
  buf.writeUInt16LE(1, 26);
  buf.writeUInt16LE(24, 28);
  buf.writeUInt32LE(0, 30);
  buf.writeUInt32LE(pixelDataSize, 34);
  buf.writeInt32LE(2835, 38);
  buf.writeInt32LE(2835, 42);
  buf.writeUInt32LE(0, 46);
  buf.writeUInt32LE(0, 50);
  const [r, g, b] = rgb;
  let offset = 54;
  for (let y = 0; y < h; y++) {
    for (let x = 0; x < w; x++) {
      buf[offset++] = b;
      buf[offset++] = g;
      buf[offset++] = r;
    }
    offset += rowSize - w * 3;
  }
  return buf;
}

function send(res, code, obj) {
  const body = Buffer.isBuffer(obj) ? obj : Buffer.from(JSON.stringify(obj));
  res.writeHead(code, { "Content-Type": Buffer.isBuffer(obj) ? "application/octet-stream" : "application/json" });
  res.end(body);
}
function sendText(res, code, text) {
  res.writeHead(code, { "Content-Type": "text/plain" });
  res.end(text);
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

  if (p === "/api/display/draw" && method === "POST") {
    let body;
    try {
      body = JSON.parse((await readBody(req)).toString("utf8") || "{}");
    } catch (_) {
      return send(res, 400, { error: "bad json" });
    }
    const appName = body.application_name || body.app_id;
    if (!appName) return send(res, 400, { error: "application_name required" });
    if (!Array.isArray(body.elements) || !body.elements.length) return send(res, 400, { error: "elements required" });
    const priority = body.priority == null ? 50 : body.priority;
    const ok = tryDraw(appName, priority);
    drawLog.push({ method, path: p, appName, priority, ok, ts: Date.now() });
    if (drawLog.length > 500) drawLog.shift();
    if (!ok) return send(res, 409, { error: "Not drawn due to low priority" });
    return send(res, 200, { result: "OK" });
  }
  if (p === "/api/display/draw" && method === "DELETE") {
    const appName = u.searchParams.get("application_name");
    drawLog.push({ method, path: p, appName, ts: Date.now() });
    if (drawLog.length > 500) drawLog.shift();
    if (!appName || frame.applicationName === appName) {
      frame = { applicationName: null, priority: 0, color: [20, 20, 20] };
    }
    return send(res, 200, { result: "OK" });
  }
  if (p === "/api/version" && method === "GET") return send(res, 200, { api: "25.0.0", mock: true });
  if (p === "/api/screen" && method === "GET") return sendText(res, 200, bmp72x16(frame.color).toString("base64"));

  // Minimal SSE stream, like busybar-emulator's own GET /events: a couple of
  // `state` events a beat apart (so a test can observe them arriving
  // incrementally, not just at stream end), then it just stays open like a
  // real long-lived mirror stream would.
  if (p === "/events" && method === "GET") {
    res.writeHead(200, { "Content-Type": "text/event-stream", "Cache-Control": "no-cache", "Connection": "keep-alive" });
    res.write("retry: 2000\n\n");
    let seq = 0;
    const send1 = () => {
      seq += 1;
      res.write(`event: state\ndata: ${JSON.stringify({ seq, frame, ts: Date.now() })}\n\n`);
    };
    send1();
    const timer = setInterval(send1, 150);
    req.on("close", () => clearInterval(timer));
    return;
  }

  // test-only introspection endpoints (not part of the firmware API)
  if (p === "/_frame" && method === "GET") return send(res, 200, frame);
  if (p === "/_log" && method === "GET") return send(res, 200, { log: drawLog.slice(-300) });
  if (p === "/_echo-query" && method === "GET") return send(res, 200, { query: Object.fromEntries(u.searchParams) });
  if (p === "/_reset" && method === "POST") {
    frame = { applicationName: null, priority: 0, color: [20, 20, 20] };
    drawLog.length = 0;
    return send(res, 200, { result: "OK" });
  }

  send(res, 404, { error: `no route for ${method} ${p}` });
});

server.listen(PORT, () => {
  console.log(`mock-bar listening on :${PORT}`);
});
