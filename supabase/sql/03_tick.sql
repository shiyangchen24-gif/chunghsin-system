-- =====================================================================
-- 03_tick.sql ── 打勾單：把 key-value 大 JSON 拆成「每客戶每營業日一列」
-- 依現行程式碼（nitaaa1119-ai/Chun-Shin-Ltd. index.html）確認的實際結構：
--   zhongxin_v4    { 客戶名: { status: 未叫貨|有叫貨|今日不叫貨, date: ''|'ordered', fixed: 負責人 } }
--   zhongxin_hist_v4 [{ date:'YYYY/MM/DD', records:{客戶名:status}, editLog:{客戶名:[{time,status,user,icon}]}, clearedAt?:ms }]
--   zhongxin_order_v1 { 群組名: [客戶名...] }        zhongxin_notices_v1 [{ id, author, text, time }]
--   zhongxin_manual_v1 { 'YYYY/MM/DD': { ord, un, no } }   zhongxin_warn3_v1 [客戶名...]
-- 舊表 "Chunghsin_store"／zhongxin_store 完全不動。
-- 狀態：草稿，尚未在真實專案執行。
-- =====================================================================
begin;

-- 舊 key-value 原文歸檔：任何不明欄位都原封保留，backfill 只讀這裡
create table if not exists public.legacy_kv_archive (
  source_table text not null,
  key          text not null,
  value        jsonb,
  value_bytes  int,
  archived_at  timestamptz not null default now(),
  primary key (source_table, key, archived_at)
);

