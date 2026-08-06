<template>
  <div class="modal-backdrop" @click.self="$emit('close')">
    <div class="term modal-term">
      <div class="term-bar">
        <span class="term-dots"><i></i><i></i><i></i></span>
        <span class="term-title">{{ app.name }} — logs</span>
        <label class="term-autoscroll"><input type="checkbox" v-model="autoscroll" />autoscroll</label>
        <span class="term-status ok">{{ lines.length }} lines</span>
        <button class="term-close" title="Close" @click="$emit('close')" v-html="icons.close"></button>
      </div>

      <div class="term-body" ref="bodyRef">
        <div v-if="!lines.length" class="term-line muted"># no log lines yet</div>
        <div v-for="(line, i) in lines" :key="i" class="term-line">{{ line }}</div>
      </div>
    </div>
  </div>
</template>

<script setup>
import { ref, computed, watch, nextTick, onMounted, onUnmounted } from 'vue'
import { logs, fetchLog } from '../composables/useManager'
import { icons } from '../icons'

const props = defineProps({ app: { type: Object, required: true } })
const emit = defineEmits(['close'])

const onKeydown = (e) => { if (e.key === 'Escape') emit('close') }
onMounted(() => window.addEventListener('keydown', onKeydown))
onUnmounted(() => window.removeEventListener('keydown', onKeydown))

const autoscroll = ref(true)
const bodyRef = ref(null)
const lines = computed(() => logs[props.app.slug] || [])

onMounted(() => {
  fetchLog(props.app.slug)
})

function scrollToBottom() {
  if (!autoscroll.value || !bodyRef.value) return
  nextTick(() => {
    bodyRef.value.scrollTop = bodyRef.value.scrollHeight
  })
}

watch(() => lines.value.length, scrollToBottom)
watch(
  () => props.app.slug,
  (slug) => fetchLog(slug)
)
</script>
