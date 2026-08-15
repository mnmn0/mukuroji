#!/bin/sh
set -eu

ENDPOINT_URL="${AWS_ENDPOINT_URL:-http://localhost:4566}"
PUBLIC_ENDPOINT_URL="${MUKUROJI_PUBLIC_FLOCI_ENDPOINT:-$ENDPOINT_URL}"
PUBLIC_ENDPOINT_URL="${PUBLIC_ENDPOINT_URL%/}"
POOL_ID="${COGNITO_USER_POOL_ID:-us-east-1_mukuroji}"
POOL_NAME="${COGNITO_USER_POOL_NAME:-mukuroji-local}"
CLIENT_NAME="${COGNITO_USER_POOL_CLIENT_NAME:-mukuroji-web-local}"
SSO_CLIENT_NAME="${COGNITO_SSO_USER_POOL_CLIENT_NAME:-mukuroji-sso-local}"
SSO_REDIRECT_URI="${COGNITO_SSO_REDIRECT_URI:-http://localhost:5173/auth/sso/callback}"
ENTERPRISE_IDP_NAME="${COGNITO_ENTERPRISE_IDP_NAME:-}"
TEST_USERNAME="${COGNITO_TEST_USERNAME:-demo@example.com}"
TEST_PASSWORD="${COGNITO_TEST_PASSWORD:-Password123!}"
INITIAL_OWNER_USERNAME="${MUKUROJI_INITIAL_OWNER_USERNAME:-$TEST_USERNAME}"
INITIAL_OWNER_EMAIL="${MUKUROJI_INITIAL_OWNER_EMAIL:-$TEST_USERNAME}"
SYSTEM_ADMIN_GROUP="${MUKUROJI_SYSTEM_ADMIN_GROUP:-mukuroji-system-admins}"
DASHBOARD_TABLE="${MUKUROJI_DASHBOARD_TABLE:-mukuroji-dashboard-local}"
PROJECT_DIRECTORY_TABLE="${MUKUROJI_PROJECT_DIRECTORY_TABLE:-mukuroji-project-directory-local}"
WORK_ITEMS_TABLE="${MUKUROJI_WORK_ITEMS_TABLE:-${WORK_ITEMS_TABLE_NAME:-${MUKUROJI_TEAM_ISSUES_TABLE:-mukuroji-team-issues-local}}}"
TEAM_ISSUES_TABLE="$WORK_ITEMS_TABLE"
TEAM_ISSUE_EVENTS_TABLE="${MUKUROJI_TEAM_ISSUE_EVENTS_TABLE:-mukuroji-team-issue-events-local}"
COLLABORATION_TABLE="${MUKUROJI_COLLABORATION_TABLE:-${COLLABORATION_TABLE_NAME:-mukuroji-collaboration-local}}"
WORKSPACE_SEARCH_TABLE="${MUKUROJI_WORKSPACE_SEARCH_TABLE:-${WORKSPACE_SEARCH_TABLE_NAME:-mukuroji-workspace-search-local}}"
ANALYTICS_TABLE="${ANALYTICS_TABLE_NAME:-mukuroji-analytics-local}"
ANALYTICS_SCHEDULE_INDEX="${ANALYTICS_SCHEDULE_INDEX_NAME:-ScheduleDueIndex}"
NOTIFICATIONS_TABLE="${MUKUROJI_NOTIFICATIONS_TABLE:-${NOTIFICATIONS_TABLE_NAME:-mukuroji-notifications-local}}"
REALTIME_SESSIONS_TABLE="${MUKUROJI_REALTIME_SESSIONS_TABLE:-${REALTIME_SESSIONS_TABLE_NAME:-mukuroji-realtime-sessions-local}}"
AUDIT_EVENTS_TABLE="${MUKUROJI_AUDIT_EVENTS_TABLE:-${AUDIT_EVENTS_TABLE_NAME:-mukuroji-audit-events}}"
AUDIT_RETENTION_DAYS="${MUKUROJI_AUDIT_RETENTION_DAYS:-${AUDIT_RETENTION_DAYS:-2555}}"
TENANT_ADMINISTRATION_TABLE="${TENANT_ADMINISTRATION_TABLE_NAME:-mukuroji-tenant-administration-local}"
WORKSPACE_AUDIT_PSEUDONYM_KEY="${MUKUROJI_WORKSPACE_AUDIT_PSEUDONYM_KEY:-}"
WORKSPACE_ACCESS_TABLE="${MUKUROJI_WORKSPACE_ACCESS_TABLE:-mukuroji-workspace-access-local}"
ENTERPRISE_IDENTITY_TABLE="${ENTERPRISE_IDENTITY_TABLE_NAME:-mukuroji-enterprise-identity-local}"
WORKSPACE_DIRECTORY_ID="${MUKUROJI_WORKSPACE_DIRECTORY_ID:-${MUKUROJI_PROJECT_DIRECTORY_ID:-workspace#mukuroji-local}}"
PROJECT_DIRECTORY_ID="$WORKSPACE_DIRECTORY_ID"
PROJECT_MEMBER_KEY="$(printf '%s' "$INITIAL_OWNER_EMAIL" | tr '[:upper:]' '[:lower:]')"
DASHBOARD_UPDATED_AT="${MUKUROJI_DASHBOARD_UPDATED_AT:-$(date -u +%Y-%m-%dT%H:%M:%S.000Z)}"
GENERATED_DIR="${MUKUROJI_GENERATED_DIR:-/app/generated}"
COGNITO_ENV_FILE="$GENERATED_DIR/cognito.env"

# 旧 ready hook が生成した file には secret が含まれるため、bootstrap が途中で
# 失敗しても残存しないよう、非secret版を生成する前に legacy file だけ除去します。
if [ -f "$COGNITO_ENV_FILE" ]; then
  if grep -Eq '^(COGNITO_TEST_PASSWORD|ENTERPRISE_IDENTITY_TOKEN_HASH_SECRET|ENTERPRISE_SSO_STATE_SECRET|MUKUROJI_WORKSPACE_AUDIT_PSEUDONYM_KEY)=' "$COGNITO_ENV_FILE"; then
    rm -f "$COGNITO_ENV_FILE"
  else
    legacy_env_inspection_status=$?
    if [ "$legacy_env_inspection_status" -gt 1 ]; then
      rm -f "$COGNITO_ENV_FILE"
    fi
  fi
fi

if [ -z "$WORKSPACE_AUDIT_PSEUDONYM_KEY" ]; then
  echo 'MUKUROJI_WORKSPACE_AUDIT_PSEUDONYM_KEY is required. Set it to the output of "openssl rand -hex 32".' >&2
  exit 2
fi

