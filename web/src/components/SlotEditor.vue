<template>
  <div class="modal-backdrop" @click.self="$emit('close')">
    <div class="modal glass">
      <div class="modal-head">
        <h2 class="card-title" style="margin:0">
          <span class="badge" v-html="icons.clockFill"></span>{{ isNew ? 'New slot' : 'Edit slot' }}
        </h2>
        <button class="modal-close" @click="$emit('close')" v-html="icons.close"></button>
      </div>

      <!-- What the slot puts on the bar decides which fields below apply, so
           it comes first. -->
      <div class="field">
        <label>This slot runs</label>
        <div class="seg" role="radiogroup" aria-label="What this slot runs">
          <label class="seg-opt" :class="{ on: form.kind === 'app' }">
            <input type="radio" name="slot-kind" value="app" v-model="form.kind" />
            <span>A single app</span>
          </label>
          <label class="seg-opt" :class="{ on: form.kind === 'scroller', disabled: !scrollers.length }">
            <input type="radio" name="slot-kind" value="scroller" v-model="form.kind" :disabled="!scrollers.length" />
            <span>A scroller</span>
          </label>
        </div>
        <span v-if="!scrollers.length" class="hint">Add a scroller on the Apps tab to schedule a whole cycle.</span>
      </div>

      <div class="field">
        <label>Days</label>
        <div class="day-picker">
          <button
            v-for="d in weekDays"
            :key="d.value"
            type="button"
            class="day-toggle"
            :class="{ on: form.days.includes(d.value) }"
            :title="d.label"
            @click="toggleDay(d.value)"
          >
            {{ d.short }}
          </button>
        </div>
        <div class="day-presets">
          <button type="button" class="pill sm" @click="form.days = [1, 2, 3, 4, 5]">Mon–Fri</button>
          <button type="button" class="pill sm" @click="form.days = [0, 6]">Weekend</button>
          <button type="button" class="pill sm" @click="form.days = [0, 1, 2, 3, 4, 5, 6]">Every day</button>
        </div>
        <span class="hint">The same window on every selected day — one slot, not one per day.</span>
      </div>

      <div class="form-grid">
        <div class="field">
          <label for="slot-start">Start</label>
          <input id="slot-start" type="time" v-model="form.start" step="60" />
        </div>
        <div class="field">
          <label for="slot-end">End</label>
          <input id="slot-end" type="time" v-model="endInput" step="60" :disabled="tillMidnight" />
          <label class="check-row" for="slot-midnight">
            <input id="slot-midnight" type="checkbox" v-model="tillMidnight" />
            until midnight
          </label>
        </div>
        <div v-if="form.kind === 'scroller'" class="field field-wide">
          <label for="slot-scroller">Scroller</label>
          <select id="slot-scroller" class="select" v-model="form.scrollerId">
            <option v-for="sc in scrollers" :key="sc.id" :value="sc.id">{{ sc.name }}</option>
          </select>
          <span class="hint">Cycles through the scroller's apps for the length of the slot, without switching the scroller itself on.</span>
        </div>
        <template v-else>
          <div class="field">
            <label for="slot-app">App</label>
            <select id="slot-app" class="select" v-model="form.slug" @change="onAppChange">
              <option v-for="a in apps" :key="a.slug" :value="a.slug">{{ a.name || a.slug }}</option>
            </select>
          </div>
          <div class="field">
            <label for="slot-variation">Variation</label>
            <select id="slot-variation" class="select" v-model="form.variation">
              <option v-for="name in variationNames" :key="name" :value="name">{{ name }}</option>
            </select>
            <span class="hint">Runs under this variation for the length of the slot, whatever is selected on the Apps tab.</span>
          </div>
        </template>
      </div>

      <p v-if="error" class="hint" style="color:var(--error)">{{ error }}</p>

      <div class="modal-foot">
        <button
          v-if="!isNew"
          class="pill danger"
          :disabled="busy"
          title="Delete slot"
          @click="onDelete"
          v-html="withLabel(icons.trashFill, 'Delete')"
        ></button>
        <span class="spacer"></span>
        <button class="pill" :disabled="busy" @click="$emit('close')">Cancel</button>
        <button class="pill brand" :disabled="busy || !hasTarget || !form.days.length" @click="onSave" v-html="withLabel(icons.save, 'Save')"></button>
      </div>
    </div>
  </div>
