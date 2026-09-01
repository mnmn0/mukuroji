import { describe, expect, test } from 'bun:test'
import {
  RESTORE_DRILL_RESOURCE_TARGETS,
  RESTORE_DRILL_RPO_TARGET_SECONDS,
  RESTORE_DRILL_RTO_TARGET_SECONDS,
  RESTORE_DRILL_TABLE_TARGETS,
  RestoreDrillFailure,
  RestoreDrillKeyedMultisetDigestAccumulator,
  calculateRestoreDrillDatasetDigest,
  calculateRestoreDrillObjectives,
  calculateRestoreDrillResourceDigest,
  calculateRestoreDrillResultDigest,
  compareRestoreDrillDatasetAggregates,
  createRestoreDrillCleanupApprovalReceipt,
  createRestoreDrillCleanupExecutionName,
  evaluateRestoreDrillCleanupApproval,
  parseRestoreDrillDatasetAggregate,
  parseRestoreDrillRunState,
  selectLatestCommonRestorePoint,
  type RestoreDrillCleanupApprovalBinding,
  type RestoreDrillDatasetAggregate,
  type RestoreDrillDatasetRole,
  type RestoreDrillPitrWindow,
  type RestoreDrillResourceAggregate,
  type RestoreDrillResourceIdentity,
  type RestoreDrillResourceTarget,
  type RestoreDrillResultEvidence,
} from './restore-drill'

const DIGEST_KEY = Uint8Array.from({ length: 32 }, (_, index) => index + 1)
const OTHER_DIGEST_KEY = Uint8Array.from({ length: 32 }, (_, index) => 255 - index)
const RESTORE_POINT = '2026-07-31T23:55:00.000Z'
const STARTED_AT = '2026-08-01T00:00:00.000Z'
const COMPLETED_AT = '2026-08-01T04:00:00.000Z'
const DIGEST_A = 'a'.repeat(64)
const DIGEST_B = 'b'.repeat(64)
const DIGEST_C = 'c'.repeat(64)
const DIGEST_D = 'd'.repeat(64)

/** Optional exact aggregate differences used by one resource fixture. */
type ResourceAggregateOptions = {
  /** Optional content digest replacement. */
  contentDigest?: string
  /** Optional descriptor digest replacement. */
  descriptorDigest?: string
  /** Optional logical partition count replacement. */
  logicalPartitionCount?: number
  /** Optional metadata digest replacement. */
  metadataDigest?: string
  /** Optional record count replacement. */
  recordCount?: number
}

/**
 * Creates seven valid PITR windows in canonical order.
 *
 * @returns Complete PITR window vector.
 */
function createPitrWindows(): RestoreDrillPitrWindow[] {
  return RESTORE_DRILL_TABLE_TARGETS.map((target, index) => ({
    earliestRestorableTime: new Date(Date.UTC(2026, 6, index + 1)).toISOString(),
    latestRestorableTime: new Date(Date.UTC(2026, 6, 31, 23, 59, 59 - index)).toISOString(),
    target,
  }))
}

/**
 * Creates one strict exact resource aggregate.
 *
 * @param target - Canonical logical resource target.
 * @param options - Optional exact aggregate differences.
 * @returns Resource aggregate fixture.
 */
function createResourceAggregate(
  target: RestoreDrillResourceTarget,
  options: ResourceAggregateOptions = {},
): RestoreDrillResourceAggregate {
  return {
    contentDigest: options.contentDigest ?? DIGEST_A,
    descriptorDigest: options.descriptorDigest ?? DIGEST_B,
    logicalPartitionCount: options.logicalPartitionCount ?? 3,
    metadataDigest: options.metadataDigest ?? DIGEST_C,
    recordCount: options.recordCount ?? 7,
    target,
  }
}

/**
 * Creates a complete source or restore aggregate in canonical resource order.
 *
 * @param role - Source-export or isolated-restore role.
 * @returns Complete aggregate fixture.
 */
function createDatasetAggregate(role: RestoreDrillDatasetRole): RestoreDrillDatasetAggregate {
  return {
    keyFingerprint: DIGEST_D,
    resources: RESTORE_DRILL_RESOURCE_TARGETS.map((target) => createResourceAggregate(target)),
    restorePoint: RESTORE_POINT,
    role,
  }
}

/**
 * Creates the complete physical-resource identity vector.
 *
 * @returns Canonically ordered secret-free identities.
 */