case "$WORKSPACE_AUDIT_PSEUDONYM_KEY" in
  *[!0-9a-f]*)
    echo 'MUKUROJI_WORKSPACE_AUDIT_PSEUDONYM_KEY must be exactly 64 lowercase hexadecimal characters.' >&2
    exit 2
    ;;
esac

if [ "${#WORKSPACE_AUDIT_PSEUDONYM_KEY}" -ne 64 ]; then
  echo 'MUKUROJI_WORKSPACE_AUDIT_PSEUDONYM_KEY must be exactly 64 lowercase hexadecimal characters.' >&2
  exit 2
fi

case "$CLIENT_NAME" in
  '' | *[!A-Za-z0-9._-]*)
    echo "COGNITO_USER_POOL_CLIENT_NAME contains unsupported characters." >&2
    exit 2
    ;;
esac

case "$SSO_CLIENT_NAME" in
  '' | *[!A-Za-z0-9._-]*)
    echo "COGNITO_SSO_USER_POOL_CLIENT_NAME contains unsupported characters." >&2
    exit 2
    ;;
esac

case "$SSO_REDIRECT_URI" in
  '' | *[!A-Za-z0-9:/._-]*)
    echo "COGNITO_SSO_REDIRECT_URI contains unsupported characters for the generated local environment." >&2
    exit 2
    ;;
esac

case "$ENTERPRISE_IDP_NAME" in
  COGNITO)
    echo "COGNITO_ENTERPRISE_IDP_NAME must identify an external provider, not COGNITO." >&2
    exit 2
    ;;
  *[!A-Za-z0-9._-]*)
    echo "COGNITO_ENTERPRISE_IDP_NAME contains unsupported characters." >&2
    exit 2
    ;;
esac

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

# AWS CLI v1 follows http(s) string parameters by default. Use an ephemeral
# config so Cognito callback URLs are sent as values instead of being fetched.
AWS_CONFIG_FILE="${TMPDIR:-/tmp}/mukuroji-floci-aws-config"
export AWS_CONFIG_FILE
aws configure set cli_follow_urlparam false

aws_local() {
  aws --endpoint-url "$ENDPOINT_URL" "$@"
}

text_list_is_exact() {
  values_text="$1"
  shift
  actual_count=0

  if [ -n "$values_text" ] && [ "$values_text" != "None" ]; then
    for value in $values_text; do
      found_expected=false
      actual_count=$((actual_count + 1))
      for expected in "$@"; do
        if [ "$value" = "$expected" ]; then
          found_expected=true
          break
        fi
      done
      if [ "$found_expected" != "true" ]; then
        return 1
      fi
    done
  fi

  for expected in "$@"; do
    found_actual=false
    for value in $values_text; do
      if [ "$value" = "$expected" ]; then
        found_actual=true
        break
      fi
    done
    if [ "$found_actual" != "true" ]; then
      return 1
    fi
  done

  [ "$actual_count" -eq "$#" ]
}

text_list_is_absent_or_exact() {
  values_text="$1"
  shift

  if [ -z "$values_text" ] || [ "$values_text" = "None" ]; then
    return 0
  fi

  text_list_is_exact "$values_text" "$@"
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

if [ -n "$ENTERPRISE_IDP_NAME" ]; then
  if ! aws_local cognito-idp describe-identity-provider \
    --user-pool-id "$POOL_ID" \
    --provider-name "$ENTERPRISE_IDP_NAME" \
    >/dev/null; then
    echo "COGNITO_ENTERPRISE_IDP_NAME does not identify a Cognito provider: $ENTERPRISE_IDP_NAME" >&2
    exit 1
  fi
  SSO_SUPPORTED_PROVIDER="$ENTERPRISE_IDP_NAME"
else
  # Floci does not emulate external federation. Keep a separate OAuth client even
  # without an IdP so password auth can never be exchanged for SSO assurance.
  SSO_SUPPORTED_PROVIDER="COGNITO"
fi

SSO_CLIENT_ID="$(aws_local cognito-idp list-user-pool-clients \
  --user-pool-id "$POOL_ID" \
  --max-results 60 \
  --query "UserPoolClients[?ClientName=='$SSO_CLIENT_NAME'].ClientId | [0]" \
  --output text)"

if [ "$SSO_CLIENT_ID" = "None" ] || [ -z "$SSO_CLIENT_ID" ]; then
  SSO_CLIENT_ID="$(aws_local cognito-idp create-user-pool-client \
    --user-pool-id "$POOL_ID" \
    --client-name "$SSO_CLIENT_NAME" \
    --no-generate-secret \
    --explicit-auth-flows ALLOW_REFRESH_TOKEN_AUTH \
    --supported-identity-providers "$SSO_SUPPORTED_PROVIDER" \
    --allowed-o-auth-flows code \
    --allowed-o-auth-scopes openid email profile \
    --allowed-o-auth-flows-user-pool-client \
    --callback-urls "$SSO_REDIRECT_URI" \
    --query UserPoolClient.ClientId \
    --output text)"
fi

if [ "$SSO_CLIENT_ID" = "$CLIENT_ID" ]; then
  echo "Cognito password and SSO app clients must be distinct." >&2
  exit 1
fi

SSO_CLIENT_SECRET="$(aws_local cognito-idp describe-user-pool-client \
  --user-pool-id "$POOL_ID" \
  --client-id "$SSO_CLIENT_ID" \
  --query UserPoolClient.ClientSecret \
  --output text)"
if [ -n "$SSO_CLIENT_SECRET" ] && [ "$SSO_CLIENT_SECRET" != "None" ]; then
  echo "Cognito SSO app client must not have a client secret." >&2
  exit 1
fi

# Reconcile mutable settings on every ready run so a persisted local client
# cannot drift back to native Cognito password/SRP/custom authentication.
if ! sso_client_update_error="$(aws_local cognito-idp update-user-pool-client \
  --user-pool-id "$POOL_ID" \
  --client-id "$SSO_CLIENT_ID" \
  --client-name "$SSO_CLIENT_NAME" \
  --explicit-auth-flows ALLOW_REFRESH_TOKEN_AUTH \
  --supported-identity-providers "$SSO_SUPPORTED_PROVIDER" \
  --allowed-o-auth-flows code \
  --allowed-o-auth-scopes openid email profile \
  --allowed-o-auth-flows-user-pool-client \
  --callback-urls "$SSO_REDIRECT_URI" \
  2>&1)"; then
  case "$sso_client_update_error" in
    *UnsupportedOperation* | *UnknownOperationException* | *"not supported"*)
      echo "Floci does not expose UpdateUserPoolClient; validating the existing SSO client contract." >&2
      ;;
    *)
      echo "$sso_client_update_error" >&2
      exit 1
      ;;
  esac
fi

SSO_CLIENT_EXPLICIT_FLOWS="$(aws_local cognito-idp describe-user-pool-client \
  --user-pool-id "$POOL_ID" \
  --client-id "$SSO_CLIENT_ID" \
  --query UserPoolClient.ExplicitAuthFlows \
  --output text)"
