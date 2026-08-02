import { randomBytes } from 'node:crypto'
import {
  DescribeTableCommand,
  type DescribeTableCommandOutput,
  DynamoDBClient,
} from '@aws-sdk/client-dynamodb'
import { isThrottlingError } from '@smithy/core/retry'
import {
  createWorkspaceSearchMigrationDescribeTableScopeBindingDigest,
  createWorkspaceSearchMigrationDescribeTableTransportBindingDigest,
  resolveWorkspaceSearchMigrationOfficialDynamoDbEndpoint,
} from './migration-describe-table-binding'

/** Exact AWS SDK attempt limit owned by the DescribeTable transport. */
export const WORKSPACE_SEARCH_MIGRATION_DESCRIBE_TABLE_SDK_MAX_ATTEMPTS = 1

/** Private constructor key preventing structural attempt construction. */
const singleAttemptConstructionKey = Symbol(
  'workspace-search-describe-table-single-attempt',
)

/** Private constructor key preventing reflected capability reconstruction. */
const describeTableCapabilityConstructionKey = Symbol(
  'workspace-search-describe-table-capability',
)

/**
 * Rejects construction outside the module's exact capability factories.
 *
 * @param constructionKey - Candidate module-private construction key.
 */
function requireDescribeTableCapabilityConstructionKey(
  constructionKey: unknown,
): void {
  if (constructionKey !== describeTableCapabilityConstructionKey) {
    throw new Error('Invalid DescribeTable capability construction.')
  }
}

/** Private controller identity never stored on an externally visible object. */
const describeTableAttemptExecutionAuthority = Object.freeze({})

/** Private authority for exact rate-lifecycle capability dispatch. */
const describeTableRateControllerAuthority = Object.freeze({})

/**
 * Rejects forged access to module-private rate capability dispatch.
 *
 * @param authority - Candidate module-private authority.
 */
function requireDescribeTableRateControllerAuthority(
  authority: unknown,
): void {
  if (authority !== describeTableRateControllerAuthority) {
    throw new WorkspaceSearchMigrationDescribeTableRateError(
      'invalid-lifecycle',
    )
  }
}

/** Logical DescribeTable calls in the proven non-terminal apply page baseline. */
export const WORKSPACE_SEARCH_MIGRATION_DESCRIBE_TABLE_PAGE_BASELINE_ATTEMPTS =
  182

/** Attempts reserved exclusively for one all-six cleanup reconciliation. */
export const WORKSPACE_SEARCH_MIGRATION_DESCRIBE_TABLE_CLEANUP_RECOVERY_ATTEMPTS =
  6

/** Version of the secret-free DescribeTable rate observation contract. */
export const WORKSPACE_SEARCH_MIGRATION_DESCRIBE_TABLE_RATE_OBSERVATION_VERSION =
  1

/** Version of the durable DescribeTable rate checkpoint contract. */
export const WORKSPACE_SEARCH_MIGRATION_DESCRIBE_TABLE_RATE_CHECKPOINT_VERSION =
  1

/**
 * Static AWS credentials pinned to the measured migration account.
 */
export type WorkspaceSearchMigrationDescribeTablePinnedAwsCredentials = {
  /** Access-key identifier copied into the dedicated SDK client. */
  readonly accessKeyId: string
  /** Secret access key copied into the dedicated SDK client. */
  readonly secretAccessKey: string
  /** Optional session token copied into the dedicated SDK client. */
  readonly sessionToken?: string
  /** Optional SigV4 credential scope copied into the dedicated SDK client. */
  readonly credentialScope?: string
  /** Upstream-measured account identifier declared for these credentials. */
  readonly accountId: string
  /** Optional credential expiration copied into a detached Date instance. */
  readonly expiration?: Date
}

/**
 * Refresh-capable provider pinned to one measured AWS account.
 *
 * @returns Fresh detached credentials declared for the measured account.
 */
export type WorkspaceSearchMigrationDescribeTablePinnedAwsCredentialsProvider =
  () => Promise<WorkspaceSearchMigrationDescribeTablePinnedAwsCredentials>

/**
 * Explicit pinned configuration accepted by the dedicated DescribeTable client.
 */
export type WorkspaceSearchMigrationDescribeTableAwsSdkConfiguration = {
  /** Upstream-measured account that must equal the credential declaration. */
  readonly account: string
  /** Static credentials or a refreshable provider pinned to the measured account. */
  readonly credentials:
    | WorkspaceSearchMigrationDescribeTablePinnedAwsCredentials
    | WorkspaceSearchMigrationDescribeTablePinnedAwsCredentialsProvider
  /** Explicit AWS region measured for the migration session. */
  readonly region: string
}

/**
 * Shallow-frozen detached configuration for one dedicated DynamoDB client.
 *
 * A static credential copy remains SDK-compatible and extensible because the
 * AWS SDK attaches identity metadata. A provider remains captured behind an
 * account-validating wrapper. Neither form is shared with caller input.
 */
export type WorkspaceSearchMigrationDescribeTableAwsSdkClientConfiguration = {
  /** SDK-owned credentials or provider matching the declared measured account. */
  readonly credentials:
    | WorkspaceSearchMigrationDescribeTablePinnedAwsCredentials
    | WorkspaceSearchMigrationDescribeTablePinnedAwsCredentialsProvider
  /** Internally derived partition-aware official DynamoDB endpoint. */
  readonly endpoint: string
  /** Transport-owned single-attempt limit. */
  readonly maxAttempts:
    typeof WORKSPACE_SEARCH_MIGRATION_DESCRIBE_TABLE_SDK_MAX_ATTEMPTS
  /** Explicit AWS region shared with the account/region rate ledger. */
  readonly region: string
}

/**
 * Dedicated low-level client capability retained behind the transport.
 */
interface WorkspaceSearchMigrationDescribeTableAwsSdkClient {
  /** Releases resources retained by the DynamoDB client. */
  destroy(): void

  /**
   * Sends exactly one SDK-managed DescribeTable attempt.
   *
   * @param command - Internally reconstructed read-only command.
   * @param signal - Rate-controller-owned cancellation signal.
   * @returns Raw DynamoDB table metadata response.
   */
  describeTable(
    command: DescribeTableCommand,
    signal: AbortSignal,
  ): Promise<DescribeTableCommandOutput>
}

/**
 * Nominal one-shot operation executable only by this module's rate controller.
 */
export class WorkspaceSearchMigrationDescribeTableSingleAttempt<Result> {
  /** Canonical account/region ledger binding hidden from reflection. */
  readonly #scopeBindingDigest: string

  /** Exact official-endpoint and retry binding hidden from reflection. */
  readonly #transportBindingDigest: string

  /** Exact physical callback hidden from reflection. */
  readonly #attempt: (signal: AbortSignal) => Promise<Result>

  /** Whether the genuine controller already consumed this operation. */
  #consumed = false

  /** Whether the genuine controller already invoked the physical callback. */
  #executed = false

  /**
   * Creates one operation only through a module-owned transport factory.
   *
   * @param constructionKey - Module-private construction capability.
   * @param scopeBindingDigest - Canonical account/region ledger binding.
   * @param transportBindingDigest - Exact fixed transport binding.
   * @param attempt - Exactly one physical transport callback.
   */
  constructor(
    constructionKey: symbol,
    scopeBindingDigest: string,
    transportBindingDigest: string,
    attempt: (signal: AbortSignal) => Promise<Result>,
  ) {
    if (constructionKey !== singleAttemptConstructionKey) {
      throw new Error('Invalid DescribeTable attempt construction.')
    }
    this.#scopeBindingDigest = scopeBindingDigest
    this.#transportBindingDigest = transportBindingDigest
    this.#attempt = attempt
    Object.freeze(this)
  }

  /**
   * Checks one operation's private controller and immutable bindings.
   *
   * @param authority - Module-private controller identity.
   * @param attempt - Nominal operation inspected without dynamic dispatch.
   * @param scopeBindingDigest - Expected canonical scope binding.
   * @param transportBindingDigest - Expected fixed transport binding.
   * @returns Whether authority and both bindings match.
   */
  static controllerMatchesBindings<Result>(
    authority: unknown,
    attempt: WorkspaceSearchMigrationDescribeTableSingleAttempt<Result>,
    scopeBindingDigest: string,
    transportBindingDigest: string,
  ): boolean {
    return authority === describeTableAttemptExecutionAuthority &&
      attempt.#scopeBindingDigest === scopeBindingDigest &&
      attempt.#transportBindingDigest === transportBindingDigest
  }

  /**
   * Claims one operation before durable budget consumption.
   *
   * @param authority - Module-private controller identity.
   * @param attempt - Nominal operation consumed without dynamic dispatch.
   * @returns True only for the first genuine controller claim.
   */
  static controllerConsume<Result>(
    authority: unknown,
    attempt: WorkspaceSearchMigrationDescribeTableSingleAttempt<Result>,
  ): boolean {
    if (
      authority !== describeTableAttemptExecutionAuthority ||
      attempt.#consumed
    ) {
      return false
    }
    attempt.#consumed = true
    return true
  }

  /**
   * Invokes one claimed exact physical callback once.
   *
   * @param authority - Module-private controller identity.
   * @param attempt - Nominal operation executed without dynamic dispatch.
   * @param signal - Rate-controller-owned cancellation signal.
   * @returns Untouched physical transport result.
   */
  static controllerExecute<Result>(
    authority: unknown,
    attempt: WorkspaceSearchMigrationDescribeTableSingleAttempt<Result>,
    signal: AbortSignal,
  ): Promise<Result> {
    if (
      authority !== describeTableAttemptExecutionAuthority ||
      !attempt.#consumed ||
      attempt.#executed
    ) {
      return Promise.reject(
        new Error('DescribeTable attempt is not executable.'),
      )
    }
    attempt.#executed = true
    return attempt.#attempt(signal)
  }
}

/** Exact controller matcher captured before callers can observe the class. */
const controllerMatchesDescribeTableAttempt =
  WorkspaceSearchMigrationDescribeTableSingleAttempt
    .controllerMatchesBindings

/** Exact controller consumer captured before callers can observe the class. */
const controllerConsumesDescribeTableAttempt =
  WorkspaceSearchMigrationDescribeTableSingleAttempt.controllerConsume

/** Exact controller executor captured before callers can observe the class. */
const controllerExecutesDescribeTableAttempt =
  WorkspaceSearchMigrationDescribeTableSingleAttempt.controllerExecute

Object.freeze(
  WorkspaceSearchMigrationDescribeTableSingleAttempt.prototype,
)
Object.freeze(WorkspaceSearchMigrationDescribeTableSingleAttempt)

/**
 * Narrow closeable AWS transport that constructs only DescribeTable attempts.
 */
export interface WorkspaceSearchMigrationDescribeTableSingleAttemptAwsTransport {
  /** Releases the dedicated DynamoDB client. */
  close(): void

  /**
   * Creates one controller-only operation for a validated table name.
   *
   * @param tableName - Untrusted DynamoDB table name.
   * @returns Nominal operation executable only by the rate controller.
   */
  createAttempt(
    tableName: string,
  ): WorkspaceSearchMigrationDescribeTableSingleAttempt<
    DescribeTableCommandOutput
  >
}

/**
 * AWS SDK implementation owning one dedicated DynamoDB client.
 */
class AwsSdkWorkspaceSearchMigrationDescribeTableSingleAttemptTransport
  implements WorkspaceSearchMigrationDescribeTableSingleAttemptAwsTransport {
  /** Dedicated client that exposes only DescribeTable. */
  readonly #client: WorkspaceSearchMigrationDescribeTableAwsSdkClient

  /** Canonical account/region ledger binding. */
  readonly #scopeBindingDigest: string

  /** Exact official-endpoint and retry contract binding. */
  readonly #transportBindingDigest: string

  /**
   * Retains the configured single-attempt client and immutable bindings.
   *
   * @param constructionKey - Module-private capability construction key.
   * @param client - Dedicated low-level DescribeTable client.
   * @param scopeBindingDigest - Canonical account/region binding.
   * @param transportBindingDigest - Exact fixed transport binding.
   */
  constructor(
    constructionKey: symbol,
    client: WorkspaceSearchMigrationDescribeTableAwsSdkClient,
    scopeBindingDigest: string,
    transportBindingDigest: string,
  ) {
    requireDescribeTableCapabilityConstructionKey(constructionKey)
    this.#client = client
    this.#scopeBindingDigest = scopeBindingDigest
    this.#transportBindingDigest = transportBindingDigest
    Object.freeze(this)
  }

  /** Releases the dedicated DynamoDB client. */
  close(): void {
    this.#client.destroy()
  }

  /**
   * Reconstructs one exact DescribeTable command from a table-name scalar.
   *
   * @param tableName - Untrusted DynamoDB table name.
   * @returns Controller-only nominal DescribeTable operation.
   */
  createAttempt(
    tableName: string,
  ): WorkspaceSearchMigrationDescribeTableSingleAttempt<
    DescribeTableCommandOutput
  > {
    const command = new DescribeTableCommand({
      TableName: detachAndValidateDescribeTableName(tableName),
    })
    return new WorkspaceSearchMigrationDescribeTableSingleAttempt(
      singleAttemptConstructionKey,
      this.#scopeBindingDigest,
      this.#transportBindingDigest,
      (signal) => this.#client.describeTable(command, signal),
    )
  }
}

/**
 * Low-level AWS SDK client exposing only the single DescribeTable operation.
 */
class DynamoDbWorkspaceSearchMigrationDescribeTableAwsSdkClient
  implements WorkspaceSearchMigrationDescribeTableAwsSdkClient {
  /** SDK client constructed with an exact one-attempt configuration. */
  readonly #client: DynamoDBClient

  /**
   * Creates the dedicated low-level client.
   *
   * @param constructionKey - Module-private capability construction key.
   * @param configuration - Allowlisted single-attempt SDK configuration.
   */
  constructor(
    constructionKey: symbol,
    configuration:
      WorkspaceSearchMigrationDescribeTableAwsSdkClientConfiguration,
  ) {
    requireDescribeTableCapabilityConstructionKey(constructionKey)
    this.#client = new DynamoDBClient(configuration)
    Object.freeze(this)
  }

  /** Releases resources retained by the SDK client. */
  destroy(): void {
    this.#client.destroy()
  }

  /**
   * Sends one exact command with the controller-owned signal.
   *
   * @param command - Internally reconstructed DescribeTable command.
   * @param signal - Rate-controller-owned cancellation signal.
   * @returns Raw DynamoDB table metadata response.
   */
  describeTable(
    command: DescribeTableCommand,
    signal: AbortSignal,
  ): Promise<DescribeTableCommandOutput> {
    return this.#client.send(command, { abortSignal: signal })
  }
}

Object.freeze(
  AwsSdkWorkspaceSearchMigrationDescribeTableSingleAttemptTransport
    .prototype,
)
Object.freeze(
  AwsSdkWorkspaceSearchMigrationDescribeTableSingleAttemptTransport,
)
Object.freeze(
  DynamoDbWorkspaceSearchMigrationDescribeTableAwsSdkClient.prototype,
)
Object.freeze(
  DynamoDbWorkspaceSearchMigrationDescribeTableAwsSdkClient,
)

/**
 * Creates a dedicated DescribeTable transport with SDK retries disabled.
 *
 * @param configuration - Explicit pinned AWS scope and credentials.
 * @returns Closeable transport producing controller-only operations.
 */
export function createWorkspaceSearchMigrationDescribeTableSingleAttemptAwsTransport(
  configuration: WorkspaceSearchMigrationDescribeTableAwsSdkConfiguration,
): WorkspaceSearchMigrationDescribeTableSingleAttemptAwsTransport {
  return createDescribeTableTransport(configuration)
}

/**
 * Reconstructs the allowlisted AWS SDK configuration owned by this transport.
 *
 * @param configuration - Explicit pinned AWS scope and credentials.
 * @returns Detached configuration with the official endpoint and one attempt.
 */
export function createWorkspaceSearchMigrationDescribeTableAwsSdkClientConfiguration(
  configuration: WorkspaceSearchMigrationDescribeTableAwsSdkConfiguration,
): WorkspaceSearchMigrationDescribeTableAwsSdkClientConfiguration {
  const snapshot =
    detachAndValidateDescribeTableAwsSdkConfiguration(configuration)
  return createDescribeTableAwsSdkClientConfigurationFromSnapshot(
    snapshot,
  )
}

/**
 * Builds the fixed client configuration from one already detached snapshot.
 *
 * @param snapshot - Validated configuration read from caller input once.
 * @returns Frozen official-endpoint and one-attempt SDK configuration.
 */
function createDescribeTableAwsSdkClientConfigurationFromSnapshot(
  snapshot: WorkspaceSearchMigrationDescribeTableAwsSdkConfiguration,
): WorkspaceSearchMigrationDescribeTableAwsSdkClientConfiguration {
  const { credentials: pinnedCredentials, region } = snapshot
  const credentials = typeof pinnedCredentials === 'function'
    ? pinnedCredentials
    : createDescribeTableAwsSdkCredentialsFromSnapshot(
      pinnedCredentials,
    )
  return Object.freeze({
    credentials,
    endpoint:
      resolveWorkspaceSearchMigrationOfficialDynamoDbEndpoint(region),
    maxAttempts:
      WORKSPACE_SEARCH_MIGRATION_DESCRIBE_TABLE_SDK_MAX_ATTEMPTS,
    region,
  })
}

/**
 * Creates an SDK-compatible credential copy from an immutable snapshot.
 *
 * The SDK may attach internal identity metadata to the object it receives, so
 * this outer copy remains extensible while every allowlisted value is detached.
 *
 * @param snapshot - Frozen validated static credential snapshot.
 * @returns Detached credentials owned exclusively by one SDK configuration.
 */
function createDescribeTableAwsSdkCredentialsFromSnapshot(
  snapshot: WorkspaceSearchMigrationDescribeTablePinnedAwsCredentials,
): WorkspaceSearchMigrationDescribeTablePinnedAwsCredentials {
  const {
    accessKeyId,
    accountId,
    credentialScope,
    expiration,
    secretAccessKey,
    sessionToken,
  } = snapshot
  return {
    accessKeyId,
    accountId,
    ...(credentialScope === undefined ? {} : { credentialScope }),
    ...(expiration === undefined
      ? {}
      : {
          expiration: Object.freeze(
            new Date(Date.prototype.getTime.call(expiration)),
          ),
        }),
    secretAccessKey,
    ...(sessionToken === undefined ? {} : { sessionToken }),
  }
}

/**
 * Validates one scope and constructs the exact concrete transport.
 *
 * @param configuration - Untrusted caller-owned configuration.
 * @returns Transport bound to canonical scope and fixed transport digests.
 */
function createDescribeTableTransport(
  configuration: WorkspaceSearchMigrationDescribeTableAwsSdkConfiguration,
): WorkspaceSearchMigrationDescribeTableSingleAttemptAwsTransport {
  const snapshot =
    detachAndValidateDescribeTableAwsSdkConfiguration(configuration)
  const { account, region } = snapshot
  const clientConfiguration =
    createDescribeTableAwsSdkClientConfigurationFromSnapshot(
      snapshot,
    )
  return new AwsSdkWorkspaceSearchMigrationDescribeTableSingleAttemptTransport(
    describeTableCapabilityConstructionKey,
    createDefaultDescribeTableClient(clientConfiguration),
    createWorkspaceSearchMigrationDescribeTableScopeBindingDigest(
      account,
      region,
    ),
    createWorkspaceSearchMigrationDescribeTableTransportBindingDigest(
      account,
      region,
      clientConfiguration.endpoint,
      WORKSPACE_SEARCH_MIGRATION_DESCRIBE_TABLE_SDK_MAX_ATTEMPTS,
    ),
  )
}

/**
 * Validates and detaches the transport scope without accepting retry controls.
 *
 * @param configuration - Untrusted caller-owned configuration.
 * @returns Exact account, credentials, and region accepted by the transport.
 */
function detachAndValidateDescribeTableAwsSdkConfiguration(
  configuration: WorkspaceSearchMigrationDescribeTableAwsSdkConfiguration,
): WorkspaceSearchMigrationDescribeTableAwsSdkConfiguration {
  let account: unknown
  let region: unknown
  try {
    account = configuration.account
    region = configuration.region
  } catch {
    throw new Error('Invalid DescribeTable transport scope.')
  }
  if (
    typeof account !== 'string' ||
    !/^\d{12}$/u.test(account) ||
    typeof region !== 'string' ||
    !/^[a-z0-9]+(?:-[a-z0-9]+)+$/u.test(region)
  ) {
    throw new Error('Invalid DescribeTable transport scope.')
  }
  let credentialInput: unknown
  try {
    credentialInput = configuration.credentials
  } catch {
    throw new Error('Invalid DescribeTable transport credentials.')
  }
  const credentials = detachAndValidateDescribeTableAwsCredentials(
    credentialInput,
    account,
  )
  return Object.freeze({ account, credentials, region })
}

/**
 * Captures static credentials or a refresh-capable provider and validates
 * every provider result against the measured account.
 *
 * @param credentials - Untrusted static credentials or provider.
 * @param expectedAccount - Account selected for the shared rate ledger.
 * @returns Detached static credentials or an account-validating provider.
 */
function detachAndValidateDescribeTableAwsCredentials(
  credentials: unknown,
  expectedAccount: string,
):
  | WorkspaceSearchMigrationDescribeTablePinnedAwsCredentials
  | WorkspaceSearchMigrationDescribeTablePinnedAwsCredentialsProvider {
  if (typeof credentials !== 'function') {
    return detachAndValidateDescribeTablePinnedAwsCredentials(
      credentials,
      expectedAccount,
    )
  }
  const provider = credentials
  const capturedProvider:
    WorkspaceSearchMigrationDescribeTablePinnedAwsCredentialsProvider =
      async () => {
        try {
          const resolved: unknown = await Reflect.apply(
            provider,
            undefined,
            [],
          )
          return createDescribeTableAwsSdkCredentialsFromSnapshot(
            detachAndValidateDescribeTablePinnedAwsCredentials(
              resolved,
              expectedAccount,
            ),
          )
        } catch {
          throw new Error('Invalid DescribeTable transport credentials.')
        }
      }
  return Object.freeze(capturedProvider)
}

/**
 * Copies allowlisted scalar credential fields into one immutable snapshot.
 *
 * @param credentials - Untrusted credential input that must be static data.
 * @param expectedAccount - Account selected for the shared rate ledger.
 * @returns Detached static credentials bound to the selected account.
 */
function detachAndValidateDescribeTablePinnedAwsCredentials(
  credentials: unknown,
  expectedAccount: string,
): WorkspaceSearchMigrationDescribeTablePinnedAwsCredentials {
  try {
    if (credentials === null || typeof credentials !== 'object') {
      throw new Error('invalid credential object')
    }
    const accessKeyId = readDescribeTableCredentialDataProperty(
      credentials,
      'accessKeyId',
    )
    const secretAccessKey = readDescribeTableCredentialDataProperty(
      credentials,
      'secretAccessKey',
    )
    const sessionToken = readDescribeTableCredentialDataProperty(
      credentials,
      'sessionToken',
    )
    const credentialScope = readDescribeTableCredentialDataProperty(
      credentials,
      'credentialScope',
    )
    const accountId = readDescribeTableCredentialDataProperty(
      credentials,
      'accountId',
    )
    const expiration = readDescribeTableCredentialDataProperty(
      credentials,
      'expiration',
    )
    if (
      typeof accessKeyId !== 'string' ||
      accessKeyId.length === 0 ||
      typeof secretAccessKey !== 'string' ||
      secretAccessKey.length === 0 ||
      (sessionToken !== undefined &&
        (typeof sessionToken !== 'string' || sessionToken.length === 0)) ||
      (credentialScope !== undefined &&
        (typeof credentialScope !== 'string' ||
          credentialScope.length === 0)) ||
      typeof accountId !== 'string' ||
      !/^\d{12}$/u.test(accountId) ||
      accountId !== expectedAccount ||
      (expiration !== undefined && !(expiration instanceof Date))
    ) {
      throw new Error('invalid credential fields')
    }
    let detachedExpiration: Date | undefined
    if (expiration !== undefined) {
      const expirationMilliseconds = Date.prototype.getTime.call(expiration)
      if (!Number.isFinite(expirationMilliseconds)) {
        throw new Error('invalid credential expiration')
      }
      detachedExpiration = Object.freeze(
        new Date(expirationMilliseconds),
      )
    }
    return Object.freeze({
      accessKeyId,
      accountId,
      ...(credentialScope === undefined ? {} : { credentialScope }),
      ...(detachedExpiration === undefined
        ? {}
        : { expiration: detachedExpiration }),
      secretAccessKey,
      ...(sessionToken === undefined ? {} : { sessionToken }),
    })
  } catch {
    throw new Error('Invalid DescribeTable transport credentials.')
  }
}

