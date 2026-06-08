#!/bin/sh
set -eu

ENDPOINT_URL="${AWS_ENDPOINT_URL:-http://localhost:4566}"
PUBLIC_ENDPOINT_URL="${MUKUROJI_PUBLIC_FLOCI_ENDPOINT:-$ENDPOINT_URL}"
POOL_ID="${COGNITO_USER_POOL_ID:-us-east-1_mukuroji}"
POOL_NAME="${COGNITO_USER_POOL_NAME:-mukuroji-local}"
CLIENT_NAME="${COGNITO_USER_POOL_CLIENT_NAME:-mukuroji-web-local}"
TEST_USERNAME="${COGNITO_TEST_USERNAME:-demo@example.com}"
TEST_PASSWORD="${COGNITO_TEST_PASSWORD:-Password123!}"
SYSTEM_ADMIN_GROUP="${MUKUROJI_SYSTEM_ADMIN_GROUP:-mukuroji-system-admins}"
DASHBOARD_TABLE="${MUKUROJI_DASHBOARD_TABLE:-mukuroji-dashboard-local}"
PROJECT_TASKS_TABLE="${MUKUROJI_PROJECT_TASKS_TABLE:-mukuroji-project-tasks-v2-local}"
PROJECT_DIRECTORY_TABLE="${MUKUROJI_PROJECT_DIRECTORY_TABLE:-mukuroji-project-directory-local}"
PROJECT_DIRECTORY_ID="${MUKUROJI_PROJECT_DIRECTORY_ID:-user#$(printf '%s' "$TEST_USERNAME" | tr '[:upper:]' '[:lower:]')}"
PROJECT_MEMBER_KEY="$(printf '%s' "$TEST_USERNAME" | tr '[:upper:]' '[:lower:]')"
DASHBOARD_UPDATED_AT="${MUKUROJI_DASHBOARD_UPDATED_AT:-$(date -u +%Y-%m-%dT%H:%M:%S.000Z)}"
GENERATED_DIR="${MUKUROJI_GENERATED_DIR:-/app/generated}"

aws_local() {
  aws --endpoint-url "$ENDPOINT_URL" "$@"
}

if ! aws_local cognito-idp describe-user-pool --user-pool-id "$POOL_ID" >/dev/null 2>&1; then
  aws_local cognito-idp create-user-pool \
    --pool-name "$POOL_NAME" \
    --user-pool-tags "floci:override-id=$POOL_ID" \
    --username-attributes email \
    --policies 'PasswordPolicy={MinimumLength=8,RequireUppercase=true,RequireLowercase=true,RequireNumbers=true,RequireSymbols=true}' \
    >/dev/null
fi

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
  display_name="$2"

  if ! aws_local cognito-idp admin-get-user \
    --user-pool-id "$POOL_ID" \
    --username "$username" >/dev/null 2>&1; then
    aws_local cognito-idp admin-create-user \
      --user-pool-id "$POOL_ID" \
      --username "$username" \
      --temporary-password "$TEST_PASSWORD" \
      --message-action SUPPRESS \
      --user-attributes Name=email,Value="$username" Name=email_verified,Value=true Name=name,Value="$display_name" \
      >/dev/null
  else
    aws_local cognito-idp admin-update-user-attributes \
      --user-pool-id "$POOL_ID" \
      --username "$username" \
      --user-attributes Name=email,Value="$username" Name=email_verified,Value=true Name=name,Value="$display_name" \
      >/dev/null
  fi

  aws_local cognito-idp admin-set-user-password \
    --user-pool-id "$POOL_ID" \
    --username "$username" \
    --password "$TEST_PASSWORD" \
    --permanent \
    >/dev/null
}

ensure_cognito_user "$TEST_USERNAME" "Demo User"
ensure_cognito_user "sato@example.com" "佐藤 花子"
ensure_cognito_user "suzuki@example.com" "鈴木 大輔"
ensure_cognito_user "tanaka@example.com" "田中 美咲"
ensure_cognito_user "yamamoto@example.com" "山本 健太"
ensure_cognito_user "viewer@example.com" "Viewer User"

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
  --username "$TEST_USERNAME" \
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

