#!/usr/bin/env bash
# Chat channel: links table, events stream, secret, channel + notifier Lambdas, webhook routes.
# Reads WhatsApp values and phone numbers from the gitignored .secrets.local (never echoed).
# Safe to re-run; re-run after filling in .secrets.local to replace the placeholder secret.
set -euo pipefail
cd "$(dirname "$0")/.."
source infra/00_env.sh
: "${ROLE_ARN:?run infra/05_iam.sh first}"
: "${API_ID:?run infra/60_api.sh first}"
SECRETS_FILE=.secrets.local
LINKS_TABLE=${PREFIX}-links
SECRET_NAME=pantrypass/channel
CH_ROLE=${PREFIX}-channel-role
mkdir -p .build

sec() { # key -> value from .secrets.local, empty if absent
  [ -f "$SECRETS_FILE" ] && grep -m1 "^$1=" "$SECRETS_FILE" | cut -d= -f2- || true
}

# ---- links table (phone -> sub, role) ----
if ! aws dynamodb describe-table --table-name "$LINKS_TABLE" >/dev/null 2>&1; then
  aws dynamodb create-table --table-name "$LINKS_TABLE" --billing-mode PAY_PER_REQUEST \
    --attribute-definitions AttributeName=phone,AttributeType=S --key-schema AttributeName=phone,KeyType=HASH \
    --tags Key=$TAG_KEY,Value=$TAG_VALUE >/dev/null
  aws dynamodb wait table-exists --table-name "$LINKS_TABLE"
  echo "created $LINKS_TABLE"
else echo "table $LINKS_TABLE exists"; fi

# ---- stream on the events table ----
STREAM_ARN=$(aws dynamodb describe-table --table-name "$EVENTS_TABLE" --query Table.LatestStreamArn --output text)
if [ "$STREAM_ARN" = "None" ] || [ -z "$STREAM_ARN" ]; then
  aws dynamodb update-table --table-name "$EVENTS_TABLE" \
    --stream-specification StreamEnabled=true,StreamViewType=NEW_IMAGE >/dev/null
  sleep 5
  STREAM_ARN=$(aws dynamodb describe-table --table-name "$EVENTS_TABLE" --query Table.LatestStreamArn --output text)
  echo "enabled stream"
fi

# ---- secret ----
WA_APP_SECRET=$(sec WA_APP_SECRET); WA_VERIFY_TOKEN=$(sec WA_VERIFY_TOKEN)
WA_PHONE_NUMBER_ID=$(sec WA_PHONE_NUMBER_ID); WA_ACCESS_TOKEN=$(sec WA_ACCESS_TOKEN)
REAL=1
if [ -z "$WA_APP_SECRET" ] || [ -z "$WA_VERIFY_TOKEN" ]; then
  REAL=0
  WA_APP_SECRET=${WA_APP_SECRET:-$(python3 -c 'import secrets;print(secrets.token_hex(16))')}
  WA_VERIFY_TOKEN=${WA_VERIFY_TOKEN:-$(python3 -c 'import secrets;print(secrets.token_hex(8))')}
  echo "NOTE: WA_* values missing in $SECRETS_FILE; storing PLACEHOLDER secret (WhatsApp will not work until you fill it and re-run)"
fi
SECRET_JSON=$(WA_APP_SECRET=$WA_APP_SECRET WA_VERIFY_TOKEN=$WA_VERIFY_TOKEN WA_PHONE_NUMBER_ID=$WA_PHONE_NUMBER_ID WA_ACCESS_TOKEN=$WA_ACCESS_TOKEN \
  python3 -I -c 'import json,os;print(json.dumps({k:os.environ[k] for k in ("WA_APP_SECRET","WA_VERIFY_TOKEN","WA_PHONE_NUMBER_ID","WA_ACCESS_TOKEN")}))')
if aws secretsmanager describe-secret --secret-id "$SECRET_NAME" >/dev/null 2>&1; then
  # never overwrite real values with a placeholder
  if [ "$REAL" = 1 ]; then aws secretsmanager put-secret-value --secret-id "$SECRET_NAME" --secret-string "$SECRET_JSON" >/dev/null; echo "secret updated"; else echo "secret exists (kept)"; fi