function createResourceIdentities(): RestoreDrillResourceIdentity[] {
  return RESTORE_DRILL_RESOURCE_TARGETS.map((target, index) => ({
    identityDigest: index % 2 === 0 ? DIGEST_A : DIGEST_B,
    target,
  }))
}

/**
 * Creates valid terminal pass evidence.
 *
 * @returns Strict final restore-drill result fixture.
 */
function createResultEvidence(): RestoreDrillResultEvidence {
  return {
    completedAt: COMPLETED_AT,
    comparison: { failureCodes: [], status: 'pass' },
    drillId: 'restore-drill-2026-08-01',
    failureCodes: [],
    kind: 'mukuroji-restore-drill-result',
    objectives: calculateRestoreDrillObjectives({
      completedAt: COMPLETED_AT,
      restorePoint: RESTORE_POINT,
      startedAt: STARTED_AT,
    }),
    resourceDigest: DIGEST_A,
    restorePoint: RESTORE_POINT,
    restoreAggregateDigest: DIGEST_B,
    resultVersion: 1,
    runState: { outcome: 'pass', phase: 'completed' },
    sourceAggregateDigest: DIGEST_C,
    startedAt: STARTED_AT,
  }
}

/**
 * Creates valid cleanup approval fields.
 *
 * @param overrides - Optional field replacements.
 * @returns Cleanup approval binding fixture.
 */
function createApprovalBinding(
  overrides: Partial<RestoreDrillCleanupApprovalBinding> = {},
): RestoreDrillCleanupApprovalBinding {
  return {
    approver: 'operator@example.com',
    approvedAt: '2026-08-01T05:00:00.000Z',
    changeLocator: 'https://github.com/mnmn0/mukuroji/issues/159#cleanup',
    drillId: 'restore-drill-2026-08-01',
    expiresAt: '2026-08-01T06:00:00.000Z',
    policyVersion: 'restore-cleanup-v1',
    resourceDigest: DIGEST_A,
    resultDigest: DIGEST_B,
    ...overrides,
  }
}

describe('restore drill contract', () => {
  test('fixes the seven table targets and eight resource targets in canonical order', () => {
    expect(RESTORE_DRILL_TABLE_TARGETS).toEqual([
      'table:audit-events',
      'table:file-proofing',
      'table:project-directory',
      'table:work-item-configuration',
      'table:work-items',
      'table:workspace-access',
      'table:customers',
    ])
    expect(RESTORE_DRILL_RESOURCE_TARGETS).toEqual([
      'bucket:file',
      ...RESTORE_DRILL_TABLE_TARGETS,
    ])
    expect(Object.isFrozen(RESTORE_DRILL_TABLE_TARGETS)).toBe(true)
    expect(Object.isFrozen(RESTORE_DRILL_RESOURCE_TARGETS)).toBe(true)
  })

  test('strictly accepts active and terminal phase/outcome combinations', () => {
    expect(parseRestoreDrillRunState({
      outcome: 'in-progress',
      phase: 'restoring-tables',
    })).toEqual({ outcome: 'in-progress', phase: 'restoring-tables' })
    expect(parseRestoreDrillRunState({ outcome: 'pass', phase: 'completed' })).toEqual({
      outcome: 'pass',
      phase: 'completed',
    })
    expect(parseRestoreDrillRunState({ outcome: 'fail', phase: 'failed' })).toEqual({
      outcome: 'fail',
      phase: 'failed',
    })
  })

  test('rejects impossible state pairs and unknown persisted fields', () => {
    expect(() => parseRestoreDrillRunState({
      outcome: 'pass',
      phase: 'verifying',
    })).toThrow(new RestoreDrillFailure('RUN_STATE_INVALID'))
    expect(() => parseRestoreDrillRunState({
      outcome: 'in-progress',
      phase: 'completed',
    })).toThrow(new RestoreDrillFailure('RUN_STATE_INVALID'))
    expect(() => parseRestoreDrillRunState({
      outcome: 'pass',
      phase: 'completed',
      rawError: 'secret',
    })).toThrow(new RestoreDrillFailure('RUN_STATE_INVALID'))
  })
})

