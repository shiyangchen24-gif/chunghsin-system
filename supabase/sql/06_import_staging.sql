-- =====================================================================
-- 06_import_staging.sql ── 舊專案資料的「暫存區」
-- 新專案目前是空的；三個舊網站各自在不同的 Supabase 專案：
--   打勾單   ozlsmfmpqzdcskqrlccw  表 zhongxin_store (key, value)
--   異常交接 xojtuhbnvryfoslqekjr  表 abnormal_reports / handover_reports
--   報價     ovjdtzzvpafomivbuecb  表 customers / master_items
-- tools/migrate.html 以「舊站公開 anon key 讀取」→「新專案 admin 登入寫入」的方式搬進下列表格，
-- 再執行 07_backfill.sql 轉成新結構。暫存表只有 admin 能讀寫。
-- =====================================================================
begin;

-- 打勾單舊 key-value（使用者指定新專案沿用 "Chunghsin_store" 這個名稱；大小寫需加引號）
create table if not exists public."Chunghsin_store" (
  key        text primary key,
  value      jsonb,
  updated_at timestamptz not null default now()
);

-- 報價舊 customers 整列原文（含 mapping / saved_records / quoted_prices / item_code_lookup / last_item_codes）
create table if not exists public.legacy_quote_customers (
  code        text primary key,
  row         jsonb not null,
  imported_at timestamptz not null default now()
);

-- 搬移紀錄（筆數與位元組，供核對）
create table if not exists public.legacy_import_log (
  id          bigint generated always as identity primary key,
  source      text not null,     -- 舊專案 ref
  source_table text not null,
  target_table text not null,
  rows        int not null,
  bytes       bigint,
  actor       uuid default auth.uid(),
  imported_at timestamptz not null default now()
);

do $$
declare t text;
begin
  foreach t in array array['Chunghsin_store', 'legacy_quote_customers', 'legacy_import_log'] loop
    execute format('alter table public.%I enable row level security', t);
    execute format('drop policy if exists zx_admin_all on public.%I', t);
    execute format('create policy zx_admin_all on public.%I for all to authenticated using ((select private.is_admin())) with check ((select private.is_admin()))', t);
  end loop;
end $$;

commit;
