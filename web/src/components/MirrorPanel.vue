<template>
  <div class="preview">
    <div class="busybar">
      <img class="device-illu" src="/brand/busybar-device.png" alt="BUSY Bar" draggable="false" />
      <!-- Backing store at 720×dpr like the firmware's StateScreenStream.vue
           (screenStreamCanvasBaseResolutionWidth=720, height from the 72:16
           aspect); CSS scales it down, so the LED render stays razor sharp. -->
      <canvas
        v-show="hasFrame"
        ref="canvasRef"
        class="matrix"
        :width="CANVAS_BASE_W * dpr"
        :height="(CANVAS_BASE_W / FRONT_W) * FRONT_H * dpr"
        aria-label="LED matrix"
      ></canvas>
      <div v-if="!hasFrame" class="mirror-placeholder">no mirror available</div>
    </div>
    <div class="mirror-meta">
      <span class="owner-badge" :class="{ idle: !ownerLabel }">
        <span v-if="ownerLabel" class="dot"></span>{{ ownerLabel || '—' }}
      </span>
    </div>
  </div>
</template>

<script setup>
import { ref, computed, onMounted, onBeforeUnmount, watch } from 'vue'
import { LocalStateStream, ScreenRenderer, Display, getDisplayDimensions } from '@busy-app/busy-lib'
import { createRenderer as createEmuRenderer } from '../lib/emu/renderer.js'

const props = defineProps({
  barHost: { type: String, default: '' },
  screenOwner: { type: Object, default: null },
  apps: { type: Array, default: () => [] },
})

const { width: FRONT_W, height: FRONT_H } = getDisplayDimensions(Display.FRONT)
const FRONT_PIXELS = FRONT_W * FRONT_H
// Same base resolution as the firmware web UI (multiplied by the screen DPR).
const CANVAS_BASE_W = 720
const dpr = window.devicePixelRatio || 1

const canvasRef = ref(null)
const hasFrame = ref(false)
// 'connecting' | 'ws' | 'poll' | 'emu' | 'none'
const source = ref('connecting')
const ownerLabel = computed(() => {
  const owner = props.screenOwner
  if (owner && owner.applicationName) return `${owner.applicationName} owns the screen`
  const anyBlocked = (props.apps || []).some((a) => a.blocked)
  if (anyBlocked) return 'a firmware app owns the screen'
  return ''
})

let stream = null
let fallbackTimer = null // 3s "no frame yet" watchdog
let retryTimer = null // 30s ws retry while on poll/emu fallback
let pollTimer = null
let pollFail404Streak = 0 // consecutive /api/screen 404s — signals "no such endpoint" (busybar-emulator) rather than a transient outage
let lastFrameAt = 0
let destroyed = false

// Third rung of the source ladder: busybar-emulator has no ws/binary status
// API and no /api/screen, but does broadcast draw-element state over SSE
// (docs/CONTRACT.md "Bar-passthrough /api/_bar/*" makes it same-origin as
// /api/_bar/events). Rendered with the vendored emulator renderer (web/src/lib/emu/).
let emuSource = null // EventSource
let emuRenderer = null // { start(), stop() } from createEmuRenderer
let emuOledCanvas = null // renderer needs an OLED target too; never shown, created once
let emuWatchdogTimer = null // "no state event for N s" watchdog, both for initial connect and for going stale

function renderRgba(data, w, h) {
  if (!canvasRef.value) return
  try {
    ScreenRenderer.renderFrame(Display.FRONT, { canvas: canvasRef.value, data, width: w, height: h })
    hasFrame.value = true
    lastFrameAt = Date.now()
  } catch (_) {
    /* malformed frame, skip */
  }
}

function clearWatchdog() {
  if (fallbackTimer) {
    clearTimeout(fallbackTimer)
    fallbackTimer = null
  }
}

function stopWs() {
  clearWatchdog()
  if (stream) {
    try {
      stream.stop()
    } catch (_) {
      /* ignore */
    }
    stream = null
  }
}

function stopPoll() {
  if (pollTimer) {
    clearInterval(pollTimer)
    pollTimer = null
  }
}

function stopRetry() {
  if (retryTimer) {
    clearInterval(retryTimer)
    retryTimer = null
  }
}

// Ensures the existing "retry ws every 30s" timer is running — shared by every
// fallback rung (poll, emu) so the ladder always eventually re-tries from the
// top, however it got knocked down. Silent: a background probe from an
// already-settled fallback rung shouldn't flip `source` (and therefore
// shouldn't let a failed probe's fallToPoll() call disrupt a healthy poll/emu
// stream) — only an actual ws frame arriving should ever pre-empt it.
function ensureRetryTimer() {
  if (!retryTimer) {
    retryTimer = setInterval(() => {
      startWs({ silent: true })
    }, 30000)
  }
}

