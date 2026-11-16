#!/usr/bin/env node
// Tests every stream in a playlist and writes a copy that only contains streams that actually respond.
// Usage:
//   node my-playlist/check.mjs [input.m3u] [--out file.m3u] [--concurrency 25] [--timeout 12000] [--retries 1] [--strict]
// Default input:  my-playlist/dist/my-iptv.m3u   Default output: <input>.working.m3u (+ .report.json)
//
// What "working" means (HLS .m3u8):
//   1. playlist downloads (HTTP 2xx) and starts with #EXTM3U
//   2. if it is a master playlist, the first variant playlist also downloads and lists segments
//   3. the first media segment answers 2xx/206 and returns at least 1 byte      (skipped for live-edge-only errors only with no --strict)
// Other URLs (mpd, ts, mp4, rtmp-over-http...): HTTP 2xx and at least 1 byte of body.
// LIMITS (real, not fixable by a script): a pass means "reachable from THIS machine right now".
// Geo-blocked streams fail outside their region; some streams die within hours; some need tokens/IP binding.

import fs from 'node:fs'
import path from 'node:path'
import { fileURLToPath } from 'node:url'

const HERE = path.dirname(fileURLToPath(import.meta.url))
const ROOT = path.resolve(HERE, '..')
const argv = process.argv.slice(2)
const flag = n => argv.includes(n)
const val = (n, d) => {
  const i = argv.indexOf(n)
  return i >= 0 ? argv[i + 1] : d
}
const positional = argv.filter((a, i) => !a.startsWith('--') && !['--out', '--concurrency', '--timeout', '--retries'].includes(argv[i - 1]))

const input = path.resolve(positional[0] || path.join(ROOT, 'my-playlist/dist/my-iptv.m3u'))
const output = path.resolve(val('--out', input.replace(/\.m3u8?$/i, '') + '.working.m3u'))
const CONC = Number(val('--concurrency', 25))
const TIMEOUT = Number(val('--timeout', 12000))
const RETRIES = Number(val('--retries', 1))
const STRICT = flag('--strict')
const DEFAULT_UA = 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/130.0 Safari/537.36'

if (!fs.existsSync(input)) {
  console.error(`Input not found: ${input}\nRun "npm run my:build" first.`)
  process.exit(1)
}

// ---- parse (keeps EXTINF + option lines intact) ----
function parse(text) {
  const out = []
  let cur = null
  for (const raw of text.split(/\r?\n/)) {
    const l = raw.trim()
    if (!l || l.startsWith('#EXTM3U')) continue
    if (l.startsWith('#EXTINF')) cur = { extinf: l, opts: [], url: '' }
    else if (l.startsWith('#') && cur) cur.opts.push(l)
    else if (cur) {
      cur.url = l
      out.push(cur)
      cur = null
    }
  }
  return out
}
const header = (fs.readFileSync(input, 'utf8').split(/\r?\n/)[0] || '#EXTM3U').startsWith('#EXTM3U')
  ? fs.readFileSync(input, 'utf8').split(/\r?\n/)[0]
  : '#EXTM3U'

function headersFor(entry) {
  const h = { 'user-agent': DEFAULT_UA, accept: '*/*' }
  const ua = entry.extinf.match(/http-user-agent="([^"]*)"/)?.[1] || entry.opts.find(o => o.startsWith('#EXTVLCOPT:http-user-agent='))?.split('=').slice(1).join('=')
  const ref = entry.extinf.match(/http-referrer="([^"]*)"/)?.[1] || entry.opts.find(o => o.startsWith('#EXTVLCOPT:http-referrer='))?.split('=').slice(1).join('=')
  if (ua) h['user-agent'] = ua
  if (ref) h.referer = ref
  return h
}

async function get(url, headers, { maxBytes = 1_000_000, range } = {}) {
  const ctl = new AbortController()
  const timer = setTimeout(() => ctl.abort(), TIMEOUT)
  try {
    const res = await fetch(url, { headers: range ? { ...headers, range } : headers, signal: ctl.signal, redirect: 'follow' })
    if (!(res.status >= 200 && res.status < 300)) {
      res.body?.cancel().catch(() => {})
      return { ok: false, status: res.status, error: `HTTP ${res.status}` }
    }
    // read up to maxBytes then stop (never download a whole live stream)
    const chunks = []
    let n = 0
    const reader = res.body.getReader()
    while (n < maxBytes) {
      const { done, value } = await reader.read()
      if (done) break
      chunks.push(value)
      n += value.length
    }
    reader.cancel().catch(() => {})
    return { ok: true, status: res.status, bytes: n, body: Buffer.concat(chunks), finalUrl: res.url }
  } catch (e) {
    return { ok: false, error: e.name === 'AbortError' ? 'timeout' : e.cause?.code || e.message }
  } finally {
    clearTimeout(timer)
  }
}

