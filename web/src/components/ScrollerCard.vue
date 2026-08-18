<template>
  <div class="app-row scroller-row" :class="{ 'screen-owner': scroller.running }">
    <div class="app-row-info">
      <div class="app-name-row">
        <span class="status-dot" :class="scroller.running ? 'running' : 'stopped'" :title="scroller.running ? 'cycling' : 'stopped'"></span>
        <span class="app-name" :title="scroller.name">{{ scroller.name }}</span>
        <span class="chip scroller">SCROLLER</span>
        <span v-if="scroller.scheduled" class="chip scheduled" title="A schedule slot is running this scroller">SCHEDULED</span>
        <span v-if="scroller.running && liveName" class="chip owner">{{ liveName }}</span>
      </div>
      <span class="app-desc">{{ summary }}</span>
    </div>

    <div class="app-row-controls">
      <label class="switch" :title="scroller.enabled ? 'Stop the cycle' : 'Run the cycle'">
        <input type="checkbox" :checked="scroller.enabled" :disabled="busy" @change="toggleEnabled" />
        <span class="track"></span>
      </label>
      <span class="spacer"></span>
      <button class="pill sm" @click="$emit('edit')" v-html="withLabel(icons.edit, 'Edit')"></button>
      <button
        class="pill sm danger"
        :disabled="busy"
        title="Delete this scroller (and any schedule slot that runs it)"
        @click="onDelete"
        v-html="withLabel(icons.trashFill, confirmDelete ? 'Sure?' : 'Delete')"
      ></button>
    </div>
  </div>
</template>

<script setup>
import { computed, ref } from 'vue'
import { deleteScroller, setScrollerEnabled } from '../composables/useManager'
import { icons } from '../icons'

const props = defineProps({
  scroller: { type: Object, required: true },
  apps: { type: Array, default: () => [] },
})
defineEmits(['edit'])

const busy = ref(false)

function appName(slug) {
  const app = props.apps.find((a) => a.slug === slug)
  return app?.name || slug
}

// The app that is on the bar right now — the one thing about a running
// scroller that is not visible from its step list.
const liveName = computed(() => (props.scroller.activeSlug ? appName(props.scroller.activeSlug) : ''))

const summary = computed(() => {
  const steps = props.scroller.steps || []
  if (!steps.length) return 'No apps yet — edit to add some.'
  const base = props.scroller.baseDurationSec
  const total = steps.reduce((sum, s) => sum + (s.durationSec || base), 0)
  const names = steps.map((s) => `${appName(s.slug)} ${s.durationSec || base}s`)
  const shown = names.slice(0, 4).join(' → ')
  return `${shown}${names.length > 4 ? ` → +${names.length - 4} more` : ''} · ${total}s per cycle`
})

function withLabel(svg, label) {
  return `${svg}<span>${label}</span>`
}

async function toggleEnabled(e) {
  const checked = e.target.checked
  busy.value = true
  try {
    await setScrollerEnabled(props.scroller.id, checked)
  } finally {
    busy.value = false
  }
}

// Two-step confirm, same pattern as removing an app.
const confirmDelete = ref(false)
async function onDelete() {
  if (!confirmDelete.value) {
    confirmDelete.value = true
    setTimeout(() => {
      confirmDelete.value = false
    }, 3000)
    return
  }
  confirmDelete.value = false
  busy.value = true
  try {
    await deleteScroller(props.scroller.id)
  } finally {
    busy.value = false
  }
}
</script>
