-- 本機模擬測試（非真實 Supabase）。每個斷言失敗會 raise exception 中止。
\set ON_ERROR_STOP 1
insert into auth.users values ('00000000-0000-0000-0000-00000000000a','admin@x'),
  ('00000000-0000-0000-0000-00000000000b','staff@x'), ('00000000-0000-0000-0000-00000000000c','viewer@x'),
  ('00000000-0000-0000-0000-00000000000d','stranger@x') on conflict do nothing;
insert into public.app_members(user_id, role) values ('00000000-0000-0000-0000-00000000000a','admin'),
  ('00000000-0000-0000-0000-00000000000b','staff'), ('00000000-0000-0000-0000-00000000000c','viewer') on conflict do nothing;
grant select, insert, update, delete on all tables in schema public to anon, authenticated;

create or replace function pg_temp.assert(c boolean, msg text) returns void language plpgsql as
$$ begin if c is not true then raise exception 'ASSERT FAILED: %', msg; end if; raise notice 'PASS: %', msg; end $$;
grant execute on function pg_temp.assert(boolean, text) to anon, authenticated;

-- 1. 非成員／匿名讀不到新表
set role authenticated; select set_config('request.jwt.claim.sub','00000000-0000-0000-0000-00000000000d',false);
select pg_temp.assert((select count(*) from public.daily_order_status) = 0, 'stranger sees 0 daily rows (RLS)');
select pg_temp.assert((select count(*) from public.customers) = 0, 'stranger sees 0 customers');
do $$ begin perform public.sync_changes(null); raise exception 'should fail'; exception when insufficient_privilege then raise notice 'PASS: stranger cannot call sync_changes'; end $$;
reset role;
set role anon;
select pg_temp.assert((select count(*) from public.customer_quote_items) = 0, 'anon sees 0 quote items');
reset role;

-- 2. 游標：staff 先取水位
set role authenticated; select set_config('request.jwt.claim.sub','00000000-0000-0000-0000-00000000000b',false);
select set_config('zx.cur', (public.sync_changes(null))->>'cursor', false);
select pg_temp.assert((select count(*) from public.customers) = 5, 'staff sees 5 customers');

-- 3. changeStatus 規則 + CAS + request_id 去重（目前營業日由 backfill 開立 = 台北今天）
select set_config('zx.day', (select service_date::text from public.tick_service_days where status='open'), false);
select set_config('zx.r1', (public.tick_set_status(current_setting('zx.day')::date,'C001','有叫貨',null,'11111111-1111-1111-1111-111111111111','click'))::text, false);
select pg_temp.assert((current_setting('zx.r1')::jsonb->>'reason') = 'conflict', 'C001 已有列(有叫貨) 但畫面以為沒有 → conflict');
select set_config('zx.r1', (public.tick_set_status(current_setting('zx.day')::date,'C004','有叫貨',null,'11111111-1111-1111-1111-111111111112','click'))::text, false);
select pg_temp.assert((current_setting('zx.r1')::jsonb->>'ok')::boolean and (current_setting('zx.r1')::jsonb->>'revision')::int = 1, 'click 未叫貨→有叫貨 ok, revision 1');
select pg_temp.assert((public.tick_set_status(current_setting('zx.day')::date,'C004','有叫貨',null,'11111111-1111-1111-1111-111111111112','click'))->>'replayed' = 'true', 'same request_id replayed, not applied twice');
select pg_temp.assert((select count(*) from public.order_status_events where customer_code='C004' and via='click') = 1, 'exactly one event row');
select pg_temp.assert((public.tick_set_status(current_setting('zx.day')::date,'C004','未叫貨',1,gen_random_uuid(),'click'))->>'reason' = 'rule', 'click 有叫貨→未叫貨 rejected (rule)');
select pg_temp.assert((public.tick_set_status(current_setting('zx.day')::date,'C004','今日不叫貨',1,gen_random_uuid(),'right_click'))->>'reason' = 'rule', 'right-click on 有叫貨 rejected');
select pg_temp.assert((public.tick_set_status(current_setting('zx.day')::date,'C004','未叫貨',99,gen_random_uuid(),'modal'))->>'reason' = 'conflict', 'stale revision rejected (conflict)');
select pg_temp.assert((public.tick_set_status(current_setting('zx.day')::date,'C004','未叫貨',1,gen_random_uuid(),'modal'))->>'revision' = '2', 'modal revert with correct revision ok → rev 2');
select pg_temp.assert((public.tick_set_status(current_setting('zx.day')::date,'C004','今日不叫貨',2,gen_random_uuid(),'right_click'))->>'ok' = 'true', 'right-click 未叫貨→今日不叫貨 ok');
select pg_temp.assert((public.tick_set_status('2020-01-01','C004','有叫貨',null,gen_random_uuid(),'click'))->>'reason' = 'day_closed', 'write to non-open day rejected');

