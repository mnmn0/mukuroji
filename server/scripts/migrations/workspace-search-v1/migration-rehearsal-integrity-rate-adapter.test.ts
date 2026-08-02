import { describe, expect, test } from 'bun:test'
import {
  DescribeTableCommand,
  type DescribeTableCommandOutput,
} from '@aws-sdk/client-dynamodb'
import type {
  CrossDomainIntegrityAwsTransport,
} from '../../data-integrity/verify-cross-domain-integrity'
import type {
  WorkspaceSearchMigrationDescribeTablePhase,
  WorkspaceSearchMigrationDescribeTableRateEvidence,
} from './migration-describe-table-rate-budget'
import type {
  WorkspaceSearchMigrationManagedDescribeTableRate,
} from './migration-describe-table-rate-managed-session'
import {
  consumeWorkspaceSearchMigrationRehearsalIntegrityRateSequence,
  createWorkspaceSearchMigrationRehearsalIntegrityRateAdapter,
  WORKSPACE_SEARCH_MIGRATION_REHEARSAL_INTEGRITY_RATE_PHASE,
  type WorkspaceSearchMigrationRehearsalIntegrityRateAdapter,
  type WorkspaceSearchMigrationRehearsalIntegrityRateSequence,
  type WorkspaceSearchMigrationRehearsalIntegrityTablePassCount,
} from './migration-rehearsal-integrity-rate-adapter'

/** Canonical physical table names in the #163 reader's fixed order. */
const orderedTableNames = Object.freeze([
  'audit-events-table',
  'file-proofing-table',
  'project-directory-table',
  'work-item-configuration-table',
  'work-items-table',
  'workspace-access-table',
])

/** One observed rate-owned DescribeTable invocation. */
type ObservedDescribeTableCall = {
  /** Exact physical table name. */
  readonly tableName: string
  /** Exact semantic durable rate phase. */
  readonly phase: WorkspaceSearchMigrationDescribeTablePhase
  /** Caller-owned cancellation propagated by the reader. */
  readonly signal?: AbortSignal
}

/** Complete deterministic adapter fixture. */
type IntegrityRateAdapterFixture = {
  /** Adapter under test. */
  readonly adapter: WorkspaceSearchMigrationRehearsalIntegrityRateAdapter
  /** Calls that reached the durable rate owner. */
  readonly rateCalls: ObservedDescribeTableCall[]
  /** Number of complete non-page gates entered. */
  readonly nonPageOperationCount: () => number
  /** Number of calls that reached the forbidden base DescribeTable method. */
  readonly baseDescribeTableCount: () => number
}

/** Controllable one-shot response used by fire-and-forget tests. */
type DeferredDescribeTableResponse = {
  /** Pending rate-owned response. */
  readonly promise: Promise<DescribeTableCommandOutput>
  /** Resolves the pending response exactly once. */
  readonly resolve: () => void
}

/** Exact immutable object causally returned by one canonical adapter task. */
type CanonicalPassResult = {
  /** Fixed result marker used only for identity tests. */
  readonly kind: 'canonical-pass-result'
}

/** Creates the finite aggregate required by the managed-rate fixture. */
function rateEvidence(
  attemptCount = 0,
): WorkspaceSearchMigrationDescribeTableRateEvidence {
  return {
    version: 2,
    policyVersion: 'a'.repeat(64),
    attemptCount,
    forfeitedAttemptCount: 0,
    throttleCount: 0,
    awsServiceThrottleCount: 0,
    rehearsalInjectedThrottleCount: 0,
    budgetStopCount: 0,
    operationalBudgetStopCount: 0,
    awsServiceThrottleBudgetStopCount: 0,
    rehearsalInjectedBudgetStopCount: 0,
    cadenceWaitCount: 0,
    cadenceWaitMilliseconds: 0,
    maximumInFlight: attemptCount === 0 ? 0 : 1,
  }
}

