<template>
  <section class="section-card">
    <div class="sc-head">
      <div class="sc-head-inner">
        <div class="sc-title-wrap">
          <span class="sc-icon" v-html="icons.play"></span>
          <div>
            <div class="sc-title">Apps</div>
          </div>
        </div>
        <div class="sc-actions">
          <span class="status-chip" :class="manager.connected ? 'ok' : ''">
            {{ manager.connected ? 'LIVE' : 'not connected' }}
          </span>
        </div>
      </div>
    </div>
    <div class="sc-body">
      <AppsGrid
        :apps="manager.apps"
        :screen-owner="manager.screenOwner"
        @edit-variation="$emit('edit-variation', $event)"
        @open-logs="$emit('open-logs', $event)"
      />
    </div>
  </section>
</template>

<script setup>
import { manager } from '../composables/useManager'
import { icons } from '../icons'
import AppsGrid from './AppsGrid.vue'

defineEmits(['edit-variation', 'open-logs'])
</script>
