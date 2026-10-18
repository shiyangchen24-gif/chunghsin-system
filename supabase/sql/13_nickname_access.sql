-- =====================================================================
-- 13_nickname_access.sql ── 免帳號使用：輸入暱稱即可使用＋後台查看裝置 IP（可重複執行）
-- 執行順序：02～06、12 之後。
-- 前置：Dashboard → Authentication → Sign In / Providers → 開啟「Allow anonymous sign-ins」。
--
-- 運作方式：
--   1. 網頁以 Supabase「匿名登入」取得一個裝置專屬的 user id（存在該瀏覽器，不用帳密）。
--   2. 使用者輸入暱稱 → device_register() 建立成員（角色 staff：可讀寫、不能刪除）並記錄裝置與 IP。
--   3. 每次開啟網頁 device_touch() 更新最後上線時間與 IP（同一裝置換過的 IP 都會留下）。
--   4. 管理員仍以 Email＋密碼登入，在「裝置管理」頁查看 IP、改暱稱、停用裝置，或關閉暱稱登入。
-- IP 來源：PostgREST 的 request.headers（cf-connecting-ip → x-forwarded-for 第一段 → x-real-ip）。
-- =====================================================================
begin;

create table if not exists public.app_settings (
  key   text primary key,
  value jsonb not null
);
alter table public.app_settings enable row level security;
insert into public.app_settings (key, value) values ('nickname_access', 'true') on conflict (key) do nothing;
drop policy if exists app_settings_read on public.app_settings;
create policy app_settings_read on public.app_settings for select to authenticated using (true);
drop policy if exists app_settings_admin on public.app_settings;
create policy app_settings_admin on public.app_settings for all to authenticated
  using ((select private.is_admin())) with check ((select private.is_admin()));

create table if not exists public.app_devices (
  user_id    uuid primary key references auth.users(id) on delete cascade,
  nickname   text not null,
  first_ip   text,
  last_ip    text,
  user_agent text,
  first_seen timestamptz not null default now(),
  last_seen  timestamptz not null default now(),
  visits     int not null default 1
);
alter table public.app_devices enable row level security;

create table if not exists public.app_device_ips (
  user_id    uuid not null references auth.users(id) on delete cascade,
  ip         text not null,
  first_seen timestamptz not null default now(),
  last_seen  timestamptz not null default now(),
  visits     int not null default 1,
  primary key (user_id, ip)
);
alter table public.app_device_ips enable row level security;

-- 只有管理員可直接讀；一般裝置的寫入一律走下面的 security definer 函式
do $$
declare t text;
begin
  foreach t in array array['app_devices', 'app_device_ips'] loop
    execute format('drop policy if exists %I on public.%I', t || '_admin', t);
    execute format('create policy %I on public.%I for all to authenticated using ((select private.is_admin())) with check ((select private.is_admin()))', t || '_admin', t);
  end loop;
end $$;

create or replace function private.client_ip() returns text
language sql stable set search_path = '' as $$
  with h as (select coalesce(nullif(current_setting('request.headers', true), ''), '{}')::jsonb as j)
  select nullif(btrim(coalesce(nullif(j ->> 'cf-connecting-ip', ''),
                               nullif(split_part(j ->> 'x-forwarded-for', ',', 1), ''),
                               j ->> 'x-real-ip')), '')
  from h
$$;
create or replace function private.client_ua() returns text
language sql stable set search_path = '' as $$
  select left((coalesce(nullif(current_setting('request.headers', true), ''), '{}')::jsonb) ->> 'user-agent', 300)
$$;

create or replace function private.log_device_ip(p_uid uuid) returns void
language sql security definer set search_path = '' as $$
  insert into public.app_device_ips (user_id, ip)
  select p_uid, private.client_ip() where private.client_ip() is not null
  on conflict (user_id, ip) do update set last_seen = now(), visits = public.app_device_ips.visits + 1
$$;

-- 輸入暱稱開始使用（新裝置建立為 staff；已是成員者只更新暱稱，不改角色）
create or replace function public.device_register(p_nickname text, p_icon text default null)
returns jsonb language plpgsql security definer set search_path = '' as $$
declare
  v_uid  uuid := auth.uid();
  v_nick text := left(btrim(coalesce(p_nickname, '')), 12);
  m      public.app_members;
