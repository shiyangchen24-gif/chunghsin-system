-- 模擬三個「舊專案」（格式照原網站程式碼；anon 全開，與舊系統相同）— 搬移工具測試用
create table public.zhongxin_store(key text primary key, value text, updated_at timestamptz default now());
insert into public.zhongxin_store(key, value) values
 ('zhongxin_v4', '{"全聯中正店":{"status":"有叫貨","date":"ordered","fixed":"阿明"},"美廉社A":{"status":"今日不叫貨","date":"ordered","fixed":"阿華"},"神秘店":{"status":"有叫貨","date":"ordered","fixed":"阿明"},"壽司郎中山":{"status":"未叫貨","date":"","fixed":"阿華"}}'),
 ('zhongxin_hist_v4', '[{"date":"2026/10/15","records":{"全聯中正店":"有叫貨"},"editLog":{"全聯中正店":[{"time":"08:12","status":"有叫貨","user":"小美","icon":"kitty.png"}]}},{"date":"2026/10/16","records":{},"editLog":{}},{"date":"2026/10/17","records":{"全聯中正店":"有叫貨"},"editLog":{}}]'),
 ('zhongxin_order_v1', '{"阿明":["神秘店","全聯中正店"]}'),
 ('zhongxin_notices_v1', '[]'), ('zhongxin_manual_v1', '{}'), ('zhongxin_warn3_v1', '[]'), ('zhongxin_ts_v1', '1792200000000');
create table public.abnormal_reports(id uuid primary key default gen_random_uuid(), date text, car_no text, store text, reason text,
 exchange_type text, category text, responsibility text, note text, created_at timestamptz default now());
insert into public.abnormal_reports(date,car_no,store,reason,exchange_type,category)
 select '2026-10-' || lpad((1 + g % 17)::text, 2, '0'), 'CAR-' || (g % 7), '全聯中正店', '品項 ' || g, '退貨', 'A 品質' from generate_series(1, 1234) g;
create table public.handover_reports(id uuid primary key default gen_random_uuid(), date text, store text, content text, created_at timestamptz default now());
insert into public.handover_reports(date,store,content) values ('2026-10-17','全聯中正店 ABC-123','明天提早送');
create table public.customers(code text primary key, name text, quote_cycle text default '7天', trade_status text default '核准交易',
 product_code_mode text default '有貨號', export_status text default '未匯出', last_export_time timestamptz, last_export_filename text,
 mapping jsonb, last_item_codes jsonb, saved_records jsonb default '[]', quoted_prices jsonb, item_code_lookup jsonb default '[]',
 notes text, unit_category text default '', quote_file_location text, last_quote_upload_time timestamptz, last_export_item_count int, updated_at timestamptz default now());
insert into public.customers(code,name,mapping,saved_records,last_item_codes) values
 ('C001','全聯中正店','{"dataStartRowIdx":2,"columnMap":{"0":"貨號","1":"單價"}}','[{"貨號":"A1","品名":"高麗菜","單價":"35","_isNew":false}]','["A1"]'),
 ('C004','壽司郎中山',null,'[]',null);
create table public.master_items(item_code text primary key, item_name text, unit text, spec_code text, grade text);
insert into public.master_items select 'Z' || g, '品項' || g, 'kg', 'S', 'A' from generate_series(1, 2500) g;
do $$ declare t text; begin
  foreach t in array array['zhongxin_store','abnormal_reports','handover_reports','customers','master_items'] loop
    execute format('alter table public.%I enable row level security', t);
    execute format('create policy anon_all on public.%I for all to anon using (true) with check (true)', t);
    execute format('grant all on public.%I to anon', t);
  end loop; end $$;
