#!/bin/bash
# 本機重現測試：PostgreSQL 16 + Supabase 介面模擬（不是真實 Supabase）
# 流程比照正式環境：空專案 → 01~06 建表 → 搬入暫存（模擬 migrate.html）→ 07 backfill → 08 核對
set -e
cd "$(dirname "$0")"
P="psql -h ${PGHOST:-/var/tmp/zxsock} -p ${PGPORT:-5544} -U postgres -v ON_ERROR_STOP=1 -q"
$P -c "drop database if exists zx" -c "create database zx" >/dev/null
$P -d zx -f supabase_stub.sql >/dev/null
for f in 01_backup 02_core_shared 03_tick 04_report 05_quote 06_import_staging 12_dashboard 13_nickname_access 14_analytics 15_api_grants \
         01_backup 02_core_shared 03_tick 04_report 05_quote 06_import_staging 12_dashboard 13_nickname_access 14_analytics 15_api_grants; do   # 每個檔跑兩次 = 冪等測試
  $P -d zx -f ../sql/$f.sql >/dev/null 2>&1 || { echo "FAIL: $f"; $P -d zx -f ../sql/$f.sql 2>&1 | grep ERROR | head -3; exit 1; }
done
echo "PASS: 01-06,12-15 executed twice on an empty project (idempotent)"
$P -d zx -f staging_sim.sql >/dev/null
for f in 07_backfill 07_backfill; do
  $P -d zx -f ../sql/$f.sql >/dev/null 2>&1 || { echo "FAIL: $f"; $P -d zx -f ../sql/$f.sql 2>&1 | grep ERROR | head -3; exit 1; }
done
echo "PASS: 07_backfill executed twice (idempotent)"
$P -d zx -f ../sql/08_verify.sql
$P -d zx -f behaviour_tests.sql 2>&1 | grep -E "PASS|FAIL|ERROR" | sed 's/^psql:[^ ]* NOTICE:  //'
./race_test.sh | tail -1
