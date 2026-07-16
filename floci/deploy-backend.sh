#!/bin/sh
set -eu

SCRIPT_DIR="$(CDPATH= cd -- "$(dirname -- "$0")" && pwd)"
ROOT_DIR="$(CDPATH= cd -- "$SCRIPT_DIR/.." && pwd)"
GENERATED_DIR="$ROOT_DIR/.floci/generated"
ENV_FILE="$GENERATED_DIR/cognito.env"

if [ -f "$ENV_FILE" ]; then
  set -a
  . "$ENV_FILE"
  set +a
fi

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
NOTIFICATIONS_TABLE="${MUKUROJI_NOTIFICATIONS_TABLE:-${NOTIFICATIONS_TABLE_NAME:-mukuroji-notifications-local}}"
REALTIME_SESSIONS_TABLE="${MUKUROJI_REALTIME_SESSIONS_TABLE:-${REALTIME_SESSIONS_TABLE_NAME:-mukuroji-realtime-sessions-local}}"
WORKSPACE_DIRECTORY_ID="${MUKUROJI_WORKSPACE_DIRECTORY_ID:-${MUKUROJI_PROJECT_DIRECTORY_ID:-workspace#mukuroji-local}}"
AUDIT_EVENTS_TABLE="${MUKUROJI_AUDIT_EVENTS_TABLE:-${AUDIT_EVENTS_TABLE_NAME:-mukuroji-audit-events}}"
AUDIT_RETENTION_DAYS="${MUKUROJI_AUDIT_RETENTION_DAYS:-${AUDIT_RETENTION_DAYS:-2555}}"
WORKSPACE_AUDIT_PSEUDONYM_KEY="${MUKUROJI_WORKSPACE_AUDIT_PSEUDONYM_KEY:-6d756b75726f6a692d6c6f63616c2d61756469742d70736575646f6e796d2d7631}"
WORKSPACE_ACCESS_TABLE="${MUKUROJI_WORKSPACE_ACCESS_TABLE:-mukuroji-workspace-access-local}"
POOL_ID="${COGNITO_USER_POOL_ID:-us-east-1_mukuroji}"
CLIENT_ID="${COGNITO_CLIENT_ID:-}"
COGNITO_ISSUER="${COGNITO_ISSUER:-$PUBLIC_ENDPOINT_URL/$POOL_ID}"
COGNITO_ISSUER="${COGNITO_ISSUER%/}"
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

if is_missing "$CLIENT_ID"; then
  echo "COGNITO_CLIENT_ID is required. Run the Floci ready hook before deploying the backend." >&2
  exit 2
fi

mkdir -p "$GENERATED_DIR"

(cd "$ROOT_DIR" && bun run server:build:lambda)
(cd "$BUNDLE_DIR" && zip -q "$ZIP_PATH" index.mjs)

FUNCTION_ENV="Variables={MUKUROJI_DASHBOARD_TABLE=$DASHBOARD_TABLE,MUKUROJI_PROJECT_TASKS_TABLE=$PROJECT_TASKS_TABLE,MUKUROJI_PROJECT_DIRECTORY_TABLE=$PROJECT_DIRECTORY_TABLE,MUKUROJI_TEAM_ISSUES_TABLE=$TEAM_ISSUES_TABLE,MUKUROJI_TEAM_ISSUE_EVENTS_TABLE=$TEAM_ISSUE_EVENTS_TABLE,MUKUROJI_COLLABORATION_TABLE=$COLLABORATION_TABLE,COLLABORATION_TABLE_NAME=$COLLABORATION_TABLE,MUKUROJI_WORKSPACE_SEARCH_TABLE=$WORKSPACE_SEARCH_TABLE,WORKSPACE_SEARCH_TABLE_NAME=$WORKSPACE_SEARCH_TABLE,MUKUROJI_NOTIFICATIONS_TABLE=$NOTIFICATIONS_TABLE,NOTIFICATIONS_TABLE_NAME=$NOTIFICATIONS_TABLE,MUKUROJI_REALTIME_SESSIONS_TABLE=$REALTIME_SESSIONS_TABLE,REALTIME_SESSIONS_TABLE_NAME=$REALTIME_SESSIONS_TABLE,MUKUROJI_WORKSPACE_DIRECTORY_ID=$WORKSPACE_DIRECTORY_ID,MUKUROJI_PROJECT_DIRECTORY_ID=$WORKSPACE_DIRECTORY_ID,MUKUROJI_WORKSPACE_ACCESS_TABLE=$WORKSPACE_ACCESS_TABLE,WORKSPACE_ACCESS_TABLE_NAME=$WORKSPACE_ACCESS_TABLE,AUDIT_EVENTS_TABLE_NAME=$AUDIT_EVENTS_TABLE,AUDIT_RETENTION_DAYS=$AUDIT_RETENTION_DAYS,MUKUROJI_WORKSPACE_AUDIT_PSEUDONYM_KEY=$WORKSPACE_AUDIT_PSEUDONYM_KEY,COGNITO_USER_POOL_ID=$POOL_ID,COGNITO_ISSUER=$COGNITO_ISSUER,COGNITO_ENDPOINT=$LAMBDA_FLOCI_ENDPOINT,DYNAMODB_ENDPOINT=$LAMBDA_FLOCI_ENDPOINT,AWS_REGION=$AWS_REGION"
if [ -n "$CLIENT_ID" ]; then
  FUNCTION_ENV="$FUNCTION_ENV,COGNITO_CLIENT_ID=$CLIENT_ID"
fi
FUNCTION_ENV="$FUNCTION_ENV}"

if aws_local lambda get-function --function-name "$FUNCTION_NAME" >/dev/null 2>&1; then
  aws_local lambda update-function-code \
    --function-name "$FUNCTION_NAME" \
    --zip-file "fileb://$ZIP_PATH" \
    >/dev/null

  aws_local lambda update-function-configuration \
    --function-name "$FUNCTION_NAME" \
    --runtime nodejs22.x \
    --handler index.handler \
    --environment "$FUNCTION_ENV" \
    >/dev/null
else
  aws_local lambda create-function \
    --function-name "$FUNCTION_NAME" \
    --runtime nodejs22.x \
    --role "$ROLE_ARN" \
    --handler index.handler \
    --zip-file "fileb://$ZIP_PATH" \
    --environment "$FUNCTION_ENV" \
    >/dev/null
fi

API_ID="$(aws_local apigateway get-rest-apis \
  --query "items[?name=='$API_NAME'].id | [0]" \
  --output text)"

if is_missing "$API_ID"; then
  API_ID="$(aws_local apigateway create-rest-api \
    --name "$API_NAME" \
    --query id \
    --output text)"
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

API_BASE_URL="$PUBLIC_ENDPOINT_URL/restapis/$API_ID/$STAGE_NAME/_user_request_"

cat >"$GENERATED_DIR/backend.env" <<EOF
VITE_API_BASE_URL=$API_BASE_URL
MUKUROJI_BACKEND_API_PREFIXED_URL=$API_BASE_URL/api
MUKUROJI_BACKEND_FUNCTION_NAME=$FUNCTION_NAME
MUKUROJI_BACKEND_API_ID=$API_ID
MUKUROJI_BACKEND_STAGE_NAME=$STAGE_NAME
EOF

echo "mukuroji backend Lambda ready: function=$FUNCTION_NAME"
echo "mukuroji backend API ready: $API_BASE_URL"
