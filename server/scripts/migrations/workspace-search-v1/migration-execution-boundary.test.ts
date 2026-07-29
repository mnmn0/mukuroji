import { describe, expect, test } from 'bun:test'
import {
  createWorkspaceSearchWriterFenceBinding,
  createWorkspaceSearchWriterFenceClosedSuccessor,
  createWorkspaceSearchWriterFenceInitialOpenRecord,
} from '../../../src/infrastructure/runtime/workspace-search-writer-fence'
import {
  createMaintenanceEvidenceFileDigest,
  maintenanceRuntimeControlSurfaces,
  type WorkspaceSearchMaintenanceEvidence,
} from './maintenance-evidence'
import {
  createMigrationDigest,
  serializeCanonicalJson,
  type WorkspaceSearchMaintenanceEvidenceReceipt,
} from './migration-contract'
import {
  admitWorkspaceSearchMigrationExecutionBoundaryPlanning,
  createWorkspaceSearchMigrationExecutionBoundary,
  createWorkspaceSearchMigrationExecutionBoundaryDigest,
  parseWorkspaceSearchMigrationExecutionBoundary,
  serializeWorkspaceSearchMigrationExecutionBoundary,
  type AdmitWorkspaceSearchMigrationExecutionBoundaryPlanningInput,
  type CreateWorkspaceSearchMigrationExecutionBoundaryInput,
  type WorkspaceSearchMigrationClosedExecutionBoundary,
  WorkspaceSearchMigrationExecutionBoundaryError,
} from './migration-execution-boundary'
import type {
  WorkspaceSearchMigrationSealedPlanningTableIds,
} from './migration-sealed-planning-authority'

const runId = 'execution-boundary-run'
const ownerId = 'execution-boundary-owner'
const configurationHash = createMigrationDigest({
  fixture: 'execution-boundary-configuration',
})
const closedAt = '2026-07-29T01:00:00.000Z'
const drainStartedAt = '2026-07-29T01:00:00.000Z'
const drainCompletedAt = '2026-07-29T01:15:00.000Z'
const tableIds: WorkspaceSearchMigrationSealedPlanningTableIds = {
  'project-directory': 'table-id-project-directory-v1',
  'work-items': 'table-id-work-items-v1',
  collaboration: 'table-id-collaboration-v1',
  documents: 'table-id-documents-v1',
  'workspace-search': 'table-id-workspace-search-v1',
  'migration-state': 'table-id-migration-state-v1',
}

