// 測試用：把 CDN 網址對應到本機 npm 的同版本檔案（沙箱內的無頭瀏覽器連不到 CDN）
'use strict';
const path = require('path');
const nm = p => path.join(__dirname, 'node_modules', p);
const MAP = [
  [/@supabase\/supabase-js@2[^/]*(\/dist\/umd\/supabase\.js)?$/, nm('@supabase/supabase-js/dist/umd/supabase.js')],
  [/exceljs(@|\/)4\.4\.0\/(dist\/)?exceljs\.min\.js$/, nm('exceljs/dist/exceljs.min.js')],
  [/xlsx\/0\.18\.5\/xlsx\.full\.min\.js$/, nm('xlsx/dist/xlsx.full.min.js')],
  [/FileSaver\.js\/2\.0\.5\/FileSaver\.min\.js$/, nm('file-saver/dist/FileSaver.min.js')]
];
module.exports = async function routeCdn(context) {
  await context.route(/^https:\/\/(cdn\.jsdelivr\.net|cdnjs\.cloudflare\.com|fonts\.googleapis\.com|fonts\.gstatic\.com)\//, route => {
    const u = route.request().url();
    const hit = MAP.find(([re]) => re.test(u));
    if (hit) return route.fulfill({ path: hit[1], contentType: 'text/javascript' });
    if (/fonts\./.test(u)) return route.fulfill({ status: 200, contentType: 'text/css', body: '' });
    return route.fulfill({ status: 404, body: 'not mapped in test: ' + u });
  });
};
