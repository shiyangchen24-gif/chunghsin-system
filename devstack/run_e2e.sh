#!/bin/bash
# 重建本機資料庫 → 重啟 PostgREST 與閘道 → 執行指定的 E2E 測試（預設全部）
cd "$(dirname "$0")"
./setup_db.sh >/dev/null 2>&1 || { echo "setup_db failed"; ./setup_db.sh; exit 1; }
./start.sh >/dev/null
# 等 PostgREST 載入 schema cache、閘道接上資料庫後才開始測試
for i in $(seq 1 40); do
  K=$(cat .anon_key 2>/dev/null)
  code=$(curl -s -o /dev/null -w '%{http_code}' -X POST localhost:8080/rest/v1/rpc/sync_changes -H "apikey: $K" -H 'Content-Type: application/json' -d '{}')
  grep -q 'pg listen ok' gateway.log 2>/dev/null && [ "$code" = "401" -o "$code" = "403" -o "$code" = "200" ] && break
  sleep 0.5
done
status=0
for t in ${@:-e2e_nav.js e2e_tick.js e2e_report.js e2e_quote.js e2e_access.js e2e_migrate.js}; do
  echo "=== $t"
  # 搬移測試需要「空的新專案」：先重建為空庫
  if [ "$t" = "e2e_migrate.js" ]; then ./setup_db.sh --empty >/dev/null 2>&1
  elif [ -n "$ran" ]; then ./setup_db.sh >/dev/null 2>&1; fi   # 每組測試從同一份種子資料開始（儀表板測試會勾選客戶）
  ran=1
  timeout 400 node "$t" || status=1
done
exit $status