SSO_CLIENT_PROVIDERS="$(aws_local cognito-idp describe-user-pool-client \
  --user-pool-id "$POOL_ID" \
  --client-id "$SSO_CLIENT_ID" \
  --query UserPoolClient.SupportedIdentityProviders \
  --output text)"
SSO_CLIENT_OAUTH_ENABLED="$(aws_local cognito-idp describe-user-pool-client \
  --user-pool-id "$POOL_ID" \
  --client-id "$SSO_CLIENT_ID" \
  --query UserPoolClient.AllowedOAuthFlowsUserPoolClient \
  --output text)"
SSO_CLIENT_OAUTH_FLOWS="$(aws_local cognito-idp describe-user-pool-client \
  --user-pool-id "$POOL_ID" \
  --client-id "$SSO_CLIENT_ID" \
  --query UserPoolClient.AllowedOAuthFlows \
  --output text)"
SSO_CLIENT_OAUTH_SCOPES="$(aws_local cognito-idp describe-user-pool-client \
  --user-pool-id "$POOL_ID" \
  --client-id "$SSO_CLIENT_ID" \
  --query UserPoolClient.AllowedOAuthScopes \
  --output text)"
SSO_CLIENT_CALLBACKS="$(aws_local cognito-idp describe-user-pool-client \
  --user-pool-id "$POOL_ID" \
  --client-id "$SSO_CLIENT_ID" \
  --query UserPoolClient.CallbackURLs \
  --output text)"

# Floci 1.5.20 omits explicit auth flows, providers, and callback URLs from
# DescribeUserPoolClient. Validate them when exposed and always validate the
# OAuth settings that the emulator persists.
if ! text_list_is_absent_or_exact "$SSO_CLIENT_EXPLICIT_FLOWS" ALLOW_REFRESH_TOKEN_AUTH ||
  ! text_list_is_absent_or_exact "$SSO_CLIENT_PROVIDERS" "$SSO_SUPPORTED_PROVIDER" ||
  [ "$SSO_CLIENT_OAUTH_ENABLED" != "True" ] ||
  ! text_list_is_exact "$SSO_CLIENT_OAUTH_FLOWS" code ||
  ! text_list_is_exact "$SSO_CLIENT_OAUTH_SCOPES" openid email profile ||
  ! text_list_is_absent_or_exact "$SSO_CLIENT_CALLBACKS" "$SSO_REDIRECT_URI"; then
  echo "Cognito SSO app client does not match the isolated code-flow contract." >&2
  exit 1
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

if ! aws_local dynamodb describe-table --table-name "$WORK_ITEMS_TABLE" >/dev/null 2>&1; then
  aws_local dynamodb create-table \
    --table-name "$WORK_ITEMS_TABLE" \
    --attribute-definitions \
      AttributeName=directoryTeamId,AttributeType=S \
      AttributeName=issueId,AttributeType=S \
      AttributeName=directoryProjectId,AttributeType=S \
      AttributeName=sortOrder,AttributeType=N \
      AttributeName=updatedAt,AttributeType=S \
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
      },
      {
        "IndexName": "TeamIssueUpdatedAtIndex",
        "KeySchema": [
          {"AttributeName": "directoryTeamId", "KeyType": "HASH"},
          {"AttributeName": "updatedAt", "KeyType": "RANGE"}
        ],
        "Projection": {"ProjectionType": "ALL"}
      }
    ]' \
    --billing-mode PAY_PER_REQUEST \
    >/dev/null
fi

aws_local dynamodb wait table-exists --table-name "$WORK_ITEMS_TABLE"

TEAM_ISSUE_UPDATED_AT_INDEX_COUNT="$(aws_local dynamodb describe-table \
  --table-name "$WORK_ITEMS_TABLE" \
  --query "length(Table.GlobalSecondaryIndexes[?IndexName=='TeamIssueUpdatedAtIndex'])" \
  --output text)"
if [ "$TEAM_ISSUE_UPDATED_AT_INDEX_COUNT" = "0" ]; then
  aws_local dynamodb update-table \
    --table-name "$WORK_ITEMS_TABLE" \
    --attribute-definitions AttributeName=updatedAt,AttributeType=S \
    --global-secondary-index-updates \
      '[{"Create":{"IndexName":"TeamIssueUpdatedAtIndex","KeySchema":[{"AttributeName":"directoryTeamId","KeyType":"HASH"},{"AttributeName":"updatedAt","KeyType":"RANGE"}],"Projection":{"ProjectionType":"ALL"}}}]' \
    >/dev/null
  aws_local dynamodb wait table-exists --table-name "$WORK_ITEMS_TABLE"
fi

TEAM_ISSUE_UPDATED_AT_INDEX_STATUS=""
TEAM_ISSUE_UPDATED_AT_INDEX_WAIT_ATTEMPT=0
while [ "$TEAM_ISSUE_UPDATED_AT_INDEX_WAIT_ATTEMPT" -lt 60 ]; do
  TEAM_ISSUE_UPDATED_AT_INDEX_STATUS="$(aws_local dynamodb describe-table \
    --table-name "$WORK_ITEMS_TABLE" \
    --query "Table.GlobalSecondaryIndexes[?IndexName=='TeamIssueUpdatedAtIndex'] | [0].IndexStatus" \
    --output text)"
  if [ "$TEAM_ISSUE_UPDATED_AT_INDEX_STATUS" = "ACTIVE" ]; then
    break
  fi

  TEAM_ISSUE_UPDATED_AT_INDEX_WAIT_ATTEMPT=$((TEAM_ISSUE_UPDATED_AT_INDEX_WAIT_ATTEMPT + 1))
  sleep 1
done
if [ "$TEAM_ISSUE_UPDATED_AT_INDEX_STATUS" != "ACTIVE" ]; then
  echo "DynamoDB index TeamIssueUpdatedAtIndex did not become active for table $WORK_ITEMS_TABLE." >&2
  exit 1
fi

WORK_ITEM_SEED_TIMESTAMP="2026-06-01T00:00:00.000Z"

