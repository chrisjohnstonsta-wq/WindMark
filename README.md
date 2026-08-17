# WindMark — K9 SAR Wind Logger

A very small offline web app for logging wind observations during K9 search-and-rescue
operations. It is **not** a navigation or tracking tool — CalTopo already handles the
track, terrain, and map. WindMark does one job:

> Record trustworthy, timestamped wind observations that can later be overlaid on an
> existing CalTopo search track.

Target platform: iPhone / Safari / installed PWA. Android Chrome is secondary.

---

## The field workflow

1. Point the **top of the phone the way the wind is blowing** (the way a talc puff travels).
2. Tap **MARK WIND** — heading, GPS fix, and timestamp are frozen at that instant.
3. Tap one intensity: **NO DISCERNIBLE WIND / CALM / LIGHT / MODERATE / STRONG**.
4. The observation is written to storage, then a full-screen **SAVED** confirmation
   appears with an **UNDO** button.

Two taps. Optional extras (GUSTY toggle, measured mph) sit above the intensity buttons
and are set before the intensity tap that commits.

Nothing is ever auto-captured. Nothing is saved without an intensity tap.

---

## Bearing reference — °M and °T

Every directional bearing shown anywhere in the app carries its reference: **°T** for
true, **°M** for magnetic. There is no bare bearing number in the UI, and there is one
helper (`bearingText`) that all of them go through.

Input may originate as either. **Wind direction is normalised to true before it is
stored or used as authoritative data** — the sensor path applies the correction inside
the compass module, the hand-entry path applies it at commit, and both write
`downwind_true` / `from_true`. Declination is applied to magnetic input only; a true
reading is never corrected twice.

The raw magnetic reading is kept in storage for provenance and debugging
(`heading_magnetic_raw`, with `bearing_input_ref` and `declination_applied`), and it is
labelled as provenance wherever it is shown. It is not an operational bearing and does
not appear in the standard export.

## Direction convention

This is the part that must never be reversed:

| Field | Meaning |
|---|---|
| `downwind_true` | true bearing the wind is blowing **toward** — where the top of the phone was pointed |
| `from_true`     | `(downwind_true + 180) % 360` — the meteorological "wind **from**" bearing |

The capture screen shows the downwind bearing large (that is what you are physically
aiming) and `WIND FROM nnn°T` underneath (that is what goes in the log and what review
and export display).

### True north / declination

    true = magnetic + declination        (east declination positive)

Default is **+8° E**, adjustable in Settings, and shown on the capture screen as
`DEC +8°E`. There is no geomagnetic model and no automatic lookup — set it from your
map or NOAA before the search.

Two independent reference controls exist, because they are two different questions:

* **Per-entry, on the bearing-by-hand screen — `MAGNETIC °M` / `TRUE °T`.** Chosen for
  each reading, next to the number, with the suffix repeated on the input field and a
  live conversion under it (`276°M → blowing toward 284°T / WIND FROM 104°T`). It
  defaults to whatever you picked last; Settings shows and sets that default. If your
  compass is set with a declination scale, use TRUE °T and no correction is applied.
* **The phone sensor's reference is decided by the source, not by a setting.**
  On iPhone, Safari reports `webkitCompassHeading`, which Apple documents as relative
  to **magnetic** north; WindMark always treats it as °M and always applies the
  declination. That is not user-configurable. The Android / absolute-orientation
  fallback has no documented reference, so a `PHONE SENSOR HEADING IS` control remains
  for it alone — it is hidden on iPhone, and its help text says it applies only to the
  fallback. Settle the fallback with the SENSOR PROOF screen and a real compass.

Every observation stores the declination in effect, whether it was applied
(`declination_applied`), the bearing source, and what the reading was entered as, so
any log can be audited after the fact.

---

## Phase 0 — sensor proof (do this first, outside, with a compass)

`SENSORS` on the capture screen opens the diagnostic page: GPS coordinates, accuracy,
fix age, raw alpha/beta/gamma, the `absolute` flag, raw heading, smoothed heading,
sample consistency, compass accuracy where reported, tilt warning, screen orientation,
active declination, computed true heading, storage and service-worker state.

**Protocol**

1. Stand clear of vehicles, power lines, and steel.
2. Hold the phone flat, top edge pointed along a compass sighting.
3. Compare `TRUE heading` against the compass (corrected for declination) on at least
   eight headings spread around the circle.
