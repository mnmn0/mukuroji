import {
  CognitoIdentityProviderClient,
  DescribeUserPoolClientCommand,
  type DescribeUserPoolClientCommandOutput,
  DescribeUserPoolCommand,
  type DescribeUserPoolCommandOutput,
} from '@aws-sdk/client-cognito-identity-provider'

/**
 * User attributes the API trusts for authorization. A user's own access token must never be able
 * to rewrite them, because the API reads them from `GetUser` on every request.
 */
export const COGNITO_SELF_WRITE_PROTECTED_ATTRIBUTES = [
  'email',
  'email_verified',
  'custom:directory_id',
  'custom:workspace_id',
] as const

/**
 * The parts of a Cognito user pool and its password app client that decide whether a signed-in
 * user can rewrite their own authorization attributes or create an account.
 */
export interface CognitoPasswordClientContractInput {
  /** `UserPoolClient.WriteAttributes`. Absent or empty means Cognito's default, which is every writable attribute. */
  readonly writeAttributes?: readonly string[]
  /** `UserPool.AdminCreateUserConfig.AllowAdminCreateUserOnly`. */
  readonly allowAdminCreateUserOnly?: boolean
}

/**
 * Lists every way the password app client lets a user change who the API thinks they are.
 *
 * @param input - Pool and client settings read from Cognito.
 * @returns One human-readable violation per broken rule; empty when the contract holds.
 */
export function findCognitoPasswordClientContractViolations(
  input: CognitoPasswordClientContractInput,
): string[] {
  const violations: string[] = []
  const writeAttributes = input.writeAttributes ?? []

  if (writeAttributes.length === 0) {
    violations.push(
      'Cognito password app client must set WriteAttributes explicitly; the Cognito default lets users write email.',
    )
  } else {
    for (const attribute of COGNITO_SELF_WRITE_PROTECTED_ATTRIBUTES) {
      if (writeAttributes.includes(attribute)) {
        violations.push(`Cognito password app client WriteAttributes must not include ${attribute}.`)
      }
    }
  }

  if (input.allowAdminCreateUserOnly !== true) {
    violations.push('Cognito user pool must set AdminCreateUserConfig.AllowAdminCreateUserOnly to true.')
  }

  return violations
}

/**
 * CloudFormation Provider event for the Cognito client contract check.
 */
export interface CognitoClientContractEvent {
  /** Existing physical identifier supplied during update and delete requests. */
  readonly PhysicalResourceId?: string
  /** CloudFormation request operation. */
  readonly RequestType?: 'Create' | 'Delete' | 'Update'
  /** Properties supplied by the custom resource. */
  readonly ResourceProperties?: {
    /** User pool the API trusts. */
    readonly UserPoolId?: unknown
    /** Password app client the API uses. */
    readonly ClientId?: unknown
  }
}

/**
 * Minimal Cognito client contract used by the check.
 */
export interface CognitoClientContractClient {
  /**
   * Sends one read-only Cognito request.
   *
   * @param command - DescribeUserPool or DescribeUserPoolClient request.
   * @returns The matching Cognito response.
   */
  send(command: DescribeUserPoolCommand): Promise<DescribeUserPoolCommandOutput>
  send(command: DescribeUserPoolClientCommand): Promise<DescribeUserPoolClientCommandOutput>
}

/** Stable physical identifier retained across stack updates. */
const COGNITO_CLIENT_CONTRACT_PHYSICAL_ID = 'mukuroji-cognito-client-contract-v1'

/**
 * Fails the deploy when the trusted user pool or password client lets users rewrite the
 * attributes the API authorizes by.
 *
 * Delete requests skip the check so a superseded resource can always be removed.
 *
 * @param event - CloudFormation Provider event.
 * @returns Stable physical identifier.
 */
export async function onEventHandler(
  event: CognitoClientContractEvent,
): Promise<{ readonly PhysicalResourceId: string }> {
  return await checkCognitoClientContract(event, new CognitoIdentityProviderClient({}))
}

/**
 * Runs the contract check with an explicit Cognito boundary.
 *
 * @param event - CloudFormation Provider event.
 * @param client - Cognito client used for the read-only requests.
 * @returns Stable physical identifier.
 */
export async function checkCognitoClientContract(
  event: CognitoClientContractEvent,
  client: CognitoClientContractClient,
): Promise<{ readonly PhysicalResourceId: string }> {
  const physicalResourceId = event.PhysicalResourceId?.trim() || COGNITO_CLIENT_CONTRACT_PHYSICAL_ID
  if (event.RequestType === 'Delete') {
    return { PhysicalResourceId: physicalResourceId }
  }

  const userPoolId = readIdentifier(event.ResourceProperties?.UserPoolId, 'user pool ID')
  const clientId = readIdentifier(event.ResourceProperties?.ClientId, 'app client ID')
  const [pool, appClient] = await Promise.all([
    client.send(new DescribeUserPoolCommand({ UserPoolId: userPoolId })),
    client.send(new DescribeUserPoolClientCommand({ UserPoolId: userPoolId, ClientId: clientId })),
  ])
  const violations = findCognitoPasswordClientContractViolations({
    writeAttributes: appClient.UserPoolClient?.WriteAttributes,
    allowAdminCreateUserOnly: pool.UserPool?.AdminCreateUserConfig?.AllowAdminCreateUserOnly,
  })

  if (violations.length > 0) {
    throw new Error(violations.join(' '))
  }
  return { PhysicalResourceId: physicalResourceId }
}

/**
 * Validates a Cognito identifier supplied by the custom resource.
 *
 * @param candidate - Raw property value.
 * @param label - Name used in the error message.
 * @returns The identifier.
 */
function readIdentifier(candidate: unknown, label: string): string {
  if (typeof candidate !== 'string' || !/^[\w-]{1,128}$/.test(candidate)) {
    throw new TypeError(`Cognito ${label} is invalid.`)
  }
  return candidate
}
