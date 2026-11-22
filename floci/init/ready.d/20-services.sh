#!/bin/sh
# Local storage and durable queues. Safe to rerun without deleting stored data.
set -eu
ENDPOINT_URL=http://localhost:4566
PUBLIC_ENDPOINT_URL="${MUKUROJI_PUBLIC_FLOCI_ENDPOINT:-$ENDPOINT_URL}"
GENERATED_DIR="${MUKUROJI_GENERATED_DIR:-/app/generated}"
export AWS_DEFAULT_REGION=us-east-1 AWS_ACCESS_KEY_ID=test AWS_SECRET_ACCESS_KEY=test
aws_local() { aws --endpoint-url "$ENDPOINT_URL" "$@"; }
ensure_queue() {
  aws_local sqs get-queue-url --queue-name "$1" --query QueueUrl --output text 2>/dev/null ||
    aws_local sqs create-queue --queue-name "$1" --query QueueUrl --output text
}
umask 077
mkdir -p "$GENERATED_DIR"
env_file="$(mktemp "$GENERATED_DIR/services.env.XXXXXX")"
trap 'rm -f "$env_file"' 0
for bucket in mukuroji-files-local mukuroji-work-item-import-local; do
  if ! aws_local s3api head-bucket --bucket "$bucket" >/dev/null 2>&1; then
    aws_local s3api create-bucket --bucket "$bucket" >/dev/null
  fi
  aws_local s3api put-bucket-versioning --bucket "$bucket" --versioning-configuration Status=Enabled
  aws_local s3api put-bucket-cors --bucket "$bucket" --cors-configuration '{"CORSRules":[{"AllowedOrigins":["http://localhost:5173","http://127.0.0.1:5173"],"AllowedMethods":["GET","HEAD","PUT"],"AllowedHeaders":["*"],"ExposeHeaders":["ETag","x-amz-checksum-sha256","x-amz-version-id"],"MaxAgeSeconds":600}]}'
done
cat >"$env_file" <<EOF
AWS_ENDPOINT_URL=$PUBLIC_ENDPOINT_URL
AWS_ENDPOINT_URL_S3=$PUBLIC_ENDPOINT_URL
AWS_ENDPOINT_URL_SQS=$PUBLIC_ENDPOINT_URL
SQS_ENDPOINT=$PUBLIC_ENDPOINT_URL
AWS_REGION=us-east-1
MUKUROJI_LOCAL_AWS_RUNTIME=floci
FILE_BUCKET_NAME=mukuroji-files-local
WORK_ITEM_IMPORT_BUCKET_NAME=mukuroji-work-item-import-local
DEVELOPER_PLATFORM_TABLE_NAME=mukuroji-developer-platform-local
EOF
for entry in WORK_ITEM_IMPORT_QUEUE_URL:work-item-import WEBHOOK_DELIVERY_QUEUE_URL:webhook-delivery CONNECTOR_SYNC_QUEUE_URL:connector-sync; do
  variable="${entry%%:*}"
  name="${entry#*:}"
  dlq_url="$(ensure_queue "$name-dlq")"
  dlq_arn="$(aws_local sqs get-queue-attributes --queue-url "$dlq_url" --attribute-names QueueArn --query Attributes.QueueArn --output text)"
  queue_url="$(ensure_queue "$name")"
  aws_local sqs set-queue-attributes --queue-url "$queue_url" --attributes "{\"VisibilityTimeout\":\"900\",\"RedrivePolicy\":\"{\\\"deadLetterTargetArn\\\":\\\"$dlq_arn\\\",\\\"maxReceiveCount\\\":\\\"5\\\"}\"}"
  queue_path="$(printf '%s' "$queue_url" | sed 's|^http[s]*://[^/]*||')"
  printf '%s=%s%s\n' "$variable" "${PUBLIC_ENDPOINT_URL%/}" "$queue_path" >>"$env_file"
done
chmod 644 "$env_file"
mv "$env_file" "$GENERATED_DIR/services.env"
echo 'mukuroji local S3 and SQS ready: services.env'
