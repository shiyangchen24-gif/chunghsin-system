-- =====================================================================
-- 02_core_shared.sql ── 三站共用：成員角色、變更日誌(change_log)、同步 RPC、
--                       Broadcast 通知、共用客戶／車輛主檔、RLS
-- 性質：additive、可重複執行；不 DROP TABLE、不改名、不刪舊欄位。
-- 狀態：草稿，尚未在真實專案執行。須先看 00_inventory 結果再確認。
-- =====================================================================
begin;

create schema if not exists private;          -- 不對 API 公開的 helper
revoke all on schema private from public;
grant usage on schema private to authenticated;

-- ---------------------------------------------------------------------
-- 1. 內部成員與角色（Supabase Auth 帳號 → 角色）
--    admin：可刪除、刪除全部、管理成員；staff：一般讀寫；viewer：唯讀
-- ---------------------------------------------------------------------
create table if not exists public.app_members (
  user_id      uuid primary key references auth.users(id) on delete cascade,
  role         text not null default 'staff' check (role in ('admin', 'staff', 'viewer')),
  display_name text,
  icon         text,                       -- 打勾單的使用者圖示（例如 kitty.png）
  is_active    boolean not null default true,
  created_at   timestamptz not null default now()
);
alter table public.app_members enable row level security;

create or replace function private.member_role() returns text
language sql stable security definer set search_path = '' as $$
  select m.role from public.app_members m where m.user_id = auth.uid() and m.is_active
$$;
create or replace function private.is_member() returns boolean
language sql stable set search_path = '' as $$ select private.member_role() is not null $$;
create or replace function private.can_write() returns boolean
language sql stable set search_path = '' as $$ select coalesce(private.member_role() in ('admin', 'staff'), false) $$;
create or replace function private.is_admin() returns boolean
language sql stable set search_path = '' as $$ select coalesce(private.member_role() = 'admin', false) $$;
-- 「單筆刪除」權限集中在這裡：預設只限 admin（待確認：是否開放 staff 刪單筆，只改這一行）
create or replace function private.can_delete() returns boolean
language sql stable set search_path = '' as $$ select private.is_admin() $$;

drop policy if exists app_members_select on public.app_members;
create policy app_members_select on public.app_members for select to authenticated
  using (user_id = (select auth.uid()) or (select private.is_admin()));
drop policy if exists app_members_admin_write on public.app_members;
create policy app_members_admin_write on public.app_members for all to authenticated
  using ((select private.is_admin())) with check ((select private.is_admin()));

-- 使用者自己設定暱稱與圖示（原打勾單「設定暱稱」）；不能改自己的角色
create or replace function public.set_my_profile(p_display_name text, p_icon text)
returns jsonb language plpgsql security definer set search_path = '' as $$
begin
  update public.app_members
     set display_name = left(btrim(coalesce(p_display_name, '')), 12), icon = p_icon
   where user_id = auth.uid() and is_active;
  if not found then raise exception 'not a member' using errcode = '42501'; end if;
  return (select jsonb_build_object('display_name', display_name, 'icon', icon, 'role', role)
          from public.app_members where user_id = auth.uid());
end $$;
revoke all on function public.set_my_profile(text, text) from public, anon;
grant execute on function public.set_my_profile(text, text) to authenticated;

-- ---------------------------------------------------------------------
-- 2. 變更日誌：每筆業務異動寫一列「小摘要」，作為補同步的權威來源
--    txid = 寫入交易的 64-bit 交易 ID（xid8，不會繞回）。
--    補同步用「快照 xmin 水位」而不是 seq / updated_at：
--      xmin 之前的交易必定已結束（提交或回滾），所以
--      [上次水位, 本次水位) 區間內的變更是「完整且不再變動」的集合，
--      不會因交易提交順序 ≠ seq 順序而漏件。代價：長交易會讓水位暫停前進（延遲，不漏件）。
-- ---------------------------------------------------------------------
create table if not exists public.change_log (
  seq        bigint generated always as identity primary key,
  txid       xid8 not null default pg_current_xact_id(),
  site       text not null check (site in ('tick', 'report', 'quote', 'shared')),
  tbl        text not null,
  row_key    text not null,
  op         char(1) not null check (op in ('I', 'U', 'D')),   -- D = tombstone
  revision   bigint,
  summary    jsonb,                                           -- 只放白名單小欄位
  actor      uuid default auth.uid(),
  changed_at timestamptz not null default now()
);
create index if not exists change_log_txid_idx on public.change_log (txid, seq);
create index if not exists change_log_changed_at_idx on public.change_log (changed_at);
alter table public.change_log enable row level security;
drop policy if exists change_log_select on public.change_log;
create policy change_log_select on public.change_log for select to authenticated
  using ((select private.is_member()));
