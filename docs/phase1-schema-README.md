# 忠欣三系統整合｜第 1 批：Schema 盤點與 Migration（草稿）

> **狀態：所有 SQL 都還沒有在你的 Supabase 專案執行過。**
> 這次的雲端環境連不到 `aknxualjinfanuchtbwo.supabase.co` 和 `nitaaa1119-ai.github.io`（網路政策擋下），
> 所以我看不到真實的資料表結構，也看不到現有網站程式碼。以下內容是依照三份 Prompt 推測的結構寫成，
> 只在**本機 PostgreSQL 16 + 模擬 Supabase 介面**上測試過，不等於已在正式環境驗證。

## 檔案

| 檔案 | 用途 | 會改資料庫嗎 |
|---|---|---|
| `sql/00_inventory.sql` | 盤點：表、欄位、筆數、大小、RLS、policy、publication、索引、舊 JSON 結構 | 否（唯讀） |
| `sql/01_backup.sql` | 在庫內建立 `zx_backup` 快照 | 新增 schema |
| `sql/02_core_shared.sql` | 成員角色、`change_log` 補差、`sync_changes` RPC、Broadcast 通知、共用客戶／車輛表、RLS | additive |
| `sql/03_tick.sql` | 打勾單：營業日、每日狀態、事件、負責人、群組／系列、留言、趨勢、三天未叫、`tick_set_status`／`tick_reset_day` RPC | additive |
| `sql/04_report.sql` | 異常／交接：新增欄位、雙向相容觸發器、日期解析、`report_delete_all`（只限 admin） | additive |
| `sql/05_quote.sql` | 報價：`customer_quote_*` 拆表、計數觸發器、儲存／匯出／主檔 RPC | additive |
| `sql/06_backfill.sql` | 舊資料 → 新表（可重複執行，不改舊欄位） | 只寫新表／新欄位 |
| `sql/07_verify.sql` | 無損核對＋待人工確認清單 | 否（唯讀） |
| `sql/08_cutover.sql` | 正式切換：移除 anon policy／權限、移除 Postgres Changes publication（有安全鎖） | 是 |
| `sql/09_export_customer_names.sql` | 產生 `STATIC_CUSTOMER_NAMES`（打勾單客戶＋主檔＋別名） | 否（唯讀） |
| `sql/99_rollback.sql` | 還原 cutover、移除舊表上的新觸發器（不 DROP TABLE；有安全鎖） | 是 |
| `shared/zx-sync.js` | 三站共用同步核心＋寫入去重重試＋流量計量器 | — |
| `shared/logo-teruteru.svg` | 晴天娃娃 LOGO（自行生成） | — |
| `shared/theme.css` | 共用設計 token（卡片式後台風格；列印時自動關閉卡片效果） | — |
| `docs/field-mapping.md` | 舊 ↔ 新欄位對照 | — |
| `docs/egress_model.py`、`docs/egress-estimate.md` | Egress 試算模型與結果 | — |
| `test/` | 本機模擬測試（`run_all.sh` 一鍵重跑） | — |

## 執行順序（在 Supabase SQL Editor）

1. **先跑 `00_inventory.sql`，把結果的 JSON 傳給我。** 我會依真實結構修正 02～06。
2. 用 Supabase CLI 在公司電腦做一份庫外備份（`supabase db dump`）。
3. `01_backup.sql` → `02` → `03` → `04` → `05` → `06` → `07_verify.sql`（每一列 `ok` 都要是 `true`）。
   02～06 跑完舊網站還是能正常用：舊的 anon policy 和舊欄位都沒動。
4. 在 Authentication 建立帳號，再把帳號加進 `app_members`（role 填 admin／staff／viewer）。
5. 新網站上線、驗收通過後才跑 `08_cutover.sql`。跑完舊網站就會停止運作。

## 架構重點

- **同步**：每次寫入都會在 `change_log` 留一筆小摘要，並透過 private Broadcast（`zx:tick`、`zx:report`、`zx:quote`、`zx:shared`）推一則不到 600 bytes 的事件。補差用 `sync_changes(cursor)`，游標是「快照 xmin 水位」，所以就算交易提交順序和序號順序不同也不會漏件（`test/race_test.sh` 有實測）。沒有任何變更時，一次檢查的回應不到 80 bytes。
- **防覆寫**：每列都有 `revision`。寫入 RPC 會比對 expected_revision，不符就回 `conflict`；同一個 `request_id` 重送只會套用一次。
- **大量寫入**：整批刪除、backfill、品項主檔上傳都只發一則 `'*'` 事件；報價一次存 200 個品項，最多產生 3 則事件。
- **權限**：Supabase Auth＋RLS。成員可讀、staff 可寫、刪除由 `private.can_delete()` 決定（預設只限 admin）。service_role key 不會放進前端。

## 第 1.5 版更新（依現行打勾單程式碼修正）

從 GitHub 讀到 `nitaaa1119-ai/Chun-Shin-Ltd.` 的 `index.html` 後，修正了下列推測錯誤：

