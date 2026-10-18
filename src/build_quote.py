#!/usr/bin/env python3
"""由原版 original/quote/{index.html,app.js} 組出新版 quote/。

原則：上傳精靈、橫向多組拆展、隱藏列排除、數字清洗、新品／未對應標示、單位衝突擋下、
有貨號 13 欄與無貨號多客戶格式的 Excel 匯出等程式「原封不動」；只替換資料存取函式
（大型 JSONB → 獨立表 + RPC）、Realtime（全表重抓 + 60 秒輪詢 → 小事件局部更新）、登入，
並在 index.html 以 @media screen 套上黏土外觀。
"""
import pathlib
import re
import sys

ROOT = pathlib.Path(__file__).resolve().parent.parent
SRC = ROOT / 'original' / 'quote'
OUT = ROOT / 'quote'
HERE = ROOT / 'src' / 'quote'
FRONTEND_VERSION = '2026-10-18-zx-v1'
SUPABASE_JS = 'https://cdn.jsdelivr.net/npm/@supabase/supabase-js@2.45.4/dist/umd/supabase.js'


def must_replace(s, old, new, count=1):
    n = s.count(old)
    if n != count:
        sys.exit(f'build_quote: expected {count} occurrence(s) of {old[:70]!r}, found {n}')
    return s.replace(old, new)


def function_span(s, signature):
    """找出以 signature 開頭的頂層函式完整範圍（以大括號配對，略過字串、樣板字串與註解）。"""
    start = s.find(signature)
    if start < 0 or s.find(signature, start + 1) >= 0:
        sys.exit(f'build_quote: signature {signature!r} not found exactly once')
    i = s.index('{', start)
    depth, n = 0, len(s)
    while i < n:
        c = s[i]
        if c in '"\'`':
            q = c
            i += 1
            while i < n and s[i] != q:
                if s[i] == '\\':
                    i += 1
                elif q == '`' and s.startswith('${', i):
                    # 樣板字串內的 ${...}：用遞迴深度粗略跳過
                    d = 1
                    i += 2
                    while i < n and d:
                        d += {'{': 1, '}': -1}.get(s[i], 0)
                        i += 1
                    continue
                i += 1
        elif s.startswith('//', i):
            i = s.index('\n', i)
        elif s.startswith('/*', i):
            i = s.index('*/', i) + 1
        elif c == '{':
            depth += 1
        elif c == '}':
            depth -= 1
            if depth == 0:
                return start, i + 1
        i += 1
    sys.exit(f'build_quote: unbalanced braces in {signature!r}')


def remove_function(s, signature):
    a, b = function_span(s, signature)
    return s[:a] + f'/* {signature.strip()} … → 新版實作見「新版資料層」 */' + s[b:]


