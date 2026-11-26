import { expect, test } from 'bun:test'
import type { AgentRunPullRequestStatus, AgentSettings, ConnectorInstallation } from '@mukuroji/contracts'
import { ConnectorRuntimeError } from '../../modules/developer-platform/connector-oauth'
import {
  InMemoryAgentRunArtifactStatusStore,
  createDefaultAgentSettings,
  type PullRequestStatusReader,
  type StoredAgentRunReport,
} from '../../modules/agent-runs'
import {
  ARTIFACT_STATUS_REFRESH_INTERVAL_MS,
  ARTIFACT_STATUS_STALE_AFTER_MS,
  createConnectorPullRequestStatusReader,
  readWorkItemArtifactStatuses,
  type ArtifactStatusDependencies,
} from './agent-run-artifact-status-access'

/** Work Item the tests read. */
const target = { directoryId: 'workspace', teamId: 'team', workItemId: 'item' }

/** Open pull request with passing checks. */
const openPullRequest: AgentRunPullRequestStatus = {
  state: 'open', draft: false, headSha: 'a'.repeat(40), checks: 'success', review: 'none',
}

/**
 * Builds a stored report that lists the given artifact URLs.
 *
 * @param sequence - Report position.
 * @param urls - Pull request URLs.
 * @returns The report.
 */
function report(sequence: number, urls: string[]): StoredAgentRunReport {
  return {
    schemaVersion: 1, runId: 'run', teamId: 'team', workItemId: 'item', sequence, kind: 'progress',
    commentId: `comment-${sequence}`, verifications: [], createdAt: '2026-11-26T00:00:00.000Z',
    artifacts: urls.map((url) => ({ type: 'pull-request', url })),
    directoryId: 'workspace', createdBy: 'member',
  }
}

/**
 * Builds the dependencies of one read.
 *
 * @param reports - Work Item reports, newest first.
 * @param reader - Provider reader.
 * @param settings - Team Agent settings changes.
 * @returns Dependencies and the status store.
 */
function dependencies(
  reports: StoredAgentRunReport[],
  reader: PullRequestStatusReader,
  settings: Partial<AgentSettings> = {},
): ArtifactStatusDependencies & { statuses: InMemoryAgentRunArtifactStatusStore, settings: Partial<AgentSettings> } {
  return {
    settings,
    agentRuns: {
      listWorkItemReports: async () => ({ reports }),
      getSettings: async () => ({ ...createDefaultAgentSettings('team'), ...settings, workspaceDefaultsRevision: 0 }),
    },
    statuses: new InMemoryAgentRunArtifactStatusStore(),
    reader,
  }
}

test('reads each reported pull request once, keeps fresh results, and refreshes open ones when stale', async () => {
  const reads: string[] = []
  const deps = dependencies([
    report(2, ['https://github.com/Org/Repo/pull/7', 'https://example.com/docs']),
    report(1, ['https://github.com/Org/Repo/pull/7', 'https://gitlab.com/group/app/-/merge_requests/3']),
  ], async (_workspaceId, reference) => {
    reads.push(`${reference.repository}#${reference.number}`)
    return reference.provider === 'github'
      ? { kind: 'verified', pullRequest: openPullRequest }
      : { kind: 'unverified', reason: 'unsupported-provider' }
  })
  const now = new Date('2026-11-26T01:00:00.000Z')

  const first = await readWorkItemArtifactStatuses(target, deps, now)
  expect(first.items.map((item) => [item.repository, item.verification, item.unverifiedReason])).toEqual([
    ['org/repo', 'verified', undefined],
    ['group/app', 'unverified', 'unsupported-provider'],
  ])
  expect(first.items[0]?.pullRequest).toEqual(openPullRequest)

  await readWorkItemArtifactStatuses(target, deps, new Date(now.getTime() + 1_000))
  expect(reads).toEqual(['org/repo#7', 'group/app#3'])

  await readWorkItemArtifactStatuses(target, deps, new Date(now.getTime() + ARTIFACT_STATUS_STALE_AFTER_MS))
  expect(reads).toEqual(['org/repo#7', 'group/app#3', 'org/repo#7', 'group/app#3'])
})

