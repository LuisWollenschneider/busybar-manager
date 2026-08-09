<template>
  <section class="section-card">
    <div class="sc-head">
      <div class="sc-head-inner">
        <div class="sc-title-wrap">
          <span class="sc-icon" v-html="icons.library"></span>
          <div>
            <div class="sc-title">Library</div>
            <div class="sc-subtitle">{{ headerSubtitle }}</div>
          </div>
        </div>
        <div class="sc-actions">
          <button class="pill sm icon-only" title="Check now" :disabled="checking" @click="onRefresh" v-html="icons.restart"></button>
          <div class="view-toggle" role="tablist" aria-label="Library view">
            <button
              class="pill sm icon-only"
              :class="{ active: subTab === 'apps' }"
              title="Apps"
              role="tab"
              :aria-selected="subTab === 'apps'"
              @click="subTab = 'apps'"
              v-html="subTab === 'apps' ? icons.gridFill : icons.grid"
            ></button>
            <button
              class="pill sm icon-only"
              :class="{ active: subTab === 'settings' }"
              title="Library settings"
              role="tab"
              :aria-selected="subTab === 'settings'"
              @click="subTab = 'settings'"
              v-html="subTab === 'settings' ? icons.settings : icons.settingsOutline"
            ></button>
          </div>
        </div>
      </div>
    </div>

    <div class="sc-body">
      <p v-if="incompatible" class="lib-error">The manager server is running an older version — restart the manager.</p>

      <template v-else>
        <!-- ================================ Apps subtab ================================ -->
        <template v-if="subTab === 'apps'">
          <!-- The catalog-empty states only take over when there's nothing at
               all to show; zip-uploaded apps live under their own "My apps"
               filter and must stay reachable even with no repos linked. -->
          <div v-if="checking && !anyApps" class="lib-empty">Checking the library…</div>
          <div v-else-if="!anyApps && everChecked" class="lib-empty">No apps found in the library.</div>
          <div v-else-if="!anyApps && library.repos.some((r) => r.error)" class="lib-empty">
            Couldn't check the library — see settings for repo errors.
          </div>
          <div v-else-if="!anyApps && library.repos.length" class="lib-empty">Checking the library…</div>
          <div v-else-if="!anyApps" class="lib-empty">No repos linked yet — add one in settings.</div>
          <template v-else>
            <div class="lib-toolbar">
              <div class="lib-search">
                <span class="lib-search-icon" v-html="icons.search"></span>
                <input
                  type="text"
                  v-model="query"
                  placeholder="Search apps…"
                  aria-label="Search apps"
                />
                <button v-if="query" class="lib-search-clear" title="Clear search" @click="query = ''" v-html="icons.close"></button>
              </div>
              <div class="seg-tabs" role="tablist">
                <button
                  v-for="t in viewTabs"
                  :key="t.key"
                  class="seg-tab"
                  :class="{ active: view === t.key }"
                  role="tab"
                  :aria-selected="view === t.key"
                  @click="view = t.key"
                >{{ t.label }}</button>
              </div>
            </div>

            <div v-if="!shownUploads.length && !shownCatalog.length" class="lib-empty">
              {{ emptyResultText }}
            </div>
            <div v-else class="lib-grid">
            <!-- Uploaded apps first: they're the user's own, and they're not in
                 the catalog (no repo provenance), so they'd otherwise be buried
                 under every repo app. -->
            <div v-for="app in shownUploads" :key="uploadKey(app)" class="lib-card">
              <div class="lib-preview">
                <div class="lib-preview-fallback">{{ app.name }}</div>
              </div>

              <span class="lib-name">{{ app.name }}</span>
              <span class="lib-card-repo">{{ app.installedAt ? `uploaded ${relTime(app.installedAt)}` : 'uploaded' }}</span>
              <p class="lib-desc">{{ app.description || '—' }}</p>
              <div class="lib-tags" v-if="app.tags && app.tags.length">
                <span v-for="t in app.tags" :key="t" class="app-tag">{{ t }}</span>
              </div>

              <div class="lib-actions">
                <span class="chip installed">installed</span>
                <span class="spacer"></span>
                <button
                  class="pill sm danger"
                  :disabled="rowBusy(uploadKey(app))"
                  @click="onUninstall(app, uploadKey(app))"
                  v-html="withLabel(icons.trashFill, uninstallLabel(uploadKey(app)))"
                ></button>
              </div>
              <p v-if="rowState[uploadKey(app)]?.error" class="hint" style="color:var(--error)">{{ rowState[uploadKey(app)].error }}</p>
            </div>

            <div v-for="app in shownCatalog" :key="app.repo + '@' + app.slug" class="lib-card">
              <div class="lib-preview">
                <img
                  v-if="app.previewUrl && !imgErrors[cardKey(app)]"
                  :src="app.previewUrl"
                  :alt="app.name"
                  @load="imgLoaded[cardKey(app)] = true"
                  @error="imgErrors[cardKey(app)] = true"
                />
                <div v-else class="lib-preview-fallback">{{ app.name }}</div>
              </div>

              <span class="lib-name">{{ app.name }}</span>
              <span class="lib-card-repo">{{ app.repo }}</span>
              <p class="lib-desc">{{ app.description || '—' }}</p>
              <div class="lib-tags" v-if="app.tags && app.tags.length">
                <span v-for="t in app.tags" :key="t" class="app-tag">{{ t }}</span>
              </div>

              <div class="lib-actions">
                <template v-if="app.source === 'local'">
                  <span class="chip local">local</span>
                </template>
                <template v-else-if="app.installed">
                  <span class="chip installed">installed</span>
                  <button
                    v-if="app.updateAvailable"
                    class="pill sm brand"
                    :disabled="rowBusy(cardKey(app))"
                    @click="onUpdate(app)"
                    v-html="withLabel(icons.download, rowState[cardKey(app)]?.updating ? 'Updating…' : 'Update')"
                  ></button>
                  <span class="spacer"></span>
                  <button
                    class="pill sm danger"
                    :disabled="rowBusy(cardKey(app))"
                    @click="onUninstall(app, cardKey(app))"
                    v-html="withLabel(icons.trashFill, uninstallLabel(cardKey(app)))"
                  ></button>
                </template>
                <template v-else>
                  <button
                    class="pill sm brand"
                    :disabled="rowBusy(cardKey(app))"
                    @click="onInstall(app)"
                  >{{ rowState[cardKey(app)]?.installing ? 'Installing…' : 'Install' }}</button>
                </template>
              </div>
              <p v-if="rowState[cardKey(app)]?.error" class="hint" style="color:var(--error)">{{ rowState[cardKey(app)].error }}</p>
            </div>
            </div>
          </template>
        </template>

        <!-- ============================== Settings subtab =============================== -->
        <template v-else>
          <div class="row-block lib-settings-block">
            <div class="rb-head">
              <div class="rb-title">Repositories</div>
              <div class="rb-hint">Apps are installed straight from linked GitHub repos.</div>
            </div>

            <div v-for="r in library.repos" :key="r.repo" class="lib-repo-row">
              <div class="lib-repo-info">
                <span class="lib-repo-name">{{ r.repo }}<span class="branch">@{{ r.branch }}</span></span>
                <span class="lib-repo-meta" :class="{ err: r.error }">
                  {{ r.error ? r.error : r.lastCheck ? `last checked ${relTime(r.lastCheck)}` : 'never checked' }}
                </span>
              </div>
              <button
                class="pill sm danger"
                :disabled="repoBusy(r.repo)"
                @click="onUnlink(r)"
              >{{ repoRow(r.repo).confirm ? 'Sure?' : 'Unlink' }}</button>
            </div>
            <div v-if="!library.repos.length" class="empty-note">No repos linked yet.</div>

            <div class="field" style="margin-bottom:0">
              <label for="repo-link-input">Link a repository</label>
              <div class="lib-repo-add">
                <input
                  id="repo-link-input"
                  type="text"
                  v-model="addRepoText"
                  placeholder="https://github.com/owner/name"
                  aria-label="Repo to link"
                />
                <button class="pill sm brand" :disabled="addingRepo || !addRepoText.trim()" @click="onLink">
                  {{ addingRepo ? 'Linking…' : 'Link repository' }}
                </button>
              </div>
              <span class="hint">Paste a GitHub repository URL, e.g. https://github.com/maxswinkels/busybar-apps</span>
            </div>
            <p v-if="addRepoError" class="hint" style="color:var(--error)">{{ addRepoError }}</p>
          </div>

          <div class="row-block lib-settings-block">
            <div class="rb-head">
              <div class="rb-title">GitHub token <span style="font-weight:400;color:var(--faint)">(optional)</span></div>
              <div class="rb-hint">
                {{
                  library.tokenSet
                    ? 'Token set — 5,000 requests/hour'
                    : 'Without a token GitHub allows 60 requests/hour; add a personal access token if you hit rate limits.'
                }}
              </div>
            </div>
            <div class="token-row">
              <input
                type="password"
                v-model="tokenInput"
                placeholder="ghp_…"
                autocomplete="off"
                aria-label="GitHub personal access token"
              />
              <button class="pill sm brand" :disabled="savingToken || !tokenInput.trim()" @click="onSaveToken">
                {{ savingToken ? 'Saving…' : 'Save' }}
              </button>
              <button v-if="library.tokenSet" class="pill sm" :disabled="savingToken" @click="onClearToken">Clear</button>
            </div>
            <p v-if="tokenError" class="hint" style="color:var(--error)">{{ tokenError }}</p>
          </div>

          <div class="row-block lib-settings-block">
            <div class="rb-head">
              <div class="rb-title">Upload app</div>
              <div class="rb-hint">Zip with app.py at the root, or a single folder containing app.py.</div>
            </div>
            <label
              class="upload-drop"
              :class="{ dragging: dragOver, busy: uploading }"
              @dragover.prevent="dragOver = true"
              @dragleave.prevent="dragOver = false"
              @drop.prevent="onDrop"
            >
              <input type="file" accept=".zip" :disabled="uploading" @change="onFilePicked" aria-label="Choose a zip file to upload" />
              <span v-if="uploading">Uploading…</span>
              <span v-else>Drop a .zip here, or click to choose</span>
            </label>
            <p v-if="uploadMessage" class="hint" :style="{ color: uploadOk ? 'var(--success)' : 'var(--error)' }">{{ uploadMessage }}</p>
          </div>

          <div class="row-block lib-settings-block">
            <div class="rb-head">
              <div class="rb-title">Local app folders <span style="font-weight:400;color:var(--faint)">(for development)</span></div>
              <div class="rb-hint">Folders scanned for apps you're developing locally, one per line. A local app wins over a library app with the same slug.</div>
            </div>
            <div class="field" style="margin-bottom:0">
              <textarea
                rows="3"
                v-model="appsDirsText"
                placeholder="/Users/user/example-app"
                aria-label="Local app folders, one per line"
              ></textarea>
            </div>
            <div class="settings-foot" style="margin-top:10px">
              <button class="pill sm brand" :disabled="savingDirs" @click="onSaveDirs">
                {{ savingDirs ? 'Saving…' : 'Save' }}
              </button>
            </div>
          </div>
        </template>
      </template>
    </div>
  </section>
