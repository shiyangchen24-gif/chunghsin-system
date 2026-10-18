-- =====================================================================
-- 07_backfill.sql ── 舊資料 → 新表（可重複執行；只寫新表/新欄位，不改舊欄位內容）
-- 前提：已執行 01～05，且已依 00_inventory 結果確認下列「待確認」項目。
-- 原則：
--   * 姓名對 customers.code：只在「恰好一個候選」時自動對上；0 個或多個 → legacy_name_review
--   * 舊 JSON 元素全文存入 legacy 欄（無損），已知欄位另外拆出
--   * 全程 zx.bulk=on：不逐列推播，最後各表只發一則 '*'
--   * 已存在的新資料不覆蓋（on conflict do nothing / where ... is null）
-- 狀態：草稿。舊 JSON 的 key 名稱是依原 Prompt 推測，需以 00_inventory 的 element_keys 修正。
-- =====================================================================
begin;
select set_config('zx.bulk', 'on', true);

-- ---------------------------------------------------------------------
-- 0. 報價：舊 customers（legacy_quote_customers 暫存）→ 共用 customers 主檔＋報價各表
--    先做這一步，打勾單／異常表的客戶名稱才能對到報價系統既有的正式客戶代號
-- ---------------------------------------------------------------------
insert into public.customers (code, name)
select code, coalesce(row ->> 'name', '') from public.legacy_quote_customers
on conflict (code) do nothing;

insert into public.customer_quote_profiles (customer_code, quote_cycle, trade_status, product_code_mode, export_status,
    last_export_time, last_export_filename, last_export_item_count, notes, unit_category, quote_file_location,
    last_quote_upload_time)
select code,
       case when row ->> 'quote_cycle' in ('7天', '10天', '15天', '30天') then row ->> 'quote_cycle' else '7天' end,
       coalesce(nullif(row ->> 'trade_status', ''), '核准交易'),
       case when row ->> 'product_code_mode' = '無貨號' then '無貨號' else '有貨號' end,
       coalesce(nullif(row ->> 'export_status', ''), '未匯出'),
       nullif(row ->> 'last_export_time', '')::timestamptz,
       coalesce(row ->> 'last_export_filename', ''),
       coalesce(nullif(row ->> 'last_export_item_count', '')::int, 0),
       coalesce(row ->> 'notes', ''),
       case when row ->> 'unit_category' in ('kg', '台斤') then row ->> 'unit_category' else '' end,
       coalesce(row ->> 'quote_file_location', ''),
       nullif(row ->> 'last_quote_upload_time', '')::timestamptz
from public.legacy_quote_customers
on conflict (customer_code) do nothing;

