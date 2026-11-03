'use client'
/**
 * Client-side latency & quality metrics using the monotonic clock (performance.now()).
 * We never subtract unsynchronized cross-host clocks. Content-free: no text is recorded.
 */
export type Mark =
  | 'partner_first_partial'
  | 'partner_final'
  | 'candidates_ready'
  | 'user_approval'
  | 'tts_request'
  | 'first_audio'
  | 'stop_pressed'
  | 'stop_silenced'
  | 'playback_done'

interface Sample { name: string; ms: number; warm: boolean }

const samples: Sample[] = []
const counters = { approvedTurns: 0, aiApproved: 0, aiEdited: 0, aiRejected: 0, typed: 0, stops: 0, uncertain: 0, unapprovedSpeech: 0, routeFallbacks: 0 }
let lastTts = 0

export function recordInterval(name: string, ms: number) {
  const warm = performance.now() - lastTts < 5 * 60_000
  samples.push({ name, ms, warm })
  if (samples.length > 500) samples.shift()
}

export function noteTts() {
  lastTts = performance.now()
}

export function count(k: keyof typeof counters, n = 1) {
  counters[k] += n
}

function pct(xs: number[], p: number) {
  if (!xs.length) return null
  const s = [...xs].sort((a, b) => a - b)
  return Math.round(s[Math.min(s.length - 1, Math.floor((p / 100) * s.length))])
}

export function summary() {
  const names = Array.from(new Set(samples.map((s) => s.name)))
  return {
    intervals: names.map((n) => {
      const xs = samples.filter((s) => s.name === n).map((s) => s.ms)
      return { name: n, n: xs.length, p50: pct(xs, 50), p95: pct(xs, 95) }
    }),
    counters: { ...counters },
  }
}
