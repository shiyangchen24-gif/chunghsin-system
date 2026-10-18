# 舊 ↔ 新 欄位對照（雙向）

> 原則：舊欄位**全部保留**。新站寫新欄位時由觸發器回填舊欄位，舊站寫舊欄位時自動補新欄位。
> 所有 JSON 元素都把原文存進 `legacy` 欄，所以就算有不明的 key 也不會遺失。

## 打勾單（舊："Chunghsin_store" key-value；值為 JSON.stringify 字串）

| 舊 key / 路徑 | 新位置 | 備註 |
|---|---|---|
| 整列原文 | `legacy_kv_archive` | 原文完整保留（字串會先解開成 JSON） |
| `zhongxin_v4.{客戶名}.status` | 目前營業日的 `daily_order_status.status` | `有叫貨`／`今日不叫貨` 才寫列，沒有列＝`未叫貨` |
| `zhongxin_v4.{客戶名}.fixed`（負責人） | `tick_customers.fixed` | |
| `zhongxin_v4.{客戶名}.date`（`''`／`'ordered'`） | 不需要 | 由狀態本身推得 |
| 客戶名 | `customers`／`customer_aliases(source='legacy_tick')`／`tick_customers.legacy_name` | 恰好一個候選才自動對應，否則進 `legacy_name_review` |
| `zhongxin_hist_v4[i].date`（`YYYY/MM/DD`） | `tick_service_days(status='closed')` | `clearedAt`（毫秒）→ `cleared_at` |
| `zhongxin_hist_v4[i].records` | 該營業日的 `daily_order_status` | 同一天有多份快照時取最後一份 |
| `zhongxin_hist_v4[i].editLog.{客戶}[]` `{time,status,user,icon}` | `order_status_events(new_status, actor_name, actor_icon, created_at)` | 用 md5 產生 request_id 防止重複轉入 |
| `zhongxin_hist_v4[i]` 全文 | `order_history_days` | 無損保存 |
| `zhongxin_order_v1 {群組: [客戶]}` | `order_groups(kind='group')` + `order_group_members(sort_order)` | |
| 程式碼內 `SERIES_LIST`／`SERIES_EXTRA` | `order_groups(kind='series', rule)` | 可自行新增 |
| `zhongxin_notices_v1 [{id,author,text,time}]` | `order_notices(body, author_name, legacy_ref='notices_v1#id')` | |
| `zhongxin_manual_v1 {'YYYY/MM/DD': {ord,un,no}}` | `order_manual_trend(period, payload)` | |
| `zhongxin_warn3_v1 [客戶]` | `tick_warn3_overrides(mode='add')` + 自動計算 `v_tick_warn3` | |
| `zhongxin_ts_v1` | 不需要 | 改用伺服器 revision／游標 |

## 異常表 `abnormal_reports`

| 舊欄位 | 新欄位 | 同步規則 |
|---|---|---|
| `reason` | `issue_description` | 雙向觸發器：哪邊被改就同步另一邊 |
| `date` (text) | `report_date` (date) | 能辨識的格式（`YYYY-MM-DD`、`YYYY/MM/DD`、`M/D`、`M月D日`）才轉換；原文**不改寫**；無法辨識的進 `legacy_name_review` |
| `store` | `customer_code` | 恰好一個候選才填；`store` 原文保留為快照 |
| `car_no` | `vehicle_id` | 從 `vehicles` 對應（只做 trim，不做正規化）；`car_no` 原文保留為快照 |
| `exchange_type`、`category`、`responsibility`、`note`、`created_at` | 不變 | |
| — | `revision`、`updated_at`、`updated_by`、`request_id`、`car_no_source` | 新增 |

## 交接表 `handover_reports`

| 舊欄位 | 新欄位 | 同步規則 |
|---|---|---|
| `content` | `handover_description` | 雙向觸發器 |
| `date` (text) | `report_date` | 同異常表 |
| `store`（客戶名稱+車號） | `customer_code`、`vehicle_id` | 合併文字無法可靠拆開，**不自動填**，待確認 |

## 報價（舊：`customers` 上的大型欄位）

| 舊 `customers` 欄位 | 新位置 |
|---|---|
| `quote_cycle`、`product_code_mode`、`export_status`、`last_export_time`、`last_export_filename`、`last_export_item_count`、`notes`、`unit_category`、`quote_file_location`、`last_quote_upload_time` | `customer_quote_profiles` 同名欄位 |
| `mapping.dataStartRowIdx` / `mapping.columnMap` | `customer_quote_mappings.data_start_row_idx` / `column_map`（原文存在 `legacy`） |
| `saved_records[i]` | `customer_quote_items(list_kind='saved', line_no=i)`；13 欄拆成具名欄位，原文存在 `legacy` |
| `quoted_prices.matched[i]` / `.unmatched[i]` | `customer_quote_items(list_kind='matched'/'unmatched')`；元素的 key 名稱**待確認** |
| `item_code_lookup{客戶品名: 料號}` | `customer_item_code_mappings(customer_item_name, item_code)` |
| `last_item_codes` | `customer_quote_baselines.item_codes` |
| `saved_records_count` / `quoted_prices_count` / `item_code_lookup_count`（generated） | `customer_quote_profiles.pending_item_count` / `item_code_lookup_count`（由語句級觸發器維護） |
| 新 → 舊 | `07_verify.sql` 依 `line_no` 用 `legacy` 欄重新組回 `saved_records`，並逐客戶比對是否完全相同 |

13 欄對照：`*客戶貨號→customer_item_code`、`客戶商品名稱→customer_item_name`、`客戶規格單位→spec_unit`、`*單價→price`、`備註→note`、`產區/品種→origin_variety`、`裝箱方式→packing`、`包裝資材→packaging_material`、`產地→origin`、`不報價原因→no_quote_reason`、`變價原因→price_change_reason`（`*客戶代號`、`客戶名稱` 匯出時取自 `customers`）。
