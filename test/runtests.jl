using Test
using SlatePlotly
using PlotlyBase
using SlateExtensionsBase: slate_render, to_widget, kind_for, SlateComponentMIME, SlateHtmlMIME
import JSON

const SP = SlatePlotly

_fig(; kw...) = Plot(scatter(x = [1, 2, 3], y = [4, 5, 6], mode = "markers"), Layout(; kw...))

# The descriptor as Slate emits it, and the figure spec inside it.
_desc(x) = JSON.parse(sprint(show, SlateComponentMIME(), x))
_spec(x) = JSON.parse(_desc(x)["props"]["spec_json"])

@testset "renders as a component, not an HTML fragment" begin
    p = _fig()
    # The blessed path: SEB's own `render.jl` calls `component` the descriptor a bound widget mounts and
    # `html_fragment` the escape hatch. Using the fragment is what divorced this from @bind and reactivity.
    @test Base.showable(SlateComponentMIME(), p)
    @test !Base.showable(SlateHtmlMIME(), p)

    d = _desc(p)
    @test d["v"] == 1
    @test d["component"] == kind_for(SP.PlotlyFigure) == "SlatePlotly.PlotlyFigure"
    @test haskey(d["props"], "spec_json")
end

@testset "a displayed figure and a bound one share one kind" begin
    p = _fig()
    w = to_widget(plot_select(p))
    # Same kind ⇒ the same registered front-end wires both, which is the whole point of the refactor.
    @test w.kind == kind_for(SP.PlotlyFigure)
    @test _desc(p)["component"] == w.kind
    @test w.default === nothing                       # nothing picked yet

    # Events are opt-in, so a plain display attaches no listeners at all.
    @test _desc(p)["props"]["events"] == String[]
    @test to_widget(plot_select(p)).params["events"] == ["click"]
    @test to_widget(plot_select(p; events = [:select, :hover])).params["events"] == ["select", "hover"]
end

@testset "spec crosses as JSON, encoded by JSON.jl" begin
    # SEB's descriptor writer is a minimal encoder that STRINGIFIES anything outside its known shapes; a
    # Plotly spec is exactly the nested payload that would quietly lose a value in it. So the spec is a
    # pre-encoded string and must survive a round-trip intact.
    s = _spec(_fig())
    @test s["data"][1]["mode"] == "markers"
    @test s["data"][1]["y"] == [4, 5, 6]
    @test haskey(s, "layout") && haskey(s, "frames") && haskey(s, "config")
    @test s["config"]["responsive"] === true          # responsive unless the author said otherwise
end

@testset "layout dimensions" begin
    props = x -> _desc(x)["props"]
    # Plotly's default height is "100%", which collapses inside a cell's auto-height output box.
    @test props(_fig())["height"] == "450px"
    @test props(_fig(height = 300))["height"] == "300px"
    @test props(_fig(width = "60%"))["width"] == "60%"
    @test SP._css_len(42) == "42px"
    @test SP._css_len("40rem") == "40rem"
end

@testset "default template is stripped, an authored one kept" begin
    # PlotlyBase stamps every Layout with the ambient default template. Left in, the front end's "theme
    # only when no template is present" rule never fires and every figure renders white on a dark page.
    @test !haskey(_spec(_fig())["layout"], "template")

    chosen = Plot(scatter(x = [1, 2], y = [3, 4]),
                  Layout(template = PlotlyBase.templates[:plotly_dark]))
    @test haskey(_spec(chosen)["layout"], "template")

    # And it is worth real bytes in a file meant to be handed out.
    @test length(_desc(_fig())["props"]["spec_json"]) < 3_000
end

@testset "bundle selection" begin
    # The bundling seam is GENERIC (`js_bundle` takes an entry module + npm deps and knows nothing about
    # plotly); this package's only share is knowing plotly's module layout and which traces were drawn.
    empty!(SP._SEEN_TRACES)
    sprint(show, SlateComponentMIME(), _fig())
    @test "scatter" in SP._SEEN_TRACES
    sprint(show, SlateComponentMIME(), Plot(heatmap(z = [1 2; 3 4])))
    @test SP._SEEN_TRACES == Set(["scatter", "heatmap"])

    # The entry imports the renderer plus exactly the traces drawn — nothing else, which is the whole
    # point: the published dist build carries 3D, geo, mapbox and finance regardless.
    e = SP._bundle_entry(["scatter", "heatmap"])
    @test occursin("plotly.js/lib/core", e)
    @test occursin("plotly.js/lib/scatter", e) && occursin("plotly.js/lib/heatmap", e)
    @test !occursin("scatter3d", e) && !occursin("mapbox", e)
    @test occursin("Plotly.register(", e) && occursin("window.Plotly = Plotly", e)
    # Deterministic: the same trace set must yield the same entry, or the bundle cache never hits.
    @test SP._bundle_entry(["heatmap", "scatter"]) == e

    # Nothing drawn ⇒ no custom bundle; the caller falls back to the full vendored artifact. Guessing
    # small here would ship a bundle whose trace module is missing — a blank figure in a delivered file.
    empty!(SP._SEEN_TRACES)
    @test SP._ensure_bundle(Set(String[])) === nothing
    @test occursin(SP._PLOTLY_VERSION, SP._bundle_cache_dir())   # keyed by version — never a stale build

    # ONE served directory, always. The chosen build narrows as a notebook reveals its traces, so what is
    # served changes mid-session — and repointing the directory would 404 the URL a loaded page is still
    # holding, killing the library on a page that was working. Only the filename may vary.
    d = SP._serve_dir()
    @test isdir(d)
    @test isfile(joinpath(d, SP._PLOTLY_SUB))                    # the full build resolves here too
    @test filesize(joinpath(d, SP._PLOTLY_SUB)) > 1_000_000
    @test SP._serve_dir() == d                                   # stable across calls