else
  aws secretsmanager create-secret --name "$SECRET_NAME" --secret-string "$SECRET_JSON" --tags Key=$TAG_KEY,Value=$TAG_VALUE >/dev/null
  echo "secret created"
fi
SECRET_ARN=$(aws secretsmanager describe-secret --secret-id "$SECRET_NAME" --query ARN --output text)

# ---- role (least privilege for the channel + notifier) ----
if ! aws iam get-role --role-name "$CH_ROLE" >/dev/null 2>&1; then
  aws iam create-role --role-name "$CH_ROLE" --tags Key=$TAG_KEY,Value=$TAG_VALUE \
    --assume-role-policy-document '{"Version":"2012-10-17","Statement":[{"Effect":"Allow","Principal":{"Service":"lambda.amazonaws.com"},"Action":"sts:AssumeRole"}]}' >/dev/null
fi
T="arn:aws:dynamodb:$REGION:$ACCOUNT_ID:table"
aws iam put-role-policy --role-name "$CH_ROLE" --policy-name ${PREFIX}-channel-inline --policy-document "{
 \"Version\":\"2012-10-17\",\"Statement\":[
  {\"Effect\":\"Allow\",\"Action\":[\"logs:CreateLogGroup\",\"logs:CreateLogStream\",\"logs:PutLogEvents\"],\"Resource\":\"arn:aws:logs:$REGION:$ACCOUNT_ID:*\"},
  {\"Effect\":\"Allow\",\"Action\":[\"dynamodb:GetItem\",\"dynamodb:PutItem\",\"dynamodb:UpdateItem\",\"dynamodb:Query\",\"dynamodb:Scan\",\"dynamodb:TransactWriteItems\"],
   \"Resource\":[\"$T/$LOTS_TABLE\",\"$T/$EVENTS_TABLE\",\"$T/$LINKS_TABLE\"]},
  {\"Effect\":\"Allow\",\"Action\":[\"dynamodb:DescribeStream\",\"dynamodb:GetRecords\",\"dynamodb:GetShardIterator\",\"dynamodb:ListStreams\"],\"Resource\":\"$T/$EVENTS_TABLE/stream/*\"},
  {\"Effect\":\"Allow\",\"Action\":[\"states:SendTaskSuccess\",\"states:SendTaskFailure\",\"states:StartExecution\"],\"Resource\":\"*\"},
  {\"Effect\":\"Allow\",\"Action\":\"verifiedpermissions:IsAuthorized\",\"Resource\":\"*\"},
  {\"Effect\":\"Allow\",\"Action\":\"secretsmanager:GetSecretValue\",\"Resource\":\"$SECRET_ARN\"},
  {\"Effect\":\"Allow\",\"Action\":\"lambda:InvokeFunction\",\"Resource\":\"arn:aws:lambda:$REGION:$ACCOUNT_ID:function:${PREFIX}-api-go\"}
 ]}"
CH_ROLE_ARN=$(aws iam get-role --role-name "$CH_ROLE" --query Role.Arn --output text)

# ---- Lambdas ----
deploy_fn() { # name handler files...
  local name=$1 handler=$2; shift 2
  local fn=${PREFIX}-$name zip=".build/$name.zip"
  rm -f "$zip"; (cd backend && zip -q -j "../$zip" "$@")
  local env
  env=$(LOTS_TABLE=$LOTS_TABLE EVENTS_TABLE=$EVENTS_TABLE LINKS_TABLE=$LINKS_TABLE POLICY_STORE_ID=${POLICY_STORE_ID:-} \
    STATE_MACHINE_ARN=${STATE_MACHINE_ARN:-} CHANNEL_SECRET_ID=$SECRET_NAME GO_FUNCTION=${PREFIX}-api-go \
    CHANNEL_TRANSPORT=${CHANNEL_TRANSPORT:-whatsapp} \
    python3 -I -c 'import json,os;print(json.dumps({"Variables":{k:os.environ[k] for k in ("LOTS_TABLE","EVENTS_TABLE","LINKS_TABLE","POLICY_STORE_ID","STATE_MACHINE_ARN","CHANNEL_SECRET_ID","GO_FUNCTION","CHANNEL_TRANSPORT") if os.environ.get(k)}}))')
  if aws lambda get-function --function-name "$fn" >/dev/null 2>&1; then
    aws lambda update-function-code --function-name "$fn" --zip-file "fileb://$zip" >/dev/null
    aws lambda wait function-updated --function-name "$fn"
    aws lambda update-function-configuration --function-name "$fn" --environment "$env" >/dev/null
    echo "updated $fn"
  else
    for i in 1 2 3 4 5 6; do
      if aws lambda create-function --function-name "$fn" --runtime python3.12 --handler "$handler" --role "$CH_ROLE_ARN" \
           --zip-file "fileb://$zip" --timeout 25 --memory-size 256 --environment "$env" --tags $TAG_KEY=$TAG_VALUE >/dev/null 2>.build/err.txt; then
        echo "created $fn"; break
      fi
      grep -q "cannot be assumed" .build/err.txt || { cat .build/err.txt; exit 1; }
      sleep 5
    done
  fi
}
deploy_fn channel channel.handler channel.py api.py chatio.py chatlogic.py trust.py
deploy_fn notifier notifier.handler notifier.py chatio.py chatlogic.py

# ---- webhook routes (no JWT authorizer: Meta cannot sign in; the HMAC signature is the gate) ----
CH_ARN=arn:aws:lambda:$REGION:$ACCOUNT_ID:function:${PREFIX}-channel
CH_INT=$(aws apigatewayv2 get-integrations --api-id "$API_ID" --query "Items[?IntegrationUri=='$CH_ARN'].IntegrationId | [0]" --output text)
if [ "$CH_INT" = "None" ] || [ -z "$CH_INT" ]; then
  CH_INT=$(aws apigatewayv2 create-integration --api-id "$API_ID" --integration-type AWS_PROXY --integration-uri "$CH_ARN" \
    --payload-format-version 2.0 --integration-method POST --query IntegrationId --output text)
fi
EXISTING=$(aws apigatewayv2 get-routes --api-id "$API_ID" --query 'Items[].RouteKey' --output text)
for key in 'GET /webhook/whatsapp' 'POST /webhook/whatsapp'; do
  if printf '%s\n' "$EXISTING" | tr '\t' '\n' | grep -qx "$key"; then echo "route exists: $key"; else
    aws apigatewayv2 create-route --api-id "$API_ID" --route-key "$key" --authorization-type NONE --target "integrations/$CH_INT" >/dev/null
    echo "created route: $key"
  fi
done
aws lambda add-permission --function-name ${PREFIX}-channel --statement-id apigw-invoke --action lambda:InvokeFunction \
  --principal apigateway.amazonaws.com --source-arn "arn:aws:execute-api:$REGION:$ACCOUNT_ID:$API_ID/*" >/dev/null 2>&1 || true

# ---- stream -> notifier ----
if ! aws lambda list-event-source-mappings --function-name ${PREFIX}-notifier --query 'EventSourceMappings[0].UUID' --output text | grep -qv None; then
  aws lambda create-event-source-mapping --function-name ${PREFIX}-notifier --event-source-arn "$STREAM_ARN" \
    --starting-position LATEST --batch-size 10 >/dev/null
  echo "stream mapped to notifier"
else echo "stream mapping exists"; fi

# ---- seed links from .secrets.local ----
link() { # phone-var role username
  local phone sub
  phone=$(sec "$1"); [ -n "$phone" ] || { echo "skip link $2: $1 not set"; return; }
  sub=$(aws cognito-idp admin-get-user --user-pool-id "$COGNITO_POOL_ID" --username "$3" --query "UserAttributes[?Name=='sub'].Value | [0]" --output text)
  phone=$(printf '%s' "$phone" | tr -cd '0-9')
  aws dynamodb put-item --table-name "$LINKS_TABLE" --item "{\"phone\":{\"S\":\"$phone\"},\"sub\":{\"S\":\"$sub\"},\"role\":{\"S\":\"$2\"}}" >/dev/null
  echo "linked $2 ($3)"
}
link PHONE_DONOR donor donor1
link PHONE_RECEIVER receiver receiver1
link PHONE_COORDINATOR coordinator coordinator1

echo "webhook: $API_URL/webhook/whatsapp  (verify token and app secret are in $SECRET_NAME)"
