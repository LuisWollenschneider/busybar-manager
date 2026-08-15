<template>
  <div class="modal-backdrop" @click.self="$emit('close')">
    <div class="modal glass wide">
      <div class="modal-head">
        <h2 class="card-title" style="margin:0">
          <span class="badge" v-html="icons.grid"></span>{{ isNew ? 'New scroller' : 'Edit scroller' }}
        </h2>
        <button class="modal-close" @click="$emit('close')" v-html="icons.close"></button>
      </div>

      <div class="form-grid">
        <div class="field">
          <label for="scr-name">Name</label>
          <input id="scr-name" type="text" v-model="form.name" maxlength="60" placeholder="Desk" />
        </div>
        <div class="field">
          <label for="scr-base">Base duration (seconds)</label>
          <input id="scr-base" type="number" min="1" :max="MAX_DURATION" step="1" v-model="form.baseDurationSec" />
          <span class="hint">How long each app stays on the bar, unless it sets its own duration below.</span>
        </div>
      </div>

      <div class="field">
        <label>Apps in the cycle</label>
        <div v-if="!apps.length" class="empty-note">No apps found — install or add apps before building a scroller.</div>
        <div v-else-if="!form.steps.length" class="empty-note">
          No apps yet — add the first one below. They run top to bottom and then start over.
        </div>
        <div v-else class="scr-steps">
          <div v-for="(s, i) in form.steps" :key="s.key" class="scr-step" :class="{ live: s.id && s.id === activeStepId }">
            <span class="scr-step-idx">{{ i + 1 }}</span>
            <select class="select compact scr-step-app" v-model="s.slug" @change="onStepAppChange(s)">
              <option v-for="a in apps" :key="a.slug" :value="a.slug">{{ a.name || a.slug }}</option>
            </select>
            <select class="select compact scr-step-var" v-model="s.variation">
              <option v-for="name in variationNames(s.slug)" :key="name" :value="name">{{ name }}</option>
            </select>
            <input
              class="scr-step-dur"
              type="number"
              min="1"
              :max="MAX_DURATION"
              step="1"
              v-model="s.durationSec"
              :placeholder="`${form.baseDurationSec || ''}s`"
              :title="`Custom duration in seconds — leave empty to use the base duration`"
            />
            <button class="pill sm icon-only" :disabled="i === 0" title="Move up" @click="move(i, -1)" v-html="icons.chevronUp"></button>
            <button
              class="pill sm icon-only"
              :disabled="i === form.steps.length - 1"
              title="Move down"
              @click="move(i, 1)"
              v-html="icons.chevronDown"
            ></button>
            <button class="pill sm icon-only danger" title="Remove from the cycle" @click="form.steps.splice(i, 1)" v-html="icons.trashFill"></button>
          </div>
        </div>
        <div class="scr-add">
          <button class="pill sm" :disabled="!apps.length" @click="addStep" v-html="withLabel(icons.plus, 'Add app')"></button>
          <span class="hint">{{ cycleLabel }}</span>
        </div>
      </div>

      <p v-if="error" class="hint" style="color:var(--error)">{{ error }}</p>

      <div class="modal-foot">
        <button
          v-if="!isNew"
          class="pill danger"
          :disabled="busy"
          title="Delete this scroller"
          @click="onDelete"
          v-html="withLabel(icons.trashFill, confirmDelete ? 'Sure?' : 'Delete')"
        ></button>
        <span class="spacer"></span>
        <button class="pill" :disabled="busy" @click="$emit('close')">Cancel</button>
        <button class="pill brand" :disabled="busy || !form.name.trim() || !form.steps.length" @click="onSave" v-html="withLabel(icons.save, 'Save')"></button>
      </div>
    </div>
  </div>
</template>

<script setup>
import { ref, reactive, computed, onMounted, onUnmounted } from 'vue'
import { createScroller, updateScroller, deleteScroller } from '../composables/useManager'
import { icons } from '../icons'

const MAX_DURATION = 3600

const props = defineProps({
  // { id|null, name, baseDurationSec, steps: [{ id, slug, variation,
  // durationSec }] } — id null means "create".
  scroller: { type: Object, required: true },
  apps: { type: Array, default: () => [] },
})
const emit = defineEmits(['close'])

