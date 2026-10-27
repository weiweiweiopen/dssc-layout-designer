import type { Locale } from "../i18n";

/** Boundary catalog: canonical engine strings stay untouched in design/export
 * data. Known diagnostics resolve to stable codes and captured values for UI. */
export const fixedDiagnostics = {
  "mesh-wire": ["網版線徑必須小於 mesh pitch。", "Screen wire diameter must be smaller than the mesh pitch."],
  "bead-percentiles": ["玻璃珠 D90 不可小於 D50。", "Bead D90 must not be smaller than D50."],
  "bead-passage": ["網版開目小於 3 × 玻璃珠 D90，可能濾珠／堵網。", "Screen aperture is below 3 × bead D90; beads may be filtered out or clog the mesh."],
  "print-resolution": ["此網版解析度與電池數無法容納膠線下限。", "This screen resolution and cell count cannot accommodate the minimum adhesive width."],
  "fill-network": ["無法建立讓每個子電池由上進液、向下排氣的通道。請降低面積平衡／開口／Binding Width 或 Cell Jitter。", "Cannot provide every subcell with top-inlet and bottom-vent access. Reduce area balance, aperture, Binding Width or Cell Jitter."],
  "coating-target": ["Coating Safety Gap 必須為有限且不小於 0 的平面距離。", "Coating Safety Gap must be a finite planar distance of at least 0."],
  "coating-clearance": ["塗層與 AB-313 的實際多邊形間距小於要求的安全距離／對位餘量，請檢查膠版與塗層幾何。", "Coating-to-AB-313 polygon clearance is below the required safety/registration budget. Check seal and coating geometry."],
  "seal-volume": ["印膠體積無法在指定玻璃間隙內容納，壓合模型不成立。", "Printed adhesive volume cannot fit at the specified glass gap; the compression model is invalid."],
  "opening-film": ["開口設計情境的膠層／間隙不相容，不能據此推算壓合後孔寬。", "Opening-scenario film and glass gap are incompatible; pressed aperture cannot be inferred."],
  "opening-floor": ["實際製版開口小於指定的製版孔寬下限。", "Generated stencil aperture is below the specified print-gap floor."],
  "opening-closed": ["壓合包絡下至少一個通道小於設定淨寬／已閉合；請加大開口或修正實測厚度與側向擴散餘量。", "At least one scenario channel is below the requested clearance or closed. Increase openings or correct measured film/growth allowances."],
  "no-active-area": ["至少一個子電池扣除封膠、對位與 FTO 蝕刻後沒有可用 active area。", "At least one subcell has no usable active area after seal, registration and FTO-etch clearance."],
  "terminal-short": ["6066 正負接觸條存在 FTO 直通短路（包括玻璃外圈旁路）。", "Bigger-electrode positive and negative contact strips are shorted through retained FTO, including possible perimeter bypasses."],
  "etch-limit": ["FTO Etch Width 上限為 5 mm。", "FTO Etch Width has a 5 mm upper limit."],
  "laser-order": ["雷射需滿足 0 < hatch ≤ spot ≤ FTO Etch Width，才能填滿且不超出切除區。", "Laser settings must satisfy 0 < hatch ≤ spot ≤ FTO Etch Width to fill the removal area without overscan beyond it."],
  "laser-short-path": ["至少一段蝕刻線短於光斑，雷射填滿會超出名義端點；請縮小光斑或調整 seed / jitter。", "An etch segment is shorter than the laser spot. Fill would exceed its nominal endpoints; reduce the spot or adjust seed/jitter."],
  "bigger-size": ["6066 玻璃的寬高必須是有限且大於 0 的數值。", "Bigger-electrode width and height must be finite and greater than 0."],
  "smaller-size": ["6060 玻璃的寬高必須是有限且大於 0 的數值。", "Smaller-electrode width and height must be finite and greater than 0."],
  "contact-exposure": ["Bigger Electrode W 必須大於 Smaller Electrode W，才能在左右兩側保留斑馬條接觸區。", "Bigger Electrode W must exceed Smaller Electrode W to leave exposed zebra-contact areas on both sides."],
  "shared-height": ["兩片電極必須使用同一 Shared Glass Height，並上下齊平。", "Both electrodes must use the same Shared Glass Height with aligned top/bottom edges."],
  "overlap-size": ["兩片玻璃的重疊區必須具有有限且大於 0 的寬高。", "The glass overlap must have finite, positive width and height."],
  "active-size": ["Binding 內縮後沒有正尺寸的有效區，請縮小封框寬度或增加重疊尺寸。", "Seal inset leaves no positive active envelope. Reduce adhesive width or increase glass overlap."],
  "binding-positive": ["Binding 寬度必須是有限且大於 0 的數值。", "Binding Width must be finite and greater than 0."],
  "binding-frame": ["Binding 外框為玻璃交集，Voronoi / FTO frame 必須內縮 bindingWidthMm/2，印膠腔室再內縮另一半；不可重複加寬。", "The outer seal follows the glass overlap. Voronoi/FTO frame and printed cavities each reserve half of Binding Width; do not count it twice."],
  "cell-count": ["子電池數量必須是至少 2 的整數。", "Subcell count must be an integer of at least 2."],
  "even-count": ["子電池數量必須是偶數，才能讓正、負外部接點都位於 6066 玻璃。", "Subcell count must be even so both external terminals lie on the bigger electrode."],
  "etch-positive": ["FTO 蝕刻寬度必須是有限且大於 0 的數值。", "FTO etch width must be finite and greater than 0."],
  "cell-count-mismatch": ["幾何中的子電池數量與設計設定不一致。", "Geometry subcell count does not match the design settings."],
  "missing-series-edge": ["至少一組相鄰電氣序列子電池缺少連續的串聯共邊。", "An adjacent pair in electrical order is missing a continuous shared series edge."],
  "series-alternation": ["串聯共邊的連接玻璃或對側蝕刻玻璃不符合交替規則。", "A shared series edge uses the wrong connecting or opposite etched plate."],
  "nonseries-etch": ["非連續鄰接共邊必須在兩片玻璃上都進行 FTO 蝕刻。", "Non-series shared edges must be FTO-etched on both plates."],
  "material-alternation": ["子電池的 TiO2／Pt 玻璃配置不符合電氣序列交替規則。", "Subcell TiO₂/Pt plate assignment violates electrical-order alternation."],
  "terminal-material": ["端點材料或玻璃不符合規則：負端起於 6066/TiO2，偶數序列正端須終於 6066/Pt。", "Terminal material/plate assignment is invalid: negative starts on bigger-plate TiO₂ and an even series ends on bigger-plate Pt."],
  "terminal-span": ["第一個與最後一個子電池必須分別在有效區左、右邊界擁有正尺寸跨度。", "First and last subcells must own positive spans on the left and right envelope edges."],
  "strip-height": ["6066 玻璃左右外露接觸條必須具有正尺寸並涵蓋玻璃完整高度。", "Bigger-plate exposed contact strips must have positive size and span the full glass height."],
  "gate-span": ["每個端子 gate 必須等於端點子電池在 facing side 的完整最大跨度，接點須對齊其中點。", "Each terminal gate must match the endpoint cell's full owned facing-side span, with the contact at its midpoint."],
  "active-perimeter": ["有效區周界必須是 active 矩形的完整四邊。", "The active envelope reference must contain all four rectangle sides."],
  "canonical-etch": ["canonical etchPaths 只能包含選定的Voronoi邊界與端點出血延伸；不可附加周界蝕刻框，且必須保留6066端點引出。", "Canonical etchPaths may contain only selected Voronoi edges and endpoint bleeds, without an extra perimeter frame; bigger-plate terminal exits must be retained."],
  "electron-order": ["電子路徑必須由負端依序通過每個 Voronoi 站點後到達正端。", "The electron route must visit every Voronoi site in order from negative to positive."],
  "fabrication-calibration": ["FTO 蝕刻與封裝尺寸仍須依材料、設備及實際試片進行校正。", "FTO etching and sealing dimensions still require calibration against your materials, equipment and coupons."],
  "screen-collapsed": ["至少一個 Screen cell 在 Binding 內縮後沒有可用的 TiO2 印刷區。", "At least one screen cell has no usable TiO₂ print region after the seal inset."],
  "pointcode-density": ["Point Code 過密，至少一個非空白字元沒有可用點位或共同尺度。", "Point Code is too dense: a non-space character lacks usable sites or a shared scale."],
  "pointcode-outside": ["至少一個完整 Point Code 圓孔超出所屬 TiO2 Screen region。", "A complete Point Code hole lies outside its assigned TiO₂ screen region."],
  "pointcode-spacing": ["至少一個 Point Code 無法維持圓孔間的最小製造間距。", "A Point Code cannot maintain the minimum manufacturing hole spacing."],
  "reference-inputs": ["請填有效面積與所選光照模式的參考量測；lux 不能直接當 mW/cm²，未配對的 Isc 不會套用網站照度。", "Provide active area and measurements for the selected lighting mode. Lux is not mW/cm²; unpaired Isc does not inherit website illumination."],
  "reference-fit": ["對照 Isc × Rs 已達／超過 Voc，無法以此單二極體情境反推光電流；請核對量測與參數。", "Reference Isc × Rs reaches or exceeds Voc, so this diode scenario cannot recover photocurrent. Check measurements and inputs."],
  "unpaired-observation": ["網站 Voc/lux 與 38–40 mA 沒有同條件 I–V 配對，暫不混合擬合 FTO／MPP；可用面積縮放基準與 FTO 幾何電阻。", "Website Voc/lux and 38–40 mA are not paired under the same I–V conditions. FTO/MPP fitting is withheld; area scaling and geometric FTO resistance remain available."],
  "generation-failed": ["幾何產生失敗。", "Geometry generation failed."],
  "tiff-export-failed": ["網版 TIFF 匯出失敗。", "Screen TIFF export failed."],
  "export-failed": ["匯出失敗。", "Export failed."],
  "preparing-output": ["準備匯出檔案", "Preparing export files"],
  "manufacturing-dxf": ["建立製造 DXF", "Creating fabrication DXF"],
  "galvo-paths": ["建立 Galvo 蝕刻路徑", "Creating Galvo etch paths"],
  "export-complete": ["完成專案 ZIP", "Project ZIP complete"],
  "preparing-tiff": ["準備 1-bit TIFF", "Preparing 1-bit TIFF"],
  "preparing-bundle": ["準備匯出", "Preparing output"],
} as const;

