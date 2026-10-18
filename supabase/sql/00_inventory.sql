-- =====================================================================
-- 00_inventory.sql ── 忠欣三系統｜資料庫盤點（唯讀）
-- 用法：Supabase Dashboard → SQL Editor 貼上整份執行，
--       把結果那一格 JSON 全部複製回傳給開發者。
-- 安全性：只建立 pg_temp 暫存函式（連線結束即消失），不改任何資料或結構。
--         不讀取 auth.users 的 email 等個資，只計數。
-- =====================================================================

-- 舊打勾單以 JSON.stringify 寫入：欄位可能是 text，或 jsonb 裡包著字串 → 統一解開
create or replace function pg_temp.zx_j(v jsonb) returns jsonb language plpgsql immutable as $j$
begin
  if jsonb_typeof(v) = 'string' then return (v #>> '{}')::jsonb; end if;
  return v;
exception when others then return v;
end $j$;

create or replace function pg_temp.zx_inventory() returns jsonb
language plpgsql as $fn$
declare
  r       record;
  out     jsonb := '{}'::jsonb;
  tbls    jsonb := '[]'::jsonb;
  t       jsonb;
  n       bigint;
  kv      jsonb;
  tmp     jsonb;
  legacy  text;
begin
  out := out || jsonb_build_object(
    'generated_at', now(),
    'pg_version',   current_setting('server_version'),
    'extensions',   (select coalesce(jsonb_agg(extname || ' ' || extversion order by extname), '[]') from pg_extension),
    'schemas',      (select coalesce(jsonb_agg(nspname order by nspname), '[]') from pg_namespace
                       where nspname !~ '^pg_' and nspname <> 'information_schema'),
    'realtime_send_exists', exists(select 1 from pg_proc p join pg_namespace s on s.oid = p.pronamespace
                                   where s.nspname = 'realtime' and p.proname = 'send'),
    'realtime_messages_exists', to_regclass('realtime.messages') is not null,
    'pg_cron_exists', exists(select 1 from pg_extension where extname = 'pg_cron')
  );

  if to_regclass('auth.users') is not null then
    execute 'select count(*) from auth.users' into n;
    out := out || jsonb_build_object('auth_user_count', n);
  end if;

  -- 每張 public 表：精確筆數、大小、RLS 狀態、欄位、約束、索引、觸發器
  for r in
    select c.oid, c.relname, c.relrowsecurity, c.relforcerowsecurity
    from pg_class c join pg_namespace s on s.oid = c.relnamespace
    where s.nspname = 'public' and c.relkind in ('r','p')
    order by c.relname
  loop
    execute format('select count(*) from public.%I', r.relname) into n;
    t := jsonb_build_object(
      'table', r.relname,
      'rows', n,
      'total_size', pg_size_pretty(pg_total_relation_size(r.oid)),
      'total_bytes', pg_total_relation_size(r.oid),
      'rls', r.relrowsecurity,
      'force_rls', r.relforcerowsecurity,
      'columns', (select jsonb_agg(jsonb_build_object(
                     'name', a.attname,
                     'type', format_type(a.atttypid, a.atttypmod),
                     'not_null', a.attnotnull,
                     'default', pg_get_expr(d.adbin, d.adrelid),
                     'generated', nullif(a.attgenerated, '')) order by a.attnum)
                  from pg_attribute a
                  left join pg_attrdef d on d.adrelid = a.attrelid and d.adnum = a.attnum
                  where a.attrelid = r.oid and a.attnum > 0 and not a.attisdropped),
      'constraints', (select coalesce(jsonb_agg(conname || ': ' || pg_get_constraintdef(oid)), '[]')
                      from pg_constraint where conrelid = r.oid),
      'indexes', (select coalesce(jsonb_agg(pg_get_indexdef(indexrelid)), '[]')
                  from pg_index where indrelid = r.oid),
      'triggers', (select coalesce(jsonb_agg(tgname || ': ' || pg_get_triggerdef(oid)), '[]')
                   from pg_trigger where tgrelid = r.oid and not tgisinternal)
    );
    tbls := tbls || jsonb_build_array(t);
  end loop;
  out := out || jsonb_build_object('public_tables', tbls);

  out := out || jsonb_build_object(
    'views', (select coalesce(jsonb_agg(table_name), '[]') from information_schema.views where table_schema = 'public'),
    'functions', (select coalesce(jsonb_agg(p.proname || '(' || pg_get_function_identity_arguments(p.oid) || ')'
                    || case when p.prosecdef then ' SECURITY DEFINER' else '' end), '[]')
                  from pg_proc p join pg_namespace s on s.oid = p.pronamespace where s.nspname = 'public'),
    'policies', (select coalesce(jsonb_agg(jsonb_build_object(
                    'schema', schemaname, 'table', tablename, 'name', policyname, 'cmd', cmd,
                    'roles', roles, 'using', qual, 'check', with_check)), '[]')
                 from pg_policies where schemaname in ('public','realtime','storage')),
    'publications', (select coalesce(jsonb_agg(jsonb_build_object(
                        'pub', pubname, 'schema', schemaname, 'table', tablename)), '[]')
                     from pg_publication_tables),
    'grants_anon_authenticated', (select coalesce(jsonb_agg(distinct grantee || ' ' || privilege_type || ' ' || table_name), '[]')
                     from information_schema.role_table_grants
                     where table_schema = 'public' and grantee in ('anon','authenticated')));
  if to_regclass('storage.buckets') is not null then
    execute $q$ select coalesce(jsonb_agg(name), '[]') from storage.buckets $q$ into tmp;
    out := out || jsonb_build_object('storage_buckets', tmp);
  end if;

  -- 打勾單 key-value 表：名稱大小寫兩種都檢查，不假設哪一個存在
  kv := '[]'::jsonb;
  foreach legacy in array array['zhongxin_store', 'Chunghsin_store', 'chunghsin_store'] loop
    if to_regclass(format('public.%I', legacy)) is not null then
      execute format($q$
        select coalesce(jsonb_agg(jsonb_build_object(
                 'key', key,
                 'value_type', jsonb_typeof(pg_temp.zx_j(to_jsonb(value))),
                 'stored_as_string', jsonb_typeof(to_jsonb(value)) = 'string',
                 'value_bytes', pg_column_size(value),
                 'text_length', length(value::text),
                 'top_level_count', case jsonb_typeof(pg_temp.zx_j(to_jsonb(value)))
                                      when 'object' then (select count(*) from jsonb_object_keys(pg_temp.zx_j(to_jsonb(value))))
                                      when 'array'  then jsonb_array_length(pg_temp.zx_j(to_jsonb(value))) end,
                 -- 只取結構，不取內容：物件的第一個子值、陣列第一個元素的 key
                 'sample_shape', case jsonb_typeof(pg_temp.zx_j(to_jsonb(value)))
                                   when 'object' then (select jsonb_build_object('first_key_len', length(k), 'first_value_keys',
                                                        case jsonb_typeof(pg_temp.zx_j(to_jsonb(value)) -> k) when 'object'
                                                          then (select jsonb_agg(x) from jsonb_object_keys(pg_temp.zx_j(to_jsonb(value)) -> k) x)
                                                          else to_jsonb(jsonb_typeof(pg_temp.zx_j(to_jsonb(value)) -> k)) end)
                                                       from jsonb_object_keys(pg_temp.zx_j(to_jsonb(value))) k limit 1)
                                   when 'array' then case jsonb_typeof(pg_temp.zx_j(to_jsonb(value)) -> 0) when 'object'
                                                       then (select jsonb_agg(x) from jsonb_object_keys(pg_temp.zx_j(to_jsonb(value)) -> 0) x)
                                                       else to_jsonb(jsonb_typeof(pg_temp.zx_j(to_jsonb(value)) -> 0)) end
                                 end
               ) order by key), '[]')
        from public.%I $q$, legacy) into tmp;
      kv := kv || jsonb_build_array(jsonb_build_object('table', legacy, 'keys', tmp));
    end if;
  end loop;
  out := out || jsonb_build_object('legacy_kv', kv);

  -- 打勾單 zhongxin_v4 的 status / date 實際值分布（決定新表 check 約束與日期轉換）
  foreach legacy in array array['zhongxin_store', 'Chunghsin_store', 'chunghsin_store'] loop
    if to_regclass(format('public.%I', legacy)) is not null then
      execute format($q$
        select jsonb_build_object(
          'status_values', (select jsonb_object_agg(coalesce(s, '(null)'), c) from (
                              select e.value->>'status' s, count(*) c
                              from public.%1$I kv, jsonb_each(pg_temp.zx_j(to_jsonb(kv.value))) e
                              where kv.key = 'zhongxin_v4' and jsonb_typeof(pg_temp.zx_j(to_jsonb(kv.value))) = 'object'
                              group by 1) z),
          'date_patterns', (select jsonb_object_agg(coalesce(p, '(null)'), c) from (
                              select regexp_replace(e.value->>'date', '\d', '9', 'g') p, count(*) c
                              from public.%1$I kv, jsonb_each(pg_temp.zx_j(to_jsonb(kv.value))) e
                              where kv.key = 'zhongxin_v4' and jsonb_typeof(pg_temp.zx_j(to_jsonb(kv.value))) = 'object'
                              group by 1) z),
          'fixed_values', (select jsonb_object_agg(coalesce(f, '(null)'), c) from (
                              select e.value->>'fixed' f, count(*) c
                              from public.%1$I kv, jsonb_each(pg_temp.zx_j(to_jsonb(kv.value))) e
                              where kv.key = 'zhongxin_v4' and jsonb_typeof(pg_temp.zx_j(to_jsonb(kv.value))) = 'object'
                              group by 1) z)
        ) $q$, legacy) into tmp;
      out := out || jsonb_build_object('tick_v4_profile_' || legacy, tmp);
    end if;
  end loop;

  -- 異常／交接：舊 date 欄位(text)格式分布，決定 report_date 轉換規則
  if to_regclass('public.abnormal_reports') is not null
     and exists (select 1 from information_schema.columns where table_schema='public' and table_name='abnormal_reports' and column_name='date') then
    execute $q$ select jsonb_object_agg(coalesce(p,'(null)'), c) from (
                  select regexp_replace(date::text, '\d', '9', 'g') p, count(*) c from public.abnormal_reports group by 1) z $q$ into tmp;
    out := out || jsonb_build_object('abnormal_date_patterns', tmp);
    execute $q$ select jsonb_object_agg(coalesce(v,'(null)'), c) from (
                  select left(category, 2) v, count(*) c from public.abnormal_reports group by 1) z $q$ into tmp;
    out := out || jsonb_build_object('abnormal_category_prefix', tmp);
  end if;
  if to_regclass('public.handover_reports') is not null
     and exists (select 1 from information_schema.columns where table_schema='public' and table_name='handover_reports' and column_name='date') then
    execute $q$ select jsonb_object_agg(coalesce(p,'(null)'), c) from (
                  select regexp_replace(date::text, '\d', '9', 'g') p, count(*) c from public.handover_reports group by 1) z $q$ into tmp;
    out := out || jsonb_build_object('handover_date_patterns', tmp);
  end if;

  -- 報價：customers 上大型 JSONB 的大小與元素 key（決定拆表與 backfill 對應）
  if to_regclass('public.customers') is not null then
    tmp := '{}'::jsonb;
    for r in select column_name from information_schema.columns
             where table_schema='public' and table_name='customers' and data_type = 'jsonb' loop
      execute format($q$
        select jsonb_build_object(
          'sum_bytes', coalesce(sum(pg_column_size(%1$I)), 0),
          'max_bytes', coalesce(max(pg_column_size(%1$I)), 0),
          'types', (select jsonb_object_agg(coalesce(t,'(null)'), c) from (select jsonb_typeof(%1$I) t, count(*) c from public.customers group by 1) z),
          'top_keys', (select jsonb_agg(distinct k) from (select jsonb_object_keys(%1$I) k from public.customers where jsonb_typeof(%1$I)='object' limit 2000) z),
          'element_keys', (select jsonb_agg(distinct k) from (
                             select jsonb_object_keys(e) k
                             from public.customers, jsonb_array_elements(case jsonb_typeof(%1$I) when 'array' then %1$I else '[]' end) e
                             where jsonb_typeof(e) = 'object' limit 5000) z)
        ) from public.customers $q$, r.column_name) into t;
      tmp := tmp || jsonb_build_object(r.column_name, t);
    end loop;
    out := out || jsonb_build_object('customers_jsonb_profile', tmp);
    -- 無貨號 quoted_prices.matched / unmatched 元素的 key（backfill 欄位對應依此修正）
    if exists (select 1 from information_schema.columns where table_schema='public' and table_name='customers' and column_name='quoted_prices') then
      execute $q$ select jsonb_build_object(
          'matched', (select jsonb_agg(distinct k) from (select jsonb_object_keys(e) k from public.customers,
                        jsonb_array_elements(case jsonb_typeof(quoted_prices->'matched') when 'array' then quoted_prices->'matched' else '[]' end) e
                        where jsonb_typeof(e) = 'object' limit 5000) z),
          'unmatched', (select jsonb_agg(distinct k) from (select jsonb_object_keys(e) k from public.customers,
                        jsonb_array_elements(case jsonb_typeof(quoted_prices->'unmatched') when 'array' then quoted_prices->'unmatched' else '[]' end) e
                        where jsonb_typeof(e) = 'object' limit 5000) z)) $q$ into tmp;
      out := out || jsonb_build_object('quoted_prices_element_keys', tmp);
    end if;
    -- 重複名稱（不可自動合併，需人工確認）
    execute $q$ select coalesce(jsonb_agg(jsonb_build_object('name', name, 'codes', codes)), '[]') from (
                  select name, jsonb_agg(code) codes from public.customers group by name having count(*) > 1) z $q$ into tmp;
    out := out || jsonb_build_object('customers_duplicate_names', tmp);
  end if;

  return out;
end
$fn$;

select jsonb_pretty(pg_temp.zx_inventory()) as inventory;
