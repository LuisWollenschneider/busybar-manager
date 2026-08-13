<template>
  <section class="section-card">
    <div class="sc-head">
      <div class="sc-head-inner">
        <div class="sc-title-wrap">
          <span class="sc-icon" v-html="icons.clockFill"></span>
          <div class="sc-title-block">
            <div class="sc-title-row">
              <span class="sc-title">Schedule</span>
              <span v-if="!schedule.enabled" class="status-chip">paused</span>
            </div>
            <!-- One live status line instead of a static blurb plus a separate
                 "now" paragraph: what the schedule is doing is the only thing
                 worth the space here. -->
            <div class="sc-subtitle">
              <template v-if="!schedule.enabled">Paused — slots stay saved, nothing starts or stops.</template>
              <template v-else-if="activeSlot">
                <span class="live-dot"></span>Now <strong>{{ appName(activeSlot.slug) }}</strong>
                <span class="sub-dim">· {{ activeSlot.variation }} · until {{ activeSlot.end }}</span>
              </template>
              <template v-else-if="schedule.slots.length">Idle · next {{ nextLabel }}</template>
              <template v-else>No slots yet — click anywhere in the calendar to add one.</template>
            </div>
          </div>
        </div>
        <div class="sc-actions">
          <button class="pill sm brand" :disabled="!apps.length" @click="openNew()" v-html="withLabel(icons.plus, 'Add slot')"></button>
        </div>
      </div>
    </div>

    <div class="sc-body">
      <div v-if="!apps.length" class="empty-note">No apps found — install or add apps before scheduling them.</div>
      <div v-else class="cal" ref="calEl" :class="{ paused: !schedule.enabled }">
        <div class="cal-grid" :style="{ gridTemplateRows: `auto ${totalPx}px` }">
          <div class="cal-corner"></div>
          <div v-for="d in weekDays" :key="`h${d.value}`" class="cal-day-head" :class="{ today: d.value === todayIdx }">
            <span class="cal-day-name">{{ d.short }}</span>
          </div>

          <div class="cal-gutter">
            <div v-for="(h, i) in hourHeights" :key="i" class="cal-hour" :style="{ height: `${h}px` }">
              <span v-if="i > 0">{{ String(i).padStart(2, '0') }}:00</span>
            </div>
          </div>
          <div
            v-for="d in weekDays"
            :key="`c${d.value}`"
            class="cal-day"
            :class="{ today: d.value === todayIdx }"
            :title="`Click to add a slot on ${d.label}`"
            @click.self="addAt(d.value, $event)"
          >
            <div class="cal-lines">
              <div v-for="(h, i) in hourHeights" :key="i" class="cal-line" :style="{ height: `${h}px` }"></div>
            </div>
            <button
              v-for="slot in slotsByDay[d.value]"
              :key="slot.id"
              class="cal-event"
              :class="eventClass(slot, d.value)"
              :style="eventStyle(slot)"
              :title="`${appName(slot.slug)} · ${formatDays(slot.days)} ${slot.start}–${slot.end}`"
              @click="openEdit(slot)"
            >
              <span class="ev-app">{{ appName(slot.slug) }}</span>
              <span class="ev-time">{{ slot.start }}–{{ slot.end }}</span>
              <span class="ev-var">{{ slot.variation }}</span>
            </button>
            <div v-if="d.value === todayIdx" class="cal-now" :style="{ top: `${pxAt(nowMinutes)}px` }"><i></i></div>
          </div>
        </div>
      </div>
    </div>
  </section>

  <SlotEditor v-if="editing" :slot-data="editing" :apps="apps" @close="editing = null" />
</template>

<script setup>
import { ref, computed, onMounted, onUnmounted } from 'vue'
import { manager } from '../composables/useManager'
import { icons } from '../icons'
import { WEEK_DAYS, minutesOf, formatDays } from '../lib/week'
import SlotEditor from './SlotEditor.vue'

