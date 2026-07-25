import type {
  RuntimeControlObservationRecorder,
} from '../../infrastructure/observability/runtime-control-observability'
import type {
  RuntimeControlProvider,
  RuntimeControlSnapshot,
} from '../../infrastructure/runtime/runtime-control'

/**
 * Converts an unexpected provider rejection into an unavailable decision.
 *
 * @param provider - Scoped provider used by the current operation.
 * @returns Provider snapshot or a redacted fail-closed substitute.
 */
export async function getSafeRuntimeControlSnapshot(
  provider: RuntimeControlProvider,
): Promise<RuntimeControlSnapshot> {
  try {
    return await provider.getSnapshot()
  } catch {
    return Object.freeze({
      mode: 'disabled',
      status: 'unavailable',
    })
  }
}

/**
 * Records bounded telemetry without allowing an observer failure to admit or
 * disrupt controlled work.
 *
 * @param recorder - Optional observation destination.
 * @param observation - Bounded runtime-control decision.
 */
export function recordRuntimeControlObservationSafely(
  recorder: RuntimeControlObservationRecorder | undefined,
  observation: Parameters<RuntimeControlObservationRecorder>[0],
): void {
  try {
    recorder?.(observation)
  } catch {
    // Runtime admission is authoritative even when telemetry is unavailable.
  }
}

/**
 * Reads a bounded timestamp without trusting an injected clock.
 *
 * @param now - Candidate timestamp source.
 * @returns Non-negative safe integer timestamp or zero.
 */
export function readRuntimeControlObservedAt(
  now: () => number,
): number {
  try {
    const observedAtMilliseconds = now()
    return Number.isSafeInteger(observedAtMilliseconds) &&
      observedAtMilliseconds >= 0
      ? observedAtMilliseconds
      : 0
  } catch {
    return 0
  }
}