</template>

<script setup>
import { ref, reactive, computed, onMounted, onUnmounted } from 'vue'
import {
  library,
  fetchLibrary,
  checkLibrary,
  installApp,
  updateApp,
  uninstallApp,
  addLibraryRepo,
  removeLibraryRepo,
  saveLibraryToken,
  uploadLibraryApp,
} from '../composables/useManager'
import { manager, updateSettings } from '../composables/useManager'
import { icons } from '../icons'

// Local app folders (appsDirs) — an app *source*, so it lives here under
// Library → Settings rather than in the general Settings tab. Seed once on
// mount; no live watch (SSE state pushes would clobber mid-typing edits).
const appsDirsText = ref((manager.appsDirs || []).join('\n'))
const savingDirs = ref(false)
async function onSaveDirs() {
  savingDirs.value = true
  const appsDirs = appsDirsText.value
    .split('\n')
    .map((l) => l.trim())
    .filter(Boolean)
  await updateSettings({ appsDirs })
  savingDirs.value = false
}

function withLabel(svg, label) {
  return `${svg}<span>${label}</span>`
}

const subTab = ref('apps') // 'apps' | 'settings'

// Apps-view filters: free-text search + a three-way view. All client-side.
// Uploaded apps show under 'all' and under 'installed' (they are installed,
// they just have no repo behind them); 'mine' is the narrow view that hides
// the repo catalog and leaves only them.
const query = ref('')
const view = ref('all') // 'all' | 'installed' | 'mine'
const viewTabs = [
  { key: 'all', label: 'All' },
  { key: 'installed', label: 'Installed' },
  { key: 'mine', label: 'My apps' },
]