test('does not read a repository outside the Team allowlist, and never reads a merged pull request again', async () => {
  const reads: string[] = []
  const deps = dependencies([
    report(1, ['https://github.com/org/allowed/pull/1', 'https://github.com/org/other/pull/2']),
  ], async (_workspaceId, reference) => {
    reads.push(reference.repository)
    return { kind: 'verified', pullRequest: { ...openPullRequest, state: 'merged', mergedAt: '2026-11-25T00:00:00.000Z' } }
  }, { artifactRepositories: ['org/allowed'] })
  const now = new Date('2026-11-26T01:00:00.000Z')

  const result = await readWorkItemArtifactStatuses(target, deps, now)
  expect(result.items.map((item) => [item.repository, item.verification, item.unverifiedReason])).toEqual([
    ['org/allowed', 'verified', undefined],
    ['org/other', 'unverified', 'repository-not-allowed'],
  ])
  await readWorkItemArtifactStatuses(target, deps, new Date(now.getTime() + 10 * ARTIFACT_STATUS_REFRESH_INTERVAL_MS))
  expect(reads).toEqual(['org/allowed'])

  // Removing the repository from the allowlist takes effect at once, even for the stored merged status.
  deps.settings.artifactRepositories = ['org/other']
  const narrowed = await readWorkItemArtifactStatuses(target, deps, new Date(now.getTime() + 11 * ARTIFACT_STATUS_REFRESH_INTERVAL_MS))
  expect(narrowed.items.map((item) => [item.repository, item.verification, item.unverifiedReason])).toEqual([
    ['org/allowed', 'unverified', 'repository-not-allowed'],
    ['org/other', 'verified', undefined],
  ])
  expect(reads).toEqual(['org/allowed', 'org/other'])
})

test('saves the reads that finish within the time budget and leaves the rest for a later view', async () => {
  const deps = {
    ...dependencies([report(1, ['https://github.com/org/fast/pull/1', 'https://github.com/org/slow/pull/2'])], (_workspaceId, reference) =>
      reference.repository === 'org/fast'
        ? Promise.resolve({ kind: 'verified' as const, pullRequest: openPullRequest })
        : new Promise<never>(() => {})),
    refreshBudgetMs: 20,
  }
  const now = new Date('2026-11-26T01:00:00.000Z')

  const result = await readWorkItemArtifactStatuses(target, deps, now)
  expect(result.items.map((item) => [item.repository, item.verification, item.unverifiedReason])).toEqual([
    ['org/fast', 'verified', undefined],
    ['org/slow', 'unverified', 'unavailable'],
  ])
  expect([...(deps.statuses.statuses.values().next().value?.keys() ?? [])]).toEqual(['https://github.com/org/fast/pull/1'])
})

test('starts each refresh at a different reference, so slow ones at the front cannot starve the rest', async () => {
  const urls = Array.from({ length: 6 }, (_, index) => `https://github.com/org/r${index}/pull/1`)
  const deps = {
    ...dependencies([report(1, urls)], (_workspaceId, reference) =>
      reference.repository === 'org/r5'
        ? Promise.resolve({ kind: 'verified' as const, pullRequest: openPullRequest })
        : new Promise<never>(() => {})),
    refreshBudgetMs: 10,
  }
  const start = new Date('2026-11-26T01:00:00.000Z').getTime()
  let verified = false
  for (let refresh = 0; refresh < urls.length && !verified; refresh += 1) {
    const result = await readWorkItemArtifactStatuses(target, deps, new Date(start + refresh * ARTIFACT_STATUS_REFRESH_INTERVAL_MS))
    verified = result.items.some((item) => item.repository === 'org/r5' && item.verification === 'verified')
  }
  expect(verified).toBeTrue()
})