def build_app():
    js = (SRC / 'app.js').read_text(encoding='utf-8')

    # 1) 連線設定：改由 zx-auth.js 登入後建立（新專案 URL／anon key 在 shared/zx-config.js）
    head_end = js.index('function assertSb() {')
    _, b = function_span(js, 'function assertSb() {')
    js = ('/* ===================== 報價單匯出系統 - 前端邏輯（三站整合版） ===================== */\n'
          '// Supabase 連線由 ../shared/zx-auth.js 在登入後建立（全域 sb）；URL 與 anon key 集中在 ../shared/zx-config.js。\n'
          '// service_role／secret key 絕對不可放在前端。\n'
          f"const FRONTEND_VERSION = '{FRONTEND_VERSION}';\n"
          "let sb = null;\nlet sbInitError = '';\nlet ZXC = null;\n\n"
          "function assertSb() {\n  if (!sb) throw new Error(sbInitError || '尚未登入，請重新整理頁面');\n}"
          + js[b:])

    # 2) 客戶清單欄位：不再讀 mapping 等大型欄位；mapping 只保留「有沒有設定」，要用時才讀
    js = re.sub(r"const CUSTOMER_SELECT_COLS = '[^']*';",
                "const CUSTOMER_SELECT_COLS = 'code,name,quote_cycle,trade_status,export_status,last_export_time,"
                "last_export_filename,has_mapping,product_code_mode,last_export_item_count,item_code_lookup_count,"
                "quoted_prices_count,last_quote_upload_time,saved_records_count,notes,unit_category,quote_file_location,"
                "detail_version,revision';", js, count=1)
    js = must_replace(js, "    mapping: row.mapping || null,",
                      "    mapping: row.has_mapping ? ((mappingCache.get(row.code) || {}).version === row.detail_version\n"
                      "      ? mappingCache.get(row.code).mapping : MAPPING_PENDING) : null,\n"
                      "    hasMapping: !!row.has_mapping,\n"
                      "    detailVersion: row.detail_version || 0,\n"
                      "    revision: row.revision,")
    js = must_replace(js, "const data = await fetchAllRows('customers', CUSTOMER_SELECT_COLS, 'code');",
                      "const data = await fetchAllRows('v_quote_customer_list', CUSTOMER_SELECT_COLS, 'code');")

    # 3) 移除原版資料存取函式（新版同名實作放在 data.js，函式簽名與回傳格式不變）
    for sig in ['function setupRealtime() {', 'async function fetchPreviousCodes(code) {',
                'async function fetchItemCodeLookup(code) {', 'async function saveItemCodeLookup(code, lookupArray) {',
                'async function fetchQuotedPrices(code) {', 'async function saveQuotedPrices(customer, records) {',
                'async function fetchSavedRecords(code) {', 'async function saveHasCodeRecords(customer, records) {',
                'async function loadMasterItems() {', 'async function saveMasterItems(rows) {',
                'async function unexportCustomer(customer) {', 'async function reconfigureMapping(customer) {',
                'async function deleteCustomerSingle(customer) {', 'async function saveCustomerToBackend(payload) {',
                'async function saveMappingForCustomer() {']:
        js = remove_function(js, sig)
    js = must_replace(js, 'let realtimeChannel = null;\n', '')

    # 4) 事件處理器裡的直接寫入 → RPC
    js = must_replace(js, """    const { error } = await sb.from('customers').delete().in('code', codes);
    if (error) throw new Error(error.message);""", """    if (!ZXC.can.delete) throw new Error('刪除客戶只限管理員');
    const { error } = await sb.rpc('quote_delete_customers', { p_codes: codes });
    if (error) throw new Error(error.message);""")

    js = must_replace(js, """  setLoading(true, '準備匯出元件…');
  try {
    await ensureExcelJS();""", """  // 讀取暫存品項前先記下每位客戶的版本：匯出期間若有人重新上傳，該客戶不會被誤標為已匯出
  const revAtRead = new Map(ready.map(c => [c.code, c.revision]));
  setLoading(true, '準備匯出元件…');
  try {
    await ensureExcelJS();""")
    js = must_replace(js, """    const nowIso = new Date().toISOString();
    const readyCodes = ready.map(c => c.code);
    const { data, error } = await sb.from('customers').update({
      export_status: '已匯出', last_export_time: nowIso, last_export_filename: outName, updated_at: nowIso
    }).in('code', readyCodes).select(CUSTOMER_SELECT_COLS);
    if (error) throw new Error(error.message);
    (data || []).forEach(row => upsertCustomer(rowToCustomer(row)));""", """    const { data, error } = await sb.rpc('quote_mark_exported', {
      p_filename: outName,
      p_items: ready.map(c => ({ customer_code: c.code, item_count: c[countField] || 0, expected_revision: revAtRead.get(c.code) })),
      p_request_id: zxSync.uuid()
    });
    if (error) throw new Error(error.message);
    (data.rows || []).forEach(row => upsertCustomer(rowToCustomer(row)));
    if (data.conflicts && data.conflicts.length) {
      toast('err', `檔案已存好，但 ${data.conflicts.join('、')} 在匯出期間被其他裝置更新，未標記為已匯出，請確認後重新匯出`);
    }""")

    js = must_replace(js, """    const { data, error } = await sb.from('customers').update(patch).in('code', codes)
      .select(CUSTOMER_SELECT_COLS);""", """    const { data, error } = await sb.rpc('quote_patch_profiles', { p_codes: codes, p_patch: patch });""")

    js = must_replace(js, """    const { data, error } = await sb.from('customers').update({
      export_status: '未匯出', last_export_time: null, last_export_filename: '', updated_at: new Date().toISOString()
    }).not('code', 'is', null).select();""", """    const { data, error } = await sb.rpc('quote_patch_profiles', {
      p_codes: null, p_patch: { export_status: '未匯出', last_export_time: null, last_export_filename: '' }
    });""")

    js = must_replace(js, """      const { data, error } = await sb.from('customers').upsert(payload, { onConflict: 'code' }).select(CUSTOMER_SELECT_COLS);""",
                      """      const { data, error } = await sb.rpc('quote_upsert_customers', { p_rows: payload, p_request_id: zxSync.uuid() });""")

    # 5) 套用範本前才讀完整欄位對應
    js = must_replace(js, """    const customer = state.wizard.customer;
    if (customer.mapping && customer.mapping.columnMap""", """    const customer = await ensureMapping(state.wizard.customer);
    if (customer.mapping && customer.mapping.columnMap""")
    js = must_replace(js, """        const records = buildConvertedRecords(rows, job.customer.mapping.dataStartRowIdx""",
                      """        await ensureMapping(job.customer);
        if (!job.customer.mapping) throw new Error('這個客戶的欄位對應範本已被清除，請重新設定');
        const records = buildConvertedRecords(rows, job.customer.mapping.dataStartRowIdx""")

    # 5b) 修正原版 bug：SheetJS 0.18.5 只有在 cellStyles: true 時才會解析 !rows（含 hidden），
    #     原版沒帶這個選項，所以「自動排除隱藏列」其實從未生效
    js = must_replace(js, "const wb = XLSX.read(data, { type: 'array', cellDates: false });",
                      "const wb = XLSX.read(data, { type: 'array', cellDates: false, cellStyles: true });")

    # 6) 啟動：登入 → 載入清單 → 訂閱（取代原本的全表 Realtime + 60 秒輪詢）
    a = js.index('if (!sb) {\n  toast(\'err\', sbInitError')
    js = js[:a] + """ZX.boot({
  site: 'quote',
  title: '報價單匯出系統',
  logo: '../shared/logo.svg',
  onReady: async ctx => {
    sb = ctx.sb;
    ZXC = ctx;
    document.documentElement.classList.toggle('zx-readonly', !ctx.can.write);
    const syncer = setupRealtime();
    await syncer.start(() => loadCustomers(true));
  }
});
"""

    data_js = (HERE / 'data.js').read_text(encoding='utf-8')
    marker = '/* ---------------- 共用 UI 工具 ---------------- */'
    js = must_replace(js, marker, data_js + '\n' + marker)
    return js


