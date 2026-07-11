#!/usr/bin/env bash
set -euo pipefail

require_env() {
  local name="$1"

  if [[ -z "${!name:-}" ]]; then
    echo "$name is required." >&2
    exit 2
  fi
}

require_env COGNITO_USER_POOL_ID
require_env COGNITO_USER_POOL_CLIENT_ID
require_env MUKUROJI_WORKSPACE_DIRECTORY_ID
require_env MUKUROJI_INITIAL_OWNER_EMAIL
require_env MUKUROJI_INITIAL_OWNER_USERNAME

AWS_REGION="${AWS_REGION:-${AWS_DEFAULT_REGION:-us-east-1}}"
INITIAL_OWNER_USERNAME="$MUKUROJI_INITIAL_OWNER_USERNAME"
NORMALIZED_OWNER_EMAIL="$(printf '%s' "$MUKUROJI_INITIAL_OWNER_EMAIL" | tr '[:upper:]' '[:lower:]')"

case "$MUKUROJI_WORKSPACE_DIRECTORY_ID" in
  '' | *[!A-Za-z0-9._:/#@+-]*)
    echo "MUKUROJI_WORKSPACE_DIRECTORY_ID contains unsupported characters." >&2
    exit 2
    ;;
esac

case "$NORMALIZED_OWNER_EMAIL" in
  '' | *[!a-z0-9._%+@-]* | @* | *@ | *@*@*)
    echo "MUKUROJI_INITIAL_OWNER_EMAIL must be an email address." >&2
    exit 2
    ;;
esac

aws_args=(--region "$AWS_REGION")
if [[ -n "${AWS_ENDPOINT_URL:-}" ]]; then
  aws_args+=(--endpoint-url "$AWS_ENDPOINT_URL")
fi
if [[ "${AWS_NO_SIGN_REQUEST:-}" == "1" ]]; then
  aws_args+=(--no-sign-request)
fi

aws_call() {
  aws "$@" "${aws_args[@]}"
}

text_list_contains() {
  local values_text="$1"
  local expected="$2"
  local value
  local -a values=()

  if [[ -z "$values_text" || "$values_text" == "None" ]]; then
    return 1
  fi

  read -r -a values <<< "$values_text"

  for value in "${values[@]}"; do
    if [[ "$value" == "$expected" ]]; then
      return 0
    fi
  done

  return 1
}

validate_owner_email_login() {
  local username_attributes
  local alias_attributes
  local email_verified

  if [[ "$INITIAL_OWNER_USERNAME" == "$NORMALIZED_OWNER_EMAIL" ]]; then
    return
  fi

  username_attributes="$(aws_call cognito-idp describe-user-pool \
    --user-pool-id "$COGNITO_USER_POOL_ID" \
    --query UserPool.UsernameAttributes \
    --output text)"
  alias_attributes="$(aws_call cognito-idp describe-user-pool \
    --user-pool-id "$COGNITO_USER_POOL_ID" \
    --query UserPool.AliasAttributes \
    --output text)"

  if text_list_contains "$username_attributes" email; then
    return
  fi

  if text_list_contains "$alias_attributes" email; then
    email_verified="$(read_owner_attribute email_verified | tr '[:upper:]' '[:lower:]')"

    if [[ "$email_verified" == "true" ]]; then
      return
    fi

    echo "Initial owner uses an email alias, but Cognito email_verified is not true." >&2
    exit 1
  fi

  echo "Initial owner username differs from email, but the user pool does not allow email as a username or alias." >&2
  exit 1
}

validate_client_read_attributes() {
  local configured_attributes="$1"
  local required_attribute

  if [[ -z "$configured_attributes" || "$configured_attributes" == "None" ]]; then
    return
  fi

  for required_attribute in email custom:directory_id custom:workspace_id; do
    if ! text_list_contains "$configured_attributes" "$required_attribute"; then
      echo "Cognito app client ReadAttributes must include $required_attribute when ReadAttributes is explicitly configured." >&2
      exit 1
    fi
  done
}

read_owner_attribute() {
  local attribute_name="$1"
  aws_call cognito-idp admin-get-user \
    --user-pool-id "$COGNITO_USER_POOL_ID" \
    --username "$INITIAL_OWNER_USERNAME" \
    --query "UserAttributes[?Name=='$attribute_name'].Value | [0]" \
    --output text
}

