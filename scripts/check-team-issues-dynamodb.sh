#!/usr/bin/env bash
set -euo pipefail

if [[ -z "${TEAM_ISSUES_TABLE_NAME:-}" ]]; then
  echo "TEAM_ISSUES_TABLE_NAME is required. Use the CDK TeamIssuesTableName output." >&2
  exit 2
fi

if [[ -z "${TEAM_ISSUE_EVENTS_TABLE_NAME:-}" ]]; then
  echo "TEAM_ISSUE_EVENTS_TABLE_NAME is required. Use the CDK TeamIssueEventsTableName output." >&2
  exit 2
fi

TEAM_ID="${TEAM_ID:-core-team}"
PROJECT_ID="${PROJECT_ID:-refero}"
AWS_REGION="${AWS_REGION:-${AWS_DEFAULT_REGION:-us-east-1}}"
PROJECT_DIRECTORY_ID="${MUKUROJI_WORKSPACE_DIRECTORY_ID:-${PROJECT_DIRECTORY_ID:-${MUKUROJI_PROJECT_DIRECTORY_ID:-workspace#mukuroji-local}}}"
DIRECTORY_TEAM_ID="${PROJECT_DIRECTORY_ID}#team#${TEAM_ID}"
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
  "${endpoint_args[@]}"
  "${auth_args[@]}"
)

team_issue_count="$(
  aws dynamodb query \
    "${common_args[@]}" \
    --table-name "$TEAM_ISSUES_TABLE_NAME" \
    --index-name TeamIssueSortOrderIndex \
    --key-condition-expression "directoryTeamId = :directoryTeamId" \
    --expression-attribute-values "{\":directoryTeamId\":{\"S\":\"$DIRECTORY_TEAM_ID\"}}" \
    --select COUNT \
    --query 'Count' \
    --output text
)"

project_issue_count="$(
  aws dynamodb query \
    "${common_args[@]}" \
    --table-name "$TEAM_ISSUES_TABLE_NAME" \
    --index-name AssignedProjectIssueIndex \
    --key-condition-expression "directoryProjectId = :directoryProjectId" \
    --expression-attribute-values "{\":directoryProjectId\":{\"S\":\"$DIRECTORY_PROJECT_ID\"}}" \
    --select COUNT \
    --query 'Count' \
    --output text
)"

aws dynamodb describe-table \
  "${common_args[@]}" \
  --table-name "$TEAM_ISSUE_EVENTS_TABLE_NAME" \
  --query 'Table.TableStatus' \
  --output text >/dev/null

event_count="not-queried"
legacy_commented_event_count="not-queried"
if [[ -n "${ISSUE_ID:-}" ]]; then
  directory_team_issue_id="${DIRECTORY_TEAM_ID}#issue#${ISSUE_ID}"
  event_count="$(
    aws dynamodb query \
      "${common_args[@]}" \
      --table-name "$TEAM_ISSUE_EVENTS_TABLE_NAME" \
      --key-condition-expression "directoryTeamIssueId = :directoryTeamIssueId" \
      --expression-attribute-values "{\":directoryTeamIssueId\":{\"S\":\"$directory_team_issue_id\"}}" \
      --select COUNT \
      --query 'Count' \
      --output text
  )"
  legacy_commented_event_count="$(
    aws dynamodb query \
      "${common_args[@]}" \
      --table-name "$TEAM_ISSUE_EVENTS_TABLE_NAME" \
      --key-condition-expression "directoryTeamIssueId = :directoryTeamIssueId" \
      --filter-expression "eventType = :eventType" \
      --expression-attribute-values "{\":directoryTeamIssueId\":{\"S\":\"$directory_team_issue_id\"},\":eventType\":{\"S\":\"commented\"}}" \
      --select COUNT \
      --query 'Count' \
      --output text
  )"
  if [[ "$legacy_commented_event_count" != "0" ]]; then
    echo "Legacy commented events remain for issue=$ISSUE_ID count=$legacy_commented_event_count." >&2
    exit 1
  fi
fi

echo "DynamoDB team issue tables OK: team_table=$TEAM_ISSUES_TABLE_NAME events_table=$TEAM_ISSUE_EVENTS_TABLE_NAME team=$TEAM_ID team_issue_count=$team_issue_count project=$PROJECT_ID project_issue_count=$project_issue_count event_count=$event_count legacy_commented_event_count=$legacy_commented_event_count"
