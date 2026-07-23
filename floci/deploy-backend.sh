#!/bin/sh
set -eu

SCRIPT_DIR="$(CDPATH= cd -- "$(dirname -- "$0")" && pwd)"
ROOT_DIR="$(CDPATH= cd -- "$SCRIPT_DIR/.." && pwd)"
GENERATED_DIR="$ROOT_DIR/.floci/generated"
ENV_FILE="$GENERATED_DIR/cognito.env"
INPUT_WORKSPACE_AUDIT_PSEUDONYM_KEY="${MUKUROJI_WORKSPACE_AUDIT_PSEUDONYM_KEY:-}"
INPUT_ENTERPRISE_IDENTITY_TOKEN_HASH_SECRET="${ENTERPRISE_IDENTITY_TOKEN_HASH_SECRET:-}"
INPUT_ENTERPRISE_SSO_STATE_SECRET="${ENTERPRISE_SSO_STATE_SECRET:-}"

if [ -f "$ENV_FILE" ]; then
  set -a
  . "$ENV_FILE"
  set +a
fi

# generated file は discovery 値専用です。旧 file に secret が残っていても採用せず、
# caller の owner-only .env / process environment だけを source of truth にします。
MUKUROJI_WORKSPACE_AUDIT_PSEUDONYM_KEY="$INPUT_WORKSPACE_AUDIT_PSEUDONYM_KEY"
ENTERPRISE_IDENTITY_TOKEN_HASH_SECRET="$INPUT_ENTERPRISE_IDENTITY_TOKEN_HASH_SECRET"
ENTERPRISE_SSO_STATE_SECRET="$INPUT_ENTERPRISE_SSO_STATE_SECRET"

