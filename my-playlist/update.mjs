#!/usr/bin/env node
// Pulls the latest upstream data, finds channels/links that are NEW or CHANGED compared with what you
// already tested, tests only those, and merges the working ones into your working playlist.
//
// Usage:
//   node my-playlist/update.mjs [--config my-playlist/preferences.arabic.json] [--dry-run] [--retest-failed] [--no-download]
//                               [--concurrency N] [--timeout MS] [--retries N]
//
//   --dry-run        show what is new/changed/removed, then stop (nothing tested, working list untouched)
//   --retest-failed  also retest links that failed last time (they are skipped by default)
//   --no-download    reuse the data already on disk (offline / testing)
//
// Needs a previous full run first:  npm run my:all   (creates the working playlist + report)
// What counts as "known": a stream id + URL pair that is in your working playlist or in the last failure report.
// New = anything else the current filters select. Removed = in your working list but no longer in the build
// (dropped upstream, no longer matches your filters, or blocklisted).

import fs from 'node:fs'
import path from 'node:path'
import { spawnSync } from 'node:child_process'
import { fileURLToPath } from 'node:url'

const HERE = path.dirname(fileURLToPath(import.meta.url))
const ROOT = path.resolve(HERE, '..')
const args = process.argv.slice(2)
const has = n => args.includes(n)
const val = n => (has(n) ? args[args.indexOf(n) + 1] : undefined)
const DRY = has('--dry-run')
const RETEST_FAILED = has('--retest-failed')
const UPSTREAM_INDEX = 'https://iptv-org.github.io/iptv/index.m3u'

const die = m => {
  console.error(`ERROR: ${m}`)
  process.exit(1)
}
const run = (cmd, a, opts = {}) => spawnSync(cmd, a, { stdio: 'inherit', cwd: ROOT, ...opts })

// ---- paths from your preferences (same rules as build.mjs) ----
const CONFIG = path.resolve(val('--config') || path.join(HERE, 'preferences.json'))
const prefs = JSON.parse(fs.readFileSync(CONFIG, 'utf8'))
const o = prefs.output || {}
const DIST = path.resolve(ROOT, o.directory || 'my-playlist/dist')
const base = o.filename || 'my-iptv'
const F = {
  build: path.join(DIST, `${base}.m3u`),
  working: path.join(DIST, `${base}.working.m3u`),
  report: path.join(DIST, `${base}.working.report.json`),
  newIn: path.join(DIST, `${base}.new.m3u`),
  newOut: path.join(DIST, `${base}.new.working.m3u`),
  newReport: path.join(DIST, `${base}.new.working.report.json`),
  prev: path.join(DIST, `${base}.working.prev.m3u`)
}
const INDEX = path.join(ROOT, '.gh-pages/index.m3u')

if (!fs.existsSync(F.working) || !fs.existsSync(F.report)) {
  die(`No previous test results found in ${path.relative(ROOT, DIST)}/.\nRun "npm run my:all" once first, then use "npm run my:update" from then on.`)
}

// ---- parsing ----
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
      cur.id = (cur.extinf.match(/tvg-id="([^"]*)"/) || [])[1] || ''
      cur.title = cur.extinf.slice(cur.extinf.lastIndexOf(',') + 1)
      cur.key = `${cur.id}\n${cur.url}`
      out.push(cur)
      cur = null
    }
  }
  return out
}
const readM3U = f => parse(fs.readFileSync(f, 'utf8'))
const headerOf = f => {
  const h = (fs.readFileSync(f, 'utf8').split(/\r?\n/)[0] || '').trim()
  return h.startsWith('#EXTM3U') ? h : '#EXTM3U'
}
const write = (f, header, entries) =>
  fs.writeFileSync(f, [header, ...entries.flatMap(e => [e.extinf, ...e.opts, e.url])].join('\r\n') + '\r\n')

// ---- 1. snapshot what you already know BEFORE touching anything ----
const prevWorking = readM3U(F.working)
const prevReport = JSON.parse(fs.readFileSync(F.report, 'utf8'))
const prevFailed = (prevReport.failed_streams || []).map(f => ({ ...f, key: `${f.id}\n${f.url}` }))

