#!/usr/bin/env bash
set -euo pipefail

if [[ -z "${TASKS_TABLE_NAME:-}" ]]; then
  echo "TASKS_TABLE_NAME is required. Use the CDK ProjectTasksTableName output." >&2
  exit 2
fi

AWS_REGION="${AWS_REGION:-${AWS_DEFAULT_REGION:-us-east-1}}"
PROJECT_DIRECTORY_ID="${MUKUROJI_WORKSPACE_DIRECTORY_ID:-${PROJECT_DIRECTORY_ID:-${MUKUROJI_PROJECT_DIRECTORY_ID:-workspace#mukuroji-local}}}"
DIRECTORY_PROJECT_ID="${PROJECT_DIRECTORY_ID}#project#refero"

endpoint_args=()
if [[ -n "${AWS_ENDPOINT_URL:-}" ]]; then
  endpoint_args=(--endpoint-url "$AWS_ENDPOINT_URL")
fi

auth_args=()
if [[ "${AWS_NO_SIGN_REQUEST:-}" == "1" ]]; then
  auth_args=(--no-sign-request)
fi

request_items=$(
  cat <<JSON
{
  "$TASKS_TABLE_NAME": [
    {"PutRequest":{"Item":{"directoryId":{"S":"$PROJECT_DIRECTORY_ID"},"directoryProjectId":{"S":"$DIRECTORY_PROJECT_ID"},"projectId":{"S":"refero"},"taskId":{"S":"wireframe"},"sortOrder":{"N":"10"},"titleKey":{"S":"tasks.item.wireframe"},"assigneeUserId":{"S":"sato@example.com"},"status":{"S":"in-progress"},"dueDate":{"S":"2026/06/03"},"priority":{"S":"high"}}}},
    {"PutRequest":{"Item":{"directoryId":{"S":"$PROJECT_DIRECTORY_ID"},"directoryProjectId":{"S":"$DIRECTORY_PROJECT_ID"},"projectId":{"S":"refero"},"taskId":{"S":"brand-guideline"},"sortOrder":{"N":"20"},"titleKey":{"S":"tasks.item.brandGuideline"},"assigneeUserId":{"S":"suzuki@example.com"},"status":{"S":"review"},"dueDate":{"S":"2026/06/05"},"priority":{"S":"medium"}}}},
    {"PutRequest":{"Item":{"directoryId":{"S":"$PROJECT_DIRECTORY_ID"},"directoryProjectId":{"S":"$DIRECTORY_PROJECT_ID"},"projectId":{"S":"refero"},"taskId":{"S":"pricing-content"},"sortOrder":{"N":"30"},"titleKey":{"S":"tasks.item.pricingContent"},"assigneeUserId":{"S":"tanaka@example.com"},"status":{"S":"in-progress"},"dueDate":{"S":"2026/06/08"},"priority":{"S":"high"}}}},
    {"PutRequest":{"Item":{"directoryId":{"S":"$PROJECT_DIRECTORY_ID"},"directoryProjectId":{"S":"$DIRECTORY_PROJECT_ID"},"projectId":{"S":"refero"},"taskId":{"S":"seo-research"},"sortOrder":{"N":"40"},"titleKey":{"S":"tasks.item.seoResearch"},"assigneeUserId":{"S":"yamamoto@example.com"},"status":{"S":"todo"},"dueDate":{"S":"2026/06/09"},"priority":{"S":"medium"}}}},
    {"PutRequest":{"Item":{"directoryId":{"S":"$PROJECT_DIRECTORY_ID"},"directoryProjectId":{"S":"$DIRECTORY_PROJECT_ID"},"projectId":{"S":"refero"},"taskId":{"S":"hero-design"},"sortOrder":{"N":"50"},"titleKey":{"S":"tasks.item.heroDesign"},"assigneeUserId":{"S":"sato@example.com"},"status":{"S":"review"},"dueDate":{"S":"2026/06/10"},"priority":{"S":"medium"}}}},
    {"PutRequest":{"Item":{"directoryId":{"S":"$PROJECT_DIRECTORY_ID"},"directoryProjectId":{"S":"$DIRECTORY_PROJECT_ID"},"projectId":{"S":"refero"},"taskId":{"S":"analytics-tags"},"sortOrder":{"N":"60"},"titleKey":{"S":"tasks.item.analyticsTags"},"assigneeUserId":{"S":"suzuki@example.com"},"status":{"S":"in-progress"},"dueDate":{"S":"2026/06/11"},"priority":{"S":"low"}}}},
    {"PutRequest":{"Item":{"directoryId":{"S":"$PROJECT_DIRECTORY_ID"},"directoryProjectId":{"S":"$DIRECTORY_PROJECT_ID"},"projectId":{"S":"refero"},"taskId":{"S":"competitor-report"},"sortOrder":{"N":"70"},"titleKey":{"S":"tasks.item.competitorReport"},"assigneeUserId":{"S":"tanaka@example.com"},"status":{"S":"done"},"dueDate":{"S":"2026/06/02"},"priority":{"S":"low"}}}},
    {"PutRequest":{"Item":{"directoryId":{"S":"$PROJECT_DIRECTORY_ID"},"directoryProjectId":{"S":"$DIRECTORY_PROJECT_ID"},"projectId":{"S":"refero"},"taskId":{"S":"terms-page"},"sortOrder":{"N":"80"},"titleKey":{"S":"tasks.item.termsPage"},"assigneeUserId":{"S":"yamamoto@example.com"},"status":{"S":"todo"},"dueDate":{"S":"2026/06/12"},"priority":{"S":"medium"}}}},
    {"PutRequest":{"Item":{"directoryId":{"S":"$PROJECT_DIRECTORY_ID"},"directoryProjectId":{"S":"$DIRECTORY_PROJECT_ID"},"projectId":{"S":"refero"},"taskId":{"S":"faq-content"},"sortOrder":{"N":"90"},"titleKey":{"S":"tasks.item.faqContent"},"assigneeUserId":{"S":"sato@example.com"},"status":{"S":"todo"},"dueDate":{"S":"2026/06/15"},"priority":{"S":"low"}}}},
    {"PutRequest":{"Item":{"directoryId":{"S":"$PROJECT_DIRECTORY_ID"},"directoryProjectId":{"S":"$DIRECTORY_PROJECT_ID"},"projectId":{"S":"refero"},"taskId":{"S":"landing-release"},"sortOrder":{"N":"100"},"titleKey":{"S":"tasks.item.landingRelease"},"assigneeUserId":{"S":"suzuki@example.com"},"status":{"S":"todo"},"dueDate":{"S":"2026/06/16"},"priority":{"S":"high"}}}}
  ]
}
JSON
)

remaining_request_items="$request_items"
for attempt in 1 2 3 4 5; do
  unprocessed_items="$(
    aws dynamodb batch-write-item \
      "${endpoint_args[@]}" \
      "${auth_args[@]}" \
      --region "$AWS_REGION" \
      --request-items "$remaining_request_items" \
      --output json \
      --query 'UnprocessedItems'
  )"

  if [[ "$unprocessed_items" == "{}" ]]; then
    echo "DynamoDB task seed written: table=$TASKS_TABLE_NAME directory=$PROJECT_DIRECTORY_ID project=refero count=10"
    exit 0
  fi

  remaining_request_items="$unprocessed_items"
  sleep "$((attempt * 2))"
done

echo "DynamoDB task seed still has unprocessed items after retries." >&2
echo "$remaining_request_items" >&2
exit 1
