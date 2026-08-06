<template>
  <div v-if="apps.length > 5" class="app-search">
    <span class="app-search-ic" v-html="icons.search"></span>
    <input type="text" v-model="search" placeholder="Filter by name or description…" aria-label="Filter apps" />
    <button v-if="search" class="app-search-clear" title="Clear filter" aria-label="Clear filter" @click="search = ''">×</button>
  </div>
  <div v-if="filteredApps.length" class="apps-list">
    <AppCard
      v-for="app in filteredApps"
      :key="app.slug"
      :app="app"
      :is-owner="isOwner(app)"
      @edit-variation="$emit('edit-variation', app.slug)"
      @open-logs="$emit('open-logs', app.slug)"
    />
  </div>
  <div v-else class="empty-note">
    {{ apps.length ? `No apps found for "${search.trim()}".` : 'No apps found. Check the app folders in settings.' }}
  </div>
</template>

<script setup>
import { ref, computed } from 'vue'
import AppCard from './AppCard.vue'
import { icons } from '../icons'

const props = defineProps({
  apps: { type: Array, default: () => [] },
  screenOwner: { type: Object, default: null },
})
defineEmits(['edit-variation', 'open-logs'])

const search = ref('')
const filteredApps = computed(() => {
  const q = search.value.trim().toLowerCase()
  if (!q) return props.apps
  return props.apps.filter((app) =>
    [app.name, app.slug, app.description].filter(Boolean).join(' ').toLowerCase().includes(q)
  )
})

function isOwner(app) {
  const owner = props.screenOwner
  if (!owner) return false
  return owner.slug === app.slug || owner.applicationName === app.slug || owner.applicationName === app.name
}
</script>