-- 不開放任何 insert/update/delete policy：只能由 security definer 觸發器寫入

create table if not exists public.sync_state (
  id             int primary key default 1 check (id = 1),
  pruned_through xid8 not null default '0'::xid8   -- 早於此水位的 change_log 已清除
);
insert into public.sync_state (id) values (1) on conflict do nothing;
alter table public.sync_state enable row level security;

-- 寫入去重：斷線重送同一個 request_id 時直接回傳第一次的結果
create table if not exists public.write_requests (
  request_id uuid primary key,
  fn         text not null,
  actor      uuid default auth.uid(),
  result     jsonb,
  created_at timestamptz not null default now()
);
create index if not exists write_requests_created_idx on public.write_requests (created_at);
alter table public.write_requests enable row level security;

-- ---------------------------------------------------------------------
-- 3. 補同步 RPC（同時也是 Realtime 失聯時每 30 秒的「輕量水位檢查」）
--    無變更時回應約 60 bytes：{"cursor":"123456","changes":[]}
--    p_cursor = null：只取得目前水位（首載順序：先拿水位 → 再載資料 → 再訂閱）
--    回傳 reset=true：游標過舊或累積過多，前端重新載入「目前畫面」所需資料即可
-- ---------------------------------------------------------------------
create or replace function public.sync_changes(p_cursor text default null,
                                               p_sites  text[] default null,
                                               p_limit  int default 500)
returns jsonb language plpgsql stable security definer set search_path = '' as $$
declare
  v_hi   xid8 := pg_snapshot_xmin(pg_current_snapshot());
  v_lo   xid8;
  v_rows jsonb;
  v_cnt  int;
begin
  if not private.is_member() then
    raise exception 'not a member' using errcode = '42501';
  end if;
  if p_cursor is null then
    return jsonb_build_object('cursor', v_hi::text, 'changes', '[]'::jsonb);
  end if;
  v_lo := p_cursor::xid8;
  if v_lo < (select pruned_through from public.sync_state where id = 1) then
    return jsonb_build_object('cursor', v_hi::text, 'reset', true, 'changes', '[]'::jsonb);
  end if;
  if v_lo >= v_hi then
    return jsonb_build_object('cursor', v_lo::text, 'changes', '[]'::jsonb);
  end if;

  select count(*), coalesce(jsonb_agg(jsonb_build_object(
           's', c.seq, 'site', c.site, 't', c.tbl, 'k', c.row_key, 'op', c.op,
           'rev', c.revision, 'v', c.summary) order by c.seq), '[]')
    into v_cnt, v_rows
  from (select * from public.change_log
        where txid >= v_lo and txid < v_hi
          and (p_sites is null or site = any (p_sites))
        order by seq
        limit greatest(1, least(p_limit, 2000)) + 1) c;

  if v_cnt > least(p_limit, 2000) then
    return jsonb_build_object('cursor', v_hi::text, 'reset', true, 'changes', '[]'::jsonb);
  end if;
  return jsonb_build_object('cursor', v_hi::text, 'changes', v_rows);
end $$;
revoke all on function public.sync_changes(text, text[], int) from public, anon;
grant execute on function public.sync_changes(text, text[], int) to authenticated;

-- 清理舊日誌（建議每日一次；有 pg_cron 可排程，否則由管理員手動）
create or replace function public.prune_change_log(p_keep interval default interval '14 days')
returns int language plpgsql security definer set search_path = '' as $$
declare v_max xid8; v_n int;
begin
  if not private.is_admin() and current_user not in ('postgres', 'service_role') then
    raise exception 'admin only' using errcode = '42501';
  end if;
  select max(txid) into v_max from public.change_log where changed_at < now() - p_keep;
  if v_max is null then return 0; end if;
  delete from public.change_log where txid <= v_max;
  get diagnostics v_n = row_count;
  update public.sync_state set pruned_through = greatest(pruned_through, v_max) where id = 1;
  delete from public.write_requests where created_at < now() - p_keep;
  return v_n;