/** Creates one fully shaped read-only base transport. */
function createBaseTransport(
  observeDescribeTable: () => void,
): CrossDomainIntegrityAwsTransport {
  return {
    /** Records any forbidden ordinary DescribeTable fallback. */
    async describeTable(): Promise<DescribeTableCommandOutput> {
      observeDescribeTable()
      return { $metadata: {} }
    },
    /** No-op fixture close. */
    close(): void {},
    /** Returns empty S3 versioning metadata. */
    async getBucketVersioning() {
      return { $metadata: {} }
    },
    /** Returns empty exact-object metadata. */
    async getObjectAttributes() {
      return { $metadata: {} }
    },
    /** Returns empty exact-object tags. */
    async getObjectTagging() {
      return { $metadata: {}, TagSet: [] }
    },
    /** Returns empty exact-object headers. */
    async headObject() {
      return { $metadata: {} }
    },
    /** Returns empty caller identity metadata. */
    async readCallerIdentity() {
      return { $metadata: {} }
    },
    /** Returns an empty bounded Scan page. */
    async scan() {
      return { $metadata: {} }
    },
  }
}

/** Creates one managed-rate fixture with an optional physical-call failure. */
function createFixture(
  tablePassCount: WorkspaceSearchMigrationRehearsalIntegrityTablePassCount,
  failAtCall?: number,
  deferredAtCall?: {
    /** One-based physical call to hold unsettled. */
    readonly call: number
    /** Pending response injected at that call. */
    readonly response: DeferredDescribeTableResponse
  },
): IntegrityRateAdapterFixture {
  const rateCalls: ObservedDescribeTableCall[] = []
  let nonPageOperations = 0
  let baseDescribeTableCalls = 0
  const rate: WorkspaceSearchMigrationManagedDescribeTableRate = {
    /** Records one maxAttempts=1 DescribeTable handoff. */
    async describeTable(tableName, phase, signal) {
      rateCalls.push({ tableName, phase, signal })
      if (rateCalls.length === failAtCall) {
        throw new Error('simulated durable physical-attempt failure')
      }
      if (rateCalls.length === deferredAtCall?.call) {
        return await deferredAtCall.response.promise
      }
      return { $metadata: {} }
    },
    /** Runs an unused checkpoint-page fixture task. */
    async runCheckpointPage(_input, task) {
      return await task()
    },
    /** Runs an unused mandatory-cleanup fixture task. */
    async runMandatoryCleanup(task) {
      return await task()
    },
    /** Runs the complete integrity operation under one gate. */
    async runNonPageOperation(task) {
      nonPageOperations += 1
      return await task()
    },
    /** Runs an unused mutation-guard fixture task. */
    async runWithMutationAdmissionGuard(_guard, task) {
      return await task()
    },
    /** Accepts fixture data I/O. */
    assertNewDataIoAllowed(): void {},
    /** Accepts an unused fixture lease claim. */
    async claimAfterLease(): Promise<void> {},
    /** No-op fixture interruption. */
    interrupt(): void {},
    /** No-op fixture quarantine. */
    quarantine(): void {},
    /** Returns the fixture aggregate at the current physical-attempt count. */
    readEvidence: () => rateEvidence(rateCalls.length),
    /** Returns the immutable empty fixture aggregate after close. */
    async closeAndReadEvidence() {
      return rateEvidence(rateCalls.length)
    },
    /** No-op fixture close. */
    async close(): Promise<void> {},
  }
  const baseTransport = createBaseTransport(() => {
    baseDescribeTableCalls += 1
  })
  return {
    adapter: createWorkspaceSearchMigrationRehearsalIntegrityRateAdapter({
      tableNames: {
        'audit-events': orderedTableNames[0] ?? '',
        'file-proofing': orderedTableNames[1] ?? '',
        'project-directory': orderedTableNames[2] ?? '',
        'work-item-configuration': orderedTableNames[3] ?? '',
        'work-items': orderedTableNames[4] ?? '',
        'workspace-access': orderedTableNames[5] ?? '',
      },
      tablePassCount,
      baseTransport,
      rate,
    }),
    rateCalls,
    nonPageOperationCount: () => nonPageOperations,
    baseDescribeTableCount: () => baseDescribeTableCalls,
  }
}