// ---- 2. refresh upstream data and rebuild ----
if (!has('--no-download')) {
  console.log('Refreshing channel database...')
  const r = run('npm', ['run', 'api:load'], { shell: true })
  if (r.status !== 0) die('api:load failed (check your internet connection).')

  console.log(`Downloading latest upstream playlist: ${UPSTREAM_INDEX}`)
  let text
  try {
    const res = await fetch(UPSTREAM_INDEX)
    if (!res.ok) throw new Error(`HTTP ${res.status}`)
    text = await res.text()
  } catch (e) {
    die(`could not download the upstream playlist: ${e.message}`)
  }
  const n = (text.match(/^#EXTINF/gm) || []).length
  if (!text.startsWith('#EXTM3U') || n < 1000) die(`downloaded playlist looks wrong (${n} entries). Not overwriting your data.`)
  fs.mkdirSync(path.dirname(INDEX), { recursive: true })
  if (fs.existsSync(INDEX)) fs.copyFileSync(INDEX, INDEX.replace(/\.m3u$/, '.prev.m3u'))
  fs.writeFileSync(INDEX, text)
  console.log(`upstream playlist: ${n} channels`)
}
console.log('Rebuilding your list from your preferences...')
if (run(process.execPath, [path.join(HERE, 'build.mjs'), '--config', CONFIG]).status !== 0) die('build failed.')

// ---- 3. diff ----
const newBuild = readM3U(F.build)
const buildKeys = new Set(newBuild.map(e => e.key))
const buildIds = new Set(newBuild.map(e => e.id))
const seenIds = new Set([...prevWorking.map(e => e.id), ...prevFailed.map(e => e.id)])
const knownKeys = new Set(prevWorking.map(e => e.key))
if (!RETEST_FAILED) prevFailed.forEach(f => knownKeys.add(f.key))

const toTest = newBuild.filter(e => !knownKeys.has(e.key))
const brandNew = toTest.filter(e => !seenIds.has(e.id))
const changed = toTest.filter(e => seenIds.has(e.id) && !prevFailed.some(f => f.key === e.key))
const retried = toTest.filter(e => prevFailed.some(f => f.key === e.key))
const removed = prevWorking.filter(e => !buildKeys.has(e.key) && !buildIds.has(e.id)) // channel gone from the build
const replaced = prevWorking.filter(e => !buildKeys.has(e.key) && buildIds.has(e.id)) // same channel, new link

const show = (label, list) => {
  console.log(`\n${label}: ${list.length}`)
  list.slice(0, 25).forEach(e => console.log(`  + ${e.title}  [${e.id}]`))
  if (list.length > 25) console.log(`  ... and ${list.length - 25} more`)
}
console.log('\n=== Comparison with your last tested list ===')
console.log(`in your working list now:      ${prevWorking.length}`)
console.log(`in the fresh build:            ${newBuild.length}`)
show('NEW channels to test', brandNew)
console.log(`\nlinks changed upstream (will be retested): ${changed.length}`)
console.log(`previously failed (retested only with --retest-failed): ${RETEST_FAILED ? retried.length : prevFailed.filter(f => buildKeys.has(f.key)).length}`)
console.log(`no longer in the build (will be removed): ${removed.length}`)
if (removed.length) removed.slice(0, 15).forEach(e => console.log(`  - ${e.title}  [${e.id}]`))

if (DRY) {
  console.log('\n--dry-run: nothing tested, working playlist unchanged.')
  process.exit(0)
}

// ---- 4. test only the new/changed ones ----
let newWorkingKeys = new Set()
let newFailed = []
if (toTest.length) {
  write(F.newIn, headerOf(F.build), toTest)
  const passthrough = ['--concurrency', '--timeout', '--retries'].flatMap(f => (has(f) ? [f, val(f)] : []))
  if (has('--strict')) passthrough.push('--strict')
  const checker = val('--check-script') || path.join(HERE, 'check.mjs')
  console.log(`\nTesting ${toTest.length} new/changed streams...`)
  const r = run(process.execPath, [checker, F.newIn, '--out', F.newOut, ...passthrough])
  if (r.status !== 0 || !fs.existsSync(F.newOut)) die('the stream test did not complete; working playlist left unchanged.')
  newWorkingKeys = new Set(readM3U(F.newOut).map(e => e.key))
  newFailed = (JSON.parse(fs.readFileSync(F.newReport, 'utf8')).failed_streams || []).map(f => ({ ...f, key: `${f.id}\n${f.url}` }))
}

// ---- 5. merge, keeping the build's order/grouping ----
const keep = new Set([...prevWorking.map(e => e.key).filter(k => buildKeys.has(k)), ...newWorkingKeys])
const finalList = newBuild.filter(e => keep.has(e.key))
fs.copyFileSync(F.working, F.prev)
write(F.working, headerOf(F.build), finalList)

// keep the failure report in sync so "npm run my:prune" sees the new failures too
const retestedKeys = new Set(toTest.map(e => e.key))
const failedKept = prevFailed.filter(f => buildKeys.has(f.key) && !retestedKeys.has(f.key)).map(({ key, ...rest }) => rest)
const failedAll = [...failedKept, ...newFailed.map(({ key, ...rest }) => rest)]
const reasons = {}
failedAll.forEach(f => (reasons[f.error || 'unknown'] = (reasons[f.error || 'unknown'] || 0) + 1))
fs.writeFileSync(
  F.report,
  JSON.stringify(
    {
      ...prevReport,
      tested_at: new Date().toISOString(),
      total: finalList.length + failedAll.length,
      working: finalList.length,
      failed: failedAll.length,
      failure_reasons: Object.fromEntries(Object.entries(reasons).sort((a, b) => b[1] - a[1])),
      failed_streams: failedAll,
      last_update: { tested: toTest.length, added: newWorkingKeys.size, failed: newFailed.length, removed: removed.length, replaced: replaced.length }
    },
    null,
    2
  )
)

console.log('\n=== Update complete ===')
console.log(`tested:   ${toTest.length}  (${brandNew.length} new, ${changed.length} changed, ${retried.length} retried)`)
console.log(`added:    ${newWorkingKeys.size} working`)
console.log(`failed:   ${newFailed.length}`)
console.log(`removed:  ${removed.length} no longer in the build`)
console.log(`replaced: ${replaced.length} old links swapped for retested new ones (kept only if the new link works)`)
console.log(`working playlist now has ${finalList.length} channels -> ${path.relative(ROOT, F.working)}`)
console.log(`previous version saved as ${path.relative(ROOT, F.prev)}`)
console.log('Note: unchanged links are NOT retested here. Run "npm run my:check" now and then to re-verify everything.')
