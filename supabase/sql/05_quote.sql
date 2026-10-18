-- =====================================================================
-- 05_quote.sql ── 報價單匯出：舊 customers 上的大型 JSONB 拆成獨立表
-- 依現行程式碼（報價單匯出系統 app.js v22）確認的實際結構：
--   quote_cycle 為文字 '7天'|'10天'|'15天'|'30天'；trade_status 預設 '核准交易'
--   mapping           { dataStartRowIdx, columnMap: {欄索引: 目標欄位} }
--   saved_records     [{ 貨號,品名,單位,單價,備註,產區品種,裝箱方式,包裝資材,產地,不報價原因,變價原因,_isNew }]
--   quoted_prices     { matched: [{code, price, isNew}], unmatched: [{name, unit, price}] }
--   item_code_lookup  [{ name, code, itemName }]       last_item_codes [識別鍵...]
-- 新站首頁只讀 v_quote_customer_list（每客戶約 250 bytes），品項／對照表在開詳情、上傳或匯出時才讀。
-- 狀態：草稿，尚未在真實專案執行。
-- =====================================================================
begin;

create table if not exists public.master_items (
  item_code  text primary key,
  item_name  text,
  unit       text,
  spec_code  text,
  grade      text,
  updated_at timestamptz not null default now()
);
-- 主檔不做逐列推播：語句級觸發器只記一筆 '*' 並把 dataset_versions('master_items') +1，
-- 前端以 localStorage／IndexedDB 快取主檔，版本不同才用 .range() 分頁重抓
do $$ begin
  if not exists (select 1 from pg_trigger where tgrelid = 'public.master_items'::regclass and tgname = 'zx_log_bulk') then
    create trigger zx_log_bulk after insert or update or delete on public.master_items
      for each statement execute function private.log_bulk_change('quote');
  end if;
end $$;

-- 每位客戶的報價設定（原 customers 上的報價欄位）＋首頁所需計數（由觸發器維護）
create table if not exists public.customer_quote_profiles (
  customer_code          text primary key references public.customers(code) on update cascade on delete cascade,
  quote_cycle            text not null default '7天' check (quote_cycle in ('7天', '10天', '15天', '30天')),
  trade_status           text not null default '核准交易',
  product_code_mode      text not null default '有貨號' check (product_code_mode in ('有貨號', '無貨號')),
  export_status          text not null default '未匯出',
  last_export_time       timestamptz,
  last_export_filename   text not null default '',
  last_export_item_count int  not null default 0,
  notes                  text not null default '',
  unit_category          text not null default '' check (unit_category in ('', 'kg', '台斤')),
  quote_file_location    text not null default '',
  last_quote_upload_time timestamptz,
  has_mapping            boolean not null default false,   -- 階段①
  saved_records_count    int not null default 0,           -- 有貨號暫存品項數 → 階段②③
  quoted_prices_count    int not null default 0,           -- 無貨號暫存品項數（matched+unmatched）
  item_code_lookup_count int not null default 0,           -- 料號對照筆數 → 「待設定料號對照表」
  detail_version         bigint not null default 0         -- 品項／對照表／範本任何變動 +1，詳情與精靈據此決定是否重抓
);
select private.attach_sync('public.customer_quote_profiles', 'quote', 'customer_code',
  array['customer_code', 'export_status', 'has_mapping', 'saved_records_count', 'quoted_prices_count',
        'item_code_lookup_count', 'detail_version']);

-- 欄位對應範本（原 customers.mapping）
create table if not exists public.customer_quote_mappings (
  customer_code      text primary key references public.customers(code) on update cascade on delete cascade,
  data_start_row_idx int,
  column_map         jsonb not null default '{}'::jsonb,
  updated_at         timestamptz not null default now()
);

