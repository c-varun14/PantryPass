#!/usr/bin/env bash
# X-Ray on the Lambdas and the state machine, log metric filters, a CloudWatch dashboard,
# and throttling on the API stage. Safe to re-run.
set -euo pipefail
cd "$(dirname "$0")/.."
source infra/00_env.sh
: "${API_ID:?run infra/60_api.sh first}"
: "${STATE_MACHINE_ARN:?run infra/50_stepfn.sh first}"

# X-Ray write permission for both Lambda roles (inline policy, additive)
for role in "$ROLE_NAME" ${PREFIX}-channel-role; do
  aws iam get-role --role-name "$role" >/dev/null 2>&1 || continue
  aws iam put-role-policy --role-name "$role" --policy-name ${PREFIX}-xray \
    --policy-document '{"Version":"2012-10-17","Statement":[{"Effect":"Allow","Action":["xray:PutTraceSegments","xray:PutTelemetryRecords"],"Resource":"*"}]}'
done
aws iam put-role-policy --role-name "$SFN_ROLE_NAME" --policy-name ${PREFIX}-xray \
  --policy-document '{"Version":"2012-10-17","Statement":[{"Effect":"Allow","Action":["xray:PutTraceSegments","xray:PutTelemetryRecords","xray:GetSamplingRules","xray:GetSamplingTargets"],"Resource":"*"}]}'
sleep 5

FUNCS="wait-task escalate api api-go channel notifier"
for f in $FUNCS; do
  fn=${PREFIX}-$f
  aws lambda get-function --function-name "$fn" >/dev/null 2>&1 || { echo "skip $fn (not deployed)"; continue; }
  aws lambda update-function-configuration --function-name "$fn" --tracing-config Mode=Active >/dev/null
  aws lambda wait function-updated --function-name "$fn"
  echo "xray on $fn"
done
aws stepfunctions update-state-machine --state-machine-arn "$STATE_MACHINE_ARN" --tracing-configuration enabled=true >/dev/null
echo "xray on state machine"

# Metrics from the structured log lines the API already writes
NS=PantryPass
mf() { # log-group filter-name pattern metric
  aws logs describe-log-groups --log-group-name-prefix "$1" --query 'logGroups[0].logGroupName' --output text | grep -qx "$1" || { echo "skip filter $2 (no log group yet)"; return; }
  aws logs put-metric-filter --log-group-name "$1" --filter-name "$2" --filter-pattern "$3" \
    --metric-transformations metricName="$4",metricNamespace=$NS,metricValue=1,defaultValue=0
  echo "metric filter $2"
}
mf /aws/lambda/${PREFIX}-api denies '{ $.decision = "DENY" }' Denies
mf /aws/lambda/${PREFIX}-api callback-retries '{ $.msg = "send_task_success_failed" }' CallbackFailures
mf /aws/lambda/${PREFIX}-escalate exceptions '{ $.msg = "escalated" }' Exceptions
mf /aws/lambda/${PREFIX}-channel chat-commands '{ $.msg = "chat_command" }' ChatCommands
mf /aws/lambda/${PREFIX}-channel bad-signatures '{ $.msg = "bad_signature" }' BadSignatures

SM_NAME=${STATE_MACHINE_ARN##*:}
DASH=$(cat <<JSON
{"widgets":[
 {"type":"metric","x":0,"y":0,"width":12,"height":6,"properties":{"title":"API requests, 4xx and 5xx","region":"$REGION","stat":"Sum","period":60,
  "metrics":[["AWS/ApiGateway","Count","ApiId","$API_ID"],[".","4xx",".","."],[".","5xx",".","."]]}},
 {"type":"metric","x":12,"y":0,"width":12,"height":6,"properties":{"title":"Verified Permissions denies and exceptions","region":"$REGION","stat":"Sum","period":300,
  "metrics":[["$NS","Denies"],[".","Exceptions"],[".","CallbackFailures"]]}},
 {"type":"metric","x":0,"y":6,"width":12,"height":6,"properties":{"title":"Lot flow executions","region":"$REGION","stat":"Sum","period":300,
  "metrics":[["AWS/States","ExecutionsStarted","StateMachineArn","$STATE_MACHINE_ARN"],[".","ExecutionsSucceeded",".","."],[".","ExecutionsFailed",".","."],[".","ExecutionsTimedOut",".","."]]}},
 {"type":"metric","x":12,"y":6,"width":12,"height":6,"properties":{"title":"Lambda errors","region":"$REGION","stat":"Sum","period":300,
  "metrics":[["AWS/Lambda","Errors","FunctionName","${PREFIX}-api"],[".",".",".","${PREFIX}-api-go"],[".",".",".","${PREFIX}-channel"],[".",".",".","${PREFIX}-notifier"]]}},
 {"type":"metric","x":0,"y":12,"width":12,"height":6,"properties":{"title":"Chat commands and rejected webhook signatures","region":"$REGION","stat":"Sum","period":300,
  "metrics":[["$NS","ChatCommands"],[".","BadSignatures"]]}}
]}
JSON
)
aws cloudwatch put-dashboard --dashboard-name PantryPass --dashboard-body "$DASH" >/dev/null
echo "dashboard PantryPass"

# Throttle the whole stage so a runaway client cannot run up Lambda/Verified Permissions cost
aws apigatewayv2 update-stage --api-id "$API_ID" --stage-name '$default' \
  --default-route-settings ThrottlingBurstLimit=50,ThrottlingRateLimit=25 >/dev/null
echo "stage throttling 25 rps, burst 50"