describe('restore point and objectives', () => {
  test('chooses min(latest) when max(earliest) remains inside every window', () => {
    const windows = createPitrWindows()
    expect(selectLatestCommonRestorePoint(windows)).toEqual({
      commonEarliestRestorableTime: '2026-07-07T00:00:00.000Z',
      commonLatestRestorableTime: '2026-07-31T23:59:53.000Z',
      restorePoint: '2026-07-31T23:59:53.000Z',
    })
  })

  test('rejects incomplete, reordered, invalid, and disjoint PITR windows stably', () => {
    const windows = createPitrWindows()
    expect(() => selectLatestCommonRestorePoint(windows.slice(1))).toThrow(
      new RestoreDrillFailure('PITR_WINDOW_TARGET_MISMATCH'),
    )
    expect(() => selectLatestCommonRestorePoint([windows[1], windows[0], ...windows.slice(2)]))
      .toThrow(new RestoreDrillFailure('PITR_WINDOW_TARGET_MISMATCH'))
    expect(() => selectLatestCommonRestorePoint(windows.map((window, index) =>
      index === 0 ? { ...window, earliestRestorableTime: 'not-a-time' } : window
    ))).toThrow(new RestoreDrillFailure('PITR_WINDOW_INVALID'))
    expect(() => selectLatestCommonRestorePoint(windows.map((window, index) => {
      if (index === 0) {
        return { ...window, latestRestorableTime: '2026-07-05T00:00:00.000Z' }
      }
      return window
    }))).toThrow(new RestoreDrillFailure('PITR_WINDOW_NO_OVERLAP'))
  })

  test('meets the exact five-minute RPO and four-hour RTO limits', () => {
    expect(calculateRestoreDrillObjectives({
      completedAt: COMPLETED_AT,
      restorePoint: RESTORE_POINT,
      startedAt: STARTED_AT,
    })).toEqual({
      failureCodes: [],
      rpoMet: true,
      rpoSeconds: RESTORE_DRILL_RPO_TARGET_SECONDS,
      rpoTargetSeconds: RESTORE_DRILL_RPO_TARGET_SECONDS,
      rtoMet: true,
      rtoSeconds: RESTORE_DRILL_RTO_TARGET_SECONDS,
      rtoTargetSeconds: RESTORE_DRILL_RTO_TARGET_SECONDS,
    })
  })

  test('rounds fractional objective seconds upward and reports both misses', () => {
    expect(calculateRestoreDrillObjectives({
      completedAt: '2026-08-01T04:00:00.002Z',
      restorePoint: '2026-07-31T23:54:59.999Z',
      startedAt: STARTED_AT,
    })).toEqual({
      failureCodes: ['RPO_TARGET_MISSED', 'RTO_TARGET_MISSED'],
      rpoMet: false,
      rpoSeconds: 301,
      rpoTargetSeconds: RESTORE_DRILL_RPO_TARGET_SECONDS,
      rtoMet: false,
      rtoSeconds: 14_401,
      rtoTargetSeconds: RESTORE_DRILL_RTO_TARGET_SECONDS,
    })
  })

  test('rejects noncanonical or reversed objective timelines', () => {
    expect(() => calculateRestoreDrillObjectives({
      completedAt: COMPLETED_AT,
      restorePoint: '2026-07-31T23:55:00Z',
      startedAt: STARTED_AT,
    })).toThrow(new RestoreDrillFailure('OBJECTIVE_TIMELINE_INVALID'))
    expect(() => calculateRestoreDrillObjectives({
      completedAt: '2026-07-31T23:59:59.999Z',
      restorePoint: RESTORE_POINT,
      startedAt: STARTED_AT,
    })).toThrow(new RestoreDrillFailure('OBJECTIVE_TIMELINE_INVALID'))
  })
})

