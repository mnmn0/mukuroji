import {
  createAppConfigRuntimeControlSource,
  type AppConfigRuntimeControlClient,
  MINIMUM_APPCONFIG_POLL_INTERVAL_SECONDS,
} from '../../infrastructure/aws/appconfig-runtime-control'
import {
  loadServerConfig,
  type ServerEnvironment,
} from '../../infrastructure/config/server-config'
import type {
  RuntimeControlObservationRecorder,
} from '../../infrastructure/observability/runtime-control-observability'
import {
  createRuntimeControlMetricControlId,
  createRuntimeControlObservationRecorder,
} from '../../infrastructure/observability/runtime-control-observability'
import type {
  ReadinessProbe,
  ReadinessResult,
} from '../../infrastructure/observability/readiness'
import {
  createRuntimeControlProvider,
  createStaticRuntimeControlProvider,
  RuntimeControlBlockedError,
  runtimeControlAllowsExecution,
  runtimeControlIsReady,
  type RuntimeControlProvider,
  type RuntimeControlSnapshot,
  type RuntimeControlSurface,
  type RuntimeControlWorkerSurface,
} from '../../infrastructure/runtime/runtime-control'
import {
  getSafeRuntimeControlSnapshot,
  readRuntimeControlObservedAt,
  recordRuntimeControlObservationSafely,
} from './runtime-control-safety'
import {
  runWithWorkspaceSearchWriterFenceInvocation,
} from '../../infrastructure/runtime/workspace-search-writer-fence-invocation'

/**
 * Runtime-control surfaces backed by distinct deployed AppConfig scopes.
 */
export type ConfiguredRuntimeControlSurface = Exclude<
  RuntimeControlSurface,
  'readiness'
>

/**
 * Optional infrastructure replacements used to construct one scoped provider.
 */
export interface ProductionRuntimeControlProviderOptions {
  /** Narrow AppConfig Data client replacement used by isolated tests. */
  readonly client?: AppConfigRuntimeControlClient
  /** Environment values used instead of the live process environment. */
  readonly environment?: ServerEnvironment
  /** Monotonic clock replacement used by deterministic tests. */
  readonly now?: () => number
}

/**
 * Optional dependencies accepted by a guarded worker or realtime entrypoint.
 */
export interface RuntimeControlGuardDependencies {
  /** Timestamp used for safe decision telemetry. */
  readonly now?: () => number
  /** Scoped provider replacement used by isolated tests. */
  readonly provider?: RuntimeControlProvider
  /** Optional destination for bounded runtime-control observations. */
  readonly recordObservation?: RuntimeControlObservationRecorder
}

const DEFAULT_MAX_STALENESS_SECONDS = 60
const MAXIMUM_STALENESS_SECONDS = 60
const configuredProviders = new Map<
  ConfiguredRuntimeControlSurface,
  RuntimeControlProvider
>()

/**
 * Creates an application-isolated production runtime-control recorder.
 *
 * @param environment - Environment values used to resolve the stack control identity.
 * @returns Recorder bound to the stack-injected control identifier.
 */
export function createProductionRuntimeControlObservationRecorder(
  environment: ServerEnvironment = typeof Bun !== 'undefined'
    ? Bun.env
    : process.env,
): RuntimeControlObservationRecorder {
  const controlId = createRuntimeControlMetricControlId(
    readNonBlankEnvironmentValue(
      environment.MUKUROJI_RUNTIME_CONTROL_APPCONFIG_APPLICATION_ID,
    ),
    readNonBlankEnvironmentValue(
      environment
        .MUKUROJI_RUNTIME_CONTROL_APPCONFIG_CONFIGURATION_PROFILE_ID,
    ),
  )
  return createRuntimeControlObservationRecorder({
    controlId: controlId ?? 'unconfigured',
  })
}

/**
 * Creates a scoped provider from production configuration.
 *
 * Non-production runtimes are explicitly enabled for local development and
 * tests. Production identifiers, numeric bounds, or scope mismatches return an
 * unavailable fail-closed provider without throwing during module startup.
 *
 * @param surface - Exact deployed scope expected by this runtime.
 * @param options - Optional environment, client, and clock replacements.
 * @returns A current local provider or fail-closed production provider.
 */