function clearEmuWatchdog() {
  if (emuWatchdogTimer) {
    clearTimeout(emuWatchdogTimer)
    emuWatchdogTimer = null
  }
}

function stopEmu() {
  clearEmuWatchdog()
  if (emuRenderer) {
    try {
      emuRenderer.stop()
    } catch (_) {
      /* ignore */
    }
    emuRenderer = null
  }
  if (emuSource) {
    try {
      emuSource.close()
    } catch (_) {
      /* ignore */
    }
    emuSource = null
  }
}

async function startWs({ silent = false } = {}) {
  if (!props.barHost || destroyed) return
  // A silent call is a background "has ws recovered?" probe fired while
  // we're already settled on poll/emu — don't flip `source` for it (that
  // would make a failed probe look, to fallToPoll()'s guard below, like a
  // fresh ws attempt worth falling back from, and needlessly restart the
  // rung that's already working).
  if (!silent) source.value = 'connecting'
  stopWs()
  // Same origin, not props.barHost: the manager tunnels /api/status/ws to the
  // bar (server.js handleUpgrade). A bar with a token set only accepts the
  // credential as the `X-API-Token` query parameter on the ws upgrade, and a
  // browser WebSocket can't send headers — so the hop that owns the token has
  // to be the manager, exactly like the /api/screen poll fallback below.
  stream = new LocalStateStream({ addr: window.location.origin })
  clearWatchdog()
  fallbackTimer = setTimeout(() => {
    if (Date.now() - lastFrameAt > 2900) fallToPoll()
  }, 3000)
  try {
    await stream.start({
      dataCallback: (state) => {
        for (const update of state.updates || []) {
          if (update.state !== 'frame' || !update.frame || !update.frame.data) continue
          if (update.frame.screen !== Display.FRONT) continue
          clearWatchdog()
          source.value = 'ws'
          stopPoll()
          stopEmu()
          stopRetry()
          renderRgba(update.frame.data, update.frame.width || FRONT_W, update.frame.height || FRONT_H)
        }
      },
      errorCallback: () => {
        fallToPoll()
      },
    })
  } catch (_) {
    fallToPoll()
  }
}

function fallToPoll() {
  if (destroyed) return
  clearWatchdog()
  stopWs()
  if (source.value === 'poll' || source.value === 'emu') {
    // Already settled on a fallback rung — this call is just a failed
    // background ws-retry probe (see startWs's `silent` option), so leave
    // the active poll/emu stream alone instead of tearing it down.
    ensureRetryTimer()
    return
  }
  stopEmu()
  source.value = 'poll'
  pollFail404Streak = 0
  startPoll()
  ensureRetryTimer()
}

function startPoll() {
  stopPoll()
  pollOnce()
  pollTimer = setInterval(pollOnce, 1000)
}

// Third rung: /api/screen doesn't exist at all on this bar (busybar-emulator).
// Switches to its SSE draw-element stream, rendered with the vendored emulator
// renderer straight into our existing canvas.
function fallToEmu() {
  if (destroyed) return
  stopPoll()
  if (source.value !== 'emu') {
    source.value = 'emu'
    startEmu()
  }
  ensureRetryTimer()
}

function resetEmuWatchdog(ms) {
  clearEmuWatchdog()
  emuWatchdogTimer = setTimeout(() => {
    if (destroyed) return
    // No usable data (initial connect, or the stream went stale) — bail all
    // the way out to the placeholder and let the existing 30s retryTimer
    // re-walk the ladder from ws.
    fallToNone()
  }, ms)
}

// Emulator mode dropped out (SSE never opened, or stopped delivering frames)
// — same "give up to a clean placeholder, let the ladder retry later" shape
// as the ws/poll rungs use.
function fallToNone() {
  if (destroyed) return
  stopEmu()
  source.value = 'none'
  hasFrame.value = false
  ensureRetryTimer()
}