ensure_custom_attribute() {
  local attribute_name="$1"
  local count
  count="$(aws_call cognito-idp describe-user-pool \
    --user-pool-id "$COGNITO_USER_POOL_ID" \
    --query "length(UserPool.SchemaAttributes[?Name=='custom:$attribute_name'])" \
    --output text)"

  if [[ "$count" == "0" ]]; then
    aws_call cognito-idp add-custom-attributes \
      --user-pool-id "$COGNITO_USER_POOL_ID" \
      --custom-attributes "Name=$attribute_name,AttributeDataType=String,Mutable=true" \
      >/dev/null
    echo "Added Cognito custom attribute: custom:$attribute_name"
  fi
}

client_secret="$(aws_call cognito-idp describe-user-pool-client \
  --user-pool-id "$COGNITO_USER_POOL_ID" \
  --client-id "$COGNITO_USER_POOL_CLIENT_ID" \
  --query UserPoolClient.ClientSecret \
  --output text)"
client_flows="$(aws_call cognito-idp describe-user-pool-client \
  --user-pool-id "$COGNITO_USER_POOL_ID" \
  --client-id "$COGNITO_USER_POOL_CLIENT_ID" \
  --query UserPoolClient.ExplicitAuthFlows \
  --output text)"
client_read_attributes="$(aws_call cognito-idp describe-user-pool-client \
  --user-pool-id "$COGNITO_USER_POOL_ID" \
  --client-id "$COGNITO_USER_POOL_CLIENT_ID" \
  --query UserPoolClient.ReadAttributes \
  --output text)"

if [[ -n "$client_secret" && "$client_secret" != "None" ]]; then
  echo "Cognito app client must not have a client secret." >&2
  exit 1
fi

if [[ "$client_flows" != *"ALLOW_USER_PASSWORD_AUTH"* ]]; then
  if [[ -n "${AWS_ENDPOINT_URL:-}" && ( -z "$client_flows" || "$client_flows" == "None" ) ]]; then
    echo "Cognito emulator omitted ExplicitAuthFlows; verify USER_PASSWORD_AUTH with a login smoke test." >&2
  else
    echo "Cognito app client must allow ALLOW_USER_PASSWORD_AUTH." >&2
    exit 1
  fi
fi

validate_client_read_attributes "$client_read_attributes"
validate_owner_email_login

owner_enabled="$(aws_call cognito-idp admin-get-user \
  --user-pool-id "$COGNITO_USER_POOL_ID" \
  --username "$INITIAL_OWNER_USERNAME" \
  --query Enabled \
  --output text)"
owner_status="$(aws_call cognito-idp admin-get-user \
  --user-pool-id "$COGNITO_USER_POOL_ID" \
  --username "$INITIAL_OWNER_USERNAME" \
  --query UserStatus \
  --output text)"
owner_email="$(read_owner_attribute email | tr '[:upper:]' '[:lower:]')"

if [[ "$owner_enabled" != "True" || "$owner_status" != "CONFIRMED" ]]; then
  echo "Initial owner must be enabled and CONFIRMED: username=$INITIAL_OWNER_USERNAME enabled=$owner_enabled status=$owner_status" >&2
  exit 1
fi

if [[ "$owner_email" != "$NORMALIZED_OWNER_EMAIL" ]]; then
  echo "Initial owner email does not match Cognito: expected=$NORMALIZED_OWNER_EMAIL actual=$owner_email" >&2
  exit 1
fi

ensure_custom_attribute directory_id
ensure_custom_attribute workspace_id

aws_call cognito-idp admin-update-user-attributes \
  --user-pool-id "$COGNITO_USER_POOL_ID" \
  --username "$INITIAL_OWNER_USERNAME" \
  --user-attributes \
    "Name=custom:directory_id,Value=$MUKUROJI_WORKSPACE_DIRECTORY_ID" \
    "Name=custom:workspace_id,Value=$MUKUROJI_WORKSPACE_DIRECTORY_ID" \
  >/dev/null

directory_id="$(read_owner_attribute 'custom:directory_id')"
workspace_id="$(read_owner_attribute 'custom:workspace_id')"

if [[ "$directory_id" != "$MUKUROJI_WORKSPACE_DIRECTORY_ID" || "$workspace_id" != "$MUKUROJI_WORKSPACE_DIRECTORY_ID" ]]; then
  echo "Cognito workspace attributes do not match after update: directory_id=$directory_id workspace_id=$workspace_id" >&2
  exit 1
fi

echo "Cognito workspace owner ready: userPoolId=$COGNITO_USER_POOL_ID clientId=$COGNITO_USER_POOL_CLIENT_ID username=$INITIAL_OWNER_USERNAME email=$NORMALIZED_OWNER_EMAIL workspaceDirectoryId=$MUKUROJI_WORKSPACE_DIRECTORY_ID"
