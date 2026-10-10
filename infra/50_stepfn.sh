#!/usr/bin/env bash
set -euo pipefail
cd "$(dirname "$0")/.."
source infra/00_env.sh
: "${SFN_ROLE_ARN:?run infra/05_iam.sh first}"
WAIT_ARN=arn:aws:lambda:$REGION:$ACCOUNT_ID:function:${PREFIX}-wait-task
ESC_ARN=arn:aws:lambda:$REGION:$ACCOUNT_ID:function:${PREFIX}-escalate

# Standard workflow. TimeoutSeconds comes from the input so the test lot can use a short deadline.
cat > .build/definition.json <<JSON
{
  "Comment": "PantryPass lot flow: durable wait for the assigned receiver",
  "StartAt": "WaitForReceiver",
  "States": {
    "WaitForReceiver": {
      "Type": "Task",
      "Resource": "arn:aws:states:::lambda:invoke.waitForTaskToken",
      "Parameters": {
        "FunctionName": "$WAIT_ARN",
        "Payload": { "lot_id.\$": "\$.lot_id", "token.\$": "\$\$.Task.Token" }
      },
      "TimeoutSecondsPath": "\$.response_deadline_seconds",
      "ResultPath": "\$.receiver_result",
      "Catch": [ { "ErrorEquals": ["States.Timeout"], "ResultPath": "\$.error", "Next": "Escalate" } ],
      "Next": "Done"
    },
    "Escalate": {
      "Type": "Task",
      "Resource": "arn:aws:states:::lambda:invoke",
      "Parameters": { "FunctionName": "$ESC_ARN", "Payload": { "lot_id.\$": "\$.lot_id" } },
      "End": true
    },
    "Done": { "Type": "Succeed" }
  }
}
JSON

ARN=$(aws stepfunctions list-state-machines --query "stateMachines[?name=='$SFN_NAME'].stateMachineArn | [0]" --output text)
if [ "$ARN" = "None" ] || [ -z "$ARN" ]; then
  for i in 1 2 3 4 5 6; do
    if ARN=$(aws stepfunctions create-state-machine --name "$SFN_NAME" --type STANDARD \
         --role-arn "$SFN_ROLE_ARN" --definition file://.build/definition.json \
         --tags key=$TAG_KEY,value=$TAG_VALUE --query stateMachineArn --output text 2>.build/err.txt); then
      echo "created $ARN"; break
    fi
    cat .build/err.txt; echo "retrying ($i)..."; sleep 5
  done
else
  aws stepfunctions update-state-machine --state-machine-arn "$ARN" --definition file://.build/definition.json >/dev/null
  echo "updated $ARN"
fi
OUT=infra/.env.generated
grep -v '^export STATE_MACHINE_ARN=' "$OUT" > "$OUT.tmp" || true
{ cat "$OUT.tmp"; echo "export STATE_MACHINE_ARN=$ARN"; } > "$OUT"; rm -f "$OUT.tmp"
