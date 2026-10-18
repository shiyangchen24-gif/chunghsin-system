-- =====================================================================
-- 99_rollback.sql ── 回滾
-- 第 1 段：還原 08_cutover 移除的 anon policy／權限／publication → 舊網頁恢復可用
-- 第 2 段：移除新系統掛在「舊表」上的觸發器 → 舊表行為與遷移前完全相同
-- 新建的表與新增欄位不刪除（不影響舊站；新資料保留以便日後再次切換）。
-- 若真的要刪新表，請另外人工確認後處理，本腳本刻意不提供 DROP TABLE。
-- 執行方式：取消註解下一行後整份執行
-- set zx.confirm = 'rollback';
-- =====================================================================
do $$ begin
  if current_setting('zx.confirm', true) is distinct from 'rollback' then
    raise exception '安全鎖：請先取消註解 set zx.confirm = ''rollback''; 再執行';
  end if;
end $$;

begin;

-- 第 1 段
do $$
declare r record;
begin
  if to_regclass('zx_backup.cutover_log') is null then
    raise notice '沒有 cutover 紀錄，略過第 1 段';
    return;
  end if;
  for r in select id, kind, object, restore_sql from zx_backup.cutover_log order by id loop
    begin
      execute r.restore_sql;
      raise notice 'restored %: %', r.kind, r.object;
    exception when duplicate_object then
      raise notice 'already present %: %', r.kind, r.object;
    end;
  end loop;
  delete from zx_backup.cutover_log;
end $$;

-- 第 2 段：舊表上的新觸發器
do $$
declare r record;
begin
  for r in select tgname, tgrelid::regclass as tbl from pg_trigger
           where not tgisinternal and tgname like 'zx\_%'
             and tgrelid in (select to_regclass(t) from unnest(array['public.customers', 'public.master_items',
                               'public.abnormal_reports', 'public.handover_reports']) t where to_regclass(t) is not null) loop
    execute format('drop trigger %I on %s', r.tgname, r.tbl);
    raise notice 'dropped trigger % on %', r.tgname, r.tbl;
  end loop;
end $$;

commit;