-- 4. sync_changes 取回小摘要
select set_config('zx.sync', public.sync_changes(current_setting('zx.cur'))::text, false);
select pg_temp.assert(jsonb_array_length(current_setting('zx.sync')::jsonb->'changes') >= 2, 'sync returns ≥2 changes');
select pg_temp.assert((select bool_or(c->'v'->>'status' = '今日不叫貨') from jsonb_array_elements(current_setting('zx.sync')::jsonb->'changes') c), 'summary carries status');
select pg_temp.assert(jsonb_array_length((public.sync_changes((current_setting('zx.sync')::jsonb->>'cursor')))->'changes') = 0, 'next sync from new cursor is empty');
select pg_temp.assert(length(public.sync_changes((current_setting('zx.sync')::jsonb->>'cursor'))::text) < 80, 'empty watermark check < 80 bytes');

-- 5. viewer 不能寫；staff 不能刪；admin 才能刪除全部
reset role; set role authenticated; select set_config('request.jwt.claim.sub','00000000-0000-0000-0000-00000000000c',false);
do $$ begin perform public.tick_set_status(current_setting('zx.day')::date,'C001','有叫貨'); raise exception 'should fail'; exception when insufficient_privilege then raise notice 'PASS: viewer cannot write'; end $$;
reset role; set role authenticated; select set_config('request.jwt.claim.sub','00000000-0000-0000-0000-00000000000b',false);
delete from public.abnormal_reports;
select pg_temp.assert((select count(*) from public.abnormal_reports) = 3, 'staff delete affects 0 rows (can_delete=admin)');
do $$ begin perform public.report_delete_all('abnormal_reports','刪除全部'); raise exception 'should fail'; exception when insufficient_privilege then raise notice 'PASS: staff cannot delete-all'; end $$;

-- 6. 新站寫新欄位 → 舊欄位自動回填
insert into public.abnormal_reports(report_date, store, issue_description, request_id) values ('2026-10-18','全聯中正店','10/18 青蔥 1把 枯黃', gen_random_uuid());
select pg_temp.assert((select reason = issue_description and date = '2026-10-18' from public.abnormal_reports where report_date='2026-10-18'), 'new-site insert back-fills reason/date');
reset role;

-- 7. 搬移匯入（admin 只寫舊欄位，與舊站相同）→ 新欄位由相容觸發器自動補
select pg_temp.assert((select issue_description = reason and report_date = '2026-10-16' from public.abnormal_reports where id='a0000000-0000-0000-0000-000000000002'), 'imported legacy row (10/16) got issue_description/report_date');
select pg_temp.assert((select date from public.abnormal_reports where id='a0000000-0000-0000-0000-000000000002') = '10/16', 'legacy date text preserved');
set role authenticated; select set_config('request.jwt.claim.sub','00000000-0000-0000-0000-00000000000a',false);
insert into public.abnormal_reports(date, store, reason) values ('10/18','美廉社A','舊格式寫入');
reset role;
select pg_temp.assert((select issue_description = '舊格式寫入' and report_date is not null from public.abnormal_reports where reason='舊格式寫入'), 'legacy-shaped insert fills issue_description/report_date');

-- 8. admin 刪除全部：只產生 1 筆 change_log
set role authenticated; select set_config('request.jwt.claim.sub','00000000-0000-0000-0000-00000000000a',false);
select set_config('zx.cur2', (public.sync_changes(null))->>'cursor', false);
select pg_temp.assert((public.report_delete_all('abnormal_reports','刪除全部'))->>'deleted' = '5', 'admin delete-all removes 5');
select pg_temp.assert(jsonb_array_length((public.sync_changes(current_setting('zx.cur2')))->'changes') = 1, 'delete-all emits one change, not 5');
reset role;

