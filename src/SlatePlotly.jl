"""
    SlatePlotly

Plotly figures in Kaimon Slate notebooks, rendering identically live and in a **single-file** static
export with no network access.

Load it beside whichever Plotly package you already use — `PlotlyJS.jl`, `Plotly.jl`, or `PlotlyBase`
directly. All three build a `PlotlyBase.Plot`, which is what this package dispatches on, so existing
plotting code needs no changes:

```julia
using PlotlyJS, SlatePlotly
plot(scatter(x = 1:10, y = rand(10), mode = "markers"))   # returned from a cell → interactive
```

A figure can also be an INPUT, binding what the reader clicks or selects:

```julia
@bind sel plot_select(fig; events = [:click])
sel.x, sel.y, sel.trace       # `nothing` until something is picked
```

Nothing Plotly-specific lives in Slate core. The figure is a registered widget KIND
(`SlatePlotly.PlotlyFigure`), so a displayed figure and a bound one run through the same machinery Slate
uses for its own controls. `plotly.js` is vendored as a pinned Julia artifact and declared through
`provide_assets!`; in a standalone export Slate rewrites the vendored URL into inlined bytes, so the
delivered file makes no external request.
"""
module SlatePlotly

using Artifacts
import JSON
import PlotlyBase

# The plotly version this package's artifact pins. A partial bundle must match it exactly — mixing a
# 2.35 bundle with 2.35 figure specs is fine; mixing majors is not.
const _PLOTLY_VERSION = "2.35.2"
using SlateExtensionsBase: SlateExtensionsBase, provide_assets!, provide_frontend!, js_bundle,
                           ext_asset_url, component, kind_for, Widget, ReplayArray

export plot_select

# `@replay` and the `ReplayArray` it produces live in Slate, not here — they are renderer-agnostic (an
# ECharts figure wants the same shipped data) and they need the bind registry to read a control's domain.
# This package's whole share of that feature is two small things: NOTICING a `ReplayArray` in a figure
# (`_replay_routes`) and knowing the Plotly call that applies a new slice (`Plotly.restyle`, in the
# widget JS).

# PlotlyBase lowers a trace's fields through JSON.lower; without this the wrapper would serialize as an
# object rather than the array Plotly expects.
JSON.lower(r::ReplayArray) = r.data

# ── Building a plotly bundle for what this notebook draws ─────────────────────────────────────────────
# `plotly.js-dist-min` is the EVERYTHING build — 3D, geo, mapbox, finance, ternary, sankey — and at
# 4.3 MB it is by far the largest thing in a self-contained export. Almost no notebook uses more than a
# corner of it, and the trace types ARE known here, at the moment a figure is serialized, so the author
# never has to declare anything.
#
# Trace types this notebook has actually rendered. Accumulated as figures serialize (a notebook reveals
# itself cell by cell), so the choice reflects the whole document rather than whichever cell ran last.
const _SEEN_TRACES = Set{String}()

function _note_traces!(p::PlotlyBase.Plot)
    for tr in p.data
        f = try; tr.fields; catch; continue; end
        f isa AbstractDict || continue
        t = get(f, :type, nothing)
        t === nothing || push!(_SEEN_TRACES, lowercase(String(t)))
    end
    return nothing
end

# The file within the artifact. The artifact tree also carries the unminified `plotly.js` and the sample
# `datasets/`, which a notebook never references — harmless for a standalone export (only URLs a script
# actually mentions get inlined), but a published SITE copies the whole declared tree. Narrowing that
# would mean staging a one-file directory somewhere writable; not worth a Scratch dependency until
# someone publishes a Plotly notebook as a multi-file site.
const _PLOTLY_SUB = "plotly.min.js"

const _WIDGET_PATH = normpath(joinpath(@__DIR__, "..", "assets", "plotly_widget.js"))
# Read at load time, so it is baked into the precompiled image. Declare it as a compile-time input or
# editing the JS has no effect until something unrelated happens to invalidate the cache — which during
# front-end work reads as "my change did nothing".
include_dependency(_WIDGET_PATH)
const _WIDGET_JS = read(_WIDGET_PATH, String)

_asset_dir() = artifact"plotly-artifacts"

# Where a built bundle is cached: under the depot, keyed by plotly version so a version bump never serves
# a stale build. Built ONCE per (version, trace set) and reused by every notebook that draws the same mix.
_bundle_cache_dir() = joinpath(first(DEPOT_PATH), "slateplotly", _PLOTLY_VERSION)

# plotly's own module layout: `lib/core` is the renderer, and each trace type is a separate module
# registered onto it. This is the ONLY plotly-specific knowledge involved — the bundling itself is
# generic (`js_bundle` takes an entry module and npm deps, and knows nothing about plotly).
_trace_module(t) = "plotly.js/lib/" * lowercase(String(t))

