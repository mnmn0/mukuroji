import {
  AppConfigDataClient,
  GetLatestConfigurationCommand,
  StartConfigurationSessionCommand,
} from '@aws-sdk/client-appconfigdata'
import type {
  RuntimeControlSource,
  RuntimeControlSourceResult,
} from '../runtime/runtime-control'

/**
 * Minimum AppConfig polling interval accepted by the runtime-control boundary.
 */
export const MINIMUM_APPCONFIG_POLL_INTERVAL_SECONDS = 15

/**
 * Default timeout applied independently to each AppConfig Data request.
 */
export const DEFAULT_APPCONFIG_REQUEST_TIMEOUT_MILLISECONDS = 1_500

/**
 * Default timeout applied to session creation and its first configuration poll.
 */
export const DEFAULT_APPCONFIG_COLD_START_REQUEST_TIMEOUT_MILLISECONDS = 3_000

/**
 * Input used to start one already-scoped AppConfig Data session.
 */
export interface AppConfigRuntimeControlSessionInput {
  /** AppConfig application identifier. */
  readonly applicationIdentifier: string
  /** AppConfig configuration-profile identifier. */
  readonly configurationProfileIdentifier: string
  /** AppConfig environment identifier. */
  readonly environmentIdentifier: string
  /** Client-side lower bound requested from AppConfig. */
  readonly minimumPollIntervalSeconds: number
}

/**
 * Safe subset returned after starting an AppConfig Data session.
 */
export interface AppConfigRuntimeControlSession {
  /** One-use token required for the first configuration poll. */
  readonly initialConfigurationToken?: string
}

/**
 * Input used to poll an existing AppConfig Data session.
 */
export interface AppConfigRuntimeControlPollInput {
  /** One-use token returned by the preceding AppConfig call. */
  readonly configurationToken: string
}

/**
 * Safe subset returned by an AppConfig Data configuration poll.
 */
export interface AppConfigRuntimeControlPollResult {
  /** New configuration bytes, when AppConfig produced a version. */
  readonly configuration?: Uint8Array
  /** One-use token required for the next configuration poll. */
  readonly nextPollConfigurationToken?: string
  /** Provider-required delay before using the next token. */
  readonly nextPollIntervalInSeconds?: number
}

/**
 * Narrow AppConfig Data client port used by the runtime-control source.
 */
export interface AppConfigRuntimeControlClient {
  /**
   * Starts a session for one application, environment, and profile.
   *
   * @param input - Validated session identifiers and polling lower bound.
   * @param abortSignal - Bounded cancellation signal for the SDK request.
   * @returns The initial one-use polling token.
   */
  startConfigurationSession(
    input: AppConfigRuntimeControlSessionInput,
    abortSignal: AbortSignal,
  ): Promise<AppConfigRuntimeControlSession>

  /**
   * Polls AppConfig with the current one-use token.
   *
   * @param input - Current configuration token.
   * @param abortSignal - Bounded cancellation signal for the SDK request.
   * @returns Configuration bytes, next token, and provider interval.
   */
  getLatestConfiguration(
    input: AppConfigRuntimeControlPollInput,
    abortSignal: AbortSignal,
  ): Promise<AppConfigRuntimeControlPollResult>
}

/**
 * Inputs used to construct one direct AppConfig runtime-control source.
 */
export interface AppConfigRuntimeControlSourceOptions {
  /** AppConfig application identifier. */
  readonly applicationIdentifier: string
  /** Longer timeout used only while establishing a new polling session. */
  readonly coldStartRequestTimeoutMilliseconds?: number
  /** Optional client replacement used by isolated tests. */
  readonly client?: AppConfigRuntimeControlClient
  /** AppConfig configuration-profile identifier. */
  readonly configurationProfileIdentifier: string
  /** AppConfig environment identifier. */
  readonly environmentIdentifier: string
  /** Client-enforced minimum polling interval in seconds. */
  readonly minimumPollIntervalSeconds?: number
  /** AWS region used by the default AppConfig Data client. */
  readonly region?: string
  /** Timeout applied independently to session and poll calls. */
  readonly requestTimeoutMilliseconds?: number
}

