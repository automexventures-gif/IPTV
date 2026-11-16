#!/usr/bin/env node
// Adds streams that failed the last check to "blocklist_ids" in preferences.json,
// so future builds no longer include them.
// Usage:
//   node my-playlist/prune.mjs [--config my-playlist/preferences.arabic.json] [--report file.json] [--all] [--dry-run]
// Default: only DEFINITIVE failures (404, dead domain, bad certificate, not a playlist).
// --all  also blocks temporary-looking failures (timeouts, 403, 5xx...). Use with care:
//        a stream that timed out today may work tomorrow, and 403s may only be geo-blocks for you.

import fs from 'node:fs'
import path from 'node:path'
import { fileURLToPath } from 'node:url'

const HERE = path.dirname(fileURLToPath(import.meta.url))
const args = process.argv.slice(2)
const val = n => (args.includes(n) ? args[args.indexOf(n) + 1] : undefined)
const ALL = args.includes('--all')
const DRY = args.includes('--dry-run')

const prefsPath = path.resolve(val('--config') || path.join(HERE, 'preferences.json'))
const cfgOut = fs.existsSync(prefsPath) ? JSON.parse(fs.readFileSync(prefsPath, 'utf8')).output || {} : {}
const reportPath = path.resolve(
  val('--report') || path.resolve(path.dirname(HERE), cfgOut.directory || 'my-playlist/dist', `${cfgOut.filename || 'my-iptv'}.working.report.json`)
)

for (const f of [reportPath, prefsPath]) {
  if (!fs.existsSync(f)) {
    console.error(`Not found: ${f}\nRun "npm run my:all" first so a report exists.`)
    process.exit(1)
  }
}

const DEFINITIVE = [
  /^HTTP (404|410)$/,
  /^variant: HTTP (404|410)$/,
  /^ENOTFOUND$/,
  /^CERT_HAS_EXPIRED$/,
  /^ERR_TLS_CERT_ALTNAME_INVALID$/,
  /^DEPTH_ZERO_SELF_SIGNED_CERT$/,
  /^not a valid m3u8/,
  /^no segments listed$/,
  /^master playlist has no variants$/
]

const report = JSON.parse(fs.readFileSync(reportPath, 'utf8'))
const prefs = JSON.parse(fs.readFileSync(prefsPath, 'utf8'))
const existing = new Set(prefs.blocklist_ids || [])

const failed = report.failed_streams || []
const picked = failed.filter(f => ALL || DEFINITIVE.some(re => re.test(f.error || '')))
const noId = picked.filter(f => !f.id).length
const ids = picked.map(f => f.id).filter(Boolean)
const fresh = [...new Set(ids)].filter(id => !existing.has(id))

console.log(`report: ${report.failed} failed of ${report.total} (tested ${report.tested_at})`)
console.log(`${ALL ? 'blocking ALL failures' : 'blocking definitive failures only'}: ${picked.length} matched`)
console.log(`new ids to block: ${fresh.length}   already blocked: ${ids.length - fresh.length}   skipped (no tvg-id, cannot block): ${noId}`)
console.log(`left unblocked for a future retry: ${failed.length - picked.length}`)

if (DRY) {
  console.log('--dry-run: nothing written.')
  process.exit(0)
}
prefs.blocklist_ids = [...existing, ...fresh].sort()
fs.writeFileSync(prefsPath, JSON.stringify(prefs, null, 2) + '\n')
console.log(`preferences.json updated: blocklist_ids now has ${prefs.blocklist_ids.length} entries.`)
console.log('Run "npm run my:all" to rebuild and re-test without them. To undo: remove ids from blocklist_ids.')
