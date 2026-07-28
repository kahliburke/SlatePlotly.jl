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

  function themed(layout, el) {
    var l = Object.assign({}, layout || {});
    var t = themeLayout();
    // An author who set an explicit range in Julia means it, and that wins. Otherwise a view the reader
    // established survives the update.
    var kept = keptRanges(el);
    Object.keys(kept).forEach(function (k) {
      if (!l[k] || (l[k].range === undefined && l[k].autorange === undefined)) {
        l[k] = Object.assign({}, l[k] || {}, kept[k]);
      }
    });
    if (!l.template) l.template = { layout: t };
    // Hover labels are the one thing a template does NOT settle. Plotly derives a label's background
    // from the TRACE's colour unless the LAYOUT overrides it, and a template loses that contest — so a
    // dark page ends up with a pale box and dark text sitting on it. Set it on the layout directly,
    // still yielding to an author who specified their own.
    if (!l.hoverlabel) l.hoverlabel = t.hoverlabel;
    return l;
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
  // Live, moving a `@bind` re-runs the cell in Julia and a fresh spec arrives — so this must stay OUT of
  // the way; taking over would fight the kernel and serve stale columns. It engages ONLY where there is
  // no kernel to ask, which is exactly what `Slate.isLive()` reports (a static export mirrors it as a
  // constant `false`). One flag, one behaviour difference, everything else identical.
  function isLive() {
    try { return !!(window.Slate && window.Slate.isLive && window.Slate.isLive()); } catch (_) { return false; }
  }

  // The control that owns a bound variable. Slate marks a rendered control with `data-name`; the actual
  // input may be that node or sit inside it.
  function controlInput(name) {
    var host = document.querySelector('[data-name="' + String(name).replace(/"/g, '\\"') + '"]');
    if (!host) return null;
    return (host.matches && host.matches('input,select')) ? host : host.querySelector('input,select');
  }

  // Which column a control's current value selects. Matched NUMERICALLY against the shipped domain where
  // both sides are numbers — a DOM control reports "8" as a string, and Julia may have written 8.0, so
  // comparing text would miss. Falls back to string equality for categorical domains.
  function domainIndex(domain, raw) {
    var n = Number(raw);
    if (!Number.isNaN(n)) {
      for (var i = 0; i < domain.length; i++) if (Number(domain[i]) === n) return i;
    }
    for (var j = 0; j < domain.length; j++) if (String(domain[j]) === String(raw)) return j;
    return -1;
  }

  // Slices are stacked along the LAST dimension and the buffer is column-major, so the slice for one
  // control value is a contiguous run — a view, never a gather, however large the data.
  //
  // A 1-D slice (a series) goes straight to Plotly. A 2-D slice (a heatmap / surface `z`) has to be
  // handed over as rows, and column-major means element (r,c) sits at c*rows + r — so this transposes on
  // the way out rather than shipping a second, row-major copy.
  function sliceOf(packed, r, i) {
    var shp = (r.slice && r.slice.length) ? r.slice : [packed.data.length];
    var n = shp.reduce(function (a, b) { return a * b; }, 1);
    var flat = packed.data.subarray(i * n, (i + 1) * n);
    if (shp.length <= 1) return Array.from(flat);
    if (shp.length === 2) {
      var rows = shp[0], cols = shp[1], out = new Array(rows);
      for (var y = 0; y < rows; y++) {
        var row = new Array(cols);
        for (var x = 0; x < cols; x++) row[x] = flat[x * rows + y];
        out[y] = row;
      }
      return out;
    }
    return Array.from(flat);      // rank ≥ 3 has no direct Plotly field; hand back the flat run
  }

  function wireReplay(el, routes) {
    if (!routes || !routes.length || isLive()) return;
    routes.forEach(function (r) {
      var input = controlInput(r.control);
      if (!input) return;
      // The route names a SWEEP, not an asset: what shipped — and at what resolution — is the export's
      // decision, published in this table. A route with no entry simply never wires, so a figure whose
      // sweep was skipped leaves its control visibly disabled instead of failing at the first drag.
      var sweep = (window.__slateReplays || {})[r.id];
      if (!sweep) return;
      var loaded = window.Slate.asset(sweep.asset);   // inlined bytes in a standalone file
      var readout = input.parentElement && input.parentElement.querySelector('.exp-ctl-val');
      var apply = function () {
        var i = domainIndex(sweep.domain || [], input.value);
        if (i < 0) return;
        if (readout) readout.textContent = input.value;
        loaded.then(function (packed) {
          var patch = {};
          patch[r.field] = [sliceOf(packed, sweep, i)];
          window.Plotly.restyle(el, patch, [r.trace]);
        }).catch(function (e) { console.error('SlatePlotly replay failed', e); });
      };
      // `input` fires continuously while a slider is dragged; the data is already in memory, so redrawing
      // per event is cheap and gives the same feel as the live kernel path at its best.
      input.addEventListener('input', apply);
      input.addEventListener('change', apply);
      // The export renders every control DISABLED, because one that moves without changing anything reads
      // as a broken page. Enabling here — and only here — means a control is live exactly when data for
      // it actually rode along, with no coordination between the two sides.
      loaded.then(function () {
        input.disabled = false;
        input.removeAttribute('title');
      }).catch(function () { /* data missing → the control stays visibly inert, which is the truth */ });
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