const weekDays = WEEK_DAYS
const MINUTES_PER_DAY = 24 * 60
// An hour of calendar at rest — tall enough for a block's three lines (app,
// time, variation). Only the stretches of an hour that actually hold a slot
// grow past their share of this; see `layout`.
const HOUR_PX = 52
// Every slot block gets at least this much height, however short its window,
// so a 5-minute slot stays readable. 75% of an hour row: the most a short
// block may claim before it would read as a longer window than it is.
const MIN_BLOCK_PX = Math.round(HOUR_PX * 0.75)

// The run/pause switch lives in the app header (it is useful from every tab),
// so this component only edits slots.
const editing = ref(null)
const calEl = ref(null)
// Reactive so the "today" column and the active-occurrence highlight follow the
// clock over midnight instead of pinning to the day the tab was opened.
const todayIdx = ref(new Date().getDay())

// Drives the "now" line; a minute of granularity is all the calendar shows.
const nowMinutes = ref(new Date().getHours() * 60 + new Date().getMinutes())
let nowTimer = null
onMounted(() => {
  nowTimer = setInterval(() => {
    const d = new Date()
    nowMinutes.value = d.getHours() * 60 + d.getMinutes()
    todayIdx.value = d.getDay()
  }, 30000)
  // 24 h of calendar is taller than the panel, so open it where the content
  // is: the earliest slot, or the current hour when there is nothing yet.
  const firstStart = schedule.value.slots.reduce((min, s) => Math.min(min, minutesOf(s.start)), MINUTES_PER_DAY)
  const target = firstStart === MINUTES_PER_DAY ? nowMinutes.value : firstStart
  if (calEl.value) calEl.value.scrollTop = Math.max(0, pxAt(Math.max(0, target - 60)))
})
onUnmounted(() => {
  if (nowTimer) clearInterval(nowTimer)
})

const schedule = computed(() => manager.schedule || { enabled: false, slots: [], activeSlotId: null })
const apps = computed(() => manager.apps || [])
const nowPct = computed(() => (nowMinutes.value / MINUTES_PER_DAY) * 100)

// A slot renders in every day it covers, at the same height in each column —
// that alignment is the whole point of the calendar layout.
const slotsByDay = computed(() => {
  const byDay = { 0: [], 1: [], 2: [], 3: [], 4: [], 5: [], 6: [] }
  for (const slot of schedule.value.slots) for (const day of slot.days) byDay[day]?.push(slot)
  for (const day of Object.keys(byDay)) byDay[day].sort((a, b) => minutesOf(a.start) - minutesOf(b.start))
  return byDay
})

const activeSlot = computed(() => schedule.value.slots.find((s) => s.id === schedule.value.activeSlotId) || null)

// The day's vertical scale, as a piecewise-linear minutes → pixels mapping.
//
// Every slot boundary in the week (plus every hour boundary) cuts the day into
// segments, and only the segments a slot actually sits on are allowed to grow:
// a 5-minute slot stretches its own five minutes to MIN_BLOCK_PX and leaves
// the remaining 55 minutes of that hour at their normal scale, instead of
// inflating the whole row. Because the segments come from the *whole* week and
// every column is drawn against the same scale, two short slots at adjacent
// times on different days land in different bands — they read as consecutive
// rather than concurrent — without either of them being blown up.
const layout = computed(() => {
  const marks = new Set()
  for (let h = 0; h <= 24; h++) marks.add(h * 60)
  const windows = schedule.value.slots
    .map((s) => ({ start: minutesOf(s.start), end: minutesOf(s.end) }))
    .filter((w) => w.end > w.start)
  for (const w of windows) {
    marks.add(w.start)
    marks.add(w.end)
  }
  const cuts = [...marks].filter((m) => m >= 0 && m <= MINUTES_PER_DAY).sort((a, b) => a - b)
  const segs = cuts.slice(0, -1).map((start, i) => {
    const end = cuts[i + 1]
    return { start, end, px: ((end - start) / 60) * HOUR_PX }
  })

  // Grow the segments under any too-short slot until the block clears
  // MIN_BLOCK_PX. Heights only ever increase and a grown segment also helps
  // every other slot sharing it, so this settles in a pass or two; the bound
  // is a guard, not an expectation.
  for (let pass = 0; pass < 8; pass++) {
    let changed = false
    for (const w of windows) {
      const covered = segs.filter((g) => g.start >= w.start && g.end <= w.end)
      const total = covered.reduce((sum, g) => sum + g.px, 0)
      if (!covered.length || total >= MIN_BLOCK_PX - 0.01) continue
      const scale = MIN_BLOCK_PX / total
      for (const g of covered) g.px *= scale
      changed = true
    }
    if (!changed) break
  }

  const offsets = [0]
  for (const g of segs) offsets.push(offsets[offsets.length - 1] + g.px)
  return { segs, offsets }
})