describe('keyed aggregate evidence', () => {
  test('produces the same digest across scan orders without exposing raw values', () => {
    const first = new RestoreDrillKeyedMultisetDigestAccumulator(DIGEST_KEY, 'items-v1')
    first.add('tenant-private:first')
    first.add('tenant-private:second')
    const second = new RestoreDrillKeyedMultisetDigestAccumulator(DIGEST_KEY, 'items-v1')
    second.add('tenant-private:second')
    second.add('tenant-private:first')

    expect(first.finalize()).toEqual(second.finalize())
    const serialized = JSON.stringify(first.finalize())
    expect(serialized).not.toContain('tenant-private')
    expect(serialized).not.toContain('first')
    expect(serialized).not.toContain('second')
  })

  test('preserves duplicate multiplicity and separates keys, domains, text, and bytes', () => {
    const single = new RestoreDrillKeyedMultisetDigestAccumulator(DIGEST_KEY, 'items-v1')
    single.add('same')
    const duplicate = new RestoreDrillKeyedMultisetDigestAccumulator(DIGEST_KEY, 'items-v1')
    duplicate.add('same')
    duplicate.add('same')
    const otherKey = new RestoreDrillKeyedMultisetDigestAccumulator(OTHER_DIGEST_KEY, 'items-v1')
    otherKey.add('same')
    const otherDomain = new RestoreDrillKeyedMultisetDigestAccumulator(DIGEST_KEY, 'objects-v1')
    otherDomain.add('same')
    const bytes = new RestoreDrillKeyedMultisetDigestAccumulator(DIGEST_KEY, 'items-v1')
    bytes.add(Buffer.from('same'))

    expect(single.finalize().aggregateDigest).not.toBe(duplicate.finalize().aggregateDigest)
    expect(single.finalize().aggregateDigest).not.toBe(otherKey.finalize().aggregateDigest)
    expect(single.finalize().aggregateDigest).not.toBe(otherDomain.finalize().aggregateDigest)
    expect(single.finalize().aggregateDigest).not.toBe(bytes.finalize().aggregateDigest)
    expect(duplicate.finalize().itemCount).toBe(2)
  })

  test('bounds retained digests and rejects writes after key zeroization', () => {
    const accumulator = new RestoreDrillKeyedMultisetDigestAccumulator(
      DIGEST_KEY,
      'items-v1',
      1,
    )
    accumulator.add('first')
    expect(() => accumulator.add('overflow')).toThrow(
      new RestoreDrillFailure('AGGREGATE_INVALID'),
    )
    const evidence = accumulator.finalize()
    expect(accumulator.finalize()).toEqual(evidence)
    expect(() => accumulator.add('after-finalize')).toThrow(
      new RestoreDrillFailure('AGGREGATE_INVALID'),
    )

    const abandoned = new RestoreDrillKeyedMultisetDigestAccumulator(
      DIGEST_KEY,
      'items-v1',
    )
    abandoned.add('discarded')
    abandoned.dispose()
    expect(() => abandoned.add('after-dispose')).toThrow(
      new RestoreDrillFailure('AGGREGATE_INVALID'),
    )
    expect(() => abandoned.finalize()).toThrow(
      new RestoreDrillFailure('AGGREGATE_INVALID'),
    )
  })

  test('rejects weak keys and noncanonical domains', () => {
    expect(() => new RestoreDrillKeyedMultisetDigestAccumulator(
      Uint8Array.from([1, 2, 3]),
      'items-v1',
    )).toThrow(new RestoreDrillFailure('DIGEST_KEY_INVALID'))
    expect(() => new RestoreDrillKeyedMultisetDigestAccumulator(
      DIGEST_KEY,
      'Items v1',
    )).toThrow(new RestoreDrillFailure('DIGEST_DOMAIN_INVALID'))
  })
})

describe('source export and isolated restore comparison', () => {
  test('passes an exact complete aggregate and calculates role-bound dataset digests', () => {
    const source = createDatasetAggregate('source-export')
    const restore = createDatasetAggregate('isolated-restore')

    expect(parseRestoreDrillDatasetAggregate(source)).toEqual(source)
    expect(compareRestoreDrillDatasetAggregates(source, restore)).toEqual({
      failureCodes: [],
      status: 'pass',
    })
    expect(calculateRestoreDrillDatasetDigest(source, DIGEST_KEY)).not.toBe(
      calculateRestoreDrillDatasetDigest(restore, DIGEST_KEY),
    )
  })

  test('reports every exact resource difference without raw target details', () => {
    const source = createDatasetAggregate('source-export')
    const restore = createDatasetAggregate('isolated-restore')
    restore.resources = restore.resources.map((resource, index) => index === 2
      ? createResourceAggregate(resource.target, {
        contentDigest: DIGEST_D,
        descriptorDigest: DIGEST_D,
        logicalPartitionCount: 4,
        metadataDigest: DIGEST_D,
        recordCount: 8,
      })
      : resource)

    const comparison = compareRestoreDrillDatasetAggregates(source, restore)
    expect(comparison).toEqual({
      failureCodes: [
        'AGGREGATE_CONTENT_MISMATCH',
        'AGGREGATE_DESCRIPTOR_MISMATCH',
        'AGGREGATE_METADATA_MISMATCH',
        'AGGREGATE_PARTITION_COUNT_MISMATCH',
        'AGGREGATE_RECORD_COUNT_MISMATCH',
      ],
      status: 'fail',
    })
    expect(JSON.stringify(comparison)).not.toContain('project-directory')
  })

  test('rejects missing, reordered, unknown, or malformed aggregate data', () => {
    const source = createDatasetAggregate('source-export')
    expect(() => parseRestoreDrillDatasetAggregate({
      ...source,
      resources: source.resources.slice(1),
    })).toThrow(new RestoreDrillFailure('AGGREGATE_RESOURCE_MISMATCH'))
    expect(() => parseRestoreDrillDatasetAggregate({
      ...source,
      resources: [source.resources[1], source.resources[0], ...source.resources.slice(2)],
    })).toThrow(new RestoreDrillFailure('AGGREGATE_RESOURCE_MISMATCH'))
    expect(() => parseRestoreDrillDatasetAggregate({ ...source, rawItems: ['secret'] }))
      .toThrow(new RestoreDrillFailure('AGGREGATE_INVALID'))
    expect(() => parseRestoreDrillDatasetAggregate({ ...source, keyFingerprint: DIGEST_A.toUpperCase() }))
      .toThrow(new RestoreDrillFailure('AGGREGATE_INVALID'))
  })

  test('binds every physical resource identity without exposing names', () => {
    const identities = createResourceIdentities()
    const digest = calculateRestoreDrillResourceDigest(identities, DIGEST_KEY)
    expect(digest).toMatch(/^[0-9a-f]{64}$/)
    expect(digest).not.toContain('bucket:file')
    expect(calculateRestoreDrillResourceDigest(identities, OTHER_DIGEST_KEY)).not.toBe(digest)
    expect(() => calculateRestoreDrillResourceDigest(identities.slice(1), DIGEST_KEY))
      .toThrow(new RestoreDrillFailure('RESOURCE_IDENTITY_INVALID'))
  })
})

