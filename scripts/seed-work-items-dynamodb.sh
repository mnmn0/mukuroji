#!/usr/bin/env bash
set -euo pipefail

WORK_ITEMS_TABLE="${WORK_ITEMS_TABLE_NAME:-${MUKUROJI_WORK_ITEMS_TABLE:-${TEAM_ISSUES_TABLE_NAME:-${MUKUROJI_TEAM_ISSUES_TABLE:-}}}}"
if [[ -z "$WORK_ITEMS_TABLE" ]]; then
  echo "WORK_ITEMS_TABLE_NAME (or MUKUROJI_WORK_ITEMS_TABLE / TEAM_ISSUES_TABLE_NAME / MUKUROJI_TEAM_ISSUES_TABLE) is required." >&2
  exit 2
fi

AWS_REGION="${AWS_REGION:-${AWS_DEFAULT_REGION:-us-east-1}}"
WORKSPACE_DIRECTORY_ID="${MUKUROJI_WORKSPACE_DIRECTORY_ID:-${PROJECT_DIRECTORY_ID:-${MUKUROJI_PROJECT_DIRECTORY_ID:-workspace#mukuroji-local}}}"
DIRECTORY_TEAM_ID="${WORKSPACE_DIRECTORY_ID}#team#core-team"
DIRECTORY_PROJECT_ID="${WORKSPACE_DIRECTORY_ID}#project#refero"
SEED_TIMESTAMP="2026-06-01T00:00:00.000Z"

case "$WORKSPACE_DIRECTORY_ID" in
  '' | *[!A-Za-z0-9._:/#@+-]*)
    echo "MUKUROJI_WORKSPACE_DIRECTORY_ID contains unsupported characters." >&2
    exit 2
    ;;
esac

endpoint_args=()
DYNAMODB_ENDPOINT="${DYNAMODB_ENDPOINT:-${AWS_ENDPOINT_URL_DYNAMODB:-${AWS_ENDPOINT_URL:-}}}"
if ! MUKUROJI_SEED_DYNAMODB_ENDPOINT="$DYNAMODB_ENDPOINT" bun -e '
  const value = process.env.MUKUROJI_SEED_DYNAMODB_ENDPOINT
  try {
    const endpoint = new URL(value ?? "")
    const localHosts = new Set([
      "localhost",
      "127.0.0.1",
      "[::1]",
      "0.0.0.0",
      "floci",
      "localstack",
    ])
    if (
      endpoint.protocol !== "http:" ||
      endpoint.username !== "" ||
      endpoint.password !== "" ||
      endpoint.pathname !== "/" ||
      endpoint.search !== "" ||
      endpoint.hash !== "" ||
      !localHosts.has(endpoint.hostname)
    ) process.exit(1)
  } catch {
    process.exit(1)
  }
'; then
  echo "This legacy seed is local-only and requires an explicit local HTTP DynamoDB endpoint." >&2
  exit 2
fi
if [[ "${MUKUROJI_LOCAL_AWS_RUNTIME:-}" != "floci" ]]; then
  echo "This legacy seed requires MUKUROJI_LOCAL_AWS_RUNTIME=floci." >&2
  exit 2
fi
endpoint_args=(--endpoint-url "$DYNAMODB_ENDPOINT")

auth_args=()
if [[ "${AWS_NO_SIGN_REQUEST:-}" == "1" ]]; then
  auth_args=(--no-sign-request)
fi

seeded_count=0
preserved_count=0

seed_work_item() {
  local work_item_id="$1"
  local sort_order="$2"
  local title="$3"
  local assignee_user_id="$4"
  local workflow_status_id="$5"
  local status_category="$6"
  local due_date="$7"
  local priority="$8"
  local put_error

  if put_error="$(aws dynamodb put-item \
    "${endpoint_args[@]}" \
    "${auth_args[@]}" \
    --region "$AWS_REGION" \
    --table-name "$WORK_ITEMS_TABLE" \
    --item "{
      \"directoryId\": {\"S\": \"$WORKSPACE_DIRECTORY_ID\"},
      \"directoryTeamId\": {\"S\": \"$DIRECTORY_TEAM_ID\"},
      \"directoryProjectId\": {\"S\": \"$DIRECTORY_PROJECT_ID\"},
      \"teamId\": {\"S\": \"core-team\"},
      \"assignedProjectId\": {\"S\": \"refero\"},
      \"issueId\": {\"S\": \"$work_item_id\"},
      \"schemaVersion\": {\"N\": \"1\"},
      \"revision\": {\"N\": \"1\"},
      \"sortOrder\": {\"N\": \"$sort_order\"},
      \"title\": {\"S\": \"$title\"},
      \"assigneeUserId\": {\"S\": \"$assignee_user_id\"},
      \"creatorMemberKey\": {\"S\": \"$assignee_user_id\"},
      \"workflowSchemaVersion\": {\"N\": \"1\"},
      \"workflowStatusId\": {\"S\": \"$workflow_status_id\"},
      \"statusCategory\": {\"S\": \"$status_category\"},
      \"customFieldValues\": {\"M\": {}},
      \"relationIds\": {\"L\": []},
      \"dueDate\": {\"S\": \"$due_date\"},
      \"priority\": {\"S\": \"$priority\"},
      \"createdAt\": {\"S\": \"$SEED_TIMESTAMP\"},
      \"updatedAt\": {\"S\": \"$SEED_TIMESTAMP\"}
    }" \
    --condition-expression 'attribute_not_exists(directoryTeamId) AND attribute_not_exists(issueId)' \
    2>&1 >/dev/null)"; then
    seeded_count=$((seeded_count + 1))
    return
  fi

  case "$put_error" in
    *ConditionalCheckFailedException*)
      preserved_count=$((preserved_count + 1))
      ;;
    *)
      printf '%s\n' "$put_error" >&2
      exit 1
      ;;
  esac
}

seed_work_item "wireframe" 10 "新しいランディングページのワイヤーフレーム作成" "sato@example.com" "in-progress" "started" "2026/06/03" "high"
seed_work_item "brand-guideline" 20 "ブランドガイドラインの更新" "suzuki@example.com" "review" "started" "2026/06/05" "medium"
seed_work_item "pricing-content" 30 "料金ページのコンテンツ作成" "tanaka@example.com" "in-progress" "started" "2026/06/08" "high"
seed_work_item "seo-research" 40 "SEO キーワードリサーチ" "yamamoto@example.com" "todo" "unstarted" "2026/06/09" "medium"
seed_work_item "hero-design" 50 "ヒーロー画像のデザイン作成" "sato@example.com" "review" "started" "2026/06/10" "medium"
seed_work_item "analytics-tags" 60 "アナリティクスタグの実装" "suzuki@example.com" "in-progress" "started" "2026/06/11" "low"
seed_work_item "competitor-report" 70 "競合サイトの分析レポート作成" "tanaka@example.com" "done" "completed" "2026/06/02" "low"
seed_work_item "terms-page" 80 "利用規約ページの作成" "yamamoto@example.com" "todo" "unstarted" "2026/06/12" "medium"
seed_work_item "faq-content" 90 "FAQ セクションのコンテンツ作成" "sato@example.com" "todo" "unstarted" "2026/06/15" "low"
seed_work_item "landing-release" 100 "ランディングページの公開" "suzuki@example.com" "todo" "unstarted" "2026/06/16" "high"

echo "DynamoDB Work Item seed complete: table=$WORK_ITEMS_TABLE workspace=$WORKSPACE_DIRECTORY_ID team=core-team project=refero created=$seeded_count preserved=$preserved_count"