/**
 * Reads one own credential data property without invoking accessors.
 *
 * @param credentials - Static credential object being detached.
 * @param property - Allowlisted credential property name.
 * @returns The property's data value, or undefined when absent.
 */
function readDescribeTableCredentialDataProperty(
  credentials: object,
  property: keyof WorkspaceSearchMigrationDescribeTablePinnedAwsCredentials,
): unknown {
  const descriptor = Reflect.getOwnPropertyDescriptor(
    credentials,
    property,
  )
  if (descriptor === undefined) {
    return undefined
  }
  if (!('value' in descriptor)) {
    throw new Error('Invalid credential accessor.')
  }
  return descriptor.value
}

/**
 * Creates the production low-level client from the fixed configuration.
 *
 * @param configuration - Allowlisted single-attempt SDK configuration.
 * @returns Dedicated low-level DescribeTable client.
 */
function createDefaultDescribeTableClient(
  configuration:
    WorkspaceSearchMigrationDescribeTableAwsSdkClientConfiguration,
): WorkspaceSearchMigrationDescribeTableAwsSdkClient {
  return new DynamoDbWorkspaceSearchMigrationDescribeTableAwsSdkClient(
    describeTableCapabilityConstructionKey,
    configuration,
  )
}

/**
 * Validates the only caller-provided DescribeTable command scalar.
 *
 * @param tableName - Untrusted DynamoDB table name.
 * @returns Detached valid table name used to construct a fresh command.
 */
function detachAndValidateDescribeTableName(tableName: string): string {
  if (
    typeof tableName !== 'string' ||
    tableName.length < 3 ||
    tableName.length > 255 ||
    !/^[A-Za-z0-9_.-]+$/u.test(tableName)
  ) {
    throw new Error('Invalid DescribeTable table name.')
  }
  return tableName
}

/**
 * Explicit account/region rate policy reviewed for one migration invocation.
 */
export type WorkspaceSearchMigrationDescribeTableRatePolicy = {
  /** Lowercase SHA-256 digest of the reviewed policy document. */
  readonly policyVersion: string
  /** Maximum started attempts retained in one rolling window. */
  readonly maximumAttemptsPerWindow: number
  /** Maximum physical attempts consumed by this shared lifecycle ledger. */
  readonly maximumAttemptsPerLifecycle: number
  /** Reviewed physical-attempt reservation for every checkpoint page. */
  readonly checkpointPageAttemptCapacity: number
  /** Rolling-window duration in milliseconds. */
  readonly windowMilliseconds: number
  /** Minimum spacing between physical attempt starts. */
  readonly minimumAttemptIntervalMilliseconds: number
  /** Minimum spacing between checkpoint-page starts. */
  readonly minimumPageIntervalMilliseconds: number
  /** Maximum total wait allowed before a page or attempt must stop. */
  readonly maximumAdmissionWaitMilliseconds: number
  /** Initial throttle cooldown before jitter is applied. */
  readonly throttleBackoffInitialMilliseconds: number
  /** Maximum throttle cooldown before jitter is applied. */
  readonly throttleBackoffMaximumMilliseconds: number
}

/**
 * Finite phases that may issue one budgeted DescribeTable attempt.
 */
export type WorkspaceSearchMigrationDescribeTablePhase =
  | 'measurement'
  | 'checkpoint-page'
  | 'integrity-check'
  | 'pre-send-guard'
  | 'post-send-guard'
  | 'reconciliation'

/**
 * Stable reasons that stop work before another external operation starts.
 */
export type WorkspaceSearchMigrationDescribeTableRateStopReason =
  | 'budget-capacity'
  | 'cadence-bound'
  | 'interrupted'
  | 'invalid-lifecycle'
  | 'page-capacity'
  | 'quarantined'
  | 'throttled'
  | 'taken-over'

/**
 * Secret-free observation emitted at one DescribeTable rate boundary.
 */
export type WorkspaceSearchMigrationDescribeTableRateObservation =
  | {
    /** Contract version for downstream telemetry validation. */
    readonly version:
      typeof WORKSPACE_SEARCH_MIGRATION_DESCRIBE_TABLE_RATE_OBSERVATION_VERSION
    /** One physical attempt began after consuming a permit. */
    readonly kind: 'attempt'
    /** Finite semantic phase of the attempt. */
    readonly phase: WorkspaceSearchMigrationDescribeTablePhase
    /** Monotonic sequence within the account/region ledger. */
    readonly sequence: number
    /** Ledger-relative monotonic time supplied by the trusted clock. */
    readonly observedAtMilliseconds: number
    /** Normal-admission attempts left after protected cleanup headroom. */
    readonly remainingNormalAdmissionAttempts: number
    /** Physical permits remaining in the current rolling window. */
    readonly remainingWindowAttempts: number
    /** Reserved page permits remaining, or zero outside a page. */
    readonly remainingPageAttempts: number
    /** Physical attempts currently in flight for this scope. */
    readonly inFlight: 1
  }
  | {
    /** Contract version for downstream telemetry validation. */
    readonly version:
      typeof WORKSPACE_SEARCH_MIGRATION_DESCRIBE_TABLE_RATE_OBSERVATION_VERSION
    /** DynamoDB rejected one already consumed physical attempt. */
    readonly kind: 'throttle'
    /** Finite semantic phase of the throttled attempt. */
    readonly phase: WorkspaceSearchMigrationDescribeTablePhase
    /** Monotonic sequence of the consumed attempt. */
    readonly sequence: number
    /** Ledger-relative monotonic time supplied by the trusted clock. */
    readonly observedAtMilliseconds: number
    /** Bounded cooldown required before a later admission. */
    readonly backoffMilliseconds: number
  }
  | {
    /** Contract version for downstream telemetry validation. */
    readonly version:
      typeof WORKSPACE_SEARCH_MIGRATION_DESCRIBE_TABLE_RATE_OBSERVATION_VERSION
    /** Work stopped before a new external operation began. */
    readonly kind: 'budget-stop'
    /** Finite phase requesting the stopped operation. */
    readonly phase: WorkspaceSearchMigrationDescribeTablePhase
    /** Stable identifier-free stop classification. */
    readonly reason: WorkspaceSearchMigrationDescribeTableRateStopReason
    /** Ledger-relative monotonic time supplied by the trusted clock. */
    readonly observedAtMilliseconds: number
    /** Permits requested by the rejected admission. */
    readonly requiredAttempts: number
    /** Normal-admission attempts left after protected cleanup headroom. */
    readonly remainingNormalAdmissionAttempts: number
    /** Physical permits remaining in the current rolling window. */
    readonly remainingWindowAttempts: number
    /** Bounded delay after which a caller may explicitly resume. */
    readonly retryAfterMilliseconds: number
  }
  | {
    /** Contract version for downstream telemetry validation. */
    readonly version:
      typeof WORKSPACE_SEARCH_MIGRATION_DESCRIBE_TABLE_RATE_OBSERVATION_VERSION
    /** Admission waited without starting external I/O. */
    readonly kind: 'cadence-wait'
    /** Finite phase waiting for admission. */
    readonly phase: WorkspaceSearchMigrationDescribeTablePhase
    /** Ledger-relative monotonic time before the wait. */
    readonly observedAtMilliseconds: number
    /** Exact bounded delay supplied to the injected waiter. */
    readonly delayMilliseconds: number
  }

/**
 * Best-effort sink for secret-free rate observations.
 */
export interface WorkspaceSearchMigrationDescribeTableRateRecorder {
  /**
   * Records one already sanitized observation.
   *
   * @param observation - Fixed allowlisted event without resource identifiers.
   */
  record(
    observation: WorkspaceSearchMigrationDescribeTableRateObservation,
  ): void
}

/**
 * Injectable monotonic clock used by deterministic rate tests.
 */
export type WorkspaceSearchMigrationDescribeTableRateClock = () => number

/**
 * Injectable cancelable delay used by deterministic rate tests.
 */
export interface WorkspaceSearchMigrationDescribeTableRateWaiter {
  /**
   * Waits for the exact bounded duration or rejects after cancellation.
   *
   * @param delayMilliseconds - Non-negative validated delay.
   * @param signal - Cancellation signal for work not yet sent.
   */
  wait(delayMilliseconds: number, signal: AbortSignal): Promise<void>
}

/**
 * Cancelable handle for one admission deadline.
 */
export interface WorkspaceSearchMigrationDescribeTableRateDeadlineHandle {
  /**
   * Cancels the pending deadline callback.
   */
  cancel(): void
}

/**
 * Injectable deadline scheduler used while waiting on barriers and FIFO work.
 */
export interface WorkspaceSearchMigrationDescribeTableRateDeadlineScheduler {
  /**
   * Schedules one callback after the bounded admission duration.
   *
   * @param delayMilliseconds - Positive validated admission duration.
   * @param callback - Callback invoked when admission must stop.
   * @returns Cancelable pending deadline handle.
   */
  schedule(
    delayMilliseconds: number,
    callback: () => void,
  ): WorkspaceSearchMigrationDescribeTableRateDeadlineHandle
}

/**
 * Injectable bounded random source returning a value in the half-open [0, 1).
 */
export type WorkspaceSearchMigrationDescribeTableRateRandom = () => number

/**
 * Dependencies shared by every account/region ledger in one registry.
 */
export type CreateWorkspaceSearchMigrationDescribeTableRateRegistryInput = {
  /** Explicit reviewed policy; no AWS service quota is used as a default. */
  readonly policy: WorkspaceSearchMigrationDescribeTableRatePolicy
  /** Durable CAS store required before any DescribeTable data I/O. */
  readonly checkpointStore:
    WorkspaceSearchMigrationDescribeTableRateCheckpointStore
  /** Optional deterministic monotonic clock. */
  readonly clock?: WorkspaceSearchMigrationDescribeTableRateClock
  /** Optional deterministic Unix-epoch clock used only by checkpoints. */
  readonly epochClock?: WorkspaceSearchMigrationDescribeTableRateEpochClock
  /** Optional deterministic cancelable waiter. */
  readonly waiter?: WorkspaceSearchMigrationDescribeTableRateWaiter
  /** Optional deterministic scheduler for total admission deadlines. */
  readonly deadlineScheduler?:
    WorkspaceSearchMigrationDescribeTableRateDeadlineScheduler
  /** Optional deterministic jitter source. */
  readonly random?: WorkspaceSearchMigrationDescribeTableRateRandom
  /** Optional best-effort observation sink. */
  readonly recorder?: WorkspaceSearchMigrationDescribeTableRateRecorder
}

/**
 * Claim for one process owner without exposing owner or run identifiers.
 */
export type ClaimWorkspaceSearchMigrationDescribeTableRateLifecycleInput = {
  /** Exact twelve-digit AWS account owning the internal ledger scope. */
  readonly account: string
  /** Exact AWS region owning the internal ledger scope. */
  readonly region: string
  /** Durable lease fence; takeover requires a strictly greater value. */
  readonly fenceToken: number
  /** Whether an absent checkpoint may be atomically bootstrapped. */
  readonly bootstrap: boolean
  /** Explicit authority to recover a checkpoint left in mandatory cleanup. */
  readonly recoverInterruptedCleanup: boolean
  /** Explicit authority to reconcile an attempt with unknown completion. */
  readonly recoverInterruptedAttempt: boolean
  /** Optional cancellation that stops a not-yet-started fence mutation. */
  readonly signal?: AbortSignal
}

/**
 * Detached claim with its internally derived canonical durable scope key.
 */
type ValidatedRateLifecycleClaim =
  ClaimWorkspaceSearchMigrationDescribeTableRateLifecycleInput & {
    /** Canonical domain-separated account/region ledger key. */
    readonly scopeBindingDigest: string
    /** Fixed official-endpoint and retry contract binding. */
    readonly transportBindingDigest: string
  }

/**
 * Admission request for one complete checkpoint page.
 */
export type RunWorkspaceSearchMigrationDescribeTableCheckpointPageInput = {
  /** Optional cancellation for work not yet sent. */
  readonly signal?: AbortSignal
}

/**
 * Request for one physical DescribeTable attempt.
 */
export type RunWorkspaceSearchMigrationDescribeTableAttemptInput = {
  /** Finite phase used only for safe telemetry and cleanup semantics. */
  readonly phase: WorkspaceSearchMigrationDescribeTablePhase
  /** Optional cancellation for work not yet sent. */
  readonly signal?: AbortSignal
}

/**
 * Secret-free aggregate suitable for non-production rehearsal evidence.
 *
 * Attempt observations, rather than conservative charged counters, establish
 * actual physical start times and observed request rate.
 */
export type WorkspaceSearchMigrationDescribeTableRateEvidence = {
  /** Contract version shared with event observations. */
  readonly version:
    typeof WORKSPACE_SEARCH_MIGRATION_DESCRIBE_TABLE_RATE_OBSERVATION_VERSION
  /** Stable reviewed policy version. */
  readonly policyVersion: string
  /** Conservatively charged attempts staged in the write-ahead ledger. */
  readonly attemptCount: number
  /** Conservatively consumed permits recovered from interrupted pages. */
  readonly forfeitedAttemptCount: number
  /** Count of attempts classified as throttled. */
  readonly throttleCount: number
  /** Count of distinct fail-closed admission stops. */
  readonly budgetStopCount: number
  /** Count of waits performed before external I/O. */
  readonly cadenceWaitCount: number
  /** Sum of requested delays, including waits canceled before full expiry. */
  readonly cadenceWaitMilliseconds: number
  /** Maximum charged in-flight episode count, conservatively zero or one. */
  readonly maximumInFlight: 0 | 1
}

/**
 * Injectable Unix-epoch clock used only for durable checkpoint metadata.
 */
export type WorkspaceSearchMigrationDescribeTableRateEpochClock = () => number

/**
 * Durable write-ahead checkpoint for one opaque account/region binding.
 */
export type WorkspaceSearchMigrationDescribeTableRateCheckpoint = {
  /** Version of the exact checkpoint parser. */
  readonly version:
    typeof WORKSPACE_SEARCH_MIGRATION_DESCRIBE_TABLE_RATE_CHECKPOINT_VERSION
  /** Internally derived policy-independent account/region binding. */
  readonly scopeBindingDigest: string
  /** Fixed official-endpoint and one-attempt transport binding. */
  readonly transportBindingDigest: string
  /** Complete reviewed policy bound to this ledger. */
  readonly policy: WorkspaceSearchMigrationDescribeTableRatePolicy
  /** Monotonic CAS revision within the durable ledger. */
  readonly revision: number
  /** Durable lease fence that wrote this revision. */
  readonly fenceToken: number
  /** Cryptographically unique nonce identifying this exact CAS operation. */
  readonly writeNonce: string
  /** Informational Unix-epoch capture time, never used to shorten cooldown. */
  readonly capturedAtEpochMilliseconds: number
  /** Physical attempts durably charged before their one-shot transport. */
  readonly attemptCount: number
  /** Interrupted page reservations permanently charged on recovery. */
  readonly forfeitedAttemptCount: number
  /** Unused permits retained by the currently active page reservation. */
  readonly reservedAttempts: number
  /** Whether the checkpoint retains an uncertain active page reservation. */
  readonly reservationKind: 'none' | 'checkpoint-page'
  /** Whether a durably staged cleanup boundary needs reconciliation. */
  readonly mandatoryCleanupRequired: boolean
  /** Whether one charged attempt episode has not durably completed. */
  readonly attemptInFlight: boolean
  /** Exact charged-attempt episode, or null when none needs reconciliation. */
  readonly attemptInFlightNonce: string | null
  /** Monotonic charged-attempt sequence; start events identify physical calls. */
  readonly sequence: number
  /** Count of attempts classified as throttled. */
  readonly throttleCount: number
  /** Count of distinct fail-closed admission stops. */
  readonly budgetStopCount: number
  /** Count of cadence-delay requests started. */
  readonly cadenceWaitCount: number
  /** Aggregate requested delay, including an early-canceled final wait. */
  readonly cadenceWaitMilliseconds: number
  /** Maximum charged in-flight episode count, conservatively zero or one. */
  readonly maximumInFlight: 0 | 1
}

/**
 * Exact-predecessor durable checkpoint CAS request.
 */
export type WorkspaceSearchMigrationDescribeTableRateCheckpointWrite = {
  /** Opaque key used by the store without account or region identifiers. */
  readonly scopeBindingDigest: string
  /** Exact prior revision, or null only for atomic bootstrap. */
  readonly expectedRevision: number | null
  /** Detached successor checkpoint. */
  readonly checkpoint: WorkspaceSearchMigrationDescribeTableRateCheckpoint
}

/**
 * Durable store used for write-ahead reservation and fenced takeover.
 */
export interface WorkspaceSearchMigrationDescribeTableRateCheckpointStore {
  /**
   * Reads the current opaque checkpoint value.
   *
   * @param scopeBindingDigest - Opaque configured scope binding.
   * @returns Untrusted stored value, or undefined when absent.
   */
  load(scopeBindingDigest: string): Promise<unknown | undefined>

  /**
   * Atomically stores one exact-predecessor successor.
   *
   * The store must also reject a successor fence lower than the current fence.
   *
   * @param write - Opaque scope key, exact revision, and successor value.
   * @returns Stored on success or conflict when the predecessor changed.
   */
  compareAndSwap(
    write: WorkspaceSearchMigrationDescribeTableRateCheckpointWrite,
  ): Promise<'stored' | 'conflict'>
}

/**
 * Page-owned execution surface that keeps reservation accounting private.
 */
export interface WorkspaceSearchMigrationDescribeTableCheckpointPage {
  /**
   * Runs one exact physical SDK attempt under the page reservation.
   *
   * @param input - Finite phase and optional pre-send cancellation.
   * @param attempt - Nominal one-shot attempt from the dedicated transport.
   * @returns The untouched successful transport result.
   */
  runDescribeTableAttempt<Result>(
    input: RunWorkspaceSearchMigrationDescribeTableAttemptInput,
    attempt: WorkspaceSearchMigrationDescribeTableSingleAttempt<Result>,
  ): Promise<Result>

  /**
   * Runs mandatory response-loss or post-send guards as exclusive cleanup.
   *
   * The caller must enter this boundary immediately before an irreversible
   * send and keep the send plus all mandatory post-send guards inside it. Once
   * this callback starts, operator interruption or a higher-fence claim is
   * deferred until it finishes. This does not bypass adapter-owned generation
   * or incarnation checks.
   *
   * @param task - Already required post-send cleanup using its isolated surface.
   * @returns Cleanup result after all nested budgeted attempts finish.
   */
  runMandatoryCleanup<Result>(
    task: (
      cleanup:
        WorkspaceSearchMigrationDescribeTableMandatoryCleanup,
    ) => Promise<Result>,
  ): Promise<Result>
}

/**
 * Cleanup-only execution surface immune to a deferred lifecycle transition.
 */
export interface WorkspaceSearchMigrationDescribeTableMandatoryCleanup {
  /**
   * Records that an outer synchronous guard rejected before data mutation.
   *
   * This boundary is used only when a stronger lease or supervision guard
   * throws before `beginDataMutation` can authorize the irreversible send.
   */
  rejectDataMutationBeforeStart(): void

  /**
   * Marks the exact synchronous boundary immediately before one data mutation.
   *
   * A lifecycle transition deferred while the cleanup marker was being stored
   * rejects here and allows the untouched marker to be cleared safely.
   */
  beginDataMutation(): void

  /**
   * Runs one exact physical attempt already required by mandatory cleanup.
   *
   * @param input - Finite cleanup phase and optional pre-send cancellation.
   * @param attempt - Nominal one-shot attempt from the dedicated transport.
   * @returns The untouched successful transport result.
   */
  runDescribeTableAttempt<Result>(
    input: RunWorkspaceSearchMigrationDescribeTableAttemptInput,
    attempt: WorkspaceSearchMigrationDescribeTableSingleAttempt<Result>,
  ): Promise<Result>
}

/**
 * One fenced lifecycle over an account/region shared rate ledger.
 */
export interface WorkspaceSearchMigrationDescribeTableRateLifecycle {
  /**
   * Reserves capacity before invoking a checkpoint page callback.
   *
   * @param input - Optional cancellation for the policy-sized page.
   * @param task - Page work invoked only after admission succeeds.
   * @returns Page result after unused permits have been released.
   */
  runCheckpointPage<Result>(
    input: RunWorkspaceSearchMigrationDescribeTableCheckpointPageInput,
    task: (
      page: WorkspaceSearchMigrationDescribeTableCheckpointPage,
    ) => Promise<Result>,
  ): Promise<Result>

  /**
   * Runs one non-page DescribeTable attempt under the same shared ledger.
   *
   * @param input - Finite phase and optional pre-send cancellation.
   * @param attempt - Nominal one-shot attempt with SDK retries disabled.
   * @returns The untouched successful transport result.
   */
  runDescribeTableAttempt<Result>(
    input: RunWorkspaceSearchMigrationDescribeTableAttemptInput,
    attempt: WorkspaceSearchMigrationDescribeTableSingleAttempt<Result>,
  ): Promise<Result>

  /**
   * Reconciles a durable mandatory-cleanup marker after an authorized claim.
   *
   * The marker remains durable until the callback succeeds and the exact
   * successor CAS is confirmed.
   *
   * @param task - Recovery work using the cleanup-only attempt surface.
   * @returns Recovery result after the marker is durably cleared.
   */
  recoverInterruptedCleanup<Result>(
    task: (
      cleanup:
        WorkspaceSearchMigrationDescribeTableMandatoryCleanup,
    ) => Promise<Result>,
  ): Promise<Result>

  /**
   * Reconciles one charged attempt whose prior completion is unknown.
   *
   * No new DescribeTable attempt is admitted until this callback succeeds and
   * the in-flight marker is durably cleared.
   *
   * @param task - Operator-authorized proof that the prior owner cannot send.
   * @returns Recovery result after the marker is durably cleared.
   */
  recoverInterruptedAttempt<Result>(
    task: () => Promise<Result>,
  ): Promise<Result>

  /**
   * Interrupts queued or cadence-waiting work without refunding sent attempts.
   */
  interrupt(): void

  /**
   * Resumes the same fence after an explicit interruption.
   */
  resume(): void

  /**
   * Permanently quarantines this handle until a higher-fence claim is created.
   */
  quarantine(): void

  /**
   * Permanently closes this handle.
   */
  close(): void

  /**
   * Reads the last durably stored checkpoint only while the scope is quiescent.
   *
   * @returns Detached durable checkpoint with opaque binding digests.
   */
  readCheckpoint(): WorkspaceSearchMigrationDescribeTableRateCheckpoint

  /**
   * Reads identifier-free aggregate evidence from the shared ledger.
   *
   * Actual physical starts remain represented by attempt observations.
   *
   * @returns Detached conservative counters without account or region.
   */
  readEvidence(): WorkspaceSearchMigrationDescribeTableRateEvidence
}

/**
 * Process-shared registry enforcing one ledger for each account/region pair.
 */
export interface WorkspaceSearchMigrationDescribeTableRateRegistry {
  /**
   * Durably claims one scope or takes it over with a greater fence.
   *
   * @param input - Internal scope, opaque binding, fence, and bootstrap mode.
   * @returns Fenced lifecycle sharing retained rate history.
   */
  claim(
    input: ClaimWorkspaceSearchMigrationDescribeTableRateLifecycleInput,
  ): Promise<WorkspaceSearchMigrationDescribeTableRateLifecycle>
}

/**
 * Stable identifier-free rate failure returned before unsafe continuation.
 */
export class WorkspaceSearchMigrationDescribeTableRateError extends Error {
  /** Stable machine-readable failure code. */
  readonly code = 'DESCRIBE_TABLE_RATE_STOP'

  /** Stable identifier-free stop reason. */
  readonly reason: WorkspaceSearchMigrationDescribeTableRateStopReason

  /**
   * Creates one fixed-message rate failure.
   *
   * @param reason - Stable allowlisted reason.
   */
  constructor(reason: WorkspaceSearchMigrationDescribeTableRateStopReason) {
    super(`Workspace Search migration DescribeTable stopped (${reason}).`)
    this.name = 'WorkspaceSearchMigrationDescribeTableRateError'
    this.reason = reason
  }
}

/**
 * Mutable counters retained only inside one account/region ledger.
 */
type RateEvidenceState = {
  /** Attempts conservatively charged before possible physical execution. */
  attemptCount: number
  /** Conservatively charged permits recovered from interrupted pages. */
  forfeitedAttemptCount: number
  /** Throttled physical attempts. */
  throttleCount: number
  /** Distinct fail-closed stops. */
  budgetStopCount: number
  /** Admission delay requests started. */
  cadenceWaitCount: number
  /** Aggregate requested admission delay. */
  cadenceWaitMilliseconds: number
  /** Maximum conservatively charged in-flight episode count. */
  maximumInFlight: 0 | 1
}