seed_work_item() {
  work_item_id="$1"
  sort_order="$2"
  title="$3"
  assignee_user_id="$4"
  workflow_status_id="$5"
  status_category="$6"
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
      \"schemaVersion\": {\"N\": \"2\"},
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
      \"schedule\": {\"M\": {
        \"mode\": {\"S\": \"due-date\"},
        \"dueDate\": {\"S\": \"$due_date\"},
        \"calendarPolicy\": {\"M\": {
          \"timeZone\": {\"S\": \"UTC\"},
          \"workingWeekdays\": {\"L\": [
            {\"S\": \"monday\"},
            {\"S\": \"tuesday\"},
            {\"S\": \"wednesday\"},
            {\"S\": \"thursday\"},
            {\"S\": \"friday\"}
          ]},
          \"holidays\": {\"L\": []}
        }}
      }},
      \"priority\": {\"S\": \"$priority\"},
      \"createdAt\": {\"S\": \"$WORK_ITEM_SEED_TIMESTAMP\"},
      \"updatedAt\": {\"S\": \"$WORK_ITEM_SEED_TIMESTAMP\"}
    }" \
    --condition-expression 'attribute_not_exists(directoryTeamId) AND attribute_not_exists(issueId)' \
    2>&1 >/dev/null)"; then
    case "$put_item_error" in
      *ConditionalCheckFailedException*) ;;
      *) printf '%s\n' "$put_item_error" >&2; return 1 ;;
    esac
  fi
}

seed_work_item "wireframe" 10 "新しいランディングページのワイヤーフレーム作成" "sato@example.com" "in-progress" "started" "2026-06-03" "high"
seed_work_item "brand-guideline" 20 "ブランドガイドラインの更新" "suzuki@example.com" "review" "started" "2026-06-05" "medium"
seed_work_item "pricing-content" 30 "料金ページのコンテンツ作成" "tanaka@example.com" "in-progress" "started" "2026-06-08" "high"
seed_work_item "seo-research" 40 "SEO キーワードリサーチ" "yamamoto@example.com" "todo" "unstarted" "2026-06-09" "medium"
seed_work_item "hero-design" 50 "ヒーロー画像のデザイン作成" "sato@example.com" "review" "started" "2026-06-10" "medium"
seed_work_item "analytics-tags" 60 "アナリティクスタグの実装" "suzuki@example.com" "in-progress" "started" "2026-06-11" "low"
seed_work_item "competitor-report" 70 "競合サイトの分析レポート作成" "tanaka@example.com" "done" "completed" "2026-06-02" "low"
seed_work_item "terms-page" 80 "利用規約ページの作成" "yamamoto@example.com" "todo" "unstarted" "2026-06-12" "medium"
seed_work_item "faq-content" 90 "FAQ セクションのコンテンツ作成" "sato@example.com" "todo" "unstarted" "2026-06-15" "low"
seed_work_item "landing-release" 100 "ランディングページの公開" "suzuki@example.com" "todo" "unstarted" "2026-06-16" "high"

if ! aws_local dynamodb describe-table --table-name "$PROJECT_DIRECTORY_TABLE" >/dev/null 2>&1; then
  aws_local dynamodb create-table \
    --table-name "$PROJECT_DIRECTORY_TABLE" \
    --attribute-definitions \
      AttributeName=directoryId,AttributeType=S \
      AttributeName=entryKey,AttributeType=S \
      AttributeName=webhookAuthorizationKey,AttributeType=S \
      AttributeName=webhookAuthorizationSortKey,AttributeType=S \
    --key-schema \
      AttributeName=directoryId,KeyType=HASH \
      AttributeName=entryKey,KeyType=RANGE \
    --global-secondary-indexes \
      'IndexName=WebhookAuthorizationIndex,KeySchema=[{AttributeName=webhookAuthorizationKey,KeyType=HASH},{AttributeName=webhookAuthorizationSortKey,KeyType=RANGE}],Projection={ProjectionType=ALL}' \
    --billing-mode PAY_PER_REQUEST \
    >/dev/null
fi

WEBHOOK_AUTHORIZATION_INDEX_COUNT="$(aws_local dynamodb describe-table \
  --table-name "$PROJECT_DIRECTORY_TABLE" \
  --query "length(Table.GlobalSecondaryIndexes[?IndexName=='WebhookAuthorizationIndex'])" \
  --output text)"
if [ "$WEBHOOK_AUTHORIZATION_INDEX_COUNT" = "0" ]; then
  aws_local dynamodb update-table \
    --table-name "$PROJECT_DIRECTORY_TABLE" \
    --attribute-definitions \
      AttributeName=webhookAuthorizationKey,AttributeType=S \
      AttributeName=webhookAuthorizationSortKey,AttributeType=S \
    --global-secondary-index-updates \
      '[{"Create":{"IndexName":"WebhookAuthorizationIndex","KeySchema":[{"AttributeName":"webhookAuthorizationKey","KeyType":"HASH"},{"AttributeName":"webhookAuthorizationSortKey","KeyType":"RANGE"}],"Projection":{"ProjectionType":"ALL"}}}]' \
    >/dev/null
fi
aws_local dynamodb wait table-exists --table-name "$PROJECT_DIRECTORY_TABLE"

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

set_webhook_authorization_projection() {
  entry_key="$1"
  authorization_key="$2"
  authorization_sort_key="$3"
  aws_local dynamodb update-item \
    --table-name "$PROJECT_DIRECTORY_TABLE" \
    --key "{
      \"directoryId\": {\"S\": \"$PROJECT_DIRECTORY_ID\"},
      \"entryKey\": {\"S\": \"$entry_key\"}
    }" \
    --update-expression \
      'SET webhookAuthorizationKey = :authorizationKey, webhookAuthorizationSortKey = :authorizationSortKey' \
    --expression-attribute-values "{
      \":authorizationKey\": {\"S\": \"$authorization_key\"},
      \":authorizationSortKey\": {\"S\": \"$authorization_sort_key\"}
    }" \
    >/dev/null
}

seed_webhook_team_grant() {
  team_id="$1"
  project_id="$2"
  member_key="$3"
  team_source_entry_key="$4"
  project_source_entry_key="$5"
  aws_local dynamodb transact-write-items \
    --transact-items "[
      {
        \"Put\": {
          \"TableName\": \"$PROJECT_DIRECTORY_TABLE\",
          \"Item\": {
            \"directoryId\": {\"S\": \"WEBHOOK_TEAM_GRANT#$PROJECT_DIRECTORY_ID#$member_key\"},
            \"entryKey\": {\"S\": \"TEAM#$team_id#PROJECT#$project_id\"},
            \"entryType\": {\"S\": \"webhook-team-grant\"},
            \"workspaceId\": {\"S\": \"$PROJECT_DIRECTORY_ID\"},
            \"teamId\": {\"S\": \"$team_id\"},
            \"projectId\": {\"S\": \"$project_id\"},
            \"memberKey\": {\"S\": \"$member_key\"},
            \"sourceEntryKey\": {\"S\": \"PROJECT_MEMBER#$project_id#$member_key\"},
            \"teamSourceEntryKey\": {\"S\": \"$team_source_entry_key\"},
            \"projectSourceEntryKey\": {\"S\": \"$project_source_entry_key\"},
            \"webhookAuthorizationKey\": {\"S\": \"WEBHOOK_ACL#TEAM_MEMBER#$PROJECT_DIRECTORY_ID#$team_id#$member_key\"},
            \"webhookAuthorizationSortKey\": {\"S\": \"PROJECT#$project_id\"}
          }
        }
      },
      {
        \"Put\": {
          \"TableName\": \"$PROJECT_DIRECTORY_TABLE\",
          \"Item\": {
            \"directoryId\": {\"S\": \"WEBHOOK_GRANT_CLEANUP#$PROJECT_DIRECTORY_ID#$team_id\"},
            \"entryKey\": {\"S\": \"PROJECT#$project_id#MEMBER#$member_key\"},
            \"entryType\": {\"S\": \"webhook-team-grant-cleanup\"},
            \"workspaceId\": {\"S\": \"$PROJECT_DIRECTORY_ID\"},
            \"teamId\": {\"S\": \"$team_id\"},
            \"projectId\": {\"S\": \"$project_id\"},
            \"memberKey\": {\"S\": \"$member_key\"},
            \"grantDirectoryId\": {\"S\": \"WEBHOOK_TEAM_GRANT#$PROJECT_DIRECTORY_ID#$member_key\"},
            \"grantEntryKey\": {\"S\": \"TEAM#$team_id#PROJECT#$project_id\"}
          }
        }
      }
    ]" \
    >/dev/null
}