const onKeydown = (e) => {
  if (e.key === 'Escape') emit('close')
}
onMounted(() => window.addEventListener('keydown', onKeydown))
onUnmounted(() => window.removeEventListener('keydown', onKeydown))

const busy = ref(false)
const error = ref('')
const isNew = computed(() => !props.scroller.id)
const activeStepId = computed(() => props.scroller.activeStepId || null)

// `key` is a local, stable v-for key: a new step has no server id yet, and
// reordering must not make Vue re-create the rows (which would drop focus).
let nextKey = 0
const form = reactive({
  name: props.scroller.name || '',
  baseDurationSec: props.scroller.baseDurationSec || 10,
  steps: (props.scroller.steps || []).map((s) => ({
    key: nextKey++,
    id: s.id || null,
    slug: s.slug,
    variation: s.variation || 'default',
    // The input is empty for "use the base duration"; the server takes null.
    durationSec: s.durationSec == null ? '' : String(s.durationSec),
  })),
})

const cycleLabel = computed(() => {
  if (!form.steps.length) return ''
  const base = Number(form.baseDurationSec) || 0
  const total = form.steps.reduce((sum, s) => sum + (Number(s.durationSec) || base), 0)
  return `${form.steps.length} ${form.steps.length === 1 ? 'app' : 'apps'} · one full cycle takes ${total}s`
})

function appOf(slug) {
  return props.apps.find((a) => a.slug === slug) || null
}
function variationNames(slug) {
  return Object.keys(appOf(slug)?.variations || { default: {} })
}

function withLabel(svg, label) {
  return `${svg}<span>${label}</span>`
}

// Every addition lands with a variation already set — the app's own selection
// if it has one, otherwise its first.
function addStep() {
  const app = props.apps[0]
  if (!app) return
  const names = variationNames(app.slug)
  form.steps.push({
    key: nextKey++,
    id: null,
    slug: app.slug,
    variation: names.includes(app.variation) ? app.variation : names[0] || 'default',
    durationSec: '',
  })
}

function onStepAppChange(step) {
  const names = variationNames(step.slug)
  if (!names.includes(step.variation)) step.variation = names[0] || 'default'
}

function move(i, delta) {
  const j = i + delta
  if (j < 0 || j >= form.steps.length) return
  const [step] = form.steps.splice(i, 1)
  form.steps.splice(j, 0, step)
}

function validDuration(raw) {
  const n = Number(raw)
  return Number.isInteger(n) && n >= 1 && n <= MAX_DURATION
}

function body() {
  return {
    name: form.name.trim(),
    baseDurationSec: Number(form.baseDurationSec),
    steps: form.steps.map((s) => ({
      id: s.id || undefined,
      slug: s.slug,
      variation: s.variation,
      durationSec: s.durationSec === '' ? null : Number(s.durationSec),
    })),
  }
}

async function onSave() {
  if (!form.name.trim()) {
    error.value = 'Give the scroller a name'
    return
  }
  if (!validDuration(form.baseDurationSec)) {
    error.value = `Base duration must be a whole number of seconds 1-${MAX_DURATION}`
    return
  }
  if (!form.steps.length) {
    error.value = 'Add at least one app'
    return
  }
  if (form.steps.some((s) => s.durationSec !== '' && !validDuration(s.durationSec))) {
    error.value = `A custom duration must be a whole number of seconds 1-${MAX_DURATION}`
    return
  }
  busy.value = true
  error.value = ''
  const r = isNew.value ? await createScroller(body()) : await updateScroller(props.scroller.id, body())
  busy.value = false
  if (!r.ok) {
    error.value = r.json?.error || `Save failed (${r.status})`
    return
  }
  emit('close')
}

// Two-step confirm, same pattern as the app and library Remove buttons.
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
  error.value = ''
  const r = await deleteScroller(props.scroller.id)
  busy.value = false
  if (!r.ok) {
    error.value = r.json?.error || `Delete failed (${r.status})`
    return
  }
  emit('close')
}
</script>