-- 9. 報價：backfill 內容、儲存品項 → 每客戶少量事件；CAS；匯出標記
select pg_temp.assert((select quote_cycle from public.customer_quote_profiles where customer_code='C002') = '15天', 'quote_cycle text migrated');
select pg_temp.assert((select price from public.customer_quote_items where customer_code='C001' and line_no=2 and list_kind='saved') = '時價', 'non-numeric price preserved');
select pg_temp.assert((select legacy->>'怪欄位' from public.customer_quote_items where customer_code='C001' and line_no=1 and list_kind='saved') = '保留我', 'unknown key preserved in legacy');
select pg_temp.assert((select item_name from public.customer_item_code_mappings where customer_code='C002') = '高麗菜', 'lookup itemName migrated');
select pg_temp.assert((select has_mapping from public.customer_quote_profiles where customer_code='C001') and not (select has_mapping from public.customer_quote_profiles where customer_code='C003'), 'has_mapping computed');
set role authenticated; select set_config('request.jwt.claim.sub','00000000-0000-0000-0000-00000000000b',false);
select set_config('zx.cur3', (public.sync_changes(null))->>'cursor', false);
select set_config('zx.rev', (select revision::text from public.customer_quote_profiles where customer_code='C001'), false);
select pg_temp.assert((public.quote_save_items('C001',
  (select jsonb_agg(jsonb_build_object('list_kind','saved','item_code','X'||g,'price',g::text)) from generate_series(1,200) g),
  '["X1"]', 200, '[]', current_setting('zx.rev')::bigint, gen_random_uuid()))->>'ok' = 'true', 'save 200 items ok');
select pg_temp.assert((select saved_records_count from public.customer_quote_profiles where customer_code='C001') = 200, 'saved_records_count = 200');
select pg_temp.assert((select last_export_item_count from public.customer_quote_profiles where customer_code='C001') = 200, 'last_export_item_count updated on save (original behaviour)');
select pg_temp.assert(jsonb_array_length((public.sync_changes(current_setting('zx.cur3')))->'changes') <= 3, '200 items → ≤3 small change events');
select pg_temp.assert((public.quote_save_items('C001','[]','[]',0,'[]', current_setting('zx.rev')::bigint, gen_random_uuid()))->>'reason' = 'conflict', 'stale revision save rejected');
select pg_temp.assert((public.quote_mark_exported('test.xlsx', jsonb_build_array(
   jsonb_build_object('customer_code','C001','item_count',200,'expected_revision',(select revision from public.customer_quote_profiles where customer_code='C001')),
   jsonb_build_object('customer_code','C002','item_count',2,'expected_revision',-1)), gen_random_uuid()))->'conflicts' = '["C002"]', 'mark exported: C001 ok, stale C002 reported');
select pg_temp.assert((select export_status from public.customer_quote_profiles where customer_code='C001') = '已匯出', 'C001 marked 已匯出');
select pg_temp.assert(jsonb_array_length(public.quote_replace_lookups('C002','[{"name":"青蔥","code":"Z200","itemName":"青蔥"},{"name":"高麗菜","code":"Z100"}]')) = 1, 'replace lookups returns row');
select pg_temp.assert((select item_code_lookup_count from public.customer_quote_profiles where customer_code='C002') = 2, 'lookup count = 2');
select pg_temp.assert((public.quote_upsert_customers('[{"code":"N001","name":"新客戶","quote_cycle":"30天"}]')->0->>'quote_cycle') = '30天', 'upsert new customer');
select public.quote_patch_profiles(null, '{"export_status":"未匯出","last_export_time":null,"last_export_filename":""}');
select pg_temp.assert(not exists (select 1 from public.customer_quote_profiles where export_status <> '未匯出' or last_export_time is not null), 'reset all export status');
do $$ begin perform public.quote_delete_customers(array['N001']); raise exception 'should fail'; exception when insufficient_privilege then raise notice 'PASS: staff cannot delete quote customer'; end $$;
-- 主檔上傳無規格代號欄 → 沿用既有
select public.master_items_upsert('[{"item_code":"Z100","item_name":"高麗菜(新)","unit":"kg","spec_code":null,"grade":"A"}]', false);
select pg_temp.assert((select spec_code from public.master_items where item_code='Z100') = 'S1', 'spec_code preserved when file lacks the column');
reset role;

-- 10. Broadcast 訊息有發出且很小
select pg_temp.assert((select max(octet_length(payload::text)) from realtime.messages) < 600, 'largest broadcast payload < 600 bytes');
select pg_temp.assert((select count(*) from realtime.messages where topic not like 'zx:%') = 0, 'all broadcasts on zx:* topics');