4. Explicitly test around north: **358°, 359°, 0°, 1°, 2°**. The reading must move
   smoothly through the seam and never show 180° of error.
5. Agreement should be within about **±10°**.

On iPhone the reference is fixed (magnetic), so a consistent offset means the
declination setting is wrong, not the reference. On the Android fallback only, a phone
reading consistently high by roughly the declination means the browser was already
giving true north — switch *Phone sensor heading is* to TRUE °T and repeat. If it
disagrees wildly or wanders, use bearing by hand; the app never hides this.

Heading smoothing is a **circular (vector) mean over the last 500 ms**. Bearings are
never averaged arithmetically — `(359 + 1) / 2 = 180` is exactly backwards.

The heading is that of the **top edge of the phone**, computed from the full
orientation matrix, so it is unaffected by roll and by moderate tilt. If the top edge
gets within ~25° of vertical the horizontal direction is meaningless and the app says
"hold the phone flatter" rather than showing a confident wrong number.

---

## When the compass will not cooperate

**A sensor bearing is only ever saved when compass status is a clean `ok`.** Anything
else — uncalibrated, reported accuracy worse than the threshold, too much tilt, no
usable smoothed heading, stale events, relative-only orientation — is refused as
authoritative and the capture screen shows `---°T`. The observation is never discarded
for it: the handler enters the bearing by hand instead.

Every sensor failure produces a visible explanation and a fallback:

* orientation permission denied → explained, with **ENTER BEARING BY HAND**
* no orientation events at all → "No compass data from this device"
* relative-only orientation (no true compass) → refused as a bearing source; it is
  never written to a log
* events stopped → "Compass stopped sending data"
* uncalibrated / poor accuracy → shown with the reported accuracy
* top edge near vertical → "Hold the phone flatter"

MARK WIND always goes to the intensity screen, even with no usable heading — **No
discernible wind needs no bearing and must stay a two-tap save** with a dead compass.
The screen says so plainly (`NO USABLE BEARING · No discernible wind can be saved
as-is. Directional observations require a hand-entered bearing.`), and only CALM /
LIGHT / MODERATE / STRONG divert to hand entry before saving.

`ENTER BEARING BY HAND` is also always on the capture screen. Entry is a large number
field carrying its own °M/°T suffix, a `MAGNETIC °M` / `TRUE °T` selector above it,
−10/−1/+1/+10 buttons, and a live preview showing the conversion and the resulting true
bearings. Typed values must be **0 to 360 inclusive**; 360° normalises to 000°, and
anything else (−1, 361, 999) is rejected with *Enter a bearing from 000° to 360°*
rather than silently wrapped into a bearing nobody read. The nudge buttons still wrap
around north on purpose.

GPS never blocks a capture. A poor or stale fix is displayed and stored
(`±24 m · fix 14 sec ago`), because a flagged observation beats a lost one. If location
is denied entirely, marks still save with null coordinates.

GPS works without cellular service, but fixes may take longer or be less accurate under
heavy tree cover, steep terrain, or limited sky view. WindMark records GPS accuracy and
fix age with every observation. There is no network-assisted location, no map download,
and no external location service — `watchPosition` with high accuracy, and nothing
else.

---

## Data

`localStorage`, on the phone, no server, no account, no sync. Writes are synchronous
and complete **before** the SAVED confirmation is drawn. A failed write shows a red
NOT SAVED screen instead of a confirmation.

### Folders, searches, observations

One optional level of organisation, and one only:

```
Handler Training
  ├── Bear Creek 8/17        37 obs
  └── North Table 8/24       12 obs
Missions
  └── Mission 2026-014        5 obs
UNFILED
  └── Search 1                0 obs
```

No nesting, no tags, no colours, no favourites. A search belongs to zero or one folder;
searches with none appear under **UNFILED**, which is a normal state, not an error.

A search stores `folder_id`, never a folder name:

```json
{ "id": "folder-uuid", "name": "Handler Training", "created": "2026-08-17T09:00:00-06:00" }
{ "id": "search-uuid", "name": "Bear Creek 8/17", "folder_id": "folder-uuid",
  "started": "2026-08-17T09:12:00-06:00" }
```

