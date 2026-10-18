# 忠欣蔬果三站整合（打勾單／異常表與交接表／報價單匯出）

三個網站共用新的 Supabase 專案 `aknxualjinfanuchtbwo`，採用 High-Fidelity Claymorphism 外觀、Supabase Auth 登入＋RLS，以及低流量即時同步。

> **狀態**：程式與 SQL 都已在**本機測試堆疊**（PostgreSQL 16 + 真的 PostgREST 12 + 模擬的 Auth／Realtime 閘道）通過完整測試。
> **還沒有**部署到你的 Supabase 專案，也還沒用真實資料跑過：這個雲端環境到目前為止仍連不到 `*.supabase.co`。

## 資料夾

| 路徑 | 內容 |
|---|---|
| `index.html` | 首頁（三個系統的入口卡片，「繼續使用上次的系統」） |
| `tick/` | 打勾單（原 `nitaaa1119-ai/Chun-Shin-Ltd.`，含原有圖示） |
| `report/` | 異常表與交接表 |
| `quote/` | 報價單匯出系統（`index.html` + `app.js`） |
| `shared/` | 三站共用：側邊欄 `zx-nav.js`、連線設定 `zx-config.js`、登入 `zx-auth.js`、同步 `zx-sync.js`、設計 token `clay-tokens.css`、LOGO、使用者圖示 |
| `tools/migrate.html` | 資料搬移工具（三個舊專案 → 新專案，只限管理員） |
| `supabase/sql/` | 依序執行的 SQL（見下方「部署步驟」） |
| `supabase/test/` | SQL 測試（`run_all.sh`，75 項） |
| `devstack/` | 本機測試堆疊與瀏覽器 E2E 測試（`run_e2e.sh`） |
| `src/` | 由原版程式組出新版的建置腳本（`build_*.py`）與新版程式來源 |
| `original/` | 三個原版網站（對照用，不部署） |
| `docs/` | 欄位對照、Egress 試算與模型、第 1 批 schema 說明 |

## 部署步驟

部署方式：整個資料夾放進同一個 GitHub repo（例如 `zhongxin`），開啟 GitHub Pages，就是一個完整網站：
`…github.io/zhongxin/` 是首頁，`/tick/`、`/report/`、`/quote/` 是三個獨立頁面。每一頁左側都有共用側邊欄可以切換，三頁共用同一次登入。

**側邊欄**：桌機固定在左側，可收合成只剩圖示（會記住設定）；手機與平板（寬度小於 900px）從左下角按鈕開啟抽屜，按 Esc 或點旁邊關閉。管理員登入後才會多出「資料搬移」項目。列印時側邊欄完全隱藏，不影響原本的列印與 Excel 格式。

1. **建立結構**：在新專案的 SQL Editor 依序執行 `02_core_shared` → `03_tick` → `04_report` → `05_quote` → `06_import_staging`。新專案是空的，所以 `01_backup` 可以略過。
2. **Realtime 設定**：Dashboard → Realtime → Settings，關閉「Allow public access」，只讓登入成員收到私有頻道的推播。
3. **建立帳號**：Authentication → Users → Add user，然後修改 `11_members_template.sql` 裡的 Email 與角色後執行。
4. **搬移資料**：用管理員帳號開啟 `tools/migrate.html` → 「檢查來源筆數」→「開始搬移」。工具只讀取舊專案，可以重複執行。
5. **轉換與核對**：執行 `07_backfill.sql` → `08_verify.sql`。每一列 `ok` 都要是 `true`；最後一段列出的同名客戶（例如同一個店名對到兩個代號）請到 `legacy_name_review.resolved_code` 指定後，再跑一次 07。
6. **收回匿名權限**：執行 `09_cutover.sql`（先把檔案開頭 `-- set zx.confirm = 'cutover';` 前面的 `-- ` 刪掉，這是防誤按的安全鎖）。新專案與舊專案是分開的，這一步**不會**影響舊網站，只是讓新專案的資料一律要登入才能存取；要回復可用 `99_rollback.sql`。
7. **停用舊系統**：新網站用順、資料確認無誤後，再停用三個舊 Supabase 專案與舊的 GitHub Pages。

## 各站變更重點

**共通**
- 登入後才看得到資料。角色分 admin／staff／viewer；所有刪除都只限 admin（只改 `private.can_delete()` 一行就能調整）。
- 同步方式：一次異動只推送一則不到 600 bytes 的小事件給其他裝置。Realtime 斷線時每 30 秒做一次輕量檢查（無變更時不到 100 bytes），重連或切回分頁時立即補同步。
- 防覆寫：每筆資料都有版本號，畫面過期時寫入會被拒絕並提示；斷線重送不會重複寫入。

