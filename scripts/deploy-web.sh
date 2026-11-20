#!/usr/bin/env bash
# Builds the Web app and uploads it to the stack's CloudFront-backed bucket.
#
# The Web app calls the API on the same CloudFront origin (`/api`). Every API
# base URL variable is set to `/api` so a value left in the shell or in a
# `web/.env*` file cannot point the build at another endpoint. Hashed files
# under `assets/` are cached for a year and kept after later uploads, so a
# browser that still runs the previous `index.html` can load its lazy chunks.
# Every other file is served with `no-cache` and replaced on each upload.
#
# The build embeds the commit SHA so the Help screen can show which build is
# running. A copy of every non-asset file is also kept under
# `releases/<commit SHA>/`, so `scripts/rollback-web.sh` can restore an earlier
# release without rebuilding it.
#
# Each release lists the `assets/` keys it uses in `release-assets.txt`. The bucket
# expires release copies after 180 days, and this script then deletes hashed assets
# that neither a kept release nor the release being replaced lists. Versioning keeps a
# deleted asset recoverable for 30 days. An age-based rule cannot do this, because
# the assets of a live release are not re-uploaded while nobody deploys.
set -euo pipefail

AWS_REGION="${AWS_REGION:-${AWS_DEFAULT_REGION:-}}"
if [[ -z "$AWS_REGION" ]]; then
  echo "AWS_REGION is required." >&2
  exit 2
fi
STACK_NAME="${MUKUROJI_STACK_NAME:-Mukuroji}"
REPOSITORY_ROOT="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
DIST_DIRECTORY="$REPOSITORY_ROOT/web/dist"

if [[ -n "$(git -C "$REPOSITORY_ROOT" status --porcelain)" ]]; then
  echo "Commit or stash local changes first: a release must match its commit SHA." >&2
  exit 1
fi
WEB_BUILD_COMMIT_SHA="$(git -C "$REPOSITORY_ROOT" rev-parse HEAD)"
# Keep in sync with the `release-assets\.txt` pattern in prune_unreferenced_assets.
ASSET_MANIFEST_NAME='release-assets.txt'

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

# Prints the bucket keys under a prefix, one per line, across every listing page.
list_keys() {
  local prefix="$1"

  aws s3api list-objects-v2 \
    --region "$AWS_REGION" \
    --bucket "$WEB_BUCKET_NAME" \
    --prefix "$prefix" \
    --query 'Contents[].Key' \
    --output text \
    | tr '\t' '\n' \
    | { grep -v -x -e '' -e 'None' || true; }
}

