/* WindMark — CalTopo / GeoJSON export.

   One job: turn stored observations into geographic wind arrows that can be
   imported into the CalTopo mobile app and laid over an existing search
   track. Everything here is local and offline — no network, no API, no
   library, no map.

   ======================================================================
   THE ONE CONVENTION THAT MUST NOT BE REVERSED
   ======================================================================

   downwind_true is the true bearing the wind — and therefore scent — is
   travelling TOWARD. The arrow on the map points that way, and its TIP is
   the observation's GPS position:

       observation GPS = TIP of the arrow
       arrow direction = downwind_true
       tail            = one shaft length UPWIND of the observation

   from_true (the meteorological "wind from" bearing) is what people say and
   write, so it appears in the title and description, but it is NEVER the
   direction of the geometry. A wind from 285°T draws an arrow pointing
   105°T.

   Why the tip and not the tail: the dog and handler were physically at the
   recorded coordinate, and the terrain that could have supplied scent to the
   dog there lies upwind of it. Hanging the glyph off the upwind side keeps
   it on the side of the track that matters when the log is read back, and
   stops it projecting downwind past where the team actually was. The glyph
   is still a symbol, not a scent cone and not a claim about how far the
   team searched.

   ======================================================================
   ARROW GEOMETRY
   ======================================================================

   One observation is one map object: a single LineString that doubles back
   on itself to draw the head, so CalTopo shows one shape per observation
   rather than three.

       tail ──────────────▶ tip = [RECORDED GPS]
       (upwind)             ├── back-left barb
                            └── back-right barb

       positions: [tail, tip, left, tip, right]

   The recorded coordinate is used exactly as stored for the tip. Every other
   point is derived from it, never the other way round.

   Every point is computed as a geodesic destination — great-circle bearing
   and distance on a sphere — not as a flat offset. At these distances the
   sphere is exact to well under a metre, and it gets the longitude scaling
   right at any latitude, which a fixed metres-per-degree constant does not.

   ======================================================================
   SYMBOLIC LENGTHS — READ THIS BEFORE CHANGING THEM
   ======================================================================

   Arrows are map glyphs — tens of metres — because a single SAR search area
   is small and crowded with observations. Arrow length encodes the
   qualitative intensity category and nothing else.
   It is NOT scent travel distance, plume length, dog detection range,
   duration, or wind speed. A measured wind speed, when present, is metadata
   in the description and does not change the geometry by so much as a metre.

   Everything tunable after the first real CalTopo import is in ARROW below. */

