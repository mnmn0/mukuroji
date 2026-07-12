#!/bin/sh
set -eu

ENDPOINT_URL="${AWS_ENDPOINT_URL:-http://localhost:4566}"
PUBLIC_ENDPOINT_URL="${MUKUROJI_PUBLIC_FLOCI_ENDPOINT:-$ENDPOINT_URL}"
PUBLIC_ENDPOINT_URL="${PUBLIC_ENDPOINT_URL%/}"
POOL_ID="${COGNITO_USER_POOL_ID:-us-east-1_mukuroji}"
POOL_NAME="${COGNITO_USER_POOL_NAME:-mukuroji-local}"
CLIENT_NAME="${COGNITO_USER_POOL_CLIENT_NAME:-mukuroji-web-local}"
TEST_USERNAME="${COGNITO_TEST_USERNAME:-demo@example.com}"
TEST_PASSWORD="${COGNITO_TEST_PASSWORD:-Password123!}"
INITIAL_OWNER_USERNAME="${MUKUROJI_INITIAL_OWNER_USERNAME:-$TEST_USERNAME}"
INITIAL_OWNER_EMAIL="${MUKUROJI_INITIAL_OWNER_EMAIL:-$TEST_USERNAME}"
SYSTEM_ADMIN_GROUP="${MUKUROJI_SYSTEM_ADMIN_GROUP:-mukuroji-system-admins}"
DASHBOARD_TABLE="${MUKUROJI_DASHBOARD_TABLE:-mukuroji-dashboard-local}"
PROJECT_TASKS_TABLE="${MUKUROJI_PROJECT_TASKS_TABLE:-mukuroji-project-tasks-v2-local}"
PROJECT_DIRECTORY_TABLE="${MUKUROJI_PROJECT_DIRECTORY_TABLE:-mukuroji-project-directory-local}"
WORK_ITEMS_TABLE="${MUKUROJI_WORK_ITEMS_TABLE:-${WORK_ITEMS_TABLE_NAME:-${MUKUROJI_TEAM_ISSUES_TABLE:-mukuroji-team-issues-local}}}"
TEAM_ISSUES_TABLE="$WORK_ITEMS_TABLE"
TEAM_ISSUE_EVENTS_TABLE="${MUKUROJI_TEAM_ISSUE_EVENTS_TABLE:-mukuroji-team-issue-events-local}"
COLLABORATION_TABLE="${MUKUROJI_COLLABORATION_TABLE:-${COLLABORATION_TABLE_NAME:-mukuroji-collaboration-local}}"
WORKSPACE_SEARCH_TABLE="${MUKUROJI_WORKSPACE_SEARCH_TABLE:-${WORKSPACE_SEARCH_TABLE_NAME:-mukuroji-workspace-search-local}}"
NOTIFICATIONS_TABLE="${MUKUROJI_NOTIFICATIONS_TABLE:-${NOTIFICATIONS_TABLE_NAME:-mukuroji-notifications-local}}"
REALTIME_SESSIONS_TABLE="${MUKUROJI_REALTIME_SESSIONS_TABLE:-${REALTIME_SESSIONS_TABLE_NAME:-mukuroji-realtime-sessions-local}}"
AUDIT_EVENTS_TABLE="${MUKUROJI_AUDIT_EVENTS_TABLE:-${AUDIT_EVENTS_TABLE_NAME:-mukuroji-audit-events}}"
AUDIT_RETENTION_DAYS="${MUKUROJI_AUDIT_RETENTION_DAYS:-${AUDIT_RETENTION_DAYS:-2555}}"
WORKSPACE_ACCESS_TABLE="${MUKUROJI_WORKSPACE_ACCESS_TABLE:-mukuroji-workspace-access-local}"
WORKSPACE_DIRECTORY_ID="${MUKUROJI_WORKSPACE_DIRECTORY_ID:-${MUKUROJI_PROJECT_DIRECTORY_ID:-workspace#mukuroji-local}}"
PROJECT_DIRECTORY_ID="$WORKSPACE_DIRECTORY_ID"
PROJECT_MEMBER_KEY="$(printf '%s' "$INITIAL_OWNER_EMAIL" | tr '[:upper:]' '[:lower:]')"
DASHBOARD_UPDATED_AT="${MUKUROJI_DASHBOARD_UPDATED_AT:-$(date -u +%Y-%m-%dT%H:%M:%S.000Z)}"
GENERATED_DIR="${MUKUROJI_GENERATED_DIR:-/app/generated}"

case "$WORKSPACE_DIRECTORY_ID" in
  '' | *[!A-Za-z0-9._:/#@+-]*)
    echo "MUKUROJI_WORKSPACE_DIRECTORY_ID contains unsupported characters." >&2
    exit 2
    ;;
esac

case "$PROJECT_MEMBER_KEY" in
  '' | *[!a-z0-9._%+@-]* | @* | *@ | *@*@*)
    echo "MUKUROJI_INITIAL_OWNER_EMAIL must be an email address." >&2
    exit 2
    ;;
esac

case "$INITIAL_OWNER_USERNAME" in
  '' | *[!A-Za-z0-9._@+-]*)
    echo "MUKUROJI_INITIAL_OWNER_USERNAME contains unsupported characters." >&2
    exit 2
    ;;
esac

aws_local() {
  aws --endpoint-url "$ENDPOINT_URL" "$@"
}