-- 11. 暫編代號：打勾單找不到主檔的「神秘店」→ TK0001；同名「美廉社A」不自動建立
select pg_temp.assert((select code from public.customers where name='神秘店') = 'TK0001', '神秘店 → provisional TK0001');
select pg_temp.assert((select quotation_settings->>'provisional' from public.customers where code='TK0001') = 'true', 'TK0001 flagged provisional');
select pg_temp.assert(exists (select 1 from public.legacy_name_review where legacy_name='美廉社A' and resolved_code is null), 'ambiguous 美廉社A left for review');

-- 12. 打勾單 backfill 內容
select pg_temp.assert((select fixed from public.tick_customers where customer_code='C001') = '阿明', '負責人(fixed) migrated as text');
select pg_temp.assert((select count(*) from public.tick_service_days where status='closed') = 4, '4 legacy history days → closed service days');
select pg_temp.assert((select count(*) from public.order_status_events where via='backfill') = 1, 'editLog entry → 1 event (user 小美)');
select pg_temp.assert((select actor_icon from public.order_status_events where via='backfill') = 'kitty.png', 'editLog icon preserved');
select pg_temp.assert((select string_agg(m.customer_code, ',' order by m.sort_order) from public.order_group_members m join public.order_groups g on g.id=m.group_id where g.name='阿明') = 'TK0001,C001', 'group 阿明 order preserved (神秘店=TK0001, 全聯=C001)');
select pg_temp.assert((select body from public.order_notices limit 1) = '週日公休', 'notice migrated');
select pg_temp.assert((select count(*) from public.order_groups where kind='series') = 5, '5 built-in series migrated');

-- 13. 三天未叫：壽司郎中山(C004) 在 10/15、10/16、10/17 都未叫 → auto；美廉社A 為舊手動名單但同名未解析
set role authenticated; select set_config('request.jwt.claim.sub','00000000-0000-0000-0000-00000000000b',false);
select pg_temp.assert(not exists (select 1 from public.v_tick_warn3 where customer_code='C004'), 'C004 marked 今日不叫貨 today → hidden from warn3');
select public.tick_set_status(current_setting('zx.day')::date,'C004','未叫貨',(select revision from public.daily_order_status where customer_code='C004' and service_date=current_setting('zx.day')::date),gen_random_uuid(),'right_click');
select pg_temp.assert(exists (select 1 from public.v_tick_warn3 where customer_code='C004' and source='auto'), 'C004 missed 3 closed days → auto warn3');
select pg_temp.assert(not exists (select 1 from public.v_tick_warn3 where customer_code='C001'), 'C001 ordered on 10/15,10/17 → not warn3');

-- 14. 重置：兩台同時按，只有一台成功；新的一天全部視為未叫貨
select set_config('zx.reset', public.tick_reset_day(current_setting('zx.day')::date, current_setting('zx.day')::date + 1, gen_random_uuid())::text, false);
select pg_temp.assert((current_setting('zx.reset')::jsonb->>'ok')::boolean, 'reset day ok');
select pg_temp.assert((public.tick_reset_day(current_setting('zx.day')::date, null, gen_random_uuid()))->>'reason' = 'conflict', 'second device reset with stale day → conflict');
select pg_temp.assert((select count(*) from public.daily_order_status where service_date = current_setting('zx.day')::date + 1) = 0, 'new day has 0 rows (= all 未叫貨), no bulk write');
reset role;

-- 15. 打勾單客戶維護：新增配發 TK 代號、名稱重複擋下、群組排序只發一則事件
set role authenticated; select set_config('request.jwt.claim.sub','00000000-0000-0000-0000-00000000000b',false);
select pg_temp.assert((public.tick_save_customer(null,'新開店','阿明'))->>'code' = 'TK0002', 'new tick customer → TK0002');
select pg_temp.assert((public.tick_save_customer(null,'新開店','阿明'))->>'reason' = 'duplicate', 'duplicate name rejected');
select pg_temp.assert((public.tick_save_customer(null,'壽司郎中山','阿華'))->>'reason' = 'duplicate', 'existing listed name rejected');
select set_config('zx.cur5', (public.sync_changes(null))->>'cursor', false);
select public.tick_save_group_order('阿明', array['C001','TK0001','TK0002']);
select pg_temp.assert(jsonb_array_length((public.sync_changes(current_setting('zx.cur5')))->'changes') = 1, 'group reorder emits 1 change');
select pg_temp.assert((select count(*) from public.tick_daily_counts('2026-10-01','2026-12-31')) >= 5, 'daily counts returns service days');
select pg_temp.assert((select streak from public.v_tick_streak where customer_code='C004') >= 3, 'C004 streak ≥ 3');
do $$ begin perform public.tick_delete_day('2026-10-14'); raise exception 'should fail'; exception when insufficient_privilege then raise notice 'PASS: staff cannot delete a history day'; end $$;
select pg_temp.assert((public.set_my_profile('小美','kitty.png'))->>'icon' = 'kitty.png', 'set_my_profile works');
reset role;