export function createProductionRuntimeControlProvider(
  surface: ConfiguredRuntimeControlSurface,
  options: ProductionRuntimeControlProviderOptions = {},
): RuntimeControlProvider {
  const config = loadServerConfig(options.environment)
  if (!config.production) {
    return createStaticRuntimeControlProvider('enabled')
  }

  const environment = config.environment
  const applicationIdentifier = readNonBlankEnvironmentValue(
    environment.MUKUROJI_RUNTIME_CONTROL_APPCONFIG_APPLICATION_ID,
  )
  const appConfigEnvironmentIdentifier = readNonBlankEnvironmentValue(
    environment.MUKUROJI_RUNTIME_CONTROL_APPCONFIG_ENVIRONMENT_ID,
  )
  const configurationProfileIdentifier = readNonBlankEnvironmentValue(
    environment
      .MUKUROJI_RUNTIME_CONTROL_APPCONFIG_CONFIGURATION_PROFILE_ID,
  )
  const metricControlId = createRuntimeControlMetricControlId(
    applicationIdentifier,
    configurationProfileIdentifier,
  )
  const configuredScope = readNonBlankEnvironmentValue(
    environment.MUKUROJI_RUNTIME_CONTROL_SCOPE,
  )
  const minimumPollIntervalSeconds = readSeconds(
    environment.MUKUROJI_RUNTIME_CONTROL_MIN_POLL_INTERVAL_SECONDS,
    MINIMUM_APPCONFIG_POLL_INTERVAL_SECONDS,
    MINIMUM_APPCONFIG_POLL_INTERVAL_SECONDS,
    300,
  )
  const maximumStalenessSeconds = readSeconds(
    environment.MUKUROJI_RUNTIME_CONTROL_MAX_STALE_SECONDS,
    DEFAULT_MAX_STALENESS_SECONDS,
    1,
    MAXIMUM_STALENESS_SECONDS,
  )

  if (
    !applicationIdentifier ||
    !appConfigEnvironmentIdentifier ||
    !configurationProfileIdentifier ||
    !metricControlId ||
    configuredScope !== surface ||
    minimumPollIntervalSeconds === undefined ||
    maximumStalenessSeconds === undefined
  ) {
    return createUnavailableRuntimeControlProvider()
  }

  try {
    return createRuntimeControlProvider({
      source: createAppConfigRuntimeControlSource({
        applicationIdentifier,
        configurationProfileIdentifier,
        environmentIdentifier: appConfigEnvironmentIdentifier,
        minimumPollIntervalSeconds,
        region: config.awsRegion,
        ...(options.client ? { client: options.client } : {}),
      }),
      pollIntervalMilliseconds: secondsToMilliseconds(
        minimumPollIntervalSeconds,
      ),
      maxStalenessMilliseconds: secondsToMilliseconds(
        maximumStalenessSeconds,
      ),
      ...(options.now ? { now: options.now } : {}),
    })
  } catch {
    return createUnavailableRuntimeControlProvider()
  }
}

/**
 * Wraps a worker or realtime handler with one fail-closed runtime decision.
 *
 * The delegate is never invoked until the scoped provider returns an allowed
 * current or bounded-stale enabled snapshot.
 *
 * @param surface - Stable worker or realtime execution surface.
 * @param handler - Original handler invoked only after admission.
 * @param dependencies - Optional provider, recorder, and clock replacements.
 * @returns An async handler preserving the delegate's arguments and result.
 */
export function createRuntimeControlGuardedHandler<
  Arguments extends readonly unknown[],
  Result,
>(
  surface: RuntimeControlWorkerSurface,
  handler: (...arguments_: Arguments) => Result | PromiseLike<Result>,
  dependencies: RuntimeControlGuardDependencies = {},
): (...arguments_: Arguments) => Promise<Result> {
  const provider = dependencies.provider ??
    resolveConfiguredRuntimeControlProvider(surface)
  const now = dependencies.now ?? Date.now
  const recordObservation = dependencies.recordObservation ??
    createProductionRuntimeControlObservationRecorder()

  return async (...arguments_: Arguments): Promise<Result> => {
    const snapshot = await getSafeRuntimeControlSnapshot(provider)
    const allowed = runtimeControlAllowsExecution(snapshot)
    recordRuntimeControlObservationSafely(
      recordObservation,
      {
        observedAtMilliseconds: readRuntimeControlObservedAt(now),
        outcome: allowed ? 'allowed' : 'blocked',
        snapshot,
        surface,
      },
    )
    if (!allowed) throw new RuntimeControlBlockedError(snapshot)
    return await runWithWorkspaceSearchWriterFenceInvocation(
      async () => await handler(...arguments_),
    )
  }
}