end

@testset "vendored artifact" begin
    dir = SP._asset_dir()
    @test isdir(dir)
    js = joinpath(dir, SP._PLOTLY_SUB)
    @test isfile(js)
    # Guard the pin: a bumped artifact that silently stopped shipping the minified bundle, or one that
    # isn't plotly at all, should fail here rather than at render time in a delivered exam.
    @test filesize(js) > 1_000_000
    @test occursin("plotly.js", read(js, String)[1:400])
end

@testset "front-end contract" begin
    js = SP._WIDGET_JS
    # Registers through the low-level seam (self-owned DOM + no import map), under the derived kind.
    @test occursin("slateRegisterWidget", js)
    @test occursin(kind_for(SP.PlotlyFigure), js)
    # Specifically: never CALL it. Naming it in prose is fine — that is where the reasoning for choosing
    # the low-level seam over the Preact adapter lives.
    @test !occursin("registerComponent(", js)
    # Classic script, not an ES module: no import statement, so a single-file export has no import map to
    # resolve. Anchored to a real statement — the prose above explains this and would match a bare substring.
    @test !occursin(r"^\s*import\s"m, js)
    @test !occursin(r"^\s*export\s"m, js)
    # The wire/sync/destroy contract core calls.
    @test occursin("wire:", js) && occursin("sync:", js) && occursin("destroy:", js)
    @test occursin("Plotly.purge", js)                # destroy frees the plot before the node is discarded
    # `react`, not `newPlot` — diffing preserves the reader's zoom/pan across a reactive re-render.
    @test occursin("Plotly.react", js)
    @test !occursin("Plotly.newPlot", js)
    # The queue is gone: core re-wires late-registering kinds itself.
    @test !occursin("__slatePlotlyQueue", js)
    # The library URL is injected, never hardcoded — that indirection is what lets the export inline it.
    @test occursin("window.__slatePlotlySrc", js)
    @test !occursin("/ext-assets/", js)
    @test !occursin("cdn.plot.ly", js)
end

@testset "bind events" begin
    js = SP._WIDGET_JS
    @test occursin("plotly_click", js) && occursin("plotly_selected", js) && occursin("plotly_hover", js)
    # A click commits now; hover is continuous and must go through the throttled path, or a moving cursor
    # floods the kernel.
    @test occursin("api.push", js) && occursin("api.schedule", js)
end

@testset "replay routing + N-d slices" begin
    js = SP._WIDGET_JS
    # `@replay` and `ReplayArray` live in Slate — this package's only share is noticing one in a figure
    # and knowing the Plotly call that applies a new slice.
    @test !occursin("macro replay", read(joinpath(@__DIR__, "..", "src", "SlatePlotly.jl"), String))

    # A figure with no replay data carries an empty route list, so nothing about the offline path costs
    # anything until it is used.
    @test _desc(_fig())["props"]["replay"] == Any[]

    # Slices are stacked along the LAST dimension and the buffer is column-major, so one control value is
    # a contiguous run — the client takes a view, never a gather, however large the data.
    @test occursin("subarray", js)
    # A 2-D slice (a heatmap `z`) must be handed to Plotly as ROWS; column-major means (r,c) sits at
    # c*rows + r, so it transposes on the way out rather than shipping a second copy.
    @test occursin("x * rows + y", js)
    # It only takes over where there is no kernel — live, Julia recomputes and this must stay out of it.
    @test occursin("isLive()", js)
    @test occursin("Plotly.restyle", js)
    # The export renders controls disabled; enabling is the client's job, and only for what it can drive.
    @test occursin("input.disabled = false", js)
end

@testset "theme contract" begin
    js = SP._WIDGET_JS
    # The palette must come from the SAME CSS custom properties the ECharts theme reads, or a Plotly figure
    # and an echart in one notebook disagree.
    for v in ("--text", "--dim", "--border", "--bg2", "--accent", "--green", "--orange",
              "--purple", "--teal", "--gold", "--red")
        @test occursin(v, js)
    end
    @test occursin("template", js)                    # applied as a template, so author settings win
    # Hover labels are the exception: Plotly takes a label's background from the TRACE colour unless the
    # LAYOUT overrides it, and a template loses that — which showed up as a pale box with dark text on a
    # dark page. So `hoverlabel` is set on the layout itself, still yielding to an explicit one.
    @test occursin("l.hoverlabel = t.hoverlabel", js)
    @test occursin("bordercolor", js)                 # else the outline stays the trace colour
    @test occursin("rgba(0,0,0,0)", js)               # transparent, matching the ECharts theme
    @test !occursin("#ffffff", js)
    # Re-themes by observing the attribute, NOT by hooking the global core.js owns and replaces.
    @test occursin("MutationObserver", js) && occursin("data-slate-theme", js)
    @test !occursin(r"_onSlateThemeChange\s*=", js)
end