end $$;
revoke all on function public.prune_change_log(interval) from public, anon;
grant execute on function public.prune_change_log(interval) to authenticated;

-- ---------------------------------------------------------------------
-- 4. 通用觸發器
--   private.bump_revision()：UPDATE 時 revision+1、updated_at=now()
--   private.log_change(site, key_col, summary_col...)：寫 change_log + Broadcast 小事件
--     Broadcast topic = 'zx:<site>'，private channel，payload < 1 KB，不含大 JSONB
--     realtime.send 失敗不擋業務寫入（補同步 RPC 會補上）
-- ---------------------------------------------------------------------
create or replace function private.bump_revision() returns trigger
language plpgsql set search_path = '' as $$
begin
  if to_jsonb(new) is distinct from to_jsonb(old) then
    new.revision   := coalesce(old.revision, 0) + 1;
    new.updated_at := now();
  end if;
  return new;
end $$;

create or replace function private.log_change() returns trigger
language plpgsql security definer set search_path = '' as $$
declare
  v_row  jsonb := to_jsonb(case when tg_op = 'DELETE' then old else new end);
  v_site text  := tg_argv[0];
  v_key  text  := v_row ->> tg_argv[1];
  v_op   char(1) := left(tg_op, 1);
  v_rev  bigint := (v_row ->> 'revision')::bigint;
  v_sum  jsonb;
  v_seq  bigint;
begin
  if tg_op = 'UPDATE' and to_jsonb(new) = to_jsonb(old) then
    return null;
  end if;
  -- 批次作業（刪除全部、backfill）先 set_config('zx.bulk','on',true)，最後自行記一筆 '*'
  if current_setting('zx.bulk', true) = 'on' then
    return null;
  end if;
  if tg_op <> 'DELETE' and tg_nargs > 2 then
    select jsonb_object_agg(k, v_row -> k) into v_sum
    from unnest(tg_argv[2:tg_nargs - 1]) k;
  end if;
  insert into public.change_log (site, tbl, row_key, op, revision, summary)
  values (v_site, tg_table_name, v_key, v_op, v_rev, v_sum)
  returning seq into v_seq;
  begin
    perform realtime.send(
      jsonb_build_object('s', v_seq, 't', tg_table_name, 'k', v_key, 'op', v_op, 'rev', v_rev, 'v', v_sum),
      'chg', 'zx:' || v_site, true);
  exception when others then
    null;
  end;
  return null;
end $$;

-- 資料集版本：前端把大型且少變動的資料（品項主檔）快取在 IndexedDB，
-- 每次開啟只讀這張小表比對版本，有變才重抓（避免每次首載下載整份主檔）
create table if not exists public.dataset_versions (
  name       text primary key,
  version    bigint not null default 1,
  updated_at timestamptz not null default now()
);
alter table public.dataset_versions enable row level security;
drop policy if exists dataset_versions_select on public.dataset_versions;
create policy dataset_versions_select on public.dataset_versions for select to authenticated
  using ((select private.is_member()));

-- 記一筆「整表／整批」變更並推播（row_key='*'；前端收到後重載目前畫面或比對 dataset_versions）
create or replace function private.emit_bulk(p_site text, p_tbl text, p_op char(1) default 'U')
returns void language plpgsql security definer set search_path = '' as $$
declare v_seq bigint;
begin
  insert into public.change_log (site, tbl, row_key, op)
  values (p_site, p_tbl, '*', p_op) returning seq into v_seq;
  insert into public.dataset_versions as d (name) values (p_tbl)
  on conflict (name) do update set version = d.version + 1, updated_at = now();
  begin
    perform realtime.send(jsonb_build_object('s', v_seq, 't', p_tbl, 'k', '*', 'op', p_op),
                          'chg', 'zx:' || p_site, true);
  exception when others then null;
  end;
end $$;

-- 大量寫入（品項主檔上傳等）用「語句級」觸發器只記一筆 '*'，避免數千則推播
create or replace function private.log_bulk_change() returns trigger
language plpgsql security definer set search_path = '' as $$
begin
  if current_setting('zx.bulk', true) = 'on' then
    return null;
  end if;
  perform private.emit_bulk(tg_argv[0], tg_table_name);
  return null;