RESOURCE_AUTHORIZATION_KEY="WEBHOOK_ACL#RESOURCE#$PROJECT_DIRECTORY_ID"
set_webhook_authorization_projection \
  '000010#000000#TEAM#core-team' \
  "$RESOURCE_AUTHORIZATION_KEY" \
  'TEAM#core-team'
set_webhook_authorization_projection \
  '000010#000010#PROJECT#refero' \
  "$RESOURCE_AUTHORIZATION_KEY" \
  'PROJECT#refero'
set_webhook_authorization_projection \
  '000010#000020#PROJECT#product-roadmap' \
  "$RESOURCE_AUTHORIZATION_KEY" \
  'PROJECT#product-roadmap'
set_webhook_authorization_projection \
  '000010#000030#PROJECT#shared-launch' \
  "$RESOURCE_AUTHORIZATION_KEY" \
  'PROJECT#shared-launch'
set_webhook_authorization_projection \
  '000020#000000#TEAM#design-team' \
  "$RESOURCE_AUTHORIZATION_KEY" \
  'TEAM#design-team'
set_webhook_authorization_projection \
  '000020#000010#PROJECT#shared-launch' \
  "$RESOURCE_AUTHORIZATION_KEY" \
  'PROJECT#shared-launch'
set_webhook_authorization_projection \
  '000020#000020#PROJECT#brand-refresh' \
  "$RESOURCE_AUTHORIZATION_KEY" \
  'PROJECT#brand-refresh'

set_webhook_authorization_projection \
  'PROJECT_MEMBER#refero#sato@example.com' \
  "WEBHOOK_ACL#MEMBER#$PROJECT_DIRECTORY_ID#sato@example.com" \
  'PROJECT#refero'
set_webhook_authorization_projection \
  'PROJECT_MEMBER#refero#viewer@example.com' \
  "WEBHOOK_ACL#MEMBER#$PROJECT_DIRECTORY_ID#viewer@example.com" \
  'PROJECT#refero'
for owner_project_id in refero product-roadmap shared-launch brand-refresh; do
  set_webhook_authorization_projection \
    "PROJECT_MEMBER#$owner_project_id#$PROJECT_MEMBER_KEY" \
    "WEBHOOK_ACL#MEMBER#$PROJECT_DIRECTORY_ID#$PROJECT_MEMBER_KEY" \
    "PROJECT#$owner_project_id"
done

seed_webhook_team_grant \
  'core-team' 'refero' 'sato@example.com' \
  '000010#000000#TEAM#core-team' '000010#000010#PROJECT#refero'
seed_webhook_team_grant \
  'core-team' 'refero' 'viewer@example.com' \
  '000010#000000#TEAM#core-team' '000010#000010#PROJECT#refero'
seed_webhook_team_grant \
  'core-team' 'refero' "$PROJECT_MEMBER_KEY" \
  '000010#000000#TEAM#core-team' '000010#000010#PROJECT#refero'
seed_webhook_team_grant \
  'core-team' 'product-roadmap' "$PROJECT_MEMBER_KEY" \
  '000010#000000#TEAM#core-team' '000010#000020#PROJECT#product-roadmap'
seed_webhook_team_grant \
  'core-team' 'shared-launch' "$PROJECT_MEMBER_KEY" \
  '000010#000000#TEAM#core-team' '000010#000030#PROJECT#shared-launch'
seed_webhook_team_grant \
  'design-team' 'shared-launch' "$PROJECT_MEMBER_KEY" \
  '000020#000000#TEAM#design-team' '000020#000010#PROJECT#shared-launch'
seed_webhook_team_grant \
  'design-team' 'brand-refresh' "$PROJECT_MEMBER_KEY" \
  '000020#000000#TEAM#design-team' '000020#000020#PROJECT#brand-refresh'

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

if ! aws_local dynamodb describe-table --table-name "$ENTERPRISE_IDENTITY_TABLE" >/dev/null 2>&1; then
  aws_local dynamodb create-table \
    --table-name "$ENTERPRISE_IDENTITY_TABLE" \
    --attribute-definitions \
      AttributeName=scopeKey,AttributeType=S \
      AttributeName=recordKey,AttributeType=S \
    --key-schema \
      AttributeName=scopeKey,KeyType=HASH \
      AttributeName=recordKey,KeyType=RANGE \
    --billing-mode PAY_PER_REQUEST \
    >/dev/null
fi

aws_local dynamodb wait table-exists --table-name "$ENTERPRISE_IDENTITY_TABLE"

ENTERPRISE_IDENTITY_TTL_STATUS="$(aws_local dynamodb describe-time-to-live \
  --table-name "$ENTERPRISE_IDENTITY_TABLE" \
  --query TimeToLiveDescription.TimeToLiveStatus \
  --output text 2>/dev/null || true)"
case "$ENTERPRISE_IDENTITY_TTL_STATUS" in
  ENABLED | ENABLING) ;;
  *)
    aws_local dynamodb update-time-to-live \
      --table-name "$ENTERPRISE_IDENTITY_TABLE" \
      --time-to-live-specification AttributeName=expiresAt,Enabled=true \
      >/dev/null
    ;;
esac

