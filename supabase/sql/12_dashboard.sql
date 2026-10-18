-- =====================================================================
-- 12_dashboard.sql ── 首頁儀表板用的單一彙總 RPC（唯讀，可重複執行）
-- 執行順序：02～06 之後任何時候皆可；不改任何資料表。
-- 一次呼叫回傳約 2～4 KB 的 JSON（30 天趨勢＋最新 4 筆異常），首頁不必下載任何明細。
-- =====================================================================
begin;

create or replace function public.dashboard_summary(p_days int default 30)
returns jsonb language sql stable security invoker set search_path = '' as $$
  with cur as (
    select service_date from public.tick_service_days where status = 'open'
  ), prev as (
    select service_date from public.tick_service_days where status = 'closed' order by service_date desc limit 1
  ), listed as (
    select t.customer_code, coalesce(nullif(c.name, ''), t.legacy_name, t.customer_code) as name
    from public.tick_customers t join public.customers c on c.code = t.customer_code
    where t.is_listed
  ), today_st as (
    select s.customer_code, s.status from public.daily_order_status s join cur using (service_date)
  ), series as (
    -- 與打勾單 getSeriesMembers 相同規則：另加店名／指定成員，或名稱開頭符合 prefix 且不符合 exclude_prefix
    select g.name, g.sort_order,
           count(l.customer_code)::int as total,
           count(l.customer_code) filter (where ts.status = '有叫貨')::int as ord
    from public.order_groups g
    left join listed l on (
         l.name in (select jsonb_array_elements_text(coalesce(g.rule -> 'extra', '[]')))
      or exists (select 1 from public.order_group_members m where m.group_id = g.id and m.customer_code = l.customer_code)
      or (exists (select 1 from jsonb_array_elements_text(coalesce(g.rule -> 'prefix', jsonb_build_array(g.name))) p
                  where starts_with(l.name, p))
          and not exists (select 1 from jsonb_array_elements_text(coalesce(g.rule -> 'exclude_prefix', '[]')) x
                          where starts_with(l.name, x))))
    left join today_st ts on ts.customer_code = l.customer_code
    where g.kind = 'series'
    group by g.id, g.name, g.sort_order
  ), days as (
    select d.service_date, d.status
    from public.tick_service_days d
    order by d.service_date desc
    limit greatest(1, least(coalesce(p_days, 30), 90))
  ), trend as (
    select d.service_date, d.status,
           count(s.id) filter (where s.status = '有叫貨')::int as ord,
           count(s.id) filter (where s.status = '今日不叫貨')::int as no
    from days d left join public.daily_order_status s on s.service_date = d.service_date
    group by d.service_date, d.status
  ), rep_day as (
    select (now() at time zone 'Asia/Taipei')::date as today
  ), quote as (
    select count(*) filter (where not p.has_mapping)::int as setup,
           count(*) filter (where p.has_mapping and (case when p.product_code_mode = '無貨號'
                                                     then p.quoted_prices_count else p.saved_records_count end) = 0)::int as pending,
           count(*) filter (where p.has_mapping and (case when p.product_code_mode = '無貨號'
                                                     then p.quoted_prices_count else p.saved_records_count end) > 0)::int as ready,
           count(*)::int as total
    from public.customer_quote_profiles p
  )
  select jsonb_build_object(
    'service_date', (select service_date from cur),
    'prev_date',    (select service_date from prev),
    'tick', jsonb_build_object(
      'total', (select count(*) from listed),
      'ord',   (select count(*) from today_st where status = '有叫貨'),
      'no',    (select count(*) from today_st where status = '今日不叫貨'),
      'warn3', (select count(*) from public.v_tick_warn3),   -- 趨勢的「未叫貨」= total − ord − no（與 tick_daily_counts 相同，以目前名單為分母）
      'prev_ord', (select count(*) from public.daily_order_status s join prev using (service_date) where s.status = '有叫貨')
    ),
    'series', coalesce((select jsonb_agg(jsonb_build_object('name', name, 'ord', ord, 'total', total) order by sort_order, name) from series), '[]'),
    'trend',  coalesce((select jsonb_agg(jsonb_build_object('d', service_date, 'ord', ord, 'no', no, 'open', status = 'open') order by service_date) from trend), '[]'),
    'report', jsonb_build_object(
      'today', (select today from rep_day),
      'ab_today',  (select count(*) from public.abnormal_reports a, rep_day r where a.report_date = r.today),
      'ab_prev',   (select count(*) from public.abnormal_reports a, rep_day r where a.report_date = r.today - 1),
      'ho_today',  (select count(*) from public.handover_reports h, rep_day r where h.report_date = r.today),
      'ab_7d',     (select count(*) from public.abnormal_reports a, rep_day r where a.report_date > r.today - 7 and a.report_date <= r.today),
      'ab_prev_7d',(select count(*) from public.abnormal_reports a, rep_day r where a.report_date > r.today - 14 and a.report_date <= r.today - 7),
      'latest', coalesce((select jsonb_agg(x order by x.created_at desc) from (
          select a.id, a.report_date, a.date, a.store, a.car_no, a.reason, a.category, a.exchange_type, a.created_at
          from public.abnormal_reports a order by a.created_at desc nulls last, a.id desc limit 4) x), '[]')
    ),
    'quote', (select to_jsonb(q) from quote q)
  )
$$;

revoke all on function public.dashboard_summary(int) from public, anon;
grant execute on function public.dashboard_summary(int) to authenticated;

commit;
