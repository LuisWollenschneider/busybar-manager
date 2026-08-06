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
      <div class="row-block">
        <div class="field" style="margin-bottom:0">
          <label for="barToken">Bar token</label>
          <div class="token-row">
            <div class="token-input">
              <input
                id="barToken"
                :type="showToken ? 'text' : 'password'"
                v-model="form.barToken"
                autocomplete="off"
                :placeholder="manager.tokenSet ? '•••••••• (saved)' : '12345678'"
              />
              <button
                type="button"
                class="token-reveal"
                :aria-label="showToken ? 'Hide token' : 'Show token'"
                :aria-pressed="showToken"
                :title="showToken ? 'Hide token' : 'Show token'"
                @click="showToken = !showToken"
                v-html="showToken ? icons.eyeOff : icons.eye"
              ></button>
            </div>
            <button v-if="manager.tokenSet" class="pill sm" :disabled="saving" @click="clearToken">Clear</button>
          </div>
          <span class="hint">
            {{
              manager.tokenSet
                ? 'Token set. Leave blank to keep it, or type a new one to replace it.'
                : 'For Wi-Fi, the bar requires a token to connect.'
            }}
          </span>
        </div>
      </div>
      <div class="settings-foot">
        <button class="pill brand" :disabled="saving" @click="save">
          {{ saving ? 'Saving…' : 'Save' }}
        </button>
      </div>
      <p v-if="error" class="hint" style="color:var(--error)">{{ error }}</p>
    </div>
  </section>
</template>

<script setup>
import { reactive, ref, watch } from 'vue'
import { manager, updateSettings } from '../composables/useManager'
import { icons } from '../icons'

const saving = ref(false)
const error = ref('')
const showToken = ref(false)
const form = reactive({ barHost: '', barToken: '' })

// Seed once from current state when this tab mounts — no live watch, the SSE
// state stream would clobber whatever Max is mid-typing. The bar token is
// never sent to the frontend (state only carries `tokenSet`), so its field
// always starts empty: blank on save = keep the stored token.
form.barHost = manager.barHost || ''

// A refresh straight onto this tab mounts us before the first state frame
// lands, so the seed above sees ''. Seed again when the real value arrives —
// once, and only while the field is still untouched, never over live typing.
if (!form.barHost) {
  const stop = watch(
    () => manager.barHost,
    (v) => {
      if (!v) return
      if (!form.barHost) form.barHost = v
      stop()
    }
  )
}

async function save() {
  const token = form.barToken.trim()
  saving.value = true
  error.value = ''
  const patch = { barHost: form.barHost.trim() }
  if (token) patch.token = token
  const res = await updateSettings(patch)
  saving.value = false
  if (!res.ok) {
    error.value = res.json?.error || `Save failed (${res.status})`
    return
  }
  // never leave the secret sitting in the field (revealed, at that) after a save
  form.barToken = ''
  showToken.value = false
}

async function clearToken() {
  saving.value = true
  error.value = ''
  const res = await updateSettings({ token: '' })
  saving.value = false
  if (!res.ok) {
    error.value = res.json?.error || `Clear failed (${res.status})`
    return
  }
  form.barToken = ''
  showToken.value = false
}
</script>