So renaming a folder, renaming a search, or moving a search between folders rewrites one
field on one record and touches **no observation**. Names are resolved from IDs wherever
they are shown or exported.

Searches written before folders existed have no `folder_id` at all; they read as unfiled
and nothing is rewritten on disk for them. There is also no "ended" state — creating or
switching a search is enough — and an `ended` field in older data is ignored.

The SEARCHES screen lists the groups with a search count and an observation count per
row, and that is all a row carries. Tapping a search opens its own screen for USE,
RENAME, the folder picker, CLEAR OBSERVATIONS, and DELETE; tapping FOLDER on a group
heading opens RENAME FOLDER and DELETE FOLDER. Keeping those controls one tap deeper is
what stops the list turning into a control panel. Creating a search asks for a name and
then lands on that screen, where a folder is one more tap — never required.

### Destructive actions take two confirmations

Every one of them, and the first always names what is at stake:

```
Clear all 37 observations from "Bear Creek 8/17"?      Delete "Bear Creek 8/17" and its 37 observations?
The search itself will remain.

This cannot be undone.                                 This permanently deletes the search and all
Really clear 37 observations?                          37 observations. Really delete?
```

**CLEAR OBSERVATIONS** empties a search and keeps the search, its name, and its folder,
so it can be reused immediately. It is not offered at all when the search is already
empty. **DELETE SEARCH** takes the search and its observations, and nothing else — and
the app always ends up on a valid active search afterwards, falling back to another or
creating a fresh one.

A folder holding searches **cannot** be deleted:

```
This folder contains 4 searches.
Move or delete those searches before deleting the folder.
```

That is deliberately more annoying than a cascading delete, and much harder to lose a
day's work to. An empty folder still takes two confirmations. The exact wording lives in
`Store.clearPrompts` / `deleteSearchPrompts` / `deleteFolderPrompts` / 
`folderNotEmptyMessage`, so no caller can invent a vaguer version of the question.

### The bearing / intensity invariant

Enforced in `Store.validateObservation`, which both `addObservation` and
`updateObservation` run before writing, so no path — capture or correction — can
persist a contradiction:

* `intensity: "none"` → `downwind_true`, `from_true`, `heading_magnetic_raw`,
  `bearing_source`, `bearing_input_ref` all null and `declination_applied` false
* `calm` / `light` / `moderate` / `strong` → must carry a valid bearing, with
  `from_true` the reciprocal of `downwind_true`

In the UI that means: switching an observation to no discernible wind clears its
direction and provenance in one write; switching a no-discernible-wind observation to a
directional intensity asks for a bearing first and applies both together; and CORRECT
BEARING does not exist on a no-discernible-wind observation.

### Schema (`schema_version: 1`)

```json
{
  "schema_version": 1,
  "id": "uuid",
  "session_id": "uuid",
  "session_name": "Drainage sweep",
  "t": "2026-08-16T20:32:05-06:00",
  "lat": 39.8,
  "lon": -105.2,
  "acc_m": 6,
  "gps_fix_t": "2026-08-16T20:32:04-06:00",
  "gps_fix_age_s": 1.2,
  "downwind_true": 105,
  "from_true": 285,
  "heading_magnetic_raw": 97,
  "declination": 8,
  "declination_applied": true,
  "bearing_source": "sensor",
  "bearing_input_ref": "magnetic",
  "intensity": "moderate",
  "speed_mph": null,
  "speed_source": "estimated",
  "gusty": false,
  "note": "",
  "app_version": "1.6.1"
}
```

* `intensity`: `none` | `calm` | `light` | `moderate` | `strong`
* `bearing_source`: `sensor` | `manual` | `null`
* `bearing_input_ref`: `magnetic` | `true` | `null` — what the reading was before correction
* `speed_source`: `estimated` | `measured`
* `heading_magnetic_raw` is provenance only, and is `null` when the reading was already
  true-referenced — the app does not invent a magnetic value it never saw. Authoritative
  direction is always `downwind_true` / `from_true`.

**A categorical intensity never produces a numeric speed.** `speed_mph` stays `null`
with `speed_source: "estimated"` unless a real anemometer reading is typed in, which
sets `speed_source: "measured"`. The two coexist: a measured number does not erase the
qualitative category. Records written before v1.4.3 used `"kestrel"` for the same
thing; they are rewritten to `"measured"` once, on first launch of a newer version, so
an export never carries two spellings of one concept.

