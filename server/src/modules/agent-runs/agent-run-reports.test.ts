import { describe, expect, test } from 'bun:test'
import {
  AGENT_RUN_ARTIFACT_URL_PATTERN,
  AGENT_RUN_REPORT_LINE_PATTERN,
  AGENT_RUN_REPORT_MESSAGE_PATTERN,
  PUBLIC_API_OPENAPI_DOCUMENT,
} from '@mukuroji/contracts'
import { QueryCommand, TransactWriteCommand, type GetCommand, type UpdateCommand } from '@aws-sdk/lib-dynamodb'
import { DynamoDbAgentRunStore, type AgentRunDocumentClient } from './adapter-out/dynamodb/agent-run-store'
import { InMemoryAgentRunStore } from './adapter-out/in-memory/agent-run-store'
import { createActiveAgentRun, readStartAgentRunRequest, type StoredAgentRun } from './domain/agent-run'
import {
  createAgentRunReportCommentBody,
  readAgentRunArtifactUrl,
  readReportAgentRunRequest,
  toAgentRunReport,
  type StoredAgentRunReport,
} from './domain/agent-run-report'

const now = new Date('2026-10-22T00:00:00.000Z')

/**
 * Creates an active run fixture.
 *
 * @param overrides - Fields to replace.
 * @returns Stored run.
 */
function createRun(overrides: Partial<StoredAgentRun> = {}): StoredAgentRun {
  return {
    ...createActiveAgentRun({
      directoryId: 'workspace-1',
      teamId: 'core',
      workItemId: 'task-1',
      assigneeUserId: 'member-1',
      start: readStartAgentRunRequest({
        expectedRevision: 3, workflowStatusId: 'in-progress', runtime: 'codex', agentName: 'Codex', instanceId: 'laptop-1',
      }),
      credentialId: 'key-1',
      startRevision: 4,
      leaseMinutes: 30,
      now: new Date('2026-10-21T23:00:00.000Z'),
      runId: 'run_00000000-0000-4000-8000-000000000001',
    }),
    ...overrides,
  }
}

/**
 * Creates the next report of a run.
 *
 * @param run - Reporting run.
 * @param overrides - Fields to replace.
 * @returns Stored report.
 */
function createReport(run: StoredAgentRun, overrides: Partial<StoredAgentRunReport> = {}): StoredAgentRunReport {
  return {
    schemaVersion: 1,
    runId: run.runId,
    directoryId: run.directoryId,
    teamId: run.teamId,
    workItemId: run.workItemId,
    sequence: run.reportCount + 1,
    kind: 'verification',
    commentId: 'cmt_1',
    verifications: [{ command: 'bun test', status: 'passed' }],
    artifacts: [{ type: 'pull-request', url: 'https://github.com/example/repo/pull/1' }],
    createdAt: now.toISOString(),
    createdBy: 'member-1',
    ...overrides,
  }
}

/**
 * Captures commands and returns queued responses.
 *
 * @param responses - Responses returned in order.
 * @returns Fake client and the captured commands.
 */
function createClient(responses: Array<Awaited<ReturnType<AgentRunDocumentClient['send']>>> = []) {
  const commands: Array<GetCommand | QueryCommand | UpdateCommand | TransactWriteCommand> = []
  const client: AgentRunDocumentClient = {
    async send(command) {
      commands.push(command)
      return responses.shift() ?? {}
    },
  }
  return { client, commands }
}