# An entry importing exactly the traces drawn, so the bundle carries a fraction of the "dist" build.
# CommonJS, matching plotly's own modules — an ESM entry would drag in `default`-vs-namespace interop
# for no benefit.
function _bundle_entry(traces)
    mods = sort!(collect(String, traces))
    io = IOBuffer()
    println(io, "const Plotly = require('plotly.js/lib/core');")
    println(io, "Plotly.register([")
    for m in mods
        println(io, "  require('", _trace_module(m), "'),")
    end
    println(io, "]);")
    println(io, "window.Plotly = Plotly;")
    return String(take!(io))
end

# The one directory this package serves from. The chosen build narrows as a notebook reveals its traces,
# so only the FILENAME may vary — repointing the directory would 404 the URL a loaded page still holds.
# The full build is staged in alongside the tree-shaken ones.
function _serve_dir()
    dir = _bundle_cache_dir()
    full = joinpath(dir, _PLOTLY_SUB)
    if !isfile(full) || filesize(full) < 1_000_000
        try
            mkpath(dir)
            tmp = full * ".part"
            cp(joinpath(_asset_dir(), _PLOTLY_SUB), tmp; force = true)
            chmod(tmp, 0o644)          # the artifact copy is read-only; a later overwrite must not fail
            mv(tmp, full; force = true)
        catch
            return _asset_dir()        # can't stage it — serve the artifact, which is always correct
        end
    end
    return dir
end

# The tree-shaken bundle for what this notebook draws, or `nothing` to use the full vendored artifact.
#
# Everything degrades to the artifact rather than failing: a smaller bundle is an OPTIMISATION, and no
# export should break because node is absent, the network is down, or a build errored. A machine without
# a toolchain simply produces a correct, larger file.
function _ensure_bundle(traces = _SEEN_TRACES)
    isempty(traces) && return nothing                 # nothing drawn yet — full build is the safe answer
    return SlateExtensionsBase.js_bundle(
        "plotly-" * join(sort!(collect(String, traces)), "-"),
        _bundle_entry(traces);
        deps = Dict("plotly.js" => _PLOTLY_VERSION),
        dir = _bundle_cache_dir())
end


"""
    PlotlyFigure(plot; events = Symbol[])

A `PlotlyBase.Plot` addressed as a Slate widget. `events` lists the Plotly interactions that commit a
bound value (`:click`, `:hover`, `:select`); empty — the display case — attaches no listeners at all.

Constructed for you by `plot_select`, and implicitly whenever a `Plot` is returned from a cell.
"""
struct PlotlyFigure
    plot::PlotlyBase.Plot
    events::Vector{Symbol}
end
PlotlyFigure(p::PlotlyBase.Plot; events = Symbol[]) = PlotlyFigure(p, collect(Symbol, events))

"""
    plot_select(p; events = [:click], default = nothing)

Bind what the reader picks on a Plotly figure:

```julia
@bind sel plot_select(fig)                      # click a point
@bind region plot_select(fig; events = [:select])   # lasso / box → a Vector of points
```

The bound value is a `Dict` with `x`, `y`, `trace`, `curve` and `index` (a `Vector` of them for
`:select`), or `nothing` before anything is picked. `:hover` commits through Slate's throttled path — the
same one a slider drag uses — so a moving cursor cannot flood the kernel.
"""
plot_select(p::PlotlyBase.Plot; events = [:click], default = nothing) =
    PlotlyFigure(p; events = events)

# A Plotly layout dimension → a CSS length. Plotly takes a bare number as pixels; a string is already a
# CSS length ("100%", "40rem") and passes through.
_css_len(x::Real) = string(x, "px")
_css_len(x::AbstractString) = String(x)

# Whether this figure's layout carries the AMBIENT DEFAULT template rather than one the author chose.
# PlotlyBase stamps every `Layout` with `templates[templates.default]`, so presence proves nothing — but it
# stores that exact object, so identity separates the two cases with no heuristic.
_is_default_template(p::PlotlyBase.Plot) =
    get(p.layout.fields, :template, nothing) === PlotlyBase.templates[PlotlyBase.templates.default]

# The figure as a plain spec: `{data, layout, frames, config}`.
function _spec(p::PlotlyBase.Plot)
    # What this figure draws decides which plotly build ships — so record it, then re-point the loader.
    # Doing it here (rather than only in `__slate_frontend`, which fires once before anything has drawn)
    # is what lets the choice actually narrow.
    _note_traces!(p)
    try; _register_frontend!(); catch; end
    low = JSON.lower(p)
    # Drop the default template. Two reasons, both load-bearing: it is ~7 kB of light-theme JSON per figure
    # in a file whose whole point is being small enough to hand out, and the front end only applies the
    # Slate palette when no template is present — so leaving it here renders every figure white on a dark
    # page. A template the author selected is not the default object and survives untouched.
    lay = get(low, :layout, Dict{Symbol,Any}())
    if lay isa AbstractDict && _is_default_template(p)
        lay = copy(lay)
        delete!(lay, :template)
    end
    cfg = get(low, :config, Dict{Symbol,Any}())
    # Responsive by default so a figure tracks the cell width the way Slate's own charts do; an author who
    # set it explicitly keeps their value.
    cfg isa AbstractDict && get!(cfg, :responsive, true)
    return Dict{String,Any}("data" => get(low, :data, Any[]), "layout" => lay,
                            "frames" => get(low, :frames, Any[]), "config" => cfg)