</template>

<script setup>
import { ref, reactive, computed, onMounted, onUnmounted, watch } from 'vue'
import { createSlot, updateSlot, deleteSlot } from '../composables/useManager'
import { icons } from '../icons'
import { WEEK_DAYS } from '../lib/week'

const props = defineProps({
  // { id|null, days: [0-6], start, end, kind } plus slug + variation (kind
  // "app") or scrollerId (kind "scroller") — id null means "create".
  slotData: { type: Object, required: true },
  apps: { type: Array, default: () => [] },
  scrollers: { type: Array, default: () => [] },
})
const emit = defineEmits(['close'])

const onKeydown = (e) => {
  if (e.key === 'Escape') emit('close')
}
onMounted(() => window.addEventListener('keydown', onKeydown))
onUnmounted(() => window.removeEventListener('keydown', onKeydown))

const weekDays = WEEK_DAYS

const busy = ref(false)
const error = ref('')
const isNew = computed(() => !props.slotData.id)
const form = reactive({
  ...props.slotData,
  days: [...(props.slotData.days || [])],
  // Slots written before scrollers existed carry no `kind`; they are app slots.
  kind: props.slotData.kind === 'scroller' ? 'scroller' : 'app',
  slug: props.slotData.slug || props.apps[0]?.slug || '',
  variation: props.slotData.variation || 'default',
  scrollerId: props.slotData.scrollerId || props.scrollers[0]?.id || '',
})

// `<input type="time">` cannot hold the contract's "24:00" end value, so
// end-of-day is a checkbox and the input keeps the last real time.
const tillMidnight = ref(props.slotData.end === '24:00')
const endInput = ref(props.slotData.end === '24:00' ? '23:00' : props.slotData.end)

const selectedApp = computed(() => props.apps.find((a) => a.slug === form.slug) || null)
const variationNames = computed(() => Object.keys(selectedApp.value?.variations || { default: {} }))
const hasTarget = computed(() => (form.kind === 'scroller' ? !!form.scrollerId : !!form.slug))

function withLabel(svg, label) {
  return `${svg}<span>${label}</span>`
}

function toggleDay(day) {
  const i = form.days.indexOf(day)
  if (i === -1) form.days.push(day)
  else form.days.splice(i, 1)
  form.days.sort((a, b) => a - b)
}

watch(
  variationNames,
  (names) => {
    if (!names.includes(form.variation)) form.variation = names[0] || 'default'
  },
  { immediate: true },
)

async function onSave() {
  const end = tillMidnight.value ? '24:00' : endInput.value
  if (!form.days.length) {
    error.value = 'Pick at least one day'
    return
  }
  if (!form.start || !end) {
    error.value = 'Start and end are required'
    return
  }
  if (end !== '24:00' && end <= form.start) {
    error.value = 'End must be later than start'
    return
  }
  if (form.kind === 'scroller' && !form.scrollerId) {
    error.value = 'Pick a scroller'
    return
  }
  busy.value = true
  error.value = ''
  const body =
    form.kind === 'scroller'
      ? { days: [...form.days], start: form.start, end, kind: 'scroller', scrollerId: form.scrollerId }
      : { days: [...form.days], start: form.start, end, kind: 'app', slug: form.slug, variation: form.variation }
  const r = isNew.value ? await createSlot(body) : await updateSlot(form.id, body)
  busy.value = false
  if (!r.ok) {
    error.value = r.json?.error || `Save failed (${r.status})`
    return
  }
  emit('close')
}

async function onDelete() {
  busy.value = true
  error.value = ''
  const r = await deleteSlot(form.id)
  busy.value = false
  if (!r.ok) {
    error.value = r.json?.error || `Delete failed (${r.status})`
    return
  }
  emit('close')
}
</script>