end $$;

-- 共用的寫入去重 helper：已處理過的 request_id 直接回傳舊結果
create or replace function private.replayed(p_request_id uuid) returns jsonb
language sql stable security definer set search_path = '' as $$
  select result from public.write_requests where request_id = p_request_id
$$;
create or replace function private.remember(p_request_id uuid, p_fn text, p_result jsonb) returns jsonb
language plpgsql security definer set search_path = '' as $$
begin
  if p_request_id is not null then
    insert into public.write_requests (request_id, fn, result) values (p_request_id, p_fn, p_result)
    on conflict (request_id) do nothing;
  end if;
  return p_result;
end $$;

-- 套用到表上的小工具（只在觸發器不存在時建立 → 可重複執行）
create or replace function private.attach_sync(p_table regclass, p_site text, p_key text, p_summary text[] default '{}')
returns void language plpgsql set search_path = '' as $$
declare v_name text := (select relname from pg_class where oid = p_table);
begin
  if not exists (select 1 from information_schema.columns
                 where table_schema = 'public' and table_name = v_name and column_name = 'revision') then
    execute format('alter table %s add column revision bigint not null default 1', p_table);
  end if;
  if not exists (select 1 from information_schema.columns
                 where table_schema = 'public' and table_name = v_name and column_name = 'updated_at') then
    execute format('alter table %s add column updated_at timestamptz not null default now()', p_table);
  end if;
  if not exists (select 1 from pg_trigger where tgrelid = p_table and tgname = 'zx_bump_revision') then
    execute format('create trigger zx_bump_revision before update on %s for each row execute function private.bump_revision()', p_table);
  end if;
  if not exists (select 1 from pg_trigger where tgrelid = p_table and tgname = 'zx_log_change') then
    execute format('create trigger zx_log_change after insert or update or delete on %s for each row execute function private.log_change(%L, %L%s)',
                   p_table, p_site, p_key,
                   (select coalesce(string_agg(', ' || quote_literal(c), ''), '') from unnest(p_summary) c));
  end if;
end $$;

-- 共用 CAS 錯誤：前端收到 errcode 'P0409' 時顯示「資料已在別處更新」並重抓該筆
-- （所有寫入 RPC 皆以 expected_revision 比對；不符即拒絕，不悄悄覆寫）

-- ---------------------------------------------------------------------
-- 5. Realtime 私有頻道授權：只有成員能收 zx:* 的 Broadcast
--    前端：sb.channel('zx:tick', { config: { private: true } })
--    並在 Dashboard → Realtime → Settings 關閉「Allow public access」
-- ---------------------------------------------------------------------
do $$ begin
  if to_regclass('realtime.messages') is not null then
    execute 'drop policy if exists zx_members_receive on realtime.messages';
    execute $p$create policy zx_members_receive on realtime.messages for select to authenticated
              using ((select private.is_member()) and realtime.topic() like 'zx:%' and extension = 'broadcast')$p$;
  end if;
end $$;

-- ---------------------------------------------------------------------
-- 6. 共用客戶／車輛主檔（依 ERD；若 customers 已由舊報價系統建立，只補欄位，不動舊欄位）
-- ---------------------------------------------------------------------
create table if not exists public.customers (
  code text primary key,
  name text not null default ''
);
alter table public.customers add column if not exists is_active boolean not null default true;
alter table public.customers add column if not exists quotation_settings jsonb not null default '{}'::jsonb;
select private.attach_sync('public.customers', 'shared', 'code', array['code', 'name', 'is_active']);
-- 注意：舊報價系統的大型 JSONB（mapping/saved_records/...）仍留在 customers 供舊站使用，
--       新站一律欄位投影 select('code,name,is_active,revision')，Realtime 改走 Broadcast 小事件。

create table if not exists public.customer_aliases (
  id            uuid primary key default gen_random_uuid(),
  customer_code text not null references public.customers(code) on update cascade,
  alias_name    text not null,
  source        text not null default 'manual',     -- manual / legacy_tick / legacy_report / static_list
  created_at    timestamptz not null default now(),
  unique (customer_code, alias_name)
);
-- 同一別名可能對到多個客戶（同名不同店）→ 不設全域唯一，前端遇到多筆必須讓使用者選
create index if not exists customer_aliases_alias_idx on public.customer_aliases (alias_name);
select private.attach_sync('public.customer_aliases', 'shared', 'id', array['customer_code', 'alias_name']);