describe('Agent Run report validation', () => {
  test('defaults to a progress report and normalizes the message', () => {
    const report = readReportAgentRunRequest({ instanceId: 'laptop-1', message: '  Done\r\nnext  ' })
    expect(report).toEqual({ instanceIdHash: expect.any(String), kind: 'progress', message: 'Done\nnext', verifications: [], artifacts: [] })
    expect(createAgentRunReportCommentBody('Codex', report.message)).toBe('[Codex]\n\nDone\nnext')
  })

  test('reads verifications, artifacts, and the changed file count', () => {
    expect(readReportAgentRunRequest({
      instanceId: 'laptop-1',
      kind: 'handoff',
      message: 'Ready for review',
      verifications: [{ command: ' bun run server:test ', status: 'failed', summary: '2 failures' }],
      artifacts: [{ type: 'branch', url: 'https://github.com/example/repo/tree/feature', label: 'feature' }],
      changedFileCount: 3,
    })).toMatchObject({
      kind: 'handoff',
      verifications: [{ command: 'bun run server:test', status: 'failed', summary: '2 failures' }],
      artifacts: [{ type: 'branch', url: 'https://github.com/example/repo/tree/feature', label: 'feature' }],
      changedFileCount: 3,
    })
  })

  test('rejects unknown fields, kinds, statuses, and oversized lists', () => {
    const base = { instanceId: 'laptop-1', message: 'Note' }
    expect(() => readReportAgentRunRequest({ ...base, title: 'x' })).toThrow('does not accept field "title"')
    expect(() => readReportAgentRunRequest({ ...base, kind: 'done' })).toThrow('kind must be one of')
    expect(() => readReportAgentRunRequest({ ...base, verifications: [{ command: 'a', status: 'ok' }] })).toThrow('status must be one of')
    expect(() => readReportAgentRunRequest({ ...base, verifications: [{ command: 'a\nb', status: 'passed' }] })).toThrow('on one line')
    expect(() => readReportAgentRunRequest({ ...base, artifacts: Array.from({ length: 21 }, () => ({ type: 'url', url: 'https://a.test' })) }))
      .toThrow('at most 20 items')
    expect(() => readReportAgentRunRequest({ ...base, changedFileCount: -1 })).toThrow('changedFileCount')
    expect(() => readReportAgentRunRequest({ ...base, message: ' ' })).toThrow('message must be')
    expect(() => readReportAgentRunRequest({ ...base, message: 'x'.repeat(3_901) })).toThrow('message must be')
    expect(() => readReportAgentRunRequest({ message: 'Note' })).toThrow('instanceId')
  })

  test('accepts only https artifact URLs without credentials', () => {
    expect(readAgentRunArtifactUrl('https://github.com/example/repo/pull/1', '/url')).toBe('https://github.com/example/repo/pull/1')
    expect(readAgentRunArtifactUrl('https://github.com/example/repo/pull/1#discussion_r1', '/url')).toBe('https://github.com/example/repo/pull/1#discussion_r1')
    for (const url of [
      // Query strings and parameterized fragments are where presigned links and tokens live.
      'https://bucket.s3.amazonaws.com/log.txt?X-Amz-Credential=a&X-Amz-Signature=b',
      'https://example.test/build?access_token=secret',
      'https://example.test/build?',
      'https://example.test/callback#access_token=secret',
      'http://github.com/example',
      'https://user:secret@github.com/example',
      'https://token@github.com/example',
      'javascript:alert(1)',
      'https:///path',
      'https://@github.com/example',
      'https://github.com\\@evil.test/example',
      'https://github.com/a\\b',
      ' https://github.com',
      'https://github.com/a b',
      `https://example.test/${'a'.repeat(2_048)}`,
      42,
    ]) {
      expect(() => readAgentRunArtifactUrl(url, '/artifacts/0/url')).toThrow(expect.objectContaining({
        category: 'validation_failed', reason: 'invalid_artifact_url', pointer: '/artifacts/0/url',
      }))
    }
  })

  test('publishes the shared patterns in the OpenAPI document', () => {
    const schemas = PUBLIC_API_OPENAPI_DOCUMENT.components.schemas
    expect(schemas.AgentRunArtifact.properties.url.pattern).toBe(AGENT_RUN_ARTIFACT_URL_PATTERN)
    expect(schemas.AgentRunArtifact.properties.label.pattern).toBe(AGENT_RUN_REPORT_LINE_PATTERN)
    expect(schemas.AgentRunVerification.properties.command.pattern).toBe(AGENT_RUN_REPORT_LINE_PATTERN)
    expect(schemas.AgentRunVerification.properties.summary.pattern).toBe(AGENT_RUN_REPORT_LINE_PATTERN)
    expect(schemas.ReportAgentRunRequest.properties.message.pattern).toBe(AGENT_RUN_REPORT_MESSAGE_PATTERN)
  })

  test('agrees with the published one-line text and message patterns', () => {
    /**
     * Checks whether the server accepts a value as a verification command.
     *
     * @param command - Command text.
     * @returns True when the server accepts it.
     */
    const acceptsCommand = (command: string) => {
      try {
        readReportAgentRunRequest({ instanceId: 'laptop-1', message: 'Ran', verifications: [{ command, status: 'passed' }] })
        return true
      } catch {
        return false
      }
    }
    /**
     * Checks whether the server accepts a value as a report message.
     *
     * @param message - Message text.
     * @returns True when the server accepts it.
     */
    const acceptsMessage = (message: string) => {
      try {
        readReportAgentRunRequest({ instanceId: 'laptop-1', message })
        return true
      } catch {
        return false
      }
    }
    const line = new RegExp(AGENT_RUN_REPORT_LINE_PATTERN)
    const message = new RegExp(AGENT_RUN_REPORT_MESSAGE_PATTERN)
    for (const value of ['bun test', ' bun test ', 'bun\ttest', 'bun\ntest', 'bun\rtest', '   ', '\t', 'bun\u0001test', 'bun\u007ftest']) {
      expect({ value, accepted: line.test(value) }).toEqual({ value, accepted: acceptsCommand(value) })
    }
    for (const value of ['Done', 'Line 1\nLine 2', 'Line 1\r\nLine 2', 'Tab\there', '   ', '\n\n', 'Bell\u0007', 'Form\ffeed']) {
      expect({ value, accepted: message.test(value) }).toEqual({ value, accepted: acceptsMessage(value) })
    }
  })

  test('agrees with the OpenAPI artifact URL pattern', () => {
    const pattern = new RegExp(AGENT_RUN_ARTIFACT_URL_PATTERN)
    for (const url of [
      'https://github.com/example/repo/pull/1',
      'https://github.com/example/repo/pull/1#discussion_r1',
      'https://example.test',
      'https://example.test:8443/a@b/c#top',
      'https://example.test/log?token=x',
      'https://example.test/log#access_token=x',
      'https://example.test/log#a?b',
      'https://user:pass@example.test/log',
      'https://@example.test/log',
      'https://example.test\\@evil.test/log',
      'https://example.test/a\\b',
      'https:///path',
      'https://example.test/a b',
      'https://example.test/a\tb',
    ]) {
      /**
       * Checks whether the server accepts the URL.
       *
       * @returns True when the server stores the URL.
       */
      const accepted = () => {
        try {
          readAgentRunArtifactUrl(url, '/url')
          return true
        } catch {
          return false
        }
      }
      expect({ url, accepted: pattern.test(url) }).toEqual({ url, accepted: accepted() })
    }
  })
})