var CalTopo = (function () {

  /* ---------- tunables ---------------------------------------------------
     Change these after seeing real arrows on a real map, and nothing else. */
  var ARROW = {
    // Symbolic map length per intensity, in metres. Visual encoding only.
    //
    // These are directional glyphs, not geographic vectors. An individual SAR
    // search area is roughly 20-150 acres and often nearer the small end — a
    // 150-acre square is only about 780 m on a side — with several areas and
    // many observations on screen at once, so an arrow has to read as a symbol
    // pinned to a point rather than a distance across the area.
    //
    // Second pass. The first CalTopo import worked and the convention read
    // correctly, but the arrows were too subtle and the categories too close
    // together to tell apart. These are longer, and the steps between them
    // widen as intensity rises (8, 10, 12 m) so the four categories separate
    // at a glance instead of scaling evenly.
    length_m: {
      calm: 12,
      light: 20,
      moderate: 30,
      strong: 42
    },
    head_fraction: 0.28,      // barb length as a fraction of the shaft (25–30%)
    head_angle_deg: 30,       // barb angle either side of the reversed shaft
    stroke: '#4a90e2',        // one colour for every arrow — intensity is length
    stroke_width: 3,
    stroke_opacity: 1,
    pattern: 'solid',
    marker_color: '#4a90e2',  // no-discernible-wind point
    marker_symbol: 'circle',
    marker_size: 'medium',
    // ~1 cm. Six decimals (~0.1 m) would be 3% of the 3.4 m barb on the
    // shortest glyph and would swing its angle by about a degree. Seven keeps
    // the arrowhead shape honest at this scale and costs one character per
    // coordinate.
    coord_decimals: 7
  };

  var EARTH_R = 6371008.8;    // IUGG mean radius, metres

  function rad(d) { return d * Math.PI / 180; }
  function deg(r) { return r * 180 / Math.PI; }

  /* Longitude into [-180, 180] so a shape near the antimeridian stays valid. */
  function normLon(lon) {
    return ((lon + 540) % 360) - 180;
  }

  function roundCoord(v) {
    var f = Math.pow(10, ARROW.coord_decimals);
    return Math.round(v * f) / f;
  }

  /* Geodesic destination: from [lat, lon], travel distanceM along a true
     bearing. Returns a GeoJSON position, [lon, lat].
     Standard great-circle direct solution — the same formula a handheld GPS
     uses for a projected waypoint. */
  function destination(lat, lon, bearingDeg, distanceM) {
    var d = distanceM / EARTH_R;
    var br = rad(bearingDeg);
    var p1 = rad(lat);
    var l1 = rad(lon);

    var sinP2 = Math.sin(p1) * Math.cos(d) + Math.cos(p1) * Math.sin(d) * Math.cos(br);
    var p2 = Math.asin(sinP2);
    var y = Math.sin(br) * Math.sin(d) * Math.cos(p1);
    var x = Math.cos(d) - Math.sin(p1) * sinP2;
    var l2 = l1 + Math.atan2(y, x);

    return [roundCoord(normLon(deg(l2))), roundCoord(deg(p2))];
  }

  /* Inverse of destination, for tests and for anything that needs to check
     what was drawn. Both take GeoJSON positions, [lon, lat]. */
  function distanceM(a, b) {
    var p1 = rad(a[1]), p2 = rad(b[1]);
    var dp = p2 - p1;
    var dl = rad(b[0] - a[0]);
    var h = Math.sin(dp / 2) * Math.sin(dp / 2) +
            Math.cos(p1) * Math.cos(p2) * Math.sin(dl / 2) * Math.sin(dl / 2);
    return 2 * EARTH_R * Math.asin(Math.min(1, Math.sqrt(h)));
  }

  function bearingDeg(a, b) {
    var p1 = rad(a[1]), p2 = rad(b[1]);
    var dl = rad(b[0] - a[0]);
    var y = Math.sin(dl) * Math.cos(p2);
    var x = Math.cos(p1) * Math.sin(p2) - Math.sin(p1) * Math.cos(p2) * Math.cos(dl);
    var d = deg(Math.atan2(y, x));
    return (d + 360) % 360;
  }

  function lengthFor(intensity) {
    return ARROW.length_m[intensity] || null;
  }

  /* The five positions of one arrow. lat/lon are the observation's fix —
     which IS the tip — and downwindTrue is the direction the wind is blowing
     toward. Tail and barbs are all measured upwind from the fix, so nothing
     the glyph draws lies downwind of where the team actually stood. */
  function arrowPositions(lat, lon, downwindTrue, lengthMetres) {
    var tip = [roundCoord(normLon(lon)), roundCoord(lat)];

    var back = (downwindTrue + 180) % 360;      // upwind
    var tail = destination(lat, lon, back, lengthMetres);

    // Barbs splay from the same point, head_angle_deg either side of the
    // upwind direction, and are shorter than the shaft.
    var headLen = lengthMetres * ARROW.head_fraction;
    var left = destination(lat, lon, (back - ARROW.head_angle_deg + 360) % 360, headLen);
    var right = destination(lat, lon, (back + ARROW.head_angle_deg) % 360, headLen);

    return [tail, tip, left, tip, right];
  }

  /* ---------- text ------------------------------------------------------- */

  var INTENSITY_WORD = {
    none: 'No discernible wind',
    calm: 'Calm',
    light: 'Light',
    moderate: 'Moderate',
    strong: 'Strong'
  };

  /* Local clock time as it was recorded, straight out of the stored ISO
     string — no timezone re-interpretation on the way to the map. */
  function timeOf(o) {
    return (typeof o.t === 'string' && o.t.length >= 16) ? o.t.slice(11, 16) : '--:--';
  }

  function deg3(v) {
    var n = Math.round(((v % 360) + 360) % 360) % 360;
    return ('00' + n).slice(-3);
  }

  function titleFor(o) {
    var word = INTENSITY_WORD[o.intensity] || o.intensity;
    if (o.intensity === 'none' || o.from_true === null || o.from_true === undefined) {
      return timeOf(o) + ' No discernible wind';
    }
    return timeOf(o) + ' ' + word + ' — from ' + deg3(o.from_true) + '°T';
  }

  /* Detail lives here rather than in an unreadable title. Optional fields
     are omitted rather than shown empty, and no magnetic bearing appears:
     what reaches the map is true-referenced throughout. */
  function descriptionFor(o, ctx) {
    var lines = [];
    if (o.intensity !== 'none' && o.from_true !== null && o.from_true !== undefined) {
      lines.push('Wind from: ' + deg3(o.from_true) + '°T');
      lines.push('Wind toward: ' + deg3(o.downwind_true) + '°T');
    }
    lines.push('Intensity: ' + (INTENSITY_WORD[o.intensity] || o.intensity));
    if (o.speed_mph !== null && o.speed_mph !== undefined && isFinite(o.speed_mph)) {
      lines.push('Measured wind speed: ' + o.speed_mph + ' mph');
    }
    if (o.gusty) lines.push('Gusty: Yes');
    if (o.t) lines.push('Observed: ' + o.t);
    if (o.acc_m !== null && o.acc_m !== undefined && isFinite(o.acc_m)) {
      lines.push('GPS accuracy: ±' + Math.round(o.acc_m) + ' m');
    }
    if (ctx && ctx.searchName) lines.push('Search: ' + ctx.searchName);
    if (ctx && ctx.folderName) lines.push('Folder: ' + ctx.folderName);
    if (o.id) lines.push('Observation ID: ' + o.id);
    return lines.join('\n');
  }

  /* ---------- features ---------------------------------------------------- */

  function hasFix(o) {
    return typeof o.lat === 'number' && isFinite(o.lat) &&
           typeof o.lon === 'number' && isFinite(o.lon) &&
           o.lat >= -90 && o.lat <= 90 && o.lon >= -180 && o.lon <= 180;
  }

  function isDirectional(o) {
    return o.intensity !== 'none' &&
           typeof o.downwind_true === 'number' && isFinite(o.downwind_true);
  }

  function featureFor(o, ctx) {
    if (!hasFix(o)) return null;              // never invent a coordinate

    if (!isDirectional(o)) {
      // No discernible wind: a point, not a zero-length or invented arrow.
      return {
        type: 'Feature',
        geometry: { type: 'Point', coordinates: [roundCoord(normLon(o.lon)), roundCoord(o.lat)] },
        properties: {
          title: titleFor(o),
          description: descriptionFor(o, ctx),
          'marker-color': ARROW.marker_color,
          'marker-symbol': ARROW.marker_symbol,
          'marker-size': ARROW.marker_size
        }
      };
    }

    var len = lengthFor(o.intensity);
    if (!len) return null;                    // unknown category draws nothing

    return {
      type: 'Feature',
      geometry: {
        type: 'LineString',
        coordinates: arrowPositions(o.lat, o.lon, o.downwind_true, len)
      },
      properties: {
        title: titleFor(o),
        description: descriptionFor(o, ctx),
        stroke: ARROW.stroke,
        'stroke-width': ARROW.stroke_width,
        'stroke-opacity': ARROW.stroke_opacity,
        pattern: ARROW.pattern
      }
    };
  }

  /* Returns {geojson, exported, skipped}. `skipped` counts observations left
     out for having no usable fix — reported to the handler rather than
     silently dropped or parked at 0,0. */
  function build(observations, ctx) {
    var features = [];
    var skipped = 0;
    (observations || []).forEach(function (o) {
      var f = featureFor(o, ctx);
      if (f) features.push(f); else skipped++;
    });
    return {
      geojson: { type: 'FeatureCollection', features: features },
      exported: features.length,
      skipped: skipped
    };
  }

  function toText(observations, ctx) {
    return JSON.stringify(build(observations, ctx).geojson, null, 2);
  }

  /* WindMark_<folder>_<search>_<YYYY-MM-DD>.json, with anything awkward in a
     filename reduced to a hyphen. */
  function filename(ctx, date) {
    function slug(v) {
      return String(v || '').replace(/[^A-Za-z0-9]+/g, '-').replace(/^-+|-+$/g, '').slice(0, 40);
    }
    var d = date || new Date();
    var stamp = d.getFullYear() + '-' +
      ('0' + (d.getMonth() + 1)).slice(-2) + '-' + ('0' + d.getDate()).slice(-2);
    var parts = ['WindMark'];
    var f = slug(ctx && ctx.folderName);
    var s = slug(ctx && ctx.searchName);
    if (f) parts.push(f);
    if (s) parts.push(s);
    parts.push(stamp);
    return parts.join('_') + '.json';
  }

  return {
    ARROW: ARROW,
    destination: destination, distanceM: distanceM, bearingDeg: bearingDeg,
    arrowPositions: arrowPositions, lengthFor: lengthFor,
    titleFor: titleFor, descriptionFor: descriptionFor,
    featureFor: featureFor, build: build, toText: toText, filename: filename
  };
})();
