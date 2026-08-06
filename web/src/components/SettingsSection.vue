<template>
  <section class="section-card">
    <div class="sc-head">
      <div class="sc-head-inner">
        <div class="sc-title-wrap">
          <span class="sc-icon" v-html="icons.settings"></span>
          <div>
            <div class="sc-title">Settings</div>
            <div class="sc-subtitle">Connection settings for this installation.</div>
          </div>
        </div>
      </div>
    </div>
    <div class="sc-body">
      <div class="row-block">
        <div class="field" style="margin-bottom:0">
          <label for="barHost">Bar host</label>
          <input id="barHost" type="text" v-model="form.barHost" placeholder="10.0.4.20" />
          <span class="hint">Over USB the bar is always 10.0.4.20; enter an IP or host:port for Wi-Fi or the emulator.</span>
        </div>
      </div>
      <div class="settings-foot">
        <button class="pill brand" :disabled="saving" @click="save">
          {{ saving ? 'Saving…' : 'Save' }}
        </button>
      </div>
    </div>
  </section>
</template>

<script setup>
import { reactive, ref } from 'vue'
import { manager, updateSettings } from '../composables/useManager'
import { icons } from '../icons'

const saving = ref(false)
const form = reactive({ barHost: '' })

// Seed once from current state when this tab mounts — no live watch, the SSE
// state stream would clobber whatever Max is mid-typing.
form.barHost = manager.barHost || ''

async function save() {
  saving.value = true
  await updateSettings({ barHost: form.barHost.trim() })
  saving.value = false
}
</script>