/**
 * Creates a direct AppConfig Data adapter backed by the AWS SDK.
 *
 * @param region - Optional AWS region selected by server configuration.
 * @returns A narrow client that does not expose SDK response metadata.
 */
export function createAwsAppConfigRuntimeControlClient(
  region?: string,
): AppConfigRuntimeControlClient {
  const client = new AppConfigDataClient(region ? { region } : {})

  return Object.freeze({
    async startConfigurationSession(
      input: AppConfigRuntimeControlSessionInput,
      abortSignal: AbortSignal,
    ) {
      const output = await client.send(
        new StartConfigurationSessionCommand({
          ApplicationIdentifier: input.applicationIdentifier,
          ConfigurationProfileIdentifier:
            input.configurationProfileIdentifier,
          EnvironmentIdentifier: input.environmentIdentifier,
          RequiredMinimumPollIntervalInSeconds:
            input.minimumPollIntervalSeconds,
        }),
        { abortSignal },
      )
      return output.InitialConfigurationToken
        ? Object.freeze({
            initialConfigurationToken:
              output.InitialConfigurationToken,
          })
        : Object.freeze({})
    },
    async getLatestConfiguration(
      input: AppConfigRuntimeControlPollInput,
      abortSignal: AbortSignal,
    ) {
      const output = await client.send(
        new GetLatestConfigurationCommand({
          ConfigurationToken: input.configurationToken,
        }),
        { abortSignal },
      )
      return Object.freeze({
        ...(output.Configuration
          ? { configuration: new Uint8Array(output.Configuration) }
          : {}),
        ...(output.NextPollConfigurationToken
          ? {
              nextPollConfigurationToken:
                output.NextPollConfigurationToken,
            }
          : {}),
        ...(output.NextPollIntervalInSeconds === undefined
          ? {}
          : {
              nextPollIntervalInSeconds:
                output.NextPollIntervalInSeconds,
            }),
      })
    },
  })
}

/**
 * Creates a stateful AppConfig Data source that safely rotates one-use tokens.
 *
 * A missing token, malformed provider interval, or SDK failure discards the
 * session and surfaces one redacted provider failure to the core. Missing or
 * undersized provider intervals use the configured lower bound. The next call
 * starts a fresh session instead of reusing a consumed token.
 *
 * @param options - Scoped identifiers, region, client, and poll minimum.
 * @returns A runtime-control source suitable for the polling provider.
 */
export function createAppConfigRuntimeControlSource(
  options: AppConfigRuntimeControlSourceOptions,
): RuntimeControlSource {
  const applicationIdentifier = readIdentifier(
    options.applicationIdentifier,
    'AppConfig application identifier',
  )
  const environmentIdentifier = readIdentifier(
    options.environmentIdentifier,
    'AppConfig environment identifier',
  )
  const configurationProfileIdentifier = readIdentifier(
    options.configurationProfileIdentifier,
    'AppConfig configuration profile identifier',
  )
  const minimumPollIntervalSeconds = readPollIntervalSeconds(
    options.minimumPollIntervalSeconds ??
      MINIMUM_APPCONFIG_POLL_INTERVAL_SECONDS,
  )
  const client = options.client ??
    createAwsAppConfigRuntimeControlClient(options.region)
  const requestTimeoutMilliseconds = readPositiveMilliseconds(
    options.requestTimeoutMilliseconds ??
      DEFAULT_APPCONFIG_REQUEST_TIMEOUT_MILLISECONDS,
  )
  const coldStartRequestTimeoutMilliseconds = readPositiveMilliseconds(
    options.coldStartRequestTimeoutMilliseconds ??
      DEFAULT_APPCONFIG_COLD_START_REQUEST_TIMEOUT_MILLISECONDS,
  )
  let configurationToken: string | undefined

  return Object.freeze({
    async poll(): Promise<RuntimeControlSourceResult> {
      try {
        const startingSession = configurationToken === undefined
        const activeRequestTimeoutMilliseconds = startingSession
          ? coldStartRequestTimeoutMilliseconds
          : requestTimeoutMilliseconds
        let activeConfigurationToken = configurationToken
        if (activeConfigurationToken === undefined) {
          const session = await client.startConfigurationSession({
            applicationIdentifier,
            configurationProfileIdentifier,
            environmentIdentifier,
            minimumPollIntervalSeconds,
          }, AbortSignal.timeout(activeRequestTimeoutMilliseconds))
          activeConfigurationToken = readToken(
            session.initialConfigurationToken,
          )
        }

        const output = await client.getLatestConfiguration({
          configurationToken: activeConfigurationToken,
        }, AbortSignal.timeout(activeRequestTimeoutMilliseconds))
        const nextToken = readToken(
          output.nextPollConfigurationToken,
        )
        const nextPollIntervalMilliseconds = secondsToMilliseconds(
          resolveProviderPollIntervalSeconds(
            output.nextPollIntervalInSeconds,
            minimumPollIntervalSeconds,
          ),
        )
        configurationToken = nextToken

        if (
          output.configuration &&
          output.configuration.byteLength > 0
        ) {
          return Object.freeze({
            kind: 'configuration',
            configuration: new Uint8Array(output.configuration),
            nextPollIntervalMilliseconds,
          })
        }
        return Object.freeze({
          kind: 'unchanged',
          nextPollIntervalMilliseconds,
        })
      } catch {
        configurationToken = undefined
        throw new Error(
          'AppConfig runtime-control configuration is unavailable.',
        )
      }
    },
  })
}