test('keeps a verified status through a short provider outage', async () => {
  let available = true
  const deps = dependencies([report(1, ['https://github.com/org/repo/pull/1'])], async () => available
    ? { kind: 'verified', pullRequest: openPullRequest }
    : { kind: 'unverified', reason: 'unavailable' })
  const now = new Date('2026-11-26T01:00:00.000Z')
  await readWorkItemArtifactStatuses(target, deps, now)
  available = false

  const later = await readWorkItemArtifactStatuses(target, deps, new Date(now.getTime() + ARTIFACT_STATUS_STALE_AFTER_MS))
  expect(later.items[0]).toMatchObject({ verification: 'verified', checkedAt: now.toISOString() })
})

/**
 * Builds a connector installation.
 *
 * @param id - Installation ID.
 * @param patch - Field changes.
 * @returns The installation.
 */
function installation(id: string, patch: Partial<ConnectorInstallation> = {}): ConnectorInstallation {
  return {
    id, category: 'source-control', provider: 'github', name: id, status: 'connected', scopes: [],
    installedByUserId: 'member', installedAt: '2026-11-01T00:00:00.000Z', updatedAt: '2026-11-01T00:00:00.000Z',
    ...patch,
  }
}

test('the connector reader tries each connected GitHub account and maps failures to reasons', async () => {
  const reference = { url: 'https://github.com/org/repo/pull/1', provider: 'github' as const, repository: 'org/repo', number: 1 }
  const tried: string[] = []
  const reader = createConnectorPullRequestStatusReader({
    listConnectors: async () => [
      installation('gitlab', { provider: 'gitlab' }),
      installation('off', { status: 'disconnected' }),
      installation('first'),
      installation('second'),
    ],
    getEngine: async () => ({
      readPullRequest: async (_workspaceId, installationId) => {
        tried.push(installationId)
        if (installationId === 'first') throw new ConnectorRuntimeError('ConnectorExternalResourceMissing', 'Missing.')
        return openPullRequest
      },
    }),
  })

  expect(await reader('workspace', reference)).toEqual({ kind: 'verified', pullRequest: openPullRequest })
  expect(tried).toEqual(['first', 'second'])
  expect(await reader('workspace', { ...reference, provider: 'gitlab' })).toEqual({ kind: 'unverified', reason: 'unsupported-provider' })

  const none = createConnectorPullRequestStatusReader({ listConnectors: async () => [], getEngine: async () => { throw new Error('unused') } })
  expect(await none('workspace', reference)).toEqual({ kind: 'unverified', reason: 'no-connector' })

  const unconfigured = createConnectorPullRequestStatusReader({
    listConnectors: async () => [installation('first')],
    getEngine: async () => { throw new ConnectorRuntimeError('ConnectorRuntimeUnavailable', 'Off.', { retryable: true }) },
  })
  expect(await unconfigured('workspace', reference)).toEqual({ kind: 'unverified', reason: 'no-connector' })

  const hidden = createConnectorPullRequestStatusReader({
    listConnectors: async () => [installation('first')],
    getEngine: async () => ({
      readPullRequest: async () => { throw new ConnectorRuntimeError('ConnectorExternalResourceMissing', 'Missing.') },
    }),
  })
  expect(await hidden('workspace', reference)).toEqual({ kind: 'unverified', reason: 'not-accessible' })

  const outage = createConnectorPullRequestStatusReader({
    listConnectors: async () => [installation('first')],
    getEngine: async () => ({
      readPullRequest: async () => { throw new ConnectorRuntimeError('ConnectorProviderUnavailable', 'Down.', { retryable: true }) },
    }),
  })
  expect(await outage('workspace', reference)).toEqual({ kind: 'unverified', reason: 'unavailable' })
})

