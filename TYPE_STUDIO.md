# Type × Geometry Studio — v9.4 vector artwork workflow

Open `?studio=type` on GitHub Pages or the local app/preview server, or use **TYPE + GEOMETRY** in the Layout header. Studio recipes have their own storage key (`dssc-type-geometry-studio-v1`). The explicit DSSC handoff copies reference/process inputs into a separate trial without overwriting the original Layout reference.

## Scope and status

This milestone resolves actual **artwork geometry**, independently of electrical cell count. It does not start with electrode Voronoi polygons. Letters, geometric masks and the optional character enter the same closed-region boolean pipeline.

The Studio SVG and geometry JSON remain **artwork exports**, not electrode fabrication files. Use **DSSC Layout ↗** at the top right to transfer the resolved shape set into a separate patterned-electrode trial. That route now carries real contours, holes and the recipe, not only seed / cells / jitter. Layout then constructs the actual coating, adhesive and channel geometry and gates manufacturing exports on its checks.

## Two independent flavors

- **A / Continuous form:** Soft Squeeze, Shape Flip, Tall Press, Capsule Rhythm (linked type carriers or headline / capsule weaving). Shared smooth deformation and a 3×3 editable cage; no pixel-grid operation.
- **B / Stepped geometry:** Stepped Type, Offset Cuts, Block Ground. Global physical-grid sampling, horizontal-run union, seeded slice displacement / notches and stepped backing. No Unicode combining-mark noise is added.

Each flavor preserves its recipe separately: text, bundled / imported font, page dimensions, layout, deformation, mask, character, edits and seed. Presets deliberately reset the active flavor's style settings while retaining its text, page dimensions and character state. Merely switching flavor restores the saved recipe.

## First use

1. Choose a flavor and preset. Type up to six lines of English, digits and punctuation (120 characters total); line breaks remain explicit.
2. Choose **Anybody Black**, **Anton** or **Fraunces Black**. These are bundled local WOFF assets, not system-font fallbacks. An optional OTF / TTF / WOFF under 3 MB can be loaded; imported font bytes are embedded in saved recipe JSON. WOFF2 is not supported by the import control.
3. Use the canvas tools:
   - **整體變形:** drag the nine cage handles; global source-based deformation, without cumulative coordinate drift.
   - **行高:** drag a row divider; redistributes height between the two adjacent rows.
   - **字母:** click / drag a glyph, then adjust its rotation or scale in the left panel. Text or font edits reset individual glyph edits.
   - **遮罩 / 角色:** drag to position the enabled element; size and boolean mode are in the sidebar.
   - **拖移:** pan; middle-drag also pans in any tool. Wheel zoom is cursor-anchored, Fit / double-click resets the view.
4. Generate six deterministic variants. Font and text remain fixed; layout and mask can be locked. Character randomness uses its own seed and is never consumed by layout generation. Toggling the character or regenerating it does not reset any type or layout settings.
5. Save a recipe, outlined SVG, geometry JSON, or a PNG viewing image (1600 px on its longest side). The PNG is not a print TIFF / process-calibrated bitmap. Open the recipe to restore both flavors. Undo / redo includes full drag transactions; shortcuts are Cmd/Ctrl+Z and Shift+Cmd/Ctrl+Z outside text fields.

On desktop the sidebar and canvas/results scroll independently. On a narrow screen use **參數** to open or close the settings.

## Capsule Rhythm — typography-aware layout

Capsule Rhythm now uses the selected font and text, rather than a fixed pattern of twelve pierced capsules. Select one of three starting layouts in the **CAPSULE / 字形與膠囊共排** panel:

- **字行包覆:** each explicit line receives a capsule carrier. The row weights, line gap, capsule gap, stagger and seeded length variation determine the carrier and its actual text frame together.
- **字詞拼版:** split text on whitespace and reflow words into the chosen maximum number of capsules per row. Word-length allocation interpolates between equal widths and widths proportional to the chosen font's advances (including tracking). At most six rows are supported; an excessive layout reports an error instead of dropping words.
- **條帶交織:** retain the whole-poster headline and compose it with configurable tracks and segments. Horizontal / vertical orientation, spacing, stagger, length variation and roundness control the carrier field. Text remains part of the resolved boolean result.

