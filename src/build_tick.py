#!/usr/bin/env python3
"""由原版 original/tick/index.html（= GitHub nitaaa1119-ai/Chun-Shin-Ltd.）組出新版 tick/index.html。

原則：卡片、統計、系列條、拖曳排序、後台表、列印預覽（匯入 Excel、格式控制、匯出 Excel）、趨勢圖
等畫面程式維持原版；移除 key-value 大 JSON 的讀寫與 30 秒全量輪詢，換成新版資料層（src/tick/controller.js），
並以 @media screen 套上黏土外觀。
"""
import pathlib
import re
import shutil
import sys

sys.path.insert(0, str(pathlib.Path(__file__).resolve().parent))
from build_quote import must_replace, function_span  # noqa: E402

ROOT = pathlib.Path(__file__).resolve().parent.parent
SRC = ROOT / 'original' / 'tick'
ICONS = pathlib.Path('/home/user/nitaaa1119-ai/chun-shin-ltd.')
OUT = ROOT / 'tick'
HERE = ROOT / 'src' / 'tick'
SUPABASE_JS = 'https://cdn.jsdelivr.net/npm/@supabase/supabase-js@2.45.4/dist/umd/supabase.js'
VERSION = '2026-10-18-zx-v1'


def remove_function(s, signature):
    a, b = function_span(s, signature)
    return s[:a] + f'/* {signature.strip()} … → 新版實作見 controller */' + s[b:]


def remove_const_literal(s, start_text):
    """移除 const X = [...] / {...}; 這種多行字面值宣告。"""
    a = s.find(start_text)
    if a < 0 or s.find(start_text, a + 1) >= 0:
        sys.exit(f'build_tick: {start_text!r} not found exactly once')
    i = a + len(start_text) - 1
    open_c = s[i]
    close_c = {'[': ']', '{': '}'}[open_c]
    depth = 0
    while True:
        if s[i] == open_c:
            depth += 1
        elif s[i] == close_c:
            depth -= 1
            if depth == 0:
                break
        i += 1
    end = s.index(';', i) + 1
    return s[:a] + f'/* {start_text.strip()} … → 改由資料庫 order_groups(kind=series) 提供 */' + s[end:]


SERIES_MODAL = '''
<!-- 系列設定 Modal（新版：系列存在資料庫，可自行新增、自訂店家） -->
<div class="overlay" id="series-overlay" onclick="if(event.target===this)closeSeriesModal()">
  <div class="modal" style="max-width:560px;">
    <div class="modal-title">⚙ 系列統計設定</div>
    <ul class="series-admin-list" id="series-admin-list"></ul>
    <div class="modal-title" style="font-size:14px;" id="series-form-title">新增系列</div>
    <div class="field"><label for="series-name">系列名稱 *</label><input id="series-name" placeholder="例如：壽司郎"></div>
    <div class="field"><label for="series-prefix">店名開頭（多個用「、」分隔）</label><input id="series-prefix" placeholder="例如：壽司、Sushi"></div>
    <div class="field"><label for="series-exclude">排除的開頭</label><input id="series-exclude" placeholder="例如：壽司郎"></div>
    <div class="field"><label for="series-extra">另外加入的店家（完整店名）</label><input id="series-extra" list="series-store-list" placeholder="例如：燒丼統領、蛋包林口"></div>
    <datalist id="series-store-list"></datalist>
    <div class="modal-actions">
      <button class="btn btn-ghost modal-actions-left" onclick="editSeries(null)">清空表單</button>
      <button class="btn btn-ghost" onclick="closeSeriesModal()">關閉</button>
      <button class="btn btn-primary" onclick="saveSeries()">儲存系列</button>
    </div>
  </div>
</div>
'''

