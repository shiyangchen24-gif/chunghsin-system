-- =====================================================================
-- 09_export_customer_names.sql ── 產生異常表的 STATIC_CUSTOMER_NAMES（唯讀）
-- 來源：打勾單現有客戶（"Chunghsin_store" 的 zhongxin_v4 客戶名）＋ customers 主檔名稱＋別名
-- 用法：在 SQL Editor 執行，把結果那一格整段複製給開發者（或直接貼進 index.html）。
-- 新版網站上線後，店家自動完成會即時讀 customers＋customer_aliases，這份靜態名單只當離線備援。
-- =====================================================================
create or replace function pg_temp.zx_j(v jsonb) returns jsonb language plpgsql immutable as $j$
begin
  if jsonb_typeof(v) = 'string' then return (v #>> '{}')::jsonb; end if;
  return v;
exception when others then return v;
end $j$;

create or replace function pg_temp.zx_names() returns text language plpgsql as $f$
declare
  names text[] := '{}';
  t text;
  part text[];
begin
  foreach t in array array['Chunghsin_store', 'chunghsin_store', 'zhongxin_store'] loop
    if to_regclass(format('public.%I', t)) is not null then
      execute format($q$ select coalesce(array_agg(k), '{}') from public.%I s,
                         jsonb_object_keys(pg_temp.zx_j(to_jsonb(s.value))) k
                         where s.key = 'zhongxin_v4' and jsonb_typeof(pg_temp.zx_j(to_jsonb(s.value))) = 'object' $q$, t)
        into part;
      names := names || part;
      exit;                                    -- 只取第一張存在的表（"Chunghsin_store" 優先）
    end if;
  end loop;
  if to_regclass('public.customers') is not null then
    execute 'select coalesce(array_agg(name), ''{}'') from public.customers where coalesce(name, '''') <> ''''' into part;
    names := names || part;
  end if;
  if to_regclass('public.customer_aliases') is not null then
    execute 'select coalesce(array_agg(alias_name), ''{}'') from public.customer_aliases' into part;
    names := names || part;
  end if;
  return 'const STATIC_CUSTOMER_NAMES = '
      || (select coalesce(jsonb_agg(n order by n), '[]')::text
          from (select distinct btrim(x) n from unnest(names) x where btrim(coalesce(x, '')) <> '') z)
      || ';  // ' || (select count(distinct btrim(x)) from unnest(names) x where btrim(coalesce(x, '')) <> '') || ' 筆，'
      || to_char(now() at time zone 'Asia/Taipei', 'YYYY-MM-DD HH24:MI') || ' 產生';
end $f$;

select pg_temp.zx_names() as static_customer_names;