function startEmu() {
  if (destroyed || !canvasRef.value) return
  stopEmu()
  const model = { frame: { application_name: null, elements: [], ts: 0 }, connected: true, brightness: 80 }
  let frameStamp = performance.now() / 1000
  let lastTs = -1
  if (!emuOledCanvas) {
    emuOledCanvas = document.createElement('canvas')
    emuOledCanvas.width = 160
    emuOledCanvas.height = 80
  }
  emuRenderer = createEmuRenderer(canvasRef.value, emuOledCanvas, () => model, () => frameStamp)
  emuRenderer.start()
  resetEmuWatchdog(4000) // no first state event within 4s -> this bar has no emulator SSE either
  emuSource = new EventSource('/api/_bar/events')
  emuSource.addEventListener('state', (e) => {
    let st
    try {
      st = JSON.parse(e.data)
    } catch (_) {
      return
    }
    if (!st || !st.frame) return
    hasFrame.value = true
    resetEmuWatchdog(10000) // stream is open but quiet for 10s -> treat as stale, not just idle-app
    if (st.frame.ts !== lastTs) {
      lastTs = st.frame.ts
      frameStamp = performance.now() / 1000
    }
    model.frame = st.frame
    if (st.brightness != null) model.brightness = st.brightness
  })
  emuSource.onerror = () => {
    // EventSource retries connections on its own; only the watchdog (above)
    // decides when a silence is long enough to give up on this rung.
  }
}

// Frame normalization mirrors the firmware's StateScreenStream.vue: the real
// bar's GET /api/screen body is base64 whose decoded bytes are raw pixel data
// (BGR888 or BGRA), NOT an actual BMP file — despite the image/bmp content
// type. We additionally accept a genuine BMP (e.g. from test tooling).
function decodeBase64(text) {
  const decoded = atob(text.trim())
  const data = new Uint8Array(decoded.length)
  for (let i = 0; i < decoded.length; i++) data[i] = decoded.charCodeAt(i)
  return data
}

function bgrToRgbaBytes(src) {
  const out = new Uint8Array((src.length / 3) * 4)
  for (let s = 0, t = 0; s < src.length; s += 3, t += 4) {
    out[t] = src[s + 2]
    out[t + 1] = src[s + 1]
    out[t + 2] = src[s]
    out[t + 3] = 0xff
  }
  return out
}

function opaqueAlphaBytes(src) {
  const out = src.slice()
  for (let i = 3; i < out.length; i += 4) out[i] = 0xff
  return out
}

function renderBmpBlob(url, revoke) {
  const img = new Image()
  img.onload = () => {
    const off = document.createElement('canvas')
    off.width = FRONT_W
    off.height = FRONT_H
    const ctx = off.getContext('2d', { willReadFrequently: true })
    ctx.drawImage(img, 0, 0, FRONT_W, FRONT_H)
    try {
      const imgData = ctx.getImageData(0, 0, FRONT_W, FRONT_H)
      renderRgba(imgData.data, FRONT_W, FRONT_H)
    } catch (_) {
      /* tainted canvas or decode issue, skip this tick */
    }
    if (revoke) URL.revokeObjectURL(url)
  }
  img.onerror = () => {
    if (revoke) URL.revokeObjectURL(url)
  }
  img.src = url
}

async function pollOnce() {
  try {
    const res = await fetch(`/api/screen?display=0`)
    if (res.status === 404) {
      // A real bar/firmware always has /api/screen; a sustained 404 means
      // this endpoint doesn't exist at all on this barHost (busybar-emulator).
      // A single 404 could just be a proxy hiccup, so require a short streak
      // before dropping to the emulator rung.
      pollFail404Streak += 1
      if (pollFail404Streak >= 3) fallToEmu()
      return
    }
    pollFail404Streak = 0
    if (!res.ok) throw new Error('screen fetch failed')
    const blob = await res.blob()
    const text = await blob.text().catch(() => '')
    const trimmed = text.trim()
    const looksBase64 = trimmed.length > 0 && trimmed.length % 4 === 0 && /^[A-Za-z0-9+/]+=*$/.test(trimmed)
    const bytes = looksBase64 ? decodeBase64(trimmed) : new Uint8Array(await blob.arrayBuffer())

    if (bytes.length === FRONT_PIXELS * 3) {
      renderRgba(bgrToRgbaBytes(bytes), FRONT_W, FRONT_H) // raw BGR888 (real firmware)
    } else if (bytes.length === FRONT_PIXELS * 4) {
      renderRgba(opaqueAlphaBytes(bytes), FRONT_W, FRONT_H)
    } else if (bytes[0] === 0x42 && bytes[1] === 0x4d) {
      // Genuine BMP file ("BM" magic): let the browser decode it.
      const url = URL.createObjectURL(new Blob([bytes], { type: 'image/bmp' }))
      renderBmpBlob(url, true)
    }
  } catch (_) {
    // no mirror source at all yet — keep placeholder, next tick will retry
  }
}

function boot() {
  destroyed = false
  lastFrameAt = 0
  pollFail404Streak = 0
  hasFrame.value = false
  startWs()
}

function teardown() {
  destroyed = true
  stopWs()
  stopPoll()
  stopEmu()
  stopRetry()
}

onMounted(boot)
onBeforeUnmount(teardown)
watch(
  () => props.barHost,
  () => {
    teardown()
    boot()
  }
)
</script>