const dynamicDiagnostics: Array<{ code: string; pattern: RegExp; english: (...values: string[]) => string; chinese?: (...values: string[]) => string }> = [
  { code: "underfill", pattern: /^濕膜 (.+?) µm 小於假設間隙 (.+?) µm：膠量不足，壓合孔寬預測不成立；不可將它解讀成零擴散。$/, english: (film, gap) => `Wet film ${film} µm is below the assumed ${gap} µm gap: adhesive underfill invalidates pressed-aperture prediction; do not interpret it as zero growth.` },
  { code: "binding-range", pattern: /^Binding Width 超出此製程幾何範圍 (.+?)–(.+?) mm。$/, english: (lo, hi) => `Binding Width is outside this process/geometry range: ${lo}–${hi} mm.` },
  { code: "binding-limit", pattern: /^Binding 寬度必須介於 (.+?) 至 5 mm；目前為 (.+?) mm。$/, english: (lo, value) => `Binding Width must be between ${lo} and 5 mm; current value is ${value} mm.` },
  { code: "finite-number", pattern: /^(.+?) 必須是有限數值。$/, english: (field) => `${field} must be finite.` },
  { code: "practical-cell-limit", pattern: /^子電池數量超過實務建議上限 (.+?)，請確認最小圖形與製程解析度。$/, english: (count) => `Subcell count exceeds the practical recommendation of ${count}; check minimum features and process resolution.` },
  { code: "jitter-range", pattern: /^electrodeJitter 必須是有限且介於 0 至 (.+?) 的數值；目前為 (.+?)。$/, english: (max, value) => `Cell Jitter must be finite and between 0 and ${max}; current value is ${value}.` },
  { code: "series-generation", pattern: /^無法為 (.+?) 個子電池建立連續的 Delaunay\/Voronoi 電氣路徑。$/, english: (count) => `Cannot create a continuous Delaunay/Voronoi electrical route for ${count} subcells.` },
  { code: "fto-active-removed", pattern: /^(glass-6066|glass-6060) 蝕刻已移除子電池有效區，請縮小 FTO Etch Width。$/, english: (plate) => `${plate}: etching removed a subcell active region. Reduce FTO Etch Width.` },
  { code: "fto-series-connectivity", pattern: /^(glass-6066|glass-6060) 有限蝕刻寬度下 cell (\d+)\/(\d+) 的導通不符合 W 串聯。$/, english: (plate, a, b) => `${plate}: cells ${a}/${b} have incorrect W-series connectivity at the finite etch width.` },
  { code: "terminal-open", pattern: /^Cell (\d+) 未與 (negative|positive) zebra 接觸條連通。$/, english: (cell, side) => `Cell ${cell} is not connected to the ${side} zebra-contact strip.` },
  { code: "strip-broken", pattern: /^(negative|positive) 接觸條的保留 FTO 被切斷／移除，無法形成連續接觸面。$/, english: (side) => `The ${side} contact strip's retained FTO is cut/removed and cannot provide a continuous contact face.` },
  { code: "isolation-height", pattern: /^(glass-6066|glass-6060) 隔離路徑未連續貫穿實際玻璃上、下邊緣。$/, english: (plate) => `${plate}: isolation does not continuously reach both physical glass edges.` },
  { code: "etch-bleed", pattern: /^(glass-6066|glass-6060) Voronoi 出血未到玻璃邊緣，或含多餘周界蝕刻框。$/, english: (plate) => `${plate}: Voronoi bleed fails to reach the glass edge or includes an extra perimeter etch frame.` },
  { code: "production-svg", pattern: /^建立製造 SVG：(.+)$/, english: (file) => `Creating fabrication SVG: ${file}` },
  { code: "production-pdf", pattern: /^建立製造 PDF：(.+)$/, english: (file) => `Creating fabrication PDF: ${file}` },
  { code: "assembly-pdf", pattern: /^建立組裝預覽 PDF：(.+)$/, english: (file) => `Creating assembly-preview PDF: ${file}` },
  { code: "production-tiff", pattern: /^建立 1-bit (\d+) DPI TIFF：(.+)$/, english: (dpi, file) => `Creating 1-bit ${dpi} DPI TIFF: ${file}` },
  { code: "rendering-tiff", pattern: /^Rendering (.+) at 1200 DPI$/, english: (file) => `Rendering ${file} at 1200 DPI`, chinese: (file) => `以 1200 DPI 產生 ${file}` },
  { code: "missing-screen", pattern: /^Screen asset "(.+)" is unavailable\.$/, english: (id) => `Screen asset "${id}" is unavailable.`, chinese: (id) => `網版資產「${id}」無法使用。` },
  { code: "zip-library", pattern: /^Unable to load the ZIP library: (.+)$/s, english: (error) => `Unable to load the ZIP library: ${error}`, chinese: (error) => `無法載入 ZIP 程式庫：${error}` },
  { code: "zip-create", pattern: /^Unable to create project ZIP: (.+)$/s, english: (error) => `Unable to create project ZIP: ${error}`, chinese: (error) => `無法建立專案 ZIP：${error}` },
  { code: "download-api", pattern: /^File downloads require a browser with object URL support\.$/, english: () => "File downloads require a browser with object URL support.", chinese: () => "下載檔案需要支援物件 URL 的瀏覽器。" },
  { code: "adhesive-offset", pattern: /^Unable to resolve adhesive offset polygons\.$/, english: () => "Unable to resolve adhesive offset polygons.", chinese: () => "無法解出膠體偏移多邊形。" },
  { code: "bleed-gate", pattern: /^Voronoi bleed endpoint falls inside a terminal-owned gate\.$/, english: () => "Voronoi bleed endpoint falls inside a terminal-owned gate.", chinese: () => "Voronoi 出血端點落入端子擁有的 gate 範圍。" },
];

export function resolveDiagnostic(message: string) {
  for (const [code, [zh, en]] of Object.entries(fixedDiagnostics)) {
    if (message === zh || message === en) return { code, params: [] as string[], zh, en };
  }
  for (const entry of dynamicDiagnostics) {
    const match = message.match(entry.pattern);
    if (match) return { code: entry.code, params: match.slice(1), zh: entry.chinese?.(...match.slice(1)) ?? message, en: entry.english(...match.slice(1)) };
  }
  return { code: "source-message", params: [] as string[], zh: message, en: message };
}

export function diagnosticText(message: string, locale: Locale) {
  const diagnostic = resolveDiagnostic(message);
  return locale === "en" ? diagnostic.en : diagnostic.zh;
}
