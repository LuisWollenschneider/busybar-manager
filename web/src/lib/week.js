// Shared weekday vocabulary for the Schedule tab. `value` is the JS
// Date#getDay index the contract stores (0 = Sunday); the list itself is
// Monday-first, which is how the calendar and the day picker read.
export const WEEK_DAYS = [
  { value: 1, label: 'Monday', short: 'Mon' },
  { value: 2, label: 'Tuesday', short: 'Tue' },
  { value: 3, label: 'Wednesday', short: 'Wed' },
  { value: 4, label: 'Thursday', short: 'Thu' },
  { value: 5, label: 'Friday', short: 'Fri' },
  { value: 6, label: 'Saturday', short: 'Sat' },
  { value: 0, label: 'Sunday', short: 'Sun' },
]

export const minutesOf = (hhmm) => Number(hhmm.slice(0, 2)) * 60 + Number(hhmm.slice(3, 5))

// "Mon–Fri" / "Mon, Wed, Fri" / "Every day" — collapses runs in the
// Monday-first order so a weekday block reads as one range.
export function formatDays(days) {
  if (!days || !days.length) return ''
  if (days.length === 7) return 'Every day'
  const order = WEEK_DAYS.map((d) => d.value)
  const picked = order.filter((v) => days.includes(v))
  const runs = []
  for (const v of picked) {
    const last = runs[runs.length - 1]
    if (last && order.indexOf(v) === order.indexOf(last[last.length - 1]) + 1) last.push(v)
    else runs.push([v])
  }
  const shortOf = (v) => WEEK_DAYS.find((d) => d.value === v).short
  return runs.map((run) => (run.length > 2 ? `${shortOf(run[0])}–${shortOf(run[run.length - 1])}` : run.map(shortOf).join(', '))).join(', ')
}
