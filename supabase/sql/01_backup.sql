-- =====================================================================
-- 01_backup.sql ── 遷移前庫內快照（可重複執行，已存在的快照不覆蓋）
-- 注意：
--  * 這是「同一個資料庫內」的複本，只防誤操作，不防專案遺失。
--    正式備份請另外用 Supabase CLI：  supabase db dump --data-only -f backup.sql
--    （或 pg_dump 連 Dashboard → Connect 的連線字串）存到公司電腦。
--  * 複本會佔 DB 空間（Free 上限 500 MB）。先看 00_inventory 的 total_bytes，
--    確認 2 倍仍在安全範圍再執行。確認遷移穩定後，由管理員手動刪除 zx_backup。
--  * zx_backup schema 不在 API 公開 schema 內，並撤銷 anon/authenticated 權限。
-- =====================================================================
create schema if not exists zx_backup;
revoke all on schema zx_backup from public;
do $$ begin
  if exists (select 1 from pg_roles where rolname = 'anon') then
    execute 'revoke all on schema zx_backup from anon, authenticated';
  end if;
end $$;

do $$
declare
  t text;
  suffix text := to_char(now() at time zone 'Asia/Taipei', 'YYYYMMDD');
begin
  foreach t in array array['zhongxin_store', 'Chunghsin_store', 'chunghsin_store', 'customers',
                           'master_items', 'abnormal_reports', 'handover_reports'] loop
    if to_regclass(format('public.%I', t)) is not null
       and to_regclass(format('zx_backup.%I', t || '_' || suffix)) is null then
      execute format('create table zx_backup.%I as table public.%I', t || '_' || suffix, t);
      raise notice 'backup: public.% -> zx_backup.%', t, t || '_' || suffix;
    end if;
  end loop;
end $$;

-- 核對：每張快照與原表筆數相同才繼續後續 migration
select s.relname as backup_table,
       (xpath('/row/c/text()', query_to_xml(format('select count(*) c from zx_backup.%I', s.relname), false, true, '')))[1]::text::bigint as rows
from pg_class s join pg_namespace n on n.oid = s.relnamespace
where n.nspname = 'zx_backup' and s.relkind = 'r'
order by 1;
