#!/usr/bin/env bash
# Payout details: a KMS key that encrypts account numbers, a table for bank details and hand-recorded transfers,
# a least-privilege IAM policy for the API role, the routes, and a redeploy of the API Lambda. Safe to re-run.
#
# How it works: a donor adds bank details in the app; the API encrypts the account number with KMS (bound to the
# donor's id) before it is stored, and only ever returns it masked. A coordinator can reveal one donor's full
# details to make a transfer in their own bank, then records the transfer's reference. Nothing here moves money.
set -euo pipefail
cd "$(dirname "$0")/.."
source infra/00_env.sh
OUT=infra/.env.generated
TABLE=${PREFIX}-payouts
ALIAS=alias/${PREFIX}-payouts

# ---- 1. KMS key (rotation on) ----
KEY_ID=$(aws kms describe-key --key-id "$ALIAS" --query KeyMetadata.KeyId --output text 2>/dev/null || true)
if [ -z "$KEY_ID" ] || [ "$KEY_ID" = "None" ]; then
  KEY_ID=$(aws kms create-key --description "PantryPass payout account numbers" \
    --tags TagKey=$TAG_KEY,TagValue=$TAG_VALUE --query KeyMetadata.KeyId --output text)
  aws kms create-alias --alias-name "$ALIAS" --target-key-id "$KEY_ID"
  echo "created key $KEY_ID"
else
  echo "key exists $KEY_ID"
fi
aws kms enable-key-rotation --key-id "$KEY_ID"
KEY_ARN=$(aws kms describe-key --key-id "$KEY_ID" --query KeyMetadata.Arn --output text)

# ---- 2. table: one row per donor ("profile") plus one row per recorded transfer ("paid#...") ----
if aws dynamodb describe-table --table-name "$TABLE" >/dev/null 2>&1; then
  echo "table $TABLE exists"
else
  aws dynamodb create-table --table-name "$TABLE" --billing-mode PAY_PER_REQUEST \
    --attribute-definitions AttributeName=sub,AttributeType=S AttributeName=sk,AttributeType=S \
    --key-schema AttributeName=sub,KeyType=HASH AttributeName=sk,KeyType=RANGE \
    --sse-specification Enabled=true,SSEType=KMS,KMSMasterKeyId="$KEY_ARN" \
    --tags Key=$TAG_KEY,Value=$TAG_VALUE >/dev/null
  aws dynamodb wait table-exists --table-name "$TABLE"
  echo "created $TABLE"
fi
aws dynamodb update-continuous-backups --table-name "$TABLE" \
  --point-in-time-recovery-specification PointInTimeRecoveryEnabled=true >/dev/null || true

# ---- 3. IAM: the API role may read/write this table and use this one key, and can never delete a payout row ----
aws iam put-role-policy --role-name "$ROLE_NAME" --policy-name ${PREFIX}-payouts --policy-document "{
 \"Version\":\"2012-10-17\",\"Statement\":[
  {\"Sid\":\"PayoutRows\",\"Effect\":\"Allow\",\"Action\":[\"dynamodb:GetItem\",\"dynamodb:PutItem\",\"dynamodb:UpdateItem\",\"dynamodb:Query\"],
   \"Resource\":\"arn:aws:dynamodb:$REGION:$ACCOUNT_ID:table/$TABLE\"},
  {\"Sid\":\"PayoutKey\",\"Effect\":\"Allow\",\"Action\":[\"kms:Encrypt\",\"kms:Decrypt\"],\"Resource\":\"$KEY_ARN\"},
  {\"Sid\":\"PayoutsAreAppendOnly\",\"Effect\":\"Deny\",\"Action\":[\"dynamodb:DeleteItem\",\"dynamodb:BatchWriteItem\"],
   \"Resource\":\"arn:aws:dynamodb:$REGION:$ACCOUNT_ID:table/$TABLE\"}
 ]}"
echo "payout policy attached to $ROLE_NAME"

# ---- 4. remember the names, add the routes, redeploy the API ----
for kv in "PAYOUTS_TABLE=$TABLE" "KMS_KEY_ID=$KEY_ID"; do
  k=${kv%%=*}
  grep -v "^export ${k}=" "$OUT" > "$OUT.tmp" 2>/dev/null || true
  { cat "$OUT.tmp"; echo "export $kv"; } > "$OUT"; rm -f "$OUT.tmp"
done
export PAYOUTS_TABLE=$TABLE KMS_KEY_ID=$KEY_ID
bash infra/60_api.sh
bash infra/40_lambda.sh api
echo "payouts ready: $TABLE / $KEY_ID"
