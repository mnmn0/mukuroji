#!/bin/sh
set -eu

ENDPOINT_URL="${AWS_ENDPOINT_URL:-http://localhost:4566}"
PUBLIC_ENDPOINT_URL="${MUKUROJI_PUBLIC_FLOCI_ENDPOINT:-$ENDPOINT_URL}"
POOL_ID="${COGNITO_USER_POOL_ID:-us-east-1_mukuroji}"
POOL_NAME="${COGNITO_USER_POOL_NAME:-mukuroji-local}"
CLIENT_NAME="${COGNITO_USER_POOL_CLIENT_NAME:-mukuroji-web-local}"
TEST_USERNAME="${COGNITO_TEST_USERNAME:-demo@example.com}"
TEST_PASSWORD="${COGNITO_TEST_PASSWORD:-Password123!}"
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

if ! aws_local cognito-idp admin-get-user \
  --user-pool-id "$POOL_ID" \
  --username "$TEST_USERNAME" >/dev/null 2>&1; then
  aws_local cognito-idp admin-create-user \
    --user-pool-id "$POOL_ID" \
    --username "$TEST_USERNAME" \
    --temporary-password "$TEST_PASSWORD" \
    --message-action SUPPRESS \
    --user-attributes Name=email,Value="$TEST_USERNAME" Name=email_verified,Value=true \
    >/dev/null
fi

aws_local cognito-idp admin-set-user-password \
  --user-pool-id "$POOL_ID" \
  --username "$TEST_USERNAME" \
  --password "$TEST_PASSWORD" \
  --permanent \
  >/dev/null

mkdir -p "$GENERATED_DIR"
cat >"$GENERATED_DIR/cognito.env" <<EOF
COGNITO_ENDPOINT=$PUBLIC_ENDPOINT_URL
COGNITO_USER_POOL_ID=$POOL_ID
COGNITO_USER_POOL_NAME=$POOL_NAME
COGNITO_USER_POOL_CLIENT_NAME=$CLIENT_NAME
COGNITO_CLIENT_ID=$CLIENT_ID
COGNITO_TEST_USERNAME=$TEST_USERNAME
COGNITO_TEST_PASSWORD=$TEST_PASSWORD
EOF

echo "mukuroji Cognito ready: userPoolId=$POOL_ID clientId=$CLIENT_ID username=$TEST_USERNAME"
