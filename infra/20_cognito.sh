#!/usr/bin/env bash
# Cognito: one user pool, one app client (admin + browser password auth, no secret),
# a donor, receiver and coordinator user, and the three groups the API Lambda reads role from.
#
# Passwords are NOT created, stored or printed here. tests/run_gates.sh sets a
# fresh permanent password in-process immediately before it logs in.
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

POOL_NAME=${PREFIX}-pool
CLIENT_NAME=${PREFIX}-app

POOL_ID=$(aws cognito-idp list-user-pools --max-results 60 \
  --query "UserPools[?Name=='$POOL_NAME'].Id | [0]" --output text)
if [ "$POOL_ID" = "None" ] || [ -z "$POOL_ID" ]; then
  POOL_ID=$(aws cognito-idp create-user-pool --pool-name "$POOL_NAME" \
    --user-pool-tags project=$TAG_VALUE \
    --query UserPool.Id --output text)
  echo "created user pool $POOL_ID"
else
  echo "user pool exists $POOL_ID"
fi

CLIENT_ID=$(aws cognito-idp list-user-pool-clients --user-pool-id "$POOL_ID" \
  --query "UserPoolClients[?ClientName=='$CLIENT_NAME'].ClientId | [0]" --output text)
if [ "$CLIENT_ID" = "None" ] || [ -z "$CLIENT_ID" ]; then
  CLIENT_ID=$(aws cognito-idp create-user-pool-client --user-pool-id "$POOL_ID" \
    --client-name "$CLIENT_NAME" --no-generate-secret \
    --explicit-auth-flows ALLOW_ADMIN_USER_PASSWORD_AUTH ALLOW_USER_PASSWORD_AUTH ALLOW_REFRESH_TOKEN_AUTH \
    --query UserPoolClient.ClientId --output text)
  echo "created app client $CLIENT_ID"
else
  echo "app client exists $CLIENT_ID"
fi
# The browser UI signs in with USER_PASSWORD_AUTH; keep admin auth for tests/run_gates.sh.
aws cognito-idp update-user-pool-client --user-pool-id "$POOL_ID" --client-id "$CLIENT_ID" \
  --client-name "$CLIENT_NAME" \
  --explicit-auth-flows ALLOW_ADMIN_USER_PASSWORD_AUTH ALLOW_USER_PASSWORD_AUTH ALLOW_REFRESH_TOKEN_AUTH >/dev/null
echo "app client auth flows set"

for g in donor receiver coordinator; do
  aws cognito-idp get-group --user-pool-id "$POOL_ID" --group-name "$g" >/dev/null 2>&1 || \
    aws cognito-idp create-group --user-pool-id "$POOL_ID" --group-name "$g" >/dev/null
  echo "group $g ready"
done

for u in donor1 receiver1 coordinator1; do
  if ! aws cognito-idp admin-get-user --user-pool-id "$POOL_ID" --username "$u" >/dev/null 2>&1; then
    aws cognito-idp admin-create-user --user-pool-id "$POOL_ID" --username "$u" \
      --user-attributes Name=email,Value=$u@pantrypass.test Name=email_verified,Value=true \
      --message-action SUPPRESS >/dev/null
    echo "created user $u"
  else
    echo "user $u exists"
  fi
done
aws cognito-idp admin-add-user-to-group --user-pool-id "$POOL_ID" --username donor1 --group-name donor
aws cognito-idp admin-add-user-to-group --user-pool-id "$POOL_ID" --username receiver1 --group-name receiver
aws cognito-idp admin-add-user-to-group --user-pool-id "$POOL_ID" --username coordinator1 --group-name coordinator

DONOR_SUB=$(aws cognito-idp admin-get-user --user-pool-id "$POOL_ID" --username donor1 \
  --query "UserAttributes[?Name=='sub'].Value | [0]" --output text)
RECEIVER_SUB=$(aws cognito-idp admin-get-user --user-pool-id "$POOL_ID" --username receiver1 \
  --query "UserAttributes[?Name=='sub'].Value | [0]" --output text)

COORDINATOR_SUB=$(aws cognito-idp admin-get-user --user-pool-id "$POOL_ID" --username coordinator1 \
  --query "UserAttributes[?Name=='sub'].Value | [0]" --output text)

upsert_env COORDINATOR_SUB "$COORDINATOR_SUB"
upsert_env COGNITO_POOL_ID "$POOL_ID"
upsert_env COGNITO_CLIENT_ID "$CLIENT_ID"
upsert_env COGNITO_ISSUER "https://cognito-idp.$REGION.amazonaws.com/$POOL_ID"
upsert_env DONOR_SUB "$DONOR_SUB"
upsert_env RECEIVER_SUB "$RECEIVER_SUB"
echo "cognito ready: pool=$POOL_ID client=$CLIENT_ID"