end

# The component descriptor. The spec crosses as a JSON STRING, not as nested props: SEB's descriptor writer
# is a deliberately minimal JSON encoder (Dict/Vector/String/Number/Bool/Nothing, anything else
# STRINGIFIED), and a Plotly spec is exactly the deeply-nested payload that would quietly lose a value in
# it. Encoding here with JSON.jl keeps PlotlyBase's own serialization authoritative, and the front end
# parses it once.
# Which trace fields are driven by a control, found by walking the traces BEFORE they are lowered — once
# `JSON.lower` runs, a `ReplayVector` has become a plain array and its provenance is gone. This is what
# spares the author from naming a trace or a field: they put the value where it belongs and the walk
# works out the rest. Indices are 0-based, since only JavaScript consumes them.
function _replay_routes(p::PlotlyBase.Plot)
    routes = Dict{String,Any}[]
    for (i, tr) in enumerate(p.data)
        fields = try; tr.fields; catch; continue; end
        fields isa AbstractDict || continue
        for (k, v) in fields
            v isa ReplayArray || continue
            # No asset or slice shape here — live, the sweep has not run, and it is the EXPORT that
            # decides what actually ships (and at what resolution). The route carries the sweep's `id`;
            # the page resolves it against the table the export emits, so a figure rendered live and the
            # same figure in a frozen file describe themselves identically.
            push!(routes, Dict{String,Any}(
                "trace" => i - 1, "field" => String(k), "id" => v.id,
                "control" => v.control, "index" => v.index - 1))
        end
    end
    return routes
end

function _props(f::PlotlyFigure)
    p = f.plot
    return Dict{String,Any}(
        "spec_json" => JSON.json(_spec(p)),
        # Empty for an ordinary figure, so nothing about the offline path costs anything until used.
        "replay" => _replay_routes(p),
        "width"  => _css_len(get(p.layout, :width, "100%")),
        # Plotly's own default height is "100%", which collapses to zero inside a cell's auto-height output
        # box — give it a real default and let an explicit `Layout(height = …)` win.
        "height" => _css_len(get(p.layout, :height, 450)),
        "events" => String[String(e) for e in f.events])
end

# ── The two dispatch points ───────────────────────────────────────────────────────────────────────────
# Display: a `Plot` returned from a cell. Emits the component DESCRIPTOR rather than an HTML fragment, so
# a returned figure and a bound one mount through identical front-end machinery — SEB's `render.jl` is
# explicit that this is the blessed path and `html_fragment` the escape hatch. Deliberately NOT a
# `Base.show(::MIME"text/html", ::Plot)` method: that would be piracy on PlotlyBase's type and would change
# how a figure renders in the REPL, IJulia and VS Code.
SlateExtensionsBase.slate_render(p::PlotlyBase.Plot) =
    SlateExtensionsBase.slate_render(PlotlyFigure(p))
SlateExtensionsBase.slate_render(f::PlotlyFigure) = component(kind_for(PlotlyFigure), _props(f))

# Input: `@bind sel plot_select(fig)`. Same kind, so the same registered front-end wires it — the only
# difference is that a bound figure has listeners that push values back.
SlateExtensionsBase.to_widget(f::PlotlyFigure) =
    Widget(kind_for(PlotlyFigure), _props(f), nothing)

# Declared per drain rather than from `__init__`: the hook only fires for notebooks that actually loaded
# this package, so a notebook with no Plotly figure carries neither the route nor the widget script. Both
# calls are idempotent (`provide_assets!` replaces by package key, `provide_frontend!` by id).
# The last front-end registration, so re-registering is a no-op until the answer actually changes.
const _REGISTERED = Ref{String}("")

# Point the page's loader at the right plotly build. Called from the render path, not just
# `__slate_frontend` — that hook fires once per namespace generation, before anything has drawn. Both
# registrations replace by key, so repeat calls cost a string comparison.
function _register_frontend!()
    built = _ensure_bundle()
    sub = built === nothing ? _PLOTLY_SUB : basename(built)
    provide_assets!(@__MODULE__, _serve_dir())
    url = ext_asset_url(@__MODULE__, sub)
    url == _REGISTERED[] && return nothing
    _REGISTERED[] = url
    # The URL is injected as a global rather than baked into the widget source, so that file stays a
    # plain reviewable `.js` and the one line Slate rewrites at export time is obvious.
    provide_frontend!(string("window.__slatePlotlySrc=", JSON.json(url), ";\n", _WIDGET_JS);
                      id = "SlatePlotly.widget")
    return nothing
end

function __slate_frontend(slate_on)
    # Establishes the loader even for a notebook whose figures have not drawn yet (the full artifact);
    # the render path narrows it once the traces are known.
    _register_frontend!()
    return nothing
end

end # module