-- 暫存報價品項（原 saved_records / quoted_prices.matched / quoted_prices.unmatched）
-- 欄位名稱直接對應前端紀錄的 key；單價保留原始文字（客戶檔案可能寫「時價」等非數字）
create table if not exists public.customer_quote_items (
  id                  bigint generated always as identity primary key,
  customer_code       text not null references public.customers(code) on update cascade on delete cascade,
  list_kind           text not null check (list_kind in ('saved', 'matched', 'unmatched')),
  line_no             int  not null,
  item_code           text,      -- 貨號（saved=客戶貨號；matched=忠欣料號；unmatched=空）
  item_name           text,      -- 品名
  unit                text,      -- 單位
  price               text,      -- 單價（原始值）
  note                text,      -- 備註
  origin_variety      text,      -- 產區品種
  packing             text,      -- 裝箱方式
  packaging_material  text,      -- 包裝資材
  origin              text,      -- 產地
  no_quote_reason     text,      -- 不報價原因
  price_change_reason text,      -- 變價原因
  is_new              boolean not null default false,
  legacy              jsonb,     -- 從舊系統搬來的原始元素（無損）
  unique (customer_code, list_kind, line_no)
);

-- 上次品項識別鍵（原 last_item_codes）
create table if not exists public.customer_quote_baselines (
  customer_code text primary key references public.customers(code) on update cascade on delete cascade,
  item_codes    jsonb not null default '[]'::jsonb,
  updated_at    timestamptz not null default now()
);

-- 客戶品名 → 忠欣料號（原 item_code_lookup [{name, code, itemName}]）
create table if not exists public.customer_item_code_mappings (
  id                 uuid primary key default gen_random_uuid(),
  customer_code      text not null references public.customers(code) on update cascade on delete cascade,
  customer_item_name text not null,                -- name
  item_code          text not null,                -- code
  item_name          text not null default '',     -- itemName
  sort_order         int  not null default 0,
  unique (customer_code, customer_item_name)
);

-- 匯出紀錄
create table if not exists public.customer_quote_exports (
  id             uuid primary key default gen_random_uuid(),
  request_id     uuid unique,
  customer_codes text[] not null,
  filename       text,
  item_count     int,
  per_customer   jsonb,
  actor          uuid default auth.uid(),
  exported_at    timestamptz not null default now()
);
create index if not exists customer_quote_exports_at_idx on public.customer_quote_exports (exported_at desc, id);

-- ---------------------------------------------------------------------
-- 計數維護：語句級觸發器 + transition table → 一次批次寫入每位客戶只更新 profile 一次（只推播一則）
-- ---------------------------------------------------------------------
create or replace function private.quote_recount() returns trigger
language plpgsql security definer set search_path = '' as $$
declare v_codes text[];
begin
  if tg_op = 'DELETE' then
    select array_agg(distinct customer_code) into v_codes from old_rows;
  else
    select array_agg(distinct customer_code) into v_codes from new_rows;
  end if;
  if v_codes is null then return null; end if;

  insert into public.customer_quote_profiles (customer_code)
  select c.code from public.customers c where c.code = any (v_codes)   -- 客戶已被刪除（cascade）時不補建
  on conflict do nothing;

  update public.customer_quote_profiles p
     set detail_version = p.detail_version + 1,
         saved_records_count = (select count(*) from public.customer_quote_items i
                                where i.customer_code = p.customer_code and i.list_kind = 'saved'),
         quoted_prices_count = (select count(*) from public.customer_quote_items i
                                where i.customer_code = p.customer_code and i.list_kind in ('matched', 'unmatched')),
         item_code_lookup_count = (select count(*) from public.customer_item_code_mappings m where m.customer_code = p.customer_code),
         has_mapping = exists (select 1 from public.customer_quote_mappings m
                               where m.customer_code = p.customer_code and m.column_map <> '{}'::jsonb)
   where p.customer_code = any (v_codes);
  return null;
end $$;

do $$
declare t text; ev text;
begin
  foreach t in array array['customer_quote_items', 'customer_item_code_mappings', 'customer_quote_mappings'] loop
    foreach ev in array array['insert', 'update', 'delete'] loop
      if not exists (select 1 from pg_trigger where tgrelid = format('public.%I', t)::regclass and tgname = 'zx_recount_' || ev) then
        execute format('create trigger %I after %s on public.%I referencing %s table as %s for each statement execute function private.quote_recount()',
                       'zx_recount_' || ev, ev, t,
                       case ev when 'delete' then 'old' else 'new' end,
                       case ev when 'delete' then 'old_rows' else 'new_rows' end);
      end if;
    end loop;
  end loop;
end $$;

