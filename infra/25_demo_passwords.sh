#!/usr/bin/env bash
# Sets a permanent password for the four demo users from $DEMO_PASSWORD.
# The password is read at run time and never written to a file or printed.
# Give it to judges in the submission notes, not in the repo.
set -euo pipefail
cd "$(dirname "$0")/.."
source infra/00_env.sh
: "${COGNITO_POOL_ID:?run infra/20_cognito.sh first}"
: "${DEMO_PASSWORD:?export DEMO_PASSWORD (min 8 chars, upper, lower, digit, symbol) before running}"
for u in donor1 receiver1 receiver2 coordinator1; do
  aws cognito-idp admin-set-user-password --user-pool-id "$COGNITO_POOL_ID" \
    --username "$u" --password "$DEMO_PASSWORD" --permanent
  echo "password set for $u"
done