if ! aws_local cognito-idp describe-user-pool --user-pool-id "$POOL_ID" >/dev/null 2>&1; then
  aws_local cognito-idp create-user-pool \
    --pool-name "$POOL_NAME" \
    --user-pool-tags "floci:override-id=$POOL_ID" \
    --username-attributes email \
    --schema \
      Name=directory_id,AttributeDataType=String,Mutable=true,Required=false \
      Name=workspace_id,AttributeDataType=String,Mutable=true,Required=false \
    --policies 'PasswordPolicy={MinimumLength=8,RequireUppercase=true,RequireLowercase=true,RequireNumbers=true,RequireSymbols=true}' \
    >/dev/null
fi

ensure_cognito_custom_attribute() {
  attribute_name="$1"
  existing_count="$(aws_local cognito-idp describe-user-pool \
    --user-pool-id "$POOL_ID" \
    --query "length(UserPool.SchemaAttributes[?Name=='custom:$attribute_name'])" \
    --output text)"

  if [ "$existing_count" = "0" ]; then
    if ! add_attribute_error="$(aws_local cognito-idp add-custom-attributes \
      --user-pool-id "$POOL_ID" \
      --custom-attributes "Name=$attribute_name,AttributeDataType=String,Mutable=true" \
      2>&1)"; then
      case "$add_attribute_error" in
        *UnsupportedOperation* | *"not supported"*)
          echo "Floci does not expose AddCustomAttributes; validating custom:$attribute_name on the seeded user instead." >&2
          ;;
        *)
          echo "$add_attribute_error" >&2
          exit 1
          ;;
      esac
    fi
  fi
}

ensure_cognito_custom_attribute "directory_id"
ensure_cognito_custom_attribute "workspace_id"

CLIENT_ID="$(aws_local cognito-idp list-user-pool-clients \
  --user-pool-id "$POOL_ID" \
  --max-results 60 \
  --query "UserPoolClients[?ClientName=='$CLIENT_NAME'].ClientId | [0]" \
  --output text)"

if [ "$CLIENT_ID" = "None" ] || [ -z "$CLIENT_ID" ]; then
  CLIENT_ID="$(aws_local cognito-idp create-user-pool-client \
    --user-pool-id "$POOL_ID" \
    --client-name "$CLIENT_NAME" \
    --no-generate-secret \
    --explicit-auth-flows ALLOW_USER_PASSWORD_AUTH ALLOW_REFRESH_TOKEN_AUTH \
    --query UserPoolClient.ClientId \
    --output text)"
fi

ensure_cognito_user() {
  username="$1"
  email="$2"
  display_name="$3"

  if ! aws_local cognito-idp admin-get-user \
    --user-pool-id "$POOL_ID" \
    --username "$username" >/dev/null 2>&1; then
    aws_local cognito-idp admin-create-user \
      --user-pool-id "$POOL_ID" \
      --username "$username" \
      --temporary-password "$TEST_PASSWORD" \
      --message-action SUPPRESS \
      --user-attributes Name=email,Value="$email" Name=email_verified,Value=true Name=name,Value="$display_name" Name=custom:directory_id,Value="$WORKSPACE_DIRECTORY_ID" Name=custom:workspace_id,Value="$WORKSPACE_DIRECTORY_ID" \
      >/dev/null
  else
    aws_local cognito-idp admin-update-user-attributes \
      --user-pool-id "$POOL_ID" \
      --username "$username" \
      --user-attributes Name=email,Value="$email" Name=email_verified,Value=true Name=name,Value="$display_name" Name=custom:directory_id,Value="$WORKSPACE_DIRECTORY_ID" Name=custom:workspace_id,Value="$WORKSPACE_DIRECTORY_ID" \
      >/dev/null
  fi

  aws_local cognito-idp admin-set-user-password \
    --user-pool-id "$POOL_ID" \
    --username "$username" \
    --password "$TEST_PASSWORD" \
    --permanent \
    >/dev/null
}

ensure_cognito_user "$INITIAL_OWNER_USERNAME" "$INITIAL_OWNER_EMAIL" "Demo User"
ensure_cognito_user "sato@example.com" "sato@example.com" "佐藤 花子"
ensure_cognito_user "suzuki@example.com" "suzuki@example.com" "鈴木 大輔"
ensure_cognito_user "tanaka@example.com" "tanaka@example.com" "田中 美咲"
ensure_cognito_user "yamamoto@example.com" "yamamoto@example.com" "山本 健太"
ensure_cognito_user "viewer@example.com" "viewer@example.com" "Viewer User"

if ! aws_local cognito-idp get-group \
  --user-pool-id "$POOL_ID" \
  --group-name "$SYSTEM_ADMIN_GROUP" >/dev/null 2>&1; then
  aws_local cognito-idp create-group \
    --user-pool-id "$POOL_ID" \
    --group-name "$SYSTEM_ADMIN_GROUP" \
    >/dev/null
fi

aws_local cognito-idp admin-add-user-to-group \
  --user-pool-id "$POOL_ID" \
  --username "$INITIAL_OWNER_USERNAME" \
  --group-name "$SYSTEM_ADMIN_GROUP" \
  >/dev/null

if ! aws_local dynamodb describe-table --table-name "$DASHBOARD_TABLE" >/dev/null 2>&1; then
  aws_local dynamodb create-table \
    --table-name "$DASHBOARD_TABLE" \
    --attribute-definitions AttributeName=id,AttributeType=S \
    --key-schema AttributeName=id,KeyType=HASH \
    --billing-mode PAY_PER_REQUEST \
    >/dev/null
fi

aws_local dynamodb put-item \
  --table-name "$DASHBOARD_TABLE" \
  --item "{
    \"id\": {\"S\": \"summary\"},
    \"projects\": {\"N\": \"3\"},
    \"tasks\": {\"N\": \"18\"},
    \"blocked\": {\"N\": \"2\"},
    \"updatedAt\": {\"S\": \"$DASHBOARD_UPDATED_AT\"}
  }" \
  >/dev/null