describe('Workspace Search migration execution boundary', () => {
  test('round-trips both canonical phases without mutating the predecessor', () => {
    const closed = createClosedBoundary()
    const closedSnapshot = structuredClone(closed)
    const closedBytes =
      serializeWorkspaceSearchMigrationExecutionBoundary(closed)

    expect(
      parseWorkspaceSearchMigrationExecutionBoundary(closedBytes),
    ).toEqual(closed)
    expect(
      createWorkspaceSearchMigrationExecutionBoundaryDigest(closed),
    ).toBe(closed.boundaryDigest)
    expect(closed).toMatchObject({
      phase: 'closed',
      revision: 1,
      runId,
      configurationHash,
      tableIds,
      closedAt,
      closeAuthority: {
        ownerId,
        leaseFenceToken: 3,
        maintenanceEvidencePointerRevision: 7,
      },
    })

    const admissionInput = createAdmissionInput(closed)
    const admitted =
      admitWorkspaceSearchMigrationExecutionBoundaryPlanning(
        admissionInput,
      )
    const admittedBytes =
      serializeWorkspaceSearchMigrationExecutionBoundary(admitted)

    expect(closed).toEqual(closedSnapshot)
    expect(
      parseWorkspaceSearchMigrationExecutionBoundary(admittedBytes),
    ).toEqual(admitted)
    expect(
      createWorkspaceSearchMigrationExecutionBoundaryDigest(admitted),
    ).toBe(admitted.boundaryDigest)
    expect(admitted).toMatchObject({
      phase: 'planning-admitted',
      revision: 2,
      planningAdmission: {
        maintenanceEvidencePointerRevision: 8,
        drainStartedAt,
        drainCompletedAt,
        maintenanceEvidenceReceiptDigest: createMigrationDigest(
          admissionInput.currentAuthority
            .maintenanceEvidenceReceipt,
        ),
        ownerId,
        leaseFenceToken: 3,
        admittedAt: admissionInput.admittedAt,
      },
    })
  })

  test('rejects extra input fields and noncanonical or extended bytes', () => {
    const input = createClosedInput()
    const extendedInput = structuredClone(input)
    Reflect.set(extendedInput, 'unexpected', true)
    expectBoundaryFailure(() =>
      createWorkspaceSearchMigrationExecutionBoundary(extendedInput)
    )

    const closed = createWorkspaceSearchMigrationExecutionBoundary(input)
    const canonical =
      serializeWorkspaceSearchMigrationExecutionBoundary(closed)
    const noncanonical = new TextEncoder().encode(
      ` ${new TextDecoder().decode(canonical)}`,
    )
    expectBoundaryFailure(() =>
      parseWorkspaceSearchMigrationExecutionBoundary(noncanonical)
    )

    const extendedBoundary = structuredClone(closed)
    Reflect.set(extendedBoundary, 'unexpected', true)
    expectBoundaryFailure(() =>
      parseWorkspaceSearchMigrationExecutionBoundary(
        encodeCandidateWithDigest(extendedBoundary),
      )
    )
  })

  test('rejects run, configuration, TableId, and closed-record mismatches', () => {
    const input = createClosedInput()
    const candidates:
      readonly CreateWorkspaceSearchMigrationExecutionBoundaryInput[] = [
        {
          ...input,
          runId: 'another-execution-boundary-run',
        },
        {
          ...input,
          configurationHash: createMigrationDigest({
            fixture: 'another-configuration',
          }),
        },
        {
          ...input,
          tableIds: {
            ...input.tableIds,
            documents: 'replacement-documents-table-id',
          },
        },
        {
          ...input,
          closedWriterFenceRecord: {
            ...input.closedWriterFenceRecord,
            recordDigest: '0'.repeat(64),
          },
        },
      ]

    for (const candidate of candidates) {
      expectBoundaryFailure(() =>
        createWorkspaceSearchMigrationExecutionBoundary(candidate)
      )
    }
  })

  test('rejects stale pointer, stale fence, and raw-evidence receipt mismatches', () => {
    const closed = createClosedBoundary()
    const input = createAdmissionInput(closed)
    const candidates:
      readonly AdmitWorkspaceSearchMigrationExecutionBoundaryPlanningInput[] =
      [
        {
          ...input,
          currentAuthority: {
            ...input.currentAuthority,
            maintenanceEvidencePointerRevision:
              closed.closeAuthority.maintenanceEvidencePointerRevision,
          },
        },
        withAdmissionReceipt(input, {
          ...input.currentAuthority.maintenanceEvidenceReceipt,
          fenceToken: closed.closeAuthority.leaseFenceToken - 1,
        }, closed.closeAuthority.leaseFenceToken - 1),
        withAdmissionReceipt(input, {
          ...input.currentAuthority.maintenanceEvidenceReceipt,
          evidenceDigest: '0'.repeat(64),
        }),
        withAdmissionReceipt(input, {
          ...input.currentAuthority.maintenanceEvidenceReceipt,
          runtimeRevision:
            input.currentAuthority.maintenanceEvidenceReceipt
              .runtimeRevision + 1,
        }),
      ]

    for (const candidate of candidates) {
      expectBoundaryFailure(() =>
        admitWorkspaceSearchMigrationExecutionBoundaryPlanning(
          candidate,
        )
      )
    }
  })

  test('rejects expired or mismatched current planning authority', () => {
    const closed = createClosedBoundary()
    const input = createAdmissionInput(closed)
    const validUntil = Date.parse(
      input.currentAuthority.maintenanceEvidenceReceipt.validUntil,
    )
    const expiredAt = new Date(validUntil).toISOString()
    const expiredAuthority = {
      ...input.currentAuthority,
      lease: {
        ...input.currentAuthority.lease,
        heartbeatAt: new Date(validUntil - 30_000).toISOString(),
        expiresAt: new Date(validUntil + 30_000).toISOString(),
      },
      evaluatedAt: new Date(validUntil - 20_000).toISOString(),
    }
    const candidates:
      readonly AdmitWorkspaceSearchMigrationExecutionBoundaryPlanningInput[] =
      [
        {
          ...input,
          currentAuthority: {
            ...input.currentAuthority,
            configurationHash: createMigrationDigest(
              'foreign-admission-configuration',
            ),
          },
        },
        {
          ...input,
          currentAuthority: {
            ...input.currentAuthority,
            stateTableId: 'replacement-migration-state-table-id',
          },
        },
        {
          ...input,
          currentAuthority: {
            ...input.currentAuthority,
            maintenanceEvidenceReceiptDigest: '0'.repeat(64),
          },
        },
        {
          ...input,
          currentAuthority: {
            ...input.currentAuthority,
            evaluatedAt: new Date(
              Date.parse(input.admittedAt) + 1,
            ).toISOString(),
          },
        },
        {
          ...input,
          currentAuthority: expiredAuthority,
          admittedAt: expiredAt,
        },
      ]

    for (const candidate of candidates) {
      expectBoundaryFailure(() =>
        admitWorkspaceSearchMigrationExecutionBoundaryPlanning(candidate)
      )
    }
  })

  test('rejects closed-fence and authority accessors or Proxies without invoking them', () => {
    let hostileInvocations = 0
    const closedInput = createClosedInput()
    const hostileAuthority = structuredClone(
      closedInput.closedWriterFenceRecord.authority,
    )
    Object.defineProperty(hostileAuthority, 'runId', {
      configurable: true,
      enumerable: true,
      get: () => {
        hostileInvocations += 1
        return runId
      },
    })
    const accessorClosedRecord = structuredClone(
      closedInput.closedWriterFenceRecord,
    )
    Object.defineProperty(accessorClosedRecord, 'authority', {
      configurable: true,
      enumerable: true,
      value: hostileAuthority,
      writable: true,
    })
    expectBoundaryFailure(() =>
      createWorkspaceSearchMigrationExecutionBoundary({
        ...closedInput,
        closedWriterFenceRecord: accessorClosedRecord,
      })
    )

    const proxyClosedRecord = new Proxy(
      closedInput.closedWriterFenceRecord,
      {
        getPrototypeOf: () => {
          hostileInvocations += 1
          return Object.prototype
        },
      },
    )
    expectBoundaryFailure(() =>
      createWorkspaceSearchMigrationExecutionBoundary({
        ...closedInput,
        closedWriterFenceRecord: proxyClosedRecord,
      })
    )

    const closed = createClosedBoundary()
    const admissionInput = createAdmissionInput(closed)
    const hostileReceipt = structuredClone(
      admissionInput.currentAuthority.maintenanceEvidenceReceipt,
    )
    Object.defineProperty(hostileReceipt, 'evidenceDigest', {
      configurable: true,
      enumerable: true,
      get: () => {
        hostileInvocations += 1
        return admissionInput.currentAuthority
          .maintenanceEvidenceReceipt.evidenceDigest
      },
    })
    const accessorCurrentAuthority = structuredClone(
      admissionInput.currentAuthority,
    )
    Object.defineProperty(
      accessorCurrentAuthority,
      'maintenanceEvidenceReceipt',
      {
        configurable: true,
        enumerable: true,
        value: hostileReceipt,
        writable: true,
      },
    )
    expectBoundaryFailure(() =>
      admitWorkspaceSearchMigrationExecutionBoundaryPlanning({
        ...admissionInput,
        currentAuthority: accessorCurrentAuthority,
      })
    )

    const proxyCurrentAuthority = new Proxy(
      admissionInput.currentAuthority,
      {
        ownKeys: (target) => {
          hostileInvocations += 1
          return Reflect.ownKeys(target)
        },
      },
    )
    expectBoundaryFailure(() =>
      admitWorkspaceSearchMigrationExecutionBoundaryPlanning({
        ...admissionInput,
        currentAuthority: proxyCurrentAuthority,
      })
    )
    expect(hostileInvocations).toBe(0)
  })

  test('rejects drains that begin before the exact writer-fence close', () => {
    const closed = createClosedBoundary()
    const input = createAdmissionInput(
      closed,
      '2026-07-29T00:59:59.999Z',
      '2026-07-29T01:14:59.999Z',
    )

    expectBoundaryFailure(() =>
      admitWorkspaceSearchMigrationExecutionBoundaryPlanning(input)
    )

    const admitted =
      admitWorkspaceSearchMigrationExecutionBoundaryPlanning(
        createAdmissionInput(closed),
      )
    const tampered = structuredClone(admitted)
    Reflect.set(
      tampered.planningAdmission,
      'drainStartedAt',
      '2026-07-29T00:59:59.999Z',
    )
    expectBoundaryFailure(() =>
      parseWorkspaceSearchMigrationExecutionBoundary(
        encodeCandidateWithDigest(tampered),
      )
    )
  })

  test('rejects phase-revision drift and an invalid embedded digest', () => {
    const closed = createClosedBoundary()
    const wrongRevision = structuredClone(closed)
    Reflect.set(wrongRevision, 'revision', 2)
    expectBoundaryFailure(() =>
      parseWorkspaceSearchMigrationExecutionBoundary(
        encodeCandidateWithDigest(wrongRevision),
      )
    )

    const wrongDigest = structuredClone(closed)
    Reflect.set(wrongDigest, 'closedAt', '2026-07-29T01:00:00.001Z')
    expectBoundaryFailure(() =>
      parseWorkspaceSearchMigrationExecutionBoundary(
        encodeCandidate(wrongDigest),
      )
    )
  })
})