/**
 * Account/region state shared across interruption, resume, and takeover.
 */
type RateScopeState = {
  /** Opaque binding used by the durable checkpoint store. */
  readonly scopeBindingDigest: string
  /** Fixed transport contract required by every physical operation. */
  readonly transportBindingDigest: string
  /** Last successfully stored checkpoint revision. */
  checkpointRevision: number | null
  /** Last exact checkpoint confirmed by the durable store. */
  lastCheckpoint:
    WorkspaceSearchMigrationDescribeTableRateCheckpoint | undefined
  /** Started attempt timestamps still relevant to the rolling window. */
  readonly attemptStarts: number[]
  /** Permits reserved by the active checkpoint page. */
  reservedAttempts: number
  /** Durable marker requiring successful mandatory-cleanup reconciliation. */
  mandatoryCleanupRequired: boolean
  /** Durable marker for a charged attempt whose completion is not confirmed. */
  attemptInFlight: boolean
  /** Exact durable episode nonce for the charged in-flight attempt. */
  attemptInFlightNonce: string | null
  /** Process-local owner of the durable in-flight attempt marker. */
  attemptOwner: DescribeTableRateLifecycle | undefined
  /** Episode staged as complete but not yet confirmed by durable CAS. */
  attemptCompletionPendingNonce: string | null
  /** Last physical attempt start, when one exists. */
  lastAttemptStartedAt: number | undefined
  /** Last admitted checkpoint-page start, when one exists. */
  lastPageStartedAt: number | undefined
  /** Earliest admission after a throttle. */
  resumeNotBefore: number
  /** Conservative full safety horizon required after durable recovery. */
  coldStartNotBefore: number
  /** Consecutive throttle stops used for bounded exponential backoff. */
  consecutiveThrottles: number
  /** Monotonic attempt sequence. */
  sequence: number
  /** Greatest clock value accepted by this scope. */
  lastObservedAt: number | undefined
  /** Signature suppressing repeated stop observations while still paused. */
  lastBudgetStopSignature: string | undefined
  /** Identifier-free aggregate evidence. */
  readonly evidence: RateEvidenceState
  /** Promise tail serializing every physical attempt for this scope. */
  tail: Promise<void>
  /** Process-local generation invalidating detached operation continuations. */
  operationGeneration: number
  /** Promise tail serializing every durable checkpoint mutation. */
  checkpointTail: Promise<void>
  /** Queued or active attempt operations, used by quiescent snapshots. */
  pendingAttemptCount: number
  /** Queued or active page admissions, used by quiescent snapshots. */
  pendingPageAdmissionCount: number
  /** Lifecycle currently owning a checkpoint page. */
  pageOwner: DescribeTableRateLifecycle | undefined
  /** Process-local ownership token for the current page reservation. */
  pageReservationToken: object | undefined
  /** Barrier completed when the current checkpoint page releases its permits. */
  pageBarrier: Promise<void>
  /** Resolver for the current checkpoint-page barrier. */
  releasePageBarrier: (() => void) | undefined
  /** Lifecycle currently completing mandatory post-send cleanup. */
  cleanupOwner: DescribeTableRateLifecycle | undefined
  /** Barrier completed when mandatory cleanup releases the scope. */
  cleanupBarrier: Promise<void>
  /** Resolver for the current mandatory-cleanup barrier. */
  releaseCleanupBarrier: (() => void) | undefined
  /** Current fenced lifecycle, when claimed. */
  current: DescribeTableRateLifecycle | undefined
}

/**
 * Validated immutable dependencies owned by one registry.
 */
type RateRegistryDependencies = {
  /** Detached explicit policy. */
  readonly policy: WorkspaceSearchMigrationDescribeTableRatePolicy
  /** Required durable exact-predecessor checkpoint store. */
  readonly checkpointStore:
    WorkspaceSearchMigrationDescribeTableRateCheckpointStore
  /** Validated monotonic clock. */
  readonly clock: WorkspaceSearchMigrationDescribeTableRateClock
  /** Validated Unix-epoch clock for checkpoint metadata only. */
  readonly epochClock: WorkspaceSearchMigrationDescribeTableRateEpochClock
  /** Cancelable bounded waiter. */
  readonly waiter: WorkspaceSearchMigrationDescribeTableRateWaiter
  /** Cancelable deadline spanning barriers, FIFO, and cadence waits. */
  readonly deadlineScheduler:
    WorkspaceSearchMigrationDescribeTableRateDeadlineScheduler
  /** Validated jitter source. */
  readonly random: WorkspaceSearchMigrationDescribeTableRateRandom
  /** Optional best-effort recorder. */
  readonly recorder: WorkspaceSearchMigrationDescribeTableRateRecorder | undefined
}

/**
 * One total admission deadline created before any barrier or FIFO wait.
 */
type RateAdmissionDeadline = {
  /** Absolute trusted-clock boundary used by computed cadence waits. */
  readonly expiresAtMilliseconds: number
  /** Settles when the injected scheduler reaches the total wait bound. */
  readonly expiration: Promise<void>
  /** Cancellation source used to stop a pending injected cadence waiter. */
  readonly signal: AbortSignal
  /** Cancels the scheduler after admission or final rejection. */
  readonly cancel: () => void
}

/**
 * Explicit recovery permissions captured by one durable fence claim.
 */
type RateRecoveryAuthority = {
  /** Whether this owner may reconcile mandatory cleanup. */
  interruptedCleanup: boolean
  /** Whether this owner may reconcile an uncertain physical attempt. */
  interruptedAttempt: boolean
}

/**
 * Result of racing one admission wait against cancellation and its deadline.
 */
type RateAdmissionBoundaryOutcome =
  | 'completed'
  | 'deadline'
  | 'interrupted'

/**
 * Creates an explicit process-shared DescribeTable rate registry.
 *
 * @param input - Reviewed policy and optional deterministic dependencies.
 * @returns Registry with isolated account/region ledgers.
 */
export function createWorkspaceSearchMigrationDescribeTableRateRegistry(
  input: CreateWorkspaceSearchMigrationDescribeTableRateRegistryInput,
): WorkspaceSearchMigrationDescribeTableRateRegistry {
  const dependencies = createRegistryDependencies(input)
  const scopes = new Map<string, RateScopeState>()
  const claimTails = new Map<string, Promise<void>>()
  return {
    claim: async (
      claimInput: ClaimWorkspaceSearchMigrationDescribeTableRateLifecycleInput,
    ): Promise<WorkspaceSearchMigrationDescribeTableRateLifecycle> => {
      const claim = detachAndValidateClaim(claimInput)
      const key = `${claim.account}\u0000${claim.region}`
      const predecessor = claimTails.get(key) ?? Promise.resolve()
      let release = (): void => {}
      const ownTurn = new Promise<void>((resolve) => {
        release = resolve
      })
      claimTails.set(key, ownTurn)
      let predecessorCompleted = false
      try {
        await waitForRateRegistryBoundary(
          predecessor,
          dependencies,
        )
        predecessorCompleted = true
        return await claimDescribeTableRateLifecycle(
          claim,
          key,
          scopes,
          dependencies,
        )
      } finally {
        if (predecessorCompleted) {
          release()
        } else {
          void predecessor.then(release, release)
        }
        void ownTurn.then(() => {
          if (claimTails.get(key) === ownTurn) {
            claimTails.delete(key)
          }
        })
      }
    },
  }
}

/**
 * Bounds registry claim serialization, durable loads, and takeover barriers.
 *
 * @param boundary - Promise that must settle before claim work may continue.
 * @param dependencies - Validated scheduler and finite admission policy.
 * @returns Exact boundary result.
 */
async function waitForRateRegistryBoundary<Result>(
  boundary: Promise<Result>,
  dependencies: RateRegistryDependencies,
): Promise<Result> {
  const startedAtMilliseconds = readInitialRateClock(
    dependencies.clock,
  )
  const expiresAtMilliseconds =
    startedAtMilliseconds +
    dependencies.policy.maximumAdmissionWaitMilliseconds
  if (!Number.isSafeInteger(expiresAtMilliseconds)) {
    throw new WorkspaceSearchMigrationDescribeTableRateError(
      'invalid-lifecycle',
    )
  }
  let resolveDeadline = (): void => {}
  const deadline = new Promise<void>((resolve) => {
    resolveDeadline = resolve
  })
  let handle:
    WorkspaceSearchMigrationDescribeTableRateDeadlineHandle | undefined
  try {
    handle = dependencies.deadlineScheduler.schedule(
      dependencies.policy.maximumAdmissionWaitMilliseconds,
      resolveDeadline,
    )
  } catch {
    throw new WorkspaceSearchMigrationDescribeTableRateError(
      'invalid-lifecycle',
    )
  }
  const outcome = await Promise.race([
    boundary.then(
      (
        value,
      ): { readonly kind: 'completed'; readonly value: Result } => ({
        kind: 'completed',
        value,
      }),
      (
        error: unknown,
      ): { readonly kind: 'failed'; readonly error: unknown } => ({
        kind: 'failed',
        error,
      }),
    ),
    deadline.then(
      (): { readonly kind: 'deadline' } => ({
        kind: 'deadline',
      }),
    ),
  ])
  try {
    handle.cancel()
  } catch {
    // Deadline cleanup cannot make a completed durable boundary unsafe.
  }
  if (outcome.kind === 'completed') {
    if (
      readInitialRateClock(dependencies.clock) >=
        expiresAtMilliseconds
    ) {
      throw new WorkspaceSearchMigrationDescribeTableRateError(
        'cadence-bound',
      )
    }
    return outcome.value
  }
  if (outcome.kind === 'failed') throw outcome.error
  throw new WorkspaceSearchMigrationDescribeTableRateError(
    'cadence-bound',
  )
}

/**
 * Loads, fences, and durably stores one serialized scope claim.
 *
 * @param claim - Detached validated claim with canonical bindings.
 * @param key - Process-local exact account/region lookup key.
 * @param scopes - Process-local account/region states.
 * @param dependencies - Validated registry dependencies.
 * @returns Durably fenced lifecycle.
 */
async function claimDescribeTableRateLifecycle(
  claim: ValidatedRateLifecycleClaim,
  key: string,
  scopes: Map<string, RateScopeState>,
  dependencies: RateRegistryDependencies,
): Promise<WorkspaceSearchMigrationDescribeTableRateLifecycle> {
  requireRateClaimSignalActive(claim.signal)
  let scope = scopes.get(key)
  if (scope === undefined) {
    let stored: unknown | undefined
    try {
      stored = await waitForRateRegistryBoundary(
        dependencies.checkpointStore.load(
          claim.scopeBindingDigest,
        ),
        dependencies,
      )
    } catch (error: unknown) {
      if (
        error instanceof
          WorkspaceSearchMigrationDescribeTableRateError
      ) {
        throw error
      }
      throw new WorkspaceSearchMigrationDescribeTableRateError(
        'invalid-lifecycle',
      )
    }
    requireRateClaimSignalActive(claim.signal)
    if (stored === undefined) {
      if (!claim.bootstrap) {
        throw new WorkspaceSearchMigrationDescribeTableRateError(
          'invalid-lifecycle',
        )
      }
      scope = createFreshRateScopeState(
        claim.scopeBindingDigest,
        claim.transportBindingDigest,
        dependencies,
      )
    } else {
      if (claim.bootstrap) {
        throw new WorkspaceSearchMigrationDescribeTableRateError(
          'invalid-lifecycle',
        )
      }
      const checkpoint = parseRateCheckpoint(
        stored,
        claim.scopeBindingDigest,
        dependencies.policy,
        claim.transportBindingDigest,
      )
      if (
        claim.fenceToken <= checkpoint.fenceToken ||
        checkpoint.mandatoryCleanupRequired !==
          claim.recoverInterruptedCleanup ||
        checkpoint.attemptInFlight !==
          claim.recoverInterruptedAttempt
      ) {
        throw new WorkspaceSearchMigrationDescribeTableRateError(
          'invalid-lifecycle',
        )
      }
      scope = createRestoredRateScopeState(
        checkpoint,
        dependencies,
      )
    }
  } else {
    if (
      claim.bootstrap ||
      claim.scopeBindingDigest !== scope.scopeBindingDigest ||
      claim.transportBindingDigest !== scope.transportBindingDigest
    ) {
      throw new WorkspaceSearchMigrationDescribeTableRateError(
        'invalid-lifecycle',
      )
    }
    if (scope.attemptCompletionPendingNonce !== null) {
      await waitForRateRegistryBoundary(
        scope.checkpointTail,
        dependencies,
      )
      requireRateClaimSignalActive(claim.signal)
      if (scope.attemptCompletionPendingNonce !== null) {
        throw new WorkspaceSearchMigrationDescribeTableRateError(
          'invalid-lifecycle',
        )
      }
    }
    const current = scope.current
    if (
      current === undefined ||
      claim.fenceToken <= readDescribeTableRateLifecycleFence(
        describeTableRateControllerAuthority,
        current,
      )
    ) {
      throw new WorkspaceSearchMigrationDescribeTableRateError(
        'invalid-lifecycle',
      )
    }
    requestDescribeTableRateLifecycleTakeover(
      describeTableRateControllerAuthority,
      current,
    )
    if (scope.pageOwner !== undefined) {
      scope.pageReservationToken = undefined
    }
    if (scope.cleanupOwner !== undefined) {
      await waitForRateRegistryBoundary(
        scope.cleanupBarrier,
        dependencies,
      )
      requireRateClaimSignalActive(claim.signal)
    }
    if (scope.pageOwner !== undefined) {
      await waitForRateRegistryBoundary(
        scope.pageBarrier,
        dependencies,
      )
      requireRateClaimSignalActive(claim.signal)
    }
    if (
      scope.mandatoryCleanupRequired !==
        claim.recoverInterruptedCleanup ||
      scope.attemptInFlight !==
        claim.recoverInterruptedAttempt
    ) {
      throw new WorkspaceSearchMigrationDescribeTableRateError(
        'invalid-lifecycle',
      )
    }
    if (
      scope.mandatoryCleanupRequired ||
      scope.attemptInFlight ||
      (
        scope.reservedAttempts > 0 &&
        scope.pageOwner === undefined
      )
    ) {
      prepareLocalRateScopeForInterruptedRecovery(
        scope,
        dependencies,
      )
    }
  }
  requireRateClaimSignalActive(claim.signal)
  const lifecycle = new DescribeTableRateLifecycle(
    describeTableCapabilityConstructionKey,
    claim.fenceToken,
    scope,
    dependencies,
    {
      interruptedCleanup: claim.recoverInterruptedCleanup,
      interruptedAttempt: claim.recoverInterruptedAttempt,
    },
  )
  scope.current = lifecycle
  try {
    await persistDescribeTableRateLifecycleFenceClaim(
      describeTableRateControllerAuthority,
      lifecycle,
      claim.signal,
    )
  } catch (error: unknown) {
    scopes.delete(key)
    throw error
  }
  scopes.set(key, scope)
  return lifecycle
}

/**
 * Private implementation retaining fenced state and page reservations.
 */