if ! aws_local dynamodb describe-table --table-name "$PROJECT_TASKS_TABLE" >/dev/null 2>&1; then
  aws_local dynamodb create-table \
    --table-name "$PROJECT_TASKS_TABLE" \
    --attribute-definitions \
      AttributeName=directoryProjectId,AttributeType=S \
      AttributeName=taskId,AttributeType=S \
      AttributeName=sortOrder,AttributeType=N \
    --key-schema \
      AttributeName=directoryProjectId,KeyType=HASH \
      AttributeName=taskId,KeyType=RANGE \
    --global-secondary-indexes '[
      {
        "IndexName": "ProjectSortOrderIndex",
        "KeySchema": [
          {"AttributeName": "directoryProjectId", "KeyType": "HASH"},
          {"AttributeName": "sortOrder", "KeyType": "RANGE"}
        ],
        "Projection": {"ProjectionType": "ALL"}
      }
    ]' \
    --billing-mode PAY_PER_REQUEST \
    >/dev/null
fi

aws_local dynamodb wait table-exists --table-name "$PROJECT_TASKS_TABLE"

if ! aws_local dynamodb describe-table --table-name "$WORK_ITEMS_TABLE" >/dev/null 2>&1; then
  aws_local dynamodb create-table \
    --table-name "$WORK_ITEMS_TABLE" \
    --attribute-definitions \
      AttributeName=directoryTeamId,AttributeType=S \
      AttributeName=issueId,AttributeType=S \
      AttributeName=directoryProjectId,AttributeType=S \
      AttributeName=sortOrder,AttributeType=N \
    --key-schema \
      AttributeName=directoryTeamId,KeyType=HASH \
      AttributeName=issueId,KeyType=RANGE \
    --global-secondary-indexes '[
      {
        "IndexName": "TeamIssueSortOrderIndex",
        "KeySchema": [
          {"AttributeName": "directoryTeamId", "KeyType": "HASH"},
          {"AttributeName": "sortOrder", "KeyType": "RANGE"}
        ],
        "Projection": {"ProjectionType": "ALL"}
      },
      {
        "IndexName": "AssignedProjectIssueIndex",
        "KeySchema": [
          {"AttributeName": "directoryProjectId", "KeyType": "HASH"},
          {"AttributeName": "sortOrder", "KeyType": "RANGE"}
        ],
        "Projection": {"ProjectionType": "ALL"}
      }
    ]' \
    --billing-mode PAY_PER_REQUEST \
    >/dev/null
fi

aws_local dynamodb wait table-exists --table-name "$WORK_ITEMS_TABLE"

WORK_ITEM_SEED_TIMESTAMP="2026-06-01T00:00:00.000Z"

seed_work_item() {
  work_item_id="$1"
  sort_order="$2"
  title_key="$3"
  title="$4"
  assignee_user_id="$5"
  status="$6"
  due_date="$7"
  priority="$8"
  put_item_error=""

  if ! put_item_error="$(aws_local dynamodb put-item \
    --table-name "$WORK_ITEMS_TABLE" \
    --item "{
      \"directoryId\": {\"S\": \"$PROJECT_DIRECTORY_ID\"},
      \"directoryTeamId\": {\"S\": \"$PROJECT_DIRECTORY_ID#team#core-team\"},
      \"directoryProjectId\": {\"S\": \"$PROJECT_DIRECTORY_ID#project#refero\"},
      \"teamId\": {\"S\": \"core-team\"},
      \"assignedProjectId\": {\"S\": \"refero\"},
      \"issueId\": {\"S\": \"$work_item_id\"},
      \"workItemId\": {\"S\": \"$work_item_id\"},
      \"schemaVersion\": {\"N\": \"1\"},
      \"revision\": {\"N\": \"1\"},
      \"sortOrder\": {\"N\": \"$sort_order\"},
      \"titleKey\": {\"S\": \"$title_key\"},
      \"title\": {\"S\": \"$title\"},
      \"assigneeUserId\": {\"S\": \"$assignee_user_id\"},
      \"status\": {\"S\": \"$status\"},
      \"dueDate\": {\"S\": \"$due_date\"},
      \"priority\": {\"S\": \"$priority\"},
      \"createdAt\": {\"S\": \"$WORK_ITEM_SEED_TIMESTAMP\"},
      \"updatedAt\": {\"S\": \"$WORK_ITEM_SEED_TIMESTAMP\"},
      \"source\": {\"S\": \"dynamodb\"},
      \"migrationSource\": {\"S\": \"legacy-project-task\"},
      \"migrationSourceKey\": {\"S\": \"$PROJECT_DIRECTORY_ID#project#refero#task#$work_item_id\"}
    }" \
    --condition-expression 'attribute_not_exists(directoryTeamId) AND attribute_not_exists(issueId)' \
    2>&1 >/dev/null)"; then
    case "$put_item_error" in
      *ConditionalCheckFailedException*) ;;
      *) printf '%s\n' "$put_item_error" >&2; return 1 ;;
    esac
  fi
}

LEGACY_TASK_COUNT="$(aws_local dynamodb scan \
  --table-name "$PROJECT_TASKS_TABLE" \
  --select COUNT \
  --query Count \
  --output text)"