**No discernible wind** stores no direction at all:

```json
{ "intensity": "none", "downwind_true": null, "from_true": null,
  "heading_magnetic_raw": null, "bearing_source": null, "speed_mph": null }
```

The phone heading at that moment is deliberately discarded — it did not represent wind.

### Review and correction

The list is one line per observation, newest first:

```
20:43   From 284°T             MODERATE G 7.8mph   ±7m
20:49   From 301°T             CALM                ±5m
20:57   No discernible wind    —                   ±8m
21:04   From 318°T             STRONG              ±6m
```

Tap a row for every stored field, plus correction of intensity, bearing, gusty, and
measured speed, a free-text note, and delete (confirmed). Correcting an entry to
"no discernible wind" clears its direction fields.

### CSV export

Two files, deliberately different in kind.

`folder_name` and `search_name` in both exports are the **current** names, resolved
from `session_id` at export time, so renaming a folder or a search — or moving a search
— shows up in the next export without rewriting a single stored observation. An unfiled
search exports an empty `folder_name`. The name captured with the observation stays in
the record, is used only if its search no longer exists, and appears in the provenance
file as `search_name_at_capture`.

**Standard (operational)** — `CSV` on the list screen, or Settings for all searches.
Wind direction appears **only in true degrees**, in columns that say so:

```
schema_version,id,session_id,folder_name,search_name,t,lat,lon,acc_m,gps_fix_t,gps_fix_age_s,
wind_from_deg_true,wind_toward_deg_true,bearing_source,intensity,speed_mph,
speed_source,gusty,note,app_version
```

No magnetic bearing appears in this file. A magnetic column sitting next to a true one
in a spreadsheet is how a log gets misread, and nothing downstream should have to ask
which north a column meant.

**Provenance** — `PROVENANCE CSV (ALL, WITH RAW °M)` in Settings. Same columns plus
`search_name_at_capture`, `raw_input_deg_magnetic`, `input_reference`,
`declination_deg_east`, and `declination_applied`, for debugging and audit. The filename is suffixed
`-provenance` so the two cannot be confused.

Both use Web Share with a file attachment where supported — on iPhone that is Save to
Files / Mail / AirDrop, and it works with no connectivity — and fall back to a normal
file download.

GPX and GeoJSON are not in this build. When they are added they must be derived from
`Store.OPERATIONAL_FIELDS` — true-referenced wind bearings only, labelled as such —
never from the raw record. Wind arrows, map overlay, and CalTopo integration are
likewise deliberately out of scope here.

---

## CalTopo export (Phase 2A — geometry not yet validated on a map)

`CALTOPO (.JSON)` on a search's screen, and in Settings for the active search, writes a
GeoJSON FeatureCollection of wind arrows for import into the CalTopo mobile app over an
existing search track. Built entirely on the phone from stored observations: no server,
no account, no CalTopo API, no network call, no library. It works in airplane mode and
uses the same share sheet the CSV exports use.

> **Not validated yet.** These arrows have not been imported into the CalTopo iPhone app
> and looked at. The maths and the conventions are covered by tests; whether CalTopo
> renders them the way a handler expects is an open question until someone imports a real
> file and sees it.

### Direction

The arrow points **`downwind_true`** — the way the wind, and therefore scent, is
travelling — with its **tail on the observation's GPS position**. A wind *from* 285°T
draws an arrow pointing 105°T. `from_true` appears in the title and description because
that is how people speak and write it, but it is never the direction of the geometry.

### Geometry

One observation is one map object: a single LineString that doubles back on itself so
CalTopo shows one shape, not three.

```
positions: [tail, tip, left barb, tip, right barb]

tail ──────────────▶ tip
                     ├── barb at (downwind + 180 − 30)°
                     └── barb at (downwind + 180 + 30)°
```

Every point is a geodesic destination — great-circle bearing and distance on a sphere of
radius 6 371 008.8 m — not a flat offset, so longitude scales correctly with latitude
(20 m due east spans 0.0002343° of longitude at 39.9°N, not the 0.00018° a fixed
metres-per-degree constant would give — a 4.6 m error, a quarter of the arrow) and the
0/360 seam is a non-event. Coordinates carry seven decimals, about 1 cm: six (~0.1 m)
would be over 1% of an 8 m glyph and would swing a 2.2 m barb by up to 1.5°.

