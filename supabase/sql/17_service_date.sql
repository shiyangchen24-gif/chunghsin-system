-- =====================================================================
-- 17_service_date.sql ── 指定打勾單營業日（可重複執行）
-- 執行順序：03、15 之後。
--   SQL Editor：select public.tick_set_service_date('2026-10-24');
--   網頁：打勾單「📅 指定營業日」按鈕（只限管理員）
-- 規則（不會刪除任何已打勾的資料）：
--   往後指定（例如目前 10/23 → 10/24）：結束目前營業日（保留當天狀態為歷史），開新的一天，等同「重置今日」到指定日期
--   往前指定（例如誤按重置，目前 10/25 → 回到 10/24）：
--     目前營業日必須還沒有任何打勾，否則拒絕（避免當天的勾選被丟掉）；
--     指定日期已存在就重新打開，不存在就新增；指定日期之後不能有其他已結束的營業日
-- 開著的打勾單會自動切換到新的營業日。
-- =====================================================================
begin;

create or replace function public.tick_set_service_date(p_date date)
returns jsonb language plpgsql security definer set search_path = '' as $$
declare
  v_open  date;
  v_after date;
begin
  if auth.uid() is not null and not private.is_admin() then
    raise exception 'admin only' using errcode = '42501';
  end if;
  if p_date is null then raise exception '請指定日期' using errcode = '22023'; end if;
  select service_date into v_open from public.tick_service_days where status = 'open' for update;

  if v_open = p_date then
    return jsonb_build_object('ok', true, 'open', p_date, 'from', v_open, 'changed', false);
  end if;

  if v_open is null or p_date > v_open then
    -- 往後：結束目前營業日（與「重置今日」相同，手動加入的三天未叫標示在已叫貨後失效）
    if v_open is not null then
      update public.tick_service_days set status = 'closed', closed_at = now(), closed_by = auth.uid()
       where service_date = v_open;
      delete from public.tick_warn3_overrides o
       using public.daily_order_status s
       where o.mode = 'add' and s.customer_code = o.customer_code and s.service_date = v_open and s.status <> '未叫貨';
    end if;
  else
    -- 往前：目前營業日不能有打勾、指定日期之後不能有已結束的營業日
    if exists (select 1 from public.daily_order_status where service_date = v_open) then
      return jsonb_build_object('ok', false, 'reason', 'has_ticks', 'open', v_open);
    end if;
    select max(service_date) into v_after from public.tick_service_days
     where status = 'closed' and service_date > p_date;
    if v_after is not null then
      return jsonb_build_object('ok', false, 'reason', 'later_days', 'open', v_open, 'later', v_after);
    end if;
    delete from public.tick_service_days where service_date = v_open;
  end if;

  if exists (select 1 from public.tick_service_days where service_date = p_date) then
    update public.tick_service_days set status = 'open', closed_at = null, closed_by = null where service_date = p_date;
  else
    insert into public.tick_service_days (service_date) values (p_date);
  end if;
  return jsonb_build_object('ok', true, 'open', p_date, 'from', v_open, 'changed', true);
end $$;
revoke all on function public.tick_set_service_date(date) from public, anon;
grant execute on function public.tick_set_service_date(date) to authenticated;

commit;