FLOCI_PORT="${FLOCI_PORT:-4566}"
ENDPOINT_URL="${AWS_ENDPOINT_URL:-${COGNITO_ENDPOINT:-http://localhost:$FLOCI_PORT}}"
PUBLIC_ENDPOINT_URL="${MUKUROJI_PUBLIC_FLOCI_ENDPOINT:-${COGNITO_ENDPOINT:-http://localhost:$FLOCI_PORT}}"
PUBLIC_ENDPOINT_URL="${PUBLIC_ENDPOINT_URL%/}"
LAMBDA_FLOCI_ENDPOINT="${MUKUROJI_LAMBDA_FLOCI_ENDPOINT:-http://floci:4566}"
AWS_REGION="${AWS_REGION:-us-east-1}"
AWS_ACCOUNT_ID="${AWS_ACCOUNT_ID:-000000000000}"
FUNCTION_NAME="${MUKUROJI_BACKEND_FUNCTION_NAME:-mukuroji-backend-local}"
API_NAME="${MUKUROJI_BACKEND_API_NAME:-mukuroji-backend-local}"
STAGE_NAME="${MUKUROJI_BACKEND_STAGE_NAME:-dev}"
DASHBOARD_TABLE="${MUKUROJI_DASHBOARD_TABLE:-mukuroji-dashboard-local}"
PROJECT_TASKS_TABLE="${MUKUROJI_PROJECT_TASKS_TABLE:-mukuroji-project-tasks-v2-local}"
PROJECT_DIRECTORY_TABLE="${MUKUROJI_PROJECT_DIRECTORY_TABLE:-mukuroji-project-directory-local}"
TEAM_ISSUES_TABLE="${MUKUROJI_TEAM_ISSUES_TABLE:-mukuroji-team-issues-local}"
TEAM_ISSUE_EVENTS_TABLE="${MUKUROJI_TEAM_ISSUE_EVENTS_TABLE:-mukuroji-team-issue-events-local}"
COLLABORATION_TABLE="${MUKUROJI_COLLABORATION_TABLE:-${COLLABORATION_TABLE_NAME:-mukuroji-collaboration-local}}"
WORKSPACE_SEARCH_TABLE="${MUKUROJI_WORKSPACE_SEARCH_TABLE:-${WORKSPACE_SEARCH_TABLE_NAME:-mukuroji-workspace-search-local}}"
ANALYTICS_TABLE="${ANALYTICS_TABLE_NAME:-mukuroji-analytics-local}"
ANALYTICS_SCHEDULE_INDEX="${ANALYTICS_SCHEDULE_INDEX_NAME:-ScheduleDueIndex}"
NOTIFICATIONS_TABLE="${MUKUROJI_NOTIFICATIONS_TABLE:-${NOTIFICATIONS_TABLE_NAME:-mukuroji-notifications-local}}"
REALTIME_SESSIONS_TABLE="${MUKUROJI_REALTIME_SESSIONS_TABLE:-${REALTIME_SESSIONS_TABLE_NAME:-mukuroji-realtime-sessions-local}}"
WORKSPACE_DIRECTORY_ID="${MUKUROJI_WORKSPACE_DIRECTORY_ID:-${MUKUROJI_PROJECT_DIRECTORY_ID:-workspace#mukuroji-local}}"
AUDIT_EVENTS_TABLE="${MUKUROJI_AUDIT_EVENTS_TABLE:-${AUDIT_EVENTS_TABLE_NAME:-mukuroji-audit-events}}"
AUDIT_RETENTION_DAYS="${MUKUROJI_AUDIT_RETENTION_DAYS:-${AUDIT_RETENTION_DAYS:-2555}}"
AUTOMATION_TABLE="${MUKUROJI_AUTOMATION_TABLE:-${AUTOMATION_TABLE_NAME:-mukuroji-automation-local}}"
AUTOMATION_WEBHOOK_SECRET_PREFIX="${AUTOMATION_WEBHOOK_SECRET_PREFIX:-mukuroji/automation-webhooks}"
AUTOMATION_INBOUND_WEBHOOK_SECRET_PREFIX="${AUTOMATION_INBOUND_WEBHOOK_SECRET_PREFIX:-mukuroji/automation-inbound-webhooks}"
LAMBDA_SECRETS_MANAGER_ENDPOINT="${MUKUROJI_LAMBDA_SECRETS_MANAGER_ENDPOINT:-$LAMBDA_FLOCI_ENDPOINT}"
PLANNING_TABLE="${PLANNING_TABLE_NAME:-mukuroji-planning-local}"
WORKSPACE_AUDIT_PSEUDONYM_KEY="${MUKUROJI_WORKSPACE_AUDIT_PSEUDONYM_KEY:-}"
WORKSPACE_ACCESS_TABLE="${MUKUROJI_WORKSPACE_ACCESS_TABLE:-mukuroji-workspace-access-local}"
ENTERPRISE_IDENTITY_TABLE="${ENTERPRISE_IDENTITY_TABLE_NAME:-mukuroji-enterprise-identity-local}"
POOL_ID="${COGNITO_USER_POOL_ID:-us-east-1_mukuroji}"
CLIENT_ID="${COGNITO_CLIENT_ID:-}"
SSO_CLIENT_ID="${COGNITO_SSO_CLIENT_ID:-}"
COGNITO_ISSUER="${COGNITO_ISSUER:-$PUBLIC_ENDPOINT_URL/$POOL_ID}"
COGNITO_ISSUER="${COGNITO_ISSUER%/}"
COGNITO_ENTERPRISE_IDP_NAME="${COGNITO_ENTERPRISE_IDP_NAME:-}"
COGNITO_HOSTED_UI_DOMAIN="${COGNITO_HOSTED_UI_DOMAIN:-}"
COGNITO_SSO_REDIRECT_URI="${COGNITO_SSO_REDIRECT_URI:-}"
ZIP_PATH="$GENERATED_DIR/backend-lambda.zip"
BUNDLE_DIR="$ROOT_DIR/server/dist/lambda"
ROLE_ARN="arn:aws:iam::$AWS_ACCOUNT_ID:role/mukuroji-lambda-local"
FUNCTION_ARN="arn:aws:lambda:$AWS_REGION:$AWS_ACCOUNT_ID:function:$FUNCTION_NAME"
INTEGRATION_URI="arn:aws:apigateway:$AWS_REGION:lambda:path/2015-03-31/functions/$FUNCTION_ARN/invocations"