class DescribeTableRateLifecycle
  implements WorkspaceSearchMigrationDescribeTableRateLifecycle {
  /** Durable fence captured by this handle. */
  readonly #fenceToken: number

  /** Shared account/region rate state. */
  readonly #scope: RateScopeState

  /** Shared validated registry dependencies. */
  readonly #dependencies: RateRegistryDependencies

  /** Process-local operation generation owned by this lifecycle. */
  #operationGeneration: number

  /** Current lifecycle state. */
  #status:
    | 'active'
    | 'interrupted'
    | 'quarantined'
    | 'closed'
    | 'taken-over' = 'active'

  /** Cancellation source replaced only by same-fence resume. */
  #abortController = new AbortController()

  /** Mandatory cleanup depth that defers interruption and takeover. */
  #cleanupDepth = 0

  /** Deferred status applied after already-started cleanup finishes. */
  #deferredStatus:
    | 'interrupted'
    | 'quarantined'
    | 'closed'
    | 'taken-over'
    | undefined

  /** Whether this handle currently owns one page reservation. */
  #pageActive = false

  /** Whether this handle is currently waiting to admit a page. */
  #pageAdmissionPending = false

  /** Whether durable checkpoint state became ambiguous or conflicted. */
  #durabilityFailed = false

  /** Explicit recovery permissions captured by this fence claim. */
  readonly #recoveryAuthority: RateRecoveryAuthority

  /** Unforgeable process-local token scoped to the active cleanup callback. */
  #activeCleanupToken: object | undefined

  /** Whether this lifecycle is already reconciling one interrupted attempt. */
  #attemptRecoveryActive = false

  /**
   * Creates one lifecycle over an existing scope ledger.
   *
   * @param constructionKey - Module-private capability construction key.
   * @param fenceToken - Durable takeover fence.
   * @param scope - Shared account/region ledger.
   * @param dependencies - Validated registry dependencies.
   * @param recoveryAuthority - Explicit permissions for durable recovery.
   */
  constructor(
    constructionKey: symbol,
    fenceToken: number,
    scope: RateScopeState,
    dependencies: RateRegistryDependencies,
    recoveryAuthority: RateRecoveryAuthority,
  ) {
    requireDescribeTableCapabilityConstructionKey(constructionKey)
    this.#fenceToken = fenceToken
    this.#scope = scope
    this.#dependencies = dependencies
    this.#operationGeneration = scope.operationGeneration
    this.#recoveryAuthority = recoveryAuthority
    Object.freeze(this)
  }

  /**
   * Reads the private fence for exact registry takeover comparison.
   *
   * @param authority - Module-private rate-controller authority.
   * @param lifecycle - Exact lifecycle inspected without dynamic dispatch.
   * @returns Durable non-negative fence token.
   */
  static controllerReadFenceToken(
    authority: unknown,
    lifecycle: DescribeTableRateLifecycle,
  ): number {
    requireDescribeTableRateControllerAuthority(authority)
    return lifecycle.#fenceToken
  }

  /**
   * Invalidates one handle after a higher-fence registry claim.
   *
   * @param authority - Module-private rate-controller authority.
   * @param lifecycle - Exact lifecycle invalidated without dynamic dispatch.
   */
  static controllerRequestTakeover(
    authority: unknown,
    lifecycle: DescribeTableRateLifecycle,
  ): void {
    requireDescribeTableRateControllerAuthority(authority)
    lifecycle.#transitionTo('taken-over')
  }

  /**
   * Persists one fence before the registry exposes its lifecycle.
   *
   * @param authority - Module-private rate-controller authority.
   * @param lifecycle - Exact lifecycle persisted without dynamic dispatch.
   * @param signal - Optional cancellation before the claim CAS starts.
   */
  static async controllerPersistFenceClaim(
    authority: unknown,
    lifecycle: DescribeTableRateLifecycle,
    signal: AbortSignal | undefined,
  ): Promise<void> {
    requireDescribeTableRateControllerAuthority(authority)
    const deadline = lifecycle.#createAdmissionDeadline()
    try {
      await lifecycle.#persistRateCheckpoint(
        'measurement',
        signal ?? new AbortController().signal,
        deadline,
      )
    } finally {
      deadline.cancel()
    }
  }

  /**
   * Runs one exact attempt through a private lifecycle implementation.
   *
   * @param authority - Module-private rate-controller authority.
   * @param lifecycle - Exact lifecycle used without dynamic dispatch.
   * @param input - Validated attempt request source.
   * @param attempt - Nominal one-shot transport operation.
   * @param page - Active page capability, when applicable.
   * @param cleanupToken - Active cleanup authorization, when applicable.
   * @param cleanup - Active cleanup capacity, when applicable.
   * @returns Untouched transport result.
   */
  static controllerRunAttempt<Result>(
    authority: unknown,
    lifecycle: DescribeTableRateLifecycle,
    input: RunWorkspaceSearchMigrationDescribeTableAttemptInput,
    attempt: WorkspaceSearchMigrationDescribeTableSingleAttempt<Result>,
    page: DescribeTableCheckpointPage | undefined,
    cleanupToken: object | undefined,
    cleanup: DescribeTableMandatoryCleanup | undefined,
  ): Promise<Result> {
    requireDescribeTableRateControllerAuthority(authority)
    return lifecycle.#runAttempt(
      input,
      attempt,
      page,
      cleanupToken,
      cleanup,
    )
  }

  /**
   * Runs mandatory cleanup through a private lifecycle implementation.
   *
   * @param authority - Module-private rate-controller authority.
   * @param lifecycle - Exact lifecycle used without dynamic dispatch.
   * @param task - Mandatory cleanup callback.
   * @param page - Active page owning the cleanup.
   * @returns Cleanup result after durable reconciliation.
   */
  static controllerRunMandatoryCleanup<Result>(
    authority: unknown,
    lifecycle: DescribeTableRateLifecycle,
    task: (
      cleanup:
        WorkspaceSearchMigrationDescribeTableMandatoryCleanup,
    ) => Promise<Result>,
    page: DescribeTableCheckpointPage,
  ): Promise<Result> {
    requireDescribeTableRateControllerAuthority(authority)
    return lifecycle.#runMandatoryCleanup(task, page)
  }

  /**
   * Authorizes the exact synchronous boundary before cleanup data mutation.
   *
   * @param authority - Module-private rate-controller authority.
   * @param lifecycle - Exact lifecycle retaining the cleanup barrier.
   * @param cleanupToken - Exact active cleanup authorization.
   */
  static controllerBeginCleanupDataMutation(
    authority: unknown,
    lifecycle: DescribeTableRateLifecycle,
    cleanupToken: object,
  ): void {
    requireDescribeTableRateControllerAuthority(authority)
    lifecycle.#requireCurrentOperationGeneration()
    if (
      lifecycle.#cleanupDepth <= 0 ||
      lifecycle.#activeCleanupToken !== cleanupToken
    ) {
      throw new WorkspaceSearchMigrationDescribeTableRateError(
        'invalid-lifecycle',
      )
    }
    const deferredStatus = lifecycle.#deferredStatus
    if (deferredStatus !== undefined) {
      const reason: WorkspaceSearchMigrationDescribeTableRateStopReason =
        deferredStatus === 'interrupted'
          ? 'interrupted'
          : deferredStatus === 'quarantined'
            ? 'quarantined'
            : deferredStatus === 'taken-over'
              ? 'taken-over'
              : 'invalid-lifecycle'
      return lifecycle.#stop('post-send-guard', reason, 0, 0)
    }
    lifecycle.#requireActive('post-send-guard', cleanupToken)
  }

  /**
   * Reserves one complete page before its first external operation.
   */
  async runCheckpointPage<Result>(
    input: RunWorkspaceSearchMigrationDescribeTableCheckpointPageInput,
    task: (
      page: WorkspaceSearchMigrationDescribeTableCheckpointPage,
    ) => Promise<Result>,
  ): Promise<Result> {
    const request = detachCheckpointPageInput(input)
    const attemptCapacity =
      this.#dependencies.policy.checkpointPageAttemptCapacity
    if (
      attemptCapacity >
        this.#dependencies.policy.maximumAttemptsPerLifecycle ||
      this.#pageActive ||
      this.#pageAdmissionPending
    ) {
      return this.#stop(
        'checkpoint-page',
        'page-capacity',
        attemptCapacity,
        0,
      )
    }
    this.#requireActive('checkpoint-page')
    if (
      this.#attemptRecoveryActive ||
      this.#scope.attemptCompletionPendingNonce !== null ||
      this.#scope.mandatoryCleanupRequired ||
      this.#scope.attemptInFlight
    ) {
      return this.#stop(
        'checkpoint-page',
        'invalid-lifecycle',
        attemptCapacity,
        0,
      )
    }
    const linkedSignal = createLinkedAbortSignal(
      this.#abortController.signal,
      request.signal,
    )
    const deadline = this.#createAdmissionDeadline()
    this.#pageAdmissionPending = true
    this.#scope.pendingPageAdmissionCount += 1
    let page: DescribeTableCheckpointPage | undefined
    let pageReservationPersisted = false
    let pageReservationRequiresRecovery = false
    let pageCallbackSettledWithPendingAttempts = false
    try {
      await this.#waitForExclusiveScope(
        linkedSignal.signal,
        'checkpoint-page',
        deadline,
        attemptCapacity,
      )
      await this.#withScopeSingleFlight(
        async () => {
          this.#requireActive('checkpoint-page')
          if (
            this.#attemptRecoveryActive ||
            this.#scope.attemptCompletionPendingNonce !== null ||
            this.#scope.mandatoryCleanupRequired ||
            this.#scope.attemptInFlight ||
            this.#scope.pageOwner !== undefined
          ) {
            return this.#stop(
              'checkpoint-page',
              'invalid-lifecycle',
              attemptCapacity,
              0,
            )
          }
          await this.#waitForPageAdmission(
            attemptCapacity,
            linkedSignal.signal,
            deadline,
          )
          this.#requireActive('checkpoint-page')
          if (deadline.signal.aborted) {
            return this.#stop(
              'checkpoint-page',
              'cadence-bound',
              attemptCapacity,
              0,
            )
          }
          const reservationAdmittedAt = this.#readClock()
          this.#pruneWindow(reservationAdmittedAt)
          if (
            this.#scope.pageOwner !== undefined ||
            this.#scope.attemptInFlight ||
            this.#readRemainingLifecycleAttempts() < attemptCapacity
          ) {
            return this.#stop(
              'checkpoint-page',
              'budget-capacity',
              attemptCapacity,
              0,
            )
          }
          this.#scope.reservedAttempts += attemptCapacity
          this.#pageActive = true
          this.#pageAdmissionPending = false
          const pageReservationToken = Object.freeze({})
          this.#acquirePageBarrier(pageReservationToken)
          page = new DescribeTableCheckpointPage(
            describeTableCapabilityConstructionKey,
            this,
            attemptCapacity,
            pageReservationToken,
          )
          try {
            await this.#persistRateCheckpoint(
              'checkpoint-page',
              linkedSignal.signal,
              deadline,
            )
            pageReservationPersisted = true
          } catch (error: unknown) {
            pageReservationRequiresRecovery = true
            this.#transitionTo('quarantined')
            throw error
          }
        },
        linkedSignal.signal,
        'checkpoint-page',
        deadline,
        undefined,
        attemptCapacity,
      )
      if (page === undefined) {
        return this.#stop(
          'checkpoint-page',
          'invalid-lifecycle',
          attemptCapacity,
          0,
        )
      }
      deadline.cancel()
      try {
        const pageStartedAt = this.#readClock()
        if (
          deadline.signal.aborted ||
          pageStartedAt >= deadline.expiresAtMilliseconds
        ) {
          return this.#stop(
            'checkpoint-page',
            'cadence-bound',
            attemptCapacity,
            0,
          )
        }
        this.#requireActive('checkpoint-page')
        if (linkedSignal.signal.aborted) {
          return this.#stop(
            'checkpoint-page',
            'interrupted',
            attemptCapacity,
            0,
          )
        }
        this.#scope.lastPageStartedAt = pageStartedAt
        this.#scope.lastBudgetStopSignature = undefined
      } catch (error: unknown) {
        pageReservationRequiresRecovery = true
        this.#transitionTo('quarantined')
        throw error
      }
      let taskOutcome:
        | { readonly kind: 'success'; readonly value: Result }
        | { readonly kind: 'failure'; readonly error: unknown }
      try {
        taskOutcome = {
          kind: 'success',
          value: await task(page),
        }
      } catch (error: unknown) {
        taskOutcome = { kind: 'failure', error }
      }
      closeDescribeTableCheckpointPageForNewOperations(
        describeTableRateControllerAuthority,
        page,
      )
      pageCallbackSettledWithPendingAttempts =
        hasDescribeTableCheckpointPagePendingOperations(
          describeTableRateControllerAuthority,
          page,
        )
      await waitForDescribeTableCheckpointPagePendingOperations(
        describeTableRateControllerAuthority,
        page,
      )
      if (pageCallbackSettledWithPendingAttempts) {
        this.#transitionTo('quarantined')
      }
      if (taskOutcome.kind === 'failure') {
        throw taskOutcome.error
      }
      if (pageCallbackSettledWithPendingAttempts) {
        return this.#stop(
          'checkpoint-page',
          'quarantined',
          0,
          0,
        )
      }
      this.#applyDeferredStatus()
      this.#requireActive('checkpoint-page')
      return taskOutcome.value
    } finally {
      deadline.cancel()
      linkedSignal.dispose()
      this.#pageAdmissionPending = false
      if (
        this.#operationGeneration ===
          this.#scope.operationGeneration
      ) {
        this.#scope.pendingPageAdmissionCount -= 1
      }
      if (page !== undefined) {
        const unusedAttempts =
          releaseDescribeTableCheckpointPageUnusedAttempts(
            describeTableRateControllerAuthority,
            page,
          )
        const ownsReservation =
          matchesDescribeTableCheckpointPageReservationToken(
            describeTableRateControllerAuthority,
            page,
          this.#scope.pageReservationToken,
          )
        const retainDurableReservation =
          this.#scope.mandatoryCleanupRequired ||
          this.#scope.attemptInFlight ||
          pageReservationRequiresRecovery ||
          pageCallbackSettledWithPendingAttempts ||
          !pageReservationPersisted ||
          !ownsReservation
        const releasedUnusedAttempts =
          !retainDurableReservation &&
          ownsReservation &&
          unusedAttempts > 0
        if (releasedUnusedAttempts) {
          this.#scope.reservedAttempts -= unusedAttempts
        }
        let unusedReleaseConfirmed = false
        try {
          if (releasedUnusedAttempts) {
            await this.#persistRateCheckpointWithNewDeadline(
              'checkpoint-page',
              this.#scope.pageReservationToken,
            )
            unusedReleaseConfirmed = true
          }
        } finally {
          if (
            releasedUnusedAttempts &&
            !unusedReleaseConfirmed
          ) {
            this.#scope.reservedAttempts += unusedAttempts
          }
          this.#pageActive = false
          this.#releasePageBarrier()
        }
      }
      this.#applyDeferredStatus()
    }
  }

  /**
   * Runs one non-page physical attempt under the shared ledger.
   */
  runDescribeTableAttempt<Result>(
    input: RunWorkspaceSearchMigrationDescribeTableAttemptInput,
    attempt: WorkspaceSearchMigrationDescribeTableSingleAttempt<Result>,
  ): Promise<Result> {
    return this.#runAttempt(
      input,
      attempt,
      undefined,
      undefined,
      undefined,
    )
  }

  /**
   * Interrupts unsent work while preserving consumed rate history.
   */
  interrupt(): void {
    this.#transitionTo('interrupted')
  }

  /**
   * Resumes only this same interrupted fence.
   */
  resume(): void {
    if (
      this.#status !== 'interrupted' ||
      this.#scope.current !== this ||
      this.#pageActive ||
      this.#pageAdmissionPending ||
      this.#cleanupDepth > 0
    ) {
      throw new WorkspaceSearchMigrationDescribeTableRateError(
        'invalid-lifecycle',
      )
    }
    this.#status = 'active'
    this.#abortController = new AbortController()
  }

  /**
   * Permanently quarantines this handle.
   */
  quarantine(): void {
    this.#transitionTo('quarantined')
  }

  /**
   * Permanently closes this handle.
   */
  close(): void {
    this.#transitionTo('closed')
  }

  /**
   * Reads the last durable checkpoint only with no pending scope work.
   */
  readCheckpoint(): WorkspaceSearchMigrationDescribeTableRateCheckpoint {
    if (
      this.#scope.current !== this ||
      this.#pageActive ||
      this.#pageAdmissionPending ||
      this.#cleanupDepth > 0 ||
      this.#scope.pendingAttemptCount > 0 ||
      this.#scope.pendingPageAdmissionCount > 0 ||
      this.#scope.pageOwner !== undefined ||
      this.#scope.cleanupOwner !== undefined ||
      this.#attemptRecoveryActive ||
      this.#scope.attemptCompletionPendingNonce !== null
    ) {
      throw new WorkspaceSearchMigrationDescribeTableRateError(
        'invalid-lifecycle',
      )
    }
    const checkpoint = this.#scope.lastCheckpoint
    if (checkpoint === undefined) {
      throw new WorkspaceSearchMigrationDescribeTableRateError(
        'invalid-lifecycle',
      )
    }
    return detachRateCheckpoint(checkpoint)
  }

  /**
   * Reads detached identifier-free evidence.
   */
  readEvidence(): WorkspaceSearchMigrationDescribeTableRateEvidence {
    const evidence = this.#scope.evidence
    return {
      version:
        WORKSPACE_SEARCH_MIGRATION_DESCRIBE_TABLE_RATE_OBSERVATION_VERSION,
      policyVersion: this.#dependencies.policy.policyVersion,
      attemptCount: evidence.attemptCount,
      forfeitedAttemptCount: evidence.forfeitedAttemptCount,
      throttleCount: evidence.throttleCount,
      budgetStopCount: evidence.budgetStopCount,
      cadenceWaitCount: evidence.cadenceWaitCount,
      cadenceWaitMilliseconds: evidence.cadenceWaitMilliseconds,
      maximumInFlight: evidence.maximumInFlight,
    }
  }

  /**
   * Runs one page-owned attempt and consumes its reservation.
   *
   * @param input - Finite phase and optional signal.
   * @param attempt - Exactly one physical transport attempt.
   * @param page - Active page reservation, when applicable.
   * @param cleanupToken - Exact cleanup-only capability token, when applicable.
   * @param cleanup - Active cleanup capacity, when applicable.
   * @returns Successful raw transport result.
   */
  async #runAttempt<Result>(
    input: RunWorkspaceSearchMigrationDescribeTableAttemptInput,
    attempt: WorkspaceSearchMigrationDescribeTableSingleAttempt<Result>,
    page: DescribeTableCheckpointPage | undefined,
    cleanupToken: object | undefined,
    cleanup: DescribeTableMandatoryCleanup | undefined,
  ): Promise<Result> {
    const request = detachAndValidateAttemptInput(input)
    if (
      !(attempt instanceof
        WorkspaceSearchMigrationDescribeTableSingleAttempt) ||
      !controllerMatchesDescribeTableAttempt(
        describeTableAttemptExecutionAuthority,
        attempt,
        this.#scope.scopeBindingDigest,
        this.#scope.transportBindingDigest,
      )
    ) {
      return this.#stop(
        request.phase,
        'invalid-lifecycle',
        1,
        0,
      )
    }
    const cleanupAuthorized =
      cleanupToken !== undefined &&
      cleanupToken === this.#activeCleanupToken
    this.#requireActive(request.phase, cleanupToken)
    if (
      this.#attemptRecoveryActive ||
      this.#scope.attemptCompletionPendingNonce !== null ||
      (
        this.#scope.mandatoryCleanupRequired &&
        !cleanupAuthorized
      ) ||
      (
        this.#scope.attemptInFlight &&
        this.#scope.attemptOwner !== this
      )
    ) {
      return this.#stop(
        request.phase,
        'invalid-lifecycle',
        1,
        0,
      )
    }
    const linkedSignal = cleanupAuthorized
      ? createUncancelledSignal()
      : createLinkedAbortSignal(
        this.#abortController.signal,
        request.signal,
      )
    const deadline = this.#createAdmissionDeadline()
    this.#scope.pendingAttemptCount += 1
    try {
      await this.#waitForExclusiveScope(
        linkedSignal.signal,
        request.phase,
        deadline,
        1,
        page !== undefined,
        cleanupToken,
      )
      return await this.#withScopeSingleFlight(async () => {
        this.#requireActive(request.phase, cleanupToken)
        if (
          (
            this.#scope.cleanupOwner !== undefined &&
            this.#scope.cleanupOwner !== this
          ) ||
          (
            this.#scope.pageOwner !== undefined &&
            (
              this.#scope.pageOwner !== this ||
              page === undefined
            )
          )
        ) {
          return this.#stop(
            request.phase,
            'invalid-lifecycle',
            1,
            0,
          )
        }
        if (
          this.#attemptRecoveryActive ||
          this.#scope.attemptCompletionPendingNonce !== null ||
          this.#scope.attemptInFlight ||
          (
            this.#scope.mandatoryCleanupRequired &&
            !cleanupAuthorized
          )
        ) {
          return this.#stop(
            request.phase,
            'invalid-lifecycle',
            1,
            0,
          )
        }
        if (linkedSignal.signal.aborted) {
          return this.#stop(request.phase, 'interrupted', 1, 0)
        }
        await this.#waitForAttemptAdmission(
          request.phase,
          linkedSignal.signal,
          page,
          deadline,
          cleanupToken,
          cleanupAuthorized && page === undefined,
        )
        this.#requireActive(request.phase, cleanupToken)
        if (linkedSignal.signal.aborted) {
          return this.#stop(request.phase, 'interrupted', 1, 0)
        }
        if (deadline.signal.aborted) {
          return this.#stop(request.phase, 'cadence-bound', 1, 0)
        }
        if (
          cleanup !== undefined &&
          !hasDescribeTableMandatoryCleanupRemaining(
            describeTableRateControllerAuthority,
            cleanup,
          )
        ) {
          return this.#stop(
            request.phase,
            'budget-capacity',
            1,
            0,
          )
        }
        if (
          !controllerConsumesDescribeTableAttempt(
            describeTableAttemptExecutionAuthority,
            attempt,
          )
        ) {
          return this.#stop(
            request.phase,
            'invalid-lifecycle',
            1,
            0,
          )
        }
        if (page === undefined) {
          if (
            this.#readRemainingLifecycleAttempts(
              cleanupAuthorized,
            ) < 1 ||
            this.#readAvailableWindowAttempts() < 1
          ) {
            return this.#stop(
              request.phase,
              'budget-capacity',
              1,
              0,
            )
          }
        } else {
          consumeDescribeTableCheckpointPageAttempt(
            describeTableRateControllerAuthority,
            page,
          )
          this.#scope.reservedAttempts -= 1
        }
        if (cleanup !== undefined) {
          consumeDescribeTableMandatoryCleanupAttempt(
            describeTableRateControllerAuthority,
            cleanup,
          )
        }
        this.#scope.sequence += 1
        this.#scope.evidence.attemptCount += 1
        this.#scope.evidence.maximumInFlight = 1
        this.#scope.attemptInFlight = true
        const attemptInFlightNonce = randomBytes(32).toString('hex')
        this.#scope.attemptInFlightNonce = attemptInFlightNonce
        this.#scope.attemptOwner = this
        const sequence = this.#scope.sequence
        await this.#persistRateCheckpoint(
          request.phase,
          linkedSignal.signal,
          deadline,
          cleanupToken,
        )
        deadline.cancel()
        const attemptStartedAt = this.#readClock()
        if (
          deadline.signal.aborted ||
          attemptStartedAt >= deadline.expiresAtMilliseconds
        ) {
          return this.#stop(
            request.phase,
            'cadence-bound',
            0,
            0,
          )
        }
        this.#requireActive(request.phase, cleanupToken)
        if (linkedSignal.signal.aborted) {
          return this.#stop(request.phase, 'interrupted', 0, 0)
        }
        this.#pruneWindow(attemptStartedAt)
        this.#scope.attemptStarts.push(attemptStartedAt)
        this.#scope.lastAttemptStartedAt = attemptStartedAt
        this.#scope.lastBudgetStopSignature = undefined
        const attemptObservation:
          WorkspaceSearchMigrationDescribeTableRateObservation = {
            version:
              WORKSPACE_SEARCH_MIGRATION_DESCRIBE_TABLE_RATE_OBSERVATION_VERSION,
            kind: 'attempt',
            phase: request.phase,
            sequence,
            observedAtMilliseconds: attemptStartedAt,
            remainingNormalAdmissionAttempts:
              this.#readRemainingLifecycleAttempts(),
            remainingWindowAttempts:
              this.#readAvailableWindowAttempts(),
            remainingPageAttempts:
              page === undefined
                ? 0
                : readDescribeTableCheckpointPageRemainingAttempts(
                  describeTableRateControllerAuthority,
                  page,
                ),
            inFlight: 1,
          }
        let result: Result
        try {
          let execution: Promise<Result>
          try {
            execution = controllerExecutesDescribeTableAttempt(
              describeTableAttemptExecutionAuthority,
              attempt,
              linkedSignal.signal,
            )
          } catch (error: unknown) {
            this.#record(attemptObservation)
            throw error
          }
          this.#record(attemptObservation)
          result = await execution
        } catch (error: unknown) {
          this.#requireCurrentOperationGeneration()
          if (isSafeThrottlingError(error)) {
            this.#scope.evidence.throttleCount += 1
            this.#scope.consecutiveThrottles += 1
            const observedAt = this.#readClock()
            const backoffMilliseconds = this.#createThrottleBackoff()
            this.#scope.resumeNotBefore = Math.max(
              this.#scope.resumeNotBefore,
              observedAt + backoffMilliseconds,
            )
            await this.#persistAttemptEpisodeCompletion(
              request.phase,
              attemptInFlightNonce,
              this,
              cleanupToken,
            )
            this.#record({
              version:
                WORKSPACE_SEARCH_MIGRATION_DESCRIBE_TABLE_RATE_OBSERVATION_VERSION,
              kind: 'throttle',
              phase: request.phase,
              sequence,
              observedAtMilliseconds: observedAt,
              backoffMilliseconds,
            })
            return this.#stop(
              request.phase,
              'throttled',
              0,
              backoffMilliseconds,
            )
          }
          await this.#persistAttemptEpisodeCompletion(
            request.phase,
            attemptInFlightNonce,
            this,
            cleanupToken,
          )
          if (!cleanupAuthorized) {
            this.#requireActive(request.phase, cleanupToken)
            if (linkedSignal.signal.aborted) {
              return this.#stop(
                request.phase,
                'interrupted',
                0,
                0,
              )
            }
          }
          this.#scope.consecutiveThrottles = 0
          throw error
        }
        this.#requireCurrentOperationGeneration()
        await this.#persistAttemptEpisodeCompletion(
          request.phase,
          attemptInFlightNonce,
          this,
          cleanupToken,
        )
        this.#scope.consecutiveThrottles = 0
        if (!cleanupAuthorized) {
          this.#requireActive(request.phase, cleanupToken)
          if (linkedSignal.signal.aborted) {
            return this.#stop(request.phase, 'interrupted', 0, 0)
          }
        }
        return result
      }, linkedSignal.signal, request.phase, deadline, cleanupToken)
    } finally {
      if (
        this.#operationGeneration ===
          this.#scope.operationGeneration
      ) {
        this.#scope.pendingAttemptCount -= 1
      }
      deadline.cancel()
      linkedSignal.dispose()
    }
  }

  /**
   * Stages and durably clears one exact completed physical-attempt episode.
   *
   * @param phase - Safe phase used by a stale-owner failure.
   * @param attemptInFlightNonce - Episode captured before the physical call.
   * @param expectedOwner - Exact process-local episode owner.
   * @param cleanupToken - Active cleanup authorization, when applicable.
   */
  async #persistAttemptEpisodeCompletion(
    phase: WorkspaceSearchMigrationDescribeTablePhase,
    attemptInFlightNonce: string,
    expectedOwner: DescribeTableRateLifecycle | undefined,
    cleanupToken: object | undefined = undefined,
  ): Promise<void> {
    if (
      this.#scope.current !== this ||
      !this.#scope.attemptInFlight ||
      this.#scope.attemptInFlightNonce !== attemptInFlightNonce ||
      this.#scope.attemptOwner !== expectedOwner ||
      this.#scope.attemptCompletionPendingNonce !== null
    ) {
      return this.#stop(
        phase,
        this.#scope.current === this
          ? 'invalid-lifecycle'
          : 'taken-over',
        0,
        0,
      )
    }
    this.#scope.attemptInFlight = false
    this.#scope.attemptInFlightNonce = null
    this.#scope.attemptOwner = undefined
    this.#scope.attemptCompletionPendingNonce =
      attemptInFlightNonce
    try {
      await this.#persistRateCheckpointWithNewDeadline(
        phase,
        cleanupToken,
      )
    } catch (error: unknown) {
      if (
        this.#scope.current === this &&
        this.#scope.attemptCompletionPendingNonce ===
          attemptInFlightNonce
      ) {
        this.#scope.attemptInFlight = true
        this.#scope.attemptInFlightNonce = attemptInFlightNonce
        this.#scope.attemptOwner = undefined
        this.#scope.attemptCompletionPendingNonce = null
      }
      throw error
    }
    if (
      this.#scope.current !== this ||
      this.#scope.attemptCompletionPendingNonce !==
        attemptInFlightNonce
    ) {
      return this.#stop(
        phase,
        this.#scope.current === this
          ? 'invalid-lifecycle'
          : 'taken-over',
        0,
        0,
      )
    }
    this.#scope.attemptCompletionPendingNonce = null
  }

  /**
   * Runs already-started mandatory cleanup before applying interruption.
   *
   * @param task - Required post-send guard using its isolated surface.
   * @param page - Active page reservation that owns the cleanup.
   * @returns Cleanup result.
   */
  async #runMandatoryCleanup<Result>(
    task: (
      cleanup:
        WorkspaceSearchMigrationDescribeTableMandatoryCleanup,
    ) => Promise<Result>,
    page: DescribeTableCheckpointPage,
  ): Promise<Result> {
    this.#requireActive('post-send-guard')
    if (
      this.#attemptRecoveryActive ||
      this.#scope.attemptCompletionPendingNonce !== null ||
      this.#cleanupDepth > 0 ||
      this.#scope.mandatoryCleanupRequired ||
      this.#scope.attemptInFlight
    ) {
      throw new WorkspaceSearchMigrationDescribeTableRateError(
        'invalid-lifecycle',
      )
    }
    return await this.#executeMandatoryCleanup(task, page, false)
  }

  /**
   * Reconciles a marker retained by an interrupted cleanup owner.
   */
  async recoverInterruptedCleanup<Result>(
    task: (
      cleanup:
        WorkspaceSearchMigrationDescribeTableMandatoryCleanup,
    ) => Promise<Result>,
  ): Promise<Result> {
    this.#requireActive('post-send-guard')
    if (
      !this.#recoveryAuthority.interruptedCleanup ||
      !this.#scope.mandatoryCleanupRequired ||
      this.#scope.attemptInFlight ||
      this.#attemptRecoveryActive ||
      this.#cleanupDepth > 0
    ) {
      throw new WorkspaceSearchMigrationDescribeTableRateError(
        'invalid-lifecycle',
      )
    }
    return await this.#executeMandatoryCleanup(
      task,
      undefined,
      true,
    )
  }

  /**
   * Reconciles a charged attempt whose prior owner did not confirm completion.
   */
  async recoverInterruptedAttempt<Result>(
    task: () => Promise<Result>,
  ): Promise<Result> {
    this.#requireActive('reconciliation')
    if (
      !this.#recoveryAuthority.interruptedAttempt ||
      !this.#scope.attemptInFlight ||
      this.#scope.attemptInFlightNonce === null ||
      this.#scope.attemptOwner !== undefined ||
      this.#attemptRecoveryActive ||
      this.#cleanupDepth > 0 ||
      typeof task !== 'function'
    ) {
      throw new WorkspaceSearchMigrationDescribeTableRateError(
        'invalid-lifecycle',
      )
    }
    const attemptInFlightNonce = this.#scope.attemptInFlightNonce
    this.#attemptRecoveryActive = true
    let taskSucceeded = false
    try {
      const result = await task()
      taskSucceeded = true
      if (
        this.#scope.current !== this ||
        !this.#scope.attemptInFlight ||
        this.#scope.attemptInFlightNonce !== attemptInFlightNonce ||
        this.#scope.attemptOwner !== undefined
      ) {
        return this.#stop(
          'reconciliation',
          this.#scope.current === this
            ? 'invalid-lifecycle'
            : 'taken-over',
          0,
          0,
        )
      }
      this.#detachRecoveredOperationGeneration()
      await this.#persistAttemptEpisodeCompletion(
        'reconciliation',
        attemptInFlightNonce,
        undefined,
      )
      this.#recoveryAuthority.interruptedAttempt = false
      return result
    } catch (error: unknown) {
      if (
        !taskSucceeded &&
        this.#scope.current === this &&
        this.#scope.attemptInFlight &&
        this.#scope.attemptInFlightNonce === attemptInFlightNonce &&
        this.#scope.attemptOwner === undefined
      ) {
        this.#transitionTo('quarantined')
      }
      throw error
    } finally {
      this.#attemptRecoveryActive = false
    }
  }

  /**
   * Executes either an original or recovered mandatory cleanup boundary.
   *
   * @param task - Cleanup callback receiving the only transition-immune surface.
   * @param page - Original page reservation, absent during recovery.
   * @param markerAlreadyPersisted - Whether a prior owner stored the marker.
   * @returns Cleanup result after its marker is durably cleared.
   */
  async #executeMandatoryCleanup<Result>(
    task: (
      cleanup:
        WorkspaceSearchMigrationDescribeTableMandatoryCleanup,
    ) => Promise<Result>,
    page: DescribeTableCheckpointPage | undefined,
    markerAlreadyPersisted: boolean,
  ): Promise<Result> {
    const cleanupCapacity = page === undefined
      ? this.#readRemainingLifecycleAttempts(true)
      : readDescribeTableCheckpointPageRemainingAttempts(
        describeTableRateControllerAuthority,
        page,
      )
    if (
      cleanupCapacity <
        WORKSPACE_SEARCH_MIGRATION_DESCRIBE_TABLE_CLEANUP_RECOVERY_ATTEMPTS
    ) {
      return this.#stop(
        'post-send-guard',
        'budget-capacity',
        WORKSPACE_SEARCH_MIGRATION_DESCRIBE_TABLE_CLEANUP_RECOVERY_ATTEMPTS,
        0,
      )
    }
    if (
      typeof task !== 'function' ||
      (
        this.#scope.cleanupOwner !== undefined &&
        this.#scope.cleanupOwner !== this
      )
    ) {
      throw new WorkspaceSearchMigrationDescribeTableRateError(
        'invalid-lifecycle',
      )
    }
    const cleanupToken = Object.freeze({})
    const cleanup = new DescribeTableMandatoryCleanup(
      describeTableCapabilityConstructionKey,
      this,
      cleanupToken,
      page,
    )
    this.#acquireCleanupBarrier()
    this.#cleanupDepth += 1
    this.#activeCleanupToken = cleanupToken
    try {
      if (!markerAlreadyPersisted) {
        this.#scope.mandatoryCleanupRequired = true
        await this.#persistRateCheckpointWithNewDeadline(
          'post-send-guard',
          cleanupToken,
        )
      }
      let taskOutcome:
        | { readonly kind: 'success'; readonly value: Result }
        | { readonly kind: 'failure'; readonly error: unknown }
      try {
        taskOutcome = {
          kind: 'success',
          value: await task(cleanup),
        }
      } catch (error: unknown) {
        taskOutcome = { kind: 'failure', error }
      }
      closeDescribeTableMandatoryCleanupForNewAttempts(
        describeTableRateControllerAuthority,
        cleanup,
      )
      const taskReturnedWithPendingAttempts =
        hasDescribeTableMandatoryCleanupPendingAttempts(
          describeTableRateControllerAuthority,
          cleanup,
        )
      await waitForDescribeTableMandatoryCleanupPendingAttempts(
        describeTableRateControllerAuthority,
        cleanup,
      )
      if (taskOutcome.kind === 'failure') {
        throw taskOutcome.error
      }
      if (taskReturnedWithPendingAttempts) {
        throw new WorkspaceSearchMigrationDescribeTableRateError(
          'invalid-lifecycle',
        )
      }
      const result = taskOutcome.value
      releaseDescribeTableMandatoryCleanup(
        describeTableRateControllerAuthority,
        cleanup,
      )
      if (this.#scope.attemptInFlight) {
        throw new WorkspaceSearchMigrationDescribeTableRateError(
          'invalid-lifecycle',
        )
      }
      this.#scope.mandatoryCleanupRequired = false
      await this.#persistRateCheckpointWithNewDeadline(
        'post-send-guard',
        cleanupToken,
      )
      if (markerAlreadyPersisted) {
        this.#recoveryAuthority.interruptedCleanup = false
      }
      return result
    } catch (error: unknown) {
      const canClearBeforeDataMutation =
        !markerAlreadyPersisted &&
        canClearDescribeTableMandatoryCleanupBeforeDataMutation(
          describeTableRateControllerAuthority,
          cleanup,
        ) &&
        readDescribeTableMandatoryCleanupConsumedAttempts(
          describeTableRateControllerAuthority,
          cleanup,
        ) === 0 &&
        !this.#scope.attemptInFlight
      if (canClearBeforeDataMutation) {
        releaseDescribeTableMandatoryCleanup(
          describeTableRateControllerAuthority,
          cleanup,
        )
        this.#scope.mandatoryCleanupRequired = false
        try {
          await this.#persistRateCheckpointWithNewDeadline(
            'post-send-guard',
            cleanupToken,
          )
        } catch (clearError: unknown) {
          this.#scope.mandatoryCleanupRequired = true
          this.#transitionTo('quarantined')
          throw clearError
        }
        throw error
      }
      this.#scope.mandatoryCleanupRequired = true
      if (
        !markerAlreadyPersisted ||
        readDescribeTableMandatoryCleanupConsumedAttempts(
          describeTableRateControllerAuthority,
          cleanup,
        ) > 0 ||
        !isRetryableCleanupRecoveryStop(error)
      ) {
        this.#transitionTo('quarantined')
      }
      throw error
    } finally {
      releaseDescribeTableMandatoryCleanup(
        describeTableRateControllerAuthority,
        cleanup,
      )
      this.#activeCleanupToken = undefined
      this.#cleanupDepth -= 1
      this.#releaseCleanupBarrier()
      this.#applyDeferredStatus()
    }
  }

  /**
   * Waits until another lifecycle releases its page or cleanup ownership.
   *
   * @param signal - Pre-send cancellation for the waiting lifecycle.
   * @param pageOwned - Whether this call uses this lifecycle's active page.
   */
  async #waitForExclusiveScope(
    signal: AbortSignal,
    phase: WorkspaceSearchMigrationDescribeTablePhase,
    deadline: RateAdmissionDeadline,
    requiredAttempts: number,
    pageOwned = false,
    cleanupToken: object | undefined = undefined,
  ): Promise<void> {
    for (;;) {
      this.#requireActive(phase, cleanupToken)
      if (signal.aborted) {
        return this.#stop(phase, 'interrupted', 0, 0)
      }
      const cleanupOwner = this.#scope.cleanupOwner
      if (
        cleanupOwner !== undefined &&
        cleanupOwner !== this
      ) {
        await this.#waitForAdmissionBoundary(
          this.#scope.cleanupBarrier,
          signal,
          phase,
          deadline,
          requiredAttempts,
          cleanupToken,
        )
        continue
      }
      const pageOwner = this.#scope.pageOwner
      if (pageOwner === undefined) return
      if (pageOwner === this) {
        if (pageOwned) return
        return this.#stop(
          phase,
          'invalid-lifecycle',
          0,
          0,
        )
      }
      await this.#waitForAdmissionBoundary(
        this.#scope.pageBarrier,
        signal,
        phase,
        deadline,
        requiredAttempts,
        cleanupToken,
      )
    }
  }

  /**
   * Marks this lifecycle as the exclusive page owner.
   */
  #acquirePageBarrier(pageReservationToken: object): void {
    if (this.#scope.pageOwner !== undefined) {
      throw new WorkspaceSearchMigrationDescribeTableRateError(
        'invalid-lifecycle',
      )
    }
    this.#scope.pageOwner = this
    this.#scope.pageReservationToken = pageReservationToken
    this.#scope.pageBarrier = new Promise<void>((resolve) => {
      this.#scope.releasePageBarrier = resolve
    })
  }

  /**
   * Releases this lifecycle's exclusive page ownership.
   */
  #releasePageBarrier(): void {
    if (this.#scope.pageOwner !== this) return
    this.#scope.pageOwner = undefined
    this.#scope.pageReservationToken = undefined
    const release = this.#scope.releasePageBarrier
    this.#scope.releasePageBarrier = undefined
    release?.()
  }

  /**
   * Marks this lifecycle as the exclusive mandatory-cleanup owner.
   */
  #acquireCleanupBarrier(): void {
    this.#scope.cleanupOwner = this
    this.#scope.cleanupBarrier = new Promise<void>((resolve) => {
      this.#scope.releaseCleanupBarrier = resolve
    })
  }

  /**
   * Releases this lifecycle's mandatory-cleanup ownership.
   */
  #releaseCleanupBarrier(): void {
    if (this.#scope.cleanupOwner !== this) return
    this.#scope.cleanupOwner = undefined
    const release = this.#scope.releaseCleanupBarrier
    this.#scope.releaseCleanupBarrier = undefined
    release?.()
  }

  /**
   * Waits until both rolling capacity and page cadence are admissible.
   */
  async #waitForPageAdmission(
    attemptCapacity: number,
    signal: AbortSignal,
    deadline: RateAdmissionDeadline,
  ): Promise<void> {
    for (;;) {
      this.#requireActive('checkpoint-page')
      if (signal.aborted) {
        return this.#stop(
          'checkpoint-page',
          'interrupted',
          attemptCapacity,
          0,
        )
      }
      const now = this.#readClock()
      this.#pruneWindow(now)
      const capacityDelay =
        this.#readRemainingLifecycleAttempts() < attemptCapacity
          ? Number.POSITIVE_INFINITY
          : this.#createWindowCapacityDelay(now, attemptCapacity)
      const pageDelay = this.#scope.lastPageStartedAt === undefined
        ? 0
        : Math.max(
          0,
          this.#scope.lastPageStartedAt +
            this.#dependencies.policy.minimumPageIntervalMilliseconds -
            now,
        )
      const throttleDelay = Math.max(
        0,
        this.#scope.resumeNotBefore - now,
      )
      const coldStartDelay = Math.max(
        0,
        this.#scope.coldStartNotBefore - now,
      )
      const delay = Math.max(
        capacityDelay,
        pageDelay,
        throttleDelay,
        coldStartDelay,
      )
      if (
        !Number.isFinite(delay) ||
        delay >= deadline.expiresAtMilliseconds - now
      ) {
        return this.#stop(
          'checkpoint-page',
          pageDelay === delay || coldStartDelay === delay
            ? 'cadence-bound'
            : throttleDelay === delay
              ? 'throttled'
              : 'budget-capacity',
          attemptCapacity,
          Number.isFinite(delay) ? delay : 0,
        )
      }
      if (delay === 0) return
      await this.#wait(
        delay,
        signal,
        'checkpoint-page',
        deadline,
        attemptCapacity,
      )
    }
  }

  /**
   * Waits for one physical attempt without consuming its permit.
   */
  async #waitForAttemptAdmission(
    phase: WorkspaceSearchMigrationDescribeTablePhase,
    signal: AbortSignal,
    page: DescribeTableCheckpointPage | undefined,
    deadline: RateAdmissionDeadline,
    cleanupToken: object | undefined,
    includeCleanupRecoveryHeadroom: boolean,
  ): Promise<void> {
    for (;;) {
      const now = this.#readClock()
      this.#pruneWindow(now)
      const capacityDelay =
        (
          page !== undefined &&
          !hasDescribeTableCheckpointPageRemainingAttempts(
            describeTableRateControllerAuthority,
            page,
          )
        ) ||
          (
            page === undefined &&
            this.#readRemainingLifecycleAttempts(
              includeCleanupRecoveryHeadroom,
            ) < 1
          )
          ? Number.POSITIVE_INFINITY
          : this.#createWindowCapacityDelay(now, 1)
      const intervalDelay =
        this.#scope.lastAttemptStartedAt === undefined
          ? 0
          : Math.max(
            0,
            this.#scope.lastAttemptStartedAt +
              this.#dependencies.policy
                .minimumAttemptIntervalMilliseconds -
              now,
          )
      const throttleDelay = Math.max(
        0,
        this.#scope.resumeNotBefore - now,
      )
      const coldStartDelay = Math.max(
        0,
        this.#scope.coldStartNotBefore - now,
      )
      const delay = Math.max(
        capacityDelay,
        intervalDelay,
        throttleDelay,
        coldStartDelay,
      )
      if (
        !Number.isFinite(delay) ||
        delay >= deadline.expiresAtMilliseconds - now
      ) {
        return this.#stop(
          phase,
          page !== undefined &&
            !hasDescribeTableCheckpointPageRemainingAttempts(
              describeTableRateControllerAuthority,
              page,
            )
            ? 'page-capacity'
            : intervalDelay === delay || coldStartDelay === delay
              ? 'cadence-bound'
              : throttleDelay === delay
                ? 'throttled'
                : 'budget-capacity',
          1,
          Number.isFinite(delay) ? delay : 0,
        )
      }
      if (delay === 0) return
      await this.#wait(
        delay,
        signal,
        phase,
        deadline,
        1,
        cleanupToken,
      )
      this.#requireActive(phase, cleanupToken)
      if (signal.aborted) {
        return this.#stop(phase, 'interrupted', 1, 0)
      }
    }
  }

  /**
   * Serializes one complete logical call, including admission and transport.
   *
   * @param operation - Work run after every earlier scope operation settles.
   * @param signal - Cancellation applying before this queue turn begins.
   * @param phase - Safe phase used by a bounded queue stop.
   * @param deadline - Total admission deadline shared with the caller.
   * @param cleanupToken - Active cleanup authorization, when applicable.
   * @param requiredAttempts - Permits reported if the queue wait is bounded.
   * @returns Operation result after exclusive scope execution.
   */
  async #withScopeSingleFlight<Result>(
    operation: () => Promise<Result>,
    signal: AbortSignal,
    phase: WorkspaceSearchMigrationDescribeTablePhase,
    deadline: RateAdmissionDeadline,
    cleanupToken: object | undefined,
    requiredAttempts = 1,
  ): Promise<Result> {
    const predecessor = this.#scope.tail
    let release: (() => void) | undefined
    const ownTurn = new Promise<void>((resolve) => {
      release = resolve
    })
    this.#scope.tail = ownTurn
    let predecessorCompleted = false
    try {
      await this.#waitForAdmissionBoundary(
        predecessor,
        signal,
        phase,
        deadline,
        requiredAttempts,
        cleanupToken,
      )
      predecessorCompleted = true
      return await operation()
    } finally {
      if (predecessorCompleted) {
        release?.()
      } else {
        void predecessor.then(() => {
          release?.()
        })
      }
    }
  }

  /**
   * Serializes one checkpoint mutation under the operation admission deadline.
   *
   * @param operation - Exact mutation performed only after predecessor release.
   * @param signal - Cancellation applying before the mutation begins.
   * @param phase - Safe phase used by a fail-closed stop.
   * @param deadline - Total admission deadline.
   * @param cleanupToken - Internal cleanup or page-release authorization.
   * @returns Mutation result.
   */
  async #withCheckpointMutation<Result>(
    operation: () => Promise<Result>,
    signal: AbortSignal,
    phase: WorkspaceSearchMigrationDescribeTablePhase,
    deadline: RateAdmissionDeadline,
    cleanupToken: object | undefined,
  ): Promise<Result> {
    const predecessor = this.#scope.checkpointTail
    let release: (() => void) | undefined
    const ownTurn = new Promise<void>((resolve) => {
      release = resolve
    })
    this.#scope.checkpointTail = ownTurn
    let predecessorCompleted = false
    try {
      await this.#waitForAdmissionBoundary(
        predecessor,
        signal,
        phase,
        deadline,
        0,
        cleanupToken,
      )
      predecessorCompleted = true
      return await operation()
    } finally {
      if (predecessorCompleted) {
        release?.()
      } else {
        void predecessor.then(
          () => release?.(),
          () => release?.(),
        )
      }
    }
  }

  /**
   * Persists the current ledger before a protected callback may continue.
   *
   * @param phase - Safe phase used by fail-closed observations.
   * @param signal - Cancellation applying before protected external I/O.
   * @param deadline - Total admission deadline.
   * @param cleanupToken - Internal cleanup or page-release authorization.
   */
  async #persistRateCheckpoint(
    phase: WorkspaceSearchMigrationDescribeTablePhase,
    signal: AbortSignal,
    deadline: RateAdmissionDeadline,
    cleanupToken: object | undefined = undefined,
  ): Promise<void> {
    return await this.#withCheckpointMutation(
      async () =>
        await this.#persistRateCheckpointUnlocked(
          phase,
          signal,
          deadline,
          cleanupToken,
        ),
      signal,
      phase,
      deadline,
      cleanupToken,
    )
  }

  /**
   * Performs one checkpoint mutation while holding the scope mutation turn.
   *
   * @param phase - Safe phase used by fail-closed observations.
   * @param signal - Cancellation applying before protected external I/O.
   * @param deadline - Total admission deadline.
   * @param cleanupToken - Internal cleanup or page-release authorization.
   */
  async #persistRateCheckpointUnlocked(
    phase: WorkspaceSearchMigrationDescribeTablePhase,
    signal: AbortSignal,
    deadline: RateAdmissionDeadline,
    cleanupToken: object | undefined,
  ): Promise<void> {
    if (this.#scope.current !== this) {
      return this.#stop(phase, 'taken-over', 0, 0)
    }
    const expectedRevision = this.#scope.checkpointRevision
    const checkpoint = this.#createSuccessorCheckpoint()
    let writeResult: 'stored' | 'conflict' | undefined
    try {
      const writing = this.#dependencies.checkpointStore.compareAndSwap({
        scopeBindingDigest: this.#scope.scopeBindingDigest,
        expectedRevision,
        checkpoint,
      }).then((result) => {
        writeResult = result
      })
      await this.#waitForAdmissionBoundary(
        writing,
        signal,
        phase,
        deadline,
        0,
        cleanupToken,
      )
    } catch {
      // An exact reread below is the only safe response-loss recovery.
    }
    if (writeResult !== 'stored') {
      const recovered = await this.#recoverExactCheckpoint(
        checkpoint,
        phase,
        deadline,
        cleanupToken,
      )
      if (!recovered) {
        this.#durabilityFailed = true
        this.#transitionTo('quarantined')
        return this.#stop(
          phase,
          writeResult === 'conflict'
            ? 'taken-over'
            : 'quarantined',
          0,
          0,
        )
      }
    }
    this.#confirmCheckpoint(checkpoint)
    if (
      deadline.signal.aborted ||
      this.#readClock() >= deadline.expiresAtMilliseconds
    ) {
      return this.#stop(phase, 'cadence-bound', 0, 0)
    }
    this.#requireActive(phase, cleanupToken)
    if (signal.aborted) {
      return this.#stop(phase, 'interrupted', 0, 0)
    }
  }

  /**
   * Persists a post-admission transition under a fresh bounded deadline.
   *
   * @param phase - Safe phase used by fail-closed observations.
   * @param cleanupToken - Internal cleanup or page-release authorization.
   */
  async #persistRateCheckpointWithNewDeadline(
    phase: WorkspaceSearchMigrationDescribeTablePhase,
    cleanupToken: object | undefined = undefined,
  ): Promise<void> {
    const deadline = this.#createAdmissionDeadline()
    try {
      await this.#persistRateCheckpoint(
        phase,
        new AbortController().signal,
        deadline,
        cleanupToken,
      )
    } finally {
      deadline.cancel()
    }
  }

  /**
   * Recovers an exact stored successor after a lost CAS response.
   *
   * @param checkpoint - Exact successor whose response was unavailable.
   * @param phase - Safe phase used if the recovery wait expires.
   * @param deadline - Original bounded persistence deadline.
   * @returns Whether the durable store contains the exact successor.
   */
  async #recoverExactCheckpoint(
    checkpoint: WorkspaceSearchMigrationDescribeTableRateCheckpoint,
    phase: WorkspaceSearchMigrationDescribeTablePhase,
    deadline: RateAdmissionDeadline,
    cleanupToken: object | undefined,
  ): Promise<boolean> {
    if (deadline.signal.aborted) return false
    let loaded: unknown | undefined
    try {
      const loading = this.#dependencies.checkpointStore.load(
        this.#scope.scopeBindingDigest,
      ).then((value) => {
        loaded = value
      })
      await this.#waitForAdmissionBoundary(
        loading,
        new AbortController().signal,
        phase,
        deadline,
        0,
        cleanupToken,
      )
      if (loaded === undefined) return false
      const parsed = parseRateCheckpoint(
        loaded,
        this.#scope.scopeBindingDigest,
        this.#dependencies.policy,
        this.#scope.transportBindingDigest,
      )
      return areRateCheckpointsEqual(parsed, checkpoint)
    } catch {
      return false
    }
  }

  /**
   * Creates the next immutable checkpoint from current in-memory accounting.
   *
   * @returns Exact successor bound to this lifecycle fence.
   */
  #createSuccessorCheckpoint():
    WorkspaceSearchMigrationDescribeTableRateCheckpoint {
    const revision = this.#scope.checkpointRevision === null
      ? 0
      : this.#scope.checkpointRevision + 1
    if (!Number.isSafeInteger(revision)) {
      throw new WorkspaceSearchMigrationDescribeTableRateError(
        'invalid-lifecycle',
      )
    }
    const capturedAtEpochMilliseconds = this.#readEpochClock()
    return Object.freeze({
      version:
        WORKSPACE_SEARCH_MIGRATION_DESCRIBE_TABLE_RATE_CHECKPOINT_VERSION,
      scopeBindingDigest: this.#scope.scopeBindingDigest,
      transportBindingDigest: this.#scope.transportBindingDigest,
      policy: this.#dependencies.policy,
      revision,
      fenceToken: this.#fenceToken,
      writeNonce: randomBytes(32).toString('hex'),
      capturedAtEpochMilliseconds,
      attemptCount: this.#scope.evidence.attemptCount,
      forfeitedAttemptCount:
        this.#scope.evidence.forfeitedAttemptCount,
      reservedAttempts: this.#scope.reservedAttempts,
      reservationKind: this.#scope.reservedAttempts === 0
        ? 'none'
        : 'checkpoint-page',
      mandatoryCleanupRequired:
        this.#scope.mandatoryCleanupRequired,
      attemptInFlight: this.#scope.attemptInFlight,
      attemptInFlightNonce: this.#scope.attemptInFlightNonce,
      sequence: this.#scope.sequence,
      throttleCount: this.#scope.evidence.throttleCount,
      budgetStopCount: this.#scope.evidence.budgetStopCount,
      cadenceWaitCount: this.#scope.evidence.cadenceWaitCount,
      cadenceWaitMilliseconds:
        this.#scope.evidence.cadenceWaitMilliseconds,
      maximumInFlight: this.#scope.evidence.maximumInFlight,
    })
  }

  /**
   * Accepts one checkpoint confirmed by CAS or exact reread.
   *
   * @param checkpoint - Exact durable successor.
   */
  #confirmCheckpoint(
    checkpoint: WorkspaceSearchMigrationDescribeTableRateCheckpoint,
  ): void {
    this.#scope.checkpointRevision = checkpoint.revision
    this.#scope.lastCheckpoint = checkpoint
  }

  /**
   * Creates the one deadline spanning every admission wait for an operation.
   *
   * @returns Cancelable deadline backed by the injected scheduler.
   */
  #createAdmissionDeadline(): RateAdmissionDeadline {
    const startedAtMilliseconds = this.#readClock()
    const expiresAtMilliseconds =
      startedAtMilliseconds +
      this.#dependencies.policy.maximumAdmissionWaitMilliseconds
    if (!Number.isSafeInteger(expiresAtMilliseconds)) {
      throw new WorkspaceSearchMigrationDescribeTableRateError(
        'invalid-lifecycle',
      )
    }
    const controller = new AbortController()
    let resolveExpiration = (): void => {}
    const expiration = new Promise<void>((resolve) => {
      resolveExpiration = resolve
    })
    let handle: WorkspaceSearchMigrationDescribeTableRateDeadlineHandle
    try {
      handle = this.#dependencies.deadlineScheduler.schedule(
        this.#dependencies.policy.maximumAdmissionWaitMilliseconds,
        (): void => {
          controller.abort()
          resolveExpiration()
        },
      )
    } catch {
      throw new WorkspaceSearchMigrationDescribeTableRateError(
        'invalid-lifecycle',
      )
    }
    let active = true
    return {
      expiresAtMilliseconds,
      expiration,
      signal: controller.signal,
      cancel: (): void => {
        if (!active) return
        active = false
        try {
          handle.cancel()
        } catch {
          // Deadline cleanup must not change completed rate accounting.
        }
      },
    }
  }

  /**
   * Waits for a barrier or FIFO predecessor under the total deadline.
   *
   * @param boundary - Existing scope barrier or serialized predecessor.
   * @param signal - Lifecycle and caller cancellation.
   * @param phase - Safe phase used by a fail-closed stop.
   * @param deadline - Deadline created before the first admission wait.
   * @param requiredAttempts - Permits requested by the stopped operation.
   * @param cleanupToken - Internal cleanup or page-release authorization.
   */
  async #waitForAdmissionBoundary(
    boundary: Promise<void>,
    signal: AbortSignal,
    phase: WorkspaceSearchMigrationDescribeTablePhase,
    deadline: RateAdmissionDeadline,
    requiredAttempts: number,
    cleanupToken: object | undefined = undefined,
  ): Promise<void> {
    let handleAbort = (): void => {}
    const interruption =
      new Promise<RateAdmissionBoundaryOutcome>((resolve) => {
        handleAbort = (): void => resolve('interrupted')
        if (signal.aborted) {
          handleAbort()
          return
        }
        signal.addEventListener('abort', handleAbort, { once: true })
      })
    let outcome: RateAdmissionBoundaryOutcome
    try {
      outcome = await Promise.race<RateAdmissionBoundaryOutcome>([
        boundary.then<RateAdmissionBoundaryOutcome>(() => 'completed'),
        deadline.expiration.then<RateAdmissionBoundaryOutcome>(
          () => 'deadline',
        ),
        interruption,
      ])
    } finally {
      signal.removeEventListener('abort', handleAbort)
    }
    if (outcome === 'completed') {
      this.#requireActive(phase, cleanupToken)
      if (signal.aborted) {
        return this.#stop(
          phase,
          'interrupted',
          requiredAttempts,
          0,
        )
      }
      if (
        deadline.signal.aborted ||
        this.#readClock() >= deadline.expiresAtMilliseconds
      ) {
        return this.#stop(
          phase,
          'cadence-bound',
          requiredAttempts,
          0,
        )
      }
      return
    }
    this.#requireActive(phase, cleanupToken)
    return this.#stop(
      phase,
      outcome === 'deadline' ? 'cadence-bound' : 'interrupted',
      requiredAttempts,
      0,
    )
  }

  /**
   * Applies one lifecycle transition, deferring it during mandatory cleanup.
   */
  #transitionTo(
    status: 'interrupted' | 'quarantined' | 'closed' | 'taken-over',
  ): void {
    if (
      this.#status === 'quarantined' ||
      this.#status === 'closed' ||
      this.#status === 'taken-over'
    ) {
      return
    }
    if (this.#cleanupDepth > 0) {
      if (
        this.#deferredStatus === undefined ||
        readLifecycleTransitionPriority(status) >
          readLifecycleTransitionPriority(this.#deferredStatus)
      ) {
        this.#deferredStatus = status
      }
      return
    }
    this.#status = status
    this.#abortController.abort()
  }

  /**
   * Applies a transition after cleanup and its owning page have released.
   */
  #applyDeferredStatus(): void {
    if (
      this.#cleanupDepth > 0 ||
      this.#pageActive ||
      this.#deferredStatus === undefined
    ) {
      return
    }
    const status = this.#deferredStatus
    this.#deferredStatus = undefined
    this.#status = status
    this.#abortController.abort()
  }

  /**
   * Rejects new work for any inactive or transition-pending lifecycle.
   *
   * @param phase - Safe phase used by a fail-closed stop.
   * @param cleanupToken - Internal cleanup or page-release authorization.
   */
  #requireActive(
    phase: WorkspaceSearchMigrationDescribeTablePhase,
    cleanupToken: object | undefined = undefined,
  ): void {
    this.#requireCurrentOperationGeneration()
    if (this.#durabilityFailed) {
      return this.#stop(phase, 'quarantined', 0, 0)
    }
    const cleanupAuthorized =
      cleanupToken !== undefined &&
      cleanupToken === this.#activeCleanupToken
    const pageReleaseAuthorized =
      cleanupToken !== undefined &&
      this.#pageActive &&
      this.#cleanupDepth === 0 &&
      cleanupToken === this.#scope.pageReservationToken
    if (
      this.#deferredStatus !== undefined &&
      this.#cleanupDepth === 0 &&
      !cleanupAuthorized &&
      !pageReleaseAuthorized
    ) {
      const reason: WorkspaceSearchMigrationDescribeTableRateStopReason =
        this.#deferredStatus === 'interrupted'
          ? 'interrupted'
          : this.#deferredStatus === 'quarantined'
            ? 'quarantined'
            : this.#deferredStatus === 'taken-over'
              ? 'taken-over'
              : 'invalid-lifecycle'
      return this.#stop(phase, reason, 0, 0)
    }
    if (
      this.#status === 'active' &&
      (
        this.#cleanupDepth === 0 ||
        cleanupAuthorized
      )
    ) {
      return
    }
    if (this.#cleanupDepth > 0 && cleanupAuthorized) return
    if (this.#status === 'active') {
      return this.#stop(phase, 'invalid-lifecycle', 0, 0)
    }
    const reason: WorkspaceSearchMigrationDescribeTableRateStopReason =
      this.#status === 'interrupted'
        ? 'interrupted'
        : this.#status === 'quarantined'
          ? 'quarantined'
          : this.#status === 'taken-over'
            ? 'taken-over'
            : 'invalid-lifecycle'
    return this.#stop(phase, reason, 0, 0)
  }

  /**
   * Rejects a continuation detached by authorized interrupted-attempt recovery.
   */
  #requireCurrentOperationGeneration(): void {
    if (
      this.#operationGeneration !==
        this.#scope.operationGeneration
    ) {
      throw new WorkspaceSearchMigrationDescribeTableRateError(
        'taken-over',
      )
    }
  }

  /**
   * Detaches every obsolete operation continuation after recovery proves safety.
   */
  #detachRecoveredOperationGeneration(): void {
    const nextGeneration = this.#scope.operationGeneration + 1
    if (!Number.isSafeInteger(nextGeneration)) {
      throw new WorkspaceSearchMigrationDescribeTableRateError(
        'invalid-lifecycle',
      )
    }
    this.#scope.operationGeneration = nextGeneration
    this.#operationGeneration = nextGeneration
    this.#scope.tail = Promise.resolve()
    this.#scope.pendingAttemptCount = 0
    this.#scope.pendingPageAdmissionCount = 0
  }

  /**
   * Removes expired physical attempts from the rolling window.
   */
  #pruneWindow(now: number): void {
    const threshold =
      now - this.#dependencies.policy.windowMilliseconds
    while (
      this.#scope.attemptStarts[0] !== undefined &&
      this.#scope.attemptStarts[0] <= threshold
    ) {
      this.#scope.attemptStarts.shift()
    }
  }

  /**
   * Reads currently unreserved rolling-window capacity.
   */
  #readRemainingLifecycleAttempts(
    includeCleanupRecoveryHeadroom = false,
  ): number {
    const protectedCleanupRecoveryAttempts =
      includeCleanupRecoveryHeadroom
        ? 0
        : WORKSPACE_SEARCH_MIGRATION_DESCRIBE_TABLE_CLEANUP_RECOVERY_ATTEMPTS
    return Math.max(
      0,
      this.#dependencies.policy.maximumAttemptsPerLifecycle -
        this.#scope.evidence.attemptCount -
        this.#scope.evidence.forfeitedAttemptCount -
        this.#scope.reservedAttempts -
        protectedCleanupRecoveryAttempts,
    )
  }

  /**
   * Reads currently available rolling-window attempt capacity.
   */
  #readAvailableWindowAttempts(): number {
    return Math.max(
      0,
      this.#dependencies.policy.maximumAttemptsPerWindow -
        this.#scope.attemptStarts.length,
    )
  }

  /**
   * Computes the delay until one rolling-window attempt fits.
   */
  #createWindowCapacityDelay(
    now: number,
    requiredAttempts: number,
  ): number {
    const missingAttempts =
      requiredAttempts - this.#readAvailableWindowAttempts()
    if (missingAttempts <= 0) return 0
    const releaseAt = this.#scope.attemptStarts[missingAttempts - 1]
    if (releaseAt === undefined) return Number.POSITIVE_INFINITY
    return Math.max(
      0,
      releaseAt + this.#dependencies.policy.windowMilliseconds - now,
    )
  }

  /**
   * Waits without consuming a permit and records only allowlisted fields.
   */
  async #wait(
    delayMilliseconds: number,
    signal: AbortSignal,
    phase: WorkspaceSearchMigrationDescribeTablePhase,
    deadline: RateAdmissionDeadline,
    requiredAttempts: number,
    cleanupToken: object | undefined = undefined,
  ): Promise<void> {
    const observedAtMilliseconds = this.#readClock()
    const waiterSignal = createLinkedAbortSignal(
      signal,
      deadline.signal,
    )
    let completedAtMilliseconds = observedAtMilliseconds
    try {
      for (let waitIndex = 0; waitIndex < 2; waitIndex += 1) {
        const boundedDelayMilliseconds =
          waitIndex === 0 ? delayMilliseconds : 1
        this.#scope.evidence.cadenceWaitCount += 1
        this.#scope.evidence.cadenceWaitMilliseconds +=
          boundedDelayMilliseconds
        this.#record({
          version:
            WORKSPACE_SEARCH_MIGRATION_DESCRIBE_TABLE_RATE_OBSERVATION_VERSION,
          kind: 'cadence-wait',
          phase,
          observedAtMilliseconds: completedAtMilliseconds,
          delayMilliseconds: boundedDelayMilliseconds,
        })
        const waiting = this.#dependencies.waiter.wait(
          boundedDelayMilliseconds,
          waiterSignal.signal,
        )
        await this.#waitForAdmissionBoundary(
          waiting,
          signal,
          phase,
          deadline,
          requiredAttempts,
          cleanupToken,
        )
        completedAtMilliseconds = this.#readClock()
        if (completedAtMilliseconds > observedAtMilliseconds) return
      }
    } catch {
      this.#requireActive(phase, cleanupToken)
      return this.#stop(
        phase,
        signal.aborted
          ? 'interrupted'
          : deadline.signal.aborted
            ? 'cadence-bound'
            : 'invalid-lifecycle',
        requiredAttempts,
        0,
      )
    } finally {
      waiterSignal.dispose()
    }
    this.#requireActive(phase, cleanupToken)
    return this.#stop(
      phase,
      signal.aborted
        ? 'interrupted'
        : deadline.signal.aborted
          ? 'cadence-bound'
          : 'invalid-lifecycle',
      0,
      0,
    )
  }

  /**
   * Creates bounded equal-jitter exponential throttle cooldown.
   */
  #createThrottleBackoff(): number {
    const exponent = Math.max(
      0,
      this.#scope.consecutiveThrottles - 1,
    )
    const cap = Math.min(
      this.#dependencies.policy.throttleBackoffMaximumMilliseconds,
      this.#dependencies.policy.throttleBackoffInitialMilliseconds *
        2 ** exponent,
    )
    let random: number
    try {
      random = this.#dependencies.random()
    } catch {
      throw new WorkspaceSearchMigrationDescribeTableRateError(
        'invalid-lifecycle',
      )
    }
    if (!Number.isFinite(random) || random < 0 || random >= 1) {
      throw new WorkspaceSearchMigrationDescribeTableRateError(
        'invalid-lifecycle',
      )
    }
    const floor = Math.ceil(cap / 2)
    return Math.min(
      cap,
      floor + Math.floor(random * Math.max(1, cap - floor + 1)),
    )
  }

  /**
   * Reads and validates one monotonic dependency clock value.
   */
  #readClock(): number {
    let now: number
    try {
      now = this.#dependencies.clock()
    } catch {
      throw new WorkspaceSearchMigrationDescribeTableRateError(
        'invalid-lifecycle',
      )
    }
    if (
      !Number.isSafeInteger(now) ||
      now < 0 ||
      (
        this.#scope.lastObservedAt !== undefined &&
        now < this.#scope.lastObservedAt
      )
    ) {
      throw new WorkspaceSearchMigrationDescribeTableRateError(
        'invalid-lifecycle',
      )
    }
    this.#scope.lastObservedAt = now
    return now
  }

  /**
   * Reads and validates one Unix-epoch dependency clock value.
   *
   * @returns Non-negative safe integer checkpoint timestamp.
   */
  #readEpochClock(): number {
    let now: number
    try {
      now = this.#dependencies.epochClock()
    } catch {
      throw new WorkspaceSearchMigrationDescribeTableRateError(
        'invalid-lifecycle',
      )
    }
    if (!Number.isSafeInteger(now) || now < 0) {
      throw new WorkspaceSearchMigrationDescribeTableRateError(
        'invalid-lifecycle',
      )
    }
    return now
  }

  /**
   * Emits one best-effort fixed-shape observation.
   */
  #record(
    observation: WorkspaceSearchMigrationDescribeTableRateObservation,
  ): void {
    try {
      this.#dependencies.recorder?.record(observation)
    } catch {
      // Telemetry must never change migration safety or accounting.
    }
  }

  /**
   * Emits one fail-closed stop and throws a stable error.
   */
  #stop(
    phase: WorkspaceSearchMigrationDescribeTablePhase,
    reason: WorkspaceSearchMigrationDescribeTableRateStopReason,
    requiredAttempts: number,
    retryAfterMilliseconds: number,
  ): never {
    this.#requireCurrentOperationGeneration()
    const observedAtMilliseconds = this.#readClock()
    const safeRetryAfterMilliseconds =
      Number.isSafeInteger(retryAfterMilliseconds) &&
        retryAfterMilliseconds >= 0
        ? retryAfterMilliseconds
        : 0
    const signature =
      `${phase}:${reason}:${this.#scope.resumeNotBefore}`
    if (this.#scope.lastBudgetStopSignature !== signature) {
      this.#scope.lastBudgetStopSignature = signature
      this.#scope.evidence.budgetStopCount += 1
      this.#record({
        version:
          WORKSPACE_SEARCH_MIGRATION_DESCRIBE_TABLE_RATE_OBSERVATION_VERSION,
        kind: 'budget-stop',
        phase,
        reason,
        observedAtMilliseconds,
        requiredAttempts,
        remainingNormalAdmissionAttempts:
          this.#readRemainingLifecycleAttempts(),
        remainingWindowAttempts:
          this.#readAvailableWindowAttempts(),
        retryAfterMilliseconds: safeRetryAfterMilliseconds,
      })
    }
    throw new WorkspaceSearchMigrationDescribeTableRateError(reason)
  }
}