const filteredCatalog = computed(() => {
  const q = query.value.trim().toLowerCase()
  return library.catalog.filter((app) => {
    if (view.value === 'installed' && !app.installed) return false
    if (!q) return true
    const haystack = [app.name, app.slug, app.repo, app.description, ...(app.tags || [])]
      .filter(Boolean)
      .join(' ')
      .toLowerCase()
    return haystack.includes(q)
  })
})

// Only the free-text search narrows "My apps" — they're all installed by
// definition, so the All/Installed split doesn't apply to them.
const filteredUploads = computed(() => {
  const q = query.value.trim().toLowerCase()
  return (library.uploads || []).filter((app) => {
    if (!q) return true
    const haystack = [app.name, app.slug, app.description, ...(app.tags || [])]
      .filter(Boolean)
      .join(' ')
      .toLowerCase()
    return haystack.includes(q)
  })
})

// What the current view actually renders, in grid order (uploads first).
const shownUploads = computed(() => filteredUploads.value)
const shownCatalog = computed(() => (view.value === 'mine' ? [] : filteredCatalog.value))

const emptyResultText = computed(() => {
  if (view.value === 'mine') {
    return query.value
      ? 'No uploaded apps match your search.'
      : 'No uploaded apps yet — upload a zip under Library settings.'
  }
  return view.value === 'installed' ? 'No installed apps match your search.' : 'No apps match your search.'
})

