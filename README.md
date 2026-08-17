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

Two taps. Optional extras (GUSTY toggle, Kestrel mph) sit above the intensity buttons
and are set before the intensity tap that commits.

Nothing is ever auto-captured. Nothing is saved without an intensity tap.

---

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

Two independent reference settings exist, because they are two different questions:

* **Manual compass readings — MAGNETIC / TRUE.** If your Silva is set with a
  declination scale, choose TRUE and no correction is applied. Choose MAGNETIC and the
  configured declination is added. A true reading is never corrected twice.
* **Phone sensor heading is — MAGNETIC / TRUE.** Browsers do not document which north
  they report. The default assumption is MAGNETIC (declination applied). Settle it
  with the SENSOR PROOF screen and a real compass before trusting a log — see below.

Every observation stores the declination in effect, whether it was applied
(`declination_applied`), the bearing source, and what the reading was entered as, so
any log can be audited after the fact.

---

## Phase 0 — sensor proof (do this first, outside, with the Silva)

`SENSORS` on the capture screen opens the diagnostic page: GPS coordinates, accuracy,
fix age, raw alpha/beta/gamma, the `absolute` flag, raw heading, smoothed heading,
sample consistency, compass accuracy where reported, tilt warning, screen orientation,
active declination, computed true heading, storage and service-worker state.

**Protocol**

1. Stand clear of vehicles, power lines, and steel.
2. Hold the phone flat, top edge pointed along a Silva sighting.
3. Compare `TRUE heading` against the Silva (corrected for declination) on at least
   eight headings spread around the circle.
4. Explicitly test around north: **358°, 359°, 0°, 1°, 2°**. The reading must move
   smoothly through the seam and never show 180° of error.
5. Agreement should be within about **±10°**.

If the phone reads consistently high by roughly the declination, the browser was
already giving true north — switch *Phone sensor heading is* to TRUE in Settings and
repeat. If it disagrees wildly or wanders, use bearing by hand; the app never hides
this.

Heading smoothing is a **circular (vector) mean over the last 500 ms**. Bearings are
never averaged arithmetically — `(359 + 1) / 2 = 180` is exactly backwards.

The heading is that of the **top edge of the phone**, computed from the full
orientation matrix, so it is unaffected by roll and by moderate tilt. If the top edge
gets within ~25° of vertical the horizontal direction is meaningless and the app says
"hold the phone flatter" rather than showing a confident wrong number.

---

## When the compass will not cooperate

Every sensor failure produces a visible explanation and a fallback:

* orientation permission denied → explained, with **ENTER BEARING BY HAND**
* no orientation events at all → "No compass data from this device"
* relative-only orientation (no true compass) → refused as a bearing source; it is
  never written to a log
* events stopped → "Compass stopped sending data"
* uncalibrated / poor accuracy → shown with the reported accuracy
* top edge near vertical → "Hold the phone flatter"

`ENTER BEARING BY HAND` is always on the capture screen, and pressing MARK WIND with no
usable heading goes straight to it. Entry is a large number field with −10/−1/+1/+10
buttons and a live preview of the resulting true and "from" bearings.

GPS never blocks a capture. A poor or stale fix is displayed and stored
(`±24 m · fix 14 sec ago`), because a flagged observation beats a lost one. If location
is denied entirely, marks still save with null coordinates.

---

## Data

`localStorage`, on the phone, no server, no account, no sync. Writes are synchronous
and complete **before** the SAVED confirmation is drawn. A failed write shows a red
NOT SAVED screen instead of a confirmation.

Observations are grouped into **searches** (sessions) so separate operations do not
mix: New / Rename / End / Delete, with confirmation on anything destructive.

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
  "app_version": "1.0.0"
}
```

* `intensity`: `none` | `calm` | `light` | `moderate` | `strong`
* `bearing_source`: `sensor` | `manual` | `null`
* `bearing_input_ref`: `magnetic` | `true` | `null` — what the reading was before correction
* `speed_source`: `estimated` | `kestrel`
* `heading_magnetic_raw` is `null` when the reading was already true-referenced —
  the app does not invent a magnetic value it never saw.

**A categorical intensity never produces a numeric speed.** `speed_mph` stays `null`
with `speed_source: "estimated"` unless an actual Kestrel reading is typed in, which
sets `speed_source: "kestrel"`. The two coexist: a Kestrel number does not erase the
qualitative category.

**No discernible wind** stores no direction at all:

```json
{ "intensity": "none", "downwind_true": null, "from_true": null,
  "heading_magnetic_raw": null, "bearing_source": null, "speed_mph": null }