// Minutes past midnight → pixels down the column.
function pxAt(mins) {
  const { segs, offsets } = layout.value
  if (mins <= 0) return 0
  for (let i = 0; i < segs.length; i++) {
    if (mins < segs[i].end) return offsets[i] + ((mins - segs[i].start) / (segs[i].end - segs[i].start)) * segs[i].px
  }
  return offsets[segs.length]
}

// Hour rows, for the gridlines and the time axis. Every hour boundary is a
// segment cut, so these line up exactly with the blocks.
const hourHeights = computed(() => Array.from({ length: 24 }, (_, i) => pxAt((i + 1) * 60) - pxAt(i * 60)))
const hourOffsets = computed(() => {
  const offsets = [0]
  for (const h of hourHeights.value) offsets.push(offsets[offsets.length - 1] + h)
  return offsets
})
const totalPx = computed(() => pxAt(MINUTES_PER_DAY))

function eventHeight(slot) {
  return pxAt(minutesOf(slot.end)) - pxAt(minutesOf(slot.start))
}
function eventStyle(slot) {
  return { top: `${pxAt(minutesOf(slot.start))}px`, height: `${eventHeight(slot)}px` }
}
// How much of the block's content fits is a question about its rendered
// height, not its duration: an hour-long slot and a 15-minute one now come out
// the same size.
// A slot draws in every day it covers, but only one of those columns is the
// occurrence that is running right now — highlighting the rest would claim the
// app is live on days it is not.
function eventClass(slot, day) {
  const px = eventHeight(slot)
  return {
    active: slot.id === schedule.value.activeSlotId && day === todayIdx.value,
    unknown: !appName(slot.slug, true),
    compact: px < 50,
    tiny: px < 36,
  }
}

// First slot at or after "now" in the week, wrapping around — purely
// informational, the server decides what actually runs.
const nextLabel = computed(() => {
  const nowKey = todayIdx.value * MINUTES_PER_DAY + nowMinutes.value
  const occurrences = []
  for (const slot of schedule.value.slots) {
    for (const day of slot.days) occurrences.push({ slot, day, key: day * MINUTES_PER_DAY + minutesOf(slot.start) })
  }
  occurrences.sort((a, b) => a.key - b.key)
  const next = occurrences.find((o) => o.key > nowKey) || occurrences[0]
  if (!next) return ''
  const label = weekDays.find((d) => d.value === next.day)?.label || ''
  return `${appName(next.slot.slug)} on ${label} at ${next.slot.start}`
})

// `strict` distinguishes "the app is gone" (used to grey the block out) from
// the display fallback, which always has to render something.
function appName(slug, strict = false) {
  const app = apps.value.find((a) => a.slug === slug)
  if (!app || app.missing) return strict ? '' : slug
  return app.name || slug
}

function withLabel(svg, label) {
  return `${svg}<span>${label}</span>`
}

function openNew(day, hour) {
  const start = hour === undefined ? 9 : hour
  editing.value = {
    id: null,
    days: [day ?? todayIdx],
    start: `${String(start).padStart(2, '0')}:00`,
    end: start >= 23 ? '24:00' : `${String(start + 1).padStart(2, '0')}:00`,
    slug: apps.value[0]?.slug || '',
    variation: 'default',
  }
}

// Click on empty calendar space → a one-hour slot starting at that hour. Rows
// are not a uniform height any more, so walk the offsets to find the hour.
function addAt(day, event) {
  const offsets = hourOffsets.value
  let hour = 0
  while (hour < 23 && offsets[hour + 1] <= event.offsetY) hour++
  openNew(day, hour)
}

function openEdit(slot) {
  editing.value = { ...slot, days: [...slot.days] }
}
</script>
