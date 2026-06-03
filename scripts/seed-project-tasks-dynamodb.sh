#!/usr/bin/env bash
set -euo pipefail

if [[ -z "${TASKS_TABLE_NAME:-}" ]]; then
  echo "TASKS_TABLE_NAME is required. Use the CDK ProjectTasksTableName output." >&2
  exit 2
fi

AWS_REGION="${AWS_REGION:-${AWS_DEFAULT_REGION:-us-east-1}}"
PROJECT_DIRECTORY_ID="${PROJECT_DIRECTORY_ID:-user#demo@example.com}"
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
    {"PutRequest":{"Item":{"directoryId":{"S":"$PROJECT_DIRECTORY_ID"},"directoryProjectId":{"S":"$DIRECTORY_PROJECT_ID"},"projectId":{"S":"refero"},"taskId":{"S":"wireframe"},"sortOrder":{"N":"10"},"titleKey":{"S":"tasks.item.wireframe"},"assigneeKey":{"S":"tasks.assignee.sato"},"status":{"S":"in-progress"},"dueDate":{"S":"2026/06/03"},"priority":{"S":"high"}}}},
    {"PutRequest":{"Item":{"directoryId":{"S":"$PROJECT_DIRECTORY_ID"},"directoryProjectId":{"S":"$DIRECTORY_PROJECT_ID"},"projectId":{"S":"refero"},"taskId":{"S":"brand-guideline"},"sortOrder":{"N":"20"},"titleKey":{"S":"tasks.item.brandGuideline"},"assigneeKey":{"S":"tasks.assignee.suzuki"},"status":{"S":"review"},"dueDate":{"S":"2026/06/05"},"priority":{"S":"medium"}}}},
    {"PutRequest":{"Item":{"directoryId":{"S":"$PROJECT_DIRECTORY_ID"},"directoryProjectId":{"S":"$DIRECTORY_PROJECT_ID"},"projectId":{"S":"refero"},"taskId":{"S":"pricing-content"},"sortOrder":{"N":"30"},"titleKey":{"S":"tasks.item.pricingContent"},"assigneeKey":{"S":"tasks.assignee.tanaka"},"status":{"S":"in-progress"},"dueDate":{"S":"2026/06/08"},"priority":{"S":"high"}}}},
    {"PutRequest":{"Item":{"directoryId":{"S":"$PROJECT_DIRECTORY_ID"},"directoryProjectId":{"S":"$DIRECTORY_PROJECT_ID"},"projectId":{"S":"refero"},"taskId":{"S":"seo-research"},"sortOrder":{"N":"40"},"titleKey":{"S":"tasks.item.seoResearch"},"assigneeKey":{"S":"tasks.assignee.yamamoto"},"status":{"S":"todo"},"dueDate":{"S":"2026/06/09"},"priority":{"S":"medium"}}}},
    {"PutRequest":{"Item":{"directoryId":{"S":"$PROJECT_DIRECTORY_ID"},"directoryProjectId":{"S":"$DIRECTORY_PROJECT_ID"},"projectId":{"S":"refero"},"taskId":{"S":"hero-design"},"sortOrder":{"N":"50"},"titleKey":{"S":"tasks.item.heroDesign"},"assigneeKey":{"S":"tasks.assignee.sato"},"status":{"S":"review"},"dueDate":{"S":"2026/06/10"},"priority":{"S":"medium"}}}},
    {"PutRequest":{"Item":{"directoryId":{"S":"$PROJECT_DIRECTORY_ID"},"directoryProjectId":{"S":"$DIRECTORY_PROJECT_ID"},"projectId":{"S":"refero"},"taskId":{"S":"analytics-tags"},"sortOrder":{"N":"60"},"titleKey":{"S":"tasks.item.analyticsTags"},"assigneeKey":{"S":"tasks.assignee.suzuki"},"status":{"S":"in-progress"},"dueDate":{"S":"2026/06/11"},"priority":{"S":"low"}}}},
    {"PutRequest":{"Item":{"directoryId":{"S":"$PROJECT_DIRECTORY_ID"},"directoryProjectId":{"S":"$DIRECTORY_PROJECT_ID"},"projectId":{"S":"refero"},"taskId":{"S":"competitor-report"},"sortOrder":{"N":"70"},"titleKey":{"S":"tasks.item.competitorReport"},"assigneeKey":{"S":"tasks.assignee.tanaka"},"status":{"S":"done"},"dueDate":{"S":"2026/06/02"},"priority":{"S":"low"}}}},
    {"PutRequest":{"Item":{"directoryId":{"S":"$PROJECT_DIRECTORY_ID"},"directoryProjectId":{"S":"$DIRECTORY_PROJECT_ID"},"projectId":{"S":"refero"},"taskId":{"S":"terms-page"},"sortOrder":{"N":"80"},"titleKey":{"S":"tasks.item.termsPage"},"assigneeKey":{"S":"tasks.assignee.yamamoto"},"status":{"S":"todo"},"dueDate":{"S":"2026/06/12"},"priority":{"S":"medium"}}}},
    {"PutRequest":{"Item":{"directoryId":{"S":"$PROJECT_DIRECTORY_ID"},"directoryProjectId":{"S":"$DIRECTORY_PROJECT_ID"},"projectId":{"S":"refero"},"taskId":{"S":"faq-content"},"sortOrder":{"N":"90"},"titleKey":{"S":"tasks.item.faqContent"},"assigneeKey":{"S":"tasks.assignee.sato"},"status":{"S":"todo"},"dueDate":{"S":"2026/06/15"},"priority":{"S":"low"}}}},
    {"PutRequest":{"Item":{"directoryId":{"S":"$PROJECT_DIRECTORY_ID"},"directoryProjectId":{"S":"$DIRECTORY_PROJECT_ID"},"projectId":{"S":"refero"},"taskId":{"S":"landing-release"},"sortOrder":{"N":"100"},"titleKey":{"S":"tasks.item.landingRelease"},"assigneeKey":{"S":"tasks.assignee.suzuki"},"status":{"S":"todo"},"dueDate":{"S":"2026/06/16"},"priority":{"S":"high"}}}}
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
