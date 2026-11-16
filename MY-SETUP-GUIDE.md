# My IPTV setup guide

This repo is a full copy of [iptv-org/iptv](https://github.com/iptv-org/iptv) (public domain, Unlicense/CC0) plus a personal layer in `my-playlist/`:

| File | Purpose |
|---|---|
| `my-playlist/preferences.json` | Your choices: categories, countries, languages, quality, extra links |
| `my-playlist/build.mjs` | Applies your choices to the generated playlists |
| `my-playlist/check.mjs` | Tests every stream and keeps only the ones that respond |
| `.github/workflows/my-playlist.yml` | Optional: does all of it daily on GitHub and hosts the result |

Nothing in the upstream scripts was changed except three added npm scripts (`my:*`).

## What to expect (read this first)

- The repo stores **links, not video**. Many links die within days. That is why testing is a step, not a one-off.
- A test pass means "reachable from the machine that ran the test, right now". It does not guarantee it plays on your TV or in your country. Geo-blocked streams fail outside their region (a VPN or a runner in another country changes results).
- The tester checks the playlist, the first variant and one media segment. It does not decode video, so a rare stream that responds but shows a black screen can still pass.
- Adult (`xxx`) channels are not in the public `index.m3u` that this layer reads, so they are excluded by design.

## Step 1. Requirements

Node.js 20+ (22 recommended) and git. Check with `node -v`.

## Step 2. Get the repo

```bash
git clone <your-copy-of-this-repo> iptv && cd iptv
npm ci
```

`npm ci` also downloads the channel database (`temp/data/`). It needs internet access to `iptv-org.github.io`.

## Step 3. Refresh data and generate the public playlists

```bash
npm run my:setup
```

This runs `api:load` (channel database) then `playlist:generate` (about 1,800 playlists into `.gh-pages/`). Takes a minute or two.

## Step 4. See what you can choose from

```bash
npm run my:list -- categories
npm run my:list -- countries
npm run my:list -- languages
npm run my:list -- stats
```

The number on each line is how many channels exist for that choice. Use the code in the second column in your preferences. Note the UK code is `uk`, not `gb`.

## Step 5. Set your preferences

Edit `my-playlist/preferences.json`. An empty list `[]` means "no restriction".

| Key | Meaning | Example |
|---|---|---|
| `filters.categories_include` | Keep only these categories | `["news","sports","movies"]` |
| `filters.categories_exclude` | Drop these categories | `["religious","shop"]` |
| `filters.countries_include` / `_exclude` | Country codes of the channel | `["us","uk","ca"]` |
| `filters.languages_include` / `_exclude` | 3-letter language codes | `["eng","spa"]` |
| `filters.name_include` / `name_exclude` | Case-insensitive regex on channel name | `["^BBC","CNN"]` |
| `filters.min_height` / `max_height` | Resolution limits in pixels (0 = off) | `720` |
| `filters.drop_unknown_quality` | Drop channels with no resolution label when `min_height` is set | `false` |
| `filters.allow_geo_blocked` | Keep streams labelled geo-blocked | `false` |
| `filters.allow_not_247` | Keep streams labelled not 24/7 | `true` |
| `filters.exclude_closed` | Drop channels marked closed in the database | `true` |
| `always_include_ids` | Channel or stream ids to keep, overriding filters | `["CNN.us"]` |
| `blocklist_ids` | Channel or stream ids to never include | `["Example.us@SD"]` |
| `extra_playlists` | Your own M3U files or URLs, appended as-is | `["my-playlist/mine.m3u"]` |
| `epg_url` | Program guide URL written in the header | `""` |
| `max_channels` | Cap the total (0 = no cap) | `500` |
| `output.group_by` | `category`, `country` or `none` | `category` |
| `output.category_priority` | Which category names the group when a channel has several | `["news","sports"]` |
| `output.also_split_by` | Also write one file per `category` or `country` | `category` |

Include filters are AND-ed across kinds (a channel must match your category AND country AND language) and OR-ed within one list. Unknown codes print a warning, so typos do not fail silently.

Suggested starting points:

- **News only, worldwide English**: `categories_include ["news"]`, `languages_include ["eng"]`, `countries_include []`.
- **Sports from several countries**: `categories_include ["sports"]`, `countries_include ["us","uk","es","de"]`, `languages_include []`.
- **Kids and family, HD only**: `categories_include ["kids","family","animation"]`, `min_height 720`.

## Step 6. Build

```bash
npm run my:build
```

Output: `my-playlist/dist/my-iptv.m3u` (plus `by-category/` files if enabled). Re-run after each preference change. This file is unverified.

## Step 7. Test the streams and keep only working ones

Run this on the machine and network where you will watch, so results reflect your reality.

```bash
npm run my:check
```

Output:

- `my-playlist/dist/my-iptv.working.m3u` is the file to use.
- `my-playlist/dist/my-iptv.working.report.json` lists every failure with its reason.

Options (pass after `--`):

```bash
npm run my:check -- --concurrency 40 --timeout 15000 --retries 2 --strict
```

Speed is roughly concurrency divided by average response time. A few hundred channels finish in a few minutes. Testing all ~11,500 channels (empty filters) takes much longer and hits many servers, so filter first.

## Step 7b (optional). Block dead links permanently

After a check, save the definitive failures (404, dead domain, bad certificate, not a playlist) to your blocklist so future builds skip them:

```bash
npm run my:prune -- --dry-run   # preview, writes nothing
npm run my:prune                # block definitive failures only
npm run my:prune -- --all       # also block timeouts, 403, 5xx (risky: temporary failures get blocked for good)
```

This edits `blocklist_ids` in `my-playlist/preferences.json`. To undo, delete ids from that list. It uses the report from the last check, so run `npm run my:all` first.

## Step 7c. Pick up new upstream channels later

iptv-org adds and removes links every day. To refresh your list without re-testing everything:

```bash
npm run my:update -- --dry-run   # preview: new, changed and removed channels, nothing tested
npm run my:update                # download latest, test ONLY new/changed links, merge the working ones
npm run my:update -- --retest-failed   # also give previously failed links another chance
```

How it works: it downloads iptv-org's freshly published `index.m3u`, rebuilds your list from your preferences, and compares it with your last tested list. Anything it has not seen before (or whose link changed) is tested. Working ones are merged into `my-iptv.working.m3u`, channels that disappeared are removed, and the previous version is saved as `my-iptv.working.prev.m3u`. It needs one full `npm run my:all` first.

Limits: unchanged links are not retested, so also run `npm run my:check` now and then. Your repo's own `streams/` snapshot is not updated by this (the script does not need it).

## Step 8. Watch it

Open `my-iptv.working.m3u` in VLC, Kodi, Jellyfin, TiviMate and similar apps (Network stream or Playlist URL).

## Step 9 (optional). Automate and host it

1. Create your own GitHub repo and push this one:
   ```bash
   git remote set-url origin https://github.com/<you>/<repo>.git
   git add -A && git commit -m "my iptv setup" && git push -u origin HEAD
   ```
2. In the repo, Settings, Pages: deploy from branch `gh-pages`.
3. Actions tab: run `my-playlist` once with "Run workflow". It then runs daily.
4. Your URL: `https://<you>.github.io/<repo>/my-iptv.working.m3u`.

Caveats: GitHub runners are in US data centers, so streams that block data centers or non-US IPs fail there and are dropped, even if they would play at your home. If that matters, schedule `npm run my:all` on your own machine or a home server instead. The workflow overwrites `gh-pages` each run. Publishing the list publicly is your call.

Also disable the upstream workflows you do not need (Actions tab, `update`, `check`, `format`, `validate_*`). They are written for the upstream project and will fail or do nothing useful on a copy.

## Keeping up with upstream

```bash
git remote add upstream https://github.com/iptv-org/iptv.git
git fetch upstream && git merge upstream/master
```

Your layer lives in new files, so conflicts are unlikely (only `package.json` scripts and `.gitignore`).

## Troubleshooting

- `.gh-pages/index.m3u not found`: run `npm run my:setup`.
- `temp/data/... not found`: run `npm run api:load` (needs access to `iptv-org.github.io`).
- 0 channels matched: loosen filters. Check codes with `npm run my:list -- <kind>`.
- Everything fails in the checker: you are probably offline, behind a proxy or firewall, or the timeout is too low.
