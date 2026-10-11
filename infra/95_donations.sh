#!/usr/bin/env bash
# Direct donations and the pool: Razorpay keys in Secrets Manager, read access for the API role, a redeploy,
# and an optional scheduled payout run. Run infra/90_payouts.sh first. Safe to re-run.
#
# PantryPass keeps no money and takes no platform fee. Supporters pay through Razorpay Checkout; donors are paid
# through RazorpayX Payouts, and the server (not the coordinator) sends the donor's account number to Razorpay,
# decrypted from KMS. Without keys the app runs in a SIMULATED mode (labelled in the UI; no money moves).
#
# GO-LIVE CHECKLIST (Razorpay dashboard, then this script):
#   1. Create live API keys (key id and key secret).
#   2. Enable RazorpayX on the same account and fund it (payouts are paid from that balance).
#   3. Add a webhook to  <API_URL>/razorpay/webhook  with a webhook secret, subscribed to:
#      payment.captured, order.paid, payout.processed, payout.reversed, payout.failed (required for the
#      Payout APIs), payout.rejected. Optional: payout.queued, payout.initiated, payout.pending, payout.updated.
#   4. Allow the site's origin in the dashboard so Checkout can load on it.
#   5. Store the secret with this script:
#        RAZORPAY_KEY_ID=rzp_live_xxx RAZORPAY_KEY_SECRET=xxx RAZORPAY_WEBHOOK_SECRET=xxx \
#        RAZORPAYX_ACCOUNT_NUMBER=xxx bash infra/95_donations.sh
#      (RAZORPAY_PAYOUT_ACCOUNT is also accepted for the RazorpayX account number.)
#   6. Optional, to pay donors automatically: PAYOUT_SCHEDULE="cron(0 4 1 * ? *)" with the same command.
#      This creates the EventBridge rule pantrypass-payouts. Without it, the coordinator runs payouts
#      by hand with POST /payouts/run.
set -euo pipefail
cd "$(dirname "$0")/.."
source infra/00_env.sh
OUT=infra/.env.generated
: "${PAYOUTS_TABLE:?run infra/90_payouts.sh first}"
SECRET_NAME=${PREFIX}/razorpay
RULE_NAME=${PREFIX}-payouts
PAYOUT_ACCOUNT=${RAZORPAYX_ACCOUNT_NUMBER:-${RAZORPAY_PAYOUT_ACCOUNT:-}}

put_env() { grep -v "^export ${1}=" "$OUT" > "$OUT.tmp" 2>/dev/null || true; { cat "$OUT.tmp"; echo "export ${1}=${2}"; } > "$OUT"; rm -f "$OUT.tmp"; }

SECRET_PROVIDED=0
if [ -n "${RAZORPAY_KEY_ID:-}" ] && [ -n "${RAZORPAY_KEY_SECRET:-}" ]; then
  SECRET_PROVIDED=1
  # python builds the JSON so quotes in a secret cannot break it; the keys are never echoed
  SECRET_JSON=$(RZP_ID="$RAZORPAY_KEY_ID" RZP_SECRET="$RAZORPAY_KEY_SECRET" RZP_WEBHOOK="${RAZORPAY_WEBHOOK_SECRET:-}" RZP_PAYOUT_ACCT="$PAYOUT_ACCOUNT" \
    python3 -I -c 'import json,os; print(json.dumps({"key_id":os.environ["RZP_ID"],"key_secret":os.environ["RZP_SECRET"],"webhook_secret":os.environ["RZP_WEBHOOK"],"payout_account_number":os.environ["RZP_PAYOUT_ACCT"]}))')
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
  if [ -z "$PAYOUT_ACCOUNT" ]; then
    echo "note: no RazorpayX account number given (RAZORPAYX_ACCOUNT_NUMBER); donor payouts will not run until one is set"
  fi
  echo "Razorpay configured: donations are LIVE"
else
  echo "no Razorpay keys given: donations stay in simulated mode"
fi

bash infra/60_api.sh
bash infra/40_lambda.sh api
echo "donations ready (no platform fee: Razorpay's own charges are covered by sponsors)"

# Scheduled payouts: only once the live secret exists, and only when a schedule is given.
if [ "$SECRET_PROVIDED" = 1 ] && [ -n "${PAYOUT_SCHEDULE:-}" ]; then
  API_FN=${PREFIX}-api
  API_FN_ARN=arn:aws:lambda:$REGION:$ACCOUNT_ID:function:$API_FN
  aws events put-rule --name "$RULE_NAME" --schedule-expression "$PAYOUT_SCHEDULE" --state ENABLED >/dev/null
  RULE_ARN=$(aws events describe-rule --name "$RULE_NAME" --query Arn --output text)
  # the input is the scheduled-event shape the API Lambda recognises as a payout run
  TARGETS=$(TARGET_ARN="$API_FN_ARN" python3 -I -c 'import json,os; print(json.dumps([{"Id":"payouts","Arn":os.environ["TARGET_ARN"],"Input":json.dumps({"source":"aws.events","detail-type":"Scheduled Event"})}]))')
  aws events put-targets --rule "$RULE_NAME" --targets "$TARGETS" >/dev/null
  aws lambda add-permission --function-name "$API_FN" --statement-id pantrypass-payouts-schedule \
    --action lambda:InvokeFunction --principal events.amazonaws.com --source-arn "$RULE_ARN" >/dev/null 2>&1 \
    && echo "added EventBridge permission" || echo "EventBridge permission already present"
  echo "scheduled payouts enabled: $RULE_NAME ($PAYOUT_SCHEDULE)"
else
  echo "scheduled payouts not enabled. To pay donors on a schedule, re-run with the Razorpay keys and"
  echo "  PAYOUT_SCHEDULE=\"cron(0 4 1 * ? *)\" bash infra/95_donations.sh"
  echo "until then the coordinator runs payouts with POST /payouts/run."
fi
