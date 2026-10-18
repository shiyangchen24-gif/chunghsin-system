-- =====================================================================
-- 04_report.sql ── 異常表／交接表：additive 擴充＋舊新欄位雙向相容
-- 舊欄位 date,car_no,store,reason,exchange_type,category,responsibility,note,content,created_at
-- 全部保留；新欄位由觸發器雙向同步 → 舊網頁在切換前仍能照常讀寫。
-- 狀態：草稿，尚未在真實專案執行。
-- =====================================================================
begin;

-- 原表若不存在（全新安裝）才建立，欄位與原 Prompt 一致
create table if not exists public.abnormal_reports (
  id uuid primary key default gen_random_uuid(),
  date text, car_no text, store text, reason text, exchange_type text,
  category text, responsibility text, note text,
  created_at timestamptz default now()
);
create table if not exists public.handover_reports (
  id uuid primary key default gen_random_uuid(),
  date text, store text, content text,
  created_at timestamptz default now()
);

alter table public.abnormal_reports add column if not exists customer_code text references public.customers(code) on update cascade;
alter table public.abnormal_reports add column if not exists vehicle_id uuid references public.vehicles(id);
alter table public.abnormal_reports add column if not exists issue_description text;   -- ⇄ reason
alter table public.abnormal_reports add column if not exists report_date date;          -- ⇄ date(text)
alter table public.abnormal_reports add column if not exists car_no_source text;        -- assignment / history / manual
alter table public.abnormal_reports add column if not exists updated_by uuid;
alter table public.abnormal_reports add column if not exists request_id uuid;
create unique index if not exists abnormal_reports_request_id_key on public.abnormal_reports (request_id);

alter table public.handover_reports add column if not exists customer_code text references public.customers(code) on update cascade;
alter table public.handover_reports add column if not exists vehicle_id uuid references public.vehicles(id);
alter table public.handover_reports add column if not exists handover_description text; -- ⇄ content
alter table public.handover_reports add column if not exists report_date date;          -- ⇄ date(text)
alter table public.handover_reports add column if not exists updated_by uuid;
alter table public.handover_reports add column if not exists request_id uuid;
create unique index if not exists handover_reports_request_id_key on public.handover_reports (request_id);

-- 依日期 keyset 分頁：where (report_date, id) < (:last_date, :last_id) order by report_date desc, id desc limit 50
create index if not exists abnormal_reports_date_idx on public.abnormal_reports (report_date desc, id desc);
create index if not exists abnormal_reports_customer_idx on public.abnormal_reports (customer_code, report_date desc);
create index if not exists abnormal_reports_store_idx on public.abnormal_reports (store, created_at desc);
-- 畫面依日期範圍篩選、建立時間新到舊排序（與原版排序一致），keyset 分頁用 (created_at, id)
create index if not exists abnormal_reports_range_idx on public.abnormal_reports (report_date, created_at desc, id desc);
create index if not exists handover_reports_range_idx on public.handover_reports (report_date, created_at desc, id desc);
create index if not exists handover_reports_date_idx on public.handover_reports (report_date desc, id desc);
create index if not exists handover_reports_customer_idx on public.handover_reports (customer_code, report_date desc);

-- 舊 text 日期 → date：只認得的格式才轉，其餘回傳 null（不強制轉型、不丟資料，原文仍在 date 欄）
--   YYYY-MM-DD / YYYY/MM/DD / YYYY.MM.DD：直接轉
--   M/D、M-D、M月D日：年份取 created_at(台北時間)；若結果比建立時間晚 7 天以上，視為前一年（跨年）
create or replace function private.parse_legacy_date(p_text text, p_created timestamptz)
returns date language plpgsql immutable set search_path = '' as $$
declare
  m   text[];
  ref date := coalesce((p_created at time zone 'Asia/Taipei')::date, current_date);
  d   date;
begin
  if p_text is null then return null; end if;
  m := regexp_match(btrim(p_text), '^(\d{4})[-/.](\d{1,2})[-/.](\d{1,2})$');
  if m is not null then
    return make_date(m[1]::int, m[2]::int, m[3]::int);
  end if;
  m := regexp_match(btrim(p_text), '^(\d{1,2})(?:[-/]|月)(\d{1,2})日?$');
  if m is not null then
    d := make_date(extract(year from ref)::int, m[1]::int, m[2]::int);
    if d > ref + 7 then d := make_date(extract(year from ref)::int - 1, m[1]::int, m[2]::int); end if;
    return d;
  end if;
  return null;
exception when others then        -- 例如 2026-02-30
  return null;
end $$;

