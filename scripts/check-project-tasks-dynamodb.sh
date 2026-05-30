#!/usr/bin/env bash
set -euo pipefail

if [[ -z "${TASKS_TABLE_NAME:-}" ]]; then
  echo "TASKS_TABLE_NAME is required. Use the CDK ProjectTasksTableName output." >&2
  exit 2
fi

PROJECT_ID="${PROJECT_ID:-refero}"
AWS_REGION="${AWS_REGION:-${AWS_DEFAULT_REGION:-us-east-1}}"

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
  --key-condition-expression "projectId = :projectId"
  --expression-attribute-values "{\":projectId\":{\"S\":\"$PROJECT_ID\"}}"
)

mapfile -t task_rows < <(
  aws dynamodb query \
    "${endpoint_args[@]}" \
    "${auth_args[@]}" \
    "${common_args[@]}" \
    --projection-expression "taskId,sortOrder,titleKey,assigneeKey,#status,dueDate,priority" \
    --expression-attribute-names '{"#status":"status"}' \
    --query 'Items[].[taskId.S,sortOrder.N,titleKey.S,assigneeKey.S,status.S,dueDate.S,priority.S]' \
    --output text
)

if [[ "${#task_rows[@]}" != "10" ]]; then
  echo "Expected 10 tasks for project '$PROJECT_ID', but DynamoDB returned ${#task_rows[@]}." >&2
  exit 1
fi

expected_task_rows=(
  $'wireframe\t10\ttasks.item.wireframe\ttasks.assignee.sato\tin-progress\t2025/05/26\thigh'
  $'brand-guideline\t20\ttasks.item.brandGuideline\ttasks.assignee.suzuki\treview\t2025/05/27\tmedium'
  $'pricing-content\t30\ttasks.item.pricingContent\ttasks.assignee.tanaka\tin-progress\t2025/05/28\thigh'
  $'seo-research\t40\ttasks.item.seoResearch\ttasks.assignee.yamamoto\ttodo\t2025/05/29\tmedium'
  $'hero-design\t50\ttasks.item.heroDesign\ttasks.assignee.sato\treview\t2025/05/30\tmedium'
  $'analytics-tags\t60\ttasks.item.analyticsTags\ttasks.assignee.suzuki\tin-progress\t2025/06/02\tlow'
  $'competitor-report\t70\ttasks.item.competitorReport\ttasks.assignee.tanaka\tdone\t2025/06/03\tlow'
  $'terms-page\t80\ttasks.item.termsPage\ttasks.assignee.yamamoto\ttodo\t2025/06/04\tmedium'
  $'faq-content\t90\ttasks.item.faqContent\ttasks.assignee.sato\ttodo\t2025/06/05\tlow'
  $'landing-release\t100\ttasks.item.landingRelease\ttasks.assignee.suzuki\ttodo\t2025/06/06\thigh'
)

for row_index in "${!expected_task_rows[@]}"; do
  if [[ "${task_rows[$row_index]}" != "${expected_task_rows[$row_index]}" ]]; then
    echo "Unexpected DynamoDB task row at index $row_index." >&2
    echo "Expected: ${expected_task_rows[$row_index]}" >&2
    echo "Actual:   ${task_rows[$row_index]}" >&2
    exit 1
  fi
done

echo "DynamoDB task seed OK: table=$TASKS_TABLE_NAME project=$PROJECT_ID count=${#task_rows[@]}"