/**
 * Validates one AppConfig identifier without exposing its value in errors.
 *
 * @param value - Candidate identifier.
 * @param label - Safe field label.
 * @returns Trimmed non-blank identifier.
 */
function readIdentifier(value: string, label: string): string {
  const identifier = value.trim()
  if (
    identifier.length === 0 ||
    Buffer.byteLength(identifier, 'utf8') > 256
  ) {
    throw new TypeError(`${label} is invalid.`)
  }
  return identifier
}

/**
 * Validates a one-use provider token.
 *
 * @param value - Candidate AppConfig token.
 * @returns Valid non-blank token.
 */
function readToken(value: string | undefined): string {
  if (
    !value ||
    value.trim().length === 0 ||
    Buffer.byteLength(value, 'utf8') > 8 * 1024
  ) {
    throw new TypeError('AppConfig polling token is invalid.')
  }
  return value
}

/**
 * Validates an AppConfig polling interval.
 *
 * @param value - Candidate duration in seconds.
 * @returns A supported safe integer duration.
 */
function readPollIntervalSeconds(
  value: number | undefined,
): number {
  if (
    !Number.isSafeInteger(value) ||
    value === undefined ||
    value < MINIMUM_APPCONFIG_POLL_INTERVAL_SECONDS
  ) {
    throw new TypeError('AppConfig polling interval is invalid.')
  }
  return value
}

/**
 * Resolves provider scheduling metadata without polling before the configured
 * client-side minimum.
 *
 * @param value - Optional provider-directed duration in seconds.
 * @param minimum - Validated client-side polling lower bound.
 * @returns Safe provider duration clamped to the client lower bound.
 */
function resolveProviderPollIntervalSeconds(
  value: number | undefined,
  minimum: number,
): number {
  if (value === undefined) return minimum
  if (!Number.isSafeInteger(value) || value < 0) {
    throw new TypeError('AppConfig polling interval is invalid.')
  }
  return Math.max(value, minimum)
}

/**
 * Converts a safe seconds duration to a safe milliseconds duration.
 *
 * @param seconds - Validated AppConfig duration.
 * @returns Equivalent safe integer milliseconds.
 */
function secondsToMilliseconds(seconds: number): number {
  const milliseconds = seconds * 1_000
  if (!Number.isSafeInteger(milliseconds)) {
    throw new TypeError('AppConfig polling interval is invalid.')
  }
  return milliseconds
}

/**
 * Validates a bounded request timeout.
 *
 * @param value - Candidate duration in milliseconds.
 * @returns A supported positive safe integer duration.
 */
function readPositiveMilliseconds(value: number): number {
  if (
    !Number.isSafeInteger(value) ||
    value <= 0 ||
    value > 30_000
  ) {
    throw new TypeError('AppConfig request timeout is invalid.')
  }
  return value
}
