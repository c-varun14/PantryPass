#!/usr/bin/env bash
# Runs kill-test Gates 2-4 against the live stack and prints PASS/FAIL lines.
# Passwords and tokens are created in-process and never written to a file.
set -uo pipefail
cd "$(dirname "$0")/.."
source infra/00_env.sh
: "${API_URL:?run infra/60_api.sh first}"
: "${COGNITO_POOL_ID:?run infra/20_cognito.sh first}"
: "${COGNITO_CLIENT_ID:?run infra/20_cognito.sh first}"

FAILED=0
check() { # label expected actual
  if [ "$2" = "$3" ]; then echo "PASS | $1 | expected=$2 actual=$3";
  else echo "FAIL | $1 | expected=$2 actual=$3"; FAILED=1; fi
}

# ---- in-process identities (no secrets persisted) ----
PW="Pp-$(python3 -c 'import secrets;print(secrets.token_urlsafe(9))')-aA1!"
aws cognito-idp admin-set-user-password --user-pool-id "$COGNITO_POOL_ID" --username donor1 --password "$PW" --permanent
aws cognito-idp admin-set-user-password --user-pool-id "$COGNITO_POOL_ID" --username receiver1 --password "$PW" --permanent
aws cognito-idp admin-set-user-password --user-pool-id "$COGNITO_POOL_ID" --username coordinator1 --password "$PW" --permanent
DTOK=$(aws cognito-idp admin-initiate-auth --user-pool-id "$COGNITO_POOL_ID" --client-id "$COGNITO_CLIENT_ID" \
  --auth-flow ADMIN_USER_PASSWORD_AUTH --auth-parameters USERNAME=donor1,PASSWORD="$PW" --query AuthenticationResult.IdToken --output text)
RTOK=$(aws cognito-idp admin-initiate-auth --user-pool-id "$COGNITO_POOL_ID" --client-id "$COGNITO_CLIENT_ID" \
  --auth-flow ADMIN_USER_PASSWORD_AUTH --auth-parameters USERNAME=receiver1,PASSWORD="$PW" --query AuthenticationResult.IdToken --output text)
CTOK=$(aws cognito-idp admin-initiate-auth --user-pool-id "$COGNITO_POOL_ID" --client-id "$COGNITO_CLIENT_ID" \
  --auth-flow ADMIN_USER_PASSWORD_AUTH --auth-parameters USERNAME=coordinator1,PASSWORD="$PW" --query AuthenticationResult.IdToken --output text)

