#!/usr/bin/env bash
# Usage: 41_lambda_go.sh   Builds backend/go as a provided.al2023 arm64 bootstrap and creates or updates ${PREFIX}-api-go.
set -euo pipefail
cd "$(dirname "$0")/.."
ROOT="$(pwd)"
source infra/00_env.sh
: "${ROLE_ARN:?run infra/05_iam.sh first}"
GO="${GO:-/home/varun/.local/go1.26.5/bin/go}"
mkdir -p .build/go

fn=${PREFIX}-api-go
# Cross-compile for Lambda arm64 (no cgo, no RPC layer). The module lives in backend/go.
(cd backend/go && CGO_ENABLED=0 GOOS=linux GOARCH=arm64 "$GO" build -tags lambda.norpc -o "$ROOT/.build/go/bootstrap" .)
(cd .build/go && rm -f api-go.zip && zip -q -j api-go.zip bootstrap)

# JSON form: shorthand rejects empty values, and POLICY_STORE_ID may not exist yet
env_vars=$(LOTS_TABLE=$LOTS_TABLE EVENTS_TABLE=$EVENTS_TABLE POLICY_STORE_ID=${POLICY_STORE_ID:-} CUTOFF_SECONDS=${CUTOFF_SECONDS:-} \
  python3 -I -c 'import json,os; print(json.dumps({"Variables":{k:os.environ[k] for k in ("LOTS_TABLE","EVENTS_TABLE","POLICY_STORE_ID","CUTOFF_SECONDS") if os.environ.get(k)}}))')

if aws lambda get-function --function-name "$fn" >/dev/null 2>&1; then
  aws lambda update-function-code --function-name "$fn" --zip-file "fileb://.build/go/api-go.zip" >/dev/null
  aws lambda wait function-updated --function-name "$fn"
  aws lambda update-function-configuration --function-name "$fn" --environment "$env_vars" >/dev/null
  echo "updated $fn"
else
  # a freshly created IAM role can take several seconds to become assumable
  for i in 1 2 3 4 5 6; do
    if aws lambda create-function --function-name "$fn" --runtime provided.al2023 --handler bootstrap \
         --architectures arm64 --role "$ROLE_ARN" --zip-file "fileb://.build/go/api-go.zip" \
         --timeout 20 --memory-size 256 --environment "$env_vars" --tags $TAG_KEY=$TAG_VALUE \
         >/dev/null 2>.build/err.txt; then
      echo "created $fn"; break
    fi
    cat .build/err.txt
    grep -q "cannot be assumed" .build/err.txt || { echo "non-transient error, giving up"; exit 1; }
    echo "role not ready, retrying ($i)..."; sleep 5
  done
fi
