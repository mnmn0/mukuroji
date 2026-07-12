#!/usr/bin/env bash
set -euo pipefail

if [[ -z "${TASKS_TABLE_NAME:-}" ]]; then
  echo "TASKS_TABLE_NAME is required. Use the CDK ProjectTasksTableName output." >&2
  exit 2
fi

PROJECT_ID="${PROJECT_ID:-refero}"
AWS_REGION="${AWS_REGION:-${AWS_DEFAULT_REGION:-us-east-1}}"
PROJECT_DIRECTORY_ID="${MUKUROJI_WORKSPACE_DIRECTORY_ID:-${PROJECT_DIRECTORY_ID:-${MUKUROJI_PROJECT_DIRECTORY_ID:-workspace#mukuroji-local}}}"
DIRECTORY_PROJECT_ID="${PROJECT_DIRECTORY_ID}#project#${PROJECT_ID}"

endpoint_args=()
if [[ -n "${AWS_ENDPOINT_URL:-}" ]]; then
  endpoint_args=(--endpoint-url "$AWS_ENDPOINT_URL")
fi

auth_args=()
if [[ "${AWS_NO_SIGN_REQUEST:-}" == "1" ]]; then
  auth_args=(--no-sign-request)
fi

common_args=(
  --region "$AWS_REGION"
  --table-name "$TASKS_TABLE_NAME"
  --index-name ProjectSortOrderIndex
  --key-condition-expression "directoryProjectId = :directoryProjectId"
  --expression-attribute-values "{\":directoryProjectId\":{\"S\":\"$DIRECTORY_PROJECT_ID\"}}"
)

mapfile -t task_rows < <(
  aws dynamodb query \
    "${endpoint_args[@]}" \
    "${auth_args[@]}" \
    "${common_args[@]}" \
    --projection-expression "taskId,sortOrder,titleKey,assigneeUserId,#status,dueDate,priority" \
    --expression-attribute-names '{"#status":"status"}' \
    --query 'Items[].[taskId.S,sortOrder.N,titleKey.S,assigneeUserId.S,status.S,dueDate.S,priority.S]' \
    --output text
)

if [[ "${#task_rows[@]}" != "10" ]]; then
  echo "Expected 10 tasks for project '$PROJECT_ID', but DynamoDB returned ${#task_rows[@]}." >&2
  exit 1
fi

expected_task_rows=(
  $'wireframe\t10\ttasks.item.wireframe\tsato@example.com\tin-progress\t2026/06/03\thigh'
  $'brand-guideline\t20\ttasks.item.brandGuideline\tsuzuki@example.com\treview\t2026/06/05\tmedium'
  $'pricing-content\t30\ttasks.item.pricingContent\ttanaka@example.com\tin-progress\t2026/06/08\thigh'
  $'seo-research\t40\ttasks.item.seoResearch\tyamamoto@example.com\ttodo\t2026/06/09\tmedium'
  $'hero-design\t50\ttasks.item.heroDesign\tsato@example.com\treview\t2026/06/10\tmedium'
  $'analytics-tags\t60\ttasks.item.analyticsTags\tsuzuki@example.com\tin-progress\t2026/06/11\tlow'
  $'competitor-report\t70\ttasks.item.competitorReport\ttanaka@example.com\tdone\t2026/06/02\tlow'
  $'terms-page\t80\ttasks.item.termsPage\tyamamoto@example.com\ttodo\t2026/06/12\tmedium'
  $'faq-content\t90\ttasks.item.faqContent\tsato@example.com\ttodo\t2026/06/15\tlow'
  $'landing-release\t100\ttasks.item.landingRelease\tsuzuki@example.com\ttodo\t2026/06/16\thigh'
)

for row_index in "${!expected_task_rows[@]}"; do
  if [[ "${task_rows[$row_index]}" != "${expected_task_rows[$row_index]}" ]]; then
    echo "Unexpected DynamoDB task row at index $row_index." >&2
    echo "Expected: ${expected_task_rows[$row_index]}" >&2
    echo "Actual:   ${task_rows[$row_index]}" >&2
    exit 1
  fi
done

echo "DynamoDB legacy task rows OK: table=$TASKS_TABLE_NAME directory=$PROJECT_DIRECTORY_ID project=$PROJECT_ID count=${#task_rows[@]}"