-- 舊程式用 JSON.stringify 寫入：jsonb 欄位裡可能是「字串形式的 JSON」→ 統一解開
create or replace function private.legacy_json(v jsonb) returns jsonb
language plpgsql immutable set search_path = '' as $$
begin
  if jsonb_typeof(v) = 'string' then
    return (v #>> '{}')::jsonb;
  end if;
  return v;
exception when others then
  return v;
end $$;

-- 打勾單客戶設定：負責人（舊 fixed）屬於客戶，不屬於某一天
create table if not exists public.tick_customers (
  customer_code text primary key references public.customers(code) on update cascade on delete cascade,
  fixed         text,                     -- 負責人（舊 zhongxin_v4.*.fixed，亦為群組名）
  is_listed     boolean not null default true,
  legacy_name   text                      -- 舊系統的客戶名（顯示仍以 customers.name / 別名為準）
);
select private.attach_sync('public.tick_customers', 'tick', 'customer_code', array['customer_code', 'fixed', 'is_listed']);

-- 營業日：取代各裝置自己的 todayStr；「重置」= 結束目前營業日、開新的一天
-- 目前營業日 = status='open' 的那一天（伺服器決定，不依賴裝置時鐘）
create table if not exists public.tick_service_days (
  service_date date primary key,
  status       text not null default 'open' check (status in ('open', 'closed')),
  opened_at    timestamptz not null default now(),
  closed_at    timestamptz,
  closed_by    uuid,
  cleared_at   timestamptz                -- 對應舊 clearedAt（清除歷史操作）
);
create unique index if not exists tick_service_days_one_open on public.tick_service_days ((true)) where status = 'open';
select private.attach_sync('public.tick_service_days', 'tick', 'service_date', array['service_date', 'status']);

-- 每日叫貨狀態：一勾只改一列（約 200 bytes）；沒有列 = 未叫貨（新的一天不必批次寫 638 列）
create table if not exists public.daily_order_status (
  id            uuid primary key default gen_random_uuid(),
  service_date  date not null,
  customer_code text not null references public.customers(code) on update cascade,
  status        text not null default '未叫貨' check (status in ('未叫貨', '有叫貨', '今日不叫貨')),
  updated_by    uuid default auth.uid(),
  last_actor_name text,                   -- 卡片底部顯示「最後操作者」，不必為此下載整份事件紀錄
  last_actor_icon text,
  unique (service_date, customer_code)
);
create index if not exists daily_order_status_date_idx on public.daily_order_status (service_date);
select private.attach_sync('public.daily_order_status', 'tick', 'id',
                           array['service_date', 'customer_code', 'status', 'last_actor_name', 'last_actor_icon', 'updated_at']);

-- 狀態變更事件（= 舊 editLog）；commit_seq 為伺服器發號的遞增序號
create table if not exists public.order_status_events (
  id            uuid primary key default gen_random_uuid(),
  request_id    uuid unique,
  service_date  date not null,
  customer_code text not null references public.customers(code) on update cascade,
  old_status    text,
  new_status    text not null,
  via           text not null default 'click',   -- click / right_click / modal / import / backfill
  actor         uuid default auth.uid(),
  actor_name    text,                             -- 舊 editLog.user（暱稱）
  actor_icon    text,                             -- 舊 editLog.icon（例如 kitty.png）
  commit_seq    bigint generated always as identity,
  created_at    timestamptz not null default now()
);
create index if not exists order_status_events_date_idx on public.order_status_events (service_date desc, commit_seq desc);
create index if not exists order_status_events_customer_idx on public.order_status_events (customer_code, service_date desc);

-- 群組排序（舊 zhongxin_order_v1：{群組名: [客戶...]}）與「系列統計」（可自行新增系列、自訂店家）
create table if not exists public.order_groups (
  id         uuid primary key default gen_random_uuid(),
  kind       text not null default 'group' check (kind in ('group', 'series')),
  name       text not null,
  sort_order int not null default 0,
  rule       jsonb,                      -- 系列：名稱前綴規則，例如 {"prefix":["壽司"],"exclude_prefix":["壽司郎"]}
  legacy     jsonb,
  unique (kind, name)
);
select private.attach_sync('public.order_groups', 'tick', 'id', array['kind', 'name', 'sort_order']);

create table if not exists public.order_group_members (
  id            uuid primary key default gen_random_uuid(),
  group_id      uuid not null references public.order_groups(id) on delete cascade,
  customer_code text not null references public.customers(code) on update cascade,
  sort_order    int not null default 0,
  unique (group_id, customer_code)
);
select private.attach_sync('public.order_group_members', 'tick', 'id',
                           array['group_id', 'customer_code', 'sort_order']);

-- 留言板（舊 {id, author, text, time}）
create table if not exists public.order_notices (
  id          uuid primary key default gen_random_uuid(),
  body        text not null,
  author      uuid default auth.uid(),
  author_name text,
  created_at  timestamptz not null default now(),
  legacy_ref  text unique,               -- backfill 防重：'notices_v1#<舊 id>'
  legacy      jsonb
);
create index if not exists order_notices_created_idx on public.order_notices (created_at desc, id);
select private.attach_sync('public.order_notices', 'tick', 'id');

-- 手動趨勢數據（舊 {'YYYY/MM/DD': {ord, un, no}}）
create table if not exists public.order_manual_trend (
  period  text primary key,              -- 保留舊 key 原文 'YYYY/MM/DD'
  payload jsonb not null default '{}'::jsonb
);
select private.attach_sync('public.order_manual_trend', 'tick', 'period');

-- 舊歷史快照原樣歸檔（舊系統只保留 6 天）；新系統的歷史直接查 daily_order_status
create table if not exists public.order_history_days (
  id           uuid primary key default gen_random_uuid(),
  service_date date not null,
  legacy_index int not null default 0,
  records      jsonb not null default '{}'::jsonb,
  edit_log     jsonb not null default '{}'::jsonb,
  cleared_at   text,
  extra        jsonb,
  archived_at  timestamptz not null default now(),
  unique (service_date, legacy_index)
);
create index if not exists order_history_days_date_idx on public.order_history_days (service_date desc, legacy_index desc);

-- 三天未叫的手動標示（舊 toggleManualWarn3）；mode add=手動加入、remove=手動排除
create table if not exists public.tick_warn3_overrides (
  customer_code text primary key references public.customers(code) on update cascade on delete cascade,
  mode          text not null check (mode in ('add', 'remove')),
  set_on        date not null,            -- 設定時的營業日；該客戶之後有叫貨即失效
  created_by    uuid default auth.uid()
);
select private.attach_sync('public.tick_warn3_overrides', 'tick', 'customer_code', array['customer_code', 'mode']);

-- 三天未叫 = 連續 3 個「已結束的營業日」都未叫貨（沒有列或狀態為未叫貨；今日不叫貨不算未叫）
--          ＋ 手動加入 － 手動排除；目前營業日已叫貨／今日不叫貨者不顯示（與舊版 resetAll 規則一致）
create or replace view public.v_tick_warn3 with (security_invoker = true) as
with last3 as (
  select service_date from public.tick_service_days where status = 'closed'
  order by service_date desc limit 3
), cur as (
  select service_date from public.tick_service_days where status = 'open'
), auto as (
  select t.customer_code
  from public.tick_customers t
  where t.is_listed
    and (select count(*) from last3) = 3
    and not exists (select 1 from public.daily_order_status s join last3 using (service_date)
                    where s.customer_code = t.customer_code and s.status <> '未叫貨')
)
select x.customer_code, x.source
from (
  select customer_code, 'auto'::text as source from auto
  where customer_code not in (select customer_code from public.tick_warn3_overrides where mode = 'remove')
  union
  select o.customer_code, 'manual' from public.tick_warn3_overrides o
  where o.mode = 'add'
    and not exists (select 1 from public.daily_order_status s
                    where s.customer_code = o.customer_code and s.service_date >= o.set_on and s.status <> '未叫貨'
                      and s.service_date < (select service_date from cur))
) x
where not exists (select 1 from public.daily_order_status s join cur using (service_date)
                  where s.customer_code = x.customer_code and s.status <> '未叫貨');

-- ---------------------------------------------------------------------
-- 寫入 RPC：changeStatus（伺服器端前置條件＋CAS＋request_id 去重）
--  p_via = 'click'      ：只允許 未叫貨→有叫貨（舊 toggle）
--  p_via = 'right_click'：只允許 未叫貨⇄今日不叫貨（舊 rightClick）
--  p_via = 'modal'      ：編輯視窗，可任意改（含改回未叫貨）
--  p_service_date 必須是目前營業日（防止停在舊畫面的裝置寫到昨天）
--  p_expected_revision：畫面上看到的版本；null 表示畫面上「尚無此列」
-- ---------------------------------------------------------------------
create or replace function public.tick_set_status(
  p_service_date date, p_customer_code text, p_new_status text,
  p_expected_revision bigint default null, p_request_id uuid default null,
  p_via text default 'click', p_actor_name text default null, p_actor_icon text default null)
returns jsonb language plpgsql security invoker set search_path = '' as $$
declare
  v_prev jsonb := private.replayed(p_request_id);
  r      public.daily_order_status;
  v_old  text;
  v_res  jsonb;
begin
  if v_prev is not null then return v_prev || '{"replayed":true}'; end if;
  if not private.can_write() then raise exception 'no write permission' using errcode = '42501'; end if;
  if not exists (select 1 from public.tick_service_days where service_date = p_service_date and status = 'open') then
    return jsonb_build_object('ok', false, 'reason', 'day_closed', 'message', '這一天已經重置，請重新整理畫面');
  end if;

  select * into r from public.daily_order_status
  where service_date = p_service_date and customer_code = p_customer_code for update;

  if (r.id is null and p_expected_revision is not null)
     or (r.id is not null and r.revision is distinct from p_expected_revision) then
    return jsonb_build_object('ok', false, 'reason', 'conflict',
      'current', case when r.id is null then null else jsonb_build_object(
        'id', r.id, 'status', r.status, 'revision', r.revision) end);
  end if;

  v_old := coalesce(r.status, '未叫貨');
  if (p_via = 'click' and not (v_old = '未叫貨' and p_new_status = '有叫貨'))
     or (p_via = 'right_click' and not ((v_old = '未叫貨' and p_new_status = '今日不叫貨')
                                     or (v_old = '今日不叫貨' and p_new_status = '未叫貨')))
     or p_via not in ('click', 'right_click', 'modal') then
    return jsonb_build_object('ok', false, 'reason', 'rule',
      'message', '已叫貨的客戶不能直接點回，請使用編輯視窗');
  end if;

  if r.id is null then
    insert into public.daily_order_status (service_date, customer_code, status, last_actor_name, last_actor_icon)
    values (p_service_date, p_customer_code, p_new_status, p_actor_name, p_actor_icon)
    returning * into r;
  else
    update public.daily_order_status
       set status = p_new_status, updated_by = auth.uid(), last_actor_name = p_actor_name, last_actor_icon = p_actor_icon
     where id = r.id returning * into r;
  end if;
  insert into public.order_status_events (request_id, service_date, customer_code, old_status, new_status, via, actor_name, actor_icon)
  values (p_request_id, p_service_date, p_customer_code, v_old, p_new_status, p_via, p_actor_name, p_actor_icon);

  v_res := jsonb_build_object('ok', true, 'id', r.id, 'status', r.status, 'revision', r.revision,
                              'last_actor_name', r.last_actor_name, 'last_actor_icon', r.last_actor_icon,
                              'updated_at', r.updated_at);
  return private.remember(p_request_id, 'tick_set_status', v_res);
end $$;

-- 重置（舊 resetAll）：結束目前營業日並開新的一天。
-- 舊版要把 638 位客戶全部寫回「未叫貨」並覆寫整份歷史；新版只寫 2 列，前一天的狀態列自動成為歷史。
-- p_expected_open：畫面上的目前營業日（兩台同時按重置時，只有一台成功）
create or replace function public.tick_reset_day(p_expected_open date, p_new_date date default null,
                                                 p_request_id uuid default null)
returns jsonb language plpgsql security invoker set search_path = '' as $$
declare
  v_prev jsonb := private.replayed(p_request_id);
  v_cur  date;
  v_new  date;
  v_res  jsonb;
begin
  if v_prev is not null then return v_prev || '{"replayed":true}'; end if;
  if not private.can_write() then raise exception 'no write permission' using errcode = '42501'; end if;
  select service_date into v_cur from public.tick_service_days where status = 'open' for update;
  if v_cur is distinct from p_expected_open then
    return jsonb_build_object('ok', false, 'reason', 'conflict', 'current_open', v_cur);
  end if;
  v_new := coalesce(p_new_date, greatest((now() at time zone 'Asia/Taipei')::date, coalesce(v_cur, '-infinity'::date) + 1));
  if v_cur is not null then
    if v_new <= v_cur then raise exception '新的營業日必須晚於 %', v_cur using errcode = '22023'; end if;
    update public.tick_service_days set status = 'closed', closed_at = now(), closed_by = auth.uid()
     where service_date = v_cur;
    -- 已叫貨／今日不叫貨的客戶，手動「加入三天未叫」標示失效（舊版 resetAll 規則）
    delete from public.tick_warn3_overrides o
     using public.daily_order_status s
     where o.mode = 'add' and s.customer_code = o.customer_code and s.service_date = v_cur and s.status <> '未叫貨';
  end if;
  insert into public.tick_service_days (service_date) values (v_new);
  v_res := jsonb_build_object('ok', true, 'closed', v_cur, 'open', v_new);
  return private.remember(p_request_id, 'tick_reset_day', v_res);
end $$;

revoke all on function public.tick_set_status(date, text, text, bigint, uuid, text, text, text) from public, anon;
revoke all on function public.tick_reset_day(date, date, uuid) from public, anon;
grant execute on function public.tick_set_status(date, text, text, bigint, uuid, text, text, text) to authenticated;
grant execute on function public.tick_reset_day(date, date, uuid) to authenticated;

-- ---------------------------------------------------------------------
-- 客戶維護（原 saveClient／deleteClient／confirmDeleteHistory）
-- 新增：p_code 為 null → 配發暫編代號 TK0001…（日後可改正式代號，FK 皆 on update cascade）
-- 改名：只改打勾單的顯示名（tick_customers.legacy_name），不動三站共用的 customers.name
-- ---------------------------------------------------------------------
create or replace function public.tick_save_customer(p_code text, p_name text, p_fixed text, p_request_id uuid default null)
returns jsonb language plpgsql security invoker set search_path = '' as $$
declare
  v_prev jsonb := private.replayed(p_request_id);
  v_code text := nullif(btrim(coalesce(p_code, '')), '');
  v_name text := btrim(coalesce(p_name, ''));
  v_next int;
begin
  if v_prev is not null then return v_prev; end if;
  if not private.can_write() then raise exception 'no write permission' using errcode = '42501'; end if;
  if v_name = '' then raise exception '請輸入客戶名稱' using errcode = '22023'; end if;
  if exists (select 1 from public.tick_customers t join public.customers c on c.code = t.customer_code
             where t.is_listed and coalesce(t.legacy_name, c.name) = v_name
               and t.customer_code is distinct from v_code) then
    return jsonb_build_object('ok', false, 'reason', 'duplicate', 'message', '該名稱已存在');
  end if;
  if v_code is null then
    -- 名稱已存在於共用主檔（例如報價系統已建立）→ 直接沿用；否則配發 TK 暫編代號
    select code into v_code from public.customers where name = v_name order by code limit 1;
    if v_code is null then
      perform pg_advisory_xact_lock(hashtext('zx_tk_code'));
      select coalesce(max(substring(code from '^TK(\d+)$')::int), 0) + 1 into v_next from public.customers where code ~ '^TK\d+$';
      v_code := 'TK' || lpad(v_next::text, 4, '0');
      insert into public.customers (code, name, quotation_settings) values (v_code, v_name, '{"provisional": true}');
    end if;
  end if;
  insert into public.tick_customers (customer_code, fixed, legacy_name, is_listed)
  values (v_code, nullif(btrim(coalesce(p_fixed, '')), ''), v_name, true)
  on conflict (customer_code) do update
    set fixed = excluded.fixed, legacy_name = excluded.legacy_name, is_listed = true;
  return private.remember(p_request_id, 'tick_save_customer', jsonb_build_object('ok', true, 'code', v_code));
end $$;

-- 從打勾單移除客戶：設為不顯示，歷史資料保留（原版會連同歷史一起刪掉，新版改為可還原）
create or replace function public.tick_hide_customer(p_code text)
returns jsonb language plpgsql security invoker set search_path = '' as $$
begin
  if not private.can_delete() then raise exception '只有管理員可以刪除客戶' using errcode = '42501'; end if;
  update public.tick_customers set is_listed = false where customer_code = p_code;
  return jsonb_build_object('ok', true);
end $$;

-- 群組內拖曳排序（原 saveOrder）：整組一次寫入，只推播一則
create or replace function public.tick_save_group_order(p_group text, p_codes text[])
returns jsonb language plpgsql security definer set search_path = '' as $$
declare v_gid uuid;
begin
  if not private.can_write() then raise exception 'no write permission' using errcode = '42501'; end if;
  perform set_config('zx.bulk', 'on', true);
  insert into public.order_groups (kind, name) values ('group', p_group)
  on conflict (kind, name) do update set name = excluded.name returning id into v_gid;
  delete from public.order_group_members where group_id = v_gid;
  insert into public.order_group_members (group_id, customer_code, sort_order)
  select v_gid, c, n::int from unnest(p_codes) with ordinality u(c, n)
  where exists (select 1 from public.customers where code = c);
  perform set_config('zx.bulk', 'off', true);
  perform private.emit_bulk('tick', 'order_group_members');
  return jsonb_build_object('ok', true);
end $$;

-- 刪除某一天的叫貨記錄（原 deleteAnalyticsDay）／清除全部歷史（原 clearAllHistory）：管理員
create or replace function public.tick_delete_day(p_date date)
returns jsonb language plpgsql security definer set search_path = '' as $$
begin
  if not private.can_delete() then raise exception '只有管理員可以刪除歷史' using errcode = '42501'; end if;
  if exists (select 1 from public.tick_service_days where service_date = p_date and status = 'open') then
    raise exception '不能刪除目前營業日' using errcode = '22023';
  end if;
  perform set_config('zx.bulk', 'on', true);
  delete from public.daily_order_status where service_date = p_date;
  delete from public.order_status_events where service_date = p_date;
  delete from public.tick_service_days where service_date = p_date;
  delete from public.order_manual_trend where period = to_char(p_date, 'YYYY/MM/DD');
  perform set_config('zx.bulk', 'off', true);
  perform private.emit_bulk('tick', 'daily_order_status', 'D');
  return jsonb_build_object('ok', true);
end $$;

create or replace function public.tick_clear_history()
returns jsonb language plpgsql security definer set search_path = '' as $$
declare v_open date := (select service_date from public.tick_service_days where status = 'open');
begin
  if not private.can_delete() then raise exception '只有管理員可以清除歷史' using errcode = '42501'; end if;
  perform set_config('zx.bulk', 'on', true);
  delete from public.daily_order_status where service_date is distinct from v_open;
  delete from public.order_status_events;
  delete from public.tick_service_days where status = 'closed';
  update public.tick_service_days set cleared_at = now() where status = 'open';
  perform set_config('zx.bulk', 'off', true);
  perform private.emit_bulk('tick', 'daily_order_status', 'D');
  return jsonb_build_object('ok', true);
end $$;

-- 趨勢分析：每日已叫／不叫筆數（一個月約 31 列，約 2 KB；不必下載歷史明細）
create or replace function public.tick_daily_counts(p_from date, p_to date)
returns table (service_date date, ord int, no int, total int, status text)
language sql stable security invoker set search_path = '' as $$
  select d.service_date,
         (select count(*) from public.daily_order_status s where s.service_date = d.service_date and s.status = '有叫貨')::int,
         (select count(*) from public.daily_order_status s where s.service_date = d.service_date and s.status = '今日不叫貨')::int,
         (select count(*) from public.tick_customers t where t.is_listed)::int,
         d.status
  from public.tick_service_days d
  where d.service_date between p_from and p_to
  order by d.service_date
$$;

-- 連續未叫天數（後台管理表「連續未叫」欄）：往回最多看 60 個已結束營業日
create or replace view public.v_tick_streak with (security_invoker = true) as
with days as (
  select service_date, row_number() over (order by service_date desc) as rn
  from public.tick_service_days where status = 'closed'
  order by service_date desc limit 60
), hit as (
  select s.customer_code, min(d.rn) as first_hit
  from public.daily_order_status s join days d using (service_date)
  where s.status <> '未叫貨'
  group by s.customer_code
)
select t.customer_code, coalesce(h.first_hit - 1, (select count(*) from days))::int as streak
from public.tick_customers t left join hit h using (customer_code)
where t.is_listed;

do $$
declare f text;
begin
  foreach f in array array['tick_save_customer(text, text, text, uuid)', 'tick_hide_customer(text)',
    'tick_save_group_order(text, text[])', 'tick_delete_day(date)', 'tick_clear_history()',
    'tick_daily_counts(date, date)'] loop
    execute format('revoke all on function public.%s from public, anon', f);
    execute format('grant execute on function public.%s to authenticated', f);
  end loop;
end $$;

-- RLS：成員讀、staff 寫、刪除走 private.can_delete()
do $$
declare t text;
begin
  foreach t in array array['tick_customers', 'tick_service_days', 'daily_order_status', 'order_status_events',
                           'order_groups', 'order_group_members', 'order_notices', 'order_manual_trend',
                           'order_history_days', 'tick_warn3_overrides', 'legacy_kv_archive'] loop
    execute format('alter table public.%I enable row level security', t);
    execute format('drop policy if exists zx_select on public.%I', t);
    execute format('create policy zx_select on public.%I for select to authenticated using ((select private.is_member()))', t);
    execute format('drop policy if exists zx_insert on public.%I', t);
    execute format('drop policy if exists zx_update on public.%I', t);
    if t not in ('order_status_events', 'legacy_kv_archive', 'order_history_days') then
      execute format('create policy zx_insert on public.%I for insert to authenticated with check ((select private.can_write()))', t);
      execute format('create policy zx_update on public.%I for update to authenticated using ((select private.can_write())) with check ((select private.can_write()))', t);
    end if;
    execute format('drop policy if exists zx_delete on public.%I', t);
    execute format('create policy zx_delete on public.%I for delete to authenticated using ((select private.can_delete()))', t);
  end loop;
end $$;
-- 事件表只能新增（經 tick_set_status），不能改、不能刪除以外的操作
drop policy if exists zx_insert on public.order_status_events;
create policy zx_insert on public.order_status_events for insert to authenticated
  with check ((select private.can_write()) and actor = (select auth.uid()));
-- 手動三天未叫：staff 可移除自己設定的標示（屬一般操作，不算「刪除資料」）
drop policy if exists zx_delete on public.tick_warn3_overrides;
create policy zx_delete on public.tick_warn3_overrides for delete to authenticated using ((select private.can_write()));

commit;