/**
 * Creates the exact writer-fence close input used by contract tests.
 *
 * @returns Strict run/configuration/TableId/closed-fence input.
 */
function createClosedInput():
  CreateWorkspaceSearchMigrationExecutionBoundaryInput {
  const binding = createWorkspaceSearchWriterFenceBinding({
    stateTableName: 'migration-state-table',
    stateTableId: tableIds['migration-state'],
    stateIncarnationDigest: createMigrationDigest({
      fixture: 'migration-state-incarnation',
    }),
    tableIds,
  })
  const open = createWorkspaceSearchWriterFenceInitialOpenRecord(
    binding,
    new Date('2026-07-29T00:30:00.000Z'),
  )
  const closedWriterFenceRecord =
    createWorkspaceSearchWriterFenceClosedSuccessor(
      open,
      {
        configurationHash,
        runId,
        ownerId,
        leaseFenceToken: 3,
        maintenanceEvidenceReceiptDigest: createMigrationDigest({
          fixture: 'close-maintenance-receipt',
        }),
        maintenanceEvidencePointerRevision: 7,
      },
      new Date(closedAt),
    )
  return {
    runId,
    configurationHash,
    tableIds,
    closedWriterFenceRecord,
  }
}

/**
 * Creates one strict revision-one boundary fixture.
 *
 * @returns Canonical closed execution boundary.
 */
