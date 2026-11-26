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
      getSettings: async () => ({ ...createDefaultAgentSettings('team'), ...settings }),
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