WRAPPERS = r'''
// ── 原版函式的薄包裝 ─────────────────────────────────────
// 趨勢分析：先讀該月每日筆數（約 2 KB），再用原版程式畫圖
const _origRenderAnalytics = renderAnalytics;
renderAnalytics = async function () { await ensureMonthCounts(analyticsYear, analyticsMonth); _origRenderAnalytics(); };
// 後台管理：切過去時才讀今日完整操作紀錄與連續未叫天數
const _origSwitchTab = switchTab;
switchTab = async function (id, btn) {
  _origSwitchTab(id, btn);
  if (id === 'backend' && sb) {
    try { await Promise.all([todayLogFull ? null : loadTodayEvents(), loadStreaks()]); renderTable(); }
    catch (e) { toast('⚠ 後台資料讀取失敗：' + e.message, true); }
  }
};
// 使用者暱稱：同步更新右上角登入資訊
const _origUpdateUserTag = updateUserTag;
updateUserTag = function () {
  _origUpdateUserTag();
  const chip = document.getElementById('zx-user-chip');
  if (!chip) return;
  const name = chip.querySelector('span');
  if (name) { name.textContent = currentUser.name || '設定暱稱'; name.title = '點擊設定暱稱與圖示'; name.onclick = openUserModal; }
  const img = chip.querySelector('img');
  if (img && currentUser.icon) img.src = ZX.iconUrl(currentUser.icon);
};
// 系列設定的店家清單
const _origOpenSeriesModal = openSeriesModal;
openSeriesModal = function () {
  document.getElementById('series-store-list').innerHTML = Object.keys(db).sort().map(n => `<option value="${esc(n)}">`).join('');
  _origOpenSeriesModal();
};
'''