// Anything at all to show in the Apps subtab — gates the catalog-empty
// messages so an uploads-only setup (no repos linked) still renders the
// toolbar and the "My apps" tab.
const anyApps = computed(() => library.catalog.length > 0 || (library.uploads?.length || 0) > 0)

// A 404 on /api/_manager/library means an old, pre-multi-repo server binary
// is still running (this has actually happened on Max's Mac) — show a fixed
// message instead of an empty/looping catalog.
const incompatible = ref(false)
// True while any refresh (mount auto-refresh, manual "check now", or the
// initial fetch) is in flight — separate from `library.checking`, which only
// reflects the server's own last-known state.
const checking = ref(false)
// Once true, an empty catalog means "checked, nothing found" rather than
// "hasn't checked yet" — flips true the first time any repo reports a
// lastCheck, and stays true for the rest of this tab's lifetime.
const everChecked = ref(false)

const headerSubtitle = computed(() => {
  if (incompatible.value) return ''
  if (subTab.value === 'settings') return `${library.repos.length} linked repo${library.repos.length === 1 ? '' : 's'}`
  if (checking.value && !anyApps.value) return 'Checking…'
  const n = library.catalog.length + (library.uploads?.length || 0)
  return `${n} app${n === 1 ? '' : 's'} available`
})

const imgLoaded = reactive({})
const imgErrors = reactive({})
const rowState = reactive({}) // "<repo>@<slug>" -> { installing, updating, uninstalling, confirm, error }
const repoState = reactive({}) // repo -> { busy, confirm, error }

function cardKey(app) {
  return `${app.repo}@${app.slug}`
}
// Uploads have no repo, so they get their own key namespace — a repo app and
// an uploaded app sharing a slug must not share row state.
function uploadKey(app) {
  return `upload@${app.slug}`
}
function uninstallLabel(key) {
  const r = rowState[key]
  if (r?.uninstalling) return 'Removing…'
  return r?.confirm ? 'Sure?' : 'Remove'
}