def build_index():
    html = (SRC / 'index.html').read_text(encoding='utf-8')
    html = re.sub(r'<link href="https://fonts\.googleapis\.com/css2\?family=Inter[^"]*" rel="stylesheet">',
                  lambda m: ('<link href="https://fonts.googleapis.com/css2?family=Inter:wght@400;500;600;700&family=Noto+Sans+TC:wght@400;500;700&family=JetBrains+Mono:wght@500;600&display=swap" rel="stylesheet">\n'
                             '<link rel="stylesheet" href="../shared/theme.css">'), html, count=1)
    html = must_replace(html, '<script src="https://cdn.jsdelivr.net/npm/@supabase/supabase-js@2/dist/umd/supabase.js"></script>',
                        f'<script src="{SUPABASE_JS}"></script>')
    html = must_replace(html, '</style>', (HERE / 'skin.css').read_text(encoding='utf-8') + '</style>')
    html = must_replace(html, '''    <div class="topbar-actions">
      <button class="btn btn-ghost" id="btnResetAll">重置本期匯出狀態</button>''', '''    <div class="topbar-actions">
      <span id="zx-sync-badge" class="sync-badge" data-state="pending" role="status" aria-live="polite">連線中…</span>
      <span id="zx-user-chip"></span>
      <button class="btn btn-ghost" id="btnResetAll">重置本期匯出狀態</button>''')
    html = re.sub(r'<div class="glyph">\s*<img src="data:image/png;base64,[^"]+" width="24" height="24" alt="" style="display:block;">\s*</div>',
                  '<div class="glyph"><img src="../shared/logo.svg" width="40" height="40" alt="忠欣蔬果 LOGO" style="display:block;"></div>',
                  html, count=1)
    html = must_replace(html, '<script src="app.js?v=2026-09-25-supabase-v22"></script>',
                        '<script src="../shared/zx-nav.js?v=' + FRONTEND_VERSION + '" data-site="quote" data-root="../"></script>\n'
                        '<script src="../shared/zx-config.js?v=' + FRONTEND_VERSION + '"></script>\n'
                        '<script src="../shared/zx-sync.js?v=' + FRONTEND_VERSION + '"></script>\n'
                        '<script src="../shared/zx-auth.js?v=' + FRONTEND_VERSION + '"></script>\n'
                        '<script src="app.js?v=' + FRONTEND_VERSION + '"></script>')
    return html


def main():
    OUT.mkdir(parents=True, exist_ok=True)
    (OUT / 'app.js').write_text(build_app(), encoding='utf-8')
    (OUT / 'index.html').write_text(build_index(), encoding='utf-8')
    for f in ('app.js', 'index.html'):
        print(f'wrote quote/{f} ({(OUT / f).stat().st_size:,} bytes)')


if __name__ == '__main__':
    main()