create table if not exists public.vehicles (
  id        uuid primary key default gen_random_uuid(),
  car_no    text not null unique,
  is_active boolean not null default true,
  notes     text
);
select private.attach_sync('public.vehicles', 'shared', 'id', array['car_no', 'is_active']);

create table if not exists public.customer_vehicle_assignments (
  id             uuid primary key default gen_random_uuid(),
  customer_code  text not null references public.customers(code) on update cascade,
  vehicle_id     uuid not null references public.vehicles(id),
  is_primary     boolean not null default true,
  effective_from date not null default current_date,
  effective_to   date,
  check (effective_to is null or effective_to >= effective_from)
);
create index if not exists cva_customer_idx on public.customer_vehicle_assignments (customer_code, effective_from desc);
select private.attach_sync('public.customer_vehicle_assignments', 'shared', 'id',
                           array['customer_code', 'vehicle_id', 'is_primary', 'effective_from', 'effective_to']);

-- 姓名對不上或同名的舊資料，先放待確認清單（打勾單／異常表 backfill 共用）
create table if not exists public.legacy_name_review (
  id           uuid primary key default gen_random_uuid(),
  source       text not null,           -- 'tick_v4' / 'tick_hist' / 'abnormal' / 'handover'
  legacy_name  text not null,
  candidates   text[] not null default '{}',   -- 可能的 customers.code
  resolved_code text references public.customers(code),
  note         text,
  created_at   timestamptz not null default now(),
  unique (source, legacy_name)
);

-- RLS：成員可讀；staff/admin 可新增修改；刪除走 private.can_delete()（預設只限 admin）
do $$
declare t text;
begin
  foreach t in array array['customers', 'customer_aliases', 'vehicles', 'customer_vehicle_assignments', 'legacy_name_review'] loop
    execute format('alter table public.%I enable row level security', t);
    execute format('drop policy if exists zx_select on public.%I', t);
    execute format('create policy zx_select on public.%I for select to authenticated using ((select private.is_member()))', t);
    execute format('drop policy if exists zx_insert on public.%I', t);
    execute format('create policy zx_insert on public.%I for insert to authenticated with check ((select private.can_write()))', t);
    execute format('drop policy if exists zx_update on public.%I', t);
    execute format('create policy zx_update on public.%I for update to authenticated using ((select private.can_write())) with check ((select private.can_write()))', t);
    execute format('drop policy if exists zx_delete on public.%I', t);
    execute format('create policy zx_delete on public.%I for delete to authenticated using ((select private.can_delete()))', t);
  end loop;
end $$;

-- 依名稱找客戶：主檔名稱 + 別名，回傳所有候選（不自動合併）
create or replace function public.find_customers(p_name text)
returns table (code text, name text, matched_by text)
language sql stable security invoker set search_path = '' as $$
  select c.code, c.name, 'name' from public.customers c where c.name = p_name and c.is_active
  union
  select c.code, c.name, 'alias' from public.customer_aliases a
    join public.customers c on c.code = a.customer_code
  where a.alias_name = p_name and c.is_active
$$;
grant execute on function public.find_customers(text) to authenticated;

-- 目前有效的車號（assignment 優先；前端若查無再參考歷史紀錄並標示來源）
create or replace function public.current_vehicle(p_customer_code text, p_on date default current_date)
returns table (vehicle_id uuid, car_no text, source text)
language sql stable security invoker set search_path = '' as $$
  select v.id, v.car_no, 'assignment'
  from public.customer_vehicle_assignments a join public.vehicles v on v.id = a.vehicle_id
  where a.customer_code = p_customer_code and a.effective_from <= p_on
    and (a.effective_to is null or a.effective_to >= p_on) and v.is_active
  order by a.is_primary desc, a.effective_from desc
  limit 1
$$;
grant execute on function public.current_vehicle(text, date) to authenticated;

-- private schema 的函式預設 PUBLIC 可執行 → 收回，只開放 RLS 需要的四個判斷函式
revoke all on all functions in schema private from public;
grant execute on function private.member_role(), private.is_member(), private.can_write(), private.is_admin(),
  private.replayed(uuid), private.remember(uuid, text, jsonb), private.can_delete()
  to authenticated;

commit;
