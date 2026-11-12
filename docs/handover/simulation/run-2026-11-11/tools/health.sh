#!/usr/bin/env bash
# Before every shift: DB 5434 and server 3100 up, and the server reads the disposable DB.
R=C:/Dev/cafe-operations-system-3/docs/handover/simulation/run-2026-11-11
db=$(cd C:/Dev/cafe-ops-handover-integration && node -e "const{PrismaClient}=require('@prisma/client');const d=new PrismaClient({datasources:{db:{url:'postgresql://postgres@127.0.0.1:5434/cafe_ops_test?schema=public'}}});d.\$queryRawUnsafe(\"select current_database() db, inet_server_addr()::text host, current_setting('port') port\").then(r=>{console.log(JSON.stringify(r[0]));return d.\$disconnect()}).catch(e=>{console.log('DB_DOWN '+e.message.split('\n')[0]);process.exit(1)})")
srv=$(curl -s -o /dev/null -w "%{http_code}" --max-time 20 http://localhost:3100/login)
me=$(MSYS_NO_PATHCONV=1 node $R/tools/sim.mjs whoami owner@demo.com 2>&1 | cut -c1-60)
echo "$(date -Is) db=$db server3100=$srv owner_session=$me" | tee -a $R/logs/health.log