/** Exact fence reader captured before callers can observe a lifecycle. */
const readDescribeTableRateLifecycleFence =
  DescribeTableRateLifecycle.controllerReadFenceToken

/** Exact takeover transition captured before callers observe a lifecycle. */
const requestDescribeTableRateLifecycleTakeover =
  DescribeTableRateLifecycle.controllerRequestTakeover

/** Exact fence persister captured before callers observe a lifecycle. */
const persistDescribeTableRateLifecycleFenceClaim =
  DescribeTableRateLifecycle.controllerPersistFenceClaim

/** Exact attempt dispatcher captured before callers observe a lifecycle. */
const runDescribeTableRateLifecycleAttempt =
  DescribeTableRateLifecycle.controllerRunAttempt

/** Exact cleanup dispatcher captured before callers observe a lifecycle. */
const runDescribeTableRateLifecycleMandatoryCleanup =
  DescribeTableRateLifecycle.controllerRunMandatoryCleanup

/** Exact cleanup mutation gate captured before callers observe a lifecycle. */
const beginDescribeTableMandatoryCleanupDataMutation =
  DescribeTableRateLifecycle.controllerBeginCleanupDataMutation

Object.freeze(DescribeTableRateLifecycle.prototype)
Object.freeze(DescribeTableRateLifecycle)

