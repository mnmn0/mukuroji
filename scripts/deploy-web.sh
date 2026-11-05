#!/usr/bin/env bash
# Builds the Web app and uploads it to the stack's CloudFront-backed bucket.
#
# The Web app calls the API on the same CloudFront origin (`/api`), so the
# build uses no API base URL overrides. Hashed files under `assets/` are cached
# for a year and kept after later uploads, so a browser that still runs the
# previous `index.html` can load its lazy chunks. Every other file is served
# with `no-cache` and replaced on each upload.
set -euo pipefail

AWS_REGION="${AWS_REGION:-${AWS_DEFAULT_REGION:-}}"
if [[ -z "$AWS_REGION" ]]; then
  echo "AWS_REGION is required." >&2
  exit 2
fi
STACK_NAME="${MUKUROJI_STACK_NAME:-Mukuroji}"
REPOSITORY_ROOT="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
DIST_DIRECTORY="$REPOSITORY_ROOT/web/dist"

stack_output() {
  local key="$1"
  local value

  value="$(aws cloudformation describe-stacks \
    --region "$AWS_REGION" \
    --stack-name "$STACK_NAME" \
    --query "Stacks[0].Outputs[?OutputKey=='$key'].OutputValue | [0]" \
    --output text)"
  if [[ -z "$value" || "$value" == "None" ]]; then
    echo "Stack $STACK_NAME has no $key output. Deploy the stack first." >&2
    exit 1
  fi
  printf '%s' "$value"
}

WEB_BUCKET_NAME="$(stack_output WebBucketName)"
WEB_DISTRIBUTION_ID="$(stack_output WebDistributionId)"
WEB_URL="$(stack_output WebUrl)"

(
  cd "$REPOSITORY_ROOT"
  env \
    -u VITE_PROJECTS_API_BASE_URL \
    -u VITE_WORKSPACE_API_BASE_URL \
    -u VITE_ENTERPRISE_IDENTITY_API_BASE_URL \
    VITE_API_BASE_URL=/api \
    bun run web:build
)

if [[ ! -f "$DIST_DIRECTORY/index.html" || ! -d "$DIST_DIRECTORY/assets" ]]; then
  echo "The Web build did not produce index.html and assets/." >&2
  exit 1
fi

aws s3 sync "$DIST_DIRECTORY/assets" "s3://$WEB_BUCKET_NAME/assets" \
  --region "$AWS_REGION" \
  --cache-control 'public, max-age=31536000, immutable'
aws s3 sync "$DIST_DIRECTORY" "s3://$WEB_BUCKET_NAME" \
  --region "$AWS_REGION" \
  --exclude 'assets/*' \
  --delete \
  --cache-control 'no-cache'
aws cloudfront create-invalidation \
  --distribution-id "$WEB_DISTRIBUTION_ID" \
  --paths '/*' \
  --query 'Invalidation.Id' \
  --output text

echo "Web app uploaded. Open $WEB_URL"