aws_local() {
  AWS_ACCESS_KEY_ID="${AWS_ACCESS_KEY_ID:-test}" \
    AWS_SECRET_ACCESS_KEY="${AWS_SECRET_ACCESS_KEY:-test}" \
    AWS_DEFAULT_REGION="$AWS_REGION" \
    aws --endpoint-url "$ENDPOINT_URL" "$@"
}

is_missing() {
  [ -z "$1" ] || [ "$1" = "None" ]
}

validate_workspace_audit_pseudonym_key() {
  key="$1"

  if [ -z "$key" ]; then
    echo 'MUKUROJI_WORKSPACE_AUDIT_PSEUDONYM_KEY is required. Set it to the output of "openssl rand -hex 32".' >&2
    exit 2
  fi

  case "$key" in
    *[!0-9a-f]*)
      echo 'MUKUROJI_WORKSPACE_AUDIT_PSEUDONYM_KEY must be exactly 64 lowercase hexadecimal characters.' >&2
      exit 2
      ;;
  esac

  if [ "${#key}" -ne 64 ]; then
    echo 'MUKUROJI_WORKSPACE_AUDIT_PSEUDONYM_KEY must be exactly 64 lowercase hexadecimal characters.' >&2
    exit 2
  fi
}

validate_workspace_audit_pseudonym_key "$WORKSPACE_AUDIT_PSEUDONYM_KEY"

if [ "${#ENTERPRISE_IDENTITY_TOKEN_HASH_SECRET}" -lt 32 ] ||
  [ "${#ENTERPRISE_IDENTITY_TOKEN_HASH_SECRET}" -gt 256 ]; then
  echo 'ENTERPRISE_IDENTITY_TOKEN_HASH_SECRET must contain between 32 and 256 characters.' >&2
  exit 2
fi

if [ "${#ENTERPRISE_SSO_STATE_SECRET}" -lt 32 ] ||
  [ "${#ENTERPRISE_SSO_STATE_SECRET}" -gt 256 ]; then
  echo 'ENTERPRISE_SSO_STATE_SECRET must contain between 32 and 256 characters.' >&2
  exit 2
fi

if [ "$ENTERPRISE_SSO_STATE_SECRET" = "$ENTERPRISE_IDENTITY_TOKEN_HASH_SECRET" ]; then
  echo 'ENTERPRISE_SSO_STATE_SECRET must differ from ENTERPRISE_IDENTITY_TOKEN_HASH_SECRET.' >&2
  exit 2
fi

if is_missing "$CLIENT_ID"; then
  echo "COGNITO_CLIENT_ID is required. Run the Floci ready hook before deploying the backend." >&2
  exit 2
fi

if is_missing "$SSO_CLIENT_ID"; then
  echo "COGNITO_SSO_CLIENT_ID is required. Run the Floci ready hook before deploying the backend." >&2
  exit 2
fi

if [ "$SSO_CLIENT_ID" = "$CLIENT_ID" ]; then
  echo "COGNITO_SSO_CLIENT_ID must differ from COGNITO_CLIENT_ID." >&2
  exit 2
fi

mkdir -p "$GENERATED_DIR"

(cd "$ROOT_DIR" && bun run server:build:lambda)
(cd "$BUNDLE_DIR" && zip -q "$ZIP_PATH" index.mjs)

API_ID="$(aws_local apigateway get-rest-apis \
  --query "items[?name=='$API_NAME'].id | [0]" \
  --output text)"

if is_missing "$API_ID"; then
  API_ID="$(aws_local apigateway create-rest-api \
    --name "$API_NAME" \
    --query id \
    --output text)"
fi

API_BASE_URL="$PUBLIC_ENDPOINT_URL/restapis/$API_ID/$STAGE_NAME/_user_request_"