describe('DynamoDB Agent Run reports', () => {
  test('numbers a report by the run, renews the lease, and checks the claim', () => {
    const run = createRun({ reportCount: 2 })
    const store = new DynamoDbAgentRunStore(createClient().client, 'AgentRuns')
    const [runUpdate, claimCheck, reportPut] = store.createReportItems(run, createReport(run), now)
    expect(runUpdate?.Update).toMatchObject({
      Key: { recordKey: `agent-run#${run.runId}` },
      ConditionExpression: '#state = :active AND #instanceIdHash = :instanceIdHash AND #reportCount = :previous AND #lastHeartbeatAt <= :now',
      ExpressionAttributeValues: {
        ':sequence': 3, ':previous': 2, ':kind': 'verification', ':now': now.toISOString(),
        ':leaseExpiresAt': '2026-10-22T00:30:00.000Z', ':instanceIdHash': run.instanceIdHash,
      },
    })
    expect(claimCheck?.ConditionCheck).toMatchObject({
      Key: { recordKey: 'agent-run-claim#task-1' },
      ExpressionAttributeValues: { ':runId': run.runId, ':instanceIdHash': run.instanceIdHash },
    })
    expect(reportPut?.Put).toMatchObject({
      Item: {
        recordKey: `agent-run-report#task-1#${now.toISOString()}#${run.runId}#000003`,
        entityType: 'agent-run-report', workspaceId: 'workspace-1', sequence: 3, commentId: 'cmt_1',
      },
      ConditionExpression: 'attribute_not_exists(recordKey)',
    })
    expect(() => store.createReportItems(run, createReport(run, { sequence: 2 }), now)).toThrow(TypeError)
    expect(() => store.createReportItems(createRun({ state: 'finished' }), createReport(run), now)).toThrow(TypeError)
  })

  test('encodes the Work Item ID so that report keys of different Work Items never share a prefix', () => {
    const run = createRun({ workItemId: 'a#b' })
    const store = new DynamoDbAgentRunStore(createClient().client, 'AgentRuns')
    const [, , reportPut] = store.createReportItems(run, createReport(run), now)
    expect(String(reportPut?.Put?.Item?.recordKey)).toStartWith('agent-run-report#a%23b#')
  })

  test('lists a Work Item\'s reports newest first with strong reads and fails closed on foreign rows', async () => {
    const run = createRun()
    const builder = new DynamoDbAgentRunStore(createClient().client, 'AgentRuns')
    const item = builder.createReportItems(run, createReport(run), now)[2]?.Put?.Item
    if (!item) throw new Error('The report put must carry an item.')
    const { client, commands } = createClient([{ Items: [item] }])
    const page = await new DynamoDbAgentRunStore(client, 'AgentRuns').listWorkItemReports('workspace-1', 'core', 'task-1', undefined, 20)
    expect(page.reports.map(toAgentRunReport)).toEqual([{
      schemaVersion: 1, runId: run.runId, teamId: 'core', workItemId: 'task-1', sequence: 1, kind: 'verification', commentId: 'cmt_1',
      verifications: [{ command: 'bun test', status: 'passed' }],
      artifacts: [{ type: 'pull-request', url: 'https://github.com/example/repo/pull/1' }],
      createdAt: now.toISOString(),
    }])
    const query = commands[0]
    if (!(query instanceof QueryCommand)) throw new Error('Reports must be queried.')
    expect(query.input).toMatchObject({
      KeyConditionExpression: '#directoryTeamId = :partition AND begins_with(#recordKey, :prefix)',
      ExpressionAttributeValues: { ':partition': 'workspace-1#team#core', ':prefix': 'agent-run-report#task-1#' },
      ScanIndexForward: false,
      ConsistentRead: true,
    })
    // A page that ends exactly at the limit has no older reports, even when DynamoDB returns a key.
    const exact = createClient([{ Items: [item], LastEvaluatedKey: { directoryTeamId: item.directoryTeamId, recordKey: item.recordKey } }, { Items: [] }])
    const exactPage = await new DynamoDbAgentRunStore(exact.client, 'AgentRuns').listWorkItemReports('workspace-1', 'core', 'task-1', undefined, 1)
    expect(exactPage).toEqual({ reports: [expect.objectContaining({ sequence: 1 })] })
    expect(exact.commands).toHaveLength(2)
    // More reports than the limit continue after the last returned report.
    const older = { ...item, recordKey: `agent-run-report#task-1#2026-10-21T00:00:00.000Z#${run.runId}#000001`, createdAt: '2026-10-21T00:00:00.000Z' }
    const more = createClient([{ Items: [item, older] }])
    const morePage = await new DynamoDbAgentRunStore(more.client, 'AgentRuns').listWorkItemReports('workspace-1', 'core', 'task-1', undefined, 1)
    expect(morePage.reports).toHaveLength(1)
    expect(JSON.parse(Buffer.from(morePage.nextCursor ?? '', 'base64url').toString('utf8')))
      .toEqual({ directoryTeamId: 'workspace-1#team#core', recordKey: item.recordKey })
    const foreign = createClient([{ Items: [{ ...item, workItemId: 'task-2' }] }])
    await expect(new DynamoDbAgentRunStore(foreign.client, 'AgentRuns').listWorkItemReports('workspace-1', 'core', 'task-1', undefined, 20))
      .rejects.toMatchObject({ category: 'temporarily_unavailable' })
    // A stored URL that the request validator would reject never reaches viewers.
    const unsafe = createClient([{ Items: [{ ...item, artifacts: [{ type: 'url', url: 'https://example.test/log?token=secret' }] }] }])
    await expect(new DynamoDbAgentRunStore(unsafe.client, 'AgentRuns').listWorkItemReports('workspace-1', 'core', 'task-1', undefined, 20))
      .rejects.toMatchObject({ category: 'temporarily_unavailable' })
    const cursor = Buffer.from(JSON.stringify({ directoryTeamId: 'workspace-1#team#core', recordKey: 'agent-run#other' })).toString('base64url')
    await expect(new DynamoDbAgentRunStore(createClient().client, 'AgentRuns').listWorkItemReports('workspace-1', 'core', 'task-1', cursor, 20))
      .rejects.toMatchObject({ category: 'validation_failed' })
  })
})

