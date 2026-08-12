<template>
  <section class="section-card">
    <div class="sc-head">
      <div class="sc-head-inner">
        <div class="sc-title-wrap">
          <span class="sc-icon" v-html="icons.gamepad"></span>
          <div>
            <div class="sc-title">Controller</div>
            <div class="sc-subtitle">Press the bar's buttons remotely.</div>
          </div>
        </div>
      </div>
    </div>
    <div class="sc-body">
      <DevicePanel
        v-if="panelOk"
        :state="lastState"
        :enabled="ready"
        @press="press"
        @unavailable="panelOk = false"
      />

      <!-- Fallback for a build without the layered panel art: same ten keys,
           plain buttons. -->
      <template v-else>
        <div class="row-block">
          <div class="rb-head">
            <div class="rb-title">Main</div>
            <div class="rb-hint">The bar's big front button.</div>
          </div>
          <button class="pill brand ctl-start" :disabled="!ready" @click="press('start')">
            <span v-html="icons.play"></span>Start
          </button>
        </div>

        <div class="row-block ctl-block">
          <div class="rb-head">
            <div class="rb-title">State</div>
            <div class="rb-hint">Switches the bar to a state, same as its state keys.</div>
          </div>
          <div class="ctl-states">
            <button
              v-for="k in STATE_KEYS"
              :key="k.key"
              type="button"
              class="ctl-key"
              :class="{ active: lastState === k.key, sent: flash === k.key }"
              :disabled="!ready"
              :title="`Send '${k.key}'`"
              @click="press(k.key)"
            >
              <span v-html="k.icon"></span>{{ k.label }}
            </button>
          </div>
        </div>

        <div class="row-block ctl-block">
          <div class="rb-head">
            <div class="rb-title">Navigation</div>
            <div class="rb-hint">Move through the on-device menus.</div>
          </div>
          <div class="ctl-dpad">
            <button
              v-for="k in NAV_KEYS"
              :key="k.key"
              type="button"
              class="ctl-key"
              :class="[k.cls, { sent: flash === k.key }]"
              :disabled="!ready"
              :aria-label="k.label"
              :title="`Send '${k.key}'`"
              @click="press(k.key)"
            >
              <span v-html="k.icon"></span>
            </button>
          </div>
        </div>
      </template>

      <div class="ctl-status">
        <span v-if="!ready" class="status-chip warn">Bar unreachable</span>
        <span v-else-if="error" class="status-chip bad">{{ error }}</span>
        <span v-else-if="lastSent" class="status-chip ok">Sent “{{ lastSent }}”</span>
        <span v-else class="status-chip">Ready</span>
        <span class="hint">
          {{
            !ready
              ? 'Check the connection in Settings.'
              : 'The bar acknowledges a key but never reports its state back, so the lever only shows what this page sent last.'
          }}
        </span>
      </div>
    </div>
  </section>
</template>

<script setup>
import { computed, ref } from 'vue'
import { manager, sendInput } from '../composables/useManager'
import { icons } from '../icons'
import DevicePanel from './DevicePanel.vue'

// The `key` values are the ones POST /api/input accepts verbatim (openapi.yaml).
const STATE_KEYS = [
  { key: 'busy', label: 'Busy', icon: icons.busy },
  { key: 'custom', label: 'Custom', icon: icons.edit },
  { key: 'off', label: 'Off', icon: icons.power },
  { key: 'apps', label: 'Apps', icon: icons.gridFill },
  { key: 'settings', label: 'Settings', icon: icons.settingsOutline },
]
const NAV_KEYS = [
  { key: 'up', label: 'Up', icon: icons.chevronUp, cls: 'ctl-up' },
  { key: 'ok', label: 'OK', icon: icons.checkmark, cls: 'ctl-ok' },
  { key: 'down', label: 'Down', icon: icons.chevronDown, cls: 'ctl-down' },
  { key: 'back', label: 'Back', icon: icons.arrowLeft, cls: 'ctl-back' },
]

const panelOk = ref(true)
const ready = computed(() => manager.barReachable)
const lastSent = ref('')
const lastState = ref('') // optimistic: which state key this page sent last
const error = ref('')
const flash = ref('') // key currently playing the "sent" pulse (fallback keypad)

let flashTimer = null
async function press(key) {
  if (!ready.value) return
  error.value = ''
  flash.value = key
  clearTimeout(flashTimer)
  flashTimer = setTimeout(() => (flash.value = ''), 400)
  const r = await sendInput(key)
  if (!r.ok) {
    error.value = r.json?.error || `Sending “${key}” failed (${r.status})`
    return
  }
  lastSent.value = key
  if (STATE_KEYS.some((k) => k.key === key)) lastState.value = key
}
</script>