if ! aws_local dynamodb describe-table --table-name "$REALTIME_SESSIONS_TABLE" >/dev/null 2>&1; then
  aws_local dynamodb create-table \
    --table-name "$REALTIME_SESSIONS_TABLE" \
    --attribute-definitions \
      AttributeName=connectionId,AttributeType=S \
      AttributeName=scopeKey,AttributeType=S \
    --key-schema AttributeName=connectionId,KeyType=HASH \
    --global-secondary-indexes '[
      {
        "IndexName": "ScopeConnectionsIndex",
        "KeySchema": [
          {"AttributeName": "scopeKey", "KeyType": "HASH"},
          {"AttributeName": "connectionId", "KeyType": "RANGE"}
        ],
        "Projection": {"ProjectionType": "ALL"}
      }
    ]' \
    --billing-mode PAY_PER_REQUEST \
    >/dev/null
fi

aws_local dynamodb wait table-exists --table-name "$REALTIME_SESSIONS_TABLE"

REALTIME_SCOPE_INDEX_NAME="$(aws_local dynamodb describe-table \
  --table-name "$REALTIME_SESSIONS_TABLE" \
  --query "Table.GlobalSecondaryIndexes[?IndexName=='ScopeConnectionsIndex'] | [0].IndexName" \
  --output text)"
if [ -z "$REALTIME_SCOPE_INDEX_NAME" ] || [ "$REALTIME_SCOPE_INDEX_NAME" = "None" ]; then
  aws_local dynamodb update-table \
    --table-name "$REALTIME_SESSIONS_TABLE" \
    --attribute-definitions AttributeName=scopeKey,AttributeType=S \
    --global-secondary-index-updates \
      '[{"Create":{"IndexName":"ScopeConnectionsIndex","KeySchema":[{"AttributeName":"scopeKey","KeyType":"HASH"},{"AttributeName":"connectionId","KeyType":"RANGE"}],"Projection":{"ProjectionType":"ALL"}}}]' \
    >/dev/null
fi

REALTIME_SCOPE_INDEX_STATUS=""
REALTIME_SCOPE_INDEX_WAIT_ATTEMPT=0
while [ "$REALTIME_SCOPE_INDEX_WAIT_ATTEMPT" -lt 60 ]; do
  REALTIME_SCOPE_INDEX_STATUS="$(aws_local dynamodb describe-table \
    --table-name "$REALTIME_SESSIONS_TABLE" \
    --query "Table.GlobalSecondaryIndexes[?IndexName=='ScopeConnectionsIndex'] | [0].IndexStatus" \
    --output text)"
  if [ "$REALTIME_SCOPE_INDEX_STATUS" = "ACTIVE" ]; then
    break
  fi

  REALTIME_SCOPE_INDEX_WAIT_ATTEMPT=$((REALTIME_SCOPE_INDEX_WAIT_ATTEMPT + 1))
  sleep 1
done
if [ "$REALTIME_SCOPE_INDEX_STATUS" != "ACTIVE" ]; then
  echo "DynamoDB index ScopeConnectionsIndex did not become active for table $REALTIME_SESSIONS_TABLE." >&2
  exit 1
fi

REALTIME_SESSIONS_TTL_STATUS="$(aws_local dynamodb describe-time-to-live \
  --table-name "$REALTIME_SESSIONS_TABLE" \
  --query TimeToLiveDescription.TimeToLiveStatus \
  --output text 2>/dev/null || true)"
case "$REALTIME_SESSIONS_TTL_STATUS" in
  ENABLED | ENABLING) ;;
  *)
    aws_local dynamodb update-time-to-live \
      --table-name "$REALTIME_SESSIONS_TABLE" \
      --time-to-live-specification AttributeName=expiresAt,Enabled=true \
      >/dev/null
    ;;
esac

read_realtime_sessions_table_schema() {
  aws_local dynamodb describe-table \
    --table-name "$REALTIME_SESSIONS_TABLE" \
    --query "$1" \
    --output text
}

REALTIME_TABLE_BILLING_MODE="$(read_realtime_sessions_table_schema 'Table.BillingModeSummary.BillingMode')"
REALTIME_TABLE_PARTITION_KEY="$(read_realtime_sessions_table_schema "Table.KeySchema[?KeyType=='HASH'].AttributeName | [0]")"
REALTIME_TABLE_SORT_KEY="$(read_realtime_sessions_table_schema "Table.KeySchema[?KeyType=='RANGE'].AttributeName | [0]")"
REALTIME_TABLE_PARTITION_KEY_TYPE="$(read_realtime_sessions_table_schema "Table.AttributeDefinitions[?AttributeName=='connectionId'].AttributeType | [0]")"
REALTIME_INDEX_PARTITION_KEY="$(read_realtime_sessions_table_schema "Table.GlobalSecondaryIndexes[?IndexName=='ScopeConnectionsIndex'] | [0].KeySchema[?KeyType=='HASH'].AttributeName | [0]")"
REALTIME_INDEX_SORT_KEY="$(read_realtime_sessions_table_schema "Table.GlobalSecondaryIndexes[?IndexName=='ScopeConnectionsIndex'] | [0].KeySchema[?KeyType=='RANGE'].AttributeName | [0]")"
REALTIME_INDEX_PARTITION_KEY_TYPE="$(read_realtime_sessions_table_schema "Table.AttributeDefinitions[?AttributeName=='scopeKey'].AttributeType | [0]")"
REALTIME_INDEX_PROJECTION_TYPE="$(read_realtime_sessions_table_schema "Table.GlobalSecondaryIndexes[?IndexName=='ScopeConnectionsIndex'] | [0].Projection.ProjectionType")"
REALTIME_SESSIONS_TTL_ATTRIBUTE="$(aws_local dynamodb describe-time-to-live \
  --table-name "$REALTIME_SESSIONS_TABLE" \
  --query TimeToLiveDescription.AttributeName \
  --output text)"

if [ "$REALTIME_TABLE_BILLING_MODE" != "PAY_PER_REQUEST" ] ||
  [ "$REALTIME_TABLE_PARTITION_KEY" != "connectionId" ] ||
  [ "$REALTIME_TABLE_SORT_KEY" != "None" ] ||
  [ "$REALTIME_TABLE_PARTITION_KEY_TYPE" != "S" ] ||
  [ "$REALTIME_INDEX_PARTITION_KEY" != "scopeKey" ] ||
  [ "$REALTIME_INDEX_SORT_KEY" != "connectionId" ] ||
  [ "$REALTIME_INDEX_PARTITION_KEY_TYPE" != "S" ] ||
  [ "$REALTIME_INDEX_PROJECTION_TYPE" != "ALL" ] ||
  [ "$REALTIME_SESSIONS_TTL_ATTRIBUTE" != "expiresAt" ]; then
  echo "Existing Realtime Sessions table schema does not match the local API contract: table=$REALTIME_SESSIONS_TABLE index=ScopeConnectionsIndex" >&2
  echo "Actual: billingMode=$REALTIME_TABLE_BILLING_MODE primaryKey=$REALTIME_TABLE_PARTITION_KEY($REALTIME_TABLE_PARTITION_KEY_TYPE)/$REALTIME_TABLE_SORT_KEY indexKey=$REALTIME_INDEX_PARTITION_KEY($REALTIME_INDEX_PARTITION_KEY_TYPE)/$REALTIME_INDEX_SORT_KEY projection=$REALTIME_INDEX_PROJECTION_TYPE ttl=$REALTIME_SESSIONS_TTL_ATTRIBUTE" >&2
  exit 1
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