function createClosedBoundary():
  WorkspaceSearchMigrationClosedExecutionBoundary {
  return createWorkspaceSearchMigrationExecutionBoundary(
    createClosedInput(),
  )
}

/**
 * Creates one exact receipt and raw-evidence admission input.
 *
 * @param current - Exact closed predecessor.
 * @param startedAt - Raw evidence drain start.
 * @param completedAt - Raw evidence drain completion.
 * @returns Strict planning-admission input.
 */
function createAdmissionInput(
  current: WorkspaceSearchMigrationClosedExecutionBoundary,
  startedAt = drainStartedAt,
  completedAt = drainCompletedAt,
): AdmitWorkspaceSearchMigrationExecutionBoundaryPlanningInput {
  const runtimeRevision = 41
  const evidence: WorkspaceSearchMaintenanceEvidence = {
    schemaVersion: 1,
    locator: 'change:OPS-39',
    runtimeMode: 'disabled',
    runtimeRevision,
    drainStartedAt: startedAt,
    drainCompletedAt: completedAt,
    observedWriterMutations: 0,
    surfaces: maintenanceRuntimeControlSurfaces.map((surface) => ({
      surface,
      mode: 'disabled',
      status: 'current',
      revision: runtimeRevision,
      observedAt: completedAt,
    })),
  }
  const maintenanceEvidenceBytes = new TextEncoder().encode(
    serializeCanonicalJson(evidence),
  )
  const receipt: WorkspaceSearchMaintenanceEvidenceReceipt = {
    runId: current.runId,
    evidenceDigest: createMaintenanceEvidenceFileDigest(
      maintenanceEvidenceBytes,
    ),
    evidenceLocator: evidence.locator,
    runtimeRevision,
    fenceToken: current.closeAuthority.leaseFenceToken,
    validatedAt: new Date(
      Date.parse(completedAt) + 5_000,
    ).toISOString(),
    oldestObservationAt: completedAt,
    validUntil: new Date(
      Date.parse(completedAt) + 5 * 60 * 1_000 + 1,
    ).toISOString(),
  }
  const admittedAt = new Date(
    Date.parse(completedAt) + 10_000,
  ).toISOString()
  return {
    current,
    currentAuthority: {
      configurationHash: current.configurationHash,
      stateTableId: current.tableIds['migration-state'],
      lease: {
        runId: current.runId,
        ownerId,
        fenceToken: current.closeAuthority.leaseFenceToken,
        heartbeatAt: completedAt,
        expiresAt: new Date(
          Date.parse(completedAt) + 60_000,
        ).toISOString(),
      },
      maintenanceEvidenceReceiptDigest: createMigrationDigest(receipt),
      maintenanceEvidencePointerRevision:
        current.closeAuthority.maintenanceEvidencePointerRevision + 1,
      maintenanceEvidenceReceipt: receipt,
      evaluatedAt: receipt.validatedAt,
    },
    admittedAt,
    maintenanceEvidenceBytes,
  }
}