function schedulePreviewFallbacks() {
  for (const app of library.catalog) {
    const key = cardKey(app)
    if (!app.previewUrl || imgLoaded[key] || imgErrors[key]) continue
    setTimeout(() => {
      if (!imgLoaded[key]) imgErrors[key] = true
    }, 4000)
  }
}

function ensureRow(key) {
  if (!rowState[key]) rowState[key] = { installing: false, updating: false, uninstalling: false, confirm: false, error: '' }
  return rowState[key]
}
function rowBusy(key) {
  const r = rowState[key]
  return !!(r && (r.installing || r.updating || r.uninstalling))
}
function repoRow(repo) {
  if (!repoState[repo]) repoState[repo] = { busy: false, confirm: false, error: '' }
  return repoState[repo]
}
function repoBusy(repo) {
  return !!repoState[repo]?.busy
}

function markEverChecked() {
  if (library.repos.some((r) => r.lastCheck)) everChecked.value = true
}

// Newest successful check across all linked repos, or null if none has ever
// succeeded — drives the "only auto-refresh if stale" rule below.
function newestLastCheck() {
  let newest = null
  for (const r of library.repos) {
    if (r.lastCheck && (!newest || r.lastCheck > newest)) newest = r.lastCheck
  }
  return newest
}

async function runFetch(refresh) {
  checking.value = true
  const r = await fetchLibrary(refresh)
  checking.value = false
  if (r.status === 404) {
    incompatible.value = true
    return r
  }
  incompatible.value = false
  markEverChecked()
  schedulePreviewFallbacks()
  return r
}

const TEN_MINUTES_MS = 10 * 60 * 1000

onMounted(async () => {
  // Rate-limit UX (CONTRACT-LIBRARY.md "v3-aanvullingen"): opening the tab
  // only forces a fresh GitHub check if the newest lastCheck is stale (or
  // there's never been one) — not on every visit, so we don't burn through
  // the rate limit just from tab-switching. The manual refresh button below
  // always forces one regardless.
  const first = await fetchLibrary(false)
  if (first.status === 404) {
    incompatible.value = true
    return
  }
  incompatible.value = false
  markEverChecked()
  schedulePreviewFallbacks()
  const newest = newestLastCheck()
  const stale = !newest || Date.now() - newest > TEN_MINUTES_MS
  if (stale && library.repos.length) await runFetch(true)
})

async function onRefresh() {
  checking.value = true
  const r = await checkLibrary()
  checking.value = false
  if (r.status === 404) {
    incompatible.value = true
    return
  }
  incompatible.value = false
  markEverChecked()
  schedulePreviewFallbacks()
}

async function onInstall(app) {
  const key = cardKey(app)
  const r = ensureRow(key)
  r.installing = true
  r.error = ''
  const res = await installApp(app.slug, app.repo)
  r.installing = false
  if (!res.ok) r.error = res.json?.error || `Install failed (${res.status})`
}

async function onUpdate(app) {
  const key = cardKey(app)
  const r = ensureRow(key)
  r.updating = true
  r.error = ''
  const res = await updateApp(app.slug)
  r.updating = false
  if (!res.ok) r.error = res.json?.error || `Update failed (${res.status})`
}

async function onUninstall(app, key = cardKey(app)) {
  const r = ensureRow(key)
  if (!r.confirm) {
    r.confirm = true
    setTimeout(() => {
      r.confirm = false
    }, 3000)
    return
  }
  r.confirm = false
  r.uninstalling = true
  r.error = ''
  const res = await uninstallApp(app.slug)
  r.uninstalling = false
  if (!res.ok) r.error = res.json?.error || `Remove failed (${res.status})`
}

const addRepoText = ref('')
const addRepoError = ref('')
const addingRepo = ref(false)

// Accepts a full GitHub URL (https://github.com/owner/name, optionally with
// /tree/<branch>, a trailing slash or .git) as well as "owner/name" or
// "owner/name@branch". Server also validates the "owner/name" shape.
function parseRepoInput(text) {
  let trimmed = text.trim()
  const url = trimmed.match(/^(?:https?:\/\/)?(?:www\.)?github\.com\/([\w.-]+)\/([\w.-]+?)(?:\.git)?(?:\/tree\/([\w./-]+))?\/?$/i)
  if (url) return { repo: `${url[1]}/${url[2]}`, branch: url[3] || undefined }
  const m = trimmed.match(/^([\w.-]+\/[\w.-]+?)(?:\.git)?(?:@([\w./-]+))?$/)
  if (!m) return null
  return { repo: m[1], branch: m[2] || undefined }
}