describe('result digest and cleanup approval', () => {
  test('binds strict final evidence and rejects understated objective values', () => {
    const result = createResultEvidence()
    const digest = calculateRestoreDrillResultDigest(result, DIGEST_KEY)
    expect(digest).toMatch(/^[0-9a-f]{64}$/)
    expect(calculateRestoreDrillResultDigest(result, OTHER_DIGEST_KEY)).not.toBe(digest)
    expect(calculateRestoreDrillResultDigest({
      ...result,
      failureCodes: ['WORKFLOW_POLL_BUDGET_EXCEEDED'],
      runState: { outcome: 'fail', phase: 'failed' },
    }, DIGEST_KEY)).toMatch(/^[0-9a-f]{64}$/)
    expect(calculateRestoreDrillResultDigest({
      ...result,
      failureCodes: ['WORKFLOW_TASK_FAILED'],
      runState: { outcome: 'fail', phase: 'failed' },
    }, DIGEST_KEY)).toMatch(/^[0-9a-f]{64}$/)
    expect(() => calculateRestoreDrillResultDigest({
      ...result,
      objectives: { ...result.objectives, rtoSeconds: 1 },
    }, DIGEST_KEY)).toThrow(new RestoreDrillFailure('EVIDENCE_INVALID'))
  })

  test('authorizes only an authentic, current, exactly scoped approval', () => {
    const binding = createApprovalBinding()
    const receipt = createRestoreDrillCleanupApprovalReceipt(binding, DIGEST_KEY)

    expect(createRestoreDrillCleanupExecutionName(receipt)).toBe(
      `restore-cleanup-${receipt.approvalMac}`,
    )
    expect(evaluateRestoreDrillCleanupApproval({
      digestKey: DIGEST_KEY,
      expected: {
        authorizedApprovers: ['operator@example.com'],
        changeLocator: binding.changeLocator,
        drillId: binding.drillId,
        policyVersion: binding.policyVersion,
        resourceDigest: binding.resourceDigest,
        resultDigest: binding.resultDigest,
      },
      now: '2026-08-01T05:30:00.000Z',
      receipt,
    })).toEqual({ eligible: true, failureCodes: [] })
  })

  test('fails closed for receipt tampering or a different HMAC key', () => {
    const binding = createApprovalBinding()
    const receipt = createRestoreDrillCleanupApprovalReceipt(binding, DIGEST_KEY)
    const expected = {
      authorizedApprovers: ['operator@example.com'],
      changeLocator: binding.changeLocator,
      drillId: binding.drillId,
      policyVersion: binding.policyVersion,
      resourceDigest: binding.resourceDigest,
      resultDigest: binding.resultDigest,
    }

    expect(evaluateRestoreDrillCleanupApproval({
      digestKey: DIGEST_KEY,
      expected,
      now: '2026-08-01T05:30:00.000Z',
      receipt: { ...receipt, resultDigest: DIGEST_C },
    })).toEqual({
      eligible: false,
      failureCodes: ['APPROVAL_AUTHENTICATION_FAILED'],
    })
    expect(evaluateRestoreDrillCleanupApproval({
      digestKey: OTHER_DIGEST_KEY,
      expected,
      now: '2026-08-01T05:30:00.000Z',
      receipt,
    })).toEqual({
      eligible: false,
      failureCodes: ['APPROVAL_AUTHENTICATION_FAILED'],
    })
  })

  test('binds drill, resources, result, approver, change, policy, and validity interval', () => {
    const approvedBinding = createApprovalBinding({ resultDigest: DIGEST_C })
    const receipt = createRestoreDrillCleanupApprovalReceipt(approvedBinding, DIGEST_KEY)
    const decision = evaluateRestoreDrillCleanupApproval({
      digestKey: DIGEST_KEY,
      expected: {
        authorizedApprovers: ['different-operator@example.com'],
        changeLocator: 'https://github.com/mnmn0/mukuroji/issues/159#different',
        drillId: 'different-drill',
        policyVersion: 'restore-cleanup-v2',
        resourceDigest: DIGEST_D,
        resultDigest: DIGEST_B,
      },
      now: '2026-08-01T05:30:00.000Z',
      receipt,
    })

    expect(decision).toEqual({
      eligible: false,
      failureCodes: [
        'APPROVAL_APPROVER_UNAUTHORIZED',
        'APPROVAL_CHANGE_MISMATCH',
        'APPROVAL_DRILL_MISMATCH',
        'APPROVAL_POLICY_MISMATCH',
        'APPROVAL_RESOURCE_MISMATCH',
        'APPROVAL_RESULT_MISMATCH',
      ],
    })
    expect(evaluateRestoreDrillCleanupApproval({
      digestKey: DIGEST_KEY,
      expected: {
        authorizedApprovers: [approvedBinding.approver],
        changeLocator: approvedBinding.changeLocator,
        drillId: approvedBinding.drillId,
        policyVersion: approvedBinding.policyVersion,
        resourceDigest: approvedBinding.resourceDigest,
        resultDigest: approvedBinding.resultDigest,
      },
      now: approvedBinding.expiresAt,
      receipt,
    })).toEqual({ eligible: false, failureCodes: ['APPROVAL_EXPIRED'] })
  })

  test('rejects malformed receipts and approval intervals without throwing from eligibility', () => {
    const binding = createApprovalBinding()
    expect(() => createRestoreDrillCleanupApprovalReceipt({
      ...binding,
      expiresAt: binding.approvedAt,
    }, DIGEST_KEY)).toThrow(new RestoreDrillFailure('APPROVAL_RECEIPT_INVALID'))
    expect(evaluateRestoreDrillCleanupApproval({
      digestKey: DIGEST_KEY,
      expected: {
        authorizedApprovers: [binding.approver],
        changeLocator: binding.changeLocator,
        drillId: binding.drillId,
        policyVersion: binding.policyVersion,
        resourceDigest: binding.resourceDigest,
        resultDigest: binding.resultDigest,
      },
      now: '2026-08-01T05:30:00.000Z',
      receipt: { malformed: true },
    })).toEqual({ eligible: false, failureCodes: ['APPROVAL_RECEIPT_INVALID'] })
    expect(() => createRestoreDrillCleanupApprovalReceipt({
      ...binding,
      expiresAt: '2026-08-02T05:00:00.001Z',
    }, DIGEST_KEY)).toThrow(new RestoreDrillFailure('APPROVAL_RECEIPT_INVALID'))
    const overlongReceipt = {
      ...createRestoreDrillCleanupApprovalReceipt({
        ...binding,
        expiresAt: '2026-08-02T05:00:00.000Z',
      }, DIGEST_KEY),
      expiresAt: '2026-08-02T05:00:00.001Z',
    }
    expect(evaluateRestoreDrillCleanupApproval({
      digestKey: DIGEST_KEY,
      expected: {
        authorizedApprovers: [binding.approver],
        changeLocator: binding.changeLocator,
        drillId: binding.drillId,
        policyVersion: binding.policyVersion,
        resourceDigest: binding.resourceDigest,
        resultDigest: binding.resultDigest,
      },
      now: binding.approvedAt,
      receipt: overlongReceipt,
    })).toEqual({ eligible: false, failureCodes: ['APPROVAL_RECEIPT_INVALID'] })
  })
})
