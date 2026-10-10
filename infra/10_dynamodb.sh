#!/usr/bin/env bash
set -euo pipefail
source "$(dirname "$0")/00_env.sh"

create_table() {
  local name=$1 sk=${2:-}
  if aws dynamodb describe-table --table-name "$name" >/dev/null 2>&1; then
    echo "table $name exists"; return
  fi
  local keys=(AttributeName=lot_id,AttributeType=S) schema=(AttributeName=lot_id,KeyType=HASH)
  if [ -n "$sk" ]; then
    keys+=(AttributeName=$sk,AttributeType=S); schema+=(AttributeName=$sk,KeyType=RANGE)
  fi
  aws dynamodb create-table --table-name "$name" --billing-mode PAY_PER_REQUEST \
    --attribute-definitions "${keys[@]}" --key-schema "${schema[@]}" \
    --tags Key=$TAG_KEY,Value=$TAG_VALUE >/dev/null
  aws dynamodb wait table-exists --table-name "$name"
  echo "created $name"
}
create_table "$LOTS_TABLE"
create_table "$EVENTS_TABLE" event_id