begin
  if v_uid is null then raise exception 'not signed in' using errcode = '42501'; end if;
  if v_nick = '' then raise exception 'nickname required' using errcode = '22023'; end if;
  select * into m from public.app_members where user_id = v_uid;
  if found and not m.is_active then
    return jsonb_build_object('ok', false, 'reason', 'blocked');
  end if;
  if not found then
    if not coalesce((select (value)::text::boolean from public.app_settings where key = 'nickname_access'), true) then
      return jsonb_build_object('ok', false, 'reason', 'disabled');
    end if;
    insert into auth.users (id) select v_uid where not exists (select 1 from auth.users where id = v_uid);  -- 真實 Supabase 已存在，此行不作用
    insert into public.app_members (user_id, role, display_name, icon) values (v_uid, 'staff', v_nick, p_icon)
    returning * into m;
  else
    update public.app_members set display_name = v_nick, icon = coalesce(p_icon, icon) where user_id = v_uid returning * into m;
  end if;
  insert into public.app_devices (user_id, nickname, first_ip, last_ip, user_agent)
  values (v_uid, v_nick, private.client_ip(), private.client_ip(), private.client_ua())
  on conflict (user_id) do update set nickname = excluded.nickname, last_ip = coalesce(excluded.last_ip, public.app_devices.last_ip),
                                      user_agent = excluded.user_agent, last_seen = now();
  perform private.log_device_ip(v_uid);
  return jsonb_build_object('ok', true, 'role', m.role, 'display_name', m.display_name, 'icon', m.icon);
end $$;

-- 每次開啟網頁呼叫一次：更新最後上線與 IP（Email 帳號也會記錄）
create or replace function public.device_touch()
returns void language plpgsql security definer set search_path = '' as $$
declare v_uid uuid := auth.uid(); v_name text;
begin
  select display_name into v_name from public.app_members where user_id = v_uid and is_active;
  if not found then return; end if;
  insert into public.app_devices (user_id, nickname, first_ip, last_ip, user_agent)
  values (v_uid, coalesce(v_name, '（未命名）'), private.client_ip(), private.client_ip(), private.client_ua())
  on conflict (user_id) do update set nickname = coalesce(v_name, public.app_devices.nickname),
                                      last_ip = coalesce(excluded.last_ip, public.app_devices.last_ip),
                                      user_agent = excluded.user_agent, last_seen = now(),
                                      visits = public.app_devices.visits + 1;
  perform private.log_device_ip(v_uid);
end $$;

-- 後台：裝置清單（含 IP 歷程）；security definer 才能讀 auth.users 判斷是否為 Email 帳號，函式內先檢查 admin
create or replace function public.admin_list_devices()
returns jsonb language plpgsql stable security definer set search_path = '' as $$
begin
  if not private.is_admin() then raise exception 'admin only' using errcode = '42501'; end if;
  return coalesce((
    select jsonb_agg(jsonb_build_object(
             'user_id', d.user_id, 'nickname', coalesce(m.display_name, d.nickname), 'role', m.role,
             'is_active', coalesce(m.is_active, false), 'is_account', u.email is not null and u.email <> '',
             'last_ip', d.last_ip, 'first_ip', d.first_ip, 'user_agent', d.user_agent,
             'first_seen', d.first_seen, 'last_seen', d.last_seen, 'visits', d.visits,
             'ips', coalesce((select jsonb_agg(jsonb_build_object('ip', i.ip, 'first_seen', i.first_seen, 'last_seen', i.last_seen, 'visits', i.visits)
                                               order by i.last_seen desc)
                              from public.app_device_ips i where i.user_id = d.user_id), '[]'))
           order by d.last_seen desc)
    from public.app_devices d
    left join public.app_members m on m.user_id = d.user_id
    left join auth.users u on u.id = d.user_id), '[]');
end $$;

-- 後台：停用／啟用、改暱稱（不能停用自己）
create or replace function public.admin_set_device(p_user_id uuid, p_active boolean default null, p_nickname text default null)
returns jsonb language plpgsql security definer set search_path = '' as $$
begin
  if not private.is_admin() then raise exception 'admin only' using errcode = '42501'; end if;
  if p_user_id = auth.uid() and p_active is false then return jsonb_build_object('ok', false, 'reason', 'self'); end if;
  update public.app_members
     set is_active = coalesce(p_active, is_active),
         display_name = coalesce(nullif(left(btrim(p_nickname), 12), ''), display_name)
   where user_id = p_user_id;
  if nullif(btrim(p_nickname), '') is not null then
    update public.app_devices set nickname = left(btrim(p_nickname), 12) where user_id = p_user_id;
  end if;
  return jsonb_build_object('ok', found);
end $$;

do $$
declare f text;
begin
  foreach f in array array['device_register(text, text)', 'device_touch()', 'admin_list_devices()', 'admin_set_device(uuid, boolean, text)'] loop
    execute format('revoke all on function public.%s from public, anon', f);
    execute format('grant execute on function public.%s to authenticated', f);
  end loop;
end $$;
revoke all on function private.log_device_ip(uuid) from public;

commit;