insert into public.customer_quote_mappings (customer_code, data_start_row_idx, column_map)
select code, nullif(row #>> '{mapping,dataStartRowIdx}', '')::int, coalesce(row #> '{mapping,columnMap}', '{}')
from public.legacy_quote_customers
where jsonb_typeof(row -> 'mapping') = 'object'
on conflict (customer_code) do nothing;

-- 有貨號 saved_records（key 為前端欄位名：貨號、品名、單位、單價…）
insert into public.customer_quote_items (customer_code, list_kind, line_no, item_code, item_name, unit, price, note,
    origin_variety, packing, packaging_material, origin, no_quote_reason, price_change_reason, is_new, legacy)
select l.code, 'saved', e.ord::int, e.v ->> '貨號', e.v ->> '品名', e.v ->> '單位', e.v ->> '單價', e.v ->> '備註',
       e.v ->> '產區品種', e.v ->> '裝箱方式', e.v ->> '包裝資材', e.v ->> '產地', e.v ->> '不報價原因', e.v ->> '變價原因',
       coalesce((e.v ->> '_isNew')::boolean, false), e.v
from public.legacy_quote_customers l,
     jsonb_array_elements(case jsonb_typeof(l.row -> 'saved_records') when 'array' then l.row -> 'saved_records' else '[]' end)
       with ordinality e(v, ord)
where not exists (select 1 from public.customer_quote_items i where i.customer_code = l.code and i.list_kind = 'saved');

-- 無貨號 quoted_prices {matched:[{code,price,isNew}], unmatched:[{name,unit,price}]}
insert into public.customer_quote_items (customer_code, list_kind, line_no, item_code, item_name, unit, price, is_new, legacy)
select l.code, k.kind, e.ord::int, e.v ->> 'code', e.v ->> 'name', e.v ->> 'unit', e.v ->> 'price',
       coalesce((e.v ->> 'isNew')::boolean, false), e.v
from public.legacy_quote_customers l,
     (values ('matched'), ('unmatched')) k(kind),
     jsonb_array_elements(case jsonb_typeof(l.row #> array['quoted_prices', k.kind]) when 'array'
                               then l.row #> array['quoted_prices', k.kind] else '[]' end) with ordinality e(v, ord)
where not exists (select 1 from public.customer_quote_items i where i.customer_code = l.code and i.list_kind = k.kind);

-- 料號對照 item_code_lookup [{name, code, itemName}]
insert into public.customer_item_code_mappings (customer_code, customer_item_name, item_code, item_name, sort_order)
select distinct on (l.code, e.v ->> 'name') l.code, e.v ->> 'name', e.v ->> 'code', coalesce(e.v ->> 'itemName', ''), e.ord::int
from public.legacy_quote_customers l,
     jsonb_array_elements(case jsonb_typeof(l.row -> 'item_code_lookup') when 'array' then l.row -> 'item_code_lookup' else '[]' end)
       with ordinality e(v, ord)
where coalesce(e.v ->> 'name', '') <> '' and coalesce(e.v ->> 'code', '') <> ''
order by l.code, e.v ->> 'name', e.ord desc
on conflict (customer_code, customer_item_name) do nothing;

insert into public.customer_quote_baselines (customer_code, item_codes)
select code, row -> 'last_item_codes' from public.legacy_quote_customers
where jsonb_typeof(row -> 'last_item_codes') = 'array'
on conflict (customer_code) do nothing;

-- ---------------------------------------------------------------------
-- A. 打勾單：歸檔舊 key-value 原文（"Chunghsin_store" 為準；另一張存在時也歸檔但不使用）
--    目前營業日：舊 zhongxin_v4 沒有日期（date 只有 '' / 'ordered'），
--    以 zx.service_date 指定（未指定 = 台北今天）。執行前可先：set zx.service_date = '2026-10-19';
-- ---------------------------------------------------------------------
do $$
declare t text;
begin
  foreach t in array array['Chunghsin_store', 'chunghsin_store', 'zhongxin_store'] loop
    if to_regclass(format('public.%I', t)) is not null then
      execute format($q$
        insert into public.legacy_kv_archive (source_table, key, value, value_bytes)
        select %L, s.key, private.legacy_json(to_jsonb(s.value)), pg_column_size(s.value)
        from public.%I s
        where not exists (select 1 from public.legacy_kv_archive a
                          where a.source_table = %L and a.key = s.key
                            and a.value = private.legacy_json(to_jsonb(s.value)))
      $q$, t, t, t);
    end if;
  end loop;
end $$;

-- 來源：優先 "Chunghsin_store"，每個 key 取最新一份歸檔
-- （to_jsonb(text) 會得到 JSON 字串 → legacy_json 解開；jsonb 欄位內的字串也一樣解開）
create or replace temporary view zx_src as
select distinct on (key) key, value
from public.legacy_kv_archive
where source_table = coalesce(
  (select min(source_table) from public.legacy_kv_archive where source_table in ('Chunghsin_store', 'chunghsin_store')),
  'zhongxin_store')
order by key, archived_at desc;

create or replace temporary view zx_names as
select k as legacy_name from zx_src s, jsonb_object_keys(s.value) k
where s.key = 'zhongxin_v4' and jsonb_typeof(s.value) = 'object'
union
select k from zx_src s, jsonb_array_elements(s.value) h, jsonb_object_keys(h -> 'records') k
where s.key = 'zhongxin_hist_v4' and jsonb_typeof(s.value) = 'array' and jsonb_typeof(h -> 'records') = 'object'
union
select trim(store) from public.abnormal_reports where coalesce(trim(store), '') <> '';

-- 打勾單客戶在 customers 主檔完全找不到時，建立「暫編代號」客戶 TK0001…（使用者已確認採用）
--   要關閉才執行：set zx.create_missing_customers = 'off';
--   暫編客戶 quotation_settings.provisional = true，日後可在 customers 改正式代號（FK 皆 on update cascade）
do $$
declare v_next int;
begin
  if coalesce(current_setting('zx.create_missing_customers', true), '') <> 'off' then
    select coalesce(max(substring(code from '^TK(\d+)$')::int), 0) into v_next from public.customers where code ~ '^TK\d+$';
    insert into public.customers (code, name, quotation_settings)
    select 'TK' || lpad((v_next + row_number() over (order by k))::text, 4, '0'), k, '{"provisional": true}'::jsonb
    from (select jsonb_object_keys(value) k from zx_src where key = 'zhongxin_v4' and jsonb_typeof(value) = 'object') n
    where not exists (select 1 from public.customers c where c.name = n.k)
      and not exists (select 1 from public.customer_aliases a where a.alias_name = n.k);
  end if;
end $$;

-- 姓名 → 候選客戶代號（主檔名稱或別名，完全相符）
create or replace temporary view zx_name_candidates as
select n.legacy_name,
       array(select distinct x.code from (
               select c.code from public.customers c where c.name = n.legacy_name
               union
               select a.customer_code from public.customer_aliases a where a.alias_name = n.legacy_name) x
             order by 1) as codes
from zx_names n;

-- 對不上／同名 → 待確認清單
insert into public.legacy_name_review (source, legacy_name, candidates)
select 'name_match', legacy_name, codes from zx_name_candidates where cardinality(codes) <> 1
on conflict (source, legacy_name) do update set candidates = excluded.candidates
  where public.legacy_name_review.resolved_code is null;

-- 人工確認後的結果優先（legacy_name_review.resolved_code）
create or replace temporary view zx_name_map as
select c.legacy_name, coalesce(r.resolved_code, case when cardinality(c.codes) = 1 then c.codes[1] end) as code
from zx_name_candidates c
left join public.legacy_name_review r on r.source = 'name_match' and r.legacy_name = c.legacy_name;

insert into public.customer_aliases (customer_code, alias_name, source)
select m.code, m.legacy_name, 'legacy_tick'
from zx_name_map m join public.customers c on c.code = m.code
where c.name <> m.legacy_name
on conflict (customer_code, alias_name) do nothing;

-- 客戶設定：負責人（fixed）
insert into public.tick_customers (customer_code, fixed, legacy_name)
select m.code, nullif(e.value ->> 'fixed', ''), e.key
from zx_src s, jsonb_each(s.value) e
join zx_name_map m on m.legacy_name = e.key
where s.key = 'zhongxin_v4' and jsonb_typeof(s.value) = 'object' and m.code is not null
on conflict (customer_code) do nothing;

-- 營業日：舊歷史的日期（已結束）＋目前營業日（open）
insert into public.tick_service_days (service_date, status, closed_at, cleared_at)
select distinct to_date(h.value ->> 'date', 'YYYY/MM/DD'), 'closed', now(),
       case when (h.value ->> 'clearedAt') ~ '^\d+$' then to_timestamp((h.value ->> 'clearedAt')::bigint / 1000.0) end
from zx_src s, jsonb_array_elements(s.value) h
where s.key = 'zhongxin_hist_v4' and jsonb_typeof(s.value) = 'array'
  and (h.value ->> 'date') ~ '^\d{4}/\d{1,2}/\d{1,2}$'
  and to_date(h.value ->> 'date', 'YYYY/MM/DD')
      < coalesce(nullif(current_setting('zx.service_date', true), '')::date, (now() at time zone 'Asia/Taipei')::date)
on conflict (service_date) do nothing;
insert into public.tick_service_days (service_date, status)
select coalesce(nullif(current_setting('zx.service_date', true), '')::date, (now() at time zone 'Asia/Taipei')::date), 'open'
where not exists (select 1 from public.tick_service_days where status = 'open')
on conflict (service_date) do nothing;

-- 目前狀態 zhongxin_v4 → 目前營業日的 daily_order_status（未叫貨不必寫列）
insert into public.daily_order_status (service_date, customer_code, status)
select d.service_date, m.code, e.value ->> 'status'
from zx_src s, jsonb_each(s.value) e
join zx_name_map m on m.legacy_name = e.key
cross join (select service_date from public.tick_service_days where status = 'open') d
where s.key = 'zhongxin_v4' and jsonb_typeof(s.value) = 'object' and m.code is not null
  and e.value ->> 'status' in ('有叫貨', '今日不叫貨')
on conflict (service_date, customer_code) do nothing;

-- 歷史 records → 已結束營業日的 daily_order_status（同一天多份快照取最後一份）
insert into public.daily_order_status (service_date, customer_code, status)
select distinct on (d, m.code) d, m.code, r.value #>> '{}'
from (select to_date(h.value ->> 'date', 'YYYY/MM/DD') d, h.value, h.ord
      from zx_src s, jsonb_array_elements(s.value) with ordinality h(value, ord)
      where s.key = 'zhongxin_hist_v4' and jsonb_typeof(s.value) = 'array'
        and (h.value ->> 'date') ~ '^\d{4}/\d{1,2}/\d{1,2}$' and jsonb_typeof(h.value -> 'records') = 'object') x
join public.tick_service_days sd on sd.service_date = x.d and sd.status = 'closed',
     jsonb_each(x.value -> 'records') r
join zx_name_map m on m.legacy_name = r.key
where m.code is not null and (r.value #>> '{}') in ('有叫貨', '今日不叫貨')
order by d, m.code, x.ord desc
on conflict (service_date, customer_code) do nothing;

-- 歷史 editLog → order_status_events（time 只有 HH:MM，以營業日＋時間組成台北時間）
insert into public.order_status_events (request_id, service_date, customer_code, old_status, new_status, via,
                                        actor, actor_name, actor_icon, created_at)
select md5('legacy-editlog|' || x.d || '|' || l.key || '|' || g.ord)::uuid,
       x.d, m.code, null, g.v ->> 'status', 'backfill', null, g.v ->> 'user', g.v ->> 'icon',
       case when (g.v ->> 'time') ~ '^\d{1,2}:\d{2}$'
            then (x.d + (g.v ->> 'time')::time) at time zone 'Asia/Taipei' else now() end
from (select to_date(h.value ->> 'date', 'YYYY/MM/DD') d, h.value
      from zx_src s, jsonb_array_elements(s.value) h
      where s.key = 'zhongxin_hist_v4' and jsonb_typeof(s.value) = 'array'
        and (h.value ->> 'date') ~ '^\d{4}/\d{1,2}/\d{1,2}$' and jsonb_typeof(h.value -> 'editLog') = 'object') x,
     jsonb_each(x.value -> 'editLog') l
join zx_name_map m on m.legacy_name = l.key,
     jsonb_array_elements(case jsonb_typeof(l.value) when 'array' then l.value else '[]' end) with ordinality g(v, ord)
where m.code is not null and coalesce(g.v ->> 'status', '') <> ''
on conflict (request_id) do nothing;

-- 歷史快照原文 → order_history_days（無損保存）
insert into public.order_history_days (service_date, legacy_index, records, edit_log, cleared_at, extra)
select to_date(h.value ->> 'date', 'YYYY/MM/DD'),
       (row_number() over (partition by h.value ->> 'date' order by h.ord))::int - 1,
       coalesce(h.value -> 'records', '{}'),
       coalesce(h.value -> 'editLog', '{}'),
       h.value ->> 'clearedAt',
       nullif(h.value - 'date' - 'records' - 'editLog' - 'clearedAt', '{}'::jsonb)
from zx_src s, jsonb_array_elements(s.value) with ordinality h(value, ord)
where s.key = 'zhongxin_hist_v4' and jsonb_typeof(s.value) = 'array'
  and (h.value ->> 'date') ~ '^\d{4}/\d{1,2}/\d{1,2}$'
on conflict (service_date, legacy_index) do nothing;

-- 群組排序 zhongxin_order_v1 {群組名: [客戶名...]}
insert into public.order_groups (kind, name, sort_order, legacy)
select 'group', g.key, (row_number() over (order by g.key))::int, g.value
from zx_src s, jsonb_each(s.value) g
where s.key = 'zhongxin_order_v1' and jsonb_typeof(s.value) = 'object'
on conflict (kind, name) do nothing;
insert into public.order_group_members (group_id, customer_code, sort_order)
select distinct on (og.id, m.code) og.id, m.code, n.ord::int
from zx_src s, jsonb_each(s.value) g
join public.order_groups og on og.kind = 'group' and og.name = g.key,
     jsonb_array_elements_text(case jsonb_typeof(g.value) when 'array' then g.value else '[]' end) with ordinality n(name, ord)
join zx_name_map m on m.legacy_name = n.name
where s.key = 'zhongxin_order_v1' and jsonb_typeof(s.value) = 'object' and m.code is not null
order by og.id, m.code, n.ord
on conflict (group_id, customer_code) do nothing;

-- 系列（舊程式寫死的 SERIES_LIST／SERIES_EXTRA，改存資料庫，可自行新增）
--   rule：prefix＝名稱開頭符合即納入；exclude_prefix＝排除的開頭；extra＝另外指定的完整店名
--   （原版「杏子」的額外店家是用開頭比對，「花月嵐」是完整店名，這裡照原邏輯轉換）
insert into public.order_groups (kind, name, sort_order, rule) values
  ('series', '壽司郎', 1, '{"prefix":["壽司"],"exclude_prefix":["壽司郎"]}'),
  ('series', '杏子',   2, '{"prefix":["杏子","勝牛","王將","橋村"]}'),
  ('series', '銀穗',   3, '{"prefix":["銀穗"]}'),
  ('series', 'YAYOI',  4, '{"prefix":["YAYOI","Ya"]}'),
  ('series', '花月嵐', 5, '{"prefix":["花月"],"exclude_prefix":["花月嵐"],"extra":["燒丼統領","蛋包林口","蛋包南港"]}')
on conflict (kind, name) do nothing;

-- 留言板 zhongxin_notices_v1 [{id, author, text, time}]
insert into public.order_notices (body, author, author_name, created_at, legacy_ref, legacy)
select coalesce(n.value ->> 'text', n.value::text), null, n.value ->> 'author',
       case when (n.value ->> 'id') ~ '^\d{12,}$' then to_timestamp((n.value ->> 'id')::bigint / 1000.0) else now() end,
       'notices_v1#' || coalesce(n.value ->> 'id', n.ord::text), n.value
from zx_src s, jsonb_array_elements(s.value) with ordinality n(value, ord)
where s.key = 'zhongxin_notices_v1' and jsonb_typeof(s.value) = 'array'
on conflict (legacy_ref) do nothing;

-- 手動趨勢 zhongxin_manual_v1 {'YYYY/MM/DD': {ord, un, no}}
insert into public.order_manual_trend (period, payload)
select e.key, e.value
from zx_src s, jsonb_each(s.value) e
where s.key = 'zhongxin_manual_v1' and jsonb_typeof(s.value) = 'object'
on conflict (period) do nothing;

-- 三天未叫 zhongxin_warn3_v1 [客戶名...] → 手動加入標示（新版另有自動計算 v_tick_warn3）
insert into public.tick_warn3_overrides (customer_code, mode, set_on)
select distinct m.code, 'add', (select service_date from public.tick_service_days where status = 'open')
from zx_src s, jsonb_array_elements_text(s.value) w(name)
join zx_name_map m on m.legacy_name = w.name
where s.key = 'zhongxin_warn3_v1' and jsonb_typeof(s.value) = 'array' and m.code is not null
on conflict (customer_code) do nothing;

-- ---------------------------------------------------------------------
-- B. 異常／交接：補新欄位（觸發器已處理之後的新寫入；這裡補舊資料）
-- ---------------------------------------------------------------------
update public.abnormal_reports set issue_description = reason
 where issue_description is null and reason is not null;
update public.handover_reports set handover_description = content
 where handover_description is null and content is not null;
update public.abnormal_reports set report_date = private.parse_legacy_date(date, created_at)
 where report_date is null and date is not null;
update public.handover_reports set report_date = private.parse_legacy_date(date, created_at)
 where report_date is null and date is not null;

-- 車號 → vehicles（只 trim，不改大小寫或符號，避免誤合併）
insert into public.vehicles (car_no)
select distinct trim(car_no) from public.abnormal_reports where coalesce(trim(car_no), '') <> ''
on conflict (car_no) do nothing;
update public.abnormal_reports a set vehicle_id = v.id
  from public.vehicles v
 where a.vehicle_id is null and v.car_no = trim(a.car_no);

-- 店家 → customer_code（恰好一個候選才填；原 store 文字保留為快照）
update public.abnormal_reports a set customer_code = m.code
  from zx_name_map m
 where a.customer_code is null and m.legacy_name = trim(a.store) and m.code is not null;
-- 交接表的 store 是「客戶名稱+車號」合併文字，無法可靠拆分 → 不自動填 customer_code（待確認）

-- 日期無法辨識的舊列 → 待確認
insert into public.legacy_name_review (source, legacy_name, note)
select 'report_date', date, count(*) || ' 筆無法辨識的日期格式'
from (select date from public.abnormal_reports where report_date is null and date is not null
      union all
      select date from public.handover_reports where report_date is null and date is not null) z
group by date
on conflict (source, legacy_name) do update set note = excluded.note;

-- 計數重算一次（backfill 時 zx.bulk 不影響計數觸發器，但保險起見）
update public.customer_quote_profiles p set
  saved_records_count = (select count(*) from public.customer_quote_items i where i.customer_code = p.customer_code and i.list_kind = 'saved'),
  quoted_prices_count = (select count(*) from public.customer_quote_items i where i.customer_code = p.customer_code and i.list_kind in ('matched', 'unmatched')),
  item_code_lookup_count = (select count(*) from public.customer_item_code_mappings m where m.customer_code = p.customer_code),
  has_mapping = exists (select 1 from public.customer_quote_mappings m where m.customer_code = p.customer_code and m.column_map <> '{}'::jsonb);

-- 每張表只發一則「整批更新」通知
select set_config('zx.bulk', 'off', true);
select private.emit_bulk('tick', 'daily_order_status');
select private.emit_bulk('report', 'abnormal_reports');
select private.emit_bulk('report', 'handover_reports');
select private.emit_bulk('quote', 'customer_quote_profiles');
select private.emit_bulk('shared', 'customers');

commit;