-- 雙向相容觸發器（BEFORE INSERT/UPDATE）
--   舊站只寫 reason/content/date → 自動補 issue_description/handover_description/report_date
--   新站寫新欄位 → 自動回填舊欄位，舊網頁仍看得到
-- security definer：切換前舊站以 anon 身分寫入時，也能呼叫 private.parse_legacy_date
create or replace function private.report_compat() returns trigger
language plpgsql security definer set search_path = '' as $$
declare
  v_old_txt text; v_new_txt text;
begin
  if tg_table_name = 'abnormal_reports' then
    if tg_op = 'INSERT' then
      new.issue_description := coalesce(new.issue_description, new.reason);
      new.reason            := coalesce(new.reason, new.issue_description);
    elsif new.reason is distinct from old.reason and new.issue_description is not distinct from old.issue_description then
      new.issue_description := new.reason;
    elsif new.issue_description is distinct from old.issue_description and new.reason is not distinct from old.reason then
      new.reason := new.issue_description;
    end if;
  else
    if tg_op = 'INSERT' then
      new.handover_description := coalesce(new.handover_description, new.content);
      new.content              := coalesce(new.content, new.handover_description);
    elsif new.content is distinct from old.content and new.handover_description is not distinct from old.handover_description then
      new.handover_description := new.content;
    elsif new.handover_description is distinct from old.handover_description and new.content is not distinct from old.content then
      new.content := new.handover_description;
    end if;
  end if;

  -- 日期
  if tg_op = 'INSERT' then
    if new.report_date is null then
      new.report_date := private.parse_legacy_date(new.date, coalesce(new.created_at, now()));
    elsif new.date is null then
      new.date := to_char(new.report_date, 'YYYY-MM-DD');
    end if;
  elsif new.date is distinct from old.date and new.report_date is not distinct from old.report_date then
    new.report_date := private.parse_legacy_date(new.date, coalesce(new.created_at, now()));
  elsif new.report_date is distinct from old.report_date and new.date is not distinct from old.date
        -- 舊文字若本來就代表同一天（例如 '10/16'、'2026/10/16'），保留原文不改寫
        and private.parse_legacy_date(new.date, coalesce(new.created_at, now())) is distinct from new.report_date then
    new.date := to_char(new.report_date, 'YYYY-MM-DD');
  end if;
  return new;
end $$;

do $$ begin
  if not exists (select 1 from pg_trigger where tgrelid = 'public.abnormal_reports'::regclass and tgname = 'zx_report_compat') then
    create trigger zx_report_compat before insert or update on public.abnormal_reports
      for each row execute function private.report_compat();
  end if;
  if not exists (select 1 from pg_trigger where tgrelid = 'public.handover_reports'::regclass and tgname = 'zx_report_compat') then
    create trigger zx_report_compat before insert or update on public.handover_reports
      for each row execute function private.report_compat();
  end if;
end $$;

-- 推播摘要只含 report_date / customer_code：
-- 前端若正在看同一天才以 id 讀那一列（欄位投影），否則只記游標
select private.attach_sync('public.abnormal_reports', 'report', 'id', array['report_date', 'customer_code']);
select private.attach_sync('public.handover_reports', 'report', 'id', array['report_date', 'customer_code']);

-- 刪除全部：只限 admin，伺服器驗證，需帶確認字串；一次只推播一筆 '*'
--   p_from／p_to 皆為 null：刪除該表全部（等同原「🗑 刪除全部」）；給日期範圍：只刪該範圍（新版畫面預設傳目前篩選範圍）
create or replace function public.report_delete_all(p_table text, p_confirm text, p_from date default null, p_to date default null)
returns jsonb language plpgsql security definer set search_path = '' as $$
declare v_n int;
begin
  if not private.is_admin() then raise exception '只有管理員可以刪除全部' using errcode = '42501'; end if;
  if p_table not in ('abnormal_reports', 'handover_reports') then raise exception 'bad table'; end if;
  if p_confirm is distinct from '刪除全部' then raise exception '確認字串錯誤' using errcode = '22023'; end if;
  perform set_config('zx.bulk', 'on', true);
  if p_from is null and p_to is null then
    execute format('delete from public.%I', p_table);
  else
    execute format('delete from public.%I where report_date between $1 and $2', p_table)
      using coalesce(p_from, '-infinity'::date), coalesce(p_to, 'infinity'::date);
  end if;
  get diagnostics v_n = row_count;
  perform set_config('zx.bulk', 'off', true);
  perform private.emit_bulk('report', p_table, 'D');
  return jsonb_build_object('ok', true, 'deleted', v_n);
end $$;
drop function if exists public.report_delete_all(text, text, date);
revoke all on function public.report_delete_all(text, text, date, date) from public, anon;
grant execute on function public.report_delete_all(text, text, date, date) to authenticated;

-- 新站 RLS（authenticated）。舊站的 anon 全開 policy 此時仍保留，於 07_cutover 才移除。
do $$
declare t text;
begin
  foreach t in array array['abnormal_reports', 'handover_reports'] loop
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

commit;