test('the connector reader tries the repository owner\'s account first and reaches accounts past the third', async () => {
  const reference = { url: 'https://github.com/org/repo/pull/1', provider: 'github' as const, repository: 'org/repo', number: 1 }
  const tried: string[] = []
  const reader = createConnectorPullRequestStatusReader({
    listConnectors: async () => [
      installation('a'), installation('b'), installation('c'), installation('d'),
      installation('owner', { externalAccountName: 'Org' }),
    ],
    getEngine: async () => ({
      readPullRequest: async (_workspaceId, installationId) => {
        tried.push(installationId)
        if (installationId !== 'd') throw new ConnectorRuntimeError('ConnectorExternalResourceMissing', 'Missing.')
        return openPullRequest
      },
    }),
  })

  expect(await reader('workspace', reference)).toEqual({ kind: 'verified', pullRequest: openPullRequest })
  // The owner's account goes first; the fourth other account is still tried.
  expect(tried).toEqual(['owner', 'a', 'b', 'c', 'd'])
})

test('reads report pages until a pull request is found, and flags a read that stops before the oldest report', async () => {
  /**
   * Serves reports 100 at a time, newest first.
   *
   * @param all - Every report, newest first.
   * @param pages - Receives the cursor of each page read.
   * @returns The report store.
   */
  function paged(all: StoredAgentRunReport[], pages: Array<string | undefined>): ArtifactStatusDependencies['agentRuns'] {
    return {
      listWorkItemReports: async (_directoryId, _teamId, _workItemId, cursor) => {
        pages.push(cursor)
        const start = cursor === undefined ? 0 : Number(cursor)
        const end = start + 100
        return { reports: all.slice(start, end), ...(end < all.length ? { nextCursor: String(end) } : {}) }
      },
      getSettings: async () => ({ ...createDefaultAgentSettings('team'), workspaceDefaultsRevision: 0 }),
    }
  }
  const reader: PullRequestStatusReader = async () => ({ kind: 'verified', pullRequest: openPullRequest })
  const now = new Date('2026-11-26T01:00:00.000Z')
  // 600 reports without a pull request come after the one that names it.
  const older = [...Array.from({ length: 600 }, (_, index) => report(700 - index, [])), report(1, ['https://github.com/org/repo/pull/1'])]
  const olderPages: Array<string | undefined> = []
  const found = await readWorkItemArtifactStatuses(
    target, { ...dependencies([], reader), agentRuns: paged(older, olderPages) }, now,
  )
  expect(found.items.map((item) => item.number)).toEqual([1])
  expect(found.incomplete).toBeUndefined()
  expect(olderPages).toHaveLength(7)

  const tooMany = Array.from({ length: 2_100 }, (_, index) => report(3_000 - index, []))
  const truncated = await readWorkItemArtifactStatuses(target, { ...dependencies([], reader), agentRuns: paged(tooMany, []) }, now)
  expect(truncated).toMatchObject({ items: [], incomplete: true })
})

test('the connector reader reaches an eleventh account on a later interval, and does not call the pull request inaccessible before', async () => {
  const reference = { url: 'https://github.com/org/repo/pull/1', provider: 'github' as const, repository: 'org/repo', number: 1 }
  const accounts = Array.from({ length: 11 }, (_, index) => installation(`account-${index + 1}`))
  // Interval 0 starts at the first account.
  let clock = new Date(0)
  const reader = createConnectorPullRequestStatusReader({
    listConnectors: async () => accounts,
    getEngine: async () => ({
      readPullRequest: async (_workspaceId, installationId) => {
        if (installationId !== 'account-11') throw new ConnectorRuntimeError('ConnectorExternalResourceMissing', 'Missing.')
        return openPullRequest
      },
    }),
  }, () => clock)

  // The first interval tries ten accounts; the eleventh is left, so the result is not final.
  expect(await reader('workspace', reference)).toEqual({ kind: 'unverified', reason: 'unavailable' })
  clock = new Date(clock.getTime() + ARTIFACT_STATUS_REFRESH_INTERVAL_MS)
  expect(await reader('workspace', reference)).toEqual({ kind: 'verified', pullRequest: openPullRequest })
})
