<template>
  <div class="app-row" :class="{ 'screen-owner': isOwner, missing: app.missing }">
    <div class="app-row-info">
      <div class="app-name-row">
        <span class="status-dot" :class="statusClass" :title="statusLabel"></span>
        <span class="app-name" :title="app.name">{{ app.name }}</span>
        <span v-if="isOwner" class="chip owner">SCREEN</span>
        <span
          v-if="app.scheduledVariation"
          class="chip scheduled"
          :title="`A schedule slot is running this app on the &quot;${app.scheduledVariation}&quot; variation`"
        >SCHEDULED · {{ app.scheduledVariation }}</span>
        <span v-if="app.blocked" class="chip blocked">409</span>
        <span v-if="app.missing" class="chip missing">folder missing</span>
        <span v-if="app.updateAvailable" class="chip update">update available</span>
        <span v-if="app.source === 'local'" class="chip local">local</span>
        <span v-for="t in app.tags" :key="t" class="app-tag">{{ t }}</span>
      </div>
      <span class="app-desc">{{ app.description || '—' }}</span>
    </div>

    <div class="app-row-controls">
      <label class="switch" :title="app.enabled ? 'Disable' : 'Enable'">
        <input type="checkbox" :checked="app.enabled" :disabled="busy" @change="toggleEnabled" />
        <span class="track"></span>
      </label>
      <select
        class="select compact"
        :value="app.variation"
        :disabled="busy || !hasVariations"
        @change="onVariationChange"
      >
        <option v-for="name in variationNames" :key="name" :value="name">{{ name }}</option>
      </select>
      <span class="spacer"></span>
      <button
        v-if="app.updateAvailable"
        class="pill sm brand"
        :disabled="busy"
        @click="doUpdate"
        v-html="withLabel(icons.download, 'Update')"
      ></button>
      <button class="pill sm" :disabled="busy || app.status === 'stopped'" @click="doRestart" v-html="withLabel(icons.restart, 'Restart')"></button>
      <button class="pill sm" @click="$emit('edit-variation')" v-html="withLabel(icons.edit, 'Variation')"></button>
      <button class="pill sm" @click="$emit('open-logs')" v-html="withLabel(icons.terminal, 'Logs')"></button>
      <span class="app-meta" v-if="app.pid">pid {{ app.pid }}</span>
    </div>
  </div>
</template>

<script setup>
import { computed, ref } from 'vue'
import { enableApp, disableApp, restartApp, setVariation, updateApp } from '../composables/useManager'
import { icons } from '../icons'

const props = defineProps({
  app: { type: Object, required: true },
  isOwner: { type: Boolean, default: false },
})
defineEmits(['edit-variation', 'open-logs'])

const busy = ref(false)

const statusClass = computed(() => (props.app.missing ? 'missing' : props.app.status))
const statusLabel = computed(
  () =>
    ({
      running: 'running',
      starting: 'starting…',
      crashed: 'crashed',
      stopped: 'stopped',
    }[props.app.status] || props.app.status)
)

const variationNames = computed(() => Object.keys(props.app.variations || { default: {} }))
const hasVariations = computed(() => variationNames.value.length > 0)

function withLabel(svg, label) {
  return `${svg}<span>${label}</span>`
}

async function toggleEnabled(e) {
  const checked = e.target.checked
  busy.value = true
  try {
    if (checked) await enableApp(props.app.slug)
    else await disableApp(props.app.slug)
  } finally {
    busy.value = false
  }
}

async function doRestart() {
  busy.value = true
  try {
    await restartApp(props.app.slug)
  } finally {
    busy.value = false
  }
}

async function doUpdate() {
  busy.value = true
  try {
    await updateApp(props.app.slug)
  } finally {
    busy.value = false
  }
}

async function onVariationChange(e) {
  const name = e.target.value
  busy.value = true
  try {
    await setVariation(props.app.slug, name)
  } finally {
    busy.value = false
  }
}
</script>