-- 首頁清單：輕量欄位，500 位客戶約 125 KB（未壓縮，gzip 後約 20 KB）
create or replace view public.v_quote_customer_list with (security_invoker = true) as
select c.code, c.name,
       p.quote_cycle, p.trade_status, p.product_code_mode, p.export_status, p.last_export_time,
       p.last_export_filename, p.last_export_item_count, p.notes, p.unit_category,
       p.quote_file_location, p.last_quote_upload_time,
       p.has_mapping, p.saved_records_count, p.quoted_prices_count, p.item_code_lookup_count,
       p.detail_version, p.revision
from public.customers c
join public.customer_quote_profiles p on p.customer_code = c.code;

-- ---------------------------------------------------------------------
-- 寫入 RPC（皆回傳 v_quote_customer_list 的最新列，前端直接 upsertCustomer）
-- ---------------------------------------------------------------------
create or replace function private.quote_rows(p_codes text[]) returns jsonb
language sql stable security invoker set search_path = '' as $$
  select coalesce(jsonb_agg(to_jsonb(v) order by v.code), '[]') from public.v_quote_customer_list v where v.code = any (p_codes)
$$;

-- 新增／編輯／批次匯入客戶。p_rows：[{code, name?, product_code_mode?, quote_cycle?, export_status?,
--   last_export_time?, last_export_filename?, unit_category?, notes?, quote_file_location?, trade_status?}]
-- 只更新該列有出現的 key（沒給的欄位維持原值），對應原 upsert 的語意
create or replace function public.quote_upsert_customers(p_rows jsonb, p_request_id uuid default null)
returns jsonb language plpgsql security invoker set search_path = '' as $$
declare
  v_prev jsonb := private.replayed(p_request_id);
  r      jsonb;
  v_codes text[] := '{}';
begin
  if v_prev is not null then return v_prev; end if;
  if not private.can_write() then raise exception 'no write permission' using errcode = '42501'; end if;
  for r in select * from jsonb_array_elements(p_rows) loop
    if coalesce(btrim(r ->> 'code'), '') = '' then continue; end if;
    insert into public.customers (code, name) values (btrim(r ->> 'code'), coalesce(r ->> 'name', ''))
    on conflict (code) do update set name = case when r ? 'name' then excluded.name else public.customers.name end;
    insert into public.customer_quote_profiles (customer_code) values (btrim(r ->> 'code')) on conflict do nothing;
    update public.customer_quote_profiles set
      product_code_mode   = case when r ? 'product_code_mode' then r ->> 'product_code_mode' else product_code_mode end,
      quote_cycle         = case when r ? 'quote_cycle' then r ->> 'quote_cycle' else quote_cycle end,
      trade_status        = case when r ? 'trade_status' then r ->> 'trade_status' else trade_status end,
      export_status       = case when r ? 'export_status' then r ->> 'export_status' else export_status end,
      last_export_time    = case when r ? 'last_export_time' then (r ->> 'last_export_time')::timestamptz else last_export_time end,
      last_export_filename = case when r ? 'last_export_filename' then coalesce(r ->> 'last_export_filename', '') else last_export_filename end,
      unit_category       = case when r ? 'unit_category' then coalesce(r ->> 'unit_category', '') else unit_category end,
      notes               = case when r ? 'notes' then coalesce(r ->> 'notes', '') else notes end,
      quote_file_location = case when r ? 'quote_file_location' then coalesce(r ->> 'quote_file_location', '') else quote_file_location end
    where customer_code = btrim(r ->> 'code');
    v_codes := v_codes || btrim(r ->> 'code');
  end loop;
  return private.remember(p_request_id, 'quote_upsert_customers', private.quote_rows(v_codes));
end $$;

-- 批次修改／重置匯出狀態／清除單一客戶匯出紀錄：同一組 patch 套用到多位客戶
--   p_codes 為 null = 全部客戶（「重置本期匯出狀態」）
create or replace function public.quote_patch_profiles(p_codes text[], p_patch jsonb)
returns jsonb language plpgsql security invoker set search_path = '' as $$
declare v_codes text[];
begin
  if not private.can_write() then raise exception 'no write permission' using errcode = '42501'; end if;
  update public.customer_quote_profiles set
    product_code_mode   = case when p_patch ? 'product_code_mode' then p_patch ->> 'product_code_mode' else product_code_mode end,
    quote_cycle         = case when p_patch ? 'quote_cycle' then p_patch ->> 'quote_cycle' else quote_cycle end,
    export_status       = case when p_patch ? 'export_status' then p_patch ->> 'export_status' else export_status end,
    last_export_time    = case when p_patch ? 'last_export_time' then (p_patch ->> 'last_export_time')::timestamptz else last_export_time end,
    last_export_filename = case when p_patch ? 'last_export_filename' then coalesce(p_patch ->> 'last_export_filename', '') else last_export_filename end
  where p_codes is null or customer_code = any (p_codes);
  select coalesce(array_agg(customer_code), '{}') into v_codes from public.customer_quote_profiles
  where p_codes is null or customer_code = any (p_codes);
  return private.quote_rows(v_codes);
