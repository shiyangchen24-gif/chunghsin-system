-- 僅供本機測試：模擬 tools/migrate.html 從三個舊專案搬進新專案暫存區的結果（假資料，結構依舊程式碼）
-- 打勾單：舊 zhongxin_store → "Chunghsin_store"（舊程式 JSON.stringify 後寫入 → jsonb 內是字串）
insert into public."Chunghsin_store"(key, value) values
 ('zhongxin_v4', to_jsonb('{"全聯中正店":{"status":"有叫貨","date":"ordered","fixed":"阿明"},"美廉社A":{"status":"今日不叫貨","date":"ordered","fixed":"阿華"},"神秘店":{"status":"有叫貨","date":"ordered","fixed":"阿明"},"壽司郎中山":{"status":"未叫貨","date":"","fixed":"阿華"}}'::text)),
 ('zhongxin_hist_v4', to_jsonb('[{"date":"2026/10/14","records":{"全聯中正店":"有叫貨","壽司郎中山":"未叫貨"},"editLog":{}},{"date":"2026/10/15","records":{"全聯中正店":"有叫貨","壽司郎中山":"未叫貨"},"editLog":{"全聯中正店":[{"time":"08:12","status":"有叫貨","user":"小美","icon":"kitty.png"}]}},{"date":"2026/10/16","records":{"壽司郎中山":"未叫貨"},"editLog":{},"clearedAt":1792130000000},{"date":"2026/10/17","records":{"全聯中正店":"有叫貨"},"editLog":{}}]'::text)),
 ('zhongxin_order_v1', to_jsonb('{"阿明":["神秘店","全聯中正店"],"阿華":["美廉社A","壽司郎中山"]}'::text)),
 ('zhongxin_notices_v1', to_jsonb('[{"id":"mabc123","author":"小美","text":"週日公休","time":"10/10 08:00"}]'::text)),
 ('zhongxin_manual_v1', to_jsonb('{"2026/10/01":{"ord":300,"un":20,"no":5}}'::text)),
 ('zhongxin_warn3_v1', to_jsonb('["美廉社A"]'::text)),
 ('zhongxin_ts_v1', to_jsonb('1792200000000'::text));

-- 報價：舊 customers 整列 → legacy_quote_customers
insert into public.legacy_quote_customers(code, row) values
 ('C001', '{"code":"C001","name":"全聯中正店","quote_cycle":"7天","trade_status":"核准交易","product_code_mode":"有貨號","export_status":"未匯出",
            "mapping":{"dataStartRowIdx":3,"columnMap":{"0":"貨號","1":"單價"}},"last_item_codes":["A1","A2"],
            "saved_records":[{"貨號":"A1","品名":"高麗菜","單位":"箱","單價":"35","不報價原因":"","怪欄位":"保留我","_isNew":false},
                             {"貨號":"A2","品名":"青蔥","單價":"時價","_isNew":true}],
            "quoted_prices":null,"item_code_lookup":[],"notes":"","unit_category":""}'),
 ('C002', '{"code":"C002","name":"美廉社A","quote_cycle":"15天","product_code_mode":"無貨號","export_status":"已匯出","last_export_time":"2026-10-10T02:00:00+00:00",
            "mapping":{"dataStartRowIdx":1,"columnMap":{"0":"品名","1":"單價"}},
            "quoted_prices":{"matched":[{"code":"Z100","price":30,"isNew":false}],"unmatched":[{"name":"奇異果","unit":"顆","price":12}]},
            "item_code_lookup":[{"name":"高麗菜","code":"Z100","itemName":"高麗菜"}],"unit_category":"kg","notes":"月結"}'),
 ('C003', '{"code":"C003","name":"美廉社A","product_code_mode":"有貨號","notes":"同名不同店"}'),
 ('C004', '{"code":"C004","name":"壽司郎中山","product_code_mode":"有貨號"}');

insert into public.master_items(item_code, item_name, unit, spec_code, grade) values
 ('Z100','高麗菜','kg','S1','A'),('Z200','青蔥','台斤',null,'B');

-- 異常／交接：舊表原樣搬入（保留 id、created_at；新欄位由相容觸發器自動補）
insert into public.abnormal_reports(id, date, car_no, store, reason, exchange_type, category, created_at) values
 ('a0000000-0000-0000-0000-000000000001','2026-10-17','ABC-123','全聯中正店','10/17 高麗菜 2箱 爛','退貨','A 品質','2026-10-17T01:00:00Z'),
 ('a0000000-0000-0000-0000-000000000002','10/16','XYZ-9','美廉社A','漏送','補貨','D 漏單','2026-10-16T01:00:00Z'),
 ('a0000000-0000-0000-0000-000000000003','2026/10/15','ABC-123','路人店','x','反應','B 送貨延遲(送錯貨)','2026-10-15T01:00:00Z');
insert into public.handover_reports(id, date, store, content, created_at) values
 ('b0000000-0000-0000-0000-000000000001','2026-10-17','全聯中正店 ABC-123','明天提早送','2026-10-17T02:00:00Z');