# Secret を AWS CLI の process arguments に含めず、owner-only JSON file から読み込みます。
umask 077
FUNCTION_ENV_FILE="$(mktemp "$GENERATED_DIR/backend-lambda-environment.XXXXXX")"
cleanup_function_environment_file() {
  rm -f "$FUNCTION_ENV_FILE"
}
trap cleanup_function_environment_file 0
trap 'exit 129' HUP
trap 'exit 130' INT
trap 'exit 143' TERM

MUKUROJI_DASHBOARD_TABLE="$DASHBOARD_TABLE" \
MUKUROJI_PROJECT_TASKS_TABLE="$PROJECT_TASKS_TABLE" \
MUKUROJI_PROJECT_DIRECTORY_TABLE="$PROJECT_DIRECTORY_TABLE" \
MUKUROJI_TEAM_ISSUES_TABLE="$TEAM_ISSUES_TABLE" \
MUKUROJI_TEAM_ISSUE_EVENTS_TABLE="$TEAM_ISSUE_EVENTS_TABLE" \
MUKUROJI_COLLABORATION_TABLE="$COLLABORATION_TABLE" \
COLLABORATION_TABLE_NAME="$COLLABORATION_TABLE" \
MUKUROJI_WORKSPACE_SEARCH_TABLE="$WORKSPACE_SEARCH_TABLE" \
WORKSPACE_SEARCH_TABLE_NAME="$WORKSPACE_SEARCH_TABLE" \
ANALYTICS_TABLE_NAME="$ANALYTICS_TABLE" \
ANALYTICS_SCHEDULE_INDEX_NAME="$ANALYTICS_SCHEDULE_INDEX" \
MUKUROJI_NOTIFICATIONS_TABLE="$NOTIFICATIONS_TABLE" \
NOTIFICATIONS_TABLE_NAME="$NOTIFICATIONS_TABLE" \
MUKUROJI_REALTIME_SESSIONS_TABLE="$REALTIME_SESSIONS_TABLE" \
REALTIME_SESSIONS_TABLE_NAME="$REALTIME_SESSIONS_TABLE" \
MUKUROJI_WORKSPACE_DIRECTORY_ID="$WORKSPACE_DIRECTORY_ID" \
MUKUROJI_PROJECT_DIRECTORY_ID="$WORKSPACE_DIRECTORY_ID" \
MUKUROJI_WORKSPACE_ACCESS_TABLE="$WORKSPACE_ACCESS_TABLE" \
WORKSPACE_ACCESS_TABLE_NAME="$WORKSPACE_ACCESS_TABLE" \
ENTERPRISE_IDENTITY_TABLE_NAME="$ENTERPRISE_IDENTITY_TABLE" \
ENTERPRISE_IDENTITY_TOKEN_HASH_SECRET="$ENTERPRISE_IDENTITY_TOKEN_HASH_SECRET" \
ENTERPRISE_SSO_STATE_SECRET="$ENTERPRISE_SSO_STATE_SECRET" \
AUDIT_EVENTS_TABLE_NAME="$AUDIT_EVENTS_TABLE" \
AUDIT_RETENTION_DAYS="$AUDIT_RETENTION_DAYS" \
MUKUROJI_AUTOMATION_TABLE="$AUTOMATION_TABLE" \
AUTOMATION_TABLE_NAME="$AUTOMATION_TABLE" \
AUTOMATION_WEBHOOK_SECRET_PREFIX="$AUTOMATION_WEBHOOK_SECRET_PREFIX" \
AUTOMATION_INBOUND_WEBHOOK_SECRET_PREFIX="$AUTOMATION_INBOUND_WEBHOOK_SECRET_PREFIX" \
AUTOMATION_INBOUND_WEBHOOK_BASE_URL="$API_BASE_URL" \
SECRETS_MANAGER_ENDPOINT="$LAMBDA_SECRETS_MANAGER_ENDPOINT" \
AWS_ENDPOINT_URL_SECRETSMANAGER="$LAMBDA_SECRETS_MANAGER_ENDPOINT" \
MUKUROJI_LOCAL_AWS_RUNTIME=floci \
PLANNING_TABLE_NAME="$PLANNING_TABLE" \
MUKUROJI_WORKSPACE_AUDIT_PSEUDONYM_KEY="$WORKSPACE_AUDIT_PSEUDONYM_KEY" \
COGNITO_USER_POOL_ID="$POOL_ID" \
COGNITO_CLIENT_ID="$CLIENT_ID" \
COGNITO_SSO_CLIENT_ID="$SSO_CLIENT_ID" \
COGNITO_ENTERPRISE_IDP_NAME="$COGNITO_ENTERPRISE_IDP_NAME" \
COGNITO_HOSTED_UI_DOMAIN="$COGNITO_HOSTED_UI_DOMAIN" \
COGNITO_SSO_REDIRECT_URI="$COGNITO_SSO_REDIRECT_URI" \
COGNITO_ISSUER="$COGNITO_ISSUER" \
COGNITO_ENDPOINT="$LAMBDA_FLOCI_ENDPOINT" \
DYNAMODB_ENDPOINT="$LAMBDA_FLOCI_ENDPOINT" \
AWS_REGION="$AWS_REGION" \
bun -e '
const names = `
  MUKUROJI_DASHBOARD_TABLE
  MUKUROJI_PROJECT_TASKS_TABLE
  MUKUROJI_PROJECT_DIRECTORY_TABLE
  MUKUROJI_TEAM_ISSUES_TABLE
  MUKUROJI_TEAM_ISSUE_EVENTS_TABLE
  MUKUROJI_COLLABORATION_TABLE
  COLLABORATION_TABLE_NAME
  MUKUROJI_WORKSPACE_SEARCH_TABLE
  WORKSPACE_SEARCH_TABLE_NAME
  ANALYTICS_TABLE_NAME
  ANALYTICS_SCHEDULE_INDEX_NAME
  MUKUROJI_NOTIFICATIONS_TABLE
  NOTIFICATIONS_TABLE_NAME
  MUKUROJI_REALTIME_SESSIONS_TABLE
  REALTIME_SESSIONS_TABLE_NAME
  MUKUROJI_WORKSPACE_DIRECTORY_ID
  MUKUROJI_PROJECT_DIRECTORY_ID
  MUKUROJI_WORKSPACE_ACCESS_TABLE
  WORKSPACE_ACCESS_TABLE_NAME
  ENTERPRISE_IDENTITY_TABLE_NAME
  ENTERPRISE_IDENTITY_TOKEN_HASH_SECRET
  ENTERPRISE_SSO_STATE_SECRET
  AUDIT_EVENTS_TABLE_NAME
  AUDIT_RETENTION_DAYS
  MUKUROJI_AUTOMATION_TABLE
  AUTOMATION_TABLE_NAME
  AUTOMATION_WEBHOOK_SECRET_PREFIX
  AUTOMATION_INBOUND_WEBHOOK_SECRET_PREFIX
  AUTOMATION_INBOUND_WEBHOOK_BASE_URL
  SECRETS_MANAGER_ENDPOINT
  AWS_ENDPOINT_URL_SECRETSMANAGER
  MUKUROJI_LOCAL_AWS_RUNTIME
  PLANNING_TABLE_NAME
  MUKUROJI_WORKSPACE_AUDIT_PSEUDONYM_KEY
  COGNITO_USER_POOL_ID
  COGNITO_CLIENT_ID
  COGNITO_SSO_CLIENT_ID
  COGNITO_ENTERPRISE_IDP_NAME
  COGNITO_HOSTED_UI_DOMAIN
  COGNITO_SSO_REDIRECT_URI
  COGNITO_ISSUER
  COGNITO_ENDPOINT
  DYNAMODB_ENDPOINT
  AWS_REGION
`.trim().split(/\s+/)
const variables = Object.fromEntries(names.map((name) => {
  const value = process.env[name]
  if (value === undefined) {
    throw new Error(`Missing Lambda environment value: ${name}`)
  }
  return [name, value]
}))
await Bun.write(process.argv[1], JSON.stringify({ Variables: variables }))
' "$FUNCTION_ENV_FILE"

