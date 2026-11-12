export MSYS_NO_PATHCONV=1 SIM_ACTOR="مازن" SIM_SCENE="D2-PM-S2b"; S="node C:/Dev/cafe-operations-system-3/docs/handover/simulation/run-2026-11-11/tools/sim.mjs"
BR=cmwc33qgt0012hlng6f0q8uz6
seen=""; empty=0; started=0; first=1
for i in $(seq 1 20); do
  out=$($S call mazen.bar@sim.test GET "/api/orders?branchId=$BR&status=CONFIRMED" --full)
  ids=$(echo "$out" | node ids.js)
  new=0
  for p in $ids; do
    id=${p%%:*}
    case " $seen " in *" $id "*) continue;; esac
    seen="$seen $id"; new=1; started=1
    echo "READ $i new order $p"
    if [ $first = 1 ]; then first=0; echo DOUBLE-PREPARING; $S call mazen.bar@sim.test PATCH /api/orders/$id/status '{"status":"PREPARING"}' --times 2 --parallel | cut -c1-200 | sed -E 's/"revision.*"orderNumber"/ order#/'
    else $S call mazen.bar@sim.test PATCH /api/orders/$id/status '{"status":"PREPARING"}' | cut -c1-220 | sed -E 's/"revision.*"orderNumber"/ order#/'; fi
    $S call mazen.bar@sim.test PATCH /api/orders/$id/status '{"status":"READY"}' | cut -c1-220 | sed -E 's/"revision.*"orderNumber"/ order#/'
  done
  if [ $new = 0 ]; then empty=$((empty+1)); else empty=0; fi
  echo "read $i empty=$empty"
  if [ $started = 1 ] && [ $empty -ge 4 ]; then break; fi
  sleep 15
done