async function onLink() {
  addRepoError.value = ''
  const parsed = parseRepoInput(addRepoText.value)
  if (!parsed) {
    addRepoError.value = 'Enter a GitHub URL or owner/name, optionally with @branch.'
    return
  }
  addingRepo.value = true
  const res = await addLibraryRepo(parsed.repo, parsed.branch)
  addingRepo.value = false
  if (!res.ok) {
    addRepoError.value = res.json?.error || `Link failed (${res.status})`
    return
  }
  addRepoText.value = ''
  markEverChecked()
  schedulePreviewFallbacks()
}

async function onUnlink(r) {
  const row = repoRow(r.repo)
  if (!row.confirm) {
    row.confirm = true
    setTimeout(() => {
      row.confirm = false
    }, 3000)
    return
  }
  row.confirm = false
  row.busy = true
  row.error = ''
  const res = await removeLibraryRepo(r.repo)
  row.busy = false
  if (!res.ok) row.error = res.json?.error || `Unlink failed (${res.status})`
}

// ------------------------------ GitHub token -------------------------------

const tokenInput = ref('')
const tokenError = ref('')
const savingToken = ref(false)

async function onSaveToken() {
  const token = tokenInput.value.trim()
  if (!token) return
  savingToken.value = true
  tokenError.value = ''
  const res = await saveLibraryToken(token)
  savingToken.value = false
  if (!res.ok) {
    tokenError.value = res.json?.error || `Save failed (${res.status})`
    return
  }
  tokenInput.value = '' // never leave the secret sitting in the field after a successful save
}

async function onClearToken() {
  savingToken.value = true
  tokenError.value = ''
  const res = await saveLibraryToken('')
  savingToken.value = false
  if (!res.ok) {
    tokenError.value = res.json?.error || `Clear failed (${res.status})`
    return
  }
  tokenInput.value = ''
}

// -------------------------------- zip upload --------------------------------

const uploading = ref(false)
const dragOver = ref(false)
const uploadMessage = ref('')
const uploadOk = ref(false)

async function doUpload(file) {
  if (!file) return
  if (!/\.zip$/i.test(file.name)) {
    uploadOk.value = false
    uploadMessage.value = 'Please choose a .zip file.'
    return
  }
  uploading.value = true
  uploadMessage.value = ''
  const res = await uploadLibraryApp(file)
  uploading.value = false
  if (res.ok) {
    uploadOk.value = true
    uploadMessage.value = `${res.json.slug} installed — find it under Apps → My apps`
  } else {
    uploadOk.value = false
    uploadMessage.value = res.json?.error || `Upload failed (${res.status})`
  }
}
function onFilePicked(e) {
  const file = e.target.files && e.target.files[0]
  doUpload(file)
  e.target.value = '' // allow picking the same file again after an error
}
function onDrop(e) {
  dragOver.value = false
  const file = e.dataTransfer?.files && e.dataTransfer.files[0]
  doUpload(file)
}

// Relative "last checked" label, ticking every 30s while this tab is mounted.
const now = ref(Date.now())
let tick = null
onMounted(() => {
  tick = setInterval(() => (now.value = Date.now()), 30000)
})
onUnmounted(() => {
  if (tick) clearInterval(tick)
})

function relTime(ts) {
  if (!ts) return 'never'
  const s = Math.max(0, Math.floor((now.value - ts) / 1000))
  if (s < 10) return 'just now'
  if (s < 60) return `${s} sec ago`
  const m = Math.floor(s / 60)
  if (m < 60) return `${m} min ago`
  const h = Math.floor(m / 60)
  if (h < 24) return `${h} hr ago`
  const d = Math.floor(h / 24)
  return `${d} day${d === 1 ? '' : 's'} ago`
}
</script>
