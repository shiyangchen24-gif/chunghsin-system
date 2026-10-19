-- =====================================================================
-- 15_api_grants.sql ── 明確授權網頁（Data API）存取資料表（可重複執行）
-- 原因：Supabase 自 2026-05-30 起新專案、2026-10-30 起所有專案，public 的新資料表
--       不再自動開放給 Data API（supabase-js／REST），必須明確 GRANT，否則網頁會出現 42501 permission denied。
--       https://supabase.com/changelog/45329-breaking-change-tables-not-exposed-to-data-and-graphql-api-automatically
-- 安全：所有資料表都已啟用 RLS（下方會檢查，未啟用就中止），GRANT 只是「允許經過 API」，
--       能看到／改到哪些列仍由 RLS 決定（成員才可讀、staff 才可寫、刪除只限 admin）。
-- 不授權給 anon：未登入一律無法讀寫；暱稱使用走匿名登入，身分是 authenticated。
-- 執行順序：02～06、12～14 之後；之後新增資料表的 SQL 也要再跑一次本檔。
-- =====================================================================
begin;

do $$
declare
  t record;
  missing text;
begin
  -- 防呆：public 中任何資料表沒開 RLS 就不授權
  select string_agg(c.relname, ', ') into missing
  from pg_class c join pg_namespace n on n.oid = c.relnamespace
  where n.nspname = 'public' and c.relkind in ('r', 'p') and not c.relrowsecurity;
  if missing is not null then
    raise exception '以下資料表尚未啟用 RLS，已停止授權：%', missing;
  end if;

  for t in select c.relname, c.relkind from pg_class c join pg_namespace n on n.oid = c.relnamespace
           where n.nspname = 'public' and c.relkind in ('r', 'p', 'v') loop
    if t.relkind = 'v' then
      execute format('grant select on public.%I to authenticated', t.relname);
    else
      execute format('grant select, insert, update, delete on public.%I to authenticated', t.relname);
    end if;
    execute format('grant all on public.%I to service_role', t.relname);
  end loop;
end $$;

grant usage on schema public to authenticated, service_role;
grant usage, select on all sequences in schema public to authenticated, service_role;

commit;

-- 檢查：每個資料表／檢視都應該是 authenticated = true
select c.relname as "資料表",
       has_table_privilege('authenticated', c.oid, 'select') as authenticated,
       has_table_privilege('anon', c.oid, 'select') as anon
from pg_class c join pg_namespace n on n.oid = c.relnamespace
where n.nspname = 'public' and c.relkind in ('r', 'p', 'v')
order by 1;