api() { local method=$1 path=$2 token=$3 body=${4:-}; local args=(-s -w '\n%{http_code}' -X "$method" "$API_URL$path" -H "Authorization: Bearer $token"); [ -n "$body" ] && args+=(-H 'content-type: application/json' -d "$body"); RESP=$(curl "${args[@]}"); STATUS=$(printf '%s' "$RESP" | tail -n1); BODY=$(printf '%s' "$RESP" | sed '$d'); }
J() { printf '%s' "$BODY" | python3 -c '
import json,sys
try: d=json.load(sys.stdin)
except Exception: d={}
try: print(eval("d"+sys.argv[1]))
except Exception: print("")
' "$1"; }
dbitem() { aws dynamodb get-item --table-name "$LOTS_TABLE" --key '{"lot_id":{"S":"'"$1"'"}}' --query 'Item' --output json; }
lotfield() { dbitem "$1" | python3 -c 'import json,sys;d=json.load(sys.stdin);v=d.get(sys.argv[1],{});print(list(v.values())[0] if v else "")' "$2"; }
wait_token() { local i; for i in $(seq 1 30); do local t; t=$(dbitem "$1" | python3 -c 'import json,sys;print(json.load(sys.stdin).get("task_token",{}).get("S",""))'); [ -n "$t" ] && return 0; sleep 1; done; return 1; }
mk() { # token receiver offered [ignored] -> lot_id; the server sets the cutoff
  api POST /lots "$1" "{\"receiver_sub\":\"$2\",\"offered\":$3}"; J "['lot']['lot_id']"; }
set_cutoff() { # lot epoch: tests move the cutoff directly, the API has no way to
  aws dynamodb update-item --table-name "$LOTS_TABLE" --key '{"lot_id":{"S":"'"$1"'"}}' \
    --update-expression 'SET cutoff_epoch = :c' --expression-attribute-values '{":c":{"N":"'"$2"'"}}' >/dev/null; }
set_token() { # lot token
  aws dynamodb update-item --table-name "$LOTS_TABLE" --key '{"lot_id":{"S":"'"$1"'"}}' \
    --update-expression 'SET task_token = :t' --expression-attribute-values '{":t":{"S":"'"$2"'"}}' >/dev/null; }
get_token() { dbitem "$1" | python3 -c 'import json,sys;print(json.load(sys.stdin).get("task_token",{}).get("S",""))'; }
# drive a lot to RECEIVED, leaving it at version 4 (skips accept if already accepted)
drive_received() { # lot token
  local lot=$1 tok=$2; wait_token "$lot" >/dev/null 2>&1
  if [ "$(lotfield "$lot" stage)" = "OFFERED" ]; then
    api POST "/lots/$lot/accept" "$tok" "{\"idem_key\":\"acc-$lot\",\"expected_version\":1}"; check "accept $lot" 200 "$STATUS"
  fi
  api POST "/lots/$lot/handoff" "$DTOK" "{\"idem_key\":\"hnd-$lot\",\"expected_version\":2,\"donor_handoff\":8}"; check "handoff $lot" 200 "$STATUS"
  api POST "/lots/$lot/receipt" "$tok" "{\"idem_key\":\"rcp-$lot\",\"expected_version\":3,\"received\":8}"; check "receipt $lot" 200 "$STATUS"; }
deny_event() { aws dynamodb query --table-name "$EVENTS_TABLE" --key-condition-expression 'lot_id = :l' \
  --expression-attribute-values '{":l":{"S":"'"$1"'"}}' --output json | A="$2" python3 -c '
import json,sys,os
items=json.load(sys.stdin)["Items"]
print(any(i.get("decision",{}).get("S")=="DENY" and i.get("action",{}).get("S")==os.environ["A"] for i in items))'; }
NOW=$(date +%s); FUT=$((NOW + 3600))

echo "=========== GATE 2: identity + policy ==========="
A=$(mk "$DTOK" "$RECEIVER_SUB" 10 "$FUT"); echo "lot A = $A"
echo "-- 2.1 donor tries to report distribution on A (expect 403, VP DENY) --"
api POST "/lots/$A/distribution" "$DTOK" "{\"idem_key\":\"g2-donor\",\"expected_version\":1,\"distributed\":1}"
echo "status=$STATUS body=$BODY"; check "2.1 donor distribution denied" 403 "$STATUS"
check "2.1 DENY event attributed" True "$(deny_event "$A" ReportDistribution)"

echo "-- 2.2 receiver acts on a DIFFERENT lot (expect 403) --"
A2=$(mk "$DTOK" "other-receiver-$(python3 -c 'import uuid;print(uuid.uuid4().hex[:8])')" 10 "$FUT"); echo "lot A2 = $A2"
api POST "/lots/$A2/distribution" "$RTOK" "{\"idem_key\":\"g2-other\",\"expected_version\":1,\"distributed\":1}"
echo "status=$STATUS body=$BODY"; check "2.2 receiver on other lot denied" 403 "$STATUS"

echo "-- 2.3 forged role field in body must not help the donor (expect 403) --"
api POST "/lots/$A/distribution" "$DTOK" "{\"role\":\"receiver\",\"actor\":\"receiver1\",\"idem_key\":\"g2-forge\",\"expected_version\":1,\"distributed\":1}"
echo "status=$STATUS body=$BODY"; check "2.3 forged role still denied" 403 "$STATUS"

echo "-- 2.4 assigned receiver is allowed on A (expect 200 + execution advances) --"
wait_token "$A" && echo "task token parked server-side (not returned by any API)"
api POST "/lots/$A/accept" "$RTOK" "{\"idem_key\":\"g2-accept\",\"expected_version\":1}"
echo "status=$STATUS body=$BODY"; check "2.4 receiver accept allowed" 200 "$STATUS"
EXEC_A=$(lotfield "$A" exec_arn)
sleep 4
ST=$(aws stepfunctions describe-execution --execution-arn "$EXEC_A" --query status --output text)
check "2.4 execution advanced to SUCCEEDED" SUCCEEDED "$ST"

echo "=========== GATE 3: stock and replay ==========="
drive_received "$A" "$RTOK"
echo "-- 3.1 duplicate receipt (same idem_key) returns same result, stock stays 8 --"
api POST "/lots/$A/receipt" "$RTOK" "{\"idem_key\":\"rcp-$A\",\"expected_version\":3,\"received\":8}"
echo "status=$STATUS body=$BODY"; check "3.1 receipt replay status" 200 "$STATUS"
check "3.1 stock after replay" 8 "$(lotfield "$A" received)"
check "3.1 idem replay did not bump version" 4 "$(lotfield "$A" version)"
echo "-- 3.2 distribution of 9 (remaining 8, expect 409) --"
api POST "/lots/$A/distribution" "$RTOK" "{\"idem_key\":\"g3-over\",\"expected_version\":4,\"distributed\":9}"
echo "status=$STATUS body=$BODY"; check "3.2 over-report rejected" 409 "$STATUS"
echo "-- 3.3 distribution of 6 -> remaining 2 --"
api POST "/lots/$A/distribution" "$RTOK" "{\"idem_key\":\"g3-six\",\"expected_version\":4,\"distributed\":6}"
echo "status=$STATUS body=$BODY"; check "3.3 distribution of 6 accepted" 200 "$STATUS"
check "3.3 remaining" 2 "$(lotfield "$A" remaining)"
check "3.3 distributed" 6 "$(lotfield "$A" distributed)"
echo "-- 3.4 close with remaining 2 (expect 409, never success) --"
api POST "/lots/$A/close" "$RTOK" "{\"idem_key\":\"g3-close\",\"expected_version\":5}"
echo "status=$STATUS body=$BODY"; check "3.4 close blocked with remainder" 409 "$STATUS"
echo "-- 3.5 stale expected_version (expect 409) --"
api POST "/lots/$A/distribution" "$RTOK" "{\"idem_key\":\"g3-stale\",\"expected_version\":1,\"distributed\":1}"
echo "status=$STATUS body=$BODY"; check "3.5 stale version rejected" 409 "$STATUS"
echo "-- 3.6 invariant on lot A --"
R=$(lotfield "$A" received); DI=$(lotfield "$A" distributed); RE=$(lotfield "$A" returned); DP=$(lotfield "$A" disposed); RM=$(lotfield "$A" remaining)
echo "received=$R distributed=$DI returned=$RE disposed=$DP remaining=$RM"
check "3.6 invariant received=dist+ret+disp+rem" "$R" "$((DI + RE + DP + RM))"

echo "-- 3.7 concurrency: two different idem keys, same version, exactly one wins --"
D=$(mk "$DTOK" "$RECEIVER_SUB" 8 "$FUT"); echo "lot D = $D"; drive_received "$D" "$RTOK"
V=$(lotfield "$D" version); echo "lot D version=$V remaining=$(lotfield "$D" remaining)"
conc() { local out=$1; curl -s -o "$out.body" -w '%{http_code}' -X POST "$API_URL/lots/$D/distribution" -H "Authorization: Bearer $RTOK" -H 'content-type: application/json' -d "{\"idem_key\":\"$2\",\"expected_version\":$V,\"distributed\":1}" > "$out.code"; }
conc /tmp/c1 conc-1 & P1=$!
conc /tmp/c2 conc-2 & P2=$!
wait $P1 $P2
C1=$(cat /tmp/c1.code); C2=$(cat /tmp/c2.code); echo "concurrent statuses: $C1 $C2"
WINS=$(printf '%s\n%s\n' "$C1" "$C2" | grep -c '^200$')
check "3.7 exactly one concurrent win" 1 "$WINS"

echo "=========== GATE 4: deadlines and callback gap ==========="
echo "-- 4.1 lot B with a 90s response deadline left unanswered -> EXCEPTION --"
B=$(mk "$DTOK" "$RECEIVER_SUB" 10 "$FUT"); echo "lot B = $B"; EXEC_B=$(lotfield "$B" exec_arn)
echo "execution B = $EXEC_B"
echo "waiting ~100s for States.Timeout ..."
sleep 100
STB=$(aws stepfunctions describe-execution --execution-arn "$EXEC_B" --query status --output text)
echo "execution B status=$STB"
ESC_ENTERED=$(aws stepfunctions get-execution-history --execution-arn "$EXEC_B" \
  --query "events[?stateEnteredEventDetails.name=='Escalate'] | length(@)" --output text)
echo "Escalate state entered $ESC_ENTERED time(s)"
check "4.1 execution B ended through the timeout branch" SUCCEEDED "$STB"
check "4.1 Escalate branch entered" 1 "$ESC_ENTERED"
echo "lot B stage=$(lotfield "$B" stage) distributed=$(lotfield "$B" distributed) disposed=$(lotfield "$B" disposed)"
check "4.1 lot B escalated to EXCEPTION" EXCEPTION "$(lotfield "$B" stage)"
check "4.1 nothing distributed on B" 0 "$(lotfield "$B" distributed)"
check "4.1 nothing disposed on B" 0 "$(lotfield "$B" disposed)"

echo "-- 4.2 lot C created with a past cutoff; distribution denied by SERVER time --"
C=$(mk "$DTOK" "$RECEIVER_SUB" 10); echo "lot C = $C"
drive_received "$C" "$RTOK"
set_cutoff "$C" "$((NOW - 60))"; echo "lot C cutoff moved into the past"
api POST "/lots/$C/distribution" "$RTOK" "{\"idem_key\":\"g4-late\",\"expected_version\":4,\"distributed\":1,\"now\":$((NOW + 100000))}"
echo "status=$STATUS body=$BODY"; check "4.2 late distribution denied" 409 "$STATUS"
check "4.2 nothing distributed after late attempt" 0 "$(lotfield "$C" distributed)"

echo "-- 4.3 forced callback failure -> callback_pending, then retry reconciles --"
E=$(mk "$DTOK" "$RECEIVER_SUB" 10 "$FUT"); echo "lot E = $E"; EXEC_E=$(lotfield "$E" exec_arn); wait_token "$E" >/dev/null 2>&1
REAL_TOK=$(get_token "$E"); set_token "$E" "bad-token"
api POST "/lots/$E/accept" "$RTOK" "{\"idem_key\":\"g4-badcb\",\"expected_version\":1}"
set_token "$E" "$REAL_TOK"
echo "status=$STATUS body=$BODY"; check "4.3 accept recorded" 200 "$STATUS"
check "4.3 callback_pending set" True "$(lotfield "$E" callback_pending)"
STE=$(aws stepfunctions describe-execution --execution-arn "$EXEC_E" --query status --output text)
check "4.3 execution not final while pending" RUNNING "$STE"
check "4.3 lot not final (not ACCOUNTED_FOR)" ACCEPTED "$(lotfield "$E" stage)"
api POST /retry-callbacks "$CTOK" "{\"lot_id\":\"$E\"}"
echo "retry status=$STATUS body=$BODY"; check "4.3 retry reconciled lot E" "$E" "$(J "['reconciled'][0]")"
sleep 4
STE2=$(aws stepfunctions describe-execution --execution-arn "$EXEC_E" --query status --output text)
check "4.3 execution advanced after retry" SUCCEEDED "$STE2"
check "4.3 callback_pending cleared" False "$(lotfield "$E" callback_pending)"

echo "-- 4.4 retry-callbacks needs the coordinator role --"
api POST /retry-callbacks "$DTOK" "{}"; check "4.4 donor retry denied" 403 "$STATUS"
api POST /retry-callbacks "$RTOK" "{}"; check "4.4 receiver retry denied" 403 "$STATUS"
api POST /retry-callbacks "$CTOK" "{}"; check "4.4 coordinator retry allowed" 200 "$STATUS"

echo "-- 4.5 force_bad_callback in the body is ignored --"
G=$(mk "$DTOK" "$RECEIVER_SUB" 10); wait_token "$G" >/dev/null 2>&1
api POST "/lots/$G/accept" "$RTOK" "{\"idem_key\":\"g4-hook\",\"expected_version\":1,\"force_bad_callback\":true}"
check "4.5 accept ok" 200 "$STATUS"
check "4.5 callback not pending" False "$(lotfield "$G" callback_pending)"

echo "-- 4.6 idem_key reused for a different action (expect 409, not a replay) --"
api POST "/lots/$G/handoff" "$DTOK" "{\"idem_key\":\"g4-hook\",\"expected_version\":2,\"donor_handoff\":8}"
echo "status=$STATUS body=$BODY"; check "4.6 cross-action idem_key rejected" 409 "$STATUS"
check "4.6 lot not advanced" ACCEPTED "$(lotfield "$G" stage)"

echo "-- 4.7 client-sent cutoff_epoch is ignored --"
api POST /lots "$DTOK" "{\"receiver_sub\":\"$RECEIVER_SUB\",\"offered\":5,\"cutoff_epoch\":$((NOW + 999999))}"
CUT=$(J "['lot']['cutoff_epoch']"); LIM=$((NOW + 100000))
if [ -n "$CUT" ] && [ "$CUT" -lt "$LIM" ]; then ok=yes; else ok=no; fi
check "4.7 server-set cutoff" yes "$ok"

echo "-- 4.8 close after cutoff succeeds when remaining is 0 --"
H=$(mk "$DTOK" "$RECEIVER_SUB" 10); drive_received "$H" "$RTOK"
api POST "/lots/$H/distribution" "$RTOK" "{\"idem_key\":\"g4-all\",\"expected_version\":4,\"distributed\":8}"
check "4.8 distribute all" 200 "$STATUS"
set_cutoff "$H" "$((NOW - 60))"
api POST "/lots/$H/close" "$RTOK" "{\"idem_key\":\"g4-close\",\"expected_version\":5}"
echo "status=$STATUS body=$BODY"; check "4.8 close after cutoff, remaining 0" 200 "$STATUS"

echo "=========== GATE 6: Go routes (disposition, resolve-dispute, GET /lots) ==========="
L=$(mk "$DTOK" "$RECEIVER_SUB" 10); drive_received "$L" "$RTOK"
echo "lot L = $L (received 8, version 4)"
echo "-- 6.1 disposition: donor denied --"
api POST "/lots/$L/disposition" "$DTOK" "{\"idem_key\":\"g6-d\",\"expected_version\":4,\"returned\":1}"
check "6.1 donor disposition denied" 403 "$STATUS"
echo "-- 6.2 disposition over remaining --"
api POST "/lots/$L/disposition" "$RTOK" "{\"idem_key\":\"g6-over\",\"expected_version\":4,\"returned\":5,\"disposed\":4}"
check "6.2 over remaining rejected" 409 "$STATUS"
echo "-- 6.3 disposition stale version --"
api POST "/lots/$L/disposition" "$RTOK" "{\"idem_key\":\"g6-stale\",\"expected_version\":1,\"returned\":1}"
check "6.3 stale version rejected" 409 "$STATUS"
echo "-- 6.4 valid disposition, replay, invariant --"
api POST "/lots/$L/disposition" "$RTOK" "{\"idem_key\":\"g6-ok\",\"expected_version\":4,\"returned\":2,\"disposed\":1}"
check "6.4 disposition accepted" 200 "$STATUS"
api POST "/lots/$L/disposition" "$RTOK" "{\"idem_key\":\"g6-ok\",\"expected_version\":4,\"returned\":2,\"disposed\":1}"
check "6.4 replay returns 200" 200 "$STATUS"
check "6.4 replay did not double-apply" 5 "$(lotfield "$L" version)"
check "6.4 returned" 2 "$(lotfield "$L" returned)"
check "6.4 disposed" 1 "$(lotfield "$L" disposed)"
check "6.4 remaining" 5 "$(lotfield "$L" remaining)"
R=$(lotfield "$L" received); DI=$(lotfield "$L" distributed); RE=$(lotfield "$L" returned); DP=$(lotfield "$L" disposed); RM=$(lotfield "$L" remaining)
check "6.4 invariant" "$R" "$((DI + RE + DP + RM))"
api POST "/lots/$L/receipt" "$RTOK" "{\"idem_key\":\"g6-ok\",\"expected_version\":5,\"received\":8}"
check "6.4 idem_key reused across routes rejected" 409 "$STATUS"

echo "-- 6.5 resolve-dispute --"
M=$(mk "$DTOK" "$RECEIVER_SUB" 10); wait_token "$M" >/dev/null 2>&1
api POST "/lots/$M/accept" "$RTOK" "{\"idem_key\":\"g6-m-acc\",\"expected_version\":1}"
api POST "/lots/$M/handoff" "$DTOK" "{\"idem_key\":\"g6-m-hnd\",\"expected_version\":2,\"donor_handoff\":10}"
api POST "/lots/$M/receipt" "$RTOK" "{\"idem_key\":\"g6-m-rcp\",\"expected_version\":3,\"received\":8}"
check "6.5 dispute lot has count_dispute" True "$(lotfield "$M" count_dispute)"
api POST "/lots/$M/resolve-dispute" "$DTOK" "{\"idem_key\":\"g6-r1\",\"expected_version\":4,\"reconciled_received\":9}"
check "6.5 donor resolve denied" 403 "$STATUS"
api POST "/lots/$M/resolve-dispute" "$RTOK" "{\"idem_key\":\"g6-r2\",\"expected_version\":4,\"reconciled_received\":9}"
check "6.5 receiver resolve denied" 403 "$STATUS"
api POST "/lots/$M/distribution" "$RTOK" "{\"idem_key\":\"g6-m-dist\",\"expected_version\":4,\"distributed\":5}"
api POST "/lots/$M/resolve-dispute" "$CTOK" "{\"idem_key\":\"g6-r3\",\"expected_version\":5,\"reconciled_received\":4}"
check "6.5 reconciled below distributed rejected" 409 "$STATUS"
api POST "/lots/$M/resolve-dispute" "$CTOK" "{\"idem_key\":\"g6-r4\",\"expected_version\":5,\"reconciled_received\":9}"
check "6.5 coordinator resolve ok" 200 "$STATUS"
check "6.5 dispute cleared" False "$(lotfield "$M" count_dispute)"
check "6.5 received updated" 9 "$(lotfield "$M" received)"
check "6.5 remaining recomputed" 4 "$(lotfield "$M" remaining)"
api POST "/lots/$L/resolve-dispute" "$CTOK" "{\"idem_key\":\"g6-r5\",\"expected_version\":5,\"reconciled_received\":8}"
check "6.5 no dispute -> 409" 409 "$STATUS"

echo "-- 6.6 GET /lots visibility --"
api GET /lots "$DTOK"; check "6.6 donor list" 200 "$STATUS"
DL=$(printf '%s' "$BODY" | python3 -c 'import json,sys;l=json.load(sys.stdin)["lots"];print(all(x["donor_sub"]==sys.argv[1] for x in l) and len(l)>0)' "$DONOR_SUB")
check "6.6 donor sees only own lots" True "$DL"
api GET /lots "$RTOK"
RL=$(printf '%s' "$BODY" | python3 -c 'import json,sys;l=json.load(sys.stdin)["lots"];print(all(x["receiver_sub"]==sys.argv[1] for x in l) and len(l)>0)' "$RECEIVER_SUB")
check "6.6 receiver sees only assigned lots" True "$RL"
check "6.6 no task_token in list" 0 "$(printf '%s' "$BODY" | grep -c task_token)"
api GET /lots "$CTOK"
CL=$(printf '%s' "$BODY" | python3 -c 'import json,sys;l=json.load(sys.stdin)["lots"];print(any(x["lot_id"]==sys.argv[1] for x in l) and any(x["lot_id"]==sys.argv[2] for x in l))' "$L" "$M")
check "6.6 coordinator sees all lots" True "$CL"
api GET "/lots/$L" "$CTOK"; check "6.6 coordinator can read a lot" 200 "$STATUS"

echo "=========== GATE 5: filmability / evidence ==========="
echo "-- 5.1 a live execution waiting in WaitForReceiver --"
api POST /lots "$DTOK" "{\"receiver_sub\":\"$RECEIVER_SUB\",\"offered\":10}"
F=$(J "['lot']['lot_id']"); RID_CREATE=$(J "['request_id']"); EXEC_F=$(J "['lot']['exec_arn']")
echo "lot F = $F"; echo "execution F = $EXEC_F"
wait_token "$F" >/dev/null 2>&1
STF=$(aws stepfunctions describe-execution --execution-arn "$EXEC_F" --query status --output text)
STATE_F=$(aws stepfunctions get-execution-history --execution-arn "$EXEC_F" --reverse-order \
  --query "events[?type=='TaskStateEntered'].stateEnteredEventDetails.name | [0]" --output text)
SUB_F=$(aws stepfunctions get-execution-history --execution-arn "$EXEC_F" \
  --query "events[?type=='TaskSubmitted'] | length(@)" --output text)
echo "execution F status=$STF waiting state=$STATE_F task-submitted=$SUB_F"
check "5.1 execution F durable-waiting" RUNNING "$STF"
check "5.1 waiting state is WaitForReceiver" WaitForReceiver "$STATE_F"
check "5.1 wait task submitted (token parked)" 1 "$SUB_F"

echo "-- 5.1b the task token is server-only (never in any API response) --"
TOKVAL=$(dbitem "$F" | python3 -c 'import json,sys;print(json.load(sys.stdin).get("task_token",{}).get("S",""))')
api GET "/lots/$F" "$DTOK"
if [ -n "$TOKVAL" ] && ! printf '%s' "$BODY" | grep -qF "$TOKVAL" && ! printf '%s' "$BODY" | grep -q task_token; then ok=yes; else ok=no; fi
check "5.1b raw task token absent from API GET response" yes "$ok"

echo "-- 5.2 donor denial body (actor + action + request id) --"
api POST "/lots/$F/distribution" "$DTOK" "{\"idem_key\":\"g5-donor\",\"expected_version\":1,\"distributed\":1}"
RID_DENY=$(J "['request_id']"); echo "donor status=$STATUS body=$BODY"
check "5.2 donor denied" 403 "$STATUS"
check "5.2 denial names actor" "$DONOR_SUB" "$(J "['actor']")"
check "5.2 denial names action" ReportDistribution "$(J "['action']")"

echo "-- 5.3 receiver success advances the SAME execution --"
api POST "/lots/$F/accept" "$RTOK" "{\"idem_key\":\"g5-accept\",\"expected_version\":1}"
RID_OK=$(J "['request_id']"); echo "receiver status=$STATUS body=$BODY"
check "5.3 receiver allowed" 200 "$STATUS"
sleep 4
STF2=$(aws stepfunctions describe-execution --execution-arn "$EXEC_F" --query status --output text)
SUCC=$(aws stepfunctions get-execution-history --execution-arn "$EXEC_F" \
  --query "events[?type=='ExecutionSucceeded'] | length(@)" --output text)
check "5.3 same execution advanced to SUCCEEDED" SUCCEEDED "$STF2"
check "5.3 execution reached Succeeded" 1 "$SUCC"

echo "-- 5.4 CloudWatch structured lines (request id <-> lot id <-> version <-> exec arn) --"
pull_logs() { LOGALL=$(aws logs filter-log-events --log-group-name /aws/lambda/pantrypass-api \
  --start-time $(( (NOW - 1800) * 1000 )) --query 'events[].message' --output text 2>/dev/null); }
grep_lot() { printf '%s\n' "$LOGALL" | grep -F "$F" | grep -F "$1" | head -1; }
for i in $(seq 1 10); do
  pull_logs
  LC=$(grep_lot '"action": "CreateLot"'); LD=$(grep_lot '"decision": "DENY"'); LO=$(grep_lot '"action": "Accept"')
  [ -n "$LC" ] && [ -n "$LD" ] && [ -n "$LO" ] && break
  sleep 3
done
echo "create log: $LC"
echo "deny   log: $LD"
echo "allow  log: $LO"
if printf '%s' "$LC" | grep -q "$EXEC_F"; then ok=yes; else ok=no; fi
check "5.4 create line carries lot id + execution ARN" yes "$ok"
if printf '%s' "$LD" | grep -q '"request_id"' && printf '%s' "$LD" | grep -qi 'DENY'; then ok=yes; else ok=no; fi
check "5.4 DENY line carries request id + decision" yes "$ok"
if printf '%s' "$LO" | grep -q '"version"' && printf '%s' "$LO" | grep -qi 'ALLOW'; then ok=yes; else ok=no; fi
check "5.4 ALLOW line carries version + decision" yes "$ok"
echo "NOTE: the only available lots are synthetic -> PRODUCT/IMPACT pass remains UNVERIFIED."

echo "=========== RESULT ==========="
if [ "$FAILED" = "0" ]; then echo "ALL GATES 2-5 PASS"; else echo "ONE OR MORE CHECKS FAILED"; fi
exit $FAILED
