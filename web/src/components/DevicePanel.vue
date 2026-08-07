<template>
  <div class="dev-panel" :class="{ disabled: !enabled }">
    <div class="dev-stack">
      <!-- Every layer is exported on the same canvas, so they just stack. -->
      <img class="dev-layer" :src="ASSETS.base" alt="BUSY Bar control panel" @error="onMissing" />
      <img
        class="dev-layer dev-lever"
        :src="ASSETS.lever"
        :style="leverStyle"
        alt=""
        aria-hidden="true"
        @error="onMissing"
      />
      <img
        class="dev-layer dev-key"
        :class="{ down: down === 'start' }"
        :src="ASSETS.start"
        alt=""
        aria-hidden="true"
        @error="onMissing"
      />
      <img
        class="dev-layer dev-key"
        :class="{ down: down === 'back' }"
        :src="ASSETS.back"
        alt=""
        aria-hidden="true"
        @error="onMissing"
      />
      <img
        class="dev-layer dev-wheel"
        :style="wheelStyle"
        :src="ASSETS.wheel"
        alt=""
        aria-hidden="true"
        @error="onMissing"
      />

      <!-- Hit targets: transparent, sized/placed in % of the same canvas. -->
      <button
        v-for="s in STATES"
        :key="s.key"
        type="button"
        class="dev-hit dev-hit-label"
        :class="{ on: state === s.key }"
        :style="rect(s.rect)"
        :disabled="!enabled"
        :title="`Move the lever to ${s.label}`"
        @click="press(s.key)"
      >
        <span class="dev-hit-name">{{ s.label }}</span>
      </button>

      <button
        type="button"
        class="dev-hit dev-hit-start"
        :style="rect(HIT.start)"
        :disabled="!enabled"
        title="Start / Pause"
        @click="press('start')"
      >
        <span class="sr-only">Start / Pause</span>
      </button>

      <button
        type="button"
        class="dev-hit dev-hit-round"
        :style="rect(HIT.back)"
        :disabled="!enabled"
        title="Back"
        @click="press('back')"
      >
        <span class="sr-only">Back</span>
      </button>

      <!-- Wheel: the ring scrolls (left half up, right half down, matching the
           printed arrows), the hub is OK/Skip. Clipped to a circle by the
           wrapper so the corners don't steal clicks from the chassis. -->
      <div class="dev-wheel-hits" :style="rect(HIT.wheel)">
        <button
          type="button"
          class="dev-hit dev-hit-arc up"
          :disabled="!enabled"
          title="Scroll up"
          @click="press('up')"
        >
          <span class="sr-only">Scroll up</span>
        </button>
        <button
          type="button"
          class="dev-hit dev-hit-arc down"
          :disabled="!enabled"
          title="Scroll down"
          @click="press('down')"
        >
          <span class="sr-only">Scroll down</span>
        </button>
      </div>
      <button
        type="button"
        class="dev-hit dev-hit-round"
        :style="rect(HIT.ok)"
        :disabled="!enabled"
        title="OK / Skip"
        @click="press('ok')"
      >
        <span class="sr-only">OK / Skip</span>
      </button>
    </div>
  </div>
</template>

<script setup>
import { computed, ref } from 'vue'

const props = defineProps({
  // Currently selected state key ('busy' | 'custom' | 'off' | 'apps' | 'settings'),
  // or '' when this page hasn't moved the lever yet.
  state: { type: String, default: '' },
  enabled: { type: Boolean, default: true },
})
const emit = defineEmits(['press', 'unavailable'])

/*
 * Layered control panel. Each part of the device top is its own PNG exported
 * on the SAME 1920x472 canvas as brand/busybar-top.png (transparent
 * everywhere else), so the layers stack with `inset: 0` and stay registered
 * at any size — no per-sprite offsets, no JS measuring.
 *
 * Every number below was measured off that canvas and is expressed as a
 * percentage of it, so the whole panel scales with its container. Re-export
 * the art on the same canvas and none of this needs touching.
 */
const ASSETS = {
  base: '/brand/busybar-top-base.png', // chassis + printed labels, no moving parts
  lever: '/brand/busybar-top-lever.png', // state lever, drawn at the OFF detent
  start: '/brand/busybar-top-start.png', // Start / Pause plate
  back: '/brand/busybar-top-back.png', // Back disc
  wheel: '/brand/busybar-top-wheel.png', // scroll wheel
}

const FRAME = { w: 1920, h: 472 }
const px = (v, total) => `${((v / total) * 100).toFixed(3)}%`
// [x, y, w, h] in canvas pixels -> an absolutely-positioned box in %
function rect([x, y, w, h]) {
  return { left: px(x, FRAME.w), top: px(y, FRAME.h), width: px(w, FRAME.w), height: px(h, FRAME.h) }
}

// The lever swings around the centre of its round head and points at the
// printed label for each state; the angles are the bearings from that pivot
// to each label, measured on the canvas, relative to the lever's own pose in
// the asset (which is drawn at OFF).
const PIVOT = { x: 413, y: 231 }
const STATES = [
  { key: 'busy', label: 'Busy', deg: 80, rect: [105, 24, 195, 46] },
  { key: 'custom', label: 'Custom', deg: 35.9, rect: [105, 98, 195, 42] },
  { key: 'off', label: 'Off', deg: 0, rect: [105, 216, 195, 42] },
  { key: 'apps', label: 'Apps', deg: -36.7, rect: [105, 331, 195, 46] },
  { key: 'settings', label: 'Settings', deg: -80, rect: [105, 403, 195, 46] },
]

const HIT = {
  start: [500, 70, 930, 385],
  back: [1369, 51, 86, 86], // centre (1412, 94.5), r 43
  wheel: [1482, 90, 286, 286], // centre (1625, 233), r 143
  ok: [1563, 171, 124, 124], // hub of the wheel, r 62
}

const leverStyle = computed(() => {
  const s = STATES.find((x) => x.key === props.state)
  return {
    transformOrigin: `${px(PIVOT.x, FRAME.w)} ${px(PIVOT.y, FRAME.h)}`,
    transform: `rotate(${s ? s.deg : 0}deg)`,
  }
})

// Momentary feedback: the pressed key sinks, the wheel kicks in the scroll
// direction and springs back. The bar reports nothing, so this is the only
// confirmation that a press left the browser.
const down = ref('')
const wheelStyle = computed(() => {
  const kick = down.value === 'up' ? -9 : down.value === 'down' ? 9 : 0
  return { transform: `rotate(${kick}deg)`, transformOrigin: `${px(1625, FRAME.w)} ${px(233, FRAME.h)}` }
})

let downTimer = null
function press(key) {
  if (!props.enabled) return
  down.value = key
  clearTimeout(downTimer)
  downTimer = setTimeout(() => (down.value = ''), 260)
  emit('press', key)
}

// A missing layer would leave the panel half-drawn (or show a broken-image
// glyph), so the section falls back to the plain keypad instead.
function onMissing() {
  emit('unavailable')
}
</script>
