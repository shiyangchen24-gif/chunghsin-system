/* =====================================================================
 * zx-charts.js — 儀表板與經營月報共用的小型圖表（純 SVG／HTML，不需外部套件）
 *   ZXCharts.curve(box, rows, opts)：平滑曲線圖（單一 Y 軸、2px 線、十字線＋提示框、端點直接標示）
 *   ZXCharts.hbars(items, opts)    ：橫條比例圖 HTML（每列：名稱、長條、筆數、百分比）
 *   ZXCharts.smooth(points)        ：單調三次插值路徑
 * 配色規則（已用 dataviz validate_palette.js 驗證）：已叫貨 #15805A 實線、未叫貨 #C2410C 虛線；比例長條單一色。
 * ===================================================================== */
(function (global) {
  'use strict';

  var CSS = '' +
    '.zxc-curve{position:relative}' +
    '.zxc-curve svg{display:block;width:100%;height:100%;overflow:visible}' +
    '.zxc-curve .grid line{stroke:var(--zx-border,#E3E8E5)}' +
    '.zxc-curve .axis text{fill:var(--zx-text-3,#66716B);font:500 11.5px var(--font-body,system-ui)}' +
    '.zxc-curve .end text{font:600 12px var(--font-body,system-ui);fill:var(--zx-text-2,#5A6660)}' +
    '.zxc-tip{position:absolute;pointer-events:none;background:var(--zx-surface,#fff);border:1px solid var(--zx-border,#E3E8E5);' +
      'box-shadow:var(--zx-shadow-pop);border-radius:10px;padding:8px 12px;font-size:12.5px;white-space:nowrap;' +
      'transform:translate(-50%,calc(-100% - 12px));z-index:5}' +
    '.zxc-tip[hidden]{display:none}' +
    '.zxc-tip b{display:block;font-size:13px;margin-bottom:4px}' +
    '.zxc-tip .r{display:flex;align-items:center;gap:6px;color:var(--zx-text-2,#5A6660)}' +
    '.zxc-tip .r i{width:10px;height:0;border-top:2px solid}' +
    '.zxc-tip .r i.dash{border-top-style:dashed}' +
    '.zxc-tip .r em{font-style:normal;font-weight:600;color:var(--zx-text,#1C2520);margin-left:auto;padding-left:12px;font-variant-numeric:tabular-nums}' +
    '.zxc-empty{display:flex;align-items:center;justify-content:center;height:100%;color:var(--zx-text-3,#66716B);font-size:13px}' +
    '.zxc-bars{list-style:none;margin:0;padding:0;display:grid;gap:10px}' +
    '.zxc-bars li{display:grid;grid-template-columns:minmax(0,1fr) auto;gap:4px 10px;font-size:13px;align-items:baseline}' +
    '.zxc-bars .k{overflow:hidden;text-overflow:ellipsis;white-space:nowrap;color:var(--zx-text,#1C2520)}' +
    '.zxc-bars .v{font-variant-numeric:tabular-nums;color:var(--zx-text-2,#5A6660);white-space:nowrap}' +
    '.zxc-bars .v b{color:var(--zx-text,#1C2520);font-weight:600}' +
    '.zxc-bars .t{grid-column:1/-1;height:8px;border-radius:999px;background:var(--zx-surface-2,#F6F8F7);border:1px solid var(--zx-border,#E3E8E5);overflow:hidden}' +
    '.zxc-bars .t>div{height:100%;border-radius:999px}' +
    '.zxc-bars .none{color:var(--zx-text-3,#66716B);display:block}' +
    '@media print{.zxc-tip{display:none!important}.zxc-bars .t{border-color:#999}}';
  if (typeof document !== 'undefined') {
    var st = document.createElement('style'); st.textContent = CSS; document.head.appendChild(st);
  }

  function esc(s) {
    return String(s == null ? '' : s).replace(/[&<>"']/g, function (c) {
      return { '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c];
    });
  }

  // 平滑曲線：單調三次插值（Fritsch–Carlson），曲線經過每個資料點，且不會衝出資料範圍（不會畫出負數）
  function smooth(P) {
    var n = P.length, f = function (v) { return v.toFixed(1); };
    if (n < 3) return P.map(function (p, i) { return (i ? 'L' : 'M') + f(p[0]) + ' ' + f(p[1]); }).join('');
    var d = [], m = [], i;
    for (i = 0; i < n - 1; i++) d.push((P[i + 1][1] - P[i][1]) / (P[i + 1][0] - P[i][0]));
    m[0] = d[0]; m[n - 1] = d[n - 2];
    for (i = 1; i < n - 1; i++) m[i] = d[i - 1] * d[i] <= 0 ? 0 : (d[i - 1] + d[i]) / 2;
    for (i = 0; i < n - 1; i++) {
      if (d[i] === 0) { m[i] = 0; m[i + 1] = 0; continue; }
      var a = m[i] / d[i], b = m[i + 1] / d[i], h = a * a + b * b;
      if (h > 9) { var t = 3 / Math.sqrt(h); m[i] = t * a * d[i]; m[i + 1] = t * b * d[i]; }
    }
    var s = 'M' + f(P[0][0]) + ' ' + f(P[0][1]);
    for (i = 0; i < n - 1; i++) {
      var dx = (P[i + 1][0] - P[i][0]) / 3;
      s += 'C' + f(P[i][0] + dx) + ' ' + f(P[i][1] + m[i] * dx) + ' ' + f(P[i + 1][0] - dx) + ' ' + f(P[i + 1][1] - m[i + 1] * dx) +
           ' ' + f(P[i + 1][0]) + ' ' + f(P[i + 1][1]);
    }
    return s;
  }

  function niceMax(v) {
    if (v <= 4) return 4;
    var p = Math.pow(10, Math.floor(Math.log10(v))), n = v / p;
    return (n <= 1 ? 1 : n <= 2 ? 2 : n <= 2.5 ? 2.5 : n <= 5 ? 5 : 10) * p;
  }

  var uid = 0;
  /* rows：[{ x 標籤用的值, <series key>: 數字, open?: 進行中 }]
   * opts：{ series: [{ key, label, end, color, dash, area }], fmtX(row), title(row), unit, extra(row) → 額外提示列 HTML, aria } */
  function curve(box, R, opts) {
    box.classList.add('zxc-curve');
    var S = opts.series, unit = opts.unit || '';
    if (!R.length) { box.innerHTML = '<div class="zxc-empty">' + esc(opts.empty || '尚無資料') + '</div>'; return; }
    var id = 'zxc' + (++uid);
    var W = box.clientWidth, H = box.clientHeight;
    var m = { l: 36, r: S.some(function (s) { return s.end; }) ? 64 : 16, t: 10, b: 26 };
    var iw = Math.max(10, W - m.l - m.r), ih = H - m.t - m.b;
    var max = niceMax(Math.max.apply(null, R.map(function (r) { return Math.max.apply(null, S.map(function (s) { return r[s.key] || 0; })); })) || 1);
    var x = function (i) { return m.l + (R.length === 1 ? iw / 2 : i * iw / (R.length - 1)); };
    var y = function (v) { return m.t + ih - v / max * ih; };
    var path = function (k) { return smooth(R.map(function (p, i) { return [x(i), y(p[k] || 0)]; })); };
    var s = '<svg viewBox="0 0 ' + W + ' ' + H + '" preserveAspectRatio="none" aria-hidden="true"><g class="grid">';
    for (var g = 0; g <= 4; g++) {
      var gy = y(max * g / 4);
      s += '<line x1="' + m.l + '" x2="' + (m.l + iw) + '" y1="' + gy + '" y2="' + gy + '"' + (g ? ' stroke-dasharray="3 4"' : '') + '/>';
    }
    s += '</g><g class="axis">';
    for (g = 0; g <= 4; g++) s += '<text x="' + (m.l - 8) + '" y="' + (y(max * g / 4) + 4) + '" text-anchor="end">' + Math.round(max * g / 4) + '</text>';
    var step = Math.max(1, Math.ceil(R.length / Math.max(2, Math.floor(iw / 64))));
    R.forEach(function (p, i) {
      if (i % step === 0 || i === R.length - 1) s += '<text x="' + x(i) + '" y="' + (H - 6) + '" text-anchor="middle">' + esc(opts.fmtX(p)) + '</text>';
    });
    s += '</g>';
    S.forEach(function (se, k) {
      if (!se.area) return;
      s += '<defs><linearGradient id="' + id + 'g' + k + '" x1="0" y1="0" x2="0" y2="1"><stop offset="0" stop-color="' + se.color + '" stop-opacity=".16"/>' +
           '<stop offset="1" stop-color="' + se.color + '" stop-opacity="0"/></linearGradient></defs>' +
           '<path d="' + path(se.key) + 'L' + x(R.length - 1).toFixed(1) + ' ' + y(0) + 'L' + x(0).toFixed(1) + ' ' + y(0) + 'Z" fill="url(#' + id + 'g' + k + ')"/>';
    });
    S.slice().reverse().forEach(function (se) {
      s += '<path d="' + path(se.key) + '" fill="none" stroke="' + se.color + '" stroke-width="2"' + (se.dash ? ' stroke-dasharray="6 4"' : '') +
           ' stroke-linejoin="round" stroke-linecap="round"/>';
    });
    // 端點直接標示（最後一天仍進行中時以空心點表示）；兩個標籤太近時上下錯開
    var L = R.length - 1, last = R[L], ends = S.filter(function (se) { return se.end; });
    var ly = ends.map(function (se) { return y(last[se.key] || 0); });
    if (ly.length === 2 && Math.abs(ly[0] - ly[1]) < 16) {
      var mid = (ly[0] + ly[1]) / 2, up = (last[ends[0].key] || 0) >= (last[ends[1].key] || 0);
      ly[0] = mid + (up ? -9 : 9); ly[1] = mid + (up ? 9 : -9);
    }
    s += '<g class="end">';
    ends.forEach(function (se, k) {
      s += '<circle cx="' + x(L) + '" cy="' + y(last[se.key] || 0) + '" r="4.5" fill="' + (last.open ? '#fff' : se.color) + '" stroke="' + se.color + '" stroke-width="2"/>' +
           '<text x="' + (x(L) + 10) + '" y="' + (ly[k] + 4) + '">' + esc(se.end) + ' ' + (last[se.key] || 0) + '</text>';
    });
    s += '</g><g class="hov" visibility="hidden"><line class="hx" y1="' + m.t + '" y2="' + (m.t + ih) + '" stroke="#9AA6A0" stroke-width="1"/>';
    S.forEach(function (se) { s += '<circle class="hd" r="5" fill="' + se.color + '" stroke="#fff" stroke-width="2"/>'; });
    s += '</g><rect class="hit" x="' + m.l + '" y="0" width="' + iw + '" height="' + H + '" fill="transparent"/></svg><div class="zxc-tip" hidden></div>';
    box.innerHTML = s;
    if (opts.aria) box.setAttribute('aria-label', opts.aria(R));

    var hit = box.querySelector('.hit'), hov = box.querySelector('.hov'), tip = box.querySelector('.zxc-tip'), dots = box.querySelectorAll('.hd');
    function show(evt) {
      var rect = box.getBoundingClientRect();
      var px = (evt.touches ? evt.touches[0].clientX : evt.clientX) - rect.left;
      var i = R.length === 1 ? 0 : Math.round((px - m.l) / iw * (R.length - 1));
      i = Math.max(0, Math.min(R.length - 1, i));
      var p = R[i];
      hov.setAttribute('visibility', 'visible');
      box.querySelector('.hx').setAttribute('x1', x(i)); box.querySelector('.hx').setAttribute('x2', x(i));
      S.forEach(function (se, k) { dots[k].setAttribute('cx', x(i)); dots[k].setAttribute('cy', y(p[se.key] || 0)); });
      tip.innerHTML = '<b>' + esc(opts.title(p)) + '</b>' + S.map(function (se) {
        return '<div class="r"><i' + (se.dash ? ' class="dash"' : '') + ' style="border-color:' + se.color + '"></i>' + esc(se.label) +
               '<em>' + (p[se.key] || 0) + (unit ? ' ' + unit : '') + '</em></div>';
      }).join('') + (opts.extra ? opts.extra(p) : '');
      tip.hidden = false;
      tip.style.left = Math.max(80, Math.min(W - 80, x(i))) + 'px';
      tip.style.top = Math.min.apply(null, S.map(function (se) { return y(p[se.key] || 0); })) + 'px';
    }
    function hide() { hov.setAttribute('visibility', 'hidden'); tip.hidden = true; }
    hit.addEventListener('mousemove', show);
    hit.addEventListener('touchstart', show, { passive: true });
    hit.addEventListener('touchmove', show, { passive: true });
    hit.addEventListener('mouseleave', hide);
  }

  /* items：[{ k, n }]；opts：{ color, sort: true（依筆數排序）, empty } → 回傳 HTML */
  function hbars(items, opts) {
    opts = opts || {};
    var total = items.reduce(function (a, b) { return a + b.n; }, 0);
    if (!total) return '<ul class="zxc-bars"><li><span class="none">' + esc(opts.empty || '這段期間沒有資料') + '</span></li></ul>';
    var L = opts.sort === false ? items : items.slice().sort(function (a, b) { return b.n - a.n || String(a.k).localeCompare(String(b.k)); });
    var max = Math.max.apply(null, L.map(function (i) { return i.n; }));
    return '<ul class="zxc-bars">' + L.map(function (i) {
      var pct = Math.round(i.n / total * 1000) / 10;
      return '<li title="' + esc(i.k) + '：' + i.n + ' 筆（' + pct + '%）"><span class="k">' + esc(i.k) + '</span>' +
        '<span class="v"><b>' + i.n + '</b> 筆・' + pct + '%</span>' +
        '<span class="t" role="img" aria-label="' + esc(i.k) + ' ' + pct + '%"><div style="width:' + (i.n / max * 100).toFixed(1) + '%;background:' + (opts.color || '#15805A') + '"></div></span></li>';
    }).join('') + '</ul>';
  }

  global.ZXCharts = { curve: curve, hbars: hbars, smooth: smooth, esc: esc };
})(window);