if ! aws_local dynamodb describe-table --table-name "$ANALYTICS_TABLE" >/dev/null 2>&1; then
  aws_local dynamodb create-table \
    --table-name "$ANALYTICS_TABLE" \
    --attribute-definitions \
      AttributeName=workspaceId,AttributeType=S \
      AttributeName=recordKey,AttributeType=S \
      AttributeName=scheduleShard,AttributeType=S \
      AttributeName=nextDeliveryAtRecordKey,AttributeType=S \
    --key-schema \
      AttributeName=workspaceId,KeyType=HASH \
      AttributeName=recordKey,KeyType=RANGE \
    --global-secondary-indexes "[
      {
        \"IndexName\": \"$ANALYTICS_SCHEDULE_INDEX\",
        \"KeySchema\": [
          {\"AttributeName\": \"scheduleShard\", \"KeyType\": \"HASH\"},
          {\"AttributeName\": \"nextDeliveryAtRecordKey\", \"KeyType\": \"RANGE\"}
        ],
        \"Projection\": {\"ProjectionType\": \"ALL\"}
      }
    ]" \
    --billing-mode PAY_PER_REQUEST \
    >/dev/null
fi

aws_local dynamodb wait table-exists --table-name "$ANALYTICS_TABLE"

if ! aws_local dynamodb describe-table --table-name "$TENANT_ADMINISTRATION_TABLE" >/dev/null 2>&1; then
  aws_local dynamodb create-table \
    --table-name "$TENANT_ADMINISTRATION_TABLE" \
    --attribute-definitions \
      AttributeName=workspaceId,AttributeType=S \
      AttributeName=recordKey,AttributeType=S \
    --key-schema \
      AttributeName=workspaceId,KeyType=HASH \
      AttributeName=recordKey,KeyType=RANGE \
    --billing-mode PAY_PER_REQUEST \
    >/dev/null
fi

aws_local dynamodb wait table-exists --table-name "$TENANT_ADMINISTRATION_TABLE"
TENANT_ADMINISTRATION_TTL_STATUS="$(aws_local dynamodb describe-time-to-live \
  --table-name "$TENANT_ADMINISTRATION_TABLE" \
  --query TimeToLiveDescription.TimeToLiveStatus \
  --output text 2>/dev/null || true)"
case "$TENANT_ADMINISTRATION_TTL_STATUS" in
  ENABLED | ENABLING) ;;
  *)
    aws_local dynamodb update-time-to-live \
      --table-name "$TENANT_ADMINISTRATION_TABLE" \
      --time-to-live-specification AttributeName=expiresAt,Enabled=true \
      >/dev/null
    ;;
esac

read_analytics_table_schema() {
  aws_local dynamodb describe-table \
    --table-name "$ANALYTICS_TABLE" \
    --query "$1" \
    --output text
}

ANALYTICS_TABLE_BILLING_MODE="$(read_analytics_table_schema 'Table.BillingModeSummary.BillingMode')"
ANALYTICS_TABLE_PARTITION_KEY="$(read_analytics_table_schema "Table.KeySchema[?KeyType=='HASH'].AttributeName | [0]")"
ANALYTICS_TABLE_SORT_KEY="$(read_analytics_table_schema "Table.KeySchema[?KeyType=='RANGE'].AttributeName | [0]")"
ANALYTICS_TABLE_PARTITION_KEY_TYPE="$(read_analytics_table_schema "Table.AttributeDefinitions[?AttributeName=='workspaceId'].AttributeType | [0]")"
ANALYTICS_TABLE_SORT_KEY_TYPE="$(read_analytics_table_schema "Table.AttributeDefinitions[?AttributeName=='recordKey'].AttributeType | [0]")"
ANALYTICS_INDEX_PARTITION_KEY="$(read_analytics_table_schema "Table.GlobalSecondaryIndexes[?IndexName=='$ANALYTICS_SCHEDULE_INDEX'] | [0].KeySchema[?KeyType=='HASH'].AttributeName | [0]")"
ANALYTICS_INDEX_SORT_KEY="$(read_analytics_table_schema "Table.GlobalSecondaryIndexes[?IndexName=='$ANALYTICS_SCHEDULE_INDEX'] | [0].KeySchema[?KeyType=='RANGE'].AttributeName | [0]")"
ANALYTICS_INDEX_PARTITION_KEY_TYPE="$(read_analytics_table_schema "Table.AttributeDefinitions[?AttributeName=='scheduleShard'].AttributeType | [0]")"
ANALYTICS_INDEX_SORT_KEY_TYPE="$(read_analytics_table_schema "Table.AttributeDefinitions[?AttributeName=='nextDeliveryAtRecordKey'].AttributeType | [0]")"
ANALYTICS_INDEX_PROJECTION_TYPE="$(read_analytics_table_schema "Table.GlobalSecondaryIndexes[?IndexName=='$ANALYTICS_SCHEDULE_INDEX'] | [0].Projection.ProjectionType")"

if [ "$ANALYTICS_TABLE_BILLING_MODE" != "PAY_PER_REQUEST" ] ||
  [ "$ANALYTICS_TABLE_PARTITION_KEY" != "workspaceId" ] ||
  [ "$ANALYTICS_TABLE_SORT_KEY" != "recordKey" ] ||
  [ "$ANALYTICS_TABLE_PARTITION_KEY_TYPE" != "S" ] ||
  [ "$ANALYTICS_TABLE_SORT_KEY_TYPE" != "S" ] ||
  [ "$ANALYTICS_INDEX_PARTITION_KEY" != "scheduleShard" ] ||
  [ "$ANALYTICS_INDEX_SORT_KEY" != "nextDeliveryAtRecordKey" ] ||
  [ "$ANALYTICS_INDEX_PARTITION_KEY_TYPE" != "S" ] ||
  [ "$ANALYTICS_INDEX_SORT_KEY_TYPE" != "S" ] ||
  [ "$ANALYTICS_INDEX_PROJECTION_TYPE" != "ALL" ]; then
  echo "Existing Analytics table schema does not match the local API contract: table=$ANALYTICS_TABLE index=$ANALYTICS_SCHEDULE_INDEX" >&2
  echo "Actual: billingMode=$ANALYTICS_TABLE_BILLING_MODE primaryKey=$ANALYTICS_TABLE_PARTITION_KEY($ANALYTICS_TABLE_PARTITION_KEY_TYPE)/$ANALYTICS_TABLE_SORT_KEY($ANALYTICS_TABLE_SORT_KEY_TYPE) indexKey=$ANALYTICS_INDEX_PARTITION_KEY($ANALYTICS_INDEX_PARTITION_KEY_TYPE)/$ANALYTICS_INDEX_SORT_KEY($ANALYTICS_INDEX_SORT_KEY_TYPE) projection=$ANALYTICS_INDEX_PROJECTION_TYPE" >&2
  exit 1
