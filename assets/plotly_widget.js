// SlatePlotly — the widget kind `SlatePlotly.PlotlyFigure`.
//
// Registered through core's low-level `slateRegisterWidget(kind, {wire, sync, destroy})` rather than the
// Preact `registerComponent` adapter, for two reasons the SDK itself names: Plotly OWNS the DOM inside its
// div (a Preact re-render would fight it — the "self-owned-DOM widget" case), and a classic script needs no
// import map, so a single-file export has one less resolution path that can fail.
//
// ONE registration serves both paths, because core wires both from this registry:
//   • a figure RETURNED from a cell  → `slate_render` emits a component descriptor → `wireOutputComponent`
//   • `@bind sel plot_select(fig)`   → a control → `wireControl`
// So a displayed figure and a bound figure run identical code; a bound one additionally pushes values back.
//
// No load queue. Core re-wires already-mounted instances when a kind registers late, which is what the
// queue used to hand-roll; the only thing left to await is the library itself, via one shared promise.
(function () {
  var KIND = 'SlatePlotly.PlotlyFigure';
  if (window.slateWidgets && window.slateWidgets[KIND]) return;   // idempotent across reloads

  // ── The library ─────────────────────────────────────────────────────────────────────────────────
  // `__slatePlotlySrc` is injected by the Julia side: the package's served vendored-asset route live, and
  // a `data:` URL carrying the bytes in a standalone export (rewritten at export time). Nothing here
  // branches on which, so an exported page makes no network request. Keep that URL out of this file's
  // prose — the export rewriter matches the route prefix anywhere in this text, comments included.
  var _libPromise = null;

  // Load a script from a URL, resolving when it has run.
  function _injectSrc(src) {
    return new Promise(function (resolve, reject) {
      var s = document.createElement('script');
      s.src = src;
      s.onload = function () { resolve(); };
      s.onerror = function () { reject(new Error('could not load plotly.js')); };
      document.head.appendChild(s);
    });
  }

  // A standalone export may carry the library GZIPPED — it is by far the biggest thing in the file
  // (4.3 MB of plotly.js becomes 5.8 once base64'd, versus about 1.6 compressed), and this loader is
  // already async, so paying an inflate at startup costs nothing a reader notices. The export marks it
  // with an `application/gzip` mime precisely so this can tell: bytes that need inflating must never be
  // handed to a <script> tag, which would try to execute them.
  //
  // Inflated through the platform's own DecompressionStream, then handed over as a blob URL — no
  // library rides along for it. If that API is missing we say so, rather than failing obscurely.
  function _loadCompressed(src) {
    if (typeof DecompressionStream === 'undefined') {
      return Promise.reject(new Error(
        'this page stores plotly.js gzipped, and this browser has no DecompressionStream to inflate it ' +
        '— re-export with data compression turned off'));
    }
    // Decoded from the URL string, NOT fetched. `fetch()` on a `data:` URL is blocked wherever the
    // document has an opaque origin — which includes `file://`, i.e. the exact case a standalone export
    // exists for. It fails there with a cross-origin error and the library simply never loads.
    var bin = atob(src.slice(src.indexOf(',') + 1));
    var u8 = new Uint8Array(bin.length);
    for (var i = 0; i < bin.length; i++) u8[i] = bin.charCodeAt(i);
    // Inflate to TEXT and run it inline. Neither a `data:` URL nor a `blob:` URL can be relied on here:
    // both are refused when the document's origin is opaque, which is precisely the standalone case
    // (`file://`, and any sandboxed frame). An inline script has no URL to be judged against.
    return new Response(new Blob([u8]).stream().pipeThrough(new DecompressionStream('gzip'))).text()
      .then(function (js) {
        var s = document.createElement('script');
        s.textContent = js;
        document.head.appendChild(s);
      });
  }

  function ensurePlotly() {
    if (window.Plotly) return Promise.resolve(window.Plotly);
    if (_libPromise) return _libPromise;
    var src = String(window.__slatePlotlySrc || '');
    var load = src.indexOf('data:application/gzip') === 0 ? _loadCompressed(src) : _injectSrc(src);
    _libPromise = load.then(function () { return window.Plotly; });
    return _libPromise;
  }

  // ── Theme ───────────────────────────────────────────────────────────────────────────────────────
  // Built from the SAME CSS custom properties the ECharts theme reads (core.js `_slateEchartsThemeFrom`),
  // so a Plotly figure and an echart in one notebook agree on background, text, gridlines and the series
  // colour cycle. Defaults mirror that function's, so a page missing a var degrades identically instead of
  // falling back to Plotly's white-on-white.
  var CYCLE = [['--accent', '#569cd6'], ['--green', '#56d364'], ['--orange', '#ce9178'],
               ['--purple', '#c586c0'], ['--teal', '#4ec9b0'], ['--gold', '#ffd700'],
               ['--red', '#e57575']];

  function themeLayout() {
    var cs = getComputedStyle(document.documentElement);
    var v = function (n, d) { return (cs.getPropertyValue(n) || '').trim() || d; };
    var text = v('--text', '#d4d8e8'), dim = v('--dim', '#6a7090'),
        border = v('--border', '#2a2e40'), bg2 = v('--bg2', '#141828');
    var family = (getComputedStyle(document.body || document.documentElement).fontFamily || '').trim() ||
                 'system-ui, -apple-system, "Segoe UI", Roboto, Helvetica, Arial, sans-serif';
    // `automargin` on here is the STARTING state, not the running one: it is the only thing that measures
    // the drawn text, so a figure needs it to find its margins the first time, and turning it off outright
    // would trade a flicker for a clipped axis. `remeasureMargins` takes it away again as soon as it has
    // answered, and puts it back only when the figure is at rest — see the note there for why.
    var axis = {
      gridcolor: border, zerolinecolor: border, linecolor: border, tickcolor: border,
      tickfont: { color: dim, size: 13 },
      title: { font: { color: text, size: 15 } },
      automargin: true
    };
    return {
      // Transparent rather than the palette's `--bg`, matching the ECharts theme: the cell's own background
      // shows through, so a figure sits correctly on light and dark alike.
      paper_bgcolor: 'rgba(0,0,0,0)',
      plot_bgcolor: 'rgba(0,0,0,0)',
      font: { color: text, size: 14, family: family },
      colorway: CYCLE.map(function (p) { return v(p[0], p[1]); }),
      title: { font: { color: text, size: 19 } },
      legend: { font: { color: dim, size: 13 } },
      xaxis: axis, yaxis: axis,
      // `bordercolor` matters as much as the fill: without it Plotly outlines the label in the trace
      // colour, which reads as a stray coloured box on a dark page.
      hoverlabel: { bgcolor: bg2, bordercolor: border, font: { color: text, size: 13, family: family } },
      modebar: { bgcolor: 'rgba(0,0,0,0)', color: dim, activecolor: text }
    };
  }

  // A Plotly TEMPLATE supplies defaults that anything set explicitly on the layout overrides — exactly the
  // precedence wanted, so an author's `Layout(paper_bgcolor = …)` still beats the palette. An author who
  // supplied their own template keeps it (the Julia side strips only PlotlyBase's ambient default).
  // Axis ranges the READER set by zooming or panning. Plotly marks a manually-set axis `autorange:false`,
  // which is exactly how a deliberate view is told apart from a fitted one.
  //
  // Without carrying these across a re-render, moving a `@bind` throws the reader's view away: they zoom
  // into a feature, nudge the control to compare, and are bounced back to the full extent. The new data
  // is the point of the update; the viewport is the reader's, and nothing about a data change implies
  // they wanted to look somewhere else.
  function keptRanges(el) {
    var out = {}, fl = el && el._fullLayout;
    if (!fl) return out;
    Object.keys(fl).forEach(function (k) {
      if (!/^[xy]axis\d*$/.test(k)) return;
      var ax = fl[k];
      if (ax && ax.autorange === false && ax.range) out[k] = { range: ax.range.slice(), autorange: false };
    });
    return out;
  }

  // ── The reader's view, across a REMOUNT ─────────────────────────────────────────────────────────
  // `keptRanges` carries a zoom through a `Plotly.react`, which covers an update drawn into the same
  // node. It cannot cover a remount — and moving a `@bind` is a remount: Slate re-renders the cell and
  // hands the widget a brand new element, whose `_fullLayout` has never been zoomed. There is nothing
  // left to read, so the reader is bounced back to the full extent by the very control they were using
  // to compare against it.
  //
  // So the view is remembered OUTSIDE the element too, keyed by WHERE the figure sits rather than by
  // whichever node currently happens to be showing it.
  var VIEWS = {};

  function viewKey(el) {
    var cell = el.closest && el.closest('[id^="cell-"]');
    if (!cell) return null;
    // Position within the cell, so a cell holding several figures keeps them apart. The class is added
    // before the first draw, so a remounted node is already findable here.
    var peers = cell.querySelectorAll('.plotly-graph-div');
    var i = Array.prototype.indexOf.call(peers, el);
    return cell.id + '#' + (i < 0 ? 0 : i);
  }

  function rememberView(el) {
    var k = viewKey(el);
    if (!k) return;
    var kept = keptRanges(el);
    // Nothing manual left means the reader RESET the view (modebar home, double-click). Forget it, so a
    // stale zoom is never re-imposed on someone who deliberately zoomed back out.
    if (Object.keys(kept).length) VIEWS[k] = kept; else delete VIEWS[k];
  }

  function rememberedView(el) {
    var k = viewKey(el);
    return (k && VIEWS[k]) || null;
  }

  function themed(layout, el) {
    var l = Object.assign({}, layout || {});
    var t = themeLayout();
    // An author who set an explicit range in Julia means it, and that wins. Otherwise a view the reader
    // established survives the update — read from the live element when there is one to read (an update
    // in place), and otherwise from what this figure's position last recorded (a remount, where the
    // element is new and remembers nothing).
    var kept = keptRanges(el);
    if (!Object.keys(kept).length) kept = rememberedView(el) || {};
    Object.keys(kept).forEach(function (k) {
      if (!l[k] || (l[k].range === undefined && l[k].autorange === undefined)) {
        l[k] = Object.assign({}, l[k] || {}, kept[k]);
      }
    });
    // The margin floor travels with the layout for the same reason the reader's ranges do: `Plotly.react`
    // rebuilds from the spec, and the spec carries no margin — so without this every re-render would drop
    // the floor and re-run the ratchet from nothing, which is a visible twitch on each step of a slider
    // drag. An author who set their own margin still wins.
    var m = el && el.__slateMargin;
    if (m && !l.margin) {
      l.margin = { l: m.l, r: m.r, t: m.t, b: m.b };
      // And automargin goes back off with it. The template's default is ON — that is how a figure gets
      // measured the first time — so a re-render would otherwise switch it back on and re-open the loop
      // until the next settle, which is precisely a slider drag's worth of pushed-and-pulled labels.
      // `themeLayout` hands xaxis and yaxis the same object; both are set for the reader, not the runtime.
      t.xaxis.automargin = false;
      t.yaxis.automargin = false;
    }
    if (!l.template) l.template = { layout: t };
    // Hover labels are the one thing a template does NOT settle. Plotly derives a label's background
    // from the TRACE's colour unless the LAYOUT overrides it, and a template loses that contest — so a
    // dark page ends up with a pale box and dark text sitting on it. Set it on the layout directly,
    // still yielding to an author who specified their own.
    if (!l.hoverlabel) l.hoverlabel = t.hoverlabel;
    return l;
  }

  // ── Margins that cannot move under a gesture ────────────────────────────────────────────────────
  // Plotly's `automargin` sizes the margin from the tick labels it drew. But the margin sizes the plot
  // AREA, and the plot area's pixel width is what decides which tick set gets drawn next. That is a loop:
  // zoom re-picks the ticks → the labels change width → the margin moves → the plot area resizes → the
  // ticks are re-picked. It has enough gain to flip between two states, and plotly only CAPS the churn
  // rather than preventing it ("Too many auto-margin redraws", then it stops wherever it happens to be).
  //
  // A floor under `layout.margin` does NOT close this: automargin's push is applied on top of the margin,
  // so a minimum can't stop it growing — and the correction lands mid-gesture, tearing down the fast path
  // plotly uses for a scroll zoom. That is the labels being pushed and pulled exactly as the grid flips.
  //
  // So automargin is demoted from a running policy to a MEASURING INSTRUMENT. It is switched on only
  // while the figure is at rest, long enough to answer "how much room does this actually need", and the
  // answer is then pinned as an explicit margin with automargin off. During a gesture there is no
  // automargin at all, so there is no loop to oscillate and nothing that can relayout: the grid may flip
  // and the labels may change text, but the layout around them is frozen.
  //
  // The pinned value is also QUANTIZED and RATCHETED, so the at-rest measurement settles instead of
  // creeping. Quantized: it moves in whole steps, and automargin's perturbations are the width difference
  // between adjacent tick sets ("0.5" vs "0.55"), a few pixels — below one step they change nothing.
  // Ratcheted: within a mounted figure it only ever grows, and a monotone sequence bounded by the
  // container must terminate. Worst case it settles one step wider than needed, which is not visible.
  var MARGIN_STEP = 16;      // px; comfortably wider than the tick-set perturbations above
  var SETTLE_MS = 200;       // quiet time that counts as "the reader has stopped"

  // Every cartesian axis, not just the first pair — a figure with subplots has `xaxis2`, `yaxis3`, and an
  // axis left on automargin is an axis still in the loop. Same test `keptRanges` uses.
  function axisKeys(el) {
    var fl = el._fullLayout || {};
    return Object.keys(fl).filter(function (k) { return /^[xy]axis\d*$/.test(k); });
  }

  function setAutomargin(el, on) {
    var patch = {};
    axisKeys(el).forEach(function (k) { patch[k + '.automargin'] = on; });
    return Object.keys(patch).length ? window.Plotly.relayout(el, patch) : Promise.resolve();
  }

  // Hand the job back to plotly briefly, read what it decided, pin it, take it away again. Reusing its
  // measurement rather than reading the SVG ourselves: automargin is the thing that knows how wide the
  // text came out, and its correctness was never the problem — only its timing.
  function remeasureMargins(el) {
    if (!window.Plotly || !el._fullLayout || el.__slateRemeasuring) return Promise.resolve();
    // A figure that draws while hidden or collapsed has no width to measure against, and plotly has
    // fallen back to its own default canvas — pinning THAT would reserve margins for a 700px figure and
    // freeze them there once the element is finally shown. Leave it unpinned; becoming visible resizes
    // the figure, which relayouts, which schedules a measure with real geometry.
    if (!el.clientWidth || !el.offsetParent) return Promise.resolve();
    el.__slateRemeasuring = true;
    return setAutomargin(el, true).then(function () {
      var size = el._fullLayout._size, prev = el.__slateMargin || {}, next = {};
      ['l', 'r', 't', 'b'].forEach(function (k) {
        var need = Math.ceil(size[k] / MARGIN_STEP) * MARGIN_STEP;
        next[k] = Math.max(need, prev[k] || 0);     // the ratchet: never hand space back mid-view
      });
      el.__slateMargin = next;
      var patch = { 'margin.l': next.l, 'margin.r': next.r, 'margin.t': next.t, 'margin.b': next.b };
      axisKeys(el).forEach(function (k) { patch[k + '.automargin'] = false; });
      return window.Plotly.relayout(el, patch);
    }).catch(function () { /* a figure torn down mid-measure — nothing to pin */ })
      .then(function () { el.__slateRemeasuring = false; });
  }

  // Re-measure only once the figure has been quiet for a beat. Relayouts we cause ourselves are excluded
  // by the `__slateRemeasuring` guard; without it the measure would retrigger its own timer forever.
  function scheduleRemeasure(el) {
    if (el.__slateRemeasuring) return;
    clearTimeout(el.__slateMarginTimer);
    el.__slateMarginTimer = setTimeout(function () { remeasureMargins(el); }, SETTLE_MS);
  }

  // A gesture is IN FLIGHT — cancel any pending measure outright.
  //
  // This is the event that matters, and getting it wrong is what made the judder. During a continuous
  // wheel plotly emits `plotly_relayouting` throughout and `plotly_relayout` only when it commits, so a
  // settle timer pushed out by the COMMIT alone expires in the middle of the gesture. Measuring there is
  // not a cosmetic mistake: turning automargin back on issues a `Plotly.relayout`, which discards the
  // in-flight scroll-box transform and re-reads the last committed range — the view snaps back to where
  // the gesture started, then jumps forward again on the next commit. `relayouting` is the only signal
  // that means "the reader's hand is still moving", so it is the one that has to hold the measure off.
  function gestureActive(el) {
    clearTimeout(el.__slateMarginTimer);
    el.__slateMarginTimer = 0;
  }

  // Registered once per element — `plotly_relayout` handlers accumulate across `Plotly.react` calls
  // otherwise, and N copies would each schedule their own measure.
  function watchMargins(el) {
    if (el.__slateMarginWatched || !el.on) return;
    el.__slateMarginWatched = true;
    // `relayout` is the COMMIT — a settled view, and the only safe moment to arm a measure. It is also
    // where the reader's view is recorded, so a remount a moment later can put it back.
    el.on('plotly_relayout', function () { rememberView(el); scheduleRemeasure(el); });
    // `relayouting` fires throughout a live gesture; it disarms.
    el.on('plotly_relayouting', function () { gestureActive(el); });
  }

  // ── Spec ────────────────────────────────────────────────────────────────────────────────────────
  // The figure crosses as a JSON STRING rather than nested props: SEB's descriptor writer is a deliberately
  // minimal JSON encoder (Dict/Vector/String/Number/Bool/Nothing, anything else stringified), and a Plotly
  // spec is exactly the kind of deeply-nested payload that would quietly lose a value in it. Encoding with
  // JSON.jl on the Julia side and parsing here keeps PlotlyBase's own serialization authoritative.
  function readSpec(params) {
    if (!params) return null;
    if (params.__spec) return params.__spec;              // parsed once, cached on the params object
    var raw = params.spec_json;
    if (!raw) return null;
    try { params.__spec = JSON.parse(raw); } catch (e) { return null; }
    return params.__spec;
  }

  function fail(el, e) {
    el.innerHTML = '<pre class="slate-plotly-err">Plotly render failed: ' +
      String((e && e.message) || e) + '</pre>';
  }

  // Draw or UPDATE. `Plotly.react` diffs against what is already drawn, so a reactive re-render keeps the
  // user's zoom and pan instead of resetting the view — the behaviour `echart` already has via persistent
  // instances, and the reason the mount is keyed on the cell rather than on a per-`Plot` UUID.
  function draw(el, spec, json) {
    if (!spec) return Promise.resolve();
    return ensurePlotly().then(function (Plotly) {
      el.__slatePlotlySpec = spec;                        // kept so a palette switch can redraw
      // The CONTENT that produced this render. Identity is useless here: `readSpec` parses a fresh
      // object whenever the params are rebuilt, so an identity check reports "changed" every time and
      // redraws constantly — which resets the axes out from under a zoom or pan in progress.
      if (json !== undefined) el.__slatePlotlyJson = json;
      return Plotly.react(el, spec.data || [], themed(spec.layout, el), spec.config || {});
    }).then(function () {
      var frames = (el.__slatePlotlySpec || {}).frames;
      if (frames && frames.length) return window.Plotly.addFrames(el, frames);
    }).then(function () {
      // Pin the margin from the FIRST draw, before the reader can touch anything — a gesture must never
      // be the thing that discovers the figure still had automargin live on it.
      watchMargins(el);
      return remeasureMargins(el);
    }).catch(function (e) { fail(el, e); });
  }

  // ── Bind: figure → value ────────────────────────────────────────────────────────────────────────
  // `events` (a widget param) says which Plotly interactions commit a value, so a plain display costs no
  // listeners. A click commits immediately; hover is continuous and goes through `schedule`, the same
  // throttled path a slider drag uses, so a moving cursor cannot flood the kernel.
  function pointPayload(d) {
    var p = (d && d.points && d.points[0]) || null;
    if (!p) return null;
    return { x: p.x, y: p.y, curve: p.curveNumber, index: p.pointNumber,
             trace: (p.data && p.data.name) || null };
  }

  function wireEvents(el, api, spec, events) {
    if (!events || !events.length) return;
    var has = function (n) { return events.indexOf(n) >= 0; };
    if (has('click')) el.on('plotly_click', function (d) {
      var v = pointPayload(d); if (v) api.push(v);
    });
    if (has('hover')) el.on('plotly_hover', function (d) {
      var v = pointPayload(d); if (v && api.schedule) api.schedule(v);
    });
    if (has('select')) el.on('plotly_selected', function (d) {
      // A lasso/box release with no selection clears it — push null rather than leaving a stale region.
      if (!d || !d.points) { api.push(null); return; }
      api.push(d.points.map(pointPayload).filter(Boolean));
    });
  }

  // ── Replay: a control driving shipped data, with no kernel ──────────────────────────────────────
  // Everything about a replayed control except the call that puts a slice on screen lives in Slate
  // core, as `Slate.replay` — the sweep lookup, the control lookup, the packed-buffer slice, the
  // listeners and the enable-once-data-arrives. Core defines it twice on purpose (core.js for a live
  // page, server_export.jl for a standalone one, the same way `Slate.asset` is mirrored), so this file
  // does not care which it is running in.
  //
  // What is left below is the only Plotly-specific part: which trace and field a slice belongs to.
  // Live, `Slate.replay.wire` returns immediately — moving a `@bind` re-runs the cell in Julia and a
  // fresh spec arrives, and taking over would fight the kernel and serve stale columns.
  function wireReplay(el, routes) {
    if (!routes || !routes.length) return;
    if (!window.Slate || !window.Slate.replay) return;   // an export predating `Slate.replay`
    window.Slate.replay.wire(routes, function (slice, r) {
      var patch = {};
      patch[r.field] = [slice];
      window.Plotly.restyle(el, patch, [r.trace]);
    });
  }

  // ── Registration ────────────────────────────────────────────────────────────────────────────────
  window.slateRegisterWidget(KIND, {
    wire: function (el, api) {
      var params = (api && api.params) || {};
      var spec = readSpec(params);
      el.classList.add('plotly-graph-div');
      // Centre like Slate's own figures. The mount is a `<span>`, which is inline — so a plot with an
      // explicit width would sit hard against the left edge while every echart beside it centred. Making
      // it a block with auto margins lines the two engines up, and is a no-op at the default 100%.
      el.style.display = 'block';
      el.style.margin = '0 auto';
      // Opt into Slate's chart scroll-zoom gate (core `settings.js`). PlotlyBase ships `scrollZoom: true`
      // in every figure's config, so without this the wheel zooms the plot the moment a reader's cursor
      // crosses it while scrolling the page — and because the page keeps scrolling under a zoom that is
      // anchored to the cursor, a single flick reads as the view jittering rather than as a zoom. The gate
      // holds the wheel back until the figure is clicked into, then scales it by the reader's setting.
      // The attribute's value names Plotly's own zoom surface: `.nsewdrag`, the transparent rect it lays
      // over the axes and listens on. (A 3-D figure has no such rect; the gate falls back to the canvas.)
      el.setAttribute('data-slate-zoomable', '.nsewdrag');
      el.tabIndex = -1;                                   // focusable, so `:focus-within` can mean "active"
      if (params.height) el.style.height = params.height;
      if (params.width) el.style.width = params.width;
      draw(el, spec, params.spec_json).then(function () {
        if (api && api.push) wireEvents(el, api, spec, params.events || []);
        wireReplay(el, params.replay || []);
      });
    },
    // A server-pushed value arriving for a figure whose SPEC changed (an upstream recompute) redraws in
    // place. The bound value itself is produced BY the figure, so there is nothing to reflect back into it.
    // A server-pushed update for a figure whose SPEC changed (an upstream recompute) redraws in place.
    // Compared by CONTENT, not identity: `sync` fires on ordinary state broadcasts, and an identity
    // check would report "changed" on every one — redrawing constantly and resetting the axes mid-zoom.
    // The bound value itself is produced BY the figure, so there is nothing to reflect back into it.
    sync: function (el, value, params) {
      var p = params || {};
      if (p.spec_json === el.__slatePlotlyJson) return;   // nothing actually changed — leave the view alone
      var spec = readSpec(p);
      if (spec) draw(el, spec, p.spec_json);
    },
    destroy: function (el) {
      try { window.Plotly && window.Plotly.purge(el); } catch (_) {}
      el.__slatePlotlySpec = null;
      // Both must go with the purge. `purge` takes the event emitter with it, so a node that is wired
      // again needs to re-register its relayout handler — a stale "already watching" flag would leave the
      // margin unstabilized for the rest of that figure's life. And the ratchet is only meaningful within
      // one mounted view: a fresh figure on this node should size to its own labels, not inherit a floor
      // reserved for data it no longer draws.
      el.__slateMarginWatched = false;
      el.__slateMargin = null;
      el.__slateRemeasuring = false;
      clearTimeout(el.__slateMarginTimer);      // a measure landing after the purge would throw
    }
  });

  // ── Re-theme on a palette switch ────────────────────────────────────────────────────────────────
  // Observing the attribute rather than hooking `window._onSlateThemeChange`: that global is owned and
  // REPLACED by core.js, so chaining onto it is a load-order race that would silently drop either our
  // re-theme or ECharts'. The attribute is the actual state, so watching it cannot be clobbered. In an
  // export the palette is baked at build time and this never fires.
  try {
    new MutationObserver(function () {
      if (!window.Plotly) return;
      document.querySelectorAll('.plotly-graph-div').forEach(function (el) {
        var spec = el.__slatePlotlySpec;
        if (!spec) return;
        try { window.Plotly.react(el, spec.data || [], themed(spec.layout, el), spec.config || {}); } catch (_) {}
      });
    }).observe(document.documentElement, { attributes: true, attributeFilter: ['data-slate-theme'] });
  } catch (_) {}
})();
