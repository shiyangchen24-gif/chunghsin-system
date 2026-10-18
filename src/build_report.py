#!/usr/bin/env python3
"""由原版 original/report/index.html 組出新版 report/index.html。

原則：列印預覽、欄寬列高拖曳、匯出 Excel、行內編輯表單等函式「原封不動」從原版複製；
只替換資料層（輪詢 → 同步）、加入登入／同步徽章／日期範圍，並以 @media screen 套上黏土外觀。
"""
import pathlib
import re
import sys

ROOT = pathlib.Path(__file__).resolve().parent.parent
SRC = ROOT / 'original' / 'report' / 'index.html'
OUT = ROOT / 'report' / 'index.html'
HERE = ROOT / 'src' / 'report'

FONTS = ('<link href="https://fonts.googleapis.com/css2?family=Inter:wght@400;500;600;700&family=Noto+Sans+TC:wght@400;500;700&family=JetBrains+Mono:wght@500;600&display=swap" rel="stylesheet">\n'
         '<link rel="stylesheet" href="../shared/theme.css">')

SUPABASE_JS = 'https://cdn.jsdelivr.net/npm/@supabase/supabase-js@2.45.4/dist/umd/supabase.js'


def must_replace(s, old, new, count=1):
    n = s.count(old)
    if n != count:
        sys.exit(f'build_report: expected {count} occurrence(s) of {old[:60]!r}, found {n}')
    return s.replace(old, new)


def block(s, start, end):
    """回傳 s 中從 start（含）到 end（不含）的原文；找不到就中止，避免默默漏掉原版程式碼。"""
    i = s.find(start)
    j = s.find(end, i + 1)
    if i < 0 or j < 0:
        sys.exit(f'build_report: block {start!r} … {end!r} not found')
    return s[i:j]


def main():
    html = SRC.read_text(encoding='utf-8')

    head_end = html.index('<script src="https://cdn.jsdelivr.net/npm/@supabase/supabase-js@2"></script>')
    page, script2 = html[:head_end], html[head_end:]

    # ---- 頁面（head / CSS / body）----
    page = re.sub(r'<link href="https://fonts\.googleapis\.com/css2\?family=Inter[^"]*" rel="stylesheet">', lambda m: FONTS, page, count=1)
    page = must_replace(page, '</style>', (HERE / 'skin.css').read_text(encoding='utf-8') + '</style>')

    page = must_replace(page, '''      <span class="dot"></span>交接表
    </button>
  </div>
</header>''', '''      <span class="dot"></span>交接表
    </button>
  </div>
  <div class="header-right">
    <span id="zx-sync-badge" class="sync-badge" data-state="pending" role="status" aria-live="polite">連線中…</span>
    <span id="zx-user-chip"></span>
  </div>
</header>''')
    page = re.sub(r'<span class="mark"><img src="data:image/png;base64,[^"]+" alt="logo"></span>',
                  '<span class="mark"><img src="../shared/logo.svg" alt="忠欣蔬果 LOGO"></span>', page, count=1)

    def range_bar(pre):
        return (f'<div class="range-bar" id="{pre}-range" role="group" aria-label="日期範圍">'
                f'<span class="range-label">日期範圍</span>'
                f'<button type="button" class="range-chip" data-preset="today">今天</button>'
                f'<button type="button" class="range-chip" data-preset="7d">近 7 天</button>'
                f'<button type="button" class="range-chip" data-preset="30d">近 30 天</button>'
                f'<button type="button" class="range-chip" data-preset="all">全部</button>'
                f'<button type="button" class="range-chip" data-preset="custom">自訂</button>'
                f'<span class="range-custom" hidden><input type="date" data-range-from aria-label="開始日期">～'
                f'<input type="date" data-range-to aria-label="結束日期">'
                f'<button type="button" class="btn btn-secondary" data-range-apply>套用</button></span></div>')

    page = must_replace(page, '<div class="panel-summary">目前共 <strong id="ab-count">0</strong> 筆異常紀錄</div>',
                        '<div class="panel-summary">目前共 <strong id="ab-count">0</strong> 筆異常紀錄'
                        '<span class="range-now">（<span id="ab-range-label"></span>）</span></div>\n    ' + range_bar('ab'))
    page = must_replace(page, '<div class="panel-summary">目前共 <strong id="ho-count">0</strong> 筆交接紀錄</div>',
                        '<div class="panel-summary">目前共 <strong id="ho-count">0</strong> 筆交接紀錄'
                        '<span class="range-now">（<span id="ho-range-label"></span>）</span></div>\n    ' + range_bar('ho'))
    page = must_replace(page, '<datalist id="ab-store-datalist"></datalist>',
                        '<datalist id="ab-store-datalist"></datalist>\n          '
                        '<div id="ab-car-source" class="car-source" aria-live="polite"></div>')
    page = must_replace(page, '    <!-- 專門用於列印的異常表版面',
                        '    <button type="button" class="btn btn-secondary load-more" id="ab-more" hidden>載入更多</button>\n\n'
                        '    <!-- 專門用於列印的異常表版面')
    page = must_replace(page, '    <!-- 專門用於列印的交接表版面',
                        '    <button type="button" class="btn btn-secondary load-more" id="ho-more" hidden>載入更多</button>\n\n'
                        '    <!-- 專門用於列印的交接表版面')

    # ---- 原版保留的函式（逐字複製）----
    static_names = re.search(r'^const STATIC_CUSTOMER_NAMES = .*$', script2, re.M).group(0)
    kept = '\n\n'.join([
        static_names,
        block(script2, 'const EXCHANGE_TYPES', 'async function saveInlineAbnormal'),
        block(script2, 'function editHandover(id){', 'async function saveInlineHandover'),
        block(script2, 'function chipClass(status){', 'async function refreshAll(){'),
    ])

    scripts = (
        f'<script src="{SUPABASE_JS}"></script>\n'
        '<script src="../shared/zx-nav.js" data-site="report" data-root="../"></script>\n'
        '<script src="../shared/zx-config.js"></script>\n'
        '<script src="../shared/zx-sync.js"></script>\n'
        '<script src="../shared/zx-auth.js"></script>\n\n'
        '<script>\n/* ===================== 原版保留（列印預覽／匯出 Excel／行內編輯表單，逐字未改） ===================== */\n'
        + kept +
        '\n</script>\n\n<script>\n'
        + (HERE / 'controller.js').read_text(encoding='utf-8') +
        '</script>\n\n</body>\n</html>\n'
    )

    OUT.parent.mkdir(parents=True, exist_ok=True)
    OUT.write_text(page + scripts, encoding='utf-8')
    print(f'wrote {OUT.relative_to(ROOT)} ({OUT.stat().st_size:,} bytes)')


if __name__ == '__main__':
    main()
