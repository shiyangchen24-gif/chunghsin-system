#!/bin/bash
# 啟動本機測試堆疊：PostgREST(3001) + 閘道(8080)
cd "$(dirname "$0")"
for f in postgrest.pid postgrest_old.pid gateway.pid; do [ -f $f ] && kill $(cat $f) 2>/dev/null; rm -f $f; done
sleep 0.5
nohup ./bin/postgrest postgrest.conf > postgrest.log 2>&1 & echo $! > postgrest.pid
[ -f postgrest_old.conf ] && { nohup ./bin/postgrest postgrest_old.conf > postgrest_old.log 2>&1 & echo $! > postgrest_old.pid; }
sleep 1
nohup node server.js > gateway.log 2>&1 & echo $! > gateway.pid
sleep 1
tail -n 2 postgrest.log gateway.log