end $$;

-- 儲存上傳結果（原 saveHasCodeRecords／saveQuotedPrices）：整批取代暫存品項＋上次品項＋合併手動料號對照，單一交易
--   p_items：[{list_kind, item_code, item_name, unit, price, note, origin_variety, packing, packaging_material,
--              origin, no_quote_reason, price_change_reason, is_new}]
--   p_new_lookups：[{name, code, itemName}]（精靈第 3 步手動補上的料號，合併進對照表）
--   p_expected_revision：開精靈時看到的 profile 版本；null = 不檢查
create or replace function public.quote_save_items(
  p_customer_code text, p_items jsonb, p_baseline jsonb, p_item_count int,
  p_new_lookups jsonb default '[]', p_expected_revision bigint default null, p_request_id uuid default null)
returns jsonb language plpgsql security invoker set search_path = '' as $$
declare
  v_prev jsonb := private.replayed(p_request_id);
  v_rev  bigint;
begin
  if v_prev is not null then return v_prev; end if;
  if not private.can_write() then raise exception 'no write permission' using errcode = '42501'; end if;

  select revision into v_rev from public.customer_quote_profiles where customer_code = p_customer_code for update;
  if p_expected_revision is not null and v_rev is distinct from p_expected_revision then
    return jsonb_build_object('ok', false, 'reason', 'conflict', 'rows', private.quote_rows(array[p_customer_code]));
  end if;

  delete from public.customer_quote_items where customer_code = p_customer_code;
  insert into public.customer_quote_items (customer_code, list_kind, line_no, item_code, item_name, unit, price, note,
    origin_variety, packing, packaging_material, origin, no_quote_reason, price_change_reason, is_new)
  select p_customer_code, x.list_kind, (row_number() over (partition by x.list_kind order by o.n))::int,
         x.item_code, x.item_name, x.unit, x.price, x.note, x.origin_variety, x.packing, x.packaging_material,
         x.origin, x.no_quote_reason, x.price_change_reason, coalesce(x.is_new, false)
  from jsonb_array_elements(coalesce(p_items, '[]')) with ordinality o(e, n),
       jsonb_to_record(o.e) as x(list_kind text, item_code text, item_name text, unit text, price text, note text,
         origin_variety text, packing text, packaging_material text, origin text, no_quote_reason text,
         price_change_reason text, is_new boolean);

  insert into public.customer_item_code_mappings (customer_code, customer_item_name, item_code, item_name, sort_order)
  select p_customer_code, l.name, l.code, coalesce(l."itemName", ''),
         coalesce((select max(sort_order) from public.customer_item_code_mappings where customer_code = p_customer_code), 0) + l.n::int
  from (select x.name, x.code, x."itemName", o.n
        from jsonb_array_elements(coalesce(p_new_lookups, '[]')) with ordinality o(e, n),
             jsonb_to_record(o.e) as x(name text, code text, "itemName" text)) l
  where coalesce(l.name, '') <> '' and coalesce(l.code, '') <> ''
  on conflict (customer_code, customer_item_name) do update set item_code = excluded.item_code, item_name = excluded.item_name;

  insert into public.customer_quote_baselines (customer_code, item_codes) values (p_customer_code, coalesce(p_baseline, '[]'))
  on conflict (customer_code) do update set item_codes = excluded.item_codes, updated_at = now();

  update public.customer_quote_profiles
     set last_quote_upload_time = now(), last_export_item_count = coalesce(p_item_count, 0)
   where customer_code = p_customer_code;

  return private.remember(p_request_id, 'quote_save_items',
                          jsonb_build_object('ok', true, 'rows', private.quote_rows(array[p_customer_code])));
end $$;

