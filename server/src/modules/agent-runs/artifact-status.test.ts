import { expect, test } from 'bun:test'
import { GetCommand, type UpdateCommand } from '@aws-sdk/lib-dynamodb'
import {
  AGENT_RUN_ARTIFACT_STATUS_SCHEMA_VERSION,
  DynamoDbAgentRunArtifactStatusStore,
  artifactRefreshRecordKey,
  artifactStatusRecordKey,
  artifactStatusRecordKeyPrefix,
  parseArtifactStatus,
} from './adapter-out/dynamodb/agent-run-artifact-status-store'
import { isArtifactRepositoryAllowed, isFinalArtifactStatus, readPullRequestArtifactReference } from './index'

test('recognizes GitHub pull requests and GitLab merge requests by URL only', () => {
  expect(readPullRequestArtifactReference('https://github.com/Org/Repo/pull/12')).toEqual({
    url: 'https://github.com/Org/Repo/pull/12', provider: 'github', repository: 'org/repo', number: 12,
  })
  expect(readPullRequestArtifactReference('https://github.com/org/repo/pull/12/files')?.number).toBe(12)
  expect(readPullRequestArtifactReference('https://gitlab.com/group/sub/app/-/merge_requests/3')).toMatchObject({
    provider: 'gitlab', repository: 'group/sub/app', number: 3,
  })
  for (const url of [
    'https://github.com/org/repo/issues/12',
    'https://github.com/org/repo/pull/0',
    'https://github.com/org/repo/pull/abc',
    'https://github.example.com/org/repo/pull/1',
    'https://github.com:8443/org/repo/pull/1',
    'http://github.com/org/repo/pull/1',
    'https://gitlab.com/-/merge_requests/1',
    'not a url',
  ]) {
    expect(readPullRequestArtifactReference(url)).toBeUndefined()
  }
})

test('an empty allowlist admits any repository, and only merged pull requests are final', () => {
  expect(isArtifactRepositoryAllowed([], 'org/repo')).toBeTrue()
  expect(isArtifactRepositoryAllowed(['org/repo'], 'org/repo')).toBeTrue()
  expect(isArtifactRepositoryAllowed(['org/repo'], 'org/other')).toBeFalse()
  const base = { url: 'https://github.com/org/repo/pull/1', provider: 'github', repository: 'org/repo', number: 1, checkedAt: '2026-11-26T00:00:00.000Z' } as const
  const pull = { draft: false, headSha: 'a'.repeat(40), checks: 'success', review: 'none' } as const
  expect(isFinalArtifactStatus({ ...base, verification: 'verified', pullRequest: { ...pull, state: 'merged' } })).toBeTrue()
  expect(isFinalArtifactStatus({ ...base, verification: 'verified', pullRequest: { ...pull, state: 'closed' } })).toBeFalse()
  expect(isFinalArtifactStatus({ ...base, verification: 'unverified', unverifiedReason: 'unavailable' })).toBeFalse()
})

test('status rows are keyed under the Work Item, saved only when newer, and parsed strictly', async () => {
  const url = 'https://github.com/org/repo/pull/1'
  const key = artifactStatusRecordKey('item', url)
  expect(key.startsWith(artifactStatusRecordKeyPrefix('item'))).toBeTrue()
  expect(key).not.toContain('github.com')
  expect(artifactRefreshRecordKey('item').startsWith(artifactStatusRecordKeyPrefix('item'))).toBeFalse()
  const status = {
    url, provider: 'github', repository: 'org/repo', number: 1, verification: 'verified', checkedAt: '2026-11-26T00:00:00.000Z',
    pullRequest: { state: 'open', draft: false, headSha: 'a'.repeat(40), checks: 'pending', review: 'none' },
  } as const
  const row = { schemaVersion: AGENT_RUN_ARTIFACT_STATUS_SCHEMA_VERSION, workItemId: 'item', recordKey: key, artifactStatus: status }
  expect(parseArtifactStatus(row, 'item')).toEqual(status)
  expect(() => parseArtifactStatus({ ...row, workItemId: 'other' }, 'item')).toThrow()
  expect(() => parseArtifactStatus({ ...row, artifactStatus: { ...status, pullRequest: { ...status.pullRequest, checks: 'green' } } }, 'item')).toThrow()

  const sent: Array<GetCommand | UpdateCommand> = []
  let conflict = false
  const store = new DynamoDbAgentRunArtifactStatusStore({
    send: async (command) => {
      sent.push(command)
      if (conflict) throw Object.assign(new Error('Condition failed'), { name: 'ConditionalCheckFailedException' })
      if (!(command instanceof GetCommand)) return {}
      return command.input.Key?.recordKey === key ? { Item: row } : {}
    },
  }, 'table')
  // Only the URLs asked for are read, each by its own key, so old rows never crowd out current ones.
  expect(await store.getStatuses('workspace', 'team', 'item', [url, 'https://github.com/org/repo/pull/2', url]))
    .toEqual([status])
  expect(sent.map((command) => command.input)).toMatchObject([
    { Key: { recordKey: key }, ConsistentRead: true },
    { Key: { recordKey: artifactStatusRecordKey('item', 'https://github.com/org/repo/pull/2') } },
  ])
  await store.saveStatuses('workspace', 'team', 'item', [status])
  // Both rows carry the Workspace ID, which the tenant export and deletion select rows by.
  expect(sent[2]?.input).toMatchObject({
    ConditionExpression: 'attribute_not_exists(#recordKey) OR #checkedAt < :checkedAt',
    ExpressionAttributeValues: { ':workspaceId': 'workspace' },
  })
  expect(await store.claimRefresh('workspace', 'team', 'item', new Date('2026-11-26T00:00:00.000Z'), 60_000)).toBeTrue()
  expect(sent[3]?.input).toMatchObject({ ExpressionAttributeValues: { ':workspaceId': 'workspace' } })
  conflict = true
  await store.saveStatuses('workspace', 'team', 'item', [status])
  expect(await store.claimRefresh('workspace', 'team', 'item', new Date('2026-11-26T00:00:30.000Z'), 60_000)).toBeFalse()
})
