# W-Series DSSC Layout v9.2

W-type DSSC 互動式製作檔工具：TiO2 網版、雙面 FTO 蝕刻、AB-313 封膠網版、雷射填滿掃描路徑與組裝預覽。所有尺寸以 **mm** 表示。

## 直接使用 / Open the interactive designer

**[開啟線上 v9.2 編輯器 / Launch the live app](https://weiweiweiopen.github.io/dssc-layout-designer/)**

首頁就是可操作的中英文版型編輯器：調整參數、預覽各圖層，並下載 SVG、DXF、雷射路徑 JSON、PDF 及 1200 DPI 1-bit TIFF。使用「匯出向量 ZIP」或「完整 ZIP：PDF＋1-bit TIFF」取得製造包。所有計算與檔案產生在瀏覽器內完成，參數及語言偏好存在自己的瀏覽器。

The home page is the working Traditional Chinese / English editor. Edit parameters, inspect layers and download SVG, DXF, laser-path JSON, PDF and 1200 DPI 1-bit TIFF. Use **Export Vector ZIP** or **Complete ZIP: PDF + 1-bit TIFF**. Geometry and downloads are generated client-side; settings and language preferences stay in your browser. Desktop Chrome is used for the complete export smoke test.

## Build and deploy

Use Node.js 24 (`.nvmrc`):

```sh
npm ci
npm test
npm run build
npm run preview -- --host 127.0.0.1
```

GitHub Actions builds from `main`, runs the unit tests and publishes `dist/` through GitHub Pages. The workflow is `.github/workflows/pages.yml`; repository **Settings → Pages → Source** uses **GitHub Actions**. Relative Vite asset paths support the `/dssc-layout-designer/` project URL and the local macOS server.

On shared CI runners the complete test suite runs sequentially with a 30-second per-test budget for the 60–64-cell numerical cases.

Browser/export verification against the public page:

```sh
APP_URL=https://weiweiweiopen.github.io/dssc-layout-designer/ npm run test:browser
```

Set `CHROME_PATH` for a nonstandard Chrome installation; `TEST_TMPDIR` can select a download-test directory. The test uses an isolated browser profile. It exercises both languages, parameter changes, contact/clearance geometry, production ZIPs, PDF and true 1-bit TIFF downloads.

`dist/` is also checked in for the existing portable packager. After intentionally rebuilding it, run `npm run manifest:dist`; verify it with `npm run manifest:dist -- --check`. The previous portable launcher source remains in `portable/`; the published [v0.1.0 macOS release](https://github.com/weiweiweiopen/dssc-layout-designer/releases/tag/v0.1.0) and its [original packaging instructions](https://github.com/weiweiweiopen/dssc-layout-designer/blob/64b9570/README.md) describe the earlier desktop release.

Third-party notices are in `THIRD_PARTY_NOTICES.md` and `DEPENDENCY_LICENSES.txt`; they apply to the attributed dependencies, not a license grant for this project as a whole.

## v9.2：內建繁中／English 介面

右上角 **繁中／EN** 即時切換同一個app的兩套介面文字，包含各系統／參數名稱、選項、所有懸浮說明、圖例、面積／製程／電性讀值、DRC及匯出進度。第一次預設繁中，後續記住所選語言。

語言獨立存於localStorage `dssc-layout-language`，不寫入DesignConfig；切換保留參數、種子、分頁、相機縮放／平移與膠體階段，也不提交正在編輯中的數值草稿。Reset只重設設計，不清除語言偏好。`document.lang`與頁面標題同步更新，按鈕帶有語言與選取狀態。

`src/i18n.tsx`提供共用語系context，`src/locales/en.ts`／`zh-TW.ts`以型別檢查保持介面字典一致；參數名稱／說明在`src/locales/parameters.ts`及既有`parameter-help.ts`中配對。動態提示明列兩語內容。DRC在介面邊界由`locales/diagnostics.ts`解析成穩定代碼與數值參數，再顯示所選語言；計算引擎的原始訊息與幾何不改寫。

製造及參考文件沿用固定工程欄位、標號與格式，介面圖例提供所選語言解釋；語言不是製程參數。瀏覽器回歸驗證中英文向量包逐檔位元組相同，並檢查語言切換保留版型／相機／草稿及重新整理後的偏好。新增語系需同時補齊字典、參數提示與診斷目錄。

## v9.1：固定安全距離、移除塗層比例裁切

舊版 Area Balance 在移動 Voronoi 生成點後，還將較大塗層朝中心等比例縮小。各邊因此產生不同退讓量，犧牲有效面積來湊面積，造成白邊寬度不一致。此步驟已移除。

新增 **Coating Safety Gap**（預設0.10 mm，可調設計起點，非材料安全規格）。所有cell對同一膠牆分區作**相同法向距離的平行內縮**，填滿固定凸形分區中符合各牆退讓限制的範圍；保留注液槽及其他製造約束，不再逐cell縮放。TiO₂與Pt使用同一有效幾何，Assembly、網版、DXF及電流估算一致更新。

設印刷膠寬B、開口設計情境的膠體單邊成長s、對位餘量r、安全淨距離c，統一內縮距離為：

`d = max(B/2 + s + r + c, etchWidth/2 + r)`。

因此印刷膠邊的要求淨距離為`s+r+c`，情境膠邊要求為`r+c`；扣除對位預算後仍保留c。這裡的s沿用實測濕膜／滿載網版情境及顯式製版餘量，沒有把未量測膠體成長假裝成0。若較大蝕刻退讓主導，塗層間距可能更大。轉角、結點與開槽附近的視覺留白可不同，法向最小距離需看實際多邊形量測。

**Area Balance** 現在只調整分區生成點，接受移動前重檢串聯鄰接與端子歸屬；評分依安全內縮後的面積，兼顧變異、最小cell及總面積。每輪候選亦檢查實際有限切寬的保留FTO連通及雷射光點可容納的最短路徑，輸出採用通過檢查的最佳候選。1代表較強局部平衡，不保證精確等面積或全域最大值，也不再以裁小塗層達成0% CV。

軟體幾何比較：70／60 mm、H60、6 cells、seed4361322、膠寬1 mm、140 threads/in、14 µm線徑、其餘預設，舊圖總有效面積2136.6 mm²／最小280.09 mm²；新版約2534.7／374.98 mm²。每cell實際印刷膠邊最小間距約1.2133 mm，情境間距約0.2000 mm（0.1安全值+0.1對位預算）。此例的名義濕膜不足警示仍成立；幾何一致不代表已驗證配方。

介面顯示 **MIN COATING GAP**，`fabrication.coatingClearance`與`process-estimates.json.coatingClearance`保留要求值、統一內縮值、印刷／情境實際最小距離及逐cell量測。距離以點／線段歐氏距離及交集檢查重算；不足時報錯。JSON格式仍為v9，舊設定缺少新欄位時補0.1 mm設計起點。

## v9.0：共同玻璃高度與斑馬條接觸區

**Electrode Glass** 現在只有三個尺寸輸入：`Shared Glass Height`、`Bigger Electrode W`、`Smaller Electrode W`。兩片共用 `glassHeightMm`，上下齊平，小片水平置中；不再有兩個獨立高度。大片寬度必須大於小片寬度，否則沒有左右外露接點，DRC 會報錯。

每側外露寬度為 `(Bigger W − Smaller W) / 2`。預設 66／60 mm、共同高度60 mm時，左右各為 **3×60 mm，180 mm²**；改為70／58 mm、共同高度64 mm時，左右各為 **6×64 mm，384 mm²**。

**Final Assembly** 在左負極、右正極的外露保留FTO加上斜線與 `− ZEBRA`／`+ ZEBRA` 標示，下方 **ZEBRA CONTACTS** 區塊列出尺寸、可接觸面積及開路／不可用狀態。面積由端子外露矩形與 `retainedFto` 實際多邊形求交，不會把蝕刻掉的部分算成可接觸面。圖示代表可放置斑馬條的FTO範圍，不是已指定斑馬條本體的壓接尺寸。

斜線與標號為 `GUIDES_NON_PRINTING` 組裝參考，會出現在Assembly SVG／PDF，並隨印膠／壓合預覽保留相同位置；正式TiO2、Binding及FTO加工圖沒有這些標示。白色頁面仍代表實際玻璃外緣。

JSON格式升為 `w-series-dssc-project-v9`：尺寸只匯出 `glassHeightMm` 及兩片寬度；接觸區參考另存於 `zebraContactReference` 與 `process-estimates.json.zebraContacts`。舊設定優先採已有共同高度；若只有舊欄位，採大片高度，大片缺失才採小片高度。舊高度不同時統一到大片高度，原先兩個高度欄位不再匯出；其他自訂參數保留。

## v8.4：55×55 mm 實測對照與 A 樣品的電壓觀測

參考有效面積已由使用者確認為 **55×55 = 3025 mm²**。預設以使用者回報的 **38–40 mA**（39±1）估算同參考光照下的串聯電流區間：`Istring ≈ min(cell area) / 3025 × Iref`。例：截圖的最小 cell 280.09 mm² 對應 **3.52–3.70 mA**，中央值約 3.61 mA。這是大電池端電流的面積縮放初估，未校正小電池集流改善、前後照光差異與製程差異，不是成品保證。

採用 [網站較早的 DSSC 55×55 A](https://weiweiweiopen.github.io/solar-oracle-walkman/data/green_proofs_are_not_always_about_tax_write-offs_1/status.json)，不是較晚 B：A 自 2026-09-03 開始，B 自 2026-10-13 開始。2026-10-26 00:15（+08:00）快照中，A 有 10127 筆有效／3390 筆排除觀測，B 有 4410 筆有效觀測。

| A 的觀測基準／日期 | 可比 Voc | 網站 Voc 保留率 |
|---|---:|---:|
| 09/03–09/06 早期基準 | 497.1 mV | 100% |
| 09/04 完整日 | 497.4 mV | 100.060% |
| 10/01 完整日 | 491.675 mV | 98.909% |
| 10/24 完整日 | 332.0 mV | 66.787% |
| 10/25 完整日 | 328.625 mV | 66.108% |

早期基準的參考條件是 **942.5 lux、29.73°C**；網站可比條件篩選為照度±10%、溫度±2°C。完整日的 Voc 是**匹配資料先取每小時中位數，再對各小時中位數取中位數**；已用公開逐筆 CSV 獨立重算以上四個完整日，與網站一致。日表的 `lux_median` 是全日有效資料的中位數，不能當作 `comparable_voc_mV` 的同步照度；介面與匯出保留這項區分。拔除期間依來源排除，缺測不內插；日期是觀測日期，不代表製造後年齡。

**這些是 Voc／lux 紀錄，沒有同步 Isc。** 38–40 mA 來自使用者的通常值，不來自此 CSV。不能把 942.5 lux 當作這個電流的已知量測照度、不能由 lux 直接得到 mW/cm²，也不能把 66.108% Voc 保留率當作 Isc／功率保留率。

介面提供：
- **Use DSSC 55×55 A reference**：套用 3025 mm²、39±1 mA、早期 Voc 與同參考光照模式。
- **Voltage Observation**：選早期／後期 A 的電壓觀測，保留來源與日期；電流不套用電壓衰退係數。
- **Reference Light Mode**：預設 Same as Isc reference（比值1，指量到 38–40 mA 的未知光照，不是自動指網站 lux）；亦可明確輸入實測 mW/cm² 比值，或在同光譜／幾何下輸入 Isc 同步 lux 作比例近似。未提供電流同步 lux 時不回退網站 Voc 的 lux。
- 選網站電壓時，不與未配對 Isc 混合反推 I–V、FTO Isc 或 MPP；FTO 幾何電阻仍可查看。同條件的手動 Voc／Isc 輸入可使用原先的未擬合情境。

快照與 SHA-256 保存在 `src/reference-data.ts`，也隨 `process-estimates.json` 的 `electrical.voltageObservation` 匯出。`reportedSourceCsvSha256` 是網站聲明的來源 logger CSV 雜湊；公開 CSV 加入品質／樣品欄位後位元組不同，另存獨立下載核對的 `publishedCsvSha256`，兩者不混用。預設同參考光照模式的 `effectiveJscMaCm2`（@100 mW/cm²）與 `calibration.referenceIrradianceMwCm2` 為 null，避免把未量測輻照度當成已知。舊設定只把原本未知的參考面積0遷移成3025；自訂非零面積與手動電壓保留。

## v8.3：整片電流校正與雙片 FTO 損失情境（歷史）

先前的 42.01 mA 雖然確實取最小 cell（280.09 mm²），卻以示例 `15 mA/cm²` 當作該製程的真實 Jsc；軟體幾何正確不能驗證這個輸入。現在預設 **Current Basis = Reference cell (mA)**，提供整片對照單電池的 Isc、有效面積、量測照度與獨立的對照 Rs。39 mA 是使用者 38–40 mA 的中間示例；有效面積預設 0（未知），**不產生電流、不套用舊 Jsc，也不假定玻璃外形就是有效面積**。已有版型及舊 Jsc 保留，選 Intrinsic Jsc 才使用該值。

若且僅若對照樣品有效面積是 3600 mm²、同照度下為 39 mA，則面積縮放的最小 cell 電流是 `39 × 280.09 / 3600 ≈ 3.03 mA`，不是 42 mA。這仍是同製程、同光譜、均勻照明的面積基準，不是完整成品 I–V。

兩片電極可各自選 **TEC7、TEC8、TEC10、TEC15、TEC20 或 Custom**。依 [NSG 原廠 GL058，March 2024，p11](https://assetmanager-ws.pilkington.com/fileserver.aspx?cmd=get_file&ref=GL058&cd=cd)：

| 規格 | 典型 Ω/□ | 原廠表上限 Ω/□ |
|---|---:|---:|
| TEC7 | 7 | <8 |
| TEC8 | 8 | <9 |
| TEC10 | 10 | <11 |
| TEC15 | 13 | <14 |
| TEC20 | 19 | <20 |

手動更改方塊電阻會切成 Custom。典型值不等於這批燒結後量測；切換品級只模擬電阻，未模擬透光／haze 差異。

**FTO Rs scenario** 依每個 cell 的有效面積、串聯共邊／端子 gate 的寬度及退讓距離，用均勻集流的等效條帶估算，雙片各計一次。不是 2D 電流分布求解，未包含窄頸、接觸、Pt、電解液與界面電阻。**FTO Isc scenario / MPP scenario** 再以單二極體 forward branch 求電壓與功率；a=50 mV 為可改的未擬合示例，無逆偏／shunt 解。若到最弱光電流上限仍未得到 V=0，回傳上限並記錄 `photocurrentCapped`／殘餘電壓。

對照電流若含自身串聯損失，需填獨立的 Reference Series Rs 才能做情境去嵌入；預設 0 暫忽略這個損失，可能重複計入已有電阻損失，明示 **UNFITTED**。不能由 TEC 品級、Voc 與一個 Isc 唯一預測真實 DSSC I–V。串聯電阻常先降低填充因子／功率，未必大幅降低 Isc，依據見 [PVEducation — Series Resistance](https://www.pveducation.org/pvcdrom/solar-cell-operation/series-resistance)。

匯出 `electrical.iscMa`／`cellIscMa` 為面積基準；含 FTO 的結果在 `electrical.scenario`，逐 cell／雙片等效電阻明細在 `electrical.fto.paths`，輸入與去嵌入狀態在 `electrical.calibration`。製造幾何不因電阻或電性校正輸入而改變。

## v8.2：角色命名、逐項提示與串聯電流核查（歷史）

尺寸欄位改為 **Bigger Electrode W/H** 與 **Smaller Electrode W/H**，預覽分頁與下載按鈕使用相同角色名稱。現有設定鍵、SVG ID 與匯出檔名仍保留 `6066`／`6060` 作相容識別，分別對應較大／較小電極，不再拿固定尺寸當介面名稱。

每個數值欄位的名稱、輸入框及結果項都可移入顯示繁體中文說明；鍵盤聚焦也會顯示，Escape 關閉。說明包括用途、單位、修改的影響、來源與假設；移除各系統底下的常駐長段落。提示浮在側欄外，不占表單高度。參數先保留，供逐項討論必要性。

`Cell Jsc @100` 是**單一子電池**的參考電流密度，串聯 Isc 取逐 cell 電流的最小值，非累加。原有公式已採最小有效面積；現在另列限制 cell 編號與面積，移入 Series Isc 顯示代入數值、mm²→cm² 與光強比例。`process-estimates.json` 保存逐 cell Isc、限制 cell 與資料來源。

玻璃珠 D50／D90 是**同一批珠的累積粒徑分布百分位**，分別為 50%／90%，不是兩種珠；百分比基準依供應商報告（例如體積分布），不能直接假定為顆數。D90 不等於最大粒徑。D50 暫作 gap 假設、D90 作過網／解析度檢查；兩者需分別核對實測資料。

## v8.1：Binding與Assembly共用膠體階段

先前Binding預設印刷膠版，Assembly卻固定使用膨脹後的情境包絡，造成兩頁看起來不一致。現在兩頁預設共用同一份`sealPrint`，膠體均以黑色顯示；同一個「壓合情境」開關會跨分頁保留，開啟時兩頁都使用`sealAssembled`情境包絡，明示非實測。

Assembly的TiO2／Pt塗層灰色區不會隨視圖切換改形；白色退讓區代表未塗層／未施膠空間，不是另一圈膠。圖例列出AB-313、TiO2、Pt及白色留空區。切換情境只影響預覽；製造Binding與預設assembly-preview.svg/PDF仍使用印刷膠版幾何。

## v8：開口尺寸與不確定的轉移率分開

舊的0.3 mm情境淨寬目標加未量測單邊125 µm餘量，只生成約0.56 mm的製版槽；140 threads/in、14 µm線徑、EOM10 µm、轉移率0.32算得10.83 µm濕膜，不能當成確定的壓合厚度來縮小開口。

現在有實測濕膜時使用量測；沒有時，以**單次網版滿載幾何估算**（同組設定約33.85 µm、transfer=1）做開口尺寸壓合情境，避免用未量測0.32產生過小補償。此情境不是AB-313規格或已驗證的最壞上界。名義濕膜不足15 µm的警示仍顯示，沒有藉情境計算宣稱配方可用。

`Opening Clear Target`及`Print Gap Floor`移至Binding Width下方：前者是設計情境的剩餘淨寬目標，後者是明確製版孔寬下限（0=自動）。介面與匯出分別記錄**實際印膠圖開口**、**情境包絡淨寬**、**實測／滿載情境來源**；實際壓合後的孔寬一律標示未量測。尺寸不會為了塞進版型而偷偷縮小。大槽避開其他子電池的真實印刷腔室，不能只避開縮小後的情境腔室。

## v7：Voronoi直接出血，不加蝕刻框

FTO製造資料只包含兩種操作：`electrode-voronoi`原始選定共邊，以及`voronoi-bleed`從這些共邊端點直接延伸到真實玻璃邊緣的出血。**不產生active-perimeter、矩形周界、獨立fence或四角stub**。

6060依每條Voronoi邊的原方向出血。6066的上下端點依原方向延伸，必要時避開端子保護區；側邊同方向端點在同一X位置**共用單一出血直線**，各Voronoi邊以精確T接點相接，保留完整zebra接觸面。取消v7的多條平行扇形出血；共線重疊段合併成一個canonical操作，SVG、DXF、Galvo和雷射填滿不重複掃描整段。共用段標記`sharedSide`，其`boundaryIndex`為最遠端主分支。

雷射隔離掃描的光斑中心也到達實際玻璃邊緣0／H，光斑會跨出玻璃半徑範圍；不再為這些邊緣端點退縮半個光斑。內部butt端點仍做半徑補償。

整片玻璃扣除實際切寬後，檢查每組W串聯接點、兩條接觸面隔離及連續性、cell1／最後cell引出。6066的`isolationRoutes`由實際Voronoi與出血路徑追蹤得出，不補框來完成路徑；6060沒有外部端子，不虛構兩條全高fence。Etch頁顯示`Voronoi bleed … · NO ETCH FRAME`與實際玻璃尺寸。測試包含出血未達玻璃邊緣0.1mm時抓出短路的反例。

**預覽外圈的12 px padding、淺灰背景與artboard外框已移除**。白色SVG頁面外緣就是實際玻璃邊緣，工作區灰色不屬於玻璃；畫面另顯示尺寸。Etch的灰色接觸條／端點填色及額外玻璃描框也已移除，只留下正式黑色切線與非印刷標號，製造檔會去除標號。

```sh
npm install
npm run dev
```

預設網址 `http://127.0.0.1:5173`。`npm run build` 更新 `dist/`。

更新 macOS 啟動器的內嵌網頁：`npm run sync:app`。若使用其他位置的同一 app，執行 `npm run sync:app -- "/path/to/DSSC Layout.app"`；此命令只同步建置資產與文件並重新作 ad-hoc 簽署，保留本機服務識別。已開啟的瀏覽器重新整理即可載入新版。

## v6 單位與封膠修正

v5 的1.5 mm隱藏目標、整片玻璃寬度作擴散尺度、面積退讓區補成膠及濕膜不足時顯示零擴散已修正。Binding Width現在是實際印膠直線法向寬度；例如0.30 mm=300 µm，與15 µm=0.015 mm的厚度方向gap分開。

EOM不是AB-313 datasheet參數。EOM10 µm與轉移率0.32均為未量測示例，介面及匯出資料標明來源；`Measured Wet Film`非零量測可覆寫估算。140 threads/in、線徑14 µm的截圖設定會算得10.83055 µm濕膜，小於15 µm gap，顯示模型不成立。

玻璃珠商品grade與D50／假設gap依使用者提供的1000目≈15 µm對照雙向連動。此近似不是通用篩網公式，與印刷網版mesh分開。印膠與壓合包絡可切換，槽的剩餘淨寬由膠體膨脹後的實際幾何量測。

## 操作重點

- **Etch Bigger / Smaller**：選定Voronoi線直接出血，無周界蝕刻框。較大電極保留兩個端點引出與完整zebra接觸面。Etch不鋪灰色提示、不加描框；SVG/PDF製造檔移除標號。
- **Binding**：黑色印 AB-313；白色包含 cell 腔室及真正扣除的垂直注液／排氣槽。SVG、PDF 和 DXF 使用相同已開槽多邊形；DXF 的 BINDING 為帶孔 `SOLID HATCH`，不是膠線中心線。
- **Final Assembly**：顯示active regions與所選階段的AB-313；預設與Binding使用相同印刷膠版，兩頁共用壓合情境切換。黑色是膠，灰色是塗層，白色是留空／退讓區。
- **Active area**：逐 cell 計算扣除封膠、膠體擴散、對位容差及 FTO 名義切寬後的多邊形面積，顯示總面積、min/max 與變異係數 CV。移除介面的 Overlap readout；內部 overlap 矩形仍用於兩片玻璃的交集運算。
- **Area Balance，0–1**：以安全內縮後的有效面積為目標移動Voronoi sites，接受移動前重新檢查所有串聯共邊及兩端gate；各塗層填滿其安全分區，不再為等面積縮小。1是較強局部搜尋，實際殘餘差異看Area CV，不保證等面積或全域最佳。
- **Point Code Text** 介面已移除；新設定的文字為空，網版不產生文字點孔。舊點碼函式保留作相容性／幾何工具，v5 不讀取 v4 瀏覽器設定。
- **FTO Etch Width** 可設 `0.02–5 mm`。數值上限不代表任一版型都可使用 5 mm；DRC 會以實際有限切寬的保留 FTO 島檢查開路／短路。

## AB-313 與微玻璃珠

新增 screen mesh（threads/in）、線徑、乳劑 EOM、轉移率、AB-313／混合膠實測黏度、玻璃珠 D50、D90、grade mesh、壓合壓力、UV 前流動時間、對位容差及最小成品開口。

玻璃珠預設 **D50 15 µm、grade 1000 目**，與印刷網版預設 **200 threads/in** 是不同規格。D90 預設 20 µm 是待量測假設；1000 目不能當成完整粒徑分布，也不能用來唯一決定 D90 或成品間隙。

修改製程參數會更新建議印膠尺寸，**保留手動Binding Width**；按套用按鈕才更改。預設可見的目標成品膠寬為0.30 mm，是設計目標而非材料最佳值。上下限是幾何／印刷起始規則，有限切寬、腔室及注液連通性另由DRC檢查。舊v5設定會遷移保留，建議按鈕可供重新選取膠寬。

完整公式、來源與校正方式見 **[PROCESS_MODEL.md](PROCESS_MODEL.md)**。TDS 只提供 25°C 黏度 `38,000 ± 8,000 mPa·s` 等材料資料，無法單憑該資料宣稱唯一最佳 mesh、膠寬或孔寬。

## 注液網路

候選開口只沿垂直方向、穿過一條相鄰 cell 的封膠牆；上緣可進液，下緣可排氣。程式要求每個 cell 同時可從上緣到達、可到達下緣，並逐一刪除冗餘槽。結果為 **inclusion-minimal**：再刪任一槽都會使至少一個 cell 失去上述通路，不保證全域開口數最少。

每個槽以整個寬度的多邊形截面檢查，避開第三個 cell；沒有可行通路時顯示錯誤，調小面積平衡、jitter、膠寬或成品孔寬後再生成。垂直槽只指定注液幾何方向，**沒有流體二極體效果**；共用電解液的離子遷移仍存在，符合側邊注液的 DIY 折衷用途。

## 面積基準（Intrinsic Jsc 模式）

- `Voc ≈ N × reference cell Voc`；預設 0.65 V/cell 為示意輸入，須換成同照度、溫度下的實測數值。
- `Isc ≈ min(active area in mm²) / 100 × reference Jsc × irradiance / 100`，Jsc 單位 mA/cm²，參考照度 100 mW/cm²。
- 舊 Jsc 10 mA/cm² 僅為示意輸入，現在須明確選擇 Intrinsic Jsc 才使用；無材料／光譜校正時不代表自己的電池。面積基準不含電阻；FTO 情境另外計算，見上方 v8.3。參考 Voc 總和不依照度線性縮放。
- 依據：[PVEducation — Mismatch for Cells Connected in Series](https://www.pveducation.org/pvcdrom/modules-and-arrays/mismatch-for-cells-connected-in-series)：串聯電流相同，電壓相加，電流失配由弱 cell 限制。這裡的最小值是簡化估算，沒有求解包含逆偏效應的完整串聯 I–V 曲線。

## 匯出

`Save View SVG` 儲存目前視圖。`Export Vector ZIP` 共 **20 files**；`Complete ZIP: PDF + 1-bit TIFF` 共 **28 files**：

| 路徑 | 內容 |
|---|---|
| `design.json` | v9共同高度設定、電路、端子、zebraContactReference、canonical Voronoi＋bleed etchPaths、active／膠／槽／openingScenario／保留 FTO 幾何 |
| `process-estimates.json` | 製程中間值、電性估算、逐 cell 面積、zebraContacts可接觸FTO面積、孔位及資料來源 |
| `manufacturing-layout.dxf` | TiO2 多邊形、FTO 中心線、電路參考、已開孔 AB-313 solid hatches |
| `fto-galvo-toolpaths.json` | v4 中性交換格式；無框Voronoi＋bleed中心線，6066隔離路徑參考 |
| `laser-fill/toolpaths.json` | 兩片光斑中心掃描線；每段 laser ON、段間移動 OFF |
| `laser-fill/glass-6066-fill.svg` / `glass-6060-fill.svg` | 真實 mm、平行填滿掃描線，依 hatch pitch 與 spot 計算 |
| `svg-layered/` | 七個分頁 SVG |
| `svg-production/` | 兩片 TiO2、兩片去 guides 的 FTO、Binding，共五張 |
| `pdf-production/` | 完整 ZIP 才包含，同五張製造 SVG 的向量 PDF |
| `pdf-preview/` | 完整 ZIP 的 Assembly PDF |
| `bitmap-production/` | 完整 ZIP 的兩片 1200 DPI、true 1-bit TiO2 TIFF |
| `README.txt` | 匯出語意與假設 |

canonical geometry 為組裝座標；各片製造檔為 conductive-side、plate-local、左上原點、X 向右 Y 向下。6060 預設水平鏡射，6066 不鏡射。雷射路徑也遵循相同鏡射。

Laser fill 需 `0 < hatch pitch ≤ calibrated spot/kerf ≤ etch width`。光斑為圓形，矩形切區角點的殘留上界約為光斑半徑；交會重複曝光、實際 kerf 與隔離電阻需試片校正。JSON 是中性交換格式，沒有機台功率、速度或控制協定。

## 驗證

```sh
npm test
npm run build
# dev server 運作時：
npm run test:browser
```

Browser smoke 使用已安裝的 Chrome；可用 `CHROME_PATH`、`APP_URL` 覆寫位置／網址。測試包含真實 SVG 渲染、製造 ZIP、PDF、1-bit TIFF、注液槽留白、FTO 端子連通與數值參數。

## 第三方資料

歷史點碼工具中的 Demaine Voronoi font 資料與 MIT notice 見 `THIRD_PARTY_NOTICES.md`。