describe('in-memory Agent Run reports', () => {
  test('saves reports in order and rejects a stale report count or another instance', () => {
    const store = new InMemoryAgentRunStore()
    const run = createRun()
    store.seed(run)
    store.applyTransactItems(store.createReportItems(run, createReport(run), now))
    const runKey = `workspace-1|core|${run.runId}`
    expect(store.state.runs.get(runKey)).toMatchObject({
      reportCount: 1, lastReportKind: 'verification', lastReportAt: now.toISOString(), leaseExpiresAt: '2026-10-22T00:30:00.000Z',
    })
    // A second report built from the same read loses to the first.
    expect(() => store.applyTransactItems(store.createReportItems(run, createReport(run), now))).toThrow('Transaction cancelled.')
    const current = store.state.runs.get(runKey)
    if (!current) throw new Error('The run must exist.')
    store.applyTransactItems(store.createReportItems(current, createReport(current, { kind: 'blocker' }), now))
    expect(store.state.reports.size).toBe(2)
    store.state.claims.set('workspace-1|core|task-1', { workItemId: 'task-1', runId: run.runId, instanceIdHash: 'other', assigneeUserId: 'member-1' })
    const latest = store.state.runs.get(runKey)
    if (!latest) throw new Error('The run must exist.')
    expect(() => store.applyTransactItems(store.createReportItems(latest, createReport(latest), now))).toThrow('Transaction cancelled.')
  })

  test('keeps a heartbeat that is newer than the report', () => {
    const store = new InMemoryAgentRunStore()
    const run = createRun()
    store.seed(run)
    const runKey = `workspace-1|core|${run.runId}`
    store.state.runs.set(runKey, { ...run, lastHeartbeatAt: '2026-10-22T00:00:05.000Z', leaseExpiresAt: '2026-10-22T00:30:05.000Z' })
    expect(() => store.applyTransactItems(store.createReportItems(run, createReport(run), now))).toThrow('Transaction cancelled.')
    expect(store.state.runs.get(runKey)).toMatchObject({ reportCount: 0, leaseExpiresAt: '2026-10-22T00:30:05.000Z' })
  })
})