-- 16. 儀表板彙總：一次回傳打勾單／異常表／報價的小計，系列規則與打勾單一致；viewer 可讀、anon 不可呼叫
set role authenticated; select set_config('request.jwt.claim.sub','00000000-0000-0000-0000-00000000000b',false);
select set_config('zx.dash', public.dashboard_summary(30)::text, false);
select pg_temp.assert((current_setting('zx.dash')::jsonb->'tick'->>'total')::int = (select count(*) from public.tick_customers where is_listed), 'dashboard tick total = listed customers');
select pg_temp.assert((current_setting('zx.dash')::jsonb->>'service_date') = (select service_date::text from public.tick_service_days where status='open'), 'dashboard uses open service day');
select pg_temp.assert(jsonb_array_length(current_setting('zx.dash')::jsonb->'series') = 5, 'dashboard returns 5 series');
select pg_temp.assert((select (e->>'total')::int from jsonb_array_elements(current_setting('zx.dash')::jsonb->'series') e where e->>'name'='壽司郎') = 0, 'series exclude_prefix honoured (壽司郎中山 excluded, same as tick page)');
select pg_temp.assert((current_setting('zx.dash')::jsonb->'quote'->>'total')::int = (select count(*) from public.customer_quote_profiles), 'dashboard quote stage counts cover all profiles');
select pg_temp.assert(length(current_setting('zx.dash')) < 8000, 'dashboard payload < 8 KB');
reset role;
do $$ begin
  set local role anon;
  perform public.dashboard_summary(30); raise exception 'should fail';
exception when insufficient_privilege then raise notice 'PASS: anon cannot call dashboard_summary'; end $$;

-- 17. 免帳號（暱稱）使用：匿名裝置輸入暱稱 → staff 成員，記錄 IP；管理員可查看與停用
insert into auth.users(id) values ('00000000-0000-0000-0000-0000000000f1') on conflict do nothing;
set role authenticated; select set_config('request.jwt.claim.sub','00000000-0000-0000-0000-0000000000f1',false);
select set_config('request.headers', '{"x-forwarded-for":"203.0.113.7, 10.0.0.1","user-agent":"TestUA"}', false);
select pg_temp.assert(not private.is_member(), 'anonymous device is not a member before nickname');
select pg_temp.assert((public.device_register('小陳'))->>'role' = 'staff', 'nickname registers device as staff');
select pg_temp.assert(private.can_write() and not private.can_delete(), 'nickname device can write, cannot delete');
select set_config('request.headers', '{"x-forwarded-for":"198.51.100.9"}', false);
select public.device_touch();
do $$ begin perform public.admin_list_devices(); raise exception 'should fail'; exception when insufficient_privilege then raise notice 'PASS: staff cannot list devices'; end $$;
select set_config('request.jwt.claim.sub','00000000-0000-0000-0000-00000000000a',false);
select set_config('zx.dev', (select e::text from jsonb_array_elements(public.admin_list_devices()) e where e->>'user_id' = '00000000-0000-0000-0000-0000000000f1'), false);
select pg_temp.assert(current_setting('zx.dev')::jsonb->>'last_ip' = '198.51.100.9' and current_setting('zx.dev')::jsonb->>'first_ip' = '203.0.113.7', 'admin sees first and last IP (x-forwarded-for first hop)');
select pg_temp.assert(jsonb_array_length(current_setting('zx.dev')::jsonb->'ips') = 2, 'IP history keeps both addresses');
select pg_temp.assert((public.admin_set_device('00000000-0000-0000-0000-0000000000f1', false))->>'ok' = 'true', 'admin blocks device');
select pg_temp.assert((public.admin_set_device('00000000-0000-0000-0000-00000000000a', false))->>'reason' = 'self', 'admin cannot block self');
select pg_temp.assert((select count(*) from public.app_settings where key = 'nickname_access') = 1, 'admin can read settings');
update public.app_settings set value = 'false' where key = 'nickname_access';
select set_config('request.jwt.claim.sub','00000000-0000-0000-0000-0000000000f1',false);
select pg_temp.assert(not private.is_member() and (public.device_register('小陳'))->>'reason' = 'blocked', 'blocked device cannot re-register');
reset role; insert into auth.users(id) values ('00000000-0000-0000-0000-0000000000f2') on conflict do nothing;
set role authenticated; select set_config('request.jwt.claim.sub','00000000-0000-0000-0000-0000000000f2',false);
select pg_temp.assert((public.device_register('新人'))->>'reason' = 'disabled', 'nickname access off → new devices refused');
reset role;
update public.app_settings set value = 'true' where key = 'nickname_access';

