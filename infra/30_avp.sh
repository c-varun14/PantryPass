#!/usr/bin/env bash
# Verified Permissions: one policy store, the Cedar schema, and the three policies.
# Types are namespaced (PantryPass::User / PantryPass::Lot / PantryPass::Action).
set -euo pipefail
cd "$(dirname "$0")/.."
source infra/00_env.sh
OUT=infra/.env.generated
touch "$OUT"

upsert_env() {
  local key=$1 val=$2
  grep -v "^export ${key}=" "$OUT" > "$OUT.tmp" 2>/dev/null || true
  { cat "$OUT.tmp"; echo "export ${key}=${val}"; } > "$OUT"
  rm -f "$OUT.tmp"
}

DESC=${PREFIX}-policy-store
PS=$(aws verifiedpermissions list-policy-stores \
  --query "policyStores[?description=='$DESC'].policyStoreId | [0]" --output text)
if [ "$PS" = "None" ] || [ -z "$PS" ]; then
  PS=$(aws verifiedpermissions create-policy-store --validation-settings '{"mode":"STRICT"}' \
    --description "$DESC" --query policyStoreId --output text)
  echo "created policy store $PS"
else
  echo "policy store exists $PS"
fi

DEF=$(python3 -I -c 'import json;print(json.dumps({"cedarJson":open("backend/schema.json").read()}))')
aws verifiedpermissions put-schema --policy-store-id "$PS" --definition "$DEF" >/dev/null
echo "schema uploaded"

create_policy() {
  local pname=$1 file=$2 attempt
  local existing
  existing=$(aws verifiedpermissions list-policies --policy-store-id "$PS" --query 'policies[].name' --output text 2>/dev/null || true)
  if printf '%s\n' "$existing" | tr '\t' '\n' | grep -qx "name/$pname" 2>/dev/null; then
    echo "policy $pname exists"; return
  fi
  local def
  def=$(python3 -I -c 'import json,sys;print(json.dumps({"static":{"statement":open(sys.argv[1]).read()}}))' "$file")
  for attempt in 1 2 3 4 5 6; do
    if out=$(aws verifiedpermissions create-policy --policy-store-id "$PS" \
              --definition "$def" --name "name/$pname" --cli-error-format json 2>&1); then
      echo "created policy $pname"; return
    fi
    if printf '%s' "$out" | grep -qiE 'conflict|already exists'; then
      echo "policy $pname exists"; return
    fi
    if printf '%s' "$out" | grep -qi 'No schema present'; then
      echo "schema not propagated yet, retrying ($attempt)"; sleep 3; continue
    fi
    echo "$out"; return 1
  done
  echo "gave up creating policy $pname"; return 1
}

create_policy create   backend/policies/01_create.cedar
create_policy receiver backend/policies/02_receiver.cedar
create_policy handoff  backend/policies/03_handoff.cedar

upsert_env POLICY_STORE_ID "$PS"
echo "avp ready: $PS"