/** Creates one controllable successful DescribeTable response. */
function createDeferredDescribeTableResponse(): DeferredDescribeTableResponse {
  let settle: (() => void) | undefined
  const promise = new Promise<DescribeTableCommandOutput>((resolve) => {
    settle = (): void => resolve({ $metadata: {} })
  })
  return {
    promise,
    resolve: (): void => {
      const captured = settle
      settle = undefined
      if (captured === undefined) {
        throw new Error('Deferred response was already settled.')
      }
      captured()
    },
  }
}

/** Runs the requested number of canonical six-table passes. */
async function runCanonicalPasses(
  adapter: WorkspaceSearchMigrationRehearsalIntegrityRateAdapter,
  passCount: WorkspaceSearchMigrationRehearsalIntegrityTablePassCount,
  signal: AbortSignal,
): Promise<CanonicalPassResult> {
  return await adapter.run(async () => {
    for (let pass = 0; pass < passCount; pass += 1) {
      for (const tableName of orderedTableNames) {
        await adapter.describeTable(
          new DescribeTableCommand({ TableName: tableName }),
          signal,
        )
      }
    }
    return Object.freeze({ kind: 'canonical-pass-result' })
  })
}

describe('migration rehearsal #163 rate-owned transport', () => {
  /** Verifies one exact successful pass-count contract. */
  async function expectCanonicalPasses(
    passCount: WorkspaceSearchMigrationRehearsalIntegrityTablePassCount,
  ): Promise<void> {
    const fixture = createFixture(passCount)
    const signal = AbortSignal.timeout(60_000)

    const taskResult = await runCanonicalPasses(
      fixture.adapter,
      passCount,
      signal,
    )
    const proof = fixture.adapter.takeCompletedSequence(taskResult)

    expect(fixture.nonPageOperationCount()).toBe(1)
    expect(fixture.baseDescribeTableCount()).toBe(0)
    expect(fixture.rateCalls.map((call) => call.tableName)).toEqual(
      Array.from({ length: passCount }, () => orderedTableNames).flat(),
    )
    expect(fixture.rateCalls.every((call) =>
      call.phase ===
        WORKSPACE_SEARCH_MIGRATION_REHEARSAL_INTEGRITY_RATE_PHASE &&
      call.signal === signal)).toBe(true)
    expect(proof).toMatchObject({
      phase: 'integrity-check',
      tablePassCount: passCount,
      describeTableCallCount: passCount * 6,
      firstAttemptSequence: 1,
      lastAttemptSequence: passCount * 6,
    })
    expect(proof.tableOrderBindingDigest).toMatch(/^[0-9a-f]{64}$/u)
    expect(() => fixture.adapter.takeCompletedSequence(taskResult)).toThrow(
      'INVALID_REHEARSAL_INTEGRITY_RATE_SEQUENCE',
    )
  }

  test('routes one canonical pass only through integrity-check', async () => {
    await expectCanonicalPasses(1)
  })

  test('routes two canonical passes only through integrity-check', async () => {
    await expectCanonicalPasses(2)
  })

  test('sequence capability rejects forgery, cloning, and replay', async () => {
    const fixture = createFixture(1)
    const taskResult = await runCanonicalPasses(
      fixture.adapter,
      1,
      AbortSignal.timeout(60_000),
    )
    expect(() =>
      fixture.adapter.takeCompletedSequence({ ...taskResult })
    ).toThrow('INVALID_REHEARSAL_INTEGRITY_RATE_SEQUENCE')
    const capability = fixture.adapter.takeCompletedSequence(taskResult)
    const clone = structuredClone(capability)
    const forged: WorkspaceSearchMigrationRehearsalIntegrityRateSequence = {
      ...capability,
    }

    expect(() =>
      consumeWorkspaceSearchMigrationRehearsalIntegrityRateSequence(
        clone,
        taskResult,
      )
    ).toThrow('INVALID_REHEARSAL_INTEGRITY_RATE_SEQUENCE')
    expect(() =>
      consumeWorkspaceSearchMigrationRehearsalIntegrityRateSequence(
        forged,
        taskResult,
      )
    ).toThrow('INVALID_REHEARSAL_INTEGRITY_RATE_SEQUENCE')
    expect(() =>
      consumeWorkspaceSearchMigrationRehearsalIntegrityRateSequence(
        capability,
        { ...taskResult },
      )
    ).toThrow('INVALID_REHEARSAL_INTEGRITY_RATE_SEQUENCE')
    expect(
      consumeWorkspaceSearchMigrationRehearsalIntegrityRateSequence(
        capability,
        taskResult,
      ),
    ).toEqual(capability)
    expect(() =>
      consumeWorkspaceSearchMigrationRehearsalIntegrityRateSequence(
        capability,
        taskResult,
      )
    ).toThrow('INVALID_REHEARSAL_INTEGRITY_RATE_SEQUENCE')
  })

  test('rejects out-of-order, incomplete, and extra DescribeTable calls', async () => {
    const signal = AbortSignal.timeout(60_000)
    const outOfOrder = createFixture(1)
    await expect(outOfOrder.adapter.run(async () => {
      await outOfOrder.adapter.describeTable(
        new DescribeTableCommand({ TableName: orderedTableNames[1] }),
        signal,
      )
    })).rejects.toThrow('INVALID_REHEARSAL_INTEGRITY_RATE_SEQUENCE')
    expect(outOfOrder.rateCalls).toHaveLength(0)

    const incomplete = createFixture(1)
    await expect(incomplete.adapter.run(async () => undefined)).rejects.toThrow(
      'INVALID_REHEARSAL_INTEGRITY_RATE_SEQUENCE',
    )

    const extra = createFixture(1)
    await expect(extra.adapter.run(async () => {
      for (const tableName of [...orderedTableNames, orderedTableNames[0]]) {
        await extra.adapter.describeTable(
          new DescribeTableCommand({ TableName: tableName }),
          signal,
        )
      }
    })).rejects.toThrow('INVALID_REHEARSAL_INTEGRITY_RATE_SEQUENCE')
    expect(extra.rateCalls).toHaveLength(6)
    expect(extra.baseDescribeTableCount()).toBe(0)
  })

  test('retains a partial rate-owned failure and never enables fallback', async () => {
    const fixture = createFixture(2, 7)

    await expect(runCanonicalPasses(
      fixture.adapter,
      2,
      AbortSignal.timeout(60_000),
    )).rejects.toThrow('simulated durable physical-attempt failure')

    expect(fixture.rateCalls).toHaveLength(7)
    expect(fixture.rateCalls.every((call) =>
      call.phase === 'integrity-check')).toBe(true)
    expect(fixture.baseDescribeTableCount()).toBe(0)
    expect(() => fixture.adapter.takeCompletedSequence({})).toThrow(
      'INVALID_REHEARSAL_INTEGRITY_RATE_SEQUENCE',
    )
  })

  test('rejects fire-and-forget work and its completion after task settlement', async () => {
    const deferred = createDeferredDescribeTableResponse()
    const fixture = createFixture(1, undefined, {
      call: 1,
      response: deferred,
    })
    let escapedCall: Promise<DescribeTableCommandOutput> | undefined

    await expect(fixture.adapter.run(async () => {
      escapedCall = fixture.adapter.describeTable(
        new DescribeTableCommand({ TableName: orderedTableNames[0] }),
        AbortSignal.timeout(60_000),
      )
    })).rejects.toThrow('INVALID_REHEARSAL_INTEGRITY_RATE_SEQUENCE')
    const pendingCall = escapedCall
    if (pendingCall === undefined) {
      throw new Error('Fixture did not retain its escaped call.')
    }
    deferred.resolve()

    await expect(pendingCall).rejects.toThrow(
      'INVALID_REHEARSAL_INTEGRITY_RATE_SEQUENCE',
    )
    expect(fixture.rateCalls).toHaveLength(1)
    expect(fixture.baseDescribeTableCount()).toBe(0)
    expect(() => fixture.adapter.takeCompletedSequence({})).toThrow(
      'INVALID_REHEARSAL_INTEGRITY_RATE_SEQUENCE',
    )
  })
})
