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
require_env PROJECT_DIRECTORY_TABLE_NAME

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

    echo "Bootstrap validation failed: initial owner uses an email alias, but Cognito email_verified is not true." >&2
    exit 1
  fi

  echo "Bootstrap validation failed: initial owner username differs from email, but the user pool does not allow email as a username or alias." >&2
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
      echo "Bootstrap validation failed: Cognito app client ReadAttributes must include $required_attribute when explicitly configured." >&2
      exit 1
    fi
  done
}

assert_equal() {
  local actual="$1"
  local expected="$2"
  local description="$3"

  if [[ "$actual" != "$expected" ]]; then
    echo "Bootstrap validation failed: $description expected=$expected actual=$actual" >&2
    exit 1
  fi
}

assert_present() {
  local actual="$1"
  local description="$2"

  if [[ -z "$actual" || "$actual" == "None" ]]; then
    echo "Bootstrap validation failed: $description is missing" >&2
    exit 1
  fi
}

read_owner_attribute() {
  local attribute_name="$1"
  aws_call cognito-idp admin-get-user \
    --user-pool-id "$COGNITO_USER_POOL_ID" \
    --username "$INITIAL_OWNER_USERNAME" \
    --query "UserAttributes[?Name=='$attribute_name'].Value | [0]" \
    --output text
}

read_directory_attribute() {
  local entry_key="$1"
  local attribute_name="$2"
  aws_call dynamodb get-item \
    --table-name "$PROJECT_DIRECTORY_TABLE_NAME" \
    --consistent-read \
    --key "{\"directoryId\":{\"S\":\"$MUKUROJI_WORKSPACE_DIRECTORY_ID\"},\"entryKey\":{\"S\":\"$entry_key\"}}" \
    --query "Item.$attribute_name.S" \
    --output text
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
  echo "Bootstrap validation failed: Cognito app client has a client secret." >&2
  exit 1
fi

if [[ "$client_flows" != *"ALLOW_USER_PASSWORD_AUTH"* ]]; then
  if [[ -n "${AWS_ENDPOINT_URL:-}" && ( -z "$client_flows" || "$client_flows" == "None" ) ]]; then
    echo "Cognito emulator omitted ExplicitAuthFlows; verify USER_PASSWORD_AUTH with a login smoke test." >&2
  else
    echo "Bootstrap validation failed: Cognito app client does not allow ALLOW_USER_PASSWORD_AUTH." >&2
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

assert_equal "$owner_enabled" "True" "Cognito owner enabled state"
assert_equal "$owner_status" "CONFIRMED" "Cognito owner status"

assert_equal "$(read_owner_attribute 'email' | tr '[:upper:]' '[:lower:]')" "$NORMALIZED_OWNER_EMAIL" "Cognito owner email"
assert_equal "$(read_owner_attribute 'custom:directory_id')" "$MUKUROJI_WORKSPACE_DIRECTORY_ID" "Cognito custom:directory_id"
assert_equal "$(read_owner_attribute 'custom:workspace_id')" "$MUKUROJI_WORKSPACE_DIRECTORY_ID" "Cognito custom:workspace_id"

assert_equal "$(read_directory_attribute 'WORKSPACE#METADATA' 'entryType')" "workspace-metadata" "workspace metadata type"
assert_equal "$(read_directory_attribute 'WORKSPACE#METADATA' 'workspaceId')" "$MUKUROJI_WORKSPACE_DIRECTORY_ID" "workspace metadata ID"

owner_key="WORKSPACE_MEMBER#$NORMALIZED_OWNER_EMAIL"
assert_equal "$(read_directory_attribute "$owner_key" 'entryType')" "workspace-member" "workspace owner type"
assert_equal "$(read_directory_attribute "$owner_key" 'workspaceId')" "$MUKUROJI_WORKSPACE_DIRECTORY_ID" "workspace owner ID"
assert_equal "$(read_directory_attribute "$owner_key" 'memberKey')" "$NORMALIZED_OWNER_EMAIL" "workspace owner member key"
assert_equal "$(read_directory_attribute "$owner_key" 'email')" "$NORMALIZED_OWNER_EMAIL" "workspace owner email"
assert_equal "$(read_directory_attribute "$owner_key" 'username')" "$INITIAL_OWNER_USERNAME" "workspace owner username"
assert_equal "$(read_directory_attribute "$owner_key" 'role')" "owner" "workspace owner role"
assert_present "$(read_directory_attribute "$owner_key" 'createdAt')" "workspace owner createdAt"
assert_present "$(read_directory_attribute "$owner_key" 'updatedAt')" "workspace owner updatedAt"

alias_key="EMAIL_ALIAS#$NORMALIZED_OWNER_EMAIL"
assert_equal "$(read_directory_attribute "$alias_key" 'entryType')" "email-alias" "email alias type"
assert_equal "$(read_directory_attribute "$alias_key" 'workspaceId')" "$MUKUROJI_WORKSPACE_DIRECTORY_ID" "email alias workspace ID"
assert_equal "$(read_directory_attribute "$alias_key" 'memberKey')" "$NORMALIZED_OWNER_EMAIL" "email alias member key"
assert_equal "$(read_directory_attribute "$alias_key" 'email')" "$NORMALIZED_OWNER_EMAIL" "email alias"
assert_equal "$(read_directory_attribute "$alias_key" 'username')" "$INITIAL_OWNER_USERNAME" "email alias username"

for project_id in refero product-roadmap shared-launch brand-refresh; do
  project_member_key="PROJECT_MEMBER#$project_id#$NORMALIZED_OWNER_EMAIL"
  assert_equal "$(read_directory_attribute "$project_member_key" 'entryType')" "project-member" "initial owner project member type ($project_id)"
  assert_equal "$(read_directory_attribute "$project_member_key" 'memberKey')" "$NORMALIZED_OWNER_EMAIL" "initial owner project member key ($project_id)"
  assert_equal "$(read_directory_attribute "$project_member_key" 'role')" "manager" "initial owner project role ($project_id)"
  assert_present "$(read_directory_attribute "$project_member_key" 'createdAt')" "initial owner project createdAt ($project_id)"
  assert_present "$(read_directory_attribute "$project_member_key" 'updatedAt')" "initial owner project updatedAt ($project_id)"
done

echo "Workspace bootstrap OK: userPoolId=$COGNITO_USER_POOL_ID clientId=$COGNITO_USER_POOL_CLIENT_ID table=$PROJECT_DIRECTORY_TABLE_NAME workspaceDirectoryId=$MUKUROJI_WORKSPACE_DIRECTORY_ID owner=$NORMALIZED_OWNER_EMAIL"