-- 料號對照表整份取代（單筆新增／編輯／刪除與整批上傳都走這裡，對應原 saveItemCodeLookup 的語意）
create or replace function public.quote_replace_lookups(p_customer_code text, p_entries jsonb, p_request_id uuid default null)
returns jsonb language plpgsql security invoker set search_path = '' as $$
declare v_prev jsonb := private.replayed(p_request_id);
begin
  if v_prev is not null then return v_prev; end if;
  if not private.can_write() then raise exception 'no write permission' using errcode = '42501'; end if;
  delete from public.customer_item_code_mappings where customer_code = p_customer_code;
  insert into public.customer_item_code_mappings (customer_code, customer_item_name, item_code, item_name, sort_order)
  select distinct on (l.name) p_customer_code, l.name, l.code, coalesce(l."itemName", ''), l.n::int
  from (select x.name, x.code, x."itemName", o.n
        from jsonb_array_elements(coalesce(p_entries, '[]')) with ordinality o(e, n),
             jsonb_to_record(o.e) as x(name text, code text, "itemName" text)) l
  where coalesce(l.name, '') <> '' and coalesce(l.code, '') <> ''
  order by l.name, l.n desc;
  insert into public.customer_quote_profiles (customer_code) values (p_customer_code) on conflict do nothing;
  return private.remember(p_request_id, 'quote_replace_lookups', private.quote_rows(array[p_customer_code]));
end $$;

-- 儲存／清除欄位對應範本（p_mapping 為 null = 清除，對應「重新設定欄位對應」）
create or replace function public.quote_set_mapping(p_customer_code text, p_mapping jsonb)
returns jsonb language plpgsql security invoker set search_path = '' as $$
begin
  if not private.can_write() then raise exception 'no write permission' using errcode = '42501'; end if;
  if p_mapping is null then
    delete from public.customer_quote_mappings where customer_code = p_customer_code;
  else
    insert into public.customer_quote_mappings (customer_code, data_start_row_idx, column_map)
    values (p_customer_code, (p_mapping ->> 'dataStartRowIdx')::int, coalesce(p_mapping -> 'columnMap', '{}'))
    on conflict (customer_code) do update set data_start_row_idx = excluded.data_start_row_idx,
                                              column_map = excluded.column_map, updated_at = now();
  end if;
  return private.quote_rows(array[p_customer_code]);
end $$;

-- 匯出成功「寫檔之後」才呼叫；使用者取消存檔則前端不呼叫
--   p_items：[{customer_code, item_count, expected_revision?}]；給了 expected_revision 且不符 → 該客戶不標記並回報
create or replace function public.quote_mark_exported(p_filename text, p_items jsonb, p_request_id uuid default null)
returns jsonb language plpgsql security invoker set search_path = '' as $$
declare
  v_prev jsonb := private.replayed(p_request_id);
  v_ok   text[];
  v_bad  jsonb;
begin
  if v_prev is not null then return v_prev; end if;
  if not private.can_write() then raise exception 'no write permission' using errcode = '42501'; end if;

  with req as (
    select * from jsonb_to_recordset(p_items) as r(customer_code text, item_count int, expected_revision bigint)
  ), upd as (
    update public.customer_quote_profiles p
       set export_status = '已匯出', last_export_time = now(), last_export_filename = p_filename
      from req
     where p.customer_code = req.customer_code
       and (req.expected_revision is null or p.revision = req.expected_revision)
    returning p.customer_code
  )
  select coalesce(array_agg(customer_code), '{}') into v_ok from upd;

  select coalesce(jsonb_agg(r.customer_code), '[]') into v_bad
  from jsonb_to_recordset(p_items) as r(customer_code text)
  where not (r.customer_code = any (v_ok));

  insert into public.customer_quote_exports (request_id, customer_codes, filename, item_count, per_customer)
  values (p_request_id, v_ok, p_filename,
          (select sum((e ->> 'item_count')::int) from jsonb_array_elements(p_items) e where e ->> 'customer_code' = any (v_ok)),
          p_items);

  return private.remember(p_request_id, 'quote_mark_exported',
    jsonb_build_object('ok', jsonb_array_length(v_bad) = 0, 'conflicts', v_bad, 'rows', private.quote_rows(v_ok)));
end $$;

