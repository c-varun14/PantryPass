#!/usr/bin/env bash
# Usage: 40_lambda.sh [name ...]   (names: wait_task escalate api). Default: every backend file that exists.
set -euo pipefail
cd "$(dirname "$0")/.."
source infra/00_env.sh
: "${ROLE_ARN:?run infra/05_iam.sh first}"
mkdir -p .build

names=("$@")
if [ ${#names[@]} -eq 0 ]; then
  for n in wait_task escalate api; do [ -f backend/$n.py ] && names+=($n); done
fi

for n in "${names[@]}"; do
  fn=${PREFIX}-${n//_/-}
  (cd backend && rm -f "../.build/$n.zip"; zip -q -j "../.build/$n.zip" "$n.py" trust.py rewards.py)
  # JSON form: shorthand rejects empty values, and POLICY_STORE_ID / STATE_MACHINE_ARN may not exist yet
  env_vars=$(LOTS_TABLE=$LOTS_TABLE EVENTS_TABLE=$EVENTS_TABLE POLICY_STORE_ID=${POLICY_STORE_ID:-} STATE_MACHINE_ARN=${STATE_MACHINE_ARN:-} CUTOFF_SECONDS=${CUTOFF_SECONDS:-} \
    python3 -I -c 'import json,os; print(json.dumps({"Variables":{k:os.environ[k] for k in ("LOTS_TABLE","EVENTS_TABLE","POLICY_STORE_ID","STATE_MACHINE_ARN","CUTOFF_SECONDS") if os.environ.get(k)}}))')
  if aws lambda get-function --function-name "$fn" >/dev/null 2>&1; then
    aws lambda update-function-code --function-name "$fn" --zip-file "fileb://.build/$n.zip" >/dev/null
    aws lambda wait function-updated --function-name "$fn"
    aws lambda update-function-configuration --function-name "$fn" --environment "$env_vars" >/dev/null
    echo "updated $fn"
  else
    # a freshly created IAM role can take several seconds to become assumable
    for i in 1 2 3 4 5 6; do
      if aws lambda create-function --function-name "$fn" --runtime python3.12 --handler "$n.handler" \
           --role "$ROLE_ARN" --zip-file "fileb://.build/$n.zip" --timeout 20 --memory-size 256 \
           --environment "$env_vars" --tags $TAG_KEY=$TAG_VALUE >/dev/null 2>.build/err.txt; then
        echo "created $fn"; break
      fi
      cat .build/err.txt
      grep -q "cannot be assumed" .build/err.txt || { echo "non-transient error, giving up"; exit 1; }
      echo "role not ready, retrying ($i)..."; sleep 5
    done
  fi
done