/**
 * Private page implementation owning a fixed number of reserved permits.
 */
class DescribeTableCheckpointPage
  implements WorkspaceSearchMigrationDescribeTableCheckpointPage {
  /** Lifecycle that admitted this page. */
  readonly #lifecycle: DescribeTableRateLifecycle

  /** Unused permits retained by this page. */
  #remainingAttempts: number

  /** Process-local token identifying this exact page reservation. */
  readonly #pageReservationToken: object

  /** Whether the owning checkpoint callback still retains this capability. */
  #active = true

  /** Whether the callback may start another page-owned operation. */
  #acceptingOperations = true

  /** Operation promises authorized by this page and not yet settled. */
  readonly #pendingOperations = new Set<Promise<unknown>>()

  /**
   * Creates one private page reservation.
   *
   * @param constructionKey - Module-private capability construction key.
   * @param lifecycle - Exact fenced lifecycle.
   * @param attemptCapacity - Already reserved physical attempts.
   * @param pageReservationToken - Exact process-local reservation token.
   */
  constructor(
    constructionKey: symbol,
    lifecycle: DescribeTableRateLifecycle,
    attemptCapacity: number,
    pageReservationToken: object,
  ) {
    requireDescribeTableCapabilityConstructionKey(constructionKey)
    this.#lifecycle = lifecycle
    this.#remainingAttempts = attemptCapacity
    this.#pageReservationToken = pageReservationToken
    Object.freeze(this)
  }

  /**
   * Runs one exact physical attempt using this page reservation.
   *
   * @param input - Finite page phase and optional cancellation.
   * @param attempt - Nominal one-shot operation bound to this scope.
   * @returns Untouched successful transport result.
   */
  runDescribeTableAttempt<Result>(
    input: RunWorkspaceSearchMigrationDescribeTableAttemptInput,
    attempt: WorkspaceSearchMigrationDescribeTableSingleAttempt<Result>,
  ): Promise<Result> {
    this.#requireAcceptingOperations()
    const pending = runDescribeTableRateLifecycleAttempt(
      describeTableRateControllerAuthority,
      this.#lifecycle,
      input,
      attempt,
      this,
      undefined,
      undefined,
    )
    const tracked = pending.finally(() => {
      this.#pendingOperations.delete(tracked)
    })
    this.#pendingOperations.add(tracked)
    return tracked
  }

  /**
   * Runs one mandatory cleanup region on the owning lifecycle.
   *
   * @param task - Exclusive mandatory cleanup callback.
   * @returns Cleanup result after its durable marker is cleared.
   */
  runMandatoryCleanup<Result>(
    task: (
      cleanup:
        WorkspaceSearchMigrationDescribeTableMandatoryCleanup,
    ) => Promise<Result>,
  ): Promise<Result> {
    this.#requireAcceptingOperations()
    const pending = runDescribeTableRateLifecycleMandatoryCleanup(
      describeTableRateControllerAuthority,
      this.#lifecycle,
      task,
      this,
    )
    const tracked = pending.finally(() => {
      this.#pendingOperations.delete(tracked)
    })
    this.#pendingOperations.add(tracked)
    return tracked
  }

  /**
   * Checks one page's remaining reservation without dynamic dispatch.
   *
   * @param authority - Module-private rate-controller authority.
   * @param page - Exact page capability inspected by the controller.
   * @returns Whether at least one permit remains.
   */
  static controllerHasRemaining(
    authority: unknown,
    page: DescribeTableCheckpointPage,
  ): boolean {
    requireDescribeTableRateControllerAuthority(authority)
    page.#requireActive()
    return page.#remainingAttempts > 0
  }

  /**
   * Reads one page's unsent permits without dynamic dispatch.
   *
   * @param authority - Module-private rate-controller authority.
   * @param page - Exact page capability inspected by the controller.
   * @returns Current non-negative reserved permit count.
   */
  static controllerReadRemainingAttempts(
    authority: unknown,
    page: DescribeTableCheckpointPage,
  ): number {
    requireDescribeTableRateControllerAuthority(authority)
    page.#requireActive()
    return page.#remainingAttempts
  }

  /**
   * Checks whether one page retains an unsettled operation.
   *
   * @param authority - Module-private rate-controller authority.
   * @param page - Exact page capability inspected by the controller.
   * @returns Whether at least one page-owned operation remains pending.
   */
  static controllerHasPendingOperations(
    authority: unknown,
    page: DescribeTableCheckpointPage,
  ): boolean {
    requireDescribeTableRateControllerAuthority(authority)
    return page.#pendingOperations.size > 0
  }

  /**
   * Waits for operations authorized before one callback settled.
   *
   * @param authority - Module-private rate-controller authority.
   * @param page - Exact page capability joined by the controller.
   */
  static async controllerWaitForPendingOperations(
    authority: unknown,
    page: DescribeTableCheckpointPage,
  ): Promise<void> {
    requireDescribeTableRateControllerAuthority(authority)
    await Promise.allSettled(page.#pendingOperations)
  }

  /**
   * Prevents one settled callback from starting another operation.
   *
   * @param authority - Module-private rate-controller authority.
   * @param page - Exact page capability closed by the controller.
   */
  static controllerCloseForNewOperations(
    authority: unknown,
    page: DescribeTableCheckpointPage,
  ): void {
    requireDescribeTableRateControllerAuthority(authority)
    page.#acceptingOperations = false
  }

  /**
   * Checks whether shared state still recognizes this exact reservation.
   *
   * @param authority - Module-private rate-controller authority.
   * @param page - Exact page capability inspected by the controller.
   * @param pageReservationToken - Current process-local scope token.
   * @returns Whether this page still owns the shared reservation.
   */
  static controllerMatchesReservationToken(
    authority: unknown,
    page: DescribeTableCheckpointPage,
    pageReservationToken: object | undefined,
  ): boolean {
    requireDescribeTableRateControllerAuthority(authority)
    return pageReservationToken === page.#pageReservationToken
  }

  /**
   * Permanently consumes one page permit immediately before write-ahead CAS.
   *
   * @param authority - Module-private rate-controller authority.
   * @param page - Exact page capability consumed by the controller.
   */
  static controllerConsumeOne(
    authority: unknown,
    page: DescribeTableCheckpointPage,
  ): void {
    requireDescribeTableRateControllerAuthority(authority)
    page.#requireActive()
    if (page.#remainingAttempts <= 0) {
      throw new WorkspaceSearchMigrationDescribeTableRateError(
        'page-capacity',
      )
    }
    page.#remainingAttempts -= 1
  }

  /**
   * Releases every permit that never reached a physical send.
   *
   * @param authority - Module-private rate-controller authority.
   * @param page - Exact page capability released by the controller.
   * @returns Exact unused permit count released from the shared ledger.
   */
  static controllerReleaseUnusedAttempts(
    authority: unknown,
    page: DescribeTableCheckpointPage,
  ): number {
    requireDescribeTableRateControllerAuthority(authority)
    const remaining = page.#remainingAttempts
    page.#remainingAttempts = 0
    page.#acceptingOperations = false
    page.#active = false
    return remaining
  }

  /**
   * Rejects operations first requested after callback settlement.
   */
  #requireAcceptingOperations(): void {
    if (!this.#acceptingOperations) {
      throw new WorkspaceSearchMigrationDescribeTableRateError(
        'invalid-lifecycle',
      )
    }
    this.#requireActive()
  }

  /**
   * Rejects use after the owning checkpoint callback has returned.
   */
  #requireActive(): void {
    if (!this.#active) {
      throw new WorkspaceSearchMigrationDescribeTableRateError(
        'invalid-lifecycle',
      )
    }
  }
}

/** Exact page-capacity check captured before callers observe a page. */
const hasDescribeTableCheckpointPageRemainingAttempts =
  DescribeTableCheckpointPage.controllerHasRemaining

/** Exact page-capacity reader captured before callers observe a page. */
const readDescribeTableCheckpointPageRemainingAttempts =
  DescribeTableCheckpointPage.controllerReadRemainingAttempts

/** Exact pending-page check captured before callers observe a page. */
const hasDescribeTableCheckpointPagePendingOperations =
  DescribeTableCheckpointPage.controllerHasPendingOperations

/** Exact pending-page join captured before callers observe a page. */
const waitForDescribeTableCheckpointPagePendingOperations =
  DescribeTableCheckpointPage.controllerWaitForPendingOperations

/** Exact page close captured before callers observe a page. */
const closeDescribeTableCheckpointPageForNewOperations =
  DescribeTableCheckpointPage.controllerCloseForNewOperations

/** Exact page-token matcher captured before callers observe a page. */
const matchesDescribeTableCheckpointPageReservationToken =
  DescribeTableCheckpointPage.controllerMatchesReservationToken

/** Exact page-permit consumer captured before callers observe a page. */
const consumeDescribeTableCheckpointPageAttempt =
  DescribeTableCheckpointPage.controllerConsumeOne

/** Exact page reservation release captured before callers observe a page. */
const releaseDescribeTableCheckpointPageUnusedAttempts =
  DescribeTableCheckpointPage.controllerReleaseUnusedAttempts

Object.freeze(DescribeTableCheckpointPage.prototype)
Object.freeze(DescribeTableCheckpointPage)

/**
 * Private cleanup capability scoped to one active mandatory callback.
 */