# Deletes `assets/` keys that no kept release, the replaced live release, or this
# build lists. Pruning is skipped when a kept release has no asset manifest, because
# its assets cannot be told apart from unused ones. Files uploaded in the last 24 hours
# are kept, so a deploy running at the same time does not lose assets it has uploaded
# before its manifest exists.
prune_unreferenced_assets() {
  local work_directory="$1"
  local release_directories="$work_directory/release-directories"
  local manifest_keys="$work_directory/manifest-keys"
  local referenced_assets="$work_directory/referenced-assets"
  local stored_assets="$work_directory/stored-assets"
  local unreferenced_assets="$work_directory/unreferenced-assets"
  local manifest_key
  local asset_key
  local cutoff

  list_keys 'releases/' >"$work_directory/release-keys"
  sed -n -E 's#^(releases/[0-9a-f]{40})/index\.html$#\1#p' "$work_directory/release-keys" \
    | LC_ALL=C sort -u >"$release_directories"
  sed -n -E 's#^(releases/[0-9a-f]{40})/release-assets\.txt$#\1#p' "$work_directory/release-keys" \
    | LC_ALL=C sort -u >"$manifest_keys"
  if [[ -n "$(LC_ALL=C comm -23 "$release_directories" "$manifest_keys")" ]]; then
    echo "Kept old assets: a kept release has no $ASSET_MANIFEST_NAME (deployed before asset pruning)."
    return 0
  fi

  (cd "$DIST_DIRECTORY" && find assets -type f) >"$referenced_assets"
  while IFS= read -r manifest_key; do
    aws s3 cp "s3://$WEB_BUCKET_NAME/$manifest_key/$ASSET_MANIFEST_NAME" - \
      --region "$AWS_REGION" >>"$referenced_assets"
  done <"$manifest_keys"
  # The live release keeps serving open tabs until this deploy replaces it.
  if aws s3api head-object \
    --region "$AWS_REGION" \
    --bucket "$WEB_BUCKET_NAME" \
    --key "$ASSET_MANIFEST_NAME" >/dev/null 2>&1; then
    aws s3 cp "s3://$WEB_BUCKET_NAME/$ASSET_MANIFEST_NAME" - \
      --region "$AWS_REGION" >>"$referenced_assets"
  elif aws s3api head-object \
    --region "$AWS_REGION" \
    --bucket "$WEB_BUCKET_NAME" \
    --key index.html >/dev/null 2>&1; then
    echo "Kept old assets: the live release has no $ASSET_MANIFEST_NAME (deployed before asset pruning)."
    return 0
  fi

  LC_ALL=C sort -u -o "$referenced_assets" "$referenced_assets"
  # ISO 8601 times in UTC compare correctly as strings.
  cutoff="$(bun -e 'console.log(new Date(Date.now() - 86_400_000).toISOString().slice(0, 19))')"
  aws s3api list-objects-v2 \
    --region "$AWS_REGION" \
    --bucket "$WEB_BUCKET_NAME" \
    --prefix 'assets/' \
    --query 'Contents[].[Key, LastModified]' \
    --output text \
    | awk -F '\t' -v cutoff="$cutoff" 'NF == 2 && $2 "" < cutoff { print $1 }' \
    | LC_ALL=C sort -u >"$stored_assets"
  LC_ALL=C comm -23 "$stored_assets" "$referenced_assets" >"$unreferenced_assets"
  while IFS= read -r asset_key; do
    aws s3 rm "s3://$WEB_BUCKET_NAME/$asset_key" \
      --region "$AWS_REGION" \
      --only-show-errors
  done <"$unreferenced_assets"
  echo "Deleted $(wc -l <"$unreferenced_assets" | tr -d ' ') asset file(s) that no kept release uses and nobody uploaded in the last 24 hours."
}

WEB_BUCKET_NAME="$(stack_output WebBucketName)"
WEB_DISTRIBUTION_ID="$(stack_output WebDistributionId)"
WEB_URL="$(stack_output WebUrl)"

(
  cd "$REPOSITORY_ROOT"
  env \
    VITE_API_BASE_URL=/api \
    VITE_PROJECTS_API_BASE_URL=/api \
    VITE_WORKSPACE_API_BASE_URL=/api \
    VITE_ENTERPRISE_IDENTITY_API_BASE_URL=/api \
    VITE_WEB_BUILD_COMMIT_SHA="$WEB_BUILD_COMMIT_SHA" \
    bun run web:build
)

if [[ ! -f "$DIST_DIRECTORY/index.html" || ! -d "$DIST_DIRECTORY/assets" ]]; then
  echo "The Web build did not produce index.html and assets/." >&2
  exit 1
fi
(cd "$DIST_DIRECTORY" && find assets -type f | LC_ALL=C sort) >"$DIST_DIRECTORY/$ASSET_MANIFEST_NAME"

aws s3 sync "$DIST_DIRECTORY/assets" "s3://$WEB_BUCKET_NAME/assets" \
  --region "$AWS_REGION" \
  --cache-control 'public, max-age=31536000, immutable'
# Keep this release's entry files first, so a release that is live can always be restored.
aws s3 sync "$DIST_DIRECTORY" "s3://$WEB_BUCKET_NAME/releases/$WEB_BUILD_COMMIT_SHA" \
  --region "$AWS_REGION" \
  --exclude 'assets/*' \
  --delete \
  --cache-control 'no-cache'
PRUNE_DIRECTORY="$(mktemp -d)"
trap 'rm -rf "$PRUNE_DIRECTORY"' EXIT
prune_unreferenced_assets "$PRUNE_DIRECTORY"
aws s3 sync "$DIST_DIRECTORY" "s3://$WEB_BUCKET_NAME" \
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

echo "Web app $WEB_BUILD_COMMIT_SHA uploaded. Open $WEB_URL"
