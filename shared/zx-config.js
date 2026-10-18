/* 三站共用連線設定。anon（publishable）key 本來就會公開在前端；service_role／secret key 絕對不可放這裡。
 * 在 localhost 開啟時自動改連本機測試堆疊（devstack/），不會碰到正式資料。 */
window.ZX_CONFIG = (function () {
  'use strict';
  var PROD = {
    url: 'https://aknxualjinfanuchtbwo.supabase.co',
    anonKey: 'eyJhbGciOiJIUzI1NiIsInR5cCI6IkpXVCJ9.eyJpc3MiOiJzdXBhYmFzZSIsInJlZiI6ImFrbnh1YWxqaW5mYW51Y2h0YndvIiwicm9sZSI6ImFub24iLCJpYXQiOjE3OTIyOTc2MjcsImV4cCI6MjEwNzg3MzYyN30.OyfUqAV4_lixqJ-8TDqc5iy77XpfB6CkG1UGiH2DNGI',
    env: 'production'
  };
  if (/^(localhost|127\.0\.0\.1)$/.test(location.hostname)) {
    try {
      var xhr = new XMLHttpRequest();
      xhr.open('GET', '/__dev_config', false);
      xhr.send();
      if (xhr.status === 200) {
        var dev = JSON.parse(xhr.responseText);
        return { url: dev.url, anonKey: dev.anonKey, env: 'local-dev' };
      }
    } catch (e) { /* 沒有本機堆疊就用正式設定 */ }
  }
  return PROD;
})();
