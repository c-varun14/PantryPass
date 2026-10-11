#!/usr/bin/env bash
set -euo pipefail
source "$(dirname "$0")/00_env.sh"
OUT="$(dirname "$0")/.env.generated"

# ---- Lambda execution role ----
if ! aws iam get-role --role-name "$ROLE_NAME" >/dev/null 2>&1; then
  aws iam create-role --role-name "$ROLE_NAME" --tags Key=$TAG_KEY,Value=$TAG_VALUE \
    --assume-role-policy-document '{"Version":"2012-10-17","Statement":[{"Effect":"Allow","Principal":{"Service":"lambda.amazonaws.com"},"Action":"sts:AssumeRole"}]}' >/dev/null
fi
aws iam put-role-policy --role-name "$ROLE_NAME" --policy-name ${PREFIX}-lambda-inline --policy-document "{
 \"Version\":\"2012-10-17\",\"Statement\":[
  {\"Effect\":\"Allow\",\"Action\":[\"logs:CreateLogGroup\",\"logs:CreateLogStream\",\"logs:PutLogEvents\"],\"Resource\":\"arn:aws:logs:$REGION:$ACCOUNT_ID:*\"},
  {\"Effect\":\"Allow\",\"Action\":[\"dynamodb:GetItem\",\"dynamodb:PutItem\",\"dynamodb:UpdateItem\",\"dynamodb:Query\",\"dynamodb:Scan\",\"dynamodb:TransactWriteItems\"],
   \"Resource\":[\"arn:aws:dynamodb:$REGION:$ACCOUNT_ID:table/$LOTS_TABLE\",\"arn:aws:dynamodb:$REGION:$ACCOUNT_ID:table/$EVENTS_TABLE\"]},
  {\"Effect\":\"Allow\",\"Action\":[\"states:SendTaskSuccess\",\"states:SendTaskFailure\",\"states:StartExecution\"],\"Resource\":\"*\"},
  {\"Effect\":\"Allow\",\"Action\":[\"verifiedpermissions:IsAuthorized\"],\"Resource\":\"*\"}
 ]}"
ROLE_ARN=$(aws iam get-role --role-name "$ROLE_NAME" --query Role.Arn --output text)
# History is append-only: no code path edits or deletes an event, so IAM refuses it for our own role too.
aws iam put-role-policy --role-name "$ROLE_NAME" --policy-name ${PREFIX}-events-append-only --policy-document "{
 \"Version\":\"2012-10-17\",\"Statement\":[
  {\"Sid\":\"EventsAreAppendOnly\",\"Effect\":\"Deny\",\"Action\":[\"dynamodb:UpdateItem\",\"dynamodb:DeleteItem\",\"dynamodb:BatchWriteItem\"],
   \"Resource\":\"arn:aws:dynamodb:$REGION:$ACCOUNT_ID:table/$EVENTS_TABLE\"}
 ]}"

# ---- Step Functions role (invoke the two Lambdas) ----
if ! aws iam get-role --role-name "$SFN_ROLE_NAME" >/dev/null 2>&1; then
  aws iam create-role --role-name "$SFN_ROLE_NAME" --tags Key=$TAG_KEY,Value=$TAG_VALUE \
    --assume-role-policy-document '{"Version":"2012-10-17","Statement":[{"Effect":"Allow","Principal":{"Service":"states.amazonaws.com"},"Action":"sts:AssumeRole"}]}' >/dev/null
fi
aws iam put-role-policy --role-name "$SFN_ROLE_NAME" --policy-name ${PREFIX}-sfn-inline --policy-document "{
 \"Version\":\"2012-10-17\",\"Statement\":[
  {\"Effect\":\"Allow\",\"Action\":\"lambda:InvokeFunction\",\"Resource\":\"arn:aws:lambda:$REGION:$ACCOUNT_ID:function:${PREFIX}-*\"}]}"
SFN_ROLE_ARN=$(aws iam get-role --role-name "$SFN_ROLE_NAME" --query Role.Arn --output text)

grep -v '^export \(ROLE_ARN\|SFN_ROLE_ARN\)=' "$OUT" 2>/dev/null > "$OUT.tmp" || true
{ cat "$OUT.tmp" 2>/dev/null; echo "export ROLE_ARN=$ROLE_ARN"; echo "export SFN_ROLE_ARN=$SFN_ROLE_ARN"; } > "$OUT"
rm -f "$OUT.tmp"
echo "roles ready: $ROLE_ARN / $SFN_ROLE_ARN"