Barbs are measured back from the tip along the reversed shaft, so they are always behind
it — 28% of the shaft at ±30°, unchanged for this test. Everything tunable sits in
`CalTopo.ARROW`: `head_fraction`, `head_angle_deg`, the stroke colour, coordinate
precision, and the lengths below.

### Symbolic lengths

| Intensity | Arrow |
|---|---|
| Calm | 8 m |
| Light | 12 m |
| Moderate | 16 m |
| Strong | 20 m |

Compact map glyphs, not geographic vectors. An individual SAR search area runs roughly
20–150 acres and is often nearer the small end — 20 acres is about 285 m on a side — with
several areas and many observations on screen at once, so an arrow has to read as a
symbol pinned to a point rather than a distance across the area. Even the longest arrow,
head included, spans about 24 m. **These are first-rendering values and may well change
after the first real CalTopo import.**

**Visual encoding only.** Not scent travel distance, not plume length, not dog detection
range, not duration, not wind speed. A measured wind speed, when present, is metadata in
the description and does not change the geometry by a metre — verified by a test that
compares the geometry of the same observation with and without one.

### Features and properties

Directional observations are `LineString` features:

```json
{
  "title": "14:32 Light — from 285°T",
  "description": "Wind from: 285°T\nWind toward: 105°T\nIntensity: Light\n…",
  "stroke": "#4a90e2",
  "stroke-width": 3,
  "stroke-opacity": 1,
  "pattern": "solid"
}
```

One colour for every arrow — intensity is already encoded by length. No-discernible-wind
observations are `Point` features with `marker-color` / `marker-symbol` / `marker-size`
and the title `14:45 No discernible wind`: no bearing is invented, no zero-degree arrow is
drawn, and no previous heading is reused. Properties are limited to simplestyle names
CalTopo is known to read; nothing undocumented is invented, and the file has no foreign
members beyond `type` and `features`. Automatic placement into a CalTopo folder is
deliberately not attempted in this pass.

The description carries `Wind from`, `Wind toward`, `Intensity`, and — when present —
`Measured wind speed`, `Gusty`, `Observed`, `GPS accuracy`, `Search`, `Folder`, and
`Observation ID`. Absent fields are omitted rather than shown empty, and no magnetic
bearing appears: what reaches the map is true-referenced throughout.

### Files and coverage

`WindMark_<folder>_<search>_<YYYY-MM-DD>.json`, with anything awkward in a filename
reduced to a hyphen and the folder omitted when the search is unfiled. Folder and search
names are resolved at export time, so a rename shows up in the next file without touching
a stored observation.

An observation without valid finite coordinates gets no geometry: it is not fabricated,
not parked at 0,0, and not silently dropped — it is left out and the handler is told how
many could not be mapped. The CSV exports still contain everything.

---

## Offline / install

A search happens with no cell service, no Wi-Fi, and often in airplane mode. Service
worker + manifest, strictly cache-first, no runtime network dependency of any kind. All
assets are local; there are no CDNs, fonts, frameworks, or analytics.

Serve the folder over HTTPS (GitHub Pages works: Settings → Pages → deploy from the
branch, root folder), open it in Safari, then **Share → Add to Home Screen**. Launch it
once with a connection so the service worker caches everything; after that it cold
starts in airplane mode.

### OFFLINE READY

Settings and the SENSOR PROOF screen both show, and the START screen carries a compact
line:

```
OFFLINE READY ✓
WindMark v1.6.1 cached locally
```

or

```
OFFLINE NOT READY
Connect once before deployment
```

with a third line saying exactly what is missing. This is deliberately **not**
`navigator.onLine`, which only reports whether a network interface is up. Ready means
all four of:

1. the browser has Cache Storage and service workers,
2. a cache named `windmark-v<this version>` exists,
3. every file in `WM_ASSETS` is actually in it, and
4. a service worker is controlling the page right now.

`js/assets.js` holds the version and the file list, and is loaded by both the page and
the service worker (`importScripts`), so the check and the cache can never disagree
about what "cached" means. Because the cache name carries the version, a half-installed
update cannot masquerade as ready: v1.5.0 asks for the v1.5.0 cache and gets `NOT READY`
until that cache is complete, while v1.6.1 keeps working from its own.

