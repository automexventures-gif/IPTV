#!/usr/bin/env node
// Merges the tested (working) playlists of all profiles into ONE playlist.
// Usage: node my-playlist/merge.mjs [--out my-playlist/dist/my-iptv-combined.m3u] [--in a.m3u --in b.m3u ...]
// Default inputs: dist/my-iptv.working.m3u and dist/my-iptv-arabic.working.m3u (missing files are skipped, with a note).
// Duplicates (same stream id + same URL, or same URL) are removed, first one wins.
// Group order and football rule come from preferences.arabic.json (output.group_order / group_overrides).

import fs from 'node:fs'
import path from 'node:path'
import { fileURLToPath } from 'node:url'

const HERE = path.dirname(fileURLToPath(import.meta.url))
const ROOT = path.resolve(HERE, '..')
const args = process.argv.slice(2)
const all = n => args.flatMap((a, i) => (a === n ? [args[i + 1]] : []))
const DIST = path.join(ROOT, 'my-playlist/dist')
const inputs = (all('--in').length ? all('--in') : [path.join(DIST, 'my-iptv.working.m3u'), path.join(DIST, 'my-iptv-arabic.working.m3u')]).map(f => path.resolve(f))
const out = path.resolve(all('--out')[0] || path.join(DIST, 'my-iptv-combined.m3u'))

function parse(text) {
  const res = []
  let cur = null
  for (const raw of text.split(/\r?\n/)) {
    const l = raw.trim()
    if (!l || l.startsWith('#EXTM3U')) continue
    if (l.startsWith('#EXTINF')) cur = { extinf: l, opts: [], url: '' }
    else if (l.startsWith('#') && cur) cur.opts.push(l)
    else if (cur) {
      cur.url = l
      cur.id = (cur.extinf.match(/tvg-id="([^"]*)"/) || [])[1] || ''
      cur.group = (cur.extinf.match(/group-title="([^"]*)"/) || [])[1] || ''
      cur.title = cur.extinf.slice(cur.extinf.lastIndexOf(',') + 1)
      res.push(cur)
      cur = null
    }
  }
  return res
}

// football rule + group order from the Arabic profile (optional)
let rules = []
let order = []
const arabicCfg = path.join(HERE, 'preferences.arabic.json')
if (fs.existsSync(arabicCfg)) {
  const o = JSON.parse(fs.readFileSync(arabicCfg, 'utf8')).output || {}
  rules = (o.group_overrides || []).map(r => ({ re: new RegExp(r.title_regex, 'i'), group: r.group }))
  order = (o.group_order || []).map(x => x.toLowerCase())
}

const seenKey = new Set()
const seenUrl = new Set()
const merged = []
let header = '#EXTM3U'
for (const f of inputs) {
  if (!fs.existsSync(f)) {
    console.warn(`note: ${path.relative(ROOT, f)} not found, skipped`)
    continue
  }
  const text = fs.readFileSync(f, 'utf8')
  const first = text.split(/\r?\n/)[0].trim()
  if (first.startsWith('#EXTM3U') && first.length > header.length) header = first
  let added = 0
  for (const e of parse(text)) {
    const key = `${e.id}\n${e.url}`
    if (seenKey.has(key) || seenUrl.has(e.url)) continue
    seenKey.add(key)
    seenUrl.add(e.url)
    // football rule only moves channels that are already in a sports-type group
    if (/^(sports|football)$/i.test(e.group)) {
      const hit = rules.find(r => r.re.test(e.title))
      if (hit) {
        e.group = hit.group
        e.extinf = e.extinf.replace(/group-title="[^"]*"/, `group-title="${hit.group}"`)
      }
    }
    merged.push(e)
    added++
  }
  console.log(`${path.relative(ROOT, f)}: ${added} channels added`)
}
if (!merged.length) {
  console.error('ERROR: nothing to merge. Run "npm run my:all" and/or "npm run my:arabic" first.')
  process.exit(1)
}

const rank = g => {
  const i = order.indexOf(g.toLowerCase())
  return i === -1 ? order.length : i
}
merged.sort((a, b) => rank(a.group) - rank(b.group) || a.group.localeCompare(b.group) || a.title.localeCompare(b.title))
fs.mkdirSync(path.dirname(out), { recursive: true })
fs.writeFileSync(out, [header, ...merged.flatMap(e => [e.extinf, ...e.opts, e.url])].join('\r\n') + '\r\n')
console.log(`wrote ${path.relative(ROOT, out)} (${merged.length} channels)`)