if [ "$LEGACY_TASK_COUNT" = "0" ]; then
  seed_work_item "wireframe" 10 "tasks.item.wireframe" "新しいランディングページのワイヤーフレーム作成" "sato@example.com" "in-progress" "2026/06/03" "high"
  seed_work_item "brand-guideline" 20 "tasks.item.brandGuideline" "ブランドガイドラインの更新" "suzuki@example.com" "review" "2026/06/05" "medium"
  seed_work_item "pricing-content" 30 "tasks.item.pricingContent" "料金ページのコンテンツ作成" "tanaka@example.com" "in-progress" "2026/06/08" "high"
  seed_work_item "seo-research" 40 "tasks.item.seoResearch" "SEO キーワードリサーチ" "yamamoto@example.com" "todo" "2026/06/09" "medium"
  seed_work_item "hero-design" 50 "tasks.item.heroDesign" "ヒーロー画像のデザイン作成" "sato@example.com" "review" "2026/06/10" "medium"
  seed_work_item "analytics-tags" 60 "tasks.item.analyticsTags" "アナリティクスタグの実装" "suzuki@example.com" "in-progress" "2026/06/11" "low"
  seed_work_item "competitor-report" 70 "tasks.item.competitorReport" "競合サイトの分析レポート作成" "tanaka@example.com" "done" "2026/06/02" "low"
  seed_work_item "terms-page" 80 "tasks.item.termsPage" "利用規約ページの作成" "yamamoto@example.com" "todo" "2026/06/12" "medium"
  seed_work_item "faq-content" 90 "tasks.item.faqContent" "FAQ セクションのコンテンツ作成" "sato@example.com" "todo" "2026/06/15" "low"
  seed_work_item "landing-release" 100 "tasks.item.landingRelease" "ランディングページの公開" "suzuki@example.com" "todo" "2026/06/16" "high"
else
  echo "mukuroji legacy task rows preserved for explicit Work Item migration: table=$PROJECT_TASKS_TABLE count=$LEGACY_TASK_COUNT"
fi

if ! aws_local dynamodb describe-table --table-name "$PROJECT_DIRECTORY_TABLE" >/dev/null 2>&1; then
  aws_local dynamodb create-table \
    --table-name "$PROJECT_DIRECTORY_TABLE" \
    --attribute-definitions \
      AttributeName=directoryId,AttributeType=S \
      AttributeName=entryKey,AttributeType=S \
    --key-schema \
      AttributeName=directoryId,KeyType=HASH \
      AttributeName=entryKey,KeyType=RANGE \
    --billing-mode PAY_PER_REQUEST \
    >/dev/null
fi