### PRE-SEARCH CHECK

Under the readiness box, in Settings and on SENSOR PROOF:

```
PRE-SEARCH CHECK
✓ Offline ready            app cached locally
✓ Storage available        observations will persist on this phone
✓ GPS available            waiting for first fix — normal indoors
✓ Compass available        sensor heading usable
```

Informational only — it is not a wizard and nothing here blocks a capture. Waiting for a
first fix indoors counts as available; only a denied or absent geolocation warns. A
compass that is not ready reads `COMPASS NOT READY — manual bearing remains available`,
because a hand compass and manual entry still do the job.

### Updating

Each version installs into its own cache, and `cache.addAll` is atomic, so a failed
install leaves nothing behind and never touches the cache the phone is running from. If
a failed install had created an empty cache, it is deleted — but only if that install
created it, never one that was already there.

There is no `skipWaiting`: an update waits until WindMark is fully closed, so a running
search cannot have its assets swapped out mid-log. **Close the app completely and reopen
it, connected, to finish an update**, then confirm OFFLINE READY shows the new version.
Old caches are deleted on activation, after the new one is complete.

Cached responses are served as-is and never refreshed in the background — silently
pulling a newer file into an older version's cache would mix versions on a phone that is
about to go offline.

Bump `WM_VERSION` in `js/assets.js` whenever a cached file changes.

> iOS note: keep the app installed to the Home Screen and export CSV regularly. Data
> lives in this phone's browser storage; uninstalling the PWA or clearing Safari data
> deletes it. There is no cloud copy by design. WindMark asks for persistent storage
> once via `navigator.storage.persist()` where it exists (Chrome grants it silently to
> installed PWAs; Safari does not implement it), and shows the result in Settings.
> Nothing depends on the answer.

### Offline field test — run this before trusting WindMark on a search

Not passed until performed on the actual iPhone.

1. Connect the iPhone to the internet.
2. Open the deployed WindMark version.
3. Add WindMark to the Home Screen.
4. Launch the installed PWA once while connected.
5. Confirm **OFFLINE READY**.
6. Close WindMark completely.
7. Enable Airplane Mode.
8. Confirm Wi-Fi is also off.
9. Launch WindMark from the Home Screen.
10. Confirm the app cold-starts normally.
11. Go outside and wait for a GPS fix.
12. Confirm coordinates, accuracy, and fix age update.
13. Make at least:
    * one No discernible wind observation
    * one manual Magnetic observation
    * one manual True observation
    * several phone-sensor observations
14. Close the app completely.
15. Reopen it while still in Airplane Mode.
16. Verify all observations remain.
17. Export the operational CSV to Files.
18. Open the CSV and verify:
    * timestamps
    * coordinates
    * accuracy
    * True wind direction
    * intensity
    * no magnetic directional column in the operational export
19. Repeat several heading comparisons with the compass, including around north.

---

## Colours

Royal blue `#1b4e9b`, red `#d32027`, white. The ground stays black — a field instrument
has to hold up in direct sun without blinding anyone at night, and black is the cheapest
thing to put on an OLED during a long search.

Blue fills primary actions (MARK WIND, START, USE THIS BEARING) with white text and a
white border, and a lifted `#4a90e2` carries "good" states — GPS OK, compass OK, SAVED,
offline ready, a passing pre-search row. Red carries the other direction: a warning is
red text, a failure is white on a red field (NOT SAVED), so severity reads without
relying on hue alone.

No organisation name, logo, or wordmark appears anywhere in the app. It is a plain
instrument, usable by any handler on any team.

Every colour is a variable at the top of `css/windmark.css`. MARK WIND's fill is its own
variable, `--action`: if the blue proves too dark against snow glare during the field
test, change that one line.

---

## Files