Controls common to the layouts: orientation, gap in mm, stagger, length variation, roundness and an independent rhythm seed. Fitted layouts also expose text padding, rounded-end following and (with multiple columns) font-based width allocation. Weaving exposes track and segment counts. Only controls relevant to the current layout are shown.

The carrier / type composition is an actual difference (text knockout), XOR, intersection, or outlined carriers united with the type. Rounded-end following contracts the letterfield according to the capsule's inner rounded rectangle; it deforms the glyph contours before boolean resolution rather than clipping a live text overlay. Large changes remain an artistic operation, not a guarantee of minimum linewidth or readability.

Choose **膠囊** in the canvas toolbar to move an individual carrier. In fitted layouts the assigned letters move, rotate and scale with it; in weaving layouts moving a carrier recomputes its relation to the whole headline. A selected carrier's rotation and group scale appear in the Capsule panel. Individual glyph edits and the shared 3×3 cage remain available. **行高** drags operate on the actual layout divisions, including X-axis divisions after vertical orientation.

Changing text resets individual glyph and capsule transforms; toggling or reseeding a character leaves them intact. Capsule rhythm uses its own saved seed so the variant layout lock also preserves carrier geometry. Earlier v1 recipes without a `capsule` field receive the new defaults on load; all their other parameters remain intact. Saved recipes include every capsule parameter and group transform.

`npm run test:browser:capsules` specifically exercises type / font coupling, layout controls, word reflow, horizontal / vertical dividers, group drag / rotation, weaving, boolean outputs, variants and persistence, and writes visual comparisons to a fresh temporary folder.

## Geometry contract

- All coordinates and page dimensions are **mm**. A defaults to black and B to white. They partition the physical rectangle; no TiO₂ / Pt role is inferred from color.
- Font contours are converted to explicit polygons with nested holes, then deformed, unioned and boolean-resolved. Curves are flattened at a nominal **0.025 mm source approximation tolerance**; this is not a fabrication tolerance or a bound on the subsequently deformed curves. Nonlinear edits also subdivide long straight edges before deformation.
- Masks perform actual union, subtraction, intersection or XOR. Inversion swaps the resolved A/B sets. “View B” changes only the canvas display; it does not modify export polarity.
- Pixel sampling uses a physical grid and phase. Adjacent samples are merged into regions, not treated as electrical cells. Coarse sampling can close counters; the UI reports reduced counter count at that stage. It does not claim minimum linewidth, all-counter preservation or process readiness.
- Original procedural characters combine lobed bodies, appendages and cutout facial regions. Enabled characters enter the output geometry. The geometry JSON embeds the recipe for provenance; source glyph IDs remain separate from the final merged sets.
- The SVG contains only the outlined A/B geometry, title and status metadata. No `<text>`, raster image, CSS blend effect, clipping mask, selection handle or character-guide overlay is exported.
- Geometry JSON uses `type-geometry-artwork-v1`, explicit `sets.A` / `sets.B`, area statistics, warnings and `stage: resolved-artwork-not-fabrication`. Material / electrical / flow check fields are null.
- A Web Worker resolves geometry and font contours. Pending preview requests are coalesced; previous results cannot be exported under newer parameters. Invalid or unavailable font / layout input disables geometry export while retaining the editable recipe.

## Implementation

| File | Responsibility |
| --- | --- |
| `src/studio/model.ts` | Typed recipes, flavor-local defaults, independent RNG, bounded project parsing |
| `src/studio/fonts.ts` | Bundled fonts and OTF / TTF / WOFF import |
| `src/studio/geometry.ts` | Font flattening, deformation, pixel regions, boolean composition and area accounting |
| `src/studio/engine.ts`, `worker.ts` | Serial worker jobs, preview coalescing and error delivery |
| `src/studio/export.ts` | Outlined artwork SVG, recipe and resolved geometry JSON |
| `src/TypeStudio.tsx`, `src/type-studio.css` | Recipe controls, direct manipulation, undo, variants and local persistence |

