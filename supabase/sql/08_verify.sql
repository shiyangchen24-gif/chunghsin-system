-- =====================================================================
-- 08_verify.sql ── backfill 無損核對（唯讀）。每一列 ok 必須為 true 才可切換。
-- =====================================================================
with src as (
  select distinct on (key) key, value from public.legacy_kv_archive
  where source_table = coalesce((select min(source_table) from public.legacy_kv_archive
                                 where source_table in ('Chunghsin_store', 'chunghsin_store')), 'zhongxin_store')
  order by key, archived_at desc
), v4 as (
  select k as name from src, jsonb_object_keys(src.value) k where src.key = 'zhongxin_v4' and jsonb_typeof(src.value) = 'object'
), checks as (
  select '打勾單 v4：已轉入客戶 + 待確認 = 舊客戶數' as item,
         (select count(*) from v4) as legacy,
         (select count(*) from v4 where exists (select 1 from public.tick_customers t where t.legacy_name = v4.name))
         + (select count(*) from v4 where exists (select 1 from public.legacy_name_review r
              where r.source = 'name_match' and r.resolved_code is null and r.legacy_name = v4.name)) as migrated
  union all
  select '打勾單 v4：有叫貨／今日不叫貨 筆數（目前營業日）',
         (select count(*) from src, jsonb_each(src.value) e where src.key = 'zhongxin_v4' and jsonb_typeof(src.value) = 'object'
            and e.value ->> 'status' in ('有叫貨', '今日不叫貨')
            and exists (select 1 from public.tick_customers t where t.legacy_name = e.key)),
         (select count(*) from public.daily_order_status s join public.tick_service_days d using (service_date) where d.status = 'open')
  union all
  select '打勾單 hist：快照天數',
         (select count(*) from src, jsonb_array_elements(src.value) h
           where src.key = 'zhongxin_hist_v4' and jsonb_typeof(src.value) = 'array'),
         (select count(*) from public.order_history_days)
  union all
  select '異常表：issue_description = reason', (select count(*) from public.abnormal_reports),
         (select count(*) from public.abnormal_reports where issue_description is not distinct from reason)
  union all
  select '交接表：handover_description = content', (select count(*) from public.handover_reports),
         (select count(*) from public.handover_reports where handover_description is not distinct from content)
  union all
  select '異常表：日期已解析（未解析者列在 legacy_name_review）',
         (select count(*) from public.abnormal_reports where date is not null),
         (select count(*) from public.abnormal_reports where report_date is not null)
)
select item, legacy, migrated, legacy = migrated as ok from checks;

-- 報價：逐客戶比對舊 JSON（legacy_quote_customers）與新表；有差異才列出（應為 0 列）
select l.code,
       jsonb_array_length(coalesce(l.row -> 'saved_records', '[]')) as legacy_saved,
       (select count(*) from public.customer_quote_items i where i.customer_code = l.code and i.list_kind = 'saved') as new_saved,
       jsonb_array_length(coalesce(l.row #> '{quoted_prices,matched}', '[]')) + jsonb_array_length(coalesce(l.row #> '{quoted_prices,unmatched}', '[]')) as legacy_quoted,
       (select count(*) from public.customer_quote_items i where i.customer_code = l.code and i.list_kind in ('matched','unmatched')) as new_quoted,
       (select count(distinct e ->> 'name') from jsonb_array_elements(coalesce(l.row -> 'item_code_lookup', '[]')) e
         where coalesce(e ->> 'name', '') <> '' and coalesce(e ->> 'code', '') <> '') as legacy_lookup,
       (select count(*) from public.customer_item_code_mappings m where m.customer_code = l.code) as new_lookup,
       -- 無損：舊陣列 = 新表 legacy 欄依序組回
       coalesce(l.row -> 'saved_records', '[]') = (select coalesce(jsonb_agg(i.legacy order by i.line_no), '[]') from public.customer_quote_items i
                          where i.customer_code = l.code and i.list_kind = 'saved') as saved_lossless
from public.legacy_quote_customers l
where jsonb_array_length(coalesce(l.row -> 'saved_records', '[]'))
      <> (select count(*) from public.customer_quote_items i where i.customer_code = l.code and i.list_kind = 'saved')
   or jsonb_array_length(coalesce(l.row #> '{quoted_prices,matched}', '[]')) + jsonb_array_length(coalesce(l.row #> '{quoted_prices,unmatched}', '[]'))
      <> (select count(*) from public.customer_quote_items i where i.customer_code = l.code and i.list_kind in ('matched','unmatched'))
   or (select count(distinct e ->> 'name') from jsonb_array_elements(coalesce(l.row -> 'item_code_lookup', '[]')) e
         where coalesce(e ->> 'name', '') <> '' and coalesce(e ->> 'code', '') <> '')
      <> (select count(*) from public.customer_item_code_mappings m where m.customer_code = l.code)
   or coalesce(l.row -> 'saved_records', '[]') is distinct from (select coalesce(jsonb_agg(i.legacy order by i.line_no), '[]')
        from public.customer_quote_items i where i.customer_code = l.code and i.list_kind = 'saved');

-- 待人工確認清單
select source, legacy_name, candidates, note from public.legacy_name_review where resolved_code is null order by source, legacy_name;
