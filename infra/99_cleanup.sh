#!/usr/bin/env bash
# Tears the whole PantryPass stack down in reverse dependency order.
# DESTRUCTIVE: deletes the data tables and every user. Requires typing the account id to proceed.
# Every step tolerates "already gone", so a half-deleted stack can be re-run.
set -uo pipefail
cd "$(dirname "$0")/.."
source infra/00_env.sh

echo "This will DELETE the PantryPass stack in account $ACCOUNT_ID ($REGION): site, API, Lambdas,"
echo "workflow, policy store, Cognito users, DynamoDB tables and IAM roles."
read -r -p "Type the account id to continue: " CONFIRM
[ "$CONFIRM" = "$ACCOUNT_ID" ] || { echo "aborted"; exit 1; }

step() { echo "-- $*"; }

# 1. CloudFront + web bucket
step "CloudFront and web bucket"
DIST_ID=$(aws cloudfront list-distributions --query "DistributionList.Items[?Comment=='${PREFIX}-web'].Id | [0]" --output text 2>/dev/null)
if [ -n "$DIST_ID" ] && [ "$DIST_ID" != "None" ]; then
  ETAG=$(aws cloudfront get-distribution-config --id "$DIST_ID" --query ETag --output text)
  aws cloudfront get-distribution-config --id "$DIST_ID" --query DistributionConfig > /tmp/pp-dist.json
  python3 -I -c 'import json;d=json.load(open("/tmp/pp-dist.json"));d["Enabled"]=False;json.dump(d,open("/tmp/pp-dist.json","w"))'
  aws cloudfront update-distribution --id "$DIST_ID" --if-match "$ETAG" --distribution-config file:///tmp/pp-dist.json >/dev/null
  echo "waiting for the distribution to disable (a few minutes)..."
  aws cloudfront wait distribution-deployed --id "$DIST_ID"
  ETAG=$(aws cloudfront get-distribution --id "$DIST_ID" --query ETag --output text)
  aws cloudfront delete-distribution --id "$DIST_ID" --if-match "$ETAG" && echo "deleted distribution"
  rm -f /tmp/pp-dist.json
fi
OAC_ID=$(aws cloudfront list-origin-access-controls --query "OriginAccessControlList.Items[?Name=='${PREFIX}-web-oac'].Id | [0]" --output text 2>/dev/null)
if [ -n "$OAC_ID" ] && [ "$OAC_ID" != "None" ]; then
  ETAG=$(aws cloudfront get-origin-access-control --id "$OAC_ID" --query ETag --output text)
  aws cloudfront delete-origin-access-control --id "$OAC_ID" --if-match "$ETAG" && echo "deleted OAC"
fi
BUCKET=${PREFIX}-web-${ACCOUNT_ID}
aws s3 rm "s3://$BUCKET" --recursive >/dev/null 2>&1
aws s3api delete-bucket --bucket "$BUCKET" 2>/dev/null && echo "deleted bucket"

# 2. API Gateway
step "HTTP API"
for id in $(aws apigatewayv2 get-apis --query "Items[?Name=='${PREFIX}-api'].ApiId" --output text); do
  aws apigatewayv2 delete-api --api-id "$id" && echo "deleted api $id"
done

# 3. Lambdas
step "Lambda functions"
for fn in $(aws lambda list-functions --query "Functions[?starts_with(FunctionName, '${PREFIX}-')].FunctionName" --output text); do
  aws lambda delete-function --function-name "$fn" && echo "deleted $fn"
done

# 4. Step Functions
step "State machine"
SM=$(aws stepfunctions list-state-machines --query "stateMachines[?name=='$SFN_NAME'].stateMachineArn | [0]" --output text)
[ -n "$SM" ] && [ "$SM" != "None" ] && aws stepfunctions delete-state-machine --state-machine-arn "$SM" && echo "deleted state machine"

# 5. Verified Permissions
step "Policy store"
if [ -n "${POLICY_STORE_ID:-}" ]; then
  aws verifiedpermissions delete-policy-store --policy-store-id "$POLICY_STORE_ID" && echo "deleted policy store"
fi

# 6. Cognito (deleting the pool removes its users, groups and clients)
step "Cognito user pool"
if [ -n "${COGNITO_POOL_ID:-}" ]; then
  aws cognito-idp delete-user-pool --user-pool-id "$COGNITO_POOL_ID" && echo "deleted user pool"
fi

# 7. DynamoDB
step "DynamoDB tables"
for t in "$LOTS_TABLE" "$EVENTS_TABLE" "${PREFIX}-payouts"; do
  aws dynamodb delete-table --table-name "$t" >/dev/null 2>&1 && echo "deleted $t"
done
# the payout key cannot be deleted at once: KMS schedules it (7 days is the minimum) and it can be cancelled
aws kms schedule-key-deletion --key-id "alias/${PREFIX}-payouts" --pending-window-in-days 7 >/dev/null 2>&1 && echo "scheduled payout key deletion"

# 8. IAM roles
step "IAM roles"
for r in "$ROLE_NAME" "$SFN_ROLE_NAME"; do
  for p in $(aws iam list-role-policies --role-name "$r" --query PolicyNames --output text 2>/dev/null); do
    aws iam delete-role-policy --role-name "$r" --policy-name "$p"
  done
  for a in $(aws iam list-attached-role-policies --role-name "$r" --query 'AttachedPolicies[].PolicyArn' --output text 2>/dev/null); do
    aws iam detach-role-policy --role-name "$r" --policy-arn "$a"
  done
  aws iam delete-role --role-name "$r" 2>/dev/null && echo "deleted role $r"
done

rm -f infra/.env.generated web/config.js
echo "cleanup finished. CloudWatch log groups /aws/lambda/${PREFIX}-* may remain; delete them in the console if wanted."
