#!/usr/bin/env bash
# HTTP API v2: JWT authorizer against the Cognito pool + the PantryPass routes.
set -euo pipefail
cd "$(dirname "$0")/.."
source infra/00_env.sh
OUT=infra/.env.generated
: "${COGNITO_POOL_ID:?run infra/20_cognito.sh first}"
: "${COGNITO_CLIENT_ID:?run infra/20_cognito.sh first}"
touch "$OUT"

upsert_env() {
  local key=$1 val=$2
  grep -v "^export ${key}=" "$OUT" > "$OUT.tmp" 2>/dev/null || true
  { cat "$OUT.tmp"; echo "export ${key}=${val}"; } > "$OUT"
  rm -f "$OUT.tmp"
}

API_NAME=${PREFIX}-api
AUTH_NAME=${PREFIX}-jwt
LAMBDA_ARN=arn:aws:lambda:$REGION:$ACCOUNT_ID:function:${PREFIX}-api

API_ID=$(aws apigatewayv2 get-apis --query "Items[?Name=='$API_NAME'].ApiId | [0]" --output text)
if [ "$API_ID" = "None" ] || [ -z "$API_ID" ]; then
  API_ID=$(aws apigatewayv2 create-api --name "$API_NAME" --protocol-type HTTP \
    --tags project=$TAG_VALUE --query ApiId --output text)
  echo "created api $API_ID"
else
  echo "api exists $API_ID"
fi

INTEGRATION_ID=$(aws apigatewayv2 get-integrations --api-id "$API_ID" \
  --query "Items[?IntegrationType=='AWS_PROXY'].IntegrationId | [0]" --output text)
if [ "$INTEGRATION_ID" = "None" ] || [ -z "$INTEGRATION_ID" ]; then
  INTEGRATION_ID=$(aws apigatewayv2 create-integration --api-id "$API_ID" \
    --integration-type AWS_PROXY --integration-uri "$LAMBDA_ARN" \
    --payload-format-version 2.0 --integration-method POST \
    --query IntegrationId --output text)
  echo "created integration $INTEGRATION_ID"
else
  echo "integration exists $INTEGRATION_ID"
fi

JWT_CONFIG="{\"Audience\":[\"$COGNITO_CLIENT_ID\"],\"Issuer\":\"$COGNITO_ISSUER\"}"
AUTH_ID=$(aws apigatewayv2 get-authorizers --api-id "$API_ID" \
  --query "Items[?Name=='$AUTH_NAME'].AuthorizerId | [0]" --output text)
if [ "$AUTH_ID" = "None" ] || [ -z "$AUTH_ID" ]; then
  AUTH_ID=$(aws apigatewayv2 create-authorizer --api-id "$API_ID" \
    --name "$AUTH_NAME" --authorizer-type JWT \
    --identity-source '$request.header.Authorization' \
    --jwt-configuration "$JWT_CONFIG" --query AuthorizerId --output text)
  echo "created authorizer $AUTH_ID"
else
  echo "authorizer exists $AUTH_ID"
fi

EXISTING_ROUTES=$(aws apigatewayv2 get-routes --api-id "$API_ID" --query 'Items[].RouteKey' --output text 2>/dev/null || true)
create_route() {
  local key=$1
  if printf '%s\n' "$EXISTING_ROUTES" | tr '\t' '\n' | grep -qx "$key"; then
    echo "route exists: $key"; return
  fi
  aws apigatewayv2 create-route --api-id "$API_ID" --route-key "$key" \
    --authorization-type JWT --authorizer-id "$AUTH_ID" \
    --target "integrations/$INTEGRATION_ID" >/dev/null
  echo "created route: $key"
}