**打勾單**
- 原本每勾一次就讀寫兩大份 JSON，現在一勾只寫一列。重置由伺服器決定營業日，兩台同時按只會有一台成功。
- 「三天未叫」改由伺服器自動計算（連續 3 個工作天未叫貨），手動標示仍保留。
- 系列統計改存資料庫，新增「⚙ 系列設定」可自行新增系列與店家。
- 歷史不再只保留 6 天。刪除客戶改為「從打勾單移除、保留歷史」。
- 「📅 更新日期」按鈕已移除：日期改由伺服器營業日管理，這個功能已無作用。
- 頁首原本的「打勾單／異常表交接表」切換標籤，改由共用側邊欄取代。
- 修正原版小 bug：卡片底部會出現「ed」字樣（`'ordered'.slice(5)`）。

**異常表與交接表**
- 改為依日期範圍顯示（今天／近 7 天／近 30 天／全部／自訂），每頁 50 筆，可「載入更多」。
- 「刪除全部」只刪目前篩選的範圍，而且只限 admin。
- 輸入店家時會帶入車號，並標示來源（客戶車輛設定或最近一筆紀錄）。
- 正在編輯的那一列若被別台改過，會保留草稿並提示「資料已在別處更新」。
- 列印預覽與 Excel 匯出的程式碼逐字沿用原版：A4 橫式、每頁 16 筆、交接表至少 18 筆、欄寬列高、字型字級都已核對。

**報價單**
- 大型 JSON 拆成獨立資料表，首頁只讀輕量清單，品項只在開詳情、上傳或匯出時才讀。
- 匯出期間若有人重新上傳，該客戶不會被誤標為已匯出。
- 品項主檔在瀏覽器快取，版本有變才重新下載。
- **修正原版 bug**：「自動排除 Excel 隱藏列」其實從未生效，因為原版沒有傳 SheetJS 的 `cellStyles: true`。

## 測試結果（本機測試堆疊，不是真實 Supabase）

- **SQL**（`supabase/test/run_all.sh`）：75 項通過。包含每支 SQL 連跑兩次、RLS 各角色、CAS 衝突、去重、交易提交順序錯亂時補差不漏件、backfill 無損核對。
- **瀏覽器 E2E**（`devstack/run_e2e.sh`）：5 組全部通過。

| 測試組 | 主要驗證內容 |
|---|---|
| 側邊欄 | 首頁 → 三站切換與目前頁反白、內容不被側邊欄遮住、切換頁面不用重新登入、只有管理員看到資料搬移、收合並記住、手機抽屜開關（含 Esc）、列印時隱藏且版面不位移 |
| 打勾單 | 搬移後的客戶與負責人群組排序、另一台 0.3～0.5 秒看到勾選、已叫貨不能點回、離線時樂觀更新 → 失敗復原、短暫斷線重送只寫入一次、Realtime 中斷時靠 30 秒檢查補上（實測 30.0 秒）、重置換日另一台自動切換、系列新增、唯讀帳號 |
| 異常表 | 另一台 0.25 秒看到新增、車號自動帶入、編輯衝突保留草稿、管理員刪除同步、列印預覽、Excel 欄寬列高字型與原規格一致、手機版 |
| 報價 | 上傳精靈（隱藏列排除、橫向多組拆展、空白單價補 0、匯出時清洗千分位／括號負數／$）、另一台 0.3 秒看到階段變化、有貨號 13 欄格式、無貨號多客戶格式（3 列表頭、#DEEBF7、欄寬、未匹配橘底）、取消存檔不標記、staff 不能刪客戶 |
| 搬移 | 空的新專案 → 工具搬入 1,234 筆異常（超過單頁 1000 筆上限）與 2,500 筆品項、重跑不重複、07/08 全部 ok、新站看得到資料 |

**沒有驗證到的部分**：真實 Supabase 的 Realtime 私有頻道授權與 `realtime.send`、gzip 壓縮後的實際流量、8／10 台實機同步、Dashboard Usage 對帳。這些要等部署後進行第 3、4 批驗收。

## Egress 試算（`docs/egress-estimate.md`）

單次大小已用本機實測校正：寫入回應 207 B、推播每台 391 B、心跳 89 B、打勾單首載每位客戶約 430 B。
試算結果：8 台約 **0.86 GB／月**，10 台約 **0.99 GB／月**，內部預算是 3 GB。這是未壓縮的數字；真實 Supabase 有 gzip，實際應該更低，仍須以 Dashboard Usage 對帳。
對照：依原程式碼推算，舊版打勾單如果全表 300 KB，每月約 125 GB。

## 本機重跑測試

```bash
# 需要 PostgreSQL 16（socket /var/tmp/zxsock、port 5544）
./supabase/test/run_all.sh          # SQL 測試
./devstack/run_e2e.sh               # 建庫 → 啟動 PostgREST 與閘道 → 4 組瀏覽器測試
# 開發時：./devstack/setup_db.sh && ./devstack/start.sh，然後瀏覽 http://localhost:8080/tick/
# 修改 src/ 後重建：python3 src/build_tick.py && python3 src/build_report.py && python3 src/build_quote.py
```
