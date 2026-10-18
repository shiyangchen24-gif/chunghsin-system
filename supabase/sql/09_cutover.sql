-- =====================================================================
-- 09_cutover.sql ── 收回匿名（anon）權限、移除 Postgres Changes 發布
-- 新專案與三個舊專案是分開的：在新專案執行這支「不會」影響舊網站，只是加強新專案的安全，
-- 執行後所有資料都必須登入（authenticated）才能存取。舊網站要等你停用舊專案才會停止。
-- 不 DROP 任何表；被移除的 policy 與 publication 會先存到 zx_backup，可用 99_rollback 還原。
-- 執行方式：把下一行開頭的「-- 」刪掉後整份執行（安全鎖，避免誤按）
-- set zx.confirm = 'cutover';
-- =====================================================================
do $$ begin
  if current_setting('zx.confirm', true) is distinct from 'cutover' then
    raise exception '安全鎖：請先取消註解 set zx.confirm = ''cutover''; 再執行';
  end if;
end $$;

begin;
create schema if not exists zx_backup;
create table if not exists zx_backup.cutover_log (
  id         bigint generated always as identity primary key,
  kind       text not null,          -- policy / publication / grant
  object     text not null,
  restore_sql text not null,
  done_at    timestamptz not null default now()
);

-- 1. 記錄並移除所有授權給 anon / public 的 policy（public schema）
insert into zx_backup.cutover_log (kind, object, restore_sql)
select 'policy', schemaname || '.' || tablename || '.' || policyname,
       format('create policy %I on %I.%I as %s for %s to %s%s%s',
              policyname, schemaname, tablename, permissive, cmd,
              (select string_agg(case r when 'public' then 'public' else quote_ident(r) end, ', ') from unnest(roles) r),
              case when qual is not null then ' using (' || qual || ')' else '' end,
              case when with_check is not null then ' with check (' || with_check || ')' else '' end)
from pg_policies
where schemaname = 'public' and (roles && array['anon', 'public']::name[]);

do $$
declare r record;
begin
  for r in select schemaname, tablename, policyname from pg_policies
           where schemaname = 'public' and (roles && array['anon', 'public']::name[]) loop
    execute format('drop policy %I on %I.%I', r.policyname, r.schemaname, r.tablename);
  end loop;
end $$;

-- 2. anon 不再有任何表／函式權限（新站一律登入後以 authenticated 存取）
insert into zx_backup.cutover_log (kind, object, restore_sql)
select distinct 'grant', table_name,
       format('grant %s on public.%I to anon', string_agg(privilege_type, ', '), table_name)
from information_schema.role_table_grants
where table_schema = 'public' and grantee = 'anon'
group by table_name;
revoke all on all tables in schema public from anon;
revoke all on all sequences in schema public from anon;
revoke execute on all functions in schema public from anon;
alter default privileges in schema public revoke all on tables from anon;
alter default privileges in schema public revoke all on functions from anon;

-- 3. 停用 Postgres Changes 全列推播（新站改用 Broadcast 小事件）
insert into zx_backup.cutover_log (kind, object, restore_sql)
select 'publication', schemaname || '.' || tablename,
       format('alter publication %I add table %I.%I', pubname, schemaname, tablename)
from pg_publication_tables
where pubname = 'supabase_realtime' and schemaname = 'public';

do $$
declare r record;
begin
  for r in select schemaname, tablename from pg_publication_tables
           where pubname = 'supabase_realtime' and schemaname = 'public' loop
    execute format('alter publication supabase_realtime drop table %I.%I', r.schemaname, r.tablename);
  end loop;
end $$;

commit;

select kind, object from zx_backup.cutover_log order by id;