const resolve = (base, ref) => new URL(ref, base).toString()
const isHls = (u, body) => /\.m3u8(\?|$)/i.test(u) || (body && body.slice(0, 7).toString() === '#EXTM3U')

async function checkOnce(entry) {
  const headers = headersFor(entry)
  let url = entry.url
  if (!/^https?:\/\//i.test(url)) return { ok: false, error: 'unsupported scheme' }

  const first = await get(url, headers, { maxBytes: 500_000 })
  if (!first.ok) return first

  if (!isHls(url, first.body)) {
    // not HLS: a body with at least one byte and 2xx is the most we can verify
    return first.bytes > 0 ? { ok: true } : { ok: false, error: 'empty body' }
  }

  let text = first.body.toString('utf8')
  let base = first.finalUrl || url
  if (!text.startsWith('#EXTM3U')) return { ok: false, error: 'not a valid m3u8 (maybe an HTML error page)' }

  // master playlist -> follow first variant
  if (/#EXT-X-STREAM-INF/.test(text)) {
    const lines = text.split(/\r?\n/)
    const i = lines.findIndex(l => l.startsWith('#EXT-X-STREAM-INF'))
    const variant = lines.slice(i + 1).find(l => l.trim() && !l.startsWith('#'))
    if (!variant) return { ok: false, error: 'master playlist has no variants' }
    const vUrl = resolve(base, variant.trim())
    const v = await get(vUrl, headers, { maxBytes: 500_000 })
    if (!v.ok) return { ...v, error: `variant: ${v.error}` }
    text = v.body.toString('utf8')
    base = v.finalUrl || vUrl
    if (!text.startsWith('#EXTM3U')) return { ok: false, error: 'variant is not a valid m3u8' }
  }

  const seg = text.split(/\r?\n/).filter(l => l.trim() && !l.startsWith('#')).pop() // newest segment
  if (!seg) return { ok: false, error: 'no segments listed' }
  const segUrl = resolve(base, seg.trim())
  if (/\.m3u8(\?|$)/i.test(segUrl)) return { ok: true } // nested playlist, accept
  const s = await get(segUrl, headers, { maxBytes: 4096, range: 'bytes=0-4095' })
  if (!s.ok) return STRICT || s.status !== 404 ? { ...s, error: `segment: ${s.error}` } : { ok: false, error: 'segment: HTTP 404 (stale)' }
  return s.bytes > 0 ? { ok: true } : { ok: false, error: 'segment empty' }
}

async function check(entry) {
  let r
  for (let i = 0; i <= RETRIES; i++) {
    r = await checkOnce(entry)
    if (r.ok) return r
    if (r.status && r.status >= 400 && r.status < 500 && r.status !== 429 && r.status !== 408) break // definitive
  }
  return r
}

// ---- run with a small worker pool ----
const entries = parse(fs.readFileSync(input, 'utf8'))
console.log(`Testing ${entries.length} streams (concurrency ${CONC}, timeout ${TIMEOUT}ms, retries ${RETRIES}${STRICT ? ', strict' : ''})...`)
const results = new Array(entries.length)
let next = 0
let done = 0
let okCount = 0
const t0 = Date.now()

async function worker() {
  while (true) {
    const i = next++
    if (i >= entries.length) return
    const r = await check(entries[i])
    results[i] = r
    done++
    if (r.ok) okCount++
    if (done % 50 === 0 || done === entries.length) {
      process.stdout.write(`\r${done}/${entries.length} tested, ${okCount} working   `)
    }
  }
}
await Promise.all(Array.from({ length: Math.min(CONC, entries.length) }, worker))
process.stdout.write('\n')

const working = entries.filter((_, i) => results[i].ok)
fs.writeFileSync(
  output,
  [header, ...working.flatMap(e => [e.extinf, ...e.opts, e.url])].join('\r\n') + '\r\n'
)

const failures = {}
entries.forEach((e, i) => {
  if (!results[i].ok) failures[results[i].error || 'unknown'] = (failures[results[i].error || 'unknown'] || 0) + 1
})
const report = {
  tested_at: new Date().toISOString(),
  total: entries.length,
  working: working.length,
  failed: entries.length - working.length,
  seconds: Math.round((Date.now() - t0) / 1000),
  failure_reasons: Object.fromEntries(Object.entries(failures).sort((a, b) => b[1] - a[1])),
  failed_streams: entries
    .map((e, i) => ({ e, r: results[i] }))
    .filter(x => !x.r.ok)
    .map(x => ({ id: x.e.extinf.match(/tvg-id="([^"]*)"/)?.[1] || '', url: x.e.url, error: x.r.error }))
}
fs.writeFileSync(output.replace(/\.m3u$/i, '') + '.report.json', JSON.stringify(report, null, 2))
console.log(`Working: ${working.length}/${entries.length}  ->  ${path.relative(process.cwd(), output)}`)
console.log('Top failure reasons:', JSON.stringify(report.failure_reasons, null, 0))