create_route 'POST /lots'
create_route 'POST /lots/{id}/accept'
create_route 'POST /lots/{id}/handoff'
create_route 'POST /lots/{id}/receipt'
create_route 'POST /lots/{id}/distribution'
create_route 'POST /lots/{id}/close'
create_route 'GET /lots/{id}'
create_route 'POST /lots/{id}/photo-upload'
create_route 'GET /lots/{id}/photo'
create_route 'GET /lots/{id}/verify'
create_route 'GET /impact'
create_route 'GET /rewards'
create_route 'GET /open-offers'
create_route 'GET /fund'
create_route 'GET /payout-profile'
create_route 'PUT /payout-profile'
create_route 'GET /payouts'
create_route 'POST /payouts/run'
create_route 'GET /donations'
create_route 'POST /donations'
create_route 'POST /donations/confirm'
create_route 'POST /pool'
# Older deployments may still have GET /payouts/{sub}/details and POST /payouts/{sub}/transfer. They are no longer
# created here, and they are harmless: the Lambda no longer serves them (the coordinator never sees account numbers).
create_route 'POST /retry-callbacks'

# Razorpay calls this itself, so it has no JWT: the X-Razorpay-Signature HMAC is the credential (checked in api.py).
if ! printf '%s\n' "$EXISTING_ROUTES" | tr '\t' '\n' | grep -qx 'POST /razorpay/webhook'; then
  aws apigatewayv2 create-route --api-id "$API_ID" --route-key 'POST /razorpay/webhook' \
    --authorization-type NONE --target "integrations/$INTEGRATION_ID" >/dev/null
  echo "created route: POST /razorpay/webhook (open, signature-checked)"
fi

# Routes served by the Go Lambda (infra/41_lambda_go.sh). Skipped until that function exists,
# so this script stays runnable before the Go routes are deployed.
GO_FN=${PREFIX}-api-go
if aws lambda get-function --function-name "$GO_FN" >/dev/null 2>&1; then
  GO_ARN=arn:aws:lambda:$REGION:$ACCOUNT_ID:function:$GO_FN
  GO_INTEGRATION_ID=$(aws apigatewayv2 get-integrations --api-id "$API_ID" \
    --query "Items[?IntegrationUri=='$GO_ARN'].IntegrationId | [0]" --output text)
  if [ "$GO_INTEGRATION_ID" = "None" ] || [ -z "$GO_INTEGRATION_ID" ]; then
    GO_INTEGRATION_ID=$(aws apigatewayv2 create-integration --api-id "$API_ID" \
      --integration-type AWS_PROXY --integration-uri "$GO_ARN" \
      --payload-format-version 2.0 --integration-method POST \
      --query IntegrationId --output text)
    echo "created go integration $GO_INTEGRATION_ID"
  else
    echo "go integration exists $GO_INTEGRATION_ID"
  fi
  INTEGRATION_ID=$GO_INTEGRATION_ID
  create_route 'POST /lots/{id}/disposition'
  create_route 'POST /lots/{id}/resolve-dispute'
  create_route 'GET /lots'
  aws lambda add-permission --function-name "$GO_FN" --statement-id apigw-invoke \
    --action lambda:InvokeFunction --principal apigateway.amazonaws.com \
    --source-arn "arn:aws:execute-api:$REGION:$ACCOUNT_ID:$API_ID/*" >/dev/null 2>&1 \
    && echo "added go lambda permission" || echo "go lambda permission already present"
else
  echo "skipping Go routes: function $GO_FN not deployed yet (run infra/41_lambda_go.sh, then re-run this script)"
fi

if ! aws apigatewayv2 get-stages --api-id "$API_ID" --query "Items[?StageName=='\$default'].StageName | [0]" --output text | grep -qx '\$default'; then
  aws apigatewayv2 create-stage --api-id "$API_ID" --stage-name '$default' --auto-deploy >/dev/null
  echo "created \$default stage"
else
  echo "\$default stage exists"
fi

aws lambda add-permission --function-name ${PREFIX}-api --statement-id apigw-invoke \
  --action lambda:InvokeFunction --principal apigateway.amazonaws.com \
  --source-arn "arn:aws:execute-api:$REGION:$ACCOUNT_ID:$API_ID/*" >/dev/null 2>&1 \
  && echo "added lambda permission" || echo "lambda permission already present"

API_URL="https://$API_ID.execute-api.$REGION.amazonaws.com"
upsert_env API_ID "$API_ID"
upsert_env API_URL "$API_URL"
echo "api ready: $API_URL"