if aws_local lambda get-function --function-name "$FUNCTION_NAME" >/dev/null 2>&1; then
  aws_local lambda update-function-code \
    --function-name "$FUNCTION_NAME" \
    --zip-file "fileb://$ZIP_PATH" \
    >/dev/null

  aws_local lambda update-function-configuration \
    --function-name "$FUNCTION_NAME" \
    --runtime nodejs22.x \
    --handler index.handler \
    --environment "file://$FUNCTION_ENV_FILE" \
    >/dev/null
else
  aws_local lambda create-function \
    --function-name "$FUNCTION_NAME" \
    --runtime nodejs22.x \
    --role "$ROLE_ARN" \
    --handler index.handler \
    --zip-file "fileb://$ZIP_PATH" \
    --environment "file://$FUNCTION_ENV_FILE" \
    >/dev/null
fi

ROOT_RESOURCE_ID="$(aws_local apigateway get-resources \
  --rest-api-id "$API_ID" \
  --query "items[?path=='/'].id | [0]" \
  --output text)"

PROXY_RESOURCE_ID="$(aws_local apigateway get-resources \
  --rest-api-id "$API_ID" \
  --query "items[?path=='/{proxy+}'].id | [0]" \
  --output text)"

if is_missing "$PROXY_RESOURCE_ID"; then
  PROXY_RESOURCE_ID="$(aws_local apigateway create-resource \
    --rest-api-id "$API_ID" \
    --parent-id "$ROOT_RESOURCE_ID" \
    --path-part '{proxy+}' \
    --query id \
    --output text)"
