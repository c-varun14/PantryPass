#!/usr/bin/env bash
# Direct donations: optional Razorpay keys in Secrets Manager, read access for the API role, and a redeploy.
# Run infra/90_payouts.sh first (donations are stored in the payouts table and paid out from it). Safe to re-run.
#
# Without keys the app runs donations in a SIMULATED mode (labelled in the UI; nothing is charged and simulated
# money is never counted as owed). To go live later, export the keys and re-run this script:
#   RAZORPAY_KEY_ID=rzp_live_xxx RAZORPAY_KEY_SECRET=xxx RAZORPAY_WEBHOOK_SECRET=xxx bash infra/95_donations.sh
# Then in the Razorpay dashboard add a webhook to  <API_URL>/razorpay/webhook  for payment.captured and order.paid,
# using the same webhook secret. Add the site's origin to the allowed domains for Checkout.
set -euo pipefail
cd "$(dirname "$0")/.."
source infra/00_env.sh
OUT=infra/.env.generated
: "${PAYOUTS_TABLE:?run infra/90_payouts.sh first}"
SECRET_NAME=${PREFIX}/razorpay

put_env() { grep -v "^export ${1}=" "$OUT" > "$OUT.tmp" 2>/dev/null || true; { cat "$OUT.tmp"; echo "export ${1}=${2}"; } > "$OUT"; rm -f "$OUT.tmp"; }

if [ -n "${RAZORPAY_KEY_ID:-}" ] && [ -n "${RAZORPAY_KEY_SECRET:-}" ]; then
  # python builds the JSON so quotes in a secret cannot break it; the keys are never echoed
  SECRET_JSON=$(python3 -I -c 'import json,os; print(json.dumps({"key_id":os.environ["RAZORPAY_KEY_ID"],"key_secret":os.environ["RAZORPAY_KEY_SECRET"],"webhook_secret":os.environ.get("RAZORPAY_WEBHOOK_SECRET","")}))')
  if aws secretsmanager describe-secret --secret-id "$SECRET_NAME" >/dev/null 2>&1; then
    aws secretsmanager put-secret-value --secret-id "$SECRET_NAME" --secret-string "$SECRET_JSON" >/dev/null
    echo "updated secret $SECRET_NAME"
  else
    aws secretsmanager create-secret --name "$SECRET_NAME" --secret-string "$SECRET_JSON" \
      --tags Key=$TAG_KEY,Value=$TAG_VALUE >/dev/null
    echo "created secret $SECRET_NAME"
  fi
  SECRET_ARN=$(aws secretsmanager describe-secret --secret-id "$SECRET_NAME" --query ARN --output text)
  aws iam put-role-policy --role-name "$ROLE_NAME" --policy-name ${PREFIX}-razorpay --policy-document "{
   \"Version\":\"2012-10-17\",\"Statement\":[{\"Effect\":\"Allow\",\"Action\":\"secretsmanager:GetSecretValue\",\"Resource\":\"$SECRET_ARN\"}]}"
  put_env RAZORPAY_SECRET_ARN "$SECRET_ARN"
  export RAZORPAY_SECRET_ARN=$SECRET_ARN
  echo "Razorpay configured: donations are LIVE"
else
  echo "no Razorpay keys given: donations stay in simulated mode"
fi
export DONATION_FEE_PCT=${DONATION_FEE_PCT:-5}
put_env DONATION_FEE_PCT "$DONATION_FEE_PCT"
bash infra/60_api.sh
bash infra/40_lambda.sh api
echo "donations ready (platform fee ${DONATION_FEE_PCT}%)"