```

The phone heading at that moment is deliberately discarded — it did not represent wind.

### Review and correction

The list is one line per observation, newest first:

```
20:43   From 284°T   MODERATE G 7.8mph   ±7m
20:49   From 301°T   CALM                ±5m
20:57   No wind      —                   ±8m
21:04   From 318°T   STRONG              ±6m
```

Tap a row for every stored field, plus correction of intensity, bearing, gusty, and
Kestrel speed, a free-text note, and delete (confirmed). Correcting an entry to
"no discernible wind" clears its direction fields.

### CSV export

`CSV` on the list screen (or Settings, for all searches) exports every stored field,
unmodified, one row per observation. It uses Web Share with a file attachment where
supported — on iPhone that is Save to Files / Mail / AirDrop, and it works with no
connectivity — and falls back to a normal file download.

GPX, wind arrows, map overlay, and CalTopo integration are deliberately **not** in this
build.

---

## Offline / install

Service worker + manifest, cache-first, no runtime network dependency of any kind. All
assets are local; there are no CDNs, fonts, frameworks, or analytics.

Serve the folder over HTTPS (GitHub Pages works: Settings → Pages → deploy from the
branch, root folder), open it in Safari, then **Share → Add to Home Screen**. Launch it
once with a connection so the service worker caches everything; after that it cold
starts in airplane mode.

Bump `CACHE_NAME` in `sw.js` whenever a cached file changes, or installed phones will
keep serving the old copy.

> iOS note: keep the app installed to the Home Screen and export CSV regularly. Data
> lives in this phone's browser storage; uninstalling the PWA or clearing Safari data
> deletes it. There is no cloud copy by design.

---

## Files

```
index.html                all screens
css/windmark.css          dark, high-contrast, ≥64 px targets
js/util.js                bearings, circular mean, declination rule, time formatting
js/store.js               localStorage, sessions, schema, CSV
js/sensors.js             compass + GPS, heavily commented orientation math
js/app.js                 capture flow and UI
sw.js                     offline cache
manifest.webmanifest      PWA manifest
icons/                    PNG icons
tools/selfcheck.js        node tools/selfcheck.js — bearing math checks, no dependencies
tools/make_icons.py       regenerates the icons
```

No build step, no bundler, no npm, no framework, no backend. Edit a file, reload.

`node tools/selfcheck.js` verifies wraparound, circular averaging, the declination
rule, the downwind/from convention, and the Euler-to-heading math (43 checks). It
cannot verify the physical sensor — that still requires the walk outside with the Silva.

---

## Acceptance checklist

Software-verifiable, checked in a Chromium harness with faked sensors:

- [x] Installed PWA cold-launches offline (service worker serves the shell with the
      network disabled)
- [x] Five observations captured entirely offline
- [x] Reload/reopen loses nothing
- [x] GPS accuracy and fix age stored (`acc_m`, `gps_fix_t`, `gps_fix_age_s`)
- [x] 0°/360° wraparound correct, including 358/359/0/1/2 through the full capture path
- [x] Manual magnetic bearing produces the correct true bearing
- [x] Manual true bearing is not declination-corrected twice
- [x] "No discernible wind" stores no directional bearing
- [x] "Calm" stores a directional bearing
- [x] Estimated intensity never fabricates a numeric mph
- [x] Kestrel speed is distinguishable from an estimate (`speed_source`)
- [x] CSV export works offline and contains every stored field

Requires the phone, outdoors:

- [ ] Sensor bearing agrees with the Silva to ~±10° after declination, on multiple
      headings including around north
- [ ] Whether the phone's reported heading is magnetic or true (set in Settings)
- [ ] Workflow comfortably usable one-handed, gloved, in bright sun
- [ ] Installed PWA cold-launch in airplane mode on the actual iPhone