def main():
    html = (SRC / 'index.html').read_text(encoding='utf-8')

    # ---- head ----
    html = must_replace(html, '<script src="https://cdn.jsdelivr.net/npm/@supabase/supabase-js@2"></script>',
                        f'<script src="{SUPABASE_JS}"></script>\n'
                        '<link href="https://fonts.googleapis.com/css2?family=Inter:wght@400;500;600;700&family=Noto+Sans+TC:wght@400;500;700&family=JetBrains+Mono:wght@500;600&display=swap" rel="stylesheet">\n'
                        '<link rel="stylesheet" href="../shared/theme.css">')
    first_style_end = html.index('</style>')
    html = html[:first_style_end] + (HERE / 'skin.css').read_text(encoding='utf-8') + html[first_style_end:]

    # ---- body ----
    # 頁首原本的「打勾單／異常表交接表」分頁標籤 → 改由三站共用側邊欄切換
    html, n = re.subn(r'  <!-- 分頁標籤列 -->.*?(?=  <!-- ★ 同步狀態)', '', html, count=1, flags=re.S)
    if n != 1:
        sys.exit('build_tick: header tab block not found')
    html = must_replace(html, '''  <div class="user-tag" id="user-tag" onclick="openUserModal()" title="點擊設定暱稱">
    <div class="user-tag-avatar" id="user-avatar">?</div>
    <span class="user-tag-name" id="user-tag-name">設定暱稱</span>
  </div>''', '''  <div class="zx-top-right">
    <span id="zx-sync-badge" class="sync-badge" data-state="pending" role="status" aria-live="polite">連線中…</span>
    <span id="zx-user-chip"></span>
  </div>''')
    html = must_replace(html, '<div class="series-strip-wrap no-print"><div class="series-strip" id="series-strip"></div></div>',
                        '<div class="series-strip-wrap no-print"><div class="series-strip" id="series-strip"></div>'
                        '<button type="button" class="btn btn-ghost btn-sm series-admin-btn" onclick="openSeriesModal()">⚙ 系列設定</button></div>')

    script_start = html.index('<script>\n// ══════════════════════════════════════════════════════════\n//  CLOUD SYNC')
    html = html[:script_start] + SERIES_MODAL + html[script_start:]
    script_start = html.index('<script>\n// ══════════════════════════════════════════════════════════\n//  CLOUD SYNC')
    script_end = html.rindex('</script>')
    page, js, tail = html[:script_start + len('<script>\n')], html[script_start + len('<script>\n'):script_end], html[script_end:]

    # ---- script：移除 key-value 同步與推送 ----
    js = re.sub(r"^const SUPABASE_URL = .*\n", '', js, count=1, flags=re.M)
    js = re.sub(r"^const SUPABASE_KEY = .*\n", '', js, count=1, flags=re.M)
    js = re.sub(r"^const _sb .*\n", '', js, count=1, flags=re.M)
    js = re.sub(r"^const SB_TABLE .*\n", '', js, count=1, flags=re.M)
    js = re.sub(r"^const ALLOWED_KEYS = \[.*\n.*\n", '', js, count=1, flags=re.M)
    for name in ('_syncInterval', '_isSyncing', '_localLockUntil', '_firstLoad'):
        js = re.sub(rf"^let {name}\b.*\n", '', js, count=1, flags=re.M)

    for sig in ['function lockLocal(ms) {', 'function unlockLocal() {', 'function touchTs() {',
                'async function _pushOne(key, value) {', 'async function _pushUpdateClient(name, status, date) {',
                'async function syncFromCloud() {', 'function save(fromInit = false) {', 'function saveHistory() {',
                'function saveOrder() {', 'function saveNotices() {', 'function pushInBackground(...pushFns) {',
                'function saveManualData() {', 'function saveManualWarn3() {', 'function clearAllHistory() {',
                'function hasResetToday() {', 'function init() {', 'function toggleManualWarn3(n) {',
                'function toggle(n) {', 'function rightClick(e, n) {', 'function changeStatus(n, s) {',
                'function confirmDeleteHistory(n) {', 'function saveClient() {', 'function deleteClient() {',
                'function resetAll() {', 'function updateAllDates() {', 'function saveUserName() {',
                'function deleteAnalyticsDay(dateStr) {', 'function getSeriesMembers(key) {']:
        js = remove_function(js, sig)
    js = remove_const_literal(js, 'const SERIES_LIST = [')
    js = remove_const_literal(js, 'const SERIES_EXTRA = {')

    boot = "window.addEventListener('load', () => {"
    a, b = function_span(js, boot)
    js = js[:a] + '/* 原 BOOT（syncFromCloud + Postgres Changes 全表重抓 + 30 秒輪詢）→ 新版見 controller */' + js[b + 2:]

    js = must_replace(js, 'const today   = new Date();', 'let today   = new Date();')
    js = must_replace(js, "const todayStr = today.getFullYear() + '/' +", "let todayStr = today.getFullYear() + '/' +")

    # 後台表「連續未叫」改用伺服器算好的天數（原版只保留 6 天歷史可算）
    js = must_replace(js, '''    let streak = 0;
    for (let i = sortedHist.length-1; i >= 0; i--) {
      const s = sortedHist[i].records && sortedHist[i].records[n];
      if (!s || s === '未叫貨') streak++; else break;
    }''', '''    let streak = tickStreak.get(n) || 0;''')

    # 修正原版小 bug：date 早已改存 'ordered'（不是日期），卡片底部會顯示「ed」；沒有操作者時改為不顯示
    js = must_replace(js, "(d.date ? `<span>${d.date.slice(5)}</span>` : '')", "''", count=2)

    js = must_replace(js, '  groupOrder[group] = ordered;\n  saveOrder();', '  groupOrder[group] = ordered;\n  saveOrder(group);', count=2)

    # 趨勢分析：歷史日改讀每日筆數（tick_daily_counts），不再需要整份歷史快照
    js = must_replace(js, '''      const entry = historyLog.find(h => h.date === dateStr);
      if (entry && entry.records) {
        const total = Object.keys(db).length;
        Object.values(entry.records).forEach(s => {
          if (s === '有叫貨')     ord++;
          else if (s === '今日不叫貨') no++;
          else un++;
        });
        // 有些客戶可能沒有記錄，視為未叫貨
        const recorded = ord + un + no;
        un += Math.max(0, total - recorded);
      } else {''', '''      const dc = dailyCounts.get(dateStr);
      if (dc) {
        ord = dc.ord; no = dc.no;
        un = Math.max(0, dc.total - dc.ord - dc.no);   // 沒有列的客戶＝未叫貨
      } else {''')

    js = 'let sb = null;\n' + js + '\n' + (HERE / 'controller.js').read_text(encoding='utf-8') + WRAPPERS
    tail = tail.replace('</script>', '</script>', 1)

    shared = (f'<script src="../shared/zx-nav.js?v={VERSION}" data-site="tick" data-root="../"></script>\n'
              f'<script src="../shared/zx-config.js?v={VERSION}"></script>\n'
              f'<script src="../shared/zx-sync.js?v={VERSION}"></script>\n'
              f'<script src="../shared/zx-auth.js?v={VERSION}"></script>\n')
    page = page[:-len('<script>\n')] + shared + '<script>\n'

    OUT.mkdir(parents=True, exist_ok=True)
    (OUT / 'index.html').write_text(page + js + tail, encoding='utf-8')
    for png in ICONS.glob('*.png'):
        shutil.copy2(png, OUT / png.name)
    print(f'wrote tick/index.html ({(OUT / "index.html").stat().st_size:,} bytes) + {len(list(ICONS.glob("*.png")))} icons')


if __name__ == '__main__':
    main()