class DescribeTableMandatoryCleanup
  implements WorkspaceSearchMigrationDescribeTableMandatoryCleanup {
  /** Lifecycle owning the mandatory cleanup marker. */
  readonly #lifecycle: DescribeTableRateLifecycle

  /** Unforgeable token accepted only while this callback remains active. */
  readonly #cleanupToken: object

  /** Original page reservation, absent for cross-process recovery. */
  readonly #page: DescribeTableCheckpointPage | undefined

  /** Whether the callback may start another cleanup attempt. */
  #acceptingAttempts = true

  /** Attempt promises already authorized by the active callback. */
  readonly #pendingAttempts = new Set<Promise<unknown>>()

  /** Attempts retained for the fixed all-six cleanup proof. */
  #remainingAttempts =
    WORKSPACE_SEARCH_MIGRATION_DESCRIBE_TABLE_CLEANUP_RECOVERY_ATTEMPTS

  /** Physical cleanup attempts consumed by this exact callback. */
  #consumedAttempts = 0

  /** Whether one irreversible data mutation was authorized in this cleanup. */
  #dataMutationStarted = false

  /** Whether deferred interruption rejected the first mutation boundary. */
  #dataMutationRejectedBeforeStart = false

  /**
   * Creates one cleanup-only attempt surface.
   *
   * @param constructionKey - Module-private capability construction key.
   * @param lifecycle - Lifecycle retaining the durable cleanup marker.
   * @param cleanupToken - Exact process-local cleanup authorization.
   * @param page - Original page reservation, when cleanup began in a page.
   */
  constructor(
    constructionKey: symbol,
    lifecycle: DescribeTableRateLifecycle,
    cleanupToken: object,
    page: DescribeTableCheckpointPage | undefined,
  ) {
    requireDescribeTableCapabilityConstructionKey(constructionKey)
    this.#lifecycle = lifecycle
    this.#cleanupToken = cleanupToken
    this.#page = page
    Object.freeze(this)
  }

  /** Marks or rejects the exact boundary before one data mutation starts. */
  beginDataMutation(): void {
    this.#requireAcceptingAttempts()
    try {
      beginDescribeTableMandatoryCleanupDataMutation(
        describeTableRateControllerAuthority,
        this.#lifecycle,
        this.#cleanupToken,
      )
    } catch (error: unknown) {
      if (!this.#dataMutationStarted) {
        this.#dataMutationRejectedBeforeStart = true
      }
      throw error
    }
    this.#dataMutationStarted = true
  }

  /** Records an outer guard rejection before any data mutation started. */
  rejectDataMutationBeforeStart(): void {
    this.#requireAcceptingAttempts()
    if (!this.#dataMutationStarted) {
      this.#dataMutationRejectedBeforeStart = true
    }
  }

  /**
   * Runs one attempt under the cleanup-only authorization.
   */
  runDescribeTableAttempt<Result>(
    input: RunWorkspaceSearchMigrationDescribeTableAttemptInput,
    attempt: WorkspaceSearchMigrationDescribeTableSingleAttempt<Result>,
  ): Promise<Result> {
    this.#requireAcceptingAttempts()
    const pending = runDescribeTableRateLifecycleAttempt(
      describeTableRateControllerAuthority,
      this.#lifecycle,
      input,
      attempt,
      this.#page,
      this.#cleanupToken,
      this,
    )
    const tracked = pending.finally(() => {
      this.#pendingAttempts.delete(tracked)
    })
    this.#pendingAttempts.add(tracked)
    return tracked
  }

  /**
   * Checks whether one cleanup retains an unsettled attempt.
   *
   * @param authority - Module-private rate-controller authority.
   * @param cleanup - Exact cleanup capability inspected by the controller.
   * @returns Whether at least one cleanup-owned attempt remains pending.
   */
  static controllerHasPendingAttempts(
    authority: unknown,
    cleanup: DescribeTableMandatoryCleanup,
  ): boolean {
    requireDescribeTableRateControllerAuthority(authority)
    return cleanup.#pendingAttempts.size > 0
  }

  /**
   * Waits for attempts authorized before one cleanup callback settled.
   *
   * @param authority - Module-private rate-controller authority.
   * @param cleanup - Exact cleanup capability joined by the controller.
   */
  static async controllerWaitForPendingAttempts(
    authority: unknown,
    cleanup: DescribeTableMandatoryCleanup,
  ): Promise<void> {
    requireDescribeTableRateControllerAuthority(authority)
    await Promise.allSettled(cleanup.#pendingAttempts)
  }

  /**
   * Prevents one settled cleanup callback from authorizing an attempt.
   *
   * @param authority - Module-private rate-controller authority.
   * @param cleanup - Exact cleanup capability closed by the controller.
   */
  static controllerCloseForNewAttempts(
    authority: unknown,
    cleanup: DescribeTableMandatoryCleanup,
  ): void {
    requireDescribeTableRateControllerAuthority(authority)
    cleanup.#acceptingAttempts = false
  }

  /**
   * Checks whether one callback retains an all-six cleanup permit.
   *
   * @param authority - Module-private rate-controller authority.
   * @param cleanup - Exact cleanup capability inspected by the controller.
   * @returns Whether another physical cleanup attempt may be consumed.
   */
  static controllerHasRemaining(
    authority: unknown,
    cleanup: DescribeTableMandatoryCleanup,
  ): boolean {
    requireDescribeTableRateControllerAuthority(authority)
    return cleanup.#remainingAttempts > 0
  }

  /**
   * Consumes one cleanup permit immediately before write-ahead CAS.
   *
   * @param authority - Module-private rate-controller authority.
   * @param cleanup - Exact cleanup capability consumed by the controller.
   */
  static controllerConsumeOne(
    authority: unknown,
    cleanup: DescribeTableMandatoryCleanup,
  ): void {
    requireDescribeTableRateControllerAuthority(authority)
    if (cleanup.#remainingAttempts <= 0) {
      throw new WorkspaceSearchMigrationDescribeTableRateError(
        'budget-capacity',
      )
    }
    cleanup.#remainingAttempts -= 1
    cleanup.#consumedAttempts += 1
  }

  /**
   * Reads attempts consumed by one exact cleanup callback.
   *
   * @param authority - Module-private rate-controller authority.
   * @param cleanup - Exact cleanup capability inspected by the controller.
   * @returns Non-negative local consumption count.
   */
  static controllerReadConsumedAttempts(
    authority: unknown,
    cleanup: DescribeTableMandatoryCleanup,
  ): number {
    requireDescribeTableRateControllerAuthority(authority)
    return cleanup.#consumedAttempts
  }

  /**
   * Checks whether interruption rejected cleanup before any mutation started.
   *
   * @param authority - Module-private rate-controller authority.
   * @param cleanup - Exact cleanup capability inspected by the controller.
   * @returns Whether the durable marker can be cleared without reconciliation.
   */
  static controllerCanClearBeforeDataMutation(
    authority: unknown,
    cleanup: DescribeTableMandatoryCleanup,
  ): boolean {
    requireDescribeTableRateControllerAuthority(authority)
    return cleanup.#dataMutationRejectedBeforeStart &&
      !cleanup.#dataMutationStarted
  }

  /**
   * Permanently invalidates one cleanup capability.
   *
   * @param authority - Module-private rate-controller authority.
   * @param cleanup - Exact cleanup capability released by the controller.
   */
  static controllerRelease(
    authority: unknown,
    cleanup: DescribeTableMandatoryCleanup,
  ): void {
    requireDescribeTableRateControllerAuthority(authority)
    cleanup.#acceptingAttempts = false
  }

  /**
   * Rejects use outside the exact mandatory cleanup callback.
   */
  #requireAcceptingAttempts(): void {
    if (!this.#acceptingAttempts) {
      throw new WorkspaceSearchMigrationDescribeTableRateError(
        'invalid-lifecycle',
      )
    }
  }
}

/** Exact pending-cleanup check captured before callers observe cleanup. */
const hasDescribeTableMandatoryCleanupPendingAttempts =
  DescribeTableMandatoryCleanup.controllerHasPendingAttempts

/** Exact pending-cleanup join captured before callers observe cleanup. */
const waitForDescribeTableMandatoryCleanupPendingAttempts =
  DescribeTableMandatoryCleanup.controllerWaitForPendingAttempts

/** Exact cleanup close captured before callers observe cleanup. */
const closeDescribeTableMandatoryCleanupForNewAttempts =
  DescribeTableMandatoryCleanup.controllerCloseForNewAttempts

/** Exact cleanup-capacity check captured before callers observe cleanup. */
const hasDescribeTableMandatoryCleanupRemaining =
  DescribeTableMandatoryCleanup.controllerHasRemaining

/** Exact cleanup-permit consumer captured before callers observe cleanup. */
const consumeDescribeTableMandatoryCleanupAttempt =
  DescribeTableMandatoryCleanup.controllerConsumeOne

/** Exact cleanup-consumption reader captured before callers observe cleanup. */
const readDescribeTableMandatoryCleanupConsumedAttempts =
  DescribeTableMandatoryCleanup.controllerReadConsumedAttempts

/** Exact pre-mutation clearability check captured before caller observation. */
const canClearDescribeTableMandatoryCleanupBeforeDataMutation =
  DescribeTableMandatoryCleanup.controllerCanClearBeforeDataMutation

/** Exact cleanup release captured before callers observe cleanup. */
const releaseDescribeTableMandatoryCleanup =
  DescribeTableMandatoryCleanup.controllerRelease

Object.freeze(DescribeTableMandatoryCleanup.prototype)
Object.freeze(DescribeTableMandatoryCleanup)

/**
 * Creates detached validated dependencies without trusting accessors twice.
 */
function createRegistryDependencies(
  input: CreateWorkspaceSearchMigrationDescribeTableRateRegistryInput,
): RateRegistryDependencies {
  let policy: WorkspaceSearchMigrationDescribeTableRatePolicy
  let checkpointStore:
    WorkspaceSearchMigrationDescribeTableRateCheckpointStore
  let clock: WorkspaceSearchMigrationDescribeTableRateClock | undefined
  let epochClock:
    WorkspaceSearchMigrationDescribeTableRateEpochClock | undefined
  let waiter: WorkspaceSearchMigrationDescribeTableRateWaiter | undefined
  let deadlineScheduler:
    WorkspaceSearchMigrationDescribeTableRateDeadlineScheduler | undefined
  let random: WorkspaceSearchMigrationDescribeTableRateRandom | undefined
  let recorder: WorkspaceSearchMigrationDescribeTableRateRecorder | undefined
  try {
    policy = detachAndValidatePolicy(input.policy)
    checkpointStore = input.checkpointStore
    clock = input.clock
    epochClock = input.epochClock
    waiter = input.waiter
    deadlineScheduler = input.deadlineScheduler
    random = input.random
    recorder = input.recorder
  } catch {
    throw new WorkspaceSearchMigrationDescribeTableRateError(
      'invalid-lifecycle',
    )
  }
  const selectedWaiter = waiter ?? defaultRateWaiter
  const selectedDeadlineScheduler =
    deadlineScheduler ?? defaultRateDeadlineScheduler
  if (
    typeof checkpointStore !== 'object' ||
    checkpointStore === null ||
    typeof selectedWaiter !== 'object' ||
    selectedWaiter === null ||
    typeof selectedDeadlineScheduler !== 'object' ||
    selectedDeadlineScheduler === null ||
    (
      recorder !== undefined &&
      (typeof recorder !== 'object' || recorder === null)
    )
  ) {
    throw new WorkspaceSearchMigrationDescribeTableRateError(
      'invalid-lifecycle',
    )
  }
  let load: WorkspaceSearchMigrationDescribeTableRateCheckpointStore['load']
  let compareAndSwap:
    WorkspaceSearchMigrationDescribeTableRateCheckpointStore['compareAndSwap']
  let wait: WorkspaceSearchMigrationDescribeTableRateWaiter['wait']
  let schedule:
    WorkspaceSearchMigrationDescribeTableRateDeadlineScheduler['schedule']
  let record:
    WorkspaceSearchMigrationDescribeTableRateRecorder['record'] | undefined
  try {
    load = checkpointStore.load
    compareAndSwap = checkpointStore.compareAndSwap
    wait = selectedWaiter.wait
    schedule = selectedDeadlineScheduler.schedule
    record = recorder?.record
  } catch {
    throw new WorkspaceSearchMigrationDescribeTableRateError(
      'invalid-lifecycle',
    )
  }
  if (
    typeof load !== 'function' ||
    typeof compareAndSwap !== 'function' ||
    typeof wait !== 'function' ||
    typeof schedule !== 'function' ||
    (recorder !== undefined && typeof record !== 'function')
  ) {
    throw new WorkspaceSearchMigrationDescribeTableRateError(
      'invalid-lifecycle',
    )
  }
  const capturedCheckpointStore:
    WorkspaceSearchMigrationDescribeTableRateCheckpointStore =
      Object.freeze({
        load: (scopeBindingDigest: string) =>
          Reflect.apply(load, checkpointStore, [scopeBindingDigest]),
        compareAndSwap: (
          write: WorkspaceSearchMigrationDescribeTableRateCheckpointWrite,
        ) =>
          Reflect.apply(compareAndSwap, checkpointStore, [write]),
      })
  const capturedWaiter:
    WorkspaceSearchMigrationDescribeTableRateWaiter = Object.freeze({
      wait: (delayMilliseconds: number, signal: AbortSignal) =>
        Reflect.apply(wait, selectedWaiter, [delayMilliseconds, signal]),
    })
  const capturedDeadlineScheduler:
    WorkspaceSearchMigrationDescribeTableRateDeadlineScheduler =
      Object.freeze({
        schedule: (
          delayMilliseconds: number,
          callback: () => void,
        ) => {
          const handle = Reflect.apply(
            schedule,
            selectedDeadlineScheduler,
            [delayMilliseconds, callback],
          )
          if (
            typeof handle !== 'object' ||
            handle === null
          ) {
            throw new WorkspaceSearchMigrationDescribeTableRateError(
              'invalid-lifecycle',
            )
          }
          let cancel:
            WorkspaceSearchMigrationDescribeTableRateDeadlineHandle['cancel']
          try {
            cancel = handle.cancel
          } catch {
            throw new WorkspaceSearchMigrationDescribeTableRateError(
              'invalid-lifecycle',
            )
          }
          if (typeof cancel !== 'function') {
            throw new WorkspaceSearchMigrationDescribeTableRateError(
              'invalid-lifecycle',
            )
          }
          return Object.freeze({
            cancel: (): void => Reflect.apply(cancel, handle, []),
          })
        },
      })
  const capturedRecorder:
    WorkspaceSearchMigrationDescribeTableRateRecorder | undefined =
      recorder === undefined || record === undefined
        ? undefined
        : Object.freeze({
          record: (
            observation:
              WorkspaceSearchMigrationDescribeTableRateObservation,
          ): void => {
            Reflect.apply(record, recorder, [observation])
          },
        })
  return Object.freeze({
    policy,
    checkpointStore: capturedCheckpointStore,
    clock: clock ?? defaultRateClock,
    epochClock: epochClock ?? Date.now,
    waiter: capturedWaiter,
    deadlineScheduler: capturedDeadlineScheduler,
    random: random ?? Math.random,
    recorder: capturedRecorder,
  })
}

/**
 * Snapshots and validates every explicit policy scalar.
 */
function detachAndValidatePolicy(
  policy: WorkspaceSearchMigrationDescribeTableRatePolicy,
): WorkspaceSearchMigrationDescribeTableRatePolicy {
  const snapshot = {
    policyVersion: policy.policyVersion,
    maximumAttemptsPerWindow: policy.maximumAttemptsPerWindow,
    maximumAttemptsPerLifecycle: policy.maximumAttemptsPerLifecycle,
    checkpointPageAttemptCapacity: policy.checkpointPageAttemptCapacity,
    windowMilliseconds: policy.windowMilliseconds,
    minimumAttemptIntervalMilliseconds:
      policy.minimumAttemptIntervalMilliseconds,
    minimumPageIntervalMilliseconds:
      policy.minimumPageIntervalMilliseconds,
    maximumAdmissionWaitMilliseconds:
      policy.maximumAdmissionWaitMilliseconds,
    throttleBackoffInitialMilliseconds:
      policy.throttleBackoffInitialMilliseconds,
    throttleBackoffMaximumMilliseconds:
      policy.throttleBackoffMaximumMilliseconds,
  }
  if (
    typeof snapshot.policyVersion !== 'string' ||
    !/^[a-f0-9]{64}$/u.test(snapshot.policyVersion) ||
    snapshot.maximumAttemptsPerLifecycle <
      WORKSPACE_SEARCH_MIGRATION_DESCRIBE_TABLE_PAGE_BASELINE_ATTEMPTS ||
    snapshot.checkpointPageAttemptCapacity <
      WORKSPACE_SEARCH_MIGRATION_DESCRIBE_TABLE_PAGE_BASELINE_ATTEMPTS ||
    snapshot.checkpointPageAttemptCapacity >
      snapshot.maximumAttemptsPerLifecycle ||
    snapshot.maximumAttemptsPerLifecycle -
        snapshot.checkpointPageAttemptCapacity <
      WORKSPACE_SEARCH_MIGRATION_DESCRIBE_TABLE_CLEANUP_RECOVERY_ATTEMPTS ||
    snapshot.checkpointPageAttemptCapacity >
      snapshot.maximumAttemptsPerWindow
  ) {
    throw new WorkspaceSearchMigrationDescribeTableRateError(
      'invalid-lifecycle',
    )
  }
  for (const value of [
    snapshot.maximumAttemptsPerWindow,
    snapshot.maximumAttemptsPerLifecycle,
    snapshot.checkpointPageAttemptCapacity,
    snapshot.windowMilliseconds,
    snapshot.minimumAttemptIntervalMilliseconds,
    snapshot.minimumPageIntervalMilliseconds,
    snapshot.maximumAdmissionWaitMilliseconds,
    snapshot.throttleBackoffInitialMilliseconds,
    snapshot.throttleBackoffMaximumMilliseconds,
  ]) {
    if (!Number.isSafeInteger(value) || value < 1) {
      throw new WorkspaceSearchMigrationDescribeTableRateError(
        'invalid-lifecycle',
      )
    }
  }
  if (
    snapshot.throttleBackoffInitialMilliseconds >
      snapshot.throttleBackoffMaximumMilliseconds
  ) {
    throw new WorkspaceSearchMigrationDescribeTableRateError(
      'invalid-lifecycle',
    )
  }
  return Object.freeze(snapshot)
}

/**
 * Parses one untrusted exact-shape durable checkpoint.
 *
 * @param value - Untrusted store value.
 * @param scopeBindingDigest - Expected opaque scope binding.
 * @param policy - Expected complete reviewed policy.
 * @param transportBindingDigest - Expected fixed transport contract binding.
 * @returns Detached validated checkpoint.
 */
function parseRateCheckpoint(
  value: unknown,
  scopeBindingDigest: string,
  policy: WorkspaceSearchMigrationDescribeTableRatePolicy,
  transportBindingDigest: string,
): WorkspaceSearchMigrationDescribeTableRateCheckpoint {
  try {
    const record = requireExactDataObject(value, [
      'attemptCount',
      'attemptInFlight',
      'attemptInFlightNonce',
      'budgetStopCount',
      'cadenceWaitCount',
      'cadenceWaitMilliseconds',
      'capturedAtEpochMilliseconds',
      'fenceToken',
      'forfeitedAttemptCount',
      'mandatoryCleanupRequired',
      'maximumInFlight',
      'policy',
      'reservationKind',
      'reservedAttempts',
      'revision',
      'scopeBindingDigest',
      'sequence',
      'throttleCount',
      'transportBindingDigest',
      'version',
      'writeNonce',
    ])
    const version = Reflect.get(record, 'version')
    const storedScopeBindingDigest = Reflect.get(
      record,
      'scopeBindingDigest',
    )
    const storedTransportBindingDigest = Reflect.get(
      record,
      'transportBindingDigest',
    )
    const storedPolicy = parseCheckpointPolicy(
      Reflect.get(record, 'policy'),
    )
    const revision = Reflect.get(record, 'revision')
    const fenceToken = Reflect.get(record, 'fenceToken')
    const writeNonce = Reflect.get(record, 'writeNonce')
    const capturedAtEpochMilliseconds = Reflect.get(
      record,
      'capturedAtEpochMilliseconds',
    )
    const attemptCount = Reflect.get(record, 'attemptCount')
    const forfeitedAttemptCount = Reflect.get(
      record,
      'forfeitedAttemptCount',
    )
    const reservedAttempts = Reflect.get(record, 'reservedAttempts')
    const reservationKind = Reflect.get(record, 'reservationKind')
    const mandatoryCleanupRequired = Reflect.get(
      record,
      'mandatoryCleanupRequired',
    )
    const attemptInFlight = Reflect.get(record, 'attemptInFlight')
    const attemptInFlightNonce = Reflect.get(
      record,
      'attemptInFlightNonce',
    )
    const sequence = Reflect.get(record, 'sequence')
    const throttleCount = Reflect.get(record, 'throttleCount')
    const budgetStopCount = Reflect.get(record, 'budgetStopCount')
    const cadenceWaitCount = Reflect.get(record, 'cadenceWaitCount')
    const cadenceWaitMilliseconds = Reflect.get(
      record,
      'cadenceWaitMilliseconds',
    )
    const maximumInFlight = Reflect.get(record, 'maximumInFlight')
    if (
      !isNonNegativeSafeInteger(revision) ||
      !isNonNegativeSafeInteger(fenceToken) ||
      !isNonNegativeSafeInteger(capturedAtEpochMilliseconds) ||
      !isNonNegativeSafeInteger(attemptCount) ||
      !isNonNegativeSafeInteger(forfeitedAttemptCount) ||
      !isNonNegativeSafeInteger(reservedAttempts) ||
      !isNonNegativeSafeInteger(sequence) ||
      !isNonNegativeSafeInteger(throttleCount) ||
      !isNonNegativeSafeInteger(budgetStopCount) ||
      !isNonNegativeSafeInteger(cadenceWaitCount) ||
      !isNonNegativeSafeInteger(cadenceWaitMilliseconds)
    ) {
      throw new WorkspaceSearchMigrationDescribeTableRateError(
        'invalid-lifecycle',
      )
    }
    if (typeof attemptInFlight !== 'boolean') {
      throw new WorkspaceSearchMigrationDescribeTableRateError(
        'invalid-lifecycle',
      )
    }
    let detachedAttemptInFlightNonce: string | null
    if (attemptInFlight) {
      if (
        typeof attemptInFlightNonce !== 'string' ||
        !/^[a-f0-9]{64}$/u.test(attemptInFlightNonce)
      ) {
        throw new WorkspaceSearchMigrationDescribeTableRateError(
          'invalid-lifecycle',
        )
      }
      detachedAttemptInFlightNonce = attemptInFlightNonce
    } else {
      if (attemptInFlightNonce !== null) {
        throw new WorkspaceSearchMigrationDescribeTableRateError(
          'invalid-lifecycle',
        )
      }
      detachedAttemptInFlightNonce = null
    }
    if (
      version !==
        WORKSPACE_SEARCH_MIGRATION_DESCRIBE_TABLE_RATE_CHECKPOINT_VERSION ||
      typeof storedScopeBindingDigest !== 'string' ||
      storedScopeBindingDigest !== scopeBindingDigest ||
      typeof storedTransportBindingDigest !== 'string' ||
      storedTransportBindingDigest !== transportBindingDigest ||
      typeof writeNonce !== 'string' ||
      !/^[a-f0-9]{64}$/u.test(writeNonce) ||
      !areRatePoliciesEqual(storedPolicy, policy) ||
      (
        reservationKind !== 'none' &&
        reservationKind !== 'checkpoint-page'
      ) ||
      (
        reservationKind === 'none'
          ? reservedAttempts !== 0
          : reservedAttempts < 1 ||
            reservedAttempts > policy.checkpointPageAttemptCapacity
      ) ||
      typeof mandatoryCleanupRequired !== 'boolean' ||
      sequence !== attemptCount ||
      (
        maximumInFlight !== 0 &&
        maximumInFlight !== 1
      ) ||
      attemptCount +
        forfeitedAttemptCount +
        reservedAttempts >
        policy.maximumAttemptsPerLifecycle
    ) {
      throw new WorkspaceSearchMigrationDescribeTableRateError(
        'invalid-lifecycle',
      )
    }
    return Object.freeze({
      version:
        WORKSPACE_SEARCH_MIGRATION_DESCRIBE_TABLE_RATE_CHECKPOINT_VERSION,
      scopeBindingDigest: storedScopeBindingDigest,
      transportBindingDigest: storedTransportBindingDigest,
      policy: storedPolicy,
      revision,
      fenceToken,
      writeNonce,
      capturedAtEpochMilliseconds,
      attemptCount,
      forfeitedAttemptCount,
      reservedAttempts,
      reservationKind,
      mandatoryCleanupRequired,
      attemptInFlight,
      attemptInFlightNonce: detachedAttemptInFlightNonce,
      sequence,
      throttleCount,
      budgetStopCount,
      cadenceWaitCount,
      cadenceWaitMilliseconds,
      maximumInFlight,
    })
  } catch {
    throw new WorkspaceSearchMigrationDescribeTableRateError(
      'invalid-lifecycle',
    )
  }
}

/**
 * Parses the nested complete policy from a durable checkpoint.
 *
 * @param value - Untrusted nested policy.
 * @returns Detached validated policy.
 */