fi

if ! aws_local apigateway get-method \
  --rest-api-id "$API_ID" \
  --resource-id "$PROXY_RESOURCE_ID" \
  --http-method ANY >/dev/null 2>&1; then
  aws_local apigateway put-method \
    --rest-api-id "$API_ID" \
    --resource-id "$PROXY_RESOURCE_ID" \
    --http-method ANY \
    --authorization-type NONE \
    >/dev/null
fi

aws_local apigateway put-integration \
  --rest-api-id "$API_ID" \
  --resource-id "$PROXY_RESOURCE_ID" \
  --http-method ANY \
  --type AWS_PROXY \
  --integration-http-method POST \
  --uri "$INTEGRATION_URI" \
  >/dev/null

if ! permission_error="$(aws_local lambda add-permission \
  --function-name "$FUNCTION_NAME" \
  --statement-id "$FUNCTION_NAME-apigateway" \
  --action lambda:InvokeFunction \
  --principal apigateway.amazonaws.com \
  2>&1)"; then
  case "$permission_error" in
    *ResourceConflictException* | *"already exists"*) ;;
    *)
      echo "$permission_error" >&2
      exit 1
      ;;
  esac
fi

DEPLOYMENT_ID="$(aws_local apigateway create-deployment \
  --rest-api-id "$API_ID" \
  --query id \
  --output text)"

if aws_local apigateway get-stage \
  --rest-api-id "$API_ID" \
  --stage-name "$STAGE_NAME" >/dev/null 2>&1; then
  aws_local apigateway update-stage \
    --rest-api-id "$API_ID" \
    --stage-name "$STAGE_NAME" \
    --patch-operations "op=replace,path=/deploymentId,value=$DEPLOYMENT_ID" \
    >/dev/null
else
  aws_local apigateway create-stage \
    --rest-api-id "$API_ID" \
    --stage-name "$STAGE_NAME" \
    --deployment-id "$DEPLOYMENT_ID" \
    >/dev/null
fi

cat >"$GENERATED_DIR/backend.env" <<EOF
VITE_API_BASE_URL=$API_BASE_URL
MUKUROJI_BACKEND_API_PREFIXED_URL=$API_BASE_URL/api
MUKUROJI_BACKEND_FUNCTION_NAME=$FUNCTION_NAME
MUKUROJI_BACKEND_API_ID=$API_ID
MUKUROJI_BACKEND_STAGE_NAME=$STAGE_NAME
EOF

echo "mukuroji backend Lambda ready: function=$FUNCTION_NAME"
echo "mukuroji backend API ready: $API_BASE_URL"
