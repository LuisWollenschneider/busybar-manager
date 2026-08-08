<template>
  <div class="modal-backdrop" @click.self="$emit('close')">
    <div class="modal glass wide">
      <div class="modal-head">
        <h2 class="card-title" style="margin:0">
          <span class="badge" v-html="icons.edit"></span>Variation — {{ app.name }}
        </h2>
        <button class="modal-close" @click="$emit('close')" v-html="icons.close"></button>
      </div>

      <div class="field">
        <label for="var-select">Edit variation</label>
        <select id="var-select" class="select" v-model="editingName" @change="loadFromVariation">
          <option v-for="name in variationNames" :key="name" :value="name">
            {{ name }}{{ name === app.variation ? ' (active)' : '' }}
          </option>
        </select>
      </div>

      <div class="subhead">Arguments</div>
      <div v-if="!optionFields.length" class="empty-note">This app has no configurable options.</div>
      <div class="form-grid">
        <div class="field" v-for="opt in optionFields" :key="opt.flag">
          <label :for="'opt-' + opt.flag">{{ opt.flag }}</label>
          <select v-if="opt.choices && opt.choices.length" :id="'opt-' + opt.flag" class="select" v-model="formArgs[opt.flag]">
            <option value="">(default: {{ opt.default ?? '—' }})</option>
            <option v-for="c in opt.choices" :key="c" :value="c">{{ c }}</option>
          </select>
          <label v-else-if="opt.type === 'bool'" class="check-row" :for="'opt-' + opt.flag">
            <input :id="'opt-' + opt.flag" type="checkbox" v-model="formArgs[opt.flag]" />
            enable
          </label>
          <input
            v-else
            :id="'opt-' + opt.flag"
            type="text"
            :placeholder="String(opt.default ?? '')"
            v-model="formArgs[opt.flag]"
          />
          <span v-if="opt.help" class="hint">{{ opt.help }}</span>
        </div>
      </div>

      <div class="subhead">Environment variables</div>
      <div v-for="(row, i) in envRows" :key="i" class="kv-row">
        <input type="text" placeholder="KEY" v-model="row.key" />
        <input type="text" placeholder="value" v-model="row.value" />
        <button class="pill sm icon-only" title="Remove" @click="envRows.splice(i, 1)" v-html="icons.trash"></button>
      </div>
      <button class="pill sm kv-add" @click="envRows.push({ key: '', value: '' })" v-html="withLabel(icons.plus, 'Add variable')"></button>

      <div class="subhead">Other</div>
      <div class="form-grid">
        <div class="field">
          <label for="priority">Priority override (1–100)</label>
          <input id="priority" type="number" min="1" max="100" placeholder="10" v-model="priorityInput" />
          <span class="hint">Managed apps default to 10 — low, so an app you start by hand can take the screen. Leave empty for 10.</span>
        </div>
        <div class="field">
          <label for="saveas">Save as</label>
          <input id="saveas" type="text" v-model="saveAsName" placeholder="variation name" />
        </div>
      </div>

      <p v-if="error" class="hint" style="color:var(--error)">{{ error }}</p>

      <div class="modal-foot">
        <button
          class="pill danger"
          :disabled="busy || variationNames.length <= 1"
          title="Delete variation"
          @click="onDelete"
          v-html="withLabel(icons.trashFill, 'Delete')"
        ></button>
        <button class="pill" :disabled="busy || editingName === app.variation" @click="onSelect">
          Select &amp; restart
        </button>
        <button class="pill brand" :disabled="busy || !saveAsName.trim()" @click="onSave" v-html="withLabel(icons.save, 'Save')"></button>
      </div>
    </div>
  </div>
</template>

<script setup>
import { ref, reactive, computed, watch, onMounted, onUnmounted } from 'vue'

const onKeydown = (e) => { if (e.key === 'Escape') emit('close') }
onMounted(() => window.addEventListener('keydown', onKeydown))
onUnmounted(() => window.removeEventListener('keydown', onKeydown))
import { putVariation, deleteVariation, setVariation } from '../composables/useManager'
import { icons } from '../icons'

const props = defineProps({ app: { type: Object, required: true } })
const emit = defineEmits(['close'])

const busy = ref(false)
const error = ref('')
const editingName = ref(props.app.variation || 'default')
const formArgs = reactive({})
const envRows = ref([])
const priorityInput = ref('')
const saveAsName = ref(editingName.value)

const optionFields = computed(() => (props.app.options || []).filter((o) => o.flag !== '--host'))
const variationNames = computed(() => Object.keys(props.app.variations || { default: {} }))

function withLabel(svg, label) {
  return `${svg}<span>${label}</span>`
}

function loadFromVariation() {
  const v = (props.app.variations || {})[editingName.value] || { args: {}, env: {}, priority: null }
  for (const key of Object.keys(formArgs)) delete formArgs[key]
  for (const opt of optionFields.value) {
    const raw = v.args ? v.args[opt.flag] : undefined
    if (opt.type === 'bool') formArgs[opt.flag] = raw === true || raw === 'true'
    else formArgs[opt.flag] = raw !== undefined ? String(raw) : ''
  }
  envRows.value = Object.entries(v.env || {}).map(([key, value]) => ({ key, value: String(value) }))
  priorityInput.value = v.priority === null || v.priority === undefined ? '' : String(v.priority)
  saveAsName.value = editingName.value
  error.value = ''
}
loadFromVariation()

watch(
  () => props.app.slug,
  () => {
    editingName.value = props.app.variation || 'default'
    loadFromVariation()
  }
)

function buildArgs() {
  const args = {}
  for (const opt of optionFields.value) {
    const val = formArgs[opt.flag]
    if (opt.type === 'bool') {
      if (val) args[opt.flag] = true
    } else if (val !== '' && val !== undefined && val !== null) {
      args[opt.flag] = val
    }
  }
  return args
}

function buildEnv() {
  const env = {}
  for (const row of envRows.value) {
    if (row.key.trim()) env[row.key.trim()] = row.value
  }
  return env
}

async function onSave() {
  const name = saveAsName.value.trim()
  if (!name) return
  busy.value = true
  error.value = ''
  const priority = priorityInput.value === '' ? null : Number(priorityInput.value)
  const r = await putVariation(props.app.slug, name, { args: buildArgs(), env: buildEnv(), priority })
  busy.value = false
  if (!r.ok) {
    error.value = r.json?.error || `Save failed (${r.status})`
    return
  }
  editingName.value = name
}

async function onSelect() {
  busy.value = true
  error.value = ''
  const r = await setVariation(props.app.slug, editingName.value)
  busy.value = false
  if (!r.ok) error.value = r.json?.error || `Select failed (${r.status})`
}

async function onDelete() {
  busy.value = true
  error.value = ''
  const r = await deleteVariation(props.app.slug, editingName.value)
  busy.value = false
  if (!r.ok) {
    error.value = r.json?.error || `Delete failed (${r.status})`
    return
  }
  editingName.value = props.app.variation || 'default'
  loadFromVariation()
}
</script>
