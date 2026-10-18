-- =====================================================================
-- 14_analytics.sql ── 異常狀態分析＋經營月報（唯讀 RPC，可重複執行）
-- 執行順序：02～06、12 之後。不改任何資料表。
--   report_analysis(p_from, p_to)：異常類別／處理方式／責任歸屬比例、店家與車號排行、每日筆數，並附上前一段同長度期間做比較
--   boss_report(p_from, p_to)    ：給老闆的月報：叫貨（營業日、平均叫貨率、叫貨率最低客戶、連續未叫）＋異常分析＋報價匯出
-- 回傳都是小型 JSON（一個月約 3～6 KB），畫面不必下載明細。
-- =====================================================================
begin;

create or replace function public.report_analysis(p_from date, p_to date)
returns jsonb language sql stable security invoker set search_path = '' as $$
  with ab as (
    select a.report_date, nullif(btrim(a.category), '') as category, nullif(btrim(a.exchange_type), '') as exchange_type,
           nullif(btrim(a.responsibility), '') as responsibility, nullif(btrim(a.store), '') as store,
           nullif(btrim(a.car_no), '') as car_no
    from public.abnormal_reports a
    where a.report_date between p_from and p_to
  ), prev as (
    select count(*)::int as n from public.abnormal_reports a
    where a.report_date between p_from - (p_to - p_from + 1) and p_from - 1
  ), resp as (
    select coalesce(responsibility, '未填') as k, count(*)::int as n,
           row_number() over (order by count(*) desc, coalesce(responsibility, '未填')) as rn
    from ab group by 1
  ), stores as (
    select store, count(*)::int as n,
           mode() within group (order by coalesce(category, '未分類')) as top_category
    from ab where store is not null group by store order by n desc, store limit 10
  )
  select jsonb_build_object(
    'from', p_from, 'to', p_to,
    'total', (select count(*) from ab),
    'prev_total', (select n from prev),
    'handover', (select count(*) from public.handover_reports h where h.report_date between p_from and p_to),
    'by_category', coalesce((select jsonb_agg(jsonb_build_object('k', k, 'n', n) order by k) from
                    (select coalesce(category, '未分類') as k, count(*)::int as n from ab group by 1) x), '[]'),
    'by_exchange', coalesce((select jsonb_agg(jsonb_build_object('k', k, 'n', n) order by n desc, k) from
                    (select coalesce(exchange_type, '未填') as k, count(*)::int as n from ab group by 1) x), '[]'),
    -- 責任歸屬是自由輸入：取前 7 名，其餘合併為「其他」
    'by_responsibility', coalesce((select jsonb_agg(jsonb_build_object('k', k, 'n', n) order by o, n desc) from
                    (select case when rn <= 7 then k else '其他' end as k, sum(n)::int as n, max(case when rn <= 7 then 0 else 1 end) as o
                     from resp group by 1) x), '[]'),
    'top_stores', coalesce((select jsonb_agg(jsonb_build_object('store', store, 'n', n, 'top_category', top_category) order by n desc, store) from stores), '[]'),
    'top_vehicles', coalesce((select jsonb_agg(jsonb_build_object('car_no', car_no, 'n', n) order by n desc, car_no) from
                    (select car_no, count(*)::int as n from ab where car_no is not null group by car_no order by n desc, car_no limit 8) x), '[]'),
    'daily', coalesce((select jsonb_agg(jsonb_build_object('d', d, 'n', n) order by d) from
                    (select report_date as d, count(*)::int as n from ab group by 1) x), '[]')
  )
$$;

create or replace function public.boss_report(p_from date, p_to date)
returns jsonb language sql stable security invoker set search_path = '' as $$
  with listed as (
    select t.customer_code, coalesce(nullif(c.name, ''), t.legacy_name, t.customer_code) as name, t.fixed
    from public.tick_customers t join public.customers c on c.code = t.customer_code where t.is_listed
  ), days as (
    select d.service_date from public.tick_service_days d
    where d.service_date between p_from and p_to and d.status = 'closed'
  ), per_day as (
    select d.service_date,
           count(s.id) filter (where s.status = '有叫貨')::int as ord,
           count(s.id) filter (where s.status = '今日不叫貨')::int as no
    from days d left join public.daily_order_status s on s.service_date = d.service_date
    group by d.service_date
  ), per_cust as (
    select l.customer_code, l.name, l.fixed,
           count(s.id) filter (where s.status = '有叫貨')::int as ord_days,
           count(s.id) filter (where s.status = '今日不叫貨')::int as no_days
    from listed l left join public.daily_order_status s
      on s.customer_code = l.customer_code and s.service_date in (select service_date from days)
    group by l.customer_code, l.name, l.fixed
  ), quote as (
    select count(*)::int as exports,
           coalesce(sum(e.item_count), 0)::int as items,
           (select count(distinct c) from public.customer_quote_exports e2, unnest(e2.customer_codes) c
             where (e2.exported_at at time zone 'Asia/Taipei')::date between p_from and p_to)::int as customers
    from public.customer_quote_exports e
    where (e.exported_at at time zone 'Asia/Taipei')::date between p_from and p_to
  )
  select jsonb_build_object(
    'from', p_from, 'to', p_to, 'generated_at', now(),
    'tick', jsonb_build_object(
      'service_days', (select count(*) from days),
      'customers', (select count(*) from listed),
      'avg_ord', (select round(avg(ord), 1) from per_day),
      'avg_rate', (select round(avg(ord::numeric / nullif((select count(*) from listed), 0)) * 100, 1) from per_day),
      'best_day', (select jsonb_build_object('d', service_date, 'ord', ord) from per_day order by ord desc, service_date limit 1),
      'worst_day', (select jsonb_build_object('d', service_date, 'ord', ord) from per_day order by ord, service_date limit 1),
      'days', coalesce((select jsonb_agg(jsonb_build_object('d', service_date, 'ord', ord, 'no', no) order by service_date) from per_day), '[]'),
      -- 叫貨率最低的客戶（流失風險）：排除整段期間都標「今日不叫貨」的客戶
      'low_customers', coalesce((select jsonb_agg(jsonb_build_object('name', name, 'fixed', fixed, 'ord_days', ord_days, 'no_days', no_days) order by ord_days, name)
                       from (select * from per_cust where (select count(*) from days) > 0 and no_days < (select count(*) from days)
                             order by ord_days, name limit 10) x), '[]'),
      'streak', coalesce((select jsonb_agg(jsonb_build_object('name', l.name, 'fixed', l.fixed, 'streak', v.streak) order by v.streak desc, l.name)
                       from (select * from public.v_tick_streak where streak >= 3 order by streak desc limit 15) v
                       join listed l using (customer_code)), '[]'),
      'by_owner', coalesce((select jsonb_agg(jsonb_build_object('fixed', fixed, 'customers', n, 'ord_days', o) order by o desc, fixed) from
                       (select coalesce(fixed, '未指定') as fixed, count(*)::int as n, sum(ord_days)::int as o from per_cust group by 1) x), '[]')
    ),
    'report', public.report_analysis(p_from, p_to),
    'quote', (select to_jsonb(q) from quote q)
  )
$$;

do $$
declare f text;
begin
  foreach f in array array['report_analysis(date, date)', 'boss_report(date, date)'] loop
    execute format('revoke all on function public.%s from public, anon', f);
    execute format('grant execute on function public.%s to authenticated', f);
  end loop;
end $$;

commit;
