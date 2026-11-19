#!/usr/bin/env bash
# Restores an earlier Web release that `scripts/deploy-web.sh` uploaded, without rebuilding it.
#
# Usage:
#   AWS_REGION=ap-northeast-1 bash scripts/rollback-web.sh            # list kept releases
#   AWS_REGION=ap-northeast-1 bash scripts/rollback-web.sh <commit>   # restore that release
#
# Each deploy keeps its entry files (`index.html`, `sw.js`, the manifest and other
# non-hashed files) under `releases/<commit SHA>/`. Hashed files under `assets/` are
# never deleted, so copying a kept release back to the bucket root and invalidating
# CloudFront is enough to serve it again.
set -euo pipefail

AWS_REGION="${AWS_REGION:-${AWS_DEFAULT_REGION:-}}"
if [[ -z "$AWS_REGION" ]]; then
  echo "AWS_REGION is required." >&2
  exit 2
fi
STACK_NAME="${MUKUROJI_STACK_NAME:-Mukuroji}"
TARGET_COMMIT_SHA="${1:-}"

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

if [[ -z "$TARGET_COMMIT_SHA" ]]; then
  echo "Kept Web releases, newest first (upload time of index.html, commit SHA):"
  aws s3api list-objects-v2 \
    --region "$AWS_REGION" \
    --bucket "$WEB_BUCKET_NAME" \
    --prefix 'releases/' \
    --query "reverse(sort_by(Contents[?ends_with(Key, '/index.html')], &LastModified))[].[LastModified, Key]" \
    --output text \
    | sed -E 's#releases/([0-9a-f]{40})/index\.html#\1#'
  echo "Run again with a commit SHA to restore that release."
  exit 0
fi

if [[ ! "$TARGET_COMMIT_SHA" =~ ^[0-9a-f]{40}$ ]]; then
  echo "Pass one full lowercase 40-character commit SHA, as shown on the Help screen." >&2
  exit 2
fi

RELEASE_PREFIX="releases/$TARGET_COMMIT_SHA"
if ! aws s3api head-object \
  --region "$AWS_REGION" \
  --bucket "$WEB_BUCKET_NAME" \
  --key "$RELEASE_PREFIX/index.html" >/dev/null 2>&1; then
  echo "No kept release for $TARGET_COMMIT_SHA. Run without arguments to list kept releases." >&2
  exit 1
fi

WEB_DISTRIBUTION_ID="$(stack_output WebDistributionId)"

# Stage the release locally and upload it the same way as deploy-web.sh. An S3-to-S3
# `sync` inside one bucket applies the `releases/*` exclude to the source keys too, so
# it would copy nothing and delete the live files. `cp` always overwrites, which `sync`
# would skip for same-sized files that are older than the live ones.
RELEASE_DIRECTORY="$(mktemp -d)"
trap 'rm -rf "$RELEASE_DIRECTORY"' EXIT
aws s3 cp "s3://$WEB_BUCKET_NAME/$RELEASE_PREFIX" "$RELEASE_DIRECTORY" \
  --region "$AWS_REGION" \
  --recursive \
  --only-show-errors
if [[ ! -f "$RELEASE_DIRECTORY/index.html" ]]; then
  echo "Downloading release $TARGET_COMMIT_SHA did not produce index.html." >&2
  exit 1
fi
aws s3 cp "$RELEASE_DIRECTORY" "s3://$WEB_BUCKET_NAME" \
  --region "$AWS_REGION" \
  --recursive \
  --cache-control 'no-cache'
aws s3 sync "$RELEASE_DIRECTORY" "s3://$WEB_BUCKET_NAME" \
  --region "$AWS_REGION" \
  --exclude 'assets/*' \
  --exclude 'releases/*' \
  --delete \
  --cache-control 'no-cache'
aws cloudfront create-invalidation \
  --distribution-id "$WEB_DISTRIBUTION_ID" \
  --paths '/*' \
  --query 'Invalidation.Id' \
  --output text

echo "Web release $TARGET_COMMIT_SHA restored."
