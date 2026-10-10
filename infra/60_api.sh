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
create_route 'POST /retry-callbacks'

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
