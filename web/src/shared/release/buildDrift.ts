/**
 * What the app tells the user about the Web build it runs and the API build it talks to.
 *
 * - `none`: the builds match, or one of them does not report its commit.
 * - `drift`: the API runs another commit, so reloading should load the matching Web build.
 * - `persisting`: the builds still differ after the user reloaded for this same pair, which
 *   happens while a deploy is between its API and Web steps or after the Web was rolled back.
 */
export type BuildDriftState = 'none' | 'drift' | 'persisting'

/** Commits the Web build and the API report. */
export type BuildCommits = {
  /** Commit the running Web build embeds, or undefined for local and test builds. */
  readonly webCommitSha: string | undefined
  /** Commit `/api/health` reports, or undefined when it reports none. */
  readonly apiCommitSha: string | undefined
}

const commitShaPattern = /^[0-9a-f]{40}$/

/** How long one health request, body included, may take, in milliseconds. */
const healthTimeoutMilliseconds = 10_000

/**
 * Reads `applicationCommitSha` from a `/api/health` body.
 *
 * @param body - Parsed JSON body.
 * @returns The full lowercase commit SHA, or undefined when the body carries no valid one.
 */
export function readApiCommitSha(body: unknown): string | undefined {
  if (typeof body !== 'object' || body === null || !('applicationCommitSha' in body)) return undefined
  const value: unknown = body.applicationCommitSha
  return typeof value === 'string' && commitShaPattern.test(value) ? value : undefined
}

/**
 * Asks the API which commit it runs.
 *
 * @param apiBaseUrl - API base URL, such as `/api`.
 * @param send - `fetch` to use.
 * @returns The API commit, or undefined when the API reports none.
 * @throws When the request fails, times out, or answers with an error, so the last answer stays.
 */
export async function fetchApiCommitSha(
  apiBaseUrl: string,
  send: typeof fetch,
): Promise<string | undefined> {
  const response = await send(`${apiBaseUrl}/health`, {
    cache: 'no-store',
    credentials: 'omit',
    signal: AbortSignal.timeout(healthTimeoutMilliseconds),
  })
  if (!response.ok) throw new Error(`Health answered ${response.status}.`)
  return readApiCommitSha(await response.json())
}

/**
 * Names one Web and API commit pair, so a reload can be remembered for exactly that pair.
 *
 * @param commits - Both commits, already known to differ.
 * @returns A stable key for the pair.
 */
export function buildDriftPairKey(commits: { readonly webCommitSha: string; readonly apiCommitSha: string }): string {
  return `${commits.webCommitSha}:${commits.apiCommitSha}`
}

/**
 * Decides what to tell the user about the two builds.
 *
 * @param commits - Commits the Web build and the API report.
 * @param reloadedForPair - Pair key the user last reloaded for in this tab, if any.
 * @returns The drift state.
 */
export function classifyBuildDrift(
  commits: BuildCommits,
  reloadedForPair: string | undefined,
): BuildDriftState {
  const { webCommitSha, apiCommitSha } = commits
  if (webCommitSha === undefined || apiCommitSha === undefined || webCommitSha === apiCommitSha) return 'none'
  return buildDriftPairKey({ webCommitSha, apiCommitSha }) === reloadedForPair ? 'persisting' : 'drift'
}
