import useSWR from 'swr'
import { resolveApiBaseUrl } from '../../../shared/api/apiBaseUrl'
import {
  buildDriftPairKey,
  classifyBuildDrift,
  fetchApiCommitSha,
  type BuildDriftState,
} from '../../../shared/release/buildDrift'
import { readWebBuildInfo } from '../../../shared/release/webBuild'

/** SWR key of the API commit. */
const apiCommitKey = 'app/api-build-commit'

/** How often to ask the API for its commit while the tab stays open, in milliseconds. */
const apiCommitPollMilliseconds = 10 * 60_000

/** Shortest gap between checks that returning to the tab starts, in milliseconds. */
const apiCommitFocusThrottleMilliseconds = 60_000

/** Session storage key holding the pair the user last reloaded for. */
const reloadedForStorageKey = 'mukuroji.buildDrift.reloadedFor'

/**
 * Reads the pair the user last reloaded for in this tab.
 *
 * @returns The pair key, or undefined when none is stored or storage is unavailable.
 */
function readReloadedForPair(): string | undefined {
  try {
    return globalThis.sessionStorage?.getItem(reloadedForStorageKey) ?? undefined
  } catch {
    return undefined
  }
}

/**
 * Remembers the pair the user reloads for, so the notice can say when a reload did not help.
 *
 * @param pair - Pair key to remember.
 */
function writeReloadedForPair(pair: string): void {
  try {
    globalThis.sessionStorage?.setItem(reloadedForStorageKey, pair)
  } catch {
    // Without storage the notice shows the plain drift message again after the reload.
  }
}

/** What the build drift notice needs. */
export type BuildDrift = {
  /** What to tell the user. */
  readonly state: BuildDriftState
  /** Key of the differing Web and API pair, or undefined while the builds match. */
  readonly pair: string | undefined
  /** Reloads the page, remembering the pair it reloads for. */
  readonly reload: () => void
}

/**
 * Compares the running Web build with the commit `/api/health` reports.
 *
 * Builds without an embedded commit, such as local and test builds, never ask the API. Deployed
 * builds ask once on load, when the user returns to the tab, and every 10 minutes.
 *
 * @param webCommitSha - Commit of the running Web build. Defaults to the embedded one.
 * @returns The drift state and the reload action.
 */
export function useBuildDrift(webCommitSha: string | undefined = readWebBuildInfo().commitSha): BuildDrift {
  const { data: apiCommitSha } = useSWR<string | undefined>(
    webCommitSha === undefined ? null : apiCommitKey,
    () => fetchApiCommitSha(resolveApiBaseUrl('shared'), (...args) => globalThis.fetch(...args)),
    {
      refreshInterval: apiCommitPollMilliseconds,
      focusThrottleInterval: apiCommitFocusThrottleMilliseconds,
      revalidateOnReconnect: true,
      // SWR skips interval polling while an error is cached, so a failed check retries on the
      // polling schedule instead, without SWR's growing backoff.
      onErrorRetry: (_error, _key, _config, revalidate) => {
        setTimeout(() => void revalidate(), apiCommitPollMilliseconds)
      },
      dedupingInterval: apiCommitFocusThrottleMilliseconds,
    },
  )
  const state = classifyBuildDrift({ webCommitSha, apiCommitSha }, readReloadedForPair())
  const pair = state === 'none' || webCommitSha === undefined || apiCommitSha === undefined
    ? undefined
    : buildDriftPairKey({ webCommitSha, apiCommitSha })
  return {
    state,
    pair,
    reload: () => {
      if (pair !== undefined) writeReloadedForPair(pair)
      globalThis.location.reload()
    },
  }
}