TASKS_UNPROCESSED_TABLES="$(aws_local dynamodb batch-write-item \
  --request-items "{
    \"$PROJECT_TASKS_TABLE\": [
      {\"PutRequest\":{\"Item\":{\"directoryId\":{\"S\":\"$PROJECT_DIRECTORY_ID\"},\"directoryProjectId\":{\"S\":\"$PROJECT_DIRECTORY_ID#project#refero\"},\"projectId\":{\"S\":\"refero\"},\"taskId\":{\"S\":\"wireframe\"},\"sortOrder\":{\"N\":\"10\"},\"titleKey\":{\"S\":\"tasks.item.wireframe\"},\"assigneeUserId\":{\"S\":\"sato@example.com\"},\"status\":{\"S\":\"in-progress\"},\"dueDate\":{\"S\":\"2026/06/03\"},\"priority\":{\"S\":\"high\"}}}},
      {\"PutRequest\":{\"Item\":{\"directoryId\":{\"S\":\"$PROJECT_DIRECTORY_ID\"},\"directoryProjectId\":{\"S\":\"$PROJECT_DIRECTORY_ID#project#refero\"},\"projectId\":{\"S\":\"refero\"},\"taskId\":{\"S\":\"brand-guideline\"},\"sortOrder\":{\"N\":\"20\"},\"titleKey\":{\"S\":\"tasks.item.brandGuideline\"},\"assigneeUserId\":{\"S\":\"suzuki@example.com\"},\"status\":{\"S\":\"review\"},\"dueDate\":{\"S\":\"2026/06/05\"},\"priority\":{\"S\":\"medium\"}}}},
      {\"PutRequest\":{\"Item\":{\"directoryId\":{\"S\":\"$PROJECT_DIRECTORY_ID\"},\"directoryProjectId\":{\"S\":\"$PROJECT_DIRECTORY_ID#project#refero\"},\"projectId\":{\"S\":\"refero\"},\"taskId\":{\"S\":\"pricing-content\"},\"sortOrder\":{\"N\":\"30\"},\"titleKey\":{\"S\":\"tasks.item.pricingContent\"},\"assigneeUserId\":{\"S\":\"tanaka@example.com\"},\"status\":{\"S\":\"in-progress\"},\"dueDate\":{\"S\":\"2026/06/08\"},\"priority\":{\"S\":\"high\"}}}},
      {\"PutRequest\":{\"Item\":{\"directoryId\":{\"S\":\"$PROJECT_DIRECTORY_ID\"},\"directoryProjectId\":{\"S\":\"$PROJECT_DIRECTORY_ID#project#refero\"},\"projectId\":{\"S\":\"refero\"},\"taskId\":{\"S\":\"seo-research\"},\"sortOrder\":{\"N\":\"40\"},\"titleKey\":{\"S\":\"tasks.item.seoResearch\"},\"assigneeUserId\":{\"S\":\"yamamoto@example.com\"},\"status\":{\"S\":\"todo\"},\"dueDate\":{\"S\":\"2026/06/09\"},\"priority\":{\"S\":\"medium\"}}}},
      {\"PutRequest\":{\"Item\":{\"directoryId\":{\"S\":\"$PROJECT_DIRECTORY_ID\"},\"directoryProjectId\":{\"S\":\"$PROJECT_DIRECTORY_ID#project#refero\"},\"projectId\":{\"S\":\"refero\"},\"taskId\":{\"S\":\"hero-design\"},\"sortOrder\":{\"N\":\"50\"},\"titleKey\":{\"S\":\"tasks.item.heroDesign\"},\"assigneeUserId\":{\"S\":\"sato@example.com\"},\"status\":{\"S\":\"review\"},\"dueDate\":{\"S\":\"2026/06/10\"},\"priority\":{\"S\":\"medium\"}}}},
      {\"PutRequest\":{\"Item\":{\"directoryId\":{\"S\":\"$PROJECT_DIRECTORY_ID\"},\"directoryProjectId\":{\"S\":\"$PROJECT_DIRECTORY_ID#project#refero\"},\"projectId\":{\"S\":\"refero\"},\"taskId\":{\"S\":\"analytics-tags\"},\"sortOrder\":{\"N\":\"60\"},\"titleKey\":{\"S\":\"tasks.item.analyticsTags\"},\"assigneeUserId\":{\"S\":\"suzuki@example.com\"},\"status\":{\"S\":\"in-progress\"},\"dueDate\":{\"S\":\"2026/06/11\"},\"priority\":{\"S\":\"low\"}}}},
      {\"PutRequest\":{\"Item\":{\"directoryId\":{\"S\":\"$PROJECT_DIRECTORY_ID\"},\"directoryProjectId\":{\"S\":\"$PROJECT_DIRECTORY_ID#project#refero\"},\"projectId\":{\"S\":\"refero\"},\"taskId\":{\"S\":\"competitor-report\"},\"sortOrder\":{\"N\":\"70\"},\"titleKey\":{\"S\":\"tasks.item.competitorReport\"},\"assigneeUserId\":{\"S\":\"tanaka@example.com\"},\"status\":{\"S\":\"done\"},\"dueDate\":{\"S\":\"2026/06/02\"},\"priority\":{\"S\":\"low\"}}}},
      {\"PutRequest\":{\"Item\":{\"directoryId\":{\"S\":\"$PROJECT_DIRECTORY_ID\"},\"directoryProjectId\":{\"S\":\"$PROJECT_DIRECTORY_ID#project#refero\"},\"projectId\":{\"S\":\"refero\"},\"taskId\":{\"S\":\"terms-page\"},\"sortOrder\":{\"N\":\"80\"},\"titleKey\":{\"S\":\"tasks.item.termsPage\"},\"assigneeUserId\":{\"S\":\"yamamoto@example.com\"},\"status\":{\"S\":\"todo\"},\"dueDate\":{\"S\":\"2026/06/12\"},\"priority\":{\"S\":\"medium\"}}}},
      {\"PutRequest\":{\"Item\":{\"directoryId\":{\"S\":\"$PROJECT_DIRECTORY_ID\"},\"directoryProjectId\":{\"S\":\"$PROJECT_DIRECTORY_ID#project#refero\"},\"projectId\":{\"S\":\"refero\"},\"taskId\":{\"S\":\"faq-content\"},\"sortOrder\":{\"N\":\"90\"},\"titleKey\":{\"S\":\"tasks.item.faqContent\"},\"assigneeUserId\":{\"S\":\"sato@example.com\"},\"status\":{\"S\":\"todo\"},\"dueDate\":{\"S\":\"2026/06/15\"},\"priority\":{\"S\":\"low\"}}}},
      {\"PutRequest\":{\"Item\":{\"directoryId\":{\"S\":\"$PROJECT_DIRECTORY_ID\"},\"directoryProjectId\":{\"S\":\"$PROJECT_DIRECTORY_ID#project#refero\"},\"projectId\":{\"S\":\"refero\"},\"taskId\":{\"S\":\"landing-release\"},\"sortOrder\":{\"N\":\"100\"},\"titleKey\":{\"S\":\"tasks.item.landingRelease\"},\"assigneeUserId\":{\"S\":\"suzuki@example.com\"},\"status\":{\"S\":\"todo\"},\"dueDate\":{\"S\":\"2026/06/16\"},\"priority\":{\"S\":\"high\"}}}}
    ]
  }" \
  --query 'length(UnprocessedItems)' \
  --output text)"

if [ "$TASKS_UNPROCESSED_TABLES" != "0" ]; then
  echo "DynamoDB task seed left unprocessed items: table=$PROJECT_TASKS_TABLE" >&2
  exit 1
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
      {\"PutRequest\":{\"Item\":{\"directoryId\":{\"S\":\"$PROJECT_DIRECTORY_ID\"},\"entryKey\":{\"S\":\"PROJECT_MEMBER#refero#$PROJECT_MEMBER_KEY\"},\"entryType\":{\"S\":\"project-member\"},\"projectId\":{\"S\":\"refero\"},\"memberKey\":{\"S\":\"$PROJECT_MEMBER_KEY\"},\"email\":{\"S\":\"$PROJECT_MEMBER_KEY\"},\"name\":{\"S\":\"Demo User\"},\"role\":{\"S\":\"manager\"},\"createdAt\":{\"S\":\"2026-06-08T00:00:00.000Z\"},\"updatedAt\":{\"S\":\"2026-06-08T00:00:00.000Z\"}}}},
      {\"PutRequest\":{\"Item\":{\"directoryId\":{\"S\":\"$PROJECT_DIRECTORY_ID\"},\"entryKey\":{\"S\":\"PROJECT_MEMBER#refero#sato@example.com\"},\"entryType\":{\"S\":\"project-member\"},\"projectId\":{\"S\":\"refero\"},\"memberKey\":{\"S\":\"sato@example.com\"},\"email\":{\"S\":\"sato@example.com\"},\"name\":{\"S\":\"佐藤 花子\"},\"role\":{\"S\":\"member\"},\"createdAt\":{\"S\":\"2026-06-08T00:00:00.000Z\"},\"updatedAt\":{\"S\":\"2026-06-08T00:00:00.000Z\"}}}},
      {\"PutRequest\":{\"Item\":{\"directoryId\":{\"S\":\"$PROJECT_DIRECTORY_ID\"},\"entryKey\":{\"S\":\"PROJECT_MEMBER#refero#viewer@example.com\"},\"entryType\":{\"S\":\"project-member\"},\"projectId\":{\"S\":\"refero\"},\"memberKey\":{\"S\":\"viewer@example.com\"},\"email\":{\"S\":\"viewer@example.com\"},\"name\":{\"S\":\"Viewer User\"},\"role\":{\"S\":\"viewer\"},\"createdAt\":{\"S\":\"2026-06-08T00:00:00.000Z\"},\"updatedAt\":{\"S\":\"2026-06-08T00:00:00.000Z\"}}}},
      {\"PutRequest\":{\"Item\":{\"directoryId\":{\"S\":\"$PROJECT_DIRECTORY_ID\"},\"entryKey\":{\"S\":\"PROJECT_MEMBER#product-roadmap#$PROJECT_MEMBER_KEY\"},\"entryType\":{\"S\":\"project-member\"},\"projectId\":{\"S\":\"product-roadmap\"},\"memberKey\":{\"S\":\"$PROJECT_MEMBER_KEY\"},\"email\":{\"S\":\"$PROJECT_MEMBER_KEY\"},\"name\":{\"S\":\"Demo User\"},\"role\":{\"S\":\"manager\"},\"createdAt\":{\"S\":\"2026-06-08T00:00:00.000Z\"},\"updatedAt\":{\"S\":\"2026-06-08T00:00:00.000Z\"}}}},
      {\"PutRequest\":{\"Item\":{\"directoryId\":{\"S\":\"$PROJECT_DIRECTORY_ID\"},\"entryKey\":{\"S\":\"PROJECT_MEMBER#shared-launch#$PROJECT_MEMBER_KEY\"},\"entryType\":{\"S\":\"project-member\"},\"projectId\":{\"S\":\"shared-launch\"},\"memberKey\":{\"S\":\"$PROJECT_MEMBER_KEY\"},\"email\":{\"S\":\"$PROJECT_MEMBER_KEY\"},\"name\":{\"S\":\"Demo User\"},\"role\":{\"S\":\"manager\"},\"createdAt\":{\"S\":\"2026-06-08T00:00:00.000Z\"},\"updatedAt\":{\"S\":\"2026-06-08T00:00:00.000Z\"}}}},
      {\"PutRequest\":{\"Item\":{\"directoryId\":{\"S\":\"$PROJECT_DIRECTORY_ID\"},\"entryKey\":{\"S\":\"PROJECT_MEMBER#brand-refresh#$PROJECT_MEMBER_KEY\"},\"entryType\":{\"S\":\"project-member\"},\"projectId\":{\"S\":\"brand-refresh\"},\"memberKey\":{\"S\":\"$PROJECT_MEMBER_KEY\"},\"email\":{\"S\":\"$PROJECT_MEMBER_KEY\"},\"name\":{\"S\":\"Demo User\"},\"role\":{\"S\":\"manager\"},\"createdAt\":{\"S\":\"2026-06-08T00:00:00.000Z\"},\"updatedAt\":{\"S\":\"2026-06-08T00:00:00.000Z\"}}}}
    ]
  }" \
  --query 'length(UnprocessedItems)' \
  --output text)"

if [ "$DIRECTORY_UNPROCESSED_TABLES" != "0" ]; then
  echo "DynamoDB directory seed left unprocessed items: table=$PROJECT_DIRECTORY_TABLE directory=$PROJECT_DIRECTORY_ID" >&2
  exit 1
fi

mkdir -p "$GENERATED_DIR"
cat >"$GENERATED_DIR/cognito.env" <<EOF
COGNITO_ENDPOINT=$PUBLIC_ENDPOINT_URL
COGNITO_USER_POOL_ID=$POOL_ID
COGNITO_USER_POOL_NAME=$POOL_NAME
COGNITO_USER_POOL_CLIENT_NAME=$CLIENT_NAME
COGNITO_CLIENT_ID=$CLIENT_ID
COGNITO_TEST_USERNAME=$TEST_USERNAME
COGNITO_TEST_PASSWORD=$TEST_PASSWORD
MUKUROJI_SYSTEM_ADMIN_GROUPS=$SYSTEM_ADMIN_GROUP
MUKUROJI_DASHBOARD_TABLE=$DASHBOARD_TABLE
MUKUROJI_PROJECT_TASKS_TABLE=$PROJECT_TASKS_TABLE
MUKUROJI_PROJECT_DIRECTORY_TABLE=$PROJECT_DIRECTORY_TABLE
DYNAMODB_ENDPOINT=$PUBLIC_ENDPOINT_URL
EOF

echo "mukuroji Cognito ready: userPoolId=$POOL_ID clientId=$CLIENT_ID username=$TEST_USERNAME adminGroup=$SYSTEM_ADMIN_GROUP"
echo "mukuroji DynamoDB ready: table=$DASHBOARD_TABLE item=summary"
echo "mukuroji DynamoDB ready: table=$PROJECT_TASKS_TABLE project=refero tasks=10"
echo "mukuroji DynamoDB ready: table=$PROJECT_DIRECTORY_TABLE directory=$PROJECT_DIRECTORY_ID"
