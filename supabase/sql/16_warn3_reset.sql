-- =====================================================================
-- 16_warn3_reset.sql ── 「三天未叫」歸 0：設定起算日，之前的未叫貨天數不再計入（可重複執行）
-- 執行順序：13（app_settings）、15 之後。
--   起算日存在 app_settings.warn3_since；三天未叫（v_tick_warn3）與連續未叫天數（v_tick_streak）
--   只計算「起算日（含）之後已結束的營業日」。歸 0 後客戶要再連續 3 個工作天沒叫貨才會重新出現。
--   歸 0 同時清掉所有手動「加入／排除」標示。
-- 使用方式：
--   SQL Editor：select public.tick_warn3_reset();
--   網頁（管理員）：sb.rpc('tick_warn3_reset')
-- =====================================================================
begin;

insert into public.app_settings (key, value) values ('warn3_since', 'null') on conflict (key) do nothing;

create or replace function private.warn3_since() returns date
language sql stable security definer set search_path = '' as $$
  select coalesce((select nullif(value #>> '{}', '')::date from public.app_settings where key = 'warn3_since'), '-infinity'::date)
$$;
grant execute on function private.warn3_since() to authenticated;

-- 與 03_tick.sql 相同，只多了「起算日之後」的條件
create or replace view public.v_tick_warn3 with (security_invoker = true) as
with last3 as (
  select service_date from public.tick_service_days
  where status = 'closed' and service_date >= private.warn3_since()
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

create or replace view public.v_tick_streak with (security_invoker = true) as
with days as (
  select service_date, row_number() over (order by service_date desc) as rn
  from public.tick_service_days where status = 'closed' and service_date >= private.warn3_since()
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

-- 歸 0：起算日 = 目前營業日；清除手動標示；通知開著的打勾單重新載入
--   SQL Editor（沒有登入身分）可直接執行；網頁上只限管理員
create or replace function public.tick_warn3_reset()
returns jsonb language plpgsql security definer set search_path = '' as $$
declare v_since date;
begin
  if auth.uid() is not null and not private.is_admin() then
    raise exception 'admin only' using errcode = '42501';
  end if;
  select service_date into v_since from public.tick_service_days where status = 'open';
  v_since := coalesce(v_since, (now() at time zone 'Asia/Taipei')::date);
  update public.app_settings set value = to_jsonb(v_since::text) where key = 'warn3_since';
  perform set_config('zx.bulk', 'on', true);
  delete from public.tick_warn3_overrides;
  perform set_config('zx.bulk', 'off', true);
  perform private.emit_bulk('tick', 'tick_warn3_overrides', 'D');
  return jsonb_build_object('ok', true, 'since', v_since);
end $$;
revoke all on function public.tick_warn3_reset() from public, anon;
grant execute on function public.tick_warn3_reset() to authenticated;

grant select on public.v_tick_warn3, public.v_tick_streak to authenticated;

commit;