-- 18. 異常分析與經營月報
insert into public.abnormal_reports (report_date, store, car_no, category, exchange_type, responsibility, reason) values
  ('2026-10-10', '全聯中正店', 'ABC-1', 'A 品質', '退貨', '倉儲', 'x'),
  ('2026-10-11', '全聯中正店', 'ABC-1', 'A 品質', '換貨', ' 倉儲 ', 'y'),
  ('2026-10-12', '神秘店', null, 'D 漏單', '補貨', null, 'z');
set role authenticated; select set_config('request.jwt.claim.sub','00000000-0000-0000-0000-00000000000b',false);
select set_config('zx.ra', public.report_analysis('2000-01-01', '2100-12-31')::text, false);
select pg_temp.assert((current_setting('zx.ra')::jsonb->>'total')::int = (select count(*) from public.abnormal_reports where report_date is not null), 'report_analysis total = dated abnormal rows');
select pg_temp.assert((select coalesce(sum((e->>'n')::int), 0) from jsonb_array_elements(current_setting('zx.ra')::jsonb->'by_category') e) = (current_setting('zx.ra')::jsonb->>'total')::int, 'category shares add up to total');
select pg_temp.assert((select coalesce(sum((e->>'n')::int), 0) from jsonb_array_elements(current_setting('zx.ra')::jsonb->'by_responsibility') e) = (current_setting('zx.ra')::jsonb->>'total')::int, 'responsibility shares add up to total (top 7 + 其他)');
select set_config('zx.ra10', public.report_analysis('2026-10-10', '2026-10-12')::text, false);
select pg_temp.assert((current_setting('zx.ra10')::jsonb->>'total')::int = 3
  and (select (e->>'n')::int from jsonb_array_elements(current_setting('zx.ra10')::jsonb->'by_category') e where e->>'k' = 'A 品質') = 2, 'category breakdown: A 品質 2 of 3');
select pg_temp.assert((select (e->>'n')::int from jsonb_array_elements(current_setting('zx.ra10')::jsonb->'by_responsibility') e where e->>'k' = '倉儲') = 2
  and (select (e->>'n')::int from jsonb_array_elements(current_setting('zx.ra10')::jsonb->'by_responsibility') e where e->>'k' = '未填') = 1, 'responsibility trimmed and blank → 未填');
select pg_temp.assert((current_setting('zx.ra10')::jsonb->'top_stores'->0->>'store') = '全聯中正店' and (current_setting('zx.ra10')::jsonb->'top_stores'->0->>'top_category') = 'A 品質', 'top store with its main category');
select set_config('zx.boss', public.boss_report('2026-10-01', '2026-10-31')::text, false);
select pg_temp.assert((current_setting('zx.boss')::jsonb->'tick'->>'service_days')::int = (select count(*) from public.tick_service_days where status='closed' and service_date between '2026-10-01' and '2026-10-31'), 'boss_report counts closed service days');
select pg_temp.assert(jsonb_typeof(current_setting('zx.boss')::jsonb->'tick'->'low_customers') = 'array' and length(current_setting('zx.boss')) < 20000, 'boss_report returns low-order customers, payload < 20 KB');
reset role;
do $$ begin
  set local role anon;
  perform public.boss_report('2026-10-01', '2026-10-31'); raise exception 'should fail';
exception when insufficient_privilege then raise notice 'PASS: anon cannot call boss_report'; end $$;

-- 19. Data API 授權（Supabase 2026-10-30 起不再自動授權 public 新資料表）：authenticated 全部有權限、anon 沒有
select pg_temp.assert(not exists (select 1 from pg_class c join pg_namespace n on n.oid = c.relnamespace
  where n.nspname = 'public' and c.relkind in ('r','p','v') and not has_table_privilege('authenticated', c.oid, 'select')), 'every public table/view granted to authenticated (15_api_grants)');
select pg_temp.assert(not exists (select 1 from pg_class c join pg_namespace n on n.oid = c.relnamespace
  where n.nspname = 'public' and c.relkind in ('r','p') and not c.relrowsecurity), 'every granted table has RLS enabled');