Run `npm run test:browser:studio` for a Chrome smoke test; it starts and closes an isolated Vite server unless `APP_URL` is supplied. `CHROME_PATH` and `TEST_TMPDIR` are supported. Screenshots and the test result go to a new temporary directory. Unit tests independently check counters, A/B partition, boolean area identities, seeded edits, character isolation and export contents.

## Patterned W-type integration

1. Set target module Voc and Isc in the Studio's DSSC section, then choose **DSSC Layout ↗**. The current resolved A set and holes are stored as a versioned trial together with the original recipe. It proposes common glass height = source height + 6 mm, smaller width = source width + 6 mm, and bigger width = smaller width + 6 mm. These editable starting dimensions are not physical requirements. The reference current, voltage and process inputs are copied from the saved Layout reference when available; no wet-film measurement is invented.
2. The trial opens **Circuit**, displaying both electrodes with real patterned coating. A is a coating candidate, not a permanently assigned plate/color. TiO₂/Pt alternate by cell order; corresponding regions on the opposite plate supply the counterelectrode. Background space supplies added AB-313 candidates, with explicit coating setbacks and fill/vent cuts.
3. Initial count is the nearest even count to the voltage target. The bounded search compares nearby voltage-compatible even counts up to 48, three seeds, and the current / strongest area-balance settings. A 36×36 density sample guides moving partition sites, while final ranking, current estimates and CV use exact post-adhesive vector areas. Search is local and is not a proof of global optimality. A target mismatch is shown separately from geometry DRC.
4. Added glue is recomputed against the actual print footprint volume model. Internal joins connect clearance-eroded natural chamber cores with a short sampled-boundary spanning tree. Cuts stay within their original convex electrical cavity; only the existing third-cell-checked ports cross electrical-cell walls. The final compressed-adhesive difference is checked for top/bottom connectivity, then eroded to check clearance access to each coating fragment. `flow.pass` covers these **undirected connectivity / width checks** only. `monotoneDownwardVerified` is explicitly false: strictly downward paths for every cavity, capillary kinetics, air evacuation and bubble-free filling remain unverified.
5. `fabrication.activeShapes` is the canonical per-cell multi-polygon coating source. `activeRegions` remains the legacy convex planning envelope. SVGs, 3D footprints, DXF hole hatches, area/current accounting and the four material masks use `cellCoating()` / `activeShapes`. FTO checks test the complete fragments against the correct retained conductor island, rather than assuming a single centroid represents patterned coating.
6. Both normal Layout and pattern vector packages now contain **25 files**. Complete packages contain **37**, including **8 PDFs** and **4 true 1-bit 1200-DPI TIFFs** (bigger/smaller 18NR-T TiO₂ and PT-1 Pt), plus a dual-plate material-distribution SVG. All four masks are also individual views/downloads. Patterned manufacturing export is blocked for missing checks, empty cells, invalid glue-volume scenarios, insufficient clearances, bad FTO membership or inaccessible coating fragments. Passing geometry checks is not an experimental validation of efficiency or fabrication yield.

Trials use `dssc-vector-transfer-v1-<id>` records, preserve the original `w-series-voronoi-layout-v6` settings, and retain their own edited configuration on reload. The last few trials remain available. Missing / malformed trial links show an explicit transfer failure rather than silently loading an ordinary Voronoi design. The Studio's source recipe remains independent of Layout edits. Exported `design.json` includes `config.artwork`, actual coating shapes and the pattern report; `process-estimates.json` includes the same report and area/electrical basis.

`npm run test:browser:pattern` exercises the real header handoff, both material assignments, outlined area / hole painting, DXF, vector/complete packages, actual TIFF pixels, process-error export gates, reload and source isolation. Test-only synthetic wet-film calibration is confined to an isolated browser profile. New modules are `artwork-source.ts`, `pattern-fabrication.ts`, `design.ts`, `layout.worker.ts` and `PatternPanel.tsx`.
