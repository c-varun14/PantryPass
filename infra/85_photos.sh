#!/usr/bin/env bash
# Photo evidence: a private, versioned S3 bucket; CORS for the site; a write-once IAM policy for the API role;
# the API routes; and a redeploy of the API Lambda with PHOTOS_BUCKET set. Safe to re-run.
#
# How it works: the API Lambda hands out a short-lived presigned POST (size-limited, one key, one content type),
# the browser uploads straight to S3, and the API reads the object when the step is committed and records its
# SHA-256 in the hash-chained event. The bucket is never public; photos are viewed through 5-minute signed URLs.
set -euo pipefail
cd "$(dirname "$0")/.."
source infra/00_env.sh
OUT=infra/.env.generated
BUCKET=${PREFIX}-photos-${ACCOUNT_ID}

# ---- 1. private, versioned, encrypted bucket ----
if aws s3api head-bucket --bucket "$BUCKET" 2>/dev/null; then
  echo "bucket exists $BUCKET"
else
  aws s3api create-bucket --bucket "$BUCKET" --region "$REGION" \
    --create-bucket-configuration LocationConstraint="$REGION" >/dev/null
  echo "created bucket $BUCKET"
fi
aws s3api put-public-access-block --bucket "$BUCKET" --public-access-block-configuration \
  BlockPublicAcls=true,IgnorePublicAcls=true,BlockPublicPolicy=true,RestrictPublicBuckets=true
aws s3api put-bucket-versioning --bucket "$BUCKET" --versioning-configuration Status=Enabled
aws s3api put-bucket-encryption --bucket "$BUCKET" --server-side-encryption-configuration \
  '{"Rules":[{"ApplyServerSideEncryptionByDefault":{"SSEAlgorithm":"AES256"}}]}'
aws s3api put-bucket-tagging --bucket "$BUCKET" --tagging "TagSet=[{Key=$TAG_KEY,Value=$TAG_VALUE}]"

# ---- 2. CORS: the deployed site and local development may upload and view ----
CF_DOMAIN=${CF_DOMAIN:-$(aws cloudfront list-distributions \
  --query "DistributionList.Items[?Origins.Items[0].DomainName=='${WEB_BUCKET}.s3.${REGION}.amazonaws.com'].DomainName | [0]" --output text)}
ORIGINS="\"http://localhost:8099\",\"http://localhost:8080\""
if [ -n "$CF_DOMAIN" ] && [ "$CF_DOMAIN" != "None" ]; then ORIGINS="\"https://$CF_DOMAIN\",$ORIGINS"; fi
aws s3api put-bucket-cors --bucket "$BUCKET" --cors-configuration \
  "{\"CORSRules\":[{\"AllowedOrigins\":[$ORIGINS],\"AllowedMethods\":[\"POST\",\"GET\"],\"AllowedHeaders\":[\"*\"],\"ExposeHeaders\":[\"ETag\"],\"MaxAgeSeconds\":3600}]}"
echo "CORS set for: $ORIGINS"

# ---- 3. IAM: the API role may add and read photos under lots/ but can never delete one ----
aws iam put-role-policy --role-name "$ROLE_NAME" --policy-name ${PREFIX}-photos --policy-document "{
 \"Version\":\"2012-10-17\",\"Statement\":[
  {\"Sid\":\"AddAndReadPhotos\",\"Effect\":\"Allow\",\"Action\":[\"s3:PutObject\",\"s3:GetObject\"],\"Resource\":\"arn:aws:s3:::$BUCKET/lots/*\"},
  {\"Sid\":\"PhotosAreWriteOnce\",\"Effect\":\"Deny\",\"Action\":[\"s3:DeleteObject\",\"s3:DeleteObjectVersion\"],\"Resource\":\"arn:aws:s3:::$BUCKET/*\"}
 ]}"
echo "photo policy attached to $ROLE_NAME"

# ---- 4. remember the bucket, add the routes, redeploy the API with PHOTOS_BUCKET ----
grep -v '^export PHOTOS_BUCKET=' "$OUT" > "$OUT.tmp" 2>/dev/null || true
{ cat "$OUT.tmp"; echo "export PHOTOS_BUCKET=$BUCKET"; } > "$OUT"; rm -f "$OUT.tmp"
export PHOTOS_BUCKET=$BUCKET
bash infra/60_api.sh
bash infra/40_lambda.sh api
echo "photos ready: s3://$BUCKET"