/**
 * Replaces one admission receipt while keeping its authority correlation exact.
 *
 * @param input - Existing admission input.
 * @param receipt - Replacement immutable receipt.
 * @param fenceToken - Replacement lease fence, or the existing fence.
 * @returns Admission input with a recomputed receipt digest.
 */
function withAdmissionReceipt(
  input: AdmitWorkspaceSearchMigrationExecutionBoundaryPlanningInput,
  receipt: WorkspaceSearchMaintenanceEvidenceReceipt,
  fenceToken = input.currentAuthority.lease.fenceToken,
): AdmitWorkspaceSearchMigrationExecutionBoundaryPlanningInput {
  return {
    ...input,
    currentAuthority: {
      ...input.currentAuthority,
      lease: {
        ...input.currentAuthority.lease,
        fenceToken,
      },
      maintenanceEvidenceReceipt: receipt,
      maintenanceEvidenceReceiptDigest: createMigrationDigest(receipt),
    },
  }
}

/**
 * Serializes one test candidate without changing its embedded digest.
 *
 * @param value - Candidate boundary graph.
 * @returns Canonical UTF-8 test bytes.
 */
function encodeCandidate(value: unknown): Uint8Array {
  return new TextEncoder().encode(serializeCanonicalJson(value))
}

/**
 * Recomputes a candidate boundary digest and serializes the result.
 *
 * @param value - Candidate boundary graph.
 * @returns Canonical UTF-8 bytes with a digest covering every other field.
 */
function encodeCandidateWithDigest(value: object): Uint8Array {
  const fields = structuredClone(value)
  Reflect.deleteProperty(fields, 'boundaryDigest')
  return encodeCandidate({
    ...fields,
    boundaryDigest: createMigrationDigest(fields),
  })
}

/**
 * Requires one operation to fail through the stable redacted boundary.
 *
 * @param operation - Candidate invalid operation.
 */
function expectBoundaryFailure(operation: () => unknown): void {
  try {
    operation()
  } catch (error: unknown) {
    expect(error).toBeInstanceOf(
      WorkspaceSearchMigrationExecutionBoundaryError,
    )
    expect(error).toMatchObject({
      code: 'INVALID_MIGRATION_EXECUTION_BOUNDARY',
      message: 'INVALID_MIGRATION_EXECUTION_BOUNDARY',
    })
    return
  }
  throw new Error('Expected execution-boundary validation to fail.')
}