| 項目 | 原本推測 | 實際（程式碼） | 新設計 |
|---|---|---|---|
| 狀態值 | 未叫貨／已叫貨 | `未叫貨`、`有叫貨`（畫面顯示「已叫貨」）、`今日不叫貨` | `daily_order_status.status` 加 check |
| 點擊規則 | 只有未叫貨→已叫貨 | 左鍵 未叫貨→有叫貨；右鍵 未叫貨⇄今日不叫貨 | `tick_set_status` 的 `p_via` 分 click／right_click／modal |
| `fixed` | boolean | **負責人姓名**（同時是群組名） | 移到 `tick_customers.fixed`（屬於客戶，不屬於某一天） |
| 換日 | 依日期 | 手動「重置」；`date` 只有 `''`／`'ordered'` | `tick_service_days` + `tick_reset_day`，目前營業日由伺服器決定，不看裝置時鐘 |
| 歷史 | — | 只保留 6 天，日期 `YYYY/MM/DD`，editLog 記暱稱與圖示 | 歷史直接查 `daily_order_status`（不再有 6 天上限），editLog → `order_status_events` |
| 三天未叫 | 自動計算 | 手動名單，重置時合併自動計算 | `v_tick_warn3`：連續 3 個工作天（已結束的營業日）未叫貨，再加上手動加入、減去手動排除；今日不叫貨不算未叫 |
| 系列 | — | 程式碼寫死 5 個系列 | 存進 `order_groups(kind='series')`，可以自行新增 |
| 儲存格式 | jsonb 物件 | `JSON.stringify` 後寫入，jsonb 裡可能是字串 | `private.legacy_json()` 統一解開 |

**重置的差異**：舊版重置要把 638 位客戶全部寫回「未叫貨」並覆寫整份歷史；新版只寫 2 列（關閉舊的一天、開新的一天）。沒有列就代表未叫貨，所以每天也不需要批次寫入。

## 本機模擬測試結果（`test/run_all.sh`）

52 項全部 PASS，涵蓋：01～06 連續跑兩次、RLS（非成員、anon、viewer、staff、admin）、左鍵／右鍵／編輯視窗規則、已重置的那一天拒絕寫入、CAS 衝突、request_id 去重、新站與舊站的雙向相容、刪除全部只限 admin 且只發 1 則事件、品項主檔缺規格代號欄時保留原值、舊 JSONB 與舊日期文字不被改動、補差在交易提交順序錯亂時不漏件、負責人／營業日／editLog／群組／留言／系列的 backfill，以及三天未叫的自動判斷與兩台同時重置只有一台成功。

**沒測到的部分**：真實 Supabase 的 Realtime 授權、`realtime.send` 的實際行為、PostgREST 回應大小、多台裝置實測、Egress 實測。這些在第 3、4 批處理。

## Egress 試算（非實測，詳見 `docs/egress-estimate.md`）

新設計：8 台約 **0.83 GB／月**，10 台約 **0.95 GB／月**，內部預算是 3 GB。

**舊版打勾單超額的原因（依程式碼推算）**：每勾一次會 ①讀整份 `zhongxin_v4`；②寫回 `zhongxin_v4` 和 `zhongxin_hist_v4` 兩列大 JSON，Postgres Changes 會把整列推給每台裝置；③其他每台裝置收到事件後再重抓整張表。另外每台每 30 秒還會輪詢整張表一次。如果全表大約 300 KB，8 台每月約 **125 GB**；就算只有 100 KB，也大約 42 GB。這是 5 GB 免費額度的 8～25 倍。

## 待確認事項

1. **盤點結果**：附件圖片沒有傳到我這邊。請把 SQL Editor 結果那一格 JSON **以文字貼上**（JSON 很長，圖片容易截斷或看錯）。
2. **兩個 Supabase 專案**：線上打勾單目前連的是 `ozlsmfmpqzdcskqrlccw`（表名 `zhongxin_store`）；你給我的是 `aknxualjinfanuchtbwo`（表名 `Chunghsin_store`）。資料要從舊專案搬過來嗎？還是已經複製到新專案的 `Chunghsin_store` 了？
3. **客戶代號**：打勾單只用客戶「名稱」（約 638 位），沒有代號。新架構要求 `customers.code`。名稱在主檔找不到的客戶，要不要先建立暫編代號 `TK0001…`？（`06_backfill.sql` 已備好，用 `set zx.create_missing_customers = 'on'` 開啟。）
4. **報價單、異常／交接網站**：有沒有現成的網站？請給 GitHub repo 名稱，或說明要重新開發。
5. **STATIC_CUSTOMER_NAMES**：網站程式碼裡沒有內嵌名單，客戶全部存在資料庫。請在新專案執行 `sql/09_export_customer_names.sql`，把結果貼給我。或者在雲端環境的 Network access 加入 `aknxualjinfanuchtbwo.supabase.co`、`ozlsmfmpqzdcskqrlccw.supabase.co`，我就能直接讀。
6. **LOGO**：已生成 `shared/logo-teruteru.svg`（晴天娃娃＋小太陽＋綠領結）。
7. **其他素材**：日曆／列印／刪除全部 PNG、Excel 範本、Claymorphism 風格附件仍待補（前端會用 placeholder 標示）。打勾單 repo 裡已有的使用者圖示（kitty.png 等）會沿用。

## 安全提醒

舊系統的 policy 是「anon 全部讀寫」。任何人只要有網址和 anon key（本來就寫在前端程式碼裡），就能讀取、修改、刪除全部資料。這要等 `08_cutover.sql` 執行後才會關閉。

## 後續批次

2. 前端功能與設計（三站）
3. 8／10 台同步驗收（同站＋跨站、離線再連線、長時間開啟）
4. Egress 實測報告（`zxMeter.report()` 與 Dashboard Usage 對帳）