-- 刪除客戶（報價系統）：只移除報價相關資料；customers 是三站共用主檔，不在這裡刪
create or replace function public.quote_delete_customers(p_codes text[])
returns jsonb language plpgsql security invoker set search_path = '' as $$
declare v_n int;
begin
  if not private.can_delete() then raise exception '只有管理員可以刪除客戶' using errcode = '42501'; end if;
  delete from public.customer_quote_items where customer_code = any (p_codes);
  delete from public.customer_item_code_mappings where customer_code = any (p_codes);
  delete from public.customer_quote_mappings where customer_code = any (p_codes);
  delete from public.customer_quote_baselines where customer_code = any (p_codes);
  delete from public.customer_quote_profiles where customer_code = any (p_codes);
  get diagnostics v_n = row_count;
  return jsonb_build_object('ok', true, 'deleted', v_n);
end $$;

-- 品項主檔上傳：upsert（前端已依原邏輯處理「沒有規格代號欄就沿用舊值」；p_has_spec=false 時伺服器再保險一次）
create or replace function public.master_items_upsert(p_items jsonb, p_has_spec boolean)
returns jsonb language plpgsql security invoker set search_path = '' as $$
declare v_n int;
begin
  if not private.can_write() then raise exception 'no write permission' using errcode = '42501'; end if;
  insert into public.master_items as m (item_code, item_name, unit, spec_code, grade, updated_at)
  select x.item_code, x.item_name, x.unit, x.spec_code, x.grade, now()
  from jsonb_to_recordset(p_items) as x(item_code text, item_name text, unit text, spec_code text, grade text)
  where coalesce(x.item_code, '') <> ''
  on conflict (item_code) do update set
    item_name  = excluded.item_name,
    unit       = excluded.unit,
    spec_code  = case when p_has_spec then excluded.spec_code else coalesce(nullif(excluded.spec_code, ''), m.spec_code) end,
    grade      = excluded.grade,
    updated_at = now();
  get diagnostics v_n = row_count;
  return jsonb_build_object('ok', true, 'upserted', v_n);
end $$;

do $$
declare f text;
begin
  foreach f in array array['quote_upsert_customers(jsonb, uuid)', 'quote_patch_profiles(text[], jsonb)',
    'quote_save_items(text, jsonb, jsonb, int, jsonb, bigint, uuid)', 'quote_replace_lookups(text, jsonb, uuid)',
    'quote_set_mapping(text, jsonb)', 'quote_mark_exported(text, jsonb, uuid)', 'quote_delete_customers(text[])',
    'master_items_upsert(jsonb, boolean)'] loop
    execute format('revoke all on function public.%s from public, anon', f);
    execute format('grant execute on function public.%s to authenticated', f);
  end loop;
end $$;
grant execute on function private.quote_rows(text[]) to authenticated;

-- RLS：成員讀、staff 寫；報價子表（品項、對照、範本、上次品項）的刪除屬於「整批取代」的一部分 → staff 可；
--      profile（＝從報價系統移除客戶）與主檔刪除 → can_delete()（預設 admin）
do $$
declare t text;
begin
  foreach t in array array['master_items', 'customer_quote_profiles', 'customer_quote_mappings', 'customer_quote_items',
                           'customer_quote_baselines', 'customer_item_code_mappings', 'customer_quote_exports'] loop
    execute format('alter table public.%I enable row level security', t);
    execute format('drop policy if exists zx_select on public.%I', t);
    execute format('create policy zx_select on public.%I for select to authenticated using ((select private.is_member()))', t);
    execute format('drop policy if exists zx_insert on public.%I', t);
    execute format('create policy zx_insert on public.%I for insert to authenticated with check ((select private.can_write()))', t);
    execute format('drop policy if exists zx_update on public.%I', t);
    execute format('create policy zx_update on public.%I for update to authenticated using ((select private.can_write())) with check ((select private.can_write()))', t);
    execute format('drop policy if exists zx_delete on public.%I', t);
    if t in ('customer_quote_items', 'customer_item_code_mappings', 'customer_quote_mappings', 'customer_quote_baselines') then
      execute format('create policy zx_delete on public.%I for delete to authenticated using ((select private.can_write()))', t);
    else
      execute format('create policy zx_delete on public.%I for delete to authenticated using ((select private.can_delete()))', t);
    end if;
  end loop;
end $$;

commit;