fi

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

umask 077
mkdir -p "$GENERATED_DIR"
COGNITO_ENV_TEMP_FILE="$(mktemp "$GENERATED_DIR/cognito.env.XXXXXX")"
cleanup_cognito_env_temp_file() {
  rm -f "$COGNITO_ENV_TEMP_FILE"
}
trap cleanup_cognito_env_temp_file 0
trap 'exit 129' HUP
trap 'exit 130' INT
trap 'exit 143' TERM
cat >"$COGNITO_ENV_TEMP_FILE" <<EOF
COGNITO_ENDPOINT=$PUBLIC_ENDPOINT_URL
COGNITO_ISSUER=$PUBLIC_ENDPOINT_URL/$POOL_ID
COGNITO_USER_POOL_ID=$POOL_ID
COGNITO_USER_POOL_NAME=$POOL_NAME
COGNITO_USER_POOL_CLIENT_NAME=$CLIENT_NAME
COGNITO_CLIENT_ID=$CLIENT_ID
COGNITO_SSO_USER_POOL_CLIENT_NAME=$SSO_CLIENT_NAME
COGNITO_SSO_CLIENT_ID=$SSO_CLIENT_ID
COGNITO_SSO_REDIRECT_URI=$SSO_REDIRECT_URI
COGNITO_TEST_USERNAME=$INITIAL_OWNER_USERNAME
MUKUROJI_INITIAL_OWNER_USERNAME=$INITIAL_OWNER_USERNAME
MUKUROJI_INITIAL_OWNER_EMAIL=$PROJECT_MEMBER_KEY
MUKUROJI_SYSTEM_ADMIN_GROUPS=$SYSTEM_ADMIN_GROUP
MUKUROJI_DASHBOARD_TABLE=$DASHBOARD_TABLE
MUKUROJI_PROJECT_DIRECTORY_TABLE=$PROJECT_DIRECTORY_TABLE
MUKUROJI_TEAM_ISSUES_TABLE=$TEAM_ISSUES_TABLE
MUKUROJI_WORK_ITEMS_TABLE=$WORK_ITEMS_TABLE
MUKUROJI_TEAM_ISSUE_EVENTS_TABLE=$TEAM_ISSUE_EVENTS_TABLE
TEAM_ISSUES_TABLE_NAME=$TEAM_ISSUES_TABLE
WORK_ITEMS_TABLE_NAME=$WORK_ITEMS_TABLE
MUKUROJI_COLLABORATION_TABLE=$COLLABORATION_TABLE
COLLABORATION_TABLE_NAME=$COLLABORATION_TABLE
MUKUROJI_WORKSPACE_SEARCH_TABLE=$WORKSPACE_SEARCH_TABLE
WORKSPACE_SEARCH_TABLE_NAME=$WORKSPACE_SEARCH_TABLE
ANALYTICS_TABLE_NAME=$ANALYTICS_TABLE
ANALYTICS_SCHEDULE_INDEX_NAME=$ANALYTICS_SCHEDULE_INDEX
MUKUROJI_NOTIFICATIONS_TABLE=$NOTIFICATIONS_TABLE
NOTIFICATIONS_TABLE_NAME=$NOTIFICATIONS_TABLE
MUKUROJI_REALTIME_SESSIONS_TABLE=$REALTIME_SESSIONS_TABLE
REALTIME_SESSIONS_TABLE_NAME=$REALTIME_SESSIONS_TABLE
MUKUROJI_WORKSPACE_DIRECTORY_ID=$WORKSPACE_DIRECTORY_ID
MUKUROJI_PROJECT_DIRECTORY_ID=$WORKSPACE_DIRECTORY_ID
MUKUROJI_AUDIT_EVENTS_TABLE=$AUDIT_EVENTS_TABLE
MUKUROJI_AUDIT_RETENTION_DAYS=$AUDIT_RETENTION_DAYS
TENANT_ADMINISTRATION_TABLE_NAME=$TENANT_ADMINISTRATION_TABLE
MUKUROJI_WORKSPACE_ACCESS_TABLE=$WORKSPACE_ACCESS_TABLE
ENTERPRISE_IDENTITY_TABLE_NAME=$ENTERPRISE_IDENTITY_TABLE
DYNAMODB_ENDPOINT=$PUBLIC_ENDPOINT_URL
EOF
# Host-owned .env に secret を残し、この discovery file は container UID と異なる
# native Linux user からも source できる mode で公開します。
chmod 644 "$COGNITO_ENV_TEMP_FILE"
mv -f "$COGNITO_ENV_TEMP_FILE" "$COGNITO_ENV_FILE"

echo "mukuroji Cognito ready: userPoolId=$POOL_ID clientId=$CLIENT_ID ssoClientId=$SSO_CLIENT_ID username=$INITIAL_OWNER_USERNAME adminGroup=$SYSTEM_ADMIN_GROUP"
echo "mukuroji DynamoDB ready: table=$DASHBOARD_TABLE item=summary"
echo "mukuroji DynamoDB ready: workItems=$WORK_ITEMS_TABLE projectDirectory=$PROJECT_DIRECTORY_TABLE"
echo "mukuroji DynamoDB ready: table=$WORK_ITEMS_TABLE canonicalSeed=ready"
echo "mukuroji DynamoDB ready: table=$PROJECT_DIRECTORY_TABLE workspaceDirectory=$WORKSPACE_DIRECTORY_ID"
echo "mukuroji audit configured: table=$AUDIT_EVENTS_TABLE retentionDays=$AUDIT_RETENTION_DAYS"
echo "mukuroji DynamoDB ready: table=$TENANT_ADMINISTRATION_TABLE tenantAdministration=ready"
echo "mukuroji DynamoDB ready: table=$WORKSPACE_ACCESS_TABLE workspace=$WORKSPACE_DIRECTORY_ID"
echo "mukuroji DynamoDB ready: table=$ENTERPRISE_IDENTITY_TABLE enterpriseIdentity=ready"
echo "mukuroji DynamoDB ready: table=$REALTIME_SESSIONS_TABLE scopeIndex=ScopeConnectionsIndex"
echo "mukuroji DynamoDB ready: table=$WORKSPACE_SEARCH_TABLE searchAndSavedViews=ready"
echo "mukuroji DynamoDB ready: table=$ANALYTICS_TABLE scheduleIndex=$ANALYTICS_SCHEDULE_INDEX"
