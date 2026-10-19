-- 僅供本機測試：模擬 Supabase 的 roles / auth / realtime 介面（不是真實 Supabase）
do $$ begin
  if not exists (select 1 from pg_roles where rolname='anon') then create role anon nologin; end if;
  if not exists (select 1 from pg_roles where rolname='authenticated') then create role authenticated nologin; end if;
  if not exists (select 1 from pg_roles where rolname='service_role') then create role service_role nologin bypassrls; end if;
end $$;
grant usage on schema public to anon, authenticated, service_role;
-- 比照 Supabase 2026-05-30 起的新專案：public 新資料表「不會」自動授權給 Data API 角色，一律由 15_api_grants.sql 明確授權
alter default privileges in schema public grant all on functions to anon, authenticated, service_role;
create schema if not exists auth;
create table if not exists auth.users(id uuid primary key, email text);
create or replace function auth.uid() returns uuid language sql stable as
$$ select nullif(current_setting('request.jwt.claim.sub', true), '')::uuid $$;
grant usage on schema auth to anon, authenticated;
grant execute on function auth.uid() to anon, authenticated;
create schema if not exists realtime;
create table if not exists realtime.messages(id bigserial primary key, topic text, extension text, event text,
  payload jsonb, private boolean, inserted_at timestamptz default now());
alter table realtime.messages enable row level security;
create or replace function realtime.topic() returns text language sql stable as
$$ select current_setting('realtime.topic', true) $$;
create or replace function realtime.send(payload jsonb, event text, topic text, private boolean default true)
returns void language sql security definer as
$$ insert into realtime.messages(topic, extension, event, payload, private) values (topic, 'broadcast', event, payload, private) $$;
grant usage on schema realtime to authenticated;
grant select on realtime.messages to authenticated;
grant execute on function realtime.topic() to authenticated;
do $$ begin if not exists (select 1 from pg_publication where pubname='supabase_realtime') then create publication supabase_realtime; end if; end $$;
