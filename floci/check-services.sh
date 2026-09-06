#!/bin/sh
# Run inside Floci: docker compose exec -T floci sh < floci/check-services.sh
set -eu
export AWS_DEFAULT_REGION=us-east-1 AWS_ACCESS_KEY_ID=test AWS_SECRET_ACCESS_KEY=test
aws_local() { aws --endpoint-url http://localhost:4566 "$@"; }
sample="$(mktemp)"
download="$(mktemp)"
key="local-smoke/$(date +%s)-$$"
version=''
cleanup() {
  if [ -n "$version" ]; then
    aws_local s3api delete-object --bucket mukuroji-files-local --key "$key" --version-id "$version" >/dev/null
  fi
  rm -f "$sample" "$download"
}
trap cleanup 0
printf 'mukuroji local object smoke\n' >"$sample"
for bucket in mukuroji-files-local mukuroji-work-item-import-local; do
  test "$(aws_local s3api get-bucket-versioning --bucket "$bucket" --query Status --output text)" = Enabled
  test "$(aws_local s3api get-bucket-cors --bucket "$bucket" --query 'CORSRules[0].AllowedOrigins[0]' --output text)" = http://localhost:5173
done
version="$(aws_local s3api put-object --bucket mukuroji-files-local --key "$key" --body "$sample" --query VersionId --output text)"
test -n "$version" && test "$version" != None && test "$version" != null
aws_local s3api get-object --bucket mukuroji-files-local --key "$key" --version-id "$version" "$download" >/dev/null
python3 -c 'import pathlib,sys; assert pathlib.Path(sys.argv[1]).read_bytes() == pathlib.Path(sys.argv[2]).read_bytes()' "$sample" "$download"
for queue in work-item-import webhook-delivery connector-sync; do
  url="$(aws_local sqs get-queue-url --queue-name "$queue" --query QueueUrl --output text)"
  test "$(aws_local sqs get-queue-attributes --queue-url "$url" --attribute-names VisibilityTimeout --query Attributes.VisibilityTimeout --output text)" = 900
  aws_local sqs get-queue-attributes --queue-url "$url" --attribute-names RedrivePolicy --query Attributes.RedrivePolicy --output text |
    python3 -c 'import json,sys; p=json.load(sys.stdin); assert int(p["maxReceiveCount"]) == 5; assert p["deadLetterTargetArn"].endswith("-dlq")'
done
echo 'Local services smoke passed: S3 versioned round trip, CORS, SQS visibility and DLQs.'