function parseCheckpointPolicy(
  value: unknown,
): WorkspaceSearchMigrationDescribeTableRatePolicy {
  const record = requireExactDataObject(value, [
    'checkpointPageAttemptCapacity',
    'maximumAdmissionWaitMilliseconds',
    'maximumAttemptsPerLifecycle',
    'maximumAttemptsPerWindow',
    'minimumAttemptIntervalMilliseconds',
    'minimumPageIntervalMilliseconds',
    'policyVersion',
    'throttleBackoffInitialMilliseconds',
    'throttleBackoffMaximumMilliseconds',
    'windowMilliseconds',
  ])
  const policyVersion = Reflect.get(record, 'policyVersion')
  const maximumAttemptsPerWindow = Reflect.get(
    record,
    'maximumAttemptsPerWindow',
  )
  const maximumAttemptsPerLifecycle = Reflect.get(
    record,
    'maximumAttemptsPerLifecycle',
  )
  const checkpointPageAttemptCapacity = Reflect.get(
    record,
    'checkpointPageAttemptCapacity',
  )
  const windowMilliseconds = Reflect.get(record, 'windowMilliseconds')
  const minimumAttemptIntervalMilliseconds = Reflect.get(
    record,
    'minimumAttemptIntervalMilliseconds',
  )
  const minimumPageIntervalMilliseconds = Reflect.get(
    record,
    'minimumPageIntervalMilliseconds',
  )
  const maximumAdmissionWaitMilliseconds = Reflect.get(
    record,
    'maximumAdmissionWaitMilliseconds',
  )
  const throttleBackoffInitialMilliseconds = Reflect.get(
    record,
    'throttleBackoffInitialMilliseconds',
  )
  const throttleBackoffMaximumMilliseconds = Reflect.get(
    record,
    'throttleBackoffMaximumMilliseconds',
  )
  if (
    typeof policyVersion !== 'string' ||
    typeof maximumAttemptsPerWindow !== 'number' ||
    typeof maximumAttemptsPerLifecycle !== 'number' ||
    typeof checkpointPageAttemptCapacity !== 'number' ||
    typeof windowMilliseconds !== 'number' ||
    typeof minimumAttemptIntervalMilliseconds !== 'number' ||
    typeof minimumPageIntervalMilliseconds !== 'number' ||
    typeof maximumAdmissionWaitMilliseconds !== 'number' ||
    typeof throttleBackoffInitialMilliseconds !== 'number' ||
    typeof throttleBackoffMaximumMilliseconds !== 'number'
  ) {
    throw new WorkspaceSearchMigrationDescribeTableRateError(
      'invalid-lifecycle',
    )
  }
  return detachAndValidatePolicy({
    policyVersion,
    maximumAttemptsPerWindow,
    maximumAttemptsPerLifecycle,
    checkpointPageAttemptCapacity,
    windowMilliseconds,
    minimumAttemptIntervalMilliseconds,
    minimumPageIntervalMilliseconds,
    maximumAdmissionWaitMilliseconds,
    throttleBackoffInitialMilliseconds,
    throttleBackoffMaximumMilliseconds,
  })
}

/**
 * Requires a plain exact-key object containing data properties only.
 *
 * @param value - Untrusted candidate.
 * @param expectedKeys - Strictly sorted exact own enumerable keys.
 * @returns Frozen detached record safe for subsequent reflected data reads.
 */
function requireExactDataObject(
  value: unknown,
  expectedKeys: readonly string[],
): Readonly<Record<string, unknown>> {
  let previousExpectedKey: string | undefined
  for (const expectedKey of expectedKeys) {
    if (
      previousExpectedKey !== undefined &&
      previousExpectedKey >= expectedKey
    ) {
      throw new WorkspaceSearchMigrationDescribeTableRateError(
        'invalid-lifecycle',
      )
    }
    previousExpectedKey = expectedKey
  }
  if (
    typeof value !== 'object' ||
    value === null ||
    Object.getPrototypeOf(value) !== Object.prototype
  ) {
    throw new WorkspaceSearchMigrationDescribeTableRateError(
      'invalid-lifecycle',
    )
  }
  const ownKeys = Reflect.ownKeys(value)
  const keys: string[] = []
  for (const key of ownKeys) {
    if (typeof key !== 'string') {
      throw new WorkspaceSearchMigrationDescribeTableRateError(
        'invalid-lifecycle',
      )
    }
    keys.push(key)
  }
  keys.sort()
  if (
    keys.length !== expectedKeys.length ||
    keys.some((key, index) => key !== expectedKeys[index])
  ) {
    throw new WorkspaceSearchMigrationDescribeTableRateError(
      'invalid-lifecycle',
    )
  }
  const snapshot: Record<string, unknown> = {}
  for (const key of expectedKeys) {
    const descriptor = Reflect.getOwnPropertyDescriptor(value, key)
    if (
      descriptor === undefined ||
      !descriptor.enumerable ||
      !('value' in descriptor)
    ) {
      throw new WorkspaceSearchMigrationDescribeTableRateError(
        'invalid-lifecycle',
      )
    }
    Object.defineProperty(snapshot, key, {
      configurable: true,
      enumerable: true,
      value: descriptor.value,
      writable: true,
    })
  }
  return Object.freeze(snapshot)
}

/**
 * Narrows an untrusted scalar to a non-negative safe integer.
 *
 * @param value - Untrusted scalar.
 * @returns Whether the value is a non-negative safe integer.
 */
function isNonNegativeSafeInteger(value: unknown): value is number {
  return typeof value === 'number' &&
    Number.isSafeInteger(value) &&
    value >= 0
}

/**
 * Compares every policy scalar without trusting a caller-owned version label.
 *
 * @param left - First detached policy.
 * @param right - Second detached policy.
 * @returns Whether every reviewed scalar is equal.
 */
function areRatePoliciesEqual(
  left: WorkspaceSearchMigrationDescribeTableRatePolicy,
  right: WorkspaceSearchMigrationDescribeTableRatePolicy,
): boolean {
  return left.policyVersion === right.policyVersion &&
    left.maximumAttemptsPerWindow === right.maximumAttemptsPerWindow &&
    left.maximumAttemptsPerLifecycle ===
      right.maximumAttemptsPerLifecycle &&
    left.checkpointPageAttemptCapacity ===
      right.checkpointPageAttemptCapacity &&
    left.windowMilliseconds === right.windowMilliseconds &&
    left.minimumAttemptIntervalMilliseconds ===
      right.minimumAttemptIntervalMilliseconds &&
    left.minimumPageIntervalMilliseconds ===
      right.minimumPageIntervalMilliseconds &&
    left.maximumAdmissionWaitMilliseconds ===
      right.maximumAdmissionWaitMilliseconds &&
    left.throttleBackoffInitialMilliseconds ===
      right.throttleBackoffInitialMilliseconds &&
    left.throttleBackoffMaximumMilliseconds ===
      right.throttleBackoffMaximumMilliseconds
}

/**
 * Detaches one already validated checkpoint for callers.
 *
 * @param checkpoint - Internal immutable checkpoint.
 * @returns Detached immutable checkpoint.
 */
function detachRateCheckpoint(
  checkpoint: WorkspaceSearchMigrationDescribeTableRateCheckpoint,
): WorkspaceSearchMigrationDescribeTableRateCheckpoint {
  return Object.freeze({
    ...checkpoint,
    policy: Object.freeze({ ...checkpoint.policy }),
  })
}

/**
 * Compares two validated exact-shape checkpoints.
 *
 * @param left - First validated checkpoint.
 * @param right - Second validated checkpoint.
 * @returns Whether every durable field is exactly equal.
 */
function areRateCheckpointsEqual(
  left: WorkspaceSearchMigrationDescribeTableRateCheckpoint,
  right: WorkspaceSearchMigrationDescribeTableRateCheckpoint,
): boolean {
  return JSON.stringify(left) === JSON.stringify(right)
}

/**
 * Snapshots and validates one internal account/region scope claim.
 */
function detachAndValidateClaim(
  input: ClaimWorkspaceSearchMigrationDescribeTableRateLifecycleInput,
): ValidatedRateLifecycleClaim {
  let account: string
  let region: string
  let fenceToken: number
  let bootstrap: boolean
  let recoverInterruptedCleanup: boolean
  let recoverInterruptedAttempt: boolean
  let signal: AbortSignal | undefined
  try {
    account = input.account
    region = input.region
    fenceToken = input.fenceToken
    bootstrap = input.bootstrap
    recoverInterruptedCleanup = input.recoverInterruptedCleanup
    recoverInterruptedAttempt = input.recoverInterruptedAttempt
    signal = input.signal
  } catch {
    throw new WorkspaceSearchMigrationDescribeTableRateError(
      'invalid-lifecycle',
    )
  }
  requireAbortSignal(signal)
  if (
    typeof account !== 'string' ||
    typeof region !== 'string' ||
    !/^\d{12}$/u.test(account) ||
    !/^[a-z0-9]+(?:-[a-z0-9]+)+$/u.test(region) ||
    !Number.isSafeInteger(fenceToken) ||
    fenceToken < 0 ||
    typeof bootstrap !== 'boolean' ||
    typeof recoverInterruptedCleanup !== 'boolean' ||
    typeof recoverInterruptedAttempt !== 'boolean' ||
    (
      bootstrap &&
      (
        recoverInterruptedCleanup ||
        recoverInterruptedAttempt
      )
    )
  ) {
    throw new WorkspaceSearchMigrationDescribeTableRateError(
      'invalid-lifecycle',
    )
  }
  return Object.freeze({
    account,
    region,
    scopeBindingDigest:
      createWorkspaceSearchMigrationDescribeTableScopeBindingDigest(
        account,
        region,
      ),
    transportBindingDigest:
      createWorkspaceSearchMigrationDescribeTableTransportBindingDigest(
        account,
        region,
        resolveWorkspaceSearchMigrationOfficialDynamoDbEndpoint(region),
        WORKSPACE_SEARCH_MIGRATION_DESCRIBE_TABLE_SDK_MAX_ATTEMPTS,
      ),
    fenceToken,
    bootstrap,
    recoverInterruptedCleanup,
    recoverInterruptedAttempt,
    ...(signal === undefined ? {} : { signal }),
  })
}

/** Stops a lifecycle claim before its next durable mutation can start. */
function requireRateClaimSignalActive(signal: AbortSignal | undefined): void {
  if (signal?.aborted === true) {
    throw new WorkspaceSearchMigrationDescribeTableRateError(
      'interrupted',
    )
  }
}

/**
 * Snapshots one page request before the first admission await.
 */
function detachCheckpointPageInput(
  input: RunWorkspaceSearchMigrationDescribeTableCheckpointPageInput,
): RunWorkspaceSearchMigrationDescribeTableCheckpointPageInput {
  let signal: AbortSignal | undefined
  try {
    signal = input.signal
  } catch {
    throw new WorkspaceSearchMigrationDescribeTableRateError(
      'invalid-lifecycle',
    )
  }
  requireAbortSignal(signal)
  return signal === undefined ? {} : { signal }
}

/**
 * Snapshots and validates one attempt request.
 */
function detachAndValidateAttemptInput(
  input: RunWorkspaceSearchMigrationDescribeTableAttemptInput,
): RunWorkspaceSearchMigrationDescribeTableAttemptInput {
  let phase: WorkspaceSearchMigrationDescribeTablePhase
  let signal: AbortSignal | undefined
  try {
    phase = input.phase
    signal = input.signal
  } catch {
    throw new WorkspaceSearchMigrationDescribeTableRateError(
      'invalid-lifecycle',
    )
  }
  if (
    phase !== 'measurement' &&
    phase !== 'checkpoint-page' &&
    phase !== 'integrity-check' &&
    phase !== 'pre-send-guard' &&
    phase !== 'post-send-guard' &&
    phase !== 'reconciliation'
  ) {
    throw new WorkspaceSearchMigrationDescribeTableRateError(
      'invalid-lifecycle',
    )
  }
  requireAbortSignal(signal)
  return signal === undefined ? { phase } : { phase, signal }
}

/**
 * Requires one optional cancellation source to be a native AbortSignal.
 */
function requireAbortSignal(
  signal: AbortSignal | undefined,
): void {
  if (
    signal !== undefined &&
    !(signal instanceof AbortSignal)
  ) {
    throw new WorkspaceSearchMigrationDescribeTableRateError(
      'invalid-lifecycle',
    )
  }
}

/**
 * Creates one explicitly bootstrapped empty account/region ledger.
 *
 * @param scopeBindingDigest - Opaque durable scope binding.
 * @param transportBindingDigest - Fixed transport contract binding.
 * @param dependencies - Validated clocks and safety policy.
 * @returns Empty process-local scope awaiting its bootstrap CAS.
 */
function createFreshRateScopeState(
  scopeBindingDigest: string,
  transportBindingDigest: string,
  dependencies: RateRegistryDependencies,
): RateScopeState {
  const now = readInitialRateClock(dependencies.clock)
  const safetyHorizon = Math.max(
    dependencies.policy.windowMilliseconds,
    dependencies.policy.minimumAttemptIntervalMilliseconds,
    dependencies.policy.minimumPageIntervalMilliseconds,
    dependencies.policy.throttleBackoffMaximumMilliseconds,
  )
  const coldStartNotBefore = now + safetyHorizon
  if (!Number.isSafeInteger(coldStartNotBefore)) {
    throw new WorkspaceSearchMigrationDescribeTableRateError(
      'invalid-lifecycle',
    )
  }
  return {
    scopeBindingDigest,
    transportBindingDigest,
    checkpointRevision: null,
    lastCheckpoint: undefined,
    attemptStarts: [],
    reservedAttempts: 0,
    mandatoryCleanupRequired: false,
    attemptInFlight: false,
    attemptInFlightNonce: null,
    attemptOwner: undefined,
    attemptCompletionPendingNonce: null,
    lastAttemptStartedAt: undefined,
    lastPageStartedAt: undefined,
    resumeNotBefore: 0,
    coldStartNotBefore,
    consecutiveThrottles: 0,
    sequence: 0,
    lastObservedAt: now,
    lastBudgetStopSignature: undefined,
    evidence: {
      attemptCount: 0,
      forfeitedAttemptCount: 0,
      throttleCount: 0,
      budgetStopCount: 0,
      cadenceWaitCount: 0,
      cadenceWaitMilliseconds: 0,
      maximumInFlight: 0,
    },
    tail: Promise.resolve(),
    operationGeneration: 0,
    checkpointTail: Promise.resolve(),
    pendingAttemptCount: 0,
    pendingPageAdmissionCount: 0,
    pageOwner: undefined,
    pageReservationToken: undefined,
    pageBarrier: Promise.resolve(),
    releasePageBarrier: undefined,
    cleanupOwner: undefined,
    cleanupBarrier: Promise.resolve(),
    releaseCleanupBarrier: undefined,
    current: undefined,
  }
}

/**
 * Conservatively detaches local page ownership before authorized recovery.
 *
 * @param scope - Existing process-local state with a durable recovery marker.
 * @param dependencies - Validated clocks and safety policy.
 */
function prepareLocalRateScopeForInterruptedRecovery(
  scope: RateScopeState,
  dependencies: RateRegistryDependencies,
): void {
  const now = readInitialRateClock(dependencies.clock)
  const safetyHorizon = Math.max(
    dependencies.policy.windowMilliseconds,
    dependencies.policy.minimumAttemptIntervalMilliseconds,
    dependencies.policy.minimumPageIntervalMilliseconds,
    dependencies.policy.throttleBackoffMaximumMilliseconds,
  )
  const coldStartNotBefore = now + safetyHorizon
  const forfeitedAttemptCount =
    scope.evidence.forfeitedAttemptCount + scope.reservedAttempts
  if (
    !Number.isSafeInteger(coldStartNotBefore) ||
    !Number.isSafeInteger(forfeitedAttemptCount) ||
    forfeitedAttemptCount >
      dependencies.policy.maximumAttemptsPerLifecycle
  ) {
    throw new WorkspaceSearchMigrationDescribeTableRateError(
      'invalid-lifecycle',
    )
  }
  scope.evidence.forfeitedAttemptCount = forfeitedAttemptCount
  scope.reservedAttempts = 0
  scope.attemptStarts.length = 0
  scope.lastAttemptStartedAt = undefined
  scope.lastPageStartedAt = undefined
  scope.resumeNotBefore = 0
  scope.coldStartNotBefore = Math.max(
    scope.coldStartNotBefore,
    coldStartNotBefore,
  )
  scope.lastObservedAt = now
  scope.attemptOwner = undefined
  scope.attemptCompletionPendingNonce = null
  scope.pageOwner = undefined
  scope.pageReservationToken = undefined
  const releasePage = scope.releasePageBarrier
  scope.releasePageBarrier = undefined
  releasePage?.()
}

/**
 * Restores one checkpoint and forfeits every interrupted page reservation.
 *
 * @param checkpoint - Exact validated durable predecessor.
 * @param dependencies - Validated clocks and safety policy.
 * @returns Recovered scope with a full conservative safety horizon.
 */
function createRestoredRateScopeState(
  checkpoint: WorkspaceSearchMigrationDescribeTableRateCheckpoint,
  dependencies: RateRegistryDependencies,
): RateScopeState {
  const now = readInitialRateClock(dependencies.clock)
  const safetyHorizon = Math.max(
    dependencies.policy.windowMilliseconds,
    dependencies.policy.minimumAttemptIntervalMilliseconds,
    dependencies.policy.minimumPageIntervalMilliseconds,
    dependencies.policy.throttleBackoffMaximumMilliseconds,
  )
  const coldStartNotBefore = now + safetyHorizon
  const forfeitedAttemptCount =
    checkpoint.forfeitedAttemptCount + checkpoint.reservedAttempts
  if (
    !Number.isSafeInteger(coldStartNotBefore) ||
    !Number.isSafeInteger(forfeitedAttemptCount)
  ) {
    throw new WorkspaceSearchMigrationDescribeTableRateError(
      'invalid-lifecycle',
    )
  }
  return {
    scopeBindingDigest: checkpoint.scopeBindingDigest,
    transportBindingDigest: checkpoint.transportBindingDigest,
    checkpointRevision: checkpoint.revision,
    lastCheckpoint: checkpoint,
    attemptStarts: [],
    reservedAttempts: 0,
    mandatoryCleanupRequired:
      checkpoint.mandatoryCleanupRequired,
    attemptInFlight: checkpoint.attemptInFlight,
    attemptInFlightNonce: checkpoint.attemptInFlightNonce,
    attemptOwner: undefined,
    attemptCompletionPendingNonce: null,
    lastAttemptStartedAt: undefined,
    lastPageStartedAt: undefined,
    resumeNotBefore: 0,
    coldStartNotBefore,
    consecutiveThrottles: 0,
    sequence: checkpoint.sequence,
    lastObservedAt: now,
    lastBudgetStopSignature: undefined,
    evidence: {
      attemptCount: checkpoint.attemptCount,
      forfeitedAttemptCount,
      throttleCount: checkpoint.throttleCount,
      budgetStopCount: checkpoint.budgetStopCount,
      cadenceWaitCount: checkpoint.cadenceWaitCount,
      cadenceWaitMilliseconds: checkpoint.cadenceWaitMilliseconds,
      maximumInFlight: checkpoint.maximumInFlight,
    },
    tail: Promise.resolve(),
    operationGeneration: 0,
    checkpointTail: Promise.resolve(),
    pendingAttemptCount: 0,
    pendingPageAdmissionCount: 0,
    pageOwner: undefined,
    pageReservationToken: undefined,
    pageBarrier: Promise.resolve(),
    releasePageBarrier: undefined,
    cleanupOwner: undefined,
    cleanupBarrier: Promise.resolve(),
    releaseCleanupBarrier: undefined,
    current: undefined,
  }
}

/**
 * Reads the initial monotonic clock used to anchor a recovery cooldown.
 *
 * @param clock - Injected process-local monotonic clock.
 * @returns Non-negative safe integer milliseconds.
 */
function readInitialRateClock(
  clock: WorkspaceSearchMigrationDescribeTableRateClock,
): number {
  let now: number
  try {
    now = clock()
  } catch {
    throw new WorkspaceSearchMigrationDescribeTableRateError(
      'invalid-lifecycle',
    )
  }
  if (!Number.isSafeInteger(now) || now < 0) {
    throw new WorkspaceSearchMigrationDescribeTableRateError(
      'invalid-lifecycle',
    )
  }
  return now
}

/**
 * Classifies throttling without exposing or forwarding raw error properties.
 */
function isSafeThrottlingError(error: unknown): boolean {
  if (!(error instanceof Error)) return false
  let name: string
  let throttling: boolean | undefined
  try {
    name = error.name
    const retryable = Reflect.get(error, '$retryable')
    if (
      typeof retryable === 'object' &&
      retryable !== null
    ) {
      const value = Reflect.get(retryable, 'throttling')
      throttling = typeof value === 'boolean' ? value : undefined
    }
  } catch {
    return false
  }
  return isThrottlingError({
    name,
    message: 'Classified DescribeTable failure.',
    ...(throttling === undefined
      ? {}
      : { $retryable: { throttling } }),
  })
}

/**
 * Identifies bounded rate stops that may be retried by the same recovery fence.
 *
 * @param error - Sanitized cleanup recovery failure.
 * @returns Whether no unsafe lifecycle or durability failure occurred.
 */
function isRetryableCleanupRecoveryStop(error: unknown): boolean {
  return error instanceof
      WorkspaceSearchMigrationDescribeTableRateError &&
    (
      error.reason === 'budget-capacity' ||
      error.reason === 'cadence-bound' ||
      error.reason === 'throttled'
    )
}

/**
 * Orders deferred lifecycle transitions so terminal quarantine cannot weaken.
 */
function readLifecycleTransitionPriority(
  status: 'interrupted' | 'quarantined' | 'closed' | 'taken-over',
): number {
  switch (status) {
    case 'interrupted':
      return 1
    case 'closed':
      return 2
    case 'taken-over':
      return 3
    case 'quarantined':
      return 4
  }
}

/** Linked cancellation with explicit listener cleanup. */
type LinkedAbortSignal = {
  /** Signal supplied to waits and the single-attempt transport. */
  readonly signal: AbortSignal
  /** Removes listeners retained by the linked cancellation. */
  readonly dispose: () => void
}

/**
 * Creates one signal aborted when either supplied source aborts.
 *
 * @returns Linked signal and its listener cleanup.
 */
function createLinkedAbortSignal(
  primary: AbortSignal,
  secondary: AbortSignal | undefined,
): LinkedAbortSignal {
  if (secondary === undefined) {
    return { signal: primary, dispose: (): void => {} }
  }
  const controller = new AbortController()
  const abort = (): void => controller.abort()
  if (primary.aborted || secondary.aborted) {
    controller.abort()
    return { signal: controller.signal, dispose: (): void => {} }
  }
  primary.addEventListener('abort', abort, { once: true })
  secondary.addEventListener('abort', abort, { once: true })
  return {
    signal: controller.signal,
    dispose: (): void => {
      primary.removeEventListener('abort', abort)
      secondary.removeEventListener('abort', abort)
    },
  }
}

/**
 * Creates a signal that intentionally ignores operator interruption.
 *
 * @returns Uncancelled signal used only inside mandatory cleanup.
 */
function createUncancelledSignal(): LinkedAbortSignal {
  return {
    signal: new AbortController().signal,
    dispose: (): void => {},
  }
}

/**
 * Default monotonic process clock.
 *
 * @returns Non-negative monotonic milliseconds.
 */
function defaultRateClock(): number {
  return Math.floor(performance.now())
}

/**
 * Default cancelable admission deadline scheduler.
 */
const defaultRateDeadlineScheduler:
  WorkspaceSearchMigrationDescribeTableRateDeadlineScheduler = {
    schedule: (
      delayMilliseconds: number,
      callback: () => void,
    ): WorkspaceSearchMigrationDescribeTableRateDeadlineHandle => {
      const timer = setTimeout(callback, delayMilliseconds)
      return {
        cancel: (): void => clearTimeout(timer),
      }
    },
  }

/**
 * Default cancelable one-shot delay.
 */
const defaultRateWaiter: WorkspaceSearchMigrationDescribeTableRateWaiter = {
  wait: (
    delayMilliseconds: number,
    signal: AbortSignal,
  ): Promise<void> =>
    new Promise<void>((resolve, reject) => {
      if (signal.aborted) {
        reject(
          new WorkspaceSearchMigrationDescribeTableRateError(
            'interrupted',
          ),
        )
        return
      }
      const handleAbort = (): void => {
        clearTimeout(timer)
        reject(
          new WorkspaceSearchMigrationDescribeTableRateError(
            'interrupted',
          ),
        )
      }
      const handleResolve = (): void => {
        signal.removeEventListener('abort', handleAbort)
        resolve()
      }
      const timer = setTimeout(handleResolve, delayMilliseconds)
      signal.addEventListener('abort', handleAbort, { once: true })
    }),
}