/**
 * Extends dependency readiness with current runtime-control admission.
 *
 * @param readiness - Existing critical dependency readiness probe.
 * @param provider - API-scoped runtime-control provider.
 * @param recordObservation - Optional destination for bounded observations.
 * @param now - Optional timestamp source used for telemetry.
 * @returns A probe that is ready only when dependencies and control are ready.
 */
export function createRuntimeControlAwareReadinessProbe(
  readiness: ReadinessProbe,
  provider: RuntimeControlProvider,
  recordObservation?: RuntimeControlObservationRecorder,
  now: () => number = Date.now,
): ReadinessProbe {
  return Object.freeze({
    async check(correlationId?: string): Promise<ReadinessResult> {
      const snapshot = await getSafeRuntimeControlSnapshot(provider)
      const controlReady = runtimeControlIsReady(snapshot)
      recordRuntimeControlObservationSafely(recordObservation, {
        observedAtMilliseconds: readRuntimeControlObservedAt(now),
        outcome: controlReady ? 'ready' : 'not-ready',
        snapshot,
        surface: 'readiness',
      })
      if (!controlReady) {
        return Object.freeze({
          checks: Object.freeze([
            Object.freeze({
              name: 'runtime-control',
              ready: false,
            }),
          ]),
          ready: false,
        })
      }

      const dependencyResult = await readiness.check(correlationId)
      const checks = Object.freeze([
        ...dependencyResult.checks.map((check) => Object.freeze({
          name: check.name,
          ready: check.ready,
        })),
        Object.freeze({
          name: 'runtime-control',
          ready: controlReady,
        }),
      ])
      return Object.freeze({
        checks,
        ready: dependencyResult.ready && controlReady,
      })
    },
  })
}

/**
 * Resolves one warm provider per deployed execution surface.
 *
 * @param surface - Exact configured scope.
 * @returns Cached provider retaining AppConfig tokens and last-known-good state.
 */
function resolveConfiguredRuntimeControlProvider(
  surface: ConfiguredRuntimeControlSurface,
): RuntimeControlProvider {
  const existing = configuredProviders.get(surface)
  if (existing) return existing
  const provider = createProductionRuntimeControlProvider(surface)
  configuredProviders.set(surface, provider)
  return provider
}

/**
 * Returns a provider that always reports an unavailable disabled state.
 *
 * @returns Immutable fail-closed provider.
 */
function createUnavailableRuntimeControlProvider(): RuntimeControlProvider {
  const snapshot: RuntimeControlSnapshot = Object.freeze({
    mode: 'disabled',
    status: 'unavailable',
  })
  return Object.freeze({
    async getSnapshot() {
      return snapshot
    },
  })
}

/**
 * Reads a non-blank environment value.
 *
 * @param value - Candidate environment value.
 * @returns Trimmed value, or undefined when absent or blank.
 */
function readNonBlankEnvironmentValue(
  value: string | undefined,
): string | undefined {
  const candidate = value?.trim()
  return candidate ? candidate : undefined
}

/**
 * Reads a bounded seconds environment value.
 *
 * @param value - Optional decimal integer string.
 * @param fallback - Default used when the value is absent.
 * @param minimum - Smallest accepted duration.
 * @param maximum - Largest accepted duration.
 * @returns Safe integer seconds, or undefined for malformed input.
 */
function readSeconds(
  value: string | undefined,
  fallback: number,
  minimum: number,
  maximum: number,
): number | undefined {
  if (value === undefined) return fallback
  if (!/^[0-9]+$/.test(value)) return undefined
  const seconds = Number(value)
  if (
    !Number.isSafeInteger(seconds) ||
    seconds < minimum ||
    seconds > maximum ||
    !Number.isSafeInteger(seconds * 1_000)
  ) {
    return undefined
  }
  return seconds
}

/**
 * Converts validated seconds to milliseconds.
 *
 * @param seconds - Safe duration in seconds.
 * @returns Equivalent duration in milliseconds.
 */
function secondsToMilliseconds(seconds: number): number {
  return seconds * 1_000
}
