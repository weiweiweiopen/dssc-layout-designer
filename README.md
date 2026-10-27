# DSSC Layout Designer

**W-type series-module geometry and experimental mask generation · v9.3**

**[Open the interactive designer →](https://weiweiweiopen.github.io/dssc-layout-designer/)**

Use a desktop browser; Chrome is the tested reference. Select **EN** at the top right for English. No installation or account is required.

## Purpose

This research tool explores how subcell geometry, FTO isolation and sealing clearances affect active-area utilisation and current matching. It generates coordinated TiO₂ print masks, FTO removal paths and adhesive stencils from one module layout, supporting comparisons before experimental fabrication.

The reference construction uses two glass/FTO electrodes, alternating TiO₂/Pt regions and an AB-313 seal. Printing, registration and electrical inputs should be set from measurements for the process being evaluated.

## First evaluation

The **left panel contains the settings**; the **right panel shows the selected drawing**. Units appear beside each field. Move the pointer over a field name to read its explanation. After editing a number, press **Enter** to apply it.

1. **Define the specimen.** Under **Electrode Glass**, enter the common **Shared Glass Height** and the two electrode widths. The smaller plate is centred within the larger one; the exposed side strips provide the positive and negative contact areas. Set the even **Electrical Cells** count under **Circuit / FTO**.

2. **Compare layouts.** Use **Seed** or **New Seed** to change the partition pattern. Keep process inputs fixed while comparing **DESIGN ACTIVE AREA**, **Min / max cell** and **Area CV**. **Coating Safety Gap** reserves coating-to-seal clearance; **Area Balance** adjusts the partitions to reduce area mismatch while retaining the series path.

3. **Inspect the layers.** Select the tabs above the drawing:

   | View | What to inspect |
   |---|---|
   | **Final Assembly** | Coatings, seal and hatched **± ZEBRA** contact areas, with their dimensions below the drawing. |
   | **Circuit** | Subcell sequence, electron route and terminal connectivity. |
   | **Screen Bigger / Smaller** | TiO₂ print regions on each electrode; black denotes printing. |
   | **Etch Bigger / Smaller** | FTO removal paths and isolation at the glass edges. |
   | **Binding** | Adhesive stencil; black denotes adhesive and white slots provide fill/vent access. |
   | **3D Review** | Registered two-electrode stack, independently colored TiO₂ regions, visible-layer controls and exploded views. |

   In **3D Review**, middle-drag or left-drag to orbit, **Shift + middle-drag** or right-drag to pan, and use the wheel to zoom. Select a dye appearance for each electrode in the right-hand controls. **Explode / interface** separates layers; **Thin-layer scale = 1** removes thickness exaggeration. Colors, opacity and unmeasured thicknesses are illustrative; appearance settings are saved locally, separately from manufacturing parameters.

4. **Download the mask set.** When **DRC pass** appears at the top right, scroll down the left panel to **TiO2 Screens** and select **Complete ZIP: PDF + 1-bit TIFF**. Unzip the download to inspect the files below. If export remains greyed out, read **DRC / Design Check**. **Save View SVG** saves the displayed reference drawing; the ZIP provides the fabrication layers.

## Files for review and fabrication

| Files in the ZIP | Intended use |
|---|---|
| `svg-production/`, `pdf-production/` | Separate TiO₂, FTO-removal and adhesive artwork for process review and fabrication preparation. |
| `bitmap-production/` | Physical-size TiO₂ masks: 1200 DPI, true 1-bit TIFF. |
| `manufacturing-layout.dxf`, `laser-fill/` | CAD geometry and laser-fill paths for adaptation to the available equipment. |
| `svg-layered/`, `pdf-preview/` | Layer and assembly references, including contact annotations. |
| `design.json`, `process-estimates.json` | Parameter record, geometry, cell areas and calculation assumptions for comparing trials. |

**Export Vector ZIP** provides the vector drawings and data without PDF/TIFF. Keep the complete trial package when comparing variants.

File labels `glass-6066` and `glass-6060` identify the **Bigger** and **Smaller** electrodes respectively; dimensions are specified inside the files. Production coordinates are plate-local, viewed from the conductive side. The smaller electrode is horizontally mirrored by default, as recorded in the export.

## Interpreting the results

For the area-based estimate, series current is limited by the smallest active subcell under uniform illumination and equal current density. Use a reference cell's measured current, active area and matching illumination conditions; lux alone does not establish irradiance or spectral equivalence.

**Compression scenario (preview)** displays an assumed adhesive-growth condition. It helps examine the clearance budget; the production seal remains the printed stencil. FTO and I–V/MPP scenarios likewise require calibration to measured devices. **DRC pass** reports the implemented geometry checks; process yield, indoor energy yield and stability are experimental outcomes.

Equations, reference data and parameter assumptions are documented in **[Process model](PROCESS_MODEL.md)**.

---

[Software setup and deployment](DEVELOPMENT.md) · [Third-party notices](THIRD_PARTY_NOTICES.md)

Settings are stored in your browser; calculations and downloads run locally. Third-party notices apply to their named materials and dependencies, without granting a project-wide licence.