DIRECTORY_UNPROCESSED_TABLES="$(aws_local dynamodb batch-write-item \
  --request-items "{
    \"$PROJECT_DIRECTORY_TABLE\": [
      {\"PutRequest\":{\"Item\":{\"directoryId\":{\"S\":\"$PROJECT_DIRECTORY_ID\"},\"entryKey\":{\"S\":\"000010#000000#TEAM#core-team\"},\"entryType\":{\"S\":\"team\"},\"teamId\":{\"S\":\"core-team\"},\"teamSortOrder\":{\"N\":\"10\"},\"nameJa\":{\"S\":\"コアチーム\"},\"nameEn\":{\"S\":\"Core Team\"},\"expanded\":{\"BOOL\":true}}}},
      {\"PutRequest\":{\"Item\":{\"directoryId\":{\"S\":\"$PROJECT_DIRECTORY_ID\"},\"entryKey\":{\"S\":\"000010#000010#PROJECT#refero\"},\"entryType\":{\"S\":\"project\"},\"teamId\":{\"S\":\"core-team\"},\"teamSortOrder\":{\"N\":\"10\"},\"projectId\":{\"S\":\"refero\"},\"projectSortOrder\":{\"N\":\"10\"},\"nameJa\":{\"S\":\"Refero\"},\"nameEn\":{\"S\":\"Refero\"},\"tone\":{\"S\":\"blue\"}}}},
      {\"PutRequest\":{\"Item\":{\"directoryId\":{\"S\":\"$PROJECT_DIRECTORY_ID\"},\"entryKey\":{\"S\":\"000010#000020#PROJECT#product-roadmap\"},\"entryType\":{\"S\":\"project\"},\"teamId\":{\"S\":\"core-team\"},\"teamSortOrder\":{\"N\":\"10\"},\"projectId\":{\"S\":\"product-roadmap\"},\"projectSortOrder\":{\"N\":\"20\"},\"nameJa\":{\"S\":\"プロダクトロードマップ\"},\"nameEn\":{\"S\":\"Product Roadmap\"},\"tone\":{\"S\":\"yellow\"}}}},
      {\"PutRequest\":{\"Item\":{\"directoryId\":{\"S\":\"$PROJECT_DIRECTORY_ID\"},\"entryKey\":{\"S\":\"000010#000030#PROJECT#shared-launch\"},\"entryType\":{\"S\":\"project\"},\"teamId\":{\"S\":\"core-team\"},\"teamSortOrder\":{\"N\":\"10\"},\"projectId\":{\"S\":\"shared-launch\"},\"projectSortOrder\":{\"N\":\"30\"},\"nameJa\":{\"S\":\"共通ローンチ\"},\"nameEn\":{\"S\":\"Shared Launch\"},\"tone\":{\"S\":\"green\"}}}},
      {\"PutRequest\":{\"Item\":{\"directoryId\":{\"S\":\"$PROJECT_DIRECTORY_ID\"},\"entryKey\":{\"S\":\"000020#000000#TEAM#design-team\"},\"entryType\":{\"S\":\"team\"},\"teamId\":{\"S\":\"design-team\"},\"teamSortOrder\":{\"N\":\"20\"},\"nameJa\":{\"S\":\"デザインチーム\"},\"nameEn\":{\"S\":\"Design Team\"},\"expanded\":{\"BOOL\":true}}}},
      {\"PutRequest\":{\"Item\":{\"directoryId\":{\"S\":\"$PROJECT_DIRECTORY_ID\"},\"entryKey\":{\"S\":\"000020#000010#PROJECT#shared-launch\"},\"entryType\":{\"S\":\"project\"},\"teamId\":{\"S\":\"design-team\"},\"teamSortOrder\":{\"N\":\"20\"},\"projectId\":{\"S\":\"shared-launch\"},\"projectSortOrder\":{\"N\":\"10\"},\"nameJa\":{\"S\":\"共通ローンチ\"},\"nameEn\":{\"S\":\"Shared Launch\"},\"tone\":{\"S\":\"purple\"}}}},
      {\"PutRequest\":{\"Item\":{\"directoryId\":{\"S\":\"$PROJECT_DIRECTORY_ID\"},\"entryKey\":{\"S\":\"000020#000020#PROJECT#brand-refresh\"},\"entryType\":{\"S\":\"project\"},\"teamId\":{\"S\":\"design-team\"},\"teamSortOrder\":{\"N\":\"20\"},\"projectId\":{\"S\":\"brand-refresh\"},\"projectSortOrder\":{\"N\":\"20\"},\"nameJa\":{\"S\":\"ブランド刷新\"},\"nameEn\":{\"S\":\"Brand Refresh\"},\"tone\":{\"S\":\"yellow\"}}}},
      {\"PutRequest\":{\"Item\":{\"directoryId\":{\"S\":\"$PROJECT_DIRECTORY_ID\"},\"entryKey\":{\"S\":\"PROJECT_MEMBER#refero#sato@example.com\"},\"entryType\":{\"S\":\"project-member\"},\"projectId\":{\"S\":\"refero\"},\"memberKey\":{\"S\":\"sato@example.com\"},\"email\":{\"S\":\"sato@example.com\"},\"name\":{\"S\":\"佐藤 花子\"},\"role\":{\"S\":\"member\"},\"createdAt\":{\"S\":\"2026-06-08T00:00:00.000Z\"},\"updatedAt\":{\"S\":\"2026-06-08T00:00:00.000Z\"}}}},
      {\"PutRequest\":{\"Item\":{\"directoryId\":{\"S\":\"$PROJECT_DIRECTORY_ID\"},\"entryKey\":{\"S\":\"PROJECT_MEMBER#refero#viewer@example.com\"},\"entryType\":{\"S\":\"project-member\"},\"projectId\":{\"S\":\"refero\"},\"memberKey\":{\"S\":\"viewer@example.com\"},\"email\":{\"S\":\"viewer@example.com\"},\"name\":{\"S\":\"Viewer User\"},\"role\":{\"S\":\"viewer\"},\"createdAt\":{\"S\":\"2026-06-08T00:00:00.000Z\"},\"updatedAt\":{\"S\":\"2026-06-08T00:00:00.000Z\"}}}}
    ]
  }" \
  --query 'length(UnprocessedItems)' \
  --output text)"

if [ "$DIRECTORY_UNPROCESSED_TABLES" != "0" ]; then
  echo "DynamoDB directory seed left unprocessed items: table=$PROJECT_DIRECTORY_TABLE directory=$PROJECT_DIRECTORY_ID" >&2
  exit 1
fi

WORKSPACE_UNPROCESSED_TABLES="$(aws_local dynamodb batch-write-item \
  --request-items "{
    \"$PROJECT_DIRECTORY_TABLE\": [
      {\"PutRequest\":{\"Item\":{\"directoryId\":{\"S\":\"$WORKSPACE_DIRECTORY_ID\"},\"entryKey\":{\"S\":\"WORKSPACE#METADATA\"},\"entryType\":{\"S\":\"workspace-metadata\"},\"workspaceId\":{\"S\":\"$WORKSPACE_DIRECTORY_ID\"}}}},
      {\"PutRequest\":{\"Item\":{\"directoryId\":{\"S\":\"$WORKSPACE_DIRECTORY_ID\"},\"entryKey\":{\"S\":\"WORKSPACE_MEMBER#$PROJECT_MEMBER_KEY\"},\"entryType\":{\"S\":\"workspace-member\"},\"workspaceId\":{\"S\":\"$WORKSPACE_DIRECTORY_ID\"},\"memberKey\":{\"S\":\"$PROJECT_MEMBER_KEY\"},\"email\":{\"S\":\"$PROJECT_MEMBER_KEY\"},\"username\":{\"S\":\"$INITIAL_OWNER_USERNAME\"},\"role\":{\"S\":\"owner\"},\"createdAt\":{\"S\":\"2026-07-11T00:00:00.000Z\"},\"updatedAt\":{\"S\":\"2026-07-11T00:00:00.000Z\"}}}},
      {\"PutRequest\":{\"Item\":{\"directoryId\":{\"S\":\"$WORKSPACE_DIRECTORY_ID\"},\"entryKey\":{\"S\":\"EMAIL_ALIAS#$PROJECT_MEMBER_KEY\"},\"entryType\":{\"S\":\"email-alias\"},\"workspaceId\":{\"S\":\"$WORKSPACE_DIRECTORY_ID\"},\"memberKey\":{\"S\":\"$PROJECT_MEMBER_KEY\"},\"email\":{\"S\":\"$PROJECT_MEMBER_KEY\"},\"username\":{\"S\":\"$INITIAL_OWNER_USERNAME\"}}}},
      {\"PutRequest\":{\"Item\":{\"directoryId\":{\"S\":\"$PROJECT_DIRECTORY_ID\"},\"entryKey\":{\"S\":\"PROJECT_MEMBER#refero#$PROJECT_MEMBER_KEY\"},\"entryType\":{\"S\":\"project-member\"},\"projectId\":{\"S\":\"refero\"},\"memberKey\":{\"S\":\"$PROJECT_MEMBER_KEY\"},\"email\":{\"S\":\"$PROJECT_MEMBER_KEY\"},\"name\":{\"S\":\"Initial Owner\"},\"role\":{\"S\":\"manager\"},\"createdAt\":{\"S\":\"2026-07-11T00:00:00.000Z\"},\"updatedAt\":{\"S\":\"2026-07-11T00:00:00.000Z\"}}}},
      {\"PutRequest\":{\"Item\":{\"directoryId\":{\"S\":\"$PROJECT_DIRECTORY_ID\"},\"entryKey\":{\"S\":\"PROJECT_MEMBER#product-roadmap#$PROJECT_MEMBER_KEY\"},\"entryType\":{\"S\":\"project-member\"},\"projectId\":{\"S\":\"product-roadmap\"},\"memberKey\":{\"S\":\"$PROJECT_MEMBER_KEY\"},\"email\":{\"S\":\"$PROJECT_MEMBER_KEY\"},\"name\":{\"S\":\"Initial Owner\"},\"role\":{\"S\":\"manager\"},\"createdAt\":{\"S\":\"2026-07-11T00:00:00.000Z\"},\"updatedAt\":{\"S\":\"2026-07-11T00:00:00.000Z\"}}}},
      {\"PutRequest\":{\"Item\":{\"directoryId\":{\"S\":\"$PROJECT_DIRECTORY_ID\"},\"entryKey\":{\"S\":\"PROJECT_MEMBER#shared-launch#$PROJECT_MEMBER_KEY\"},\"entryType\":{\"S\":\"project-member\"},\"projectId\":{\"S\":\"shared-launch\"},\"memberKey\":{\"S\":\"$PROJECT_MEMBER_KEY\"},\"email\":{\"S\":\"$PROJECT_MEMBER_KEY\"},\"name\":{\"S\":\"Initial Owner\"},\"role\":{\"S\":\"manager\"},\"createdAt\":{\"S\":\"2026-07-11T00:00:00.000Z\"},\"updatedAt\":{\"S\":\"2026-07-11T00:00:00.000Z\"}}}},
      {\"PutRequest\":{\"Item\":{\"directoryId\":{\"S\":\"$PROJECT_DIRECTORY_ID\"},\"entryKey\":{\"S\":\"PROJECT_MEMBER#brand-refresh#$PROJECT_MEMBER_KEY\"},\"entryType\":{\"S\":\"project-member\"},\"projectId\":{\"S\":\"brand-refresh\"},\"memberKey\":{\"S\":\"$PROJECT_MEMBER_KEY\"},\"email\":{\"S\":\"$PROJECT_MEMBER_KEY\"},\"name\":{\"S\":\"Initial Owner\"},\"role\":{\"S\":\"manager\"},\"createdAt\":{\"S\":\"2026-07-11T00:00:00.000Z\"},\"updatedAt\":{\"S\":\"2026-07-11T00:00:00.000Z\"}}}}
    ]
  }" \
  --query 'length(UnprocessedItems)' \
  --output text)"

if [ "$WORKSPACE_UNPROCESSED_TABLES" != "0" ]; then
  echo "DynamoDB workspace bootstrap left unprocessed items: table=$PROJECT_DIRECTORY_TABLE workspaceDirectory=$WORKSPACE_DIRECTORY_ID" >&2
  exit 1
fi

if ! aws_local dynamodb describe-table --table-name "$WORKSPACE_ACCESS_TABLE" >/dev/null 2>&1; then
  aws_local dynamodb create-table \
    --table-name "$WORKSPACE_ACCESS_TABLE" \
    --attribute-definitions \
      AttributeName=workspaceId,AttributeType=S \
      AttributeName=recordKey,AttributeType=S \
    --key-schema \
      AttributeName=workspaceId,KeyType=HASH \
      AttributeName=recordKey,KeyType=RANGE \
    --billing-mode PAY_PER_REQUEST \
    >/dev/null
fi

if ! aws_local dynamodb describe-table --table-name "$WORKSPACE_SEARCH_TABLE" >/dev/null 2>&1; then
  aws_local dynamodb create-table \
    --table-name "$WORKSPACE_SEARCH_TABLE" \
    --attribute-definitions \
      AttributeName=workspaceId,AttributeType=S \
      AttributeName=recordKey,AttributeType=S \
    --key-schema \
      AttributeName=workspaceId,KeyType=HASH \
      AttributeName=recordKey,KeyType=RANGE \
    --billing-mode PAY_PER_REQUEST \
    >/dev/null
fi

aws_local dynamodb wait table-exists --table-name "$WORKSPACE_SEARCH_TABLE"

WORKSPACE_SEED_CREATED_AT="2026-07-11T00:00:00.000Z"

ensure_workspace_record() {
  record_key="$1"
  item="$2"
  existing_record_key="$(aws_local dynamodb get-item \
    --table-name "$WORKSPACE_ACCESS_TABLE" \
    --key "{\"workspaceId\":{\"S\":\"$WORKSPACE_DIRECTORY_ID\"},\"recordKey\":{\"S\":\"$record_key\"}}" \
    --consistent-read \
    --query 'Item.recordKey.S' \
    --output text)"

  if [ "$existing_record_key" = "None" ] || [ -z "$existing_record_key" ]; then
    put_item_error=""
    if ! put_item_error="$(aws_local dynamodb put-item \
      --table-name "$WORKSPACE_ACCESS_TABLE" \
      --item "$item" \
      --condition-expression 'attribute_not_exists(workspaceId) AND attribute_not_exists(recordKey)' \
      2>&1 >/dev/null)"; then
      case "$put_item_error" in
        *ConditionalCheckFailedException*) ;;
        *) printf '%s\n' "$put_item_error" >&2; return 1 ;;
      esac
    fi
  fi
}

seed_workspace_member() {
  email="$1"
  display_name="$2"
  role="$3"
  member_key="$(printf '%s' "$email" | tr '[:upper:]' '[:lower:]')"
  record_key="MEMBER#$member_key"

  ensure_workspace_record "$record_key" "{
    \"workspaceId\": {\"S\": \"$WORKSPACE_DIRECTORY_ID\"},
    \"recordKey\": {\"S\": \"$record_key\"},
    \"entryType\": {\"S\": \"workspace-member\"},
    \"id\": {\"S\": \"$member_key\"},
    \"memberKey\": {\"S\": \"$member_key\"},
    \"email\": {\"S\": \"$member_key\"},
    \"name\": {\"S\": \"$display_name\"},
    \"role\": {\"S\": \"$role\"},
    \"status\": {\"S\": \"active\"},
    \"version\": {\"N\": \"1\"},
    \"createdAt\": {\"S\": \"$WORKSPACE_SEED_CREATED_AT\"},
    \"updatedAt\": {\"S\": \"$WORKSPACE_SEED_CREATED_AT\"}
  }"
}

ensure_workspace_record "WORKSPACE" "{
  \"workspaceId\": {\"S\": \"$WORKSPACE_DIRECTORY_ID\"},
  \"recordKey\": {\"S\": \"WORKSPACE\"},
  \"entryType\": {\"S\": \"workspace-meta\"},
  \"activeOwnerCount\": {\"N\": \"1\"},
  \"version\": {\"N\": \"1\"},
  \"createdAt\": {\"S\": \"$WORKSPACE_SEED_CREATED_AT\"},
  \"updatedAt\": {\"S\": \"$WORKSPACE_SEED_CREATED_AT\"}
}"

seed_workspace_member "$PROJECT_MEMBER_KEY" "Initial Owner" "owner"
seed_workspace_member "sato@example.com" "佐藤 花子" "member"
seed_workspace_member "suzuki@example.com" "鈴木 太郎" "member"
seed_workspace_member "tanaka@example.com" "田中 美咲" "member"
seed_workspace_member "yamamoto@example.com" "山本 健" "member"
seed_workspace_member "viewer@example.com" "Viewer User" "guest"

assert_equal() {
  actual="$1"
  expected="$2"
  description="$3"

  if [ "$actual" != "$expected" ]; then
    echo "Bootstrap validation failed: $description expected=$expected actual=$actual" >&2
    exit 1
  fi
}

assert_present() {
  actual="$1"
  description="$2"

  if [ -z "$actual" ] || [ "$actual" = "None" ]; then
    echo "Bootstrap validation failed: $description is missing" >&2
    exit 1
  fi
}

read_owner_attribute() {
  attribute_name="$1"
  aws_local cognito-idp admin-get-user \
    --user-pool-id "$POOL_ID" \
    --username "$INITIAL_OWNER_USERNAME" \
    --query "UserAttributes[?Name=='$attribute_name'].Value | [0]" \
    --output text
}

read_directory_attribute() {
  entry_key="$1"
  attribute_name="$2"
  aws_local dynamodb get-item \
    --table-name "$PROJECT_DIRECTORY_TABLE" \
    --consistent-read \
    --key "{\"directoryId\":{\"S\":\"$WORKSPACE_DIRECTORY_ID\"},\"entryKey\":{\"S\":\"$entry_key\"}}" \
    --query "Item.$attribute_name.S" \
    --output text
}

assert_equal "$(read_owner_attribute 'email' | tr '[:upper:]' '[:lower:]')" "$PROJECT_MEMBER_KEY" "Cognito owner email"
assert_equal "$(read_owner_attribute 'custom:directory_id')" "$WORKSPACE_DIRECTORY_ID" "Cognito custom:directory_id"
assert_equal "$(read_owner_attribute 'custom:workspace_id')" "$WORKSPACE_DIRECTORY_ID" "Cognito custom:workspace_id"
assert_equal "$(read_directory_attribute 'WORKSPACE#METADATA' 'workspaceId')" "$WORKSPACE_DIRECTORY_ID" "workspace metadata"
assert_equal "$(read_directory_attribute "WORKSPACE_MEMBER#$PROJECT_MEMBER_KEY" 'role')" "owner" "workspace owner role"
assert_equal "$(read_directory_attribute "WORKSPACE_MEMBER#$PROJECT_MEMBER_KEY" 'email')" "$PROJECT_MEMBER_KEY" "workspace owner email"
assert_equal "$(read_directory_attribute "WORKSPACE_MEMBER#$PROJECT_MEMBER_KEY" 'username')" "$INITIAL_OWNER_USERNAME" "workspace owner username"
assert_present "$(read_directory_attribute "WORKSPACE_MEMBER#$PROJECT_MEMBER_KEY" 'createdAt')" "workspace owner createdAt"
assert_present "$(read_directory_attribute "WORKSPACE_MEMBER#$PROJECT_MEMBER_KEY" 'updatedAt')" "workspace owner updatedAt"
assert_equal "$(read_directory_attribute "EMAIL_ALIAS#$PROJECT_MEMBER_KEY" 'workspaceId')" "$WORKSPACE_DIRECTORY_ID" "email alias workspace"
assert_equal "$(read_directory_attribute "EMAIL_ALIAS#$PROJECT_MEMBER_KEY" 'email')" "$PROJECT_MEMBER_KEY" "email alias"
assert_equal "$(read_directory_attribute "EMAIL_ALIAS#$PROJECT_MEMBER_KEY" 'username')" "$INITIAL_OWNER_USERNAME" "email alias username"

for project_id in refero product-roadmap shared-launch brand-refresh; do
  project_member_key="PROJECT_MEMBER#$project_id#$PROJECT_MEMBER_KEY"
  assert_equal "$(read_directory_attribute "$project_member_key" 'role')" "manager" "initial owner project role ($project_id)"
  assert_present "$(read_directory_attribute "$project_member_key" 'createdAt')" "initial owner project createdAt ($project_id)"
  assert_present "$(read_directory_attribute "$project_member_key" 'updatedAt')" "initial owner project updatedAt ($project_id)"
done

mkdir -p "$GENERATED_DIR"
cat >"$GENERATED_DIR/cognito.env" <<EOF
COGNITO_ENDPOINT=$PUBLIC_ENDPOINT_URL
COGNITO_ISSUER=$PUBLIC_ENDPOINT_URL/$POOL_ID
COGNITO_USER_POOL_ID=$POOL_ID
COGNITO_USER_POOL_NAME=$POOL_NAME
COGNITO_USER_POOL_CLIENT_NAME=$CLIENT_NAME
COGNITO_CLIENT_ID=$CLIENT_ID
COGNITO_TEST_USERNAME=$INITIAL_OWNER_USERNAME
COGNITO_TEST_PASSWORD=$TEST_PASSWORD
MUKUROJI_INITIAL_OWNER_USERNAME=$INITIAL_OWNER_USERNAME
MUKUROJI_INITIAL_OWNER_EMAIL=$PROJECT_MEMBER_KEY
MUKUROJI_SYSTEM_ADMIN_GROUPS=$SYSTEM_ADMIN_GROUP
MUKUROJI_DASHBOARD_TABLE=$DASHBOARD_TABLE
MUKUROJI_PROJECT_TASKS_TABLE=$PROJECT_TASKS_TABLE
MUKUROJI_PROJECT_DIRECTORY_TABLE=$PROJECT_DIRECTORY_TABLE
MUKUROJI_TEAM_ISSUES_TABLE=$TEAM_ISSUES_TABLE
MUKUROJI_WORK_ITEMS_TABLE=$WORK_ITEMS_TABLE
MUKUROJI_TEAM_ISSUE_EVENTS_TABLE=$TEAM_ISSUE_EVENTS_TABLE
PROJECT_TASKS_TABLE_NAME=$PROJECT_TASKS_TABLE
TEAM_ISSUES_TABLE_NAME=$TEAM_ISSUES_TABLE
WORK_ITEMS_TABLE_NAME=$WORK_ITEMS_TABLE
MUKUROJI_COLLABORATION_TABLE=$COLLABORATION_TABLE
COLLABORATION_TABLE_NAME=$COLLABORATION_TABLE
MUKUROJI_WORKSPACE_SEARCH_TABLE=$WORKSPACE_SEARCH_TABLE
WORKSPACE_SEARCH_TABLE_NAME=$WORKSPACE_SEARCH_TABLE
MUKUROJI_NOTIFICATIONS_TABLE=$NOTIFICATIONS_TABLE
NOTIFICATIONS_TABLE_NAME=$NOTIFICATIONS_TABLE
MUKUROJI_REALTIME_SESSIONS_TABLE=$REALTIME_SESSIONS_TABLE
REALTIME_SESSIONS_TABLE_NAME=$REALTIME_SESSIONS_TABLE
MUKUROJI_WORKSPACE_DIRECTORY_ID=$WORKSPACE_DIRECTORY_ID
MUKUROJI_PROJECT_DIRECTORY_ID=$WORKSPACE_DIRECTORY_ID
MUKUROJI_AUDIT_EVENTS_TABLE=$AUDIT_EVENTS_TABLE
MUKUROJI_AUDIT_RETENTION_DAYS=$AUDIT_RETENTION_DAYS
MUKUROJI_WORKSPACE_ACCESS_TABLE=$WORKSPACE_ACCESS_TABLE
DYNAMODB_ENDPOINT=$PUBLIC_ENDPOINT_URL
EOF

echo "mukuroji Cognito ready: userPoolId=$POOL_ID clientId=$CLIENT_ID username=$INITIAL_OWNER_USERNAME adminGroup=$SYSTEM_ADMIN_GROUP"
echo "mukuroji DynamoDB ready: table=$DASHBOARD_TABLE item=summary"
echo "mukuroji DynamoDB ready: table=$PROJECT_TASKS_TABLE legacyTasks=read-only"
echo "mukuroji DynamoDB ready: table=$WORK_ITEMS_TABLE canonicalSeed=ready"
echo "mukuroji DynamoDB ready: table=$PROJECT_DIRECTORY_TABLE workspaceDirectory=$WORKSPACE_DIRECTORY_ID"
echo "mukuroji audit configured: table=$AUDIT_EVENTS_TABLE retentionDays=$AUDIT_RETENTION_DAYS"
echo "mukuroji DynamoDB ready: table=$WORKSPACE_ACCESS_TABLE workspace=$WORKSPACE_DIRECTORY_ID"
echo "mukuroji DynamoDB ready: table=$WORKSPACE_SEARCH_TABLE searchAndSavedViews=ready"