```
index.html                all screens
css/windmark.css          dark, high-contrast, ≥64 px targets
js/assets.js              version + cached file list, shared by the page and the worker
js/util.js                bearings, circular mean, declination rule, time formatting
js/store.js               localStorage, sessions, schema, CSV
js/sensors.js             compass + GPS, heavily commented orientation math
js/offline.js             offline-readiness verdict and the pre-search check
js/caltopo.js             CalTopo/GeoJSON wind arrows — geodesic geometry, no map
js/app.js                 capture flow and UI
sw.js                     offline cache
manifest.webmanifest      PWA manifest
icons/                    PNG icons
tools/selfcheck.js        node tools/selfcheck.js — logic checks, no dependencies
tools/browsercheck.js     optional UI regression pass (needs Playwright; see its header)
tools/offlinecheck.js     optional offline / service-worker pass (needs Playwright)
tools/make_icons.py       regenerates the icons
```

No build step, no bundler, no npm, no framework, no backend. Edit a file, reload.

`node tools/selfcheck.js` verifies wraparound, circular averaging, the declination
rule, the downwind/from convention, the Euler-to-heading math, bearing labelling, the
source-specific sensor reference, the compass authority rule, the bearing/intensity
invariant across edits, manual-entry range rejection, wording, the true-only export
rule, the offline-readiness verdict, the pre-search states, the speed-source rename and
its migration, the folder/search organisation with its destructive-prompt wording, the
CalTopo arrow geometry across seven bearings and all four symbolic lengths including the
north seam, and that the cached asset list matches both what the page loads and what is
on disk (640 checks). It drives the
compass with synthetic orientation events through the real listeners.

Two optional Playwright harnesses cover what needs a real browser:
`tools/browsercheck.js` (172 checks — screen flow, edit transitions, input rejection,
one-viewport layout, the organisational UI including refused confirmations, and a real
CalTopo file downloaded from the real button) and `tools/offlinecheck.js` (38 checks —
real Cache Storage, offline cold start, CalTopo generation with the network down, a
deliberately broken update, third-party request tracking). Neither can verify the
physical sensor — that still requires the walk outside with a compass.

---

## Acceptance checklist

Software-verifiable, checked in a Chromium harness with faked sensors:

- [x] Installed PWA cold-launches offline (service worker serves the shell with the
      network disabled)
- [x] OFFLINE READY reflects the current version's complete cache, not `navigator.onLine`
- [x] An incomplete or foreign-version cache reads as OFFLINE NOT READY
- [x] A failed update leaves the previously working offline version intact
- [x] No request to any third-party origin
- [x] Five observations captured entirely offline
- [x] Reload/reopen loses nothing
- [x] GPS accuracy and fix age stored (`acc_m`, `gps_fix_t`, `gps_fix_age_s`)
- [x] 0°/360° wraparound correct, including 358/359/0/1/2 through the full capture path
- [x] Manual magnetic bearing produces the correct true bearing
- [x] Manual true bearing is not declination-corrected twice
- [x] "No discernible wind" stores no directional bearing
- [x] "Calm" stores a directional bearing
- [x] Estimated intensity never fabricates a numeric mph
- [x] A measured speed is distinguishable from an estimate (`speed_source`)
- [x] iOS `webkitCompassHeading` is treated as magnetic and cannot be reconfigured
- [x] A sensor bearing is authoritative only when compass status is `ok`
- [x] Relative-only orientation is never usable
- [x] No discernible wind saves with no bearing; directional intensities cannot
- [x] Edits cannot create a contradictory bearing/intensity state
- [x] Manual 999 is rejected, 360 normalises to 000
- [x] Renaming a search changes the next export
- [x] Every bearing in the UI carries °M or °T; no bare bearing numbers
- [x] Manual entry selects M or T per reading and remembers the last choice
- [x] Standard CSV exposes wind direction only as `wind_from_deg_true` /
      `wind_toward_deg_true`, with no magnetic column
- [x] Provenance CSV carries the raw °M reading, its reference, and the declination
- [x] CSV export works offline

Requires the phone, outdoors:

- [ ] **A CalTopo file imported into the CalTopo iPhone app and looked at** — arrows
      pointing the way the wind was blowing, lengths distinguishable, titles readable in
      the map-object list, no-wind points visible, and the whole thing legible over a
      real search track

- [ ] Sensor bearing agrees with the compass to ~±10° after declination, on multiple
      headings including around north
- [ ] Whether the phone's reported heading is magnetic or true (set in Settings)
- [ ] Workflow comfortably usable one-handed, gloved, in bright sun
- [ ] Installed PWA cold-launch in airplane mode on the actual iPhone
