import { describe, expect, test } from 'bun:test'
import {
  createMigrationDigest,
  createWorkspaceSearchConfigurationHash,
  serializeCanonicalJson,
  type MigrationKeyAttribute,
  type MigrationTableIdentity,
  type WorkspaceSearchMigrationConfiguration,
  type WorkspaceSearchMigrationSourceName,
  WORKSPACE_SEARCH_MIGRATION_ID,
  WORKSPACE_SEARCH_MIGRATION_VERSION,
} from './migration-contract'
import type {
  WorkspaceSearchMigrationRequestedResources,
} from './migration-identity'
import {
  createWorkspaceSearchMigrationFileEvidenceProvider,
  WorkspaceSearchMigrationMaintenanceEvidenceProviderError,
  type CreateWorkspaceSearchMigrationFileEvidenceProviderInput,
  type WorkspaceSearchMigrationMaintenanceEvidenceMeasurementSession,
  type WorkspaceSearchMigrationMaintenanceEvidenceWaiter,
} from './migration-maintenance-evidence-provider'
import type {
  WorkspaceSearchMigrationMaintenanceEvidenceCollectionRequest,
} from './migration-post-close-planning-supervisor'
import type {
  WorkspaceSearchMigrationSealedPlanningTableIds,
} from './migration-sealed-planning-authority'
import {
  maintenanceRuntimeControlSurfaces,
  type WorkspaceSearchMaintenanceEvidence,
} from './maintenance-evidence'

const nowMilliseconds = Date.parse('2026-08-01T01:00:00.000Z')
const configuration = createConfiguration()
const configurationHash = createWorkspaceSearchConfigurationHash(configuration)
const tableIds = createTableIds(configuration)
const resources = createRequestedResources(configuration)

/** Recording independent measurement session used by provider tests. */
class RecordingMeasurementSession
  implements WorkspaceSearchMigrationMaintenanceEvidenceMeasurementSession {
  /** Whether this independent session was closed. */
  closed = false

  /** Configuration returned by the independent measurement. */
  private readonly configuration: WorkspaceSearchMigrationConfiguration

  /**
   * Creates one recording measurement session.
   *
   * @param measured - Configuration returned by measurement.
   */
  constructor(measured: WorkspaceSearchMigrationConfiguration) {
    this.configuration = structuredClone(measured)
  }

  /** @inheritdoc */
  async measureConfiguration(): Promise<WorkspaceSearchMigrationConfiguration> {
    return structuredClone(this.configuration)
  }

  /** @inheritdoc */
  close(): void {
    if (this.closed) throw new Error('Session closed twice.')
    this.closed = true
  }
}

/** Deterministic waiter that advances the shared fake clock. */
class AdvancingWaiter
  implements WorkspaceSearchMigrationMaintenanceEvidenceWaiter {
  /** Number of bounded cadence waits performed. */
  calls = 0

  /** Mutable fake epoch advanced by every wait. */
  private readonly time: { milliseconds: number }

  /**
   * Creates one advancing waiter.
   *
   * @param time - Shared mutable fake epoch.
   */
  constructor(time: { milliseconds: number }) {
    this.time = time
  }

  /** @inheritdoc */
  async wait(milliseconds: number, signal: AbortSignal): Promise<void> {
    if (signal.aborted) throw new Error('Interrupted.')
    this.calls += 1
    this.time.milliseconds += milliseconds
  }
}

describe('Workspace Search migration file evidence provider', () => {
  test('returns close evidence only after an independent matching measurement', async () => {
    const session = new RecordingMeasurementSession(configuration)
    const bytes = createMaintenanceEvidenceBytes(
      '2026-08-01T00:44:00.000Z',
      '2026-08-01T00:59:00.000Z',
      11,
    )
    let reads = 0
    const provider = createWorkspaceSearchMigrationFileEvidenceProvider({
      resources,
      evidenceFilePath: '/trusted/maintenance.json',
      readEvidenceFile: async (): Promise<Uint8Array> => {
        reads += 1
        return bytes
      },
      createMeasurementSession: (): RecordingMeasurementSession => session,
      clock: (): Date => new Date(nowMilliseconds),
    })

    const result = await provider.collect(
      createCollectionRequest({ phase: 'close' }),
    )

    expect(reads).toBe(1)
    expect(session.closed).toBe(true)
    expect(result.configurationHash).toBe(configurationHash)
    expect(result.tableIds).toEqual(tableIds)
    expect(result.evidenceBytes).toEqual(bytes)
    expect(result.evidenceBytes).not.toBe(bytes)
  })

  test('captures provider collaborators before asynchronous collection starts', async () => {
    const session = new RecordingMeasurementSession(configuration)
    const bytes = createMaintenanceEvidenceBytes(
      '2026-08-01T00:44:00.000Z',
      '2026-08-01T00:59:00.000Z',
      11,
    )
    let providerCreated = false
    let redirectedReads = 0
    let redirectedMeasurements = 0
    const input: CreateWorkspaceSearchMigrationFileEvidenceProviderInput = {
      resources,
      evidenceFilePath: '/trusted/maintenance.json',
      get readEvidenceFile(): (path: string) => Promise<Uint8Array> {
        if (!providerCreated) {
          return async (): Promise<Uint8Array> => bytes
        }
        return async (): Promise<Uint8Array> => {
          redirectedReads += 1
          return new Uint8Array()
        }
      },
      get createMeasurementSession(): (
        selectedResources: WorkspaceSearchMigrationRequestedResources,
      ) => WorkspaceSearchMigrationMaintenanceEvidenceMeasurementSession {
        if (!providerCreated) return (): RecordingMeasurementSession => session
        return (): RecordingMeasurementSession => {
          redirectedMeasurements += 1
          return new RecordingMeasurementSession(configuration)
        }
      },
      clock: (): Date => new Date(nowMilliseconds),
    }
    const provider = createWorkspaceSearchMigrationFileEvidenceProvider(input)
    providerCreated = true

    const result = await provider.collect(
      createCollectionRequest({ phase: 'close' }),
    )

    expect(result.evidenceBytes).toEqual(bytes)
    expect(session.closed).toBe(true)
    expect(redirectedReads).toBe(0)
    expect(redirectedMeasurements).toBe(0)
  })

  test('snapshots request bindings and signal before reading the evidence file', async () => {
    const session = new RecordingMeasurementSession(configuration)
    const bytes = createMaintenanceEvidenceBytes(
      '2026-08-01T00:44:00.000Z',
      '2026-08-01T00:59:00.000Z',
      11,
    )
    const activeController = new AbortController()
    const redirectedController = new AbortController()
    redirectedController.abort(new Error('redirected-signal-canary'))
    const redirectedTableIds = {
      ...tableIds,
      documents: 'redirected-table-id-canary',
    }
    let evidenceRead = false
    const provider = createWorkspaceSearchMigrationFileEvidenceProvider({
      resources,
      evidenceFilePath: '/trusted/maintenance.json',
      readEvidenceFile: async (): Promise<Uint8Array> => {
        evidenceRead = true
        return bytes
      },
      createMeasurementSession: (): RecordingMeasurementSession => session,
      clock: (): Date => new Date(nowMilliseconds),
    })
    const phase = 'close' satisfies
      WorkspaceSearchMigrationMaintenanceEvidenceCollectionRequest['phase']
    const request: WorkspaceSearchMigrationMaintenanceEvidenceCollectionRequest = {
      runId: 'migration-run-164',
      get configurationHash(): string {
        return evidenceRead ? 'redirected-configuration-canary' : configurationHash
      },
      get tableIds(): WorkspaceSearchMigrationSealedPlanningTableIds {
        return evidenceRead ? redirectedTableIds : tableIds
      },
      get signal(): AbortSignal {
        return evidenceRead
          ? redirectedController.signal
          : activeController.signal
      },
      phase,
    }

    const result = await provider.collect(request)

    expect(result.configurationHash).toBe(configurationHash)
    expect(result.tableIds).toEqual(tableIds)
    expect(session.closed).toBe(true)
  })

  test('polls post-close evidence on a bounded cancelable cadence', async () => {
    const time = { milliseconds: nowMilliseconds }
    const waiter = new AdvancingWaiter(time)
    const session = new RecordingMeasurementSession(configuration)
    const preClose = createMaintenanceEvidenceBytes(
      '2026-08-01T00:44:00.000Z',
      '2026-08-01T00:59:00.000Z',
      12,
    )
    const postClose = createMaintenanceEvidenceBytes(
      '2026-08-01T01:00:00.000Z',
      '2026-08-01T01:15:00.000Z',
      13,
    )
    let reads = 0
    const provider = createWorkspaceSearchMigrationFileEvidenceProvider({
      resources,
      evidenceFilePath: '/trusted/maintenance.json',
      readEvidenceFile: async (): Promise<Uint8Array> => {
        reads += 1
        return reads === 1 ? preClose : postClose
      },
      createMeasurementSession: (): RecordingMeasurementSession => session,
      clock: (): Date => new Date(time.milliseconds),
      waiter,
      maximumWaitMilliseconds: 20 * 60 * 1_000,
      pollMilliseconds: 15 * 60 * 1_000,
    })

    const result = await provider.collect(
      createCollectionRequest({
        phase: 'post-close',
        closedAt: '2026-08-01T01:00:00.000Z',
      }),
    )

    expect(reads).toBe(2)
    expect(waiter.calls).toBe(1)
    expect(session.closed).toBe(true)
    expect(result.evidenceBytes).toEqual(postClose)
  })

  test('rejects otherwise valid evidence observed after the collection deadline', async () => {
    const time = { milliseconds: nowMilliseconds }
    let measurementFactories = 0
    const provider = createWorkspaceSearchMigrationFileEvidenceProvider({
      resources,
      evidenceFilePath: '/trusted/maintenance.json',
      readEvidenceFile: async (): Promise<Uint8Array> => {
        time.milliseconds += 11
        return createMaintenanceEvidenceBytes(
          '2026-08-01T00:44:00.000Z',
          '2026-08-01T00:59:00.000Z',
          16,
        )
      },
      createMeasurementSession: (): RecordingMeasurementSession => {
        measurementFactories += 1
        return new RecordingMeasurementSession(configuration)
      },
      clock: (): Date => new Date(time.milliseconds),
      maximumWaitMilliseconds: 10,
      pollMilliseconds: 5,
    })

    await expect(provider.collect(
      createCollectionRequest({ phase: 'close' }),
    )).rejects.toBeInstanceOf(
      WorkspaceSearchMigrationMaintenanceEvidenceProviderError,
    )
    expect(measurementFactories).toBe(0)
  })

  test('rejects a regressed clock before parsing otherwise fresh evidence', async () => {
    const time = {
      milliseconds: Date.parse('2026-08-01T01:06:00.000Z'),
    }
    let measurementFactories = 0
    const provider = createWorkspaceSearchMigrationFileEvidenceProvider({
      resources,
      evidenceFilePath: '/trusted/maintenance.json',
      readEvidenceFile: async (): Promise<Uint8Array> => {
        time.milliseconds = Date.parse('2026-08-01T01:04:00.000Z')
        return createMaintenanceEvidenceBytes(
          '2026-08-01T00:45:00.000Z',
          '2026-08-01T01:00:00.000Z',
          17,
        )
      },
      createMeasurementSession: (): RecordingMeasurementSession => {
        measurementFactories += 1
        return new RecordingMeasurementSession(configuration)
      },
      clock: (): Date => new Date(time.milliseconds),
    })

    await expect(provider.collect(
      createCollectionRequest({ phase: 'close' }),
    )).rejects.toBeInstanceOf(
      WorkspaceSearchMigrationMaintenanceEvidenceProviderError,
    )
    expect(measurementFactories).toBe(0)
  })

  test('revalidates evidence freshness after independent measurement', async () => {
    const time = { milliseconds: nowMilliseconds }
    let closeCalls = 0
    const provider = createWorkspaceSearchMigrationFileEvidenceProvider({
      resources,
      evidenceFilePath: '/trusted/maintenance.json',
      readEvidenceFile: async (): Promise<Uint8Array> =>
        createMaintenanceEvidenceBytes(
          '2026-08-01T00:44:00.000Z',
          '2026-08-01T00:59:00.000Z',
          18,
        ),
      createMeasurementSession: () => ({
        /** @inheritdoc */
        measureConfiguration: async () => {
          time.milliseconds += 6 * 60 * 1_000
          return structuredClone(configuration)
        },
        /** @inheritdoc */
        close: () => {
          closeCalls += 1
        },
      }),
      clock: (): Date => new Date(time.milliseconds),
    })

    await expect(provider.collect(
      createCollectionRequest({ phase: 'close' }),
    )).rejects.toBeInstanceOf(
      WorkspaceSearchMigrationMaintenanceEvidenceProviderError,
    )
    expect(closeCalls).toBe(1)
  })

  test('bounds polling even when the injected wall clock stalls', async () => {
    let reads = 0
    let waits = 0
    let measurementFactories = 0
    const provider = createWorkspaceSearchMigrationFileEvidenceProvider({
      resources,
      evidenceFilePath: '/trusted/maintenance.json',
      readEvidenceFile: async (): Promise<Uint8Array> => {
        reads += 1
        return reads < 3
          ? createMaintenanceEvidenceBytes(
              '2026-08-01T00:44:00.000Z',
              '2026-08-01T00:59:00.000Z',
              14,
            )
          : createMaintenanceEvidenceBytes(
              '2026-08-01T01:00:00.000Z',
              '2026-08-01T01:15:00.000Z',
              15,
            )
      },
      createMeasurementSession: (): RecordingMeasurementSession => {
        measurementFactories += 1
        return new RecordingMeasurementSession(configuration)
      },
      clock: (): Date => new Date(nowMilliseconds),
      waiter: {
        wait: async (): Promise<void> => {
          waits += 1
        },
      },
      maximumWaitMilliseconds: 10,
      pollMilliseconds: 5,
    })

    await expect(provider.collect(createCollectionRequest({
      phase: 'post-close',
      closedAt: '2026-08-01T01:00:00.000Z',
    }))).rejects.toBeInstanceOf(
      WorkspaceSearchMigrationMaintenanceEvidenceProviderError,
    )
    expect(reads).toBe(2)
    expect(waits).toBe(2)
    expect(measurementFactories).toBe(0)
  })

  test('rejects request-echoed TableIds that differ from fresh measurement', async () => {
    const session = new RecordingMeasurementSession(configuration)
    const provider = createWorkspaceSearchMigrationFileEvidenceProvider({
      resources,
      evidenceFilePath: '/trusted/maintenance.json',
      readEvidenceFile: async (): Promise<Uint8Array> =>
        createMaintenanceEvidenceBytes(
          '2026-08-01T00:44:00.000Z',
          '2026-08-01T00:59:00.000Z',
          14,
        ),
      createMeasurementSession: (): RecordingMeasurementSession => session,
      clock: (): Date => new Date(nowMilliseconds),
    })
    const wrongTableIds = {
      ...tableIds,
      documents: 'request-echo-canary',
    }

    await expect(provider.collect({
      ...createCollectionRequest({ phase: 'close' }),
      tableIds: wrongTableIds,
    })).rejects.toBeInstanceOf(
      WorkspaceSearchMigrationMaintenanceEvidenceProviderError,
    )
    expect(session.closed).toBe(true)
  })

  test('closes an asynchronously created measurement after interruption', async () => {
    const controller = new AbortController()
    let closeCalls = 0
    const provider = createWorkspaceSearchMigrationFileEvidenceProvider({
      resources,
      evidenceFilePath: '/trusted/maintenance.json',
      readEvidenceFile: async (): Promise<Uint8Array> =>
        createMaintenanceEvidenceBytes(
          '2026-08-01T00:44:00.000Z',
          '2026-08-01T00:59:00.000Z',
          15,
        ),
      createMeasurementSession: async () => ({
        measureConfiguration: async () => {
          controller.abort(new Error('async-measure-abort-canary'))
          return structuredClone(configuration)
        },
        close: async () => {
          await Promise.resolve()
          closeCalls += 1
        },
      }),
      clock: (): Date => new Date(nowMilliseconds),
    })

    let failure: unknown
    try {
      await provider.collect({
        ...createCollectionRequest({ phase: 'close' }),
        signal: controller.signal,
      })
    } catch (error: unknown) {
      failure = error
    }

    expect(closeCalls).toBe(1)
    expect(failure).toBeInstanceOf(
      WorkspaceSearchMigrationMaintenanceEvidenceProviderError,
    )
    expect(String(failure)).not.toContain('async-measure-abort-canary')
  })

  test('fails when cancellation arrives during asynchronous session close', async () => {
    const controller = new AbortController()
    let closeCalls = 0
    const provider = createWorkspaceSearchMigrationFileEvidenceProvider({
      resources,
      evidenceFilePath: '/trusted/maintenance.json',
      readEvidenceFile: async (): Promise<Uint8Array> =>
        createMaintenanceEvidenceBytes(
          '2026-08-01T00:44:00.000Z',
          '2026-08-01T00:59:00.000Z',
          19,
        ),
      createMeasurementSession: () => ({
        /** @inheritdoc */
        measureConfiguration: async () => structuredClone(configuration),
        /** @inheritdoc */
        close: async () => {
          await Promise.resolve()
          closeCalls += 1
          controller.abort(new Error('close-abort-canary'))
        },
      }),
      clock: (): Date => new Date(nowMilliseconds),
    })

    let failure: unknown
    try {
      await provider.collect({
        ...createCollectionRequest({ phase: 'close' }),
        signal: controller.signal,
      })
    } catch (error: unknown) {
      failure = error
    }

    expect(closeCalls).toBe(1)
    expect(failure).toBeInstanceOf(
      WorkspaceSearchMigrationMaintenanceEvidenceProviderError,
    )
    expect(String(failure)).not.toContain('close-abort-canary')
  })

  test('fails closed on invalid close evidence without measuring resources', async () => {
    let measurementFactories = 0
    const provider = createWorkspaceSearchMigrationFileEvidenceProvider({
      resources,
      evidenceFilePath: '/trusted/maintenance.json',
      readEvidenceFile: async (): Promise<Uint8Array> =>
        new TextEncoder().encode('{"raw":"tenant-canary"}'),
      createMeasurementSession: (): RecordingMeasurementSession => {
        measurementFactories += 1
        return new RecordingMeasurementSession(configuration)
      },
      clock: (): Date => new Date(nowMilliseconds),
    })

    let failure: unknown
    try {
      await provider.collect(createCollectionRequest({ phase: 'close' }))
    } catch (error: unknown) {
      failure = error
    }

    expect(measurementFactories).toBe(0)
    expect(failure).toBeInstanceOf(
      WorkspaceSearchMigrationMaintenanceEvidenceProviderError,
    )
    expect(String(failure)).not.toContain('tenant-canary')
    expect(String(failure)).not.toContain('/trusted/maintenance.json')
  })

  test('stops post-close polling immediately after cancellation', async () => {
    const controller = new AbortController()
    controller.abort(new Error('raw-abort-reason-canary'))
    let reads = 0
    const provider = createWorkspaceSearchMigrationFileEvidenceProvider({
      resources,
      evidenceFilePath: '/trusted/maintenance.json',
      readEvidenceFile: async (): Promise<Uint8Array> => {
        reads += 1
        return new Uint8Array()
      },
      createMeasurementSession: (): RecordingMeasurementSession =>
        new RecordingMeasurementSession(configuration),
      clock: (): Date => new Date(nowMilliseconds),
    })

    let failure: unknown
    try {
      await provider.collect({
        ...createCollectionRequest({
          phase: 'post-close',
          closedAt: '2026-08-01T01:00:00.000Z',
        }),
        signal: controller.signal,
      })
    } catch (error: unknown) {
      failure = error
    }

    expect(reads).toBe(0)
    expect(String(failure)).toBe(
      'WorkspaceSearchMigrationMaintenanceEvidenceProviderError: MAINTENANCE_EVIDENCE_PROVIDER_FAILED',
    )
    expect(String(failure)).not.toContain('raw-abort-reason-canary')
  })

  test('maps an injected waiter failure to the stable provider error', async () => {
    const waiterCanary = 'waiter-tenant-secret-canary'
    const provider = createWorkspaceSearchMigrationFileEvidenceProvider({
      resources,
      evidenceFilePath: '/trusted/maintenance.json',
      readEvidenceFile: async (): Promise<Uint8Array> =>
        createMaintenanceEvidenceBytes(
          '2026-08-01T00:44:00.000Z',
          '2026-08-01T00:59:00.000Z',
          20,
        ),
      createMeasurementSession: (): RecordingMeasurementSession =>
        new RecordingMeasurementSession(configuration),
      clock: (): Date => new Date(nowMilliseconds),
      waiter: {
        /** @inheritdoc */
        wait: async () => {
          throw new Error(waiterCanary)
        },
      },
      maximumWaitMilliseconds: 10,
      pollMilliseconds: 5,
    })

    let failure: unknown
    try {
      await provider.collect(createCollectionRequest({
        phase: 'post-close',
        closedAt: '2026-08-01T01:00:00.000Z',
      }))
    } catch (error: unknown) {
      failure = error
    }

    expect(failure).toBeInstanceOf(
      WorkspaceSearchMigrationMaintenanceEvidenceProviderError,
    )
    expect(String(failure)).not.toContain(waiterCanary)
  })
})

/** Collection request phase accepted by the fixture factory. */
type CollectionRequestPhase =
  | { readonly phase: 'close' }
  | { readonly phase: 'post-close'; readonly closedAt: string }

/**
 * Creates one exact supervisor collection request.
 *
 * @param phase - Close or post-close request fields.
 * @returns Bound request with a fresh signal.
 */
function createCollectionRequest(
  phase: CollectionRequestPhase,
): WorkspaceSearchMigrationMaintenanceEvidenceCollectionRequest {
  const base = {
    runId: 'migration-run-164',
    configurationHash,
    tableIds,
    signal: new AbortController().signal,
  }
  return phase.phase === 'close'
    ? { ...base, phase: 'close' }
    : { ...base, phase: 'post-close', closedAt: phase.closedAt }
}

/**
 * Creates strict canonical maintenance evidence bytes.
 *
 * @param drainStartedAt - Exact beginning of the zero-writer drain.
 * @param drainCompletedAt - Exact completion of the zero-writer drain.
 * @param runtimeRevision - Positive runtime-control revision.
 * @returns Canonical UTF-8 evidence bytes.
 */
function createMaintenanceEvidenceBytes(
  drainStartedAt: string,
  drainCompletedAt: string,
  runtimeRevision: number,
): Uint8Array {
  const evidence: WorkspaceSearchMaintenanceEvidence = {
    schemaVersion: 1,
    locator: 'change:OPS-164',
    runtimeMode: 'disabled',
    runtimeRevision,
    drainStartedAt,
    drainCompletedAt,
    observedWriterMutations: 0,
    surfaces: maintenanceRuntimeControlSurfaces.map((surface) => ({
      surface,
      mode: 'disabled',
      status: 'current',
      revision: runtimeRevision,
      observedAt: drainCompletedAt,
    })),
  }
  return new TextEncoder().encode(serializeCanonicalJson(evidence))
}

/**
 * Creates explicit resource selection represented by a configuration.
 *
 * @param measured - Strict measured configuration.
 * @returns Exact selected physical resources.
 */
function createRequestedResources(
  measured: WorkspaceSearchMigrationConfiguration,
): WorkspaceSearchMigrationRequestedResources {
  return {
    account: measured.account,
    region: measured.region,
    profile: measured.profile,
    commit: measured.commit,
    tables: {
      'project-directory': measured.tables['project-directory'].tableName,
      'work-items': measured.tables['work-items'].tableName,
      collaboration: measured.tables.collaboration.tableName,
      documents: measured.tables.documents.tableName,
      'workspace-search': measured.tables['workspace-search'].tableName,
      'migration-state': measured.tables['migration-state'].tableName,
    },
    journalBucket: measured.journal.bucketName,
    journalKeyArn: measured.journal.keyArn,
  }
}

/**
 * Extracts all six measured TableIds.
 *
 * @param measured - Strict measured configuration.
 * @returns Exact role-to-TableId binding.
 */
function createTableIds(
  measured: WorkspaceSearchMigrationConfiguration,
): WorkspaceSearchMigrationSealedPlanningTableIds {
  return {
    'project-directory': measured.tables['project-directory'].tableId,
    'work-items': measured.tables['work-items'].tableId,
    collaboration: measured.tables.collaboration.tableId,
    documents: measured.tables.documents.tableId,
    'workspace-search': measured.tables['workspace-search'].tableId,
    'migration-state': measured.tables['migration-state'].tableId,
  }
}

/**
 * Creates the complete measured configuration used by the provider fixture.
 *
 * @returns Exact six-table configuration.
 */
function createConfiguration(): WorkspaceSearchMigrationConfiguration {
  return {
    migrationId: WORKSPACE_SEARCH_MIGRATION_ID,
    migrationVersion: WORKSPACE_SEARCH_MIGRATION_VERSION,
    account: '123456789012',
    region: 'ap-northeast-1',
    profile: 'production-operator',
    commit: 'a'.repeat(40),
    callerArn:
      'arn:aws:sts::123456789012:assumed-role/migration-operator/session',
    callerRoleId: 'AROA1234567890ABCDEFG',
    tables: {
      'project-directory': createSourceTable('project-directory'),
      'work-items': createSourceTable('work-items'),
      collaboration: createSourceTable('collaboration'),
      documents: createSourceTable('documents'),
      'workspace-search': createSupportTable('workspace-search'),
      'migration-state': createSupportTable('migration-state'),
    },
    journal: {
      bucketName: 'mukuroji-workspace-search-migration-journal',
      keyArn:
        'arn:aws:kms:ap-northeast-1:123456789012:key/00000000-0000-0000-0000-000000000001',
      keyCreationTime: '2026-07-01T00:00:00.000Z',
      keyManager: 'CUSTOMER',
      keyState: 'Enabled',
      keySpec: 'SYMMETRIC_DEFAULT',
      keyUsage: 'ENCRYPT_DECRYPT',
      keyOrigin: 'AWS_KMS',
      keyMultiRegion: false,
      versioning: 'Enabled',
      objectLockMode: 'COMPLIANCE',
      defaultRetentionDays: 30,
      encryption: 'aws:kms',
      bucketKeyEnabled: true,
      accessLogBucket: 'mukuroji-access-logs',
      accessLogPrefix: 'workspace-search-migration/',
    },
    journalPrefix: 'workspace-search/v1',
  }
}

/**
 * Creates one strict measured source table.
 *
 * @param source - Fixed source role.
 * @returns Complete source identity.
 */
function createSourceTable(
  source: WorkspaceSearchMigrationSourceName,
): MigrationTableIdentity {
  return createTableIdentity(source, sourceKeyDescriptors(source), false)
}

/**
 * Creates one strict measured support table.
 *
 * @param role - Target or migration-state role.
 * @returns Complete support identity.
 */
function createSupportTable(
  role: 'migration-state' | 'workspace-search',
): MigrationTableIdentity {
  const key = role === 'workspace-search'
    ? [
        { name: 'workspaceId', role: 'HASH', type: 'S' },
        { name: 'recordKey', role: 'RANGE', type: 'S' },
      ] satisfies readonly MigrationKeyAttribute[]
    : [
        { name: 'migrationId', role: 'HASH', type: 'S' },
        { name: 'recordKey', role: 'RANGE', type: 'S' },
      ] satisfies readonly MigrationKeyAttribute[]
  return createTableIdentity(role, key, true)
}

/**
 * Creates shared strict DynamoDB table identity fields.
 *
 * @param role - Logical migration table role.
 * @param key - Exact primary-key schema.
 * @param deletionProtection - Whether deletion protection is enabled.
 * @returns Complete measured table identity.
 */
function createTableIdentity(
  role: MigrationTableIdentity['role'],
  key: readonly MigrationKeyAttribute[],
  deletionProtection: boolean,
): MigrationTableIdentity {
  return {
    role,
    tableName: `table-${role}`,
    tableArn:
      `arn:aws:dynamodb:ap-northeast-1:123456789012:table/table-${role}`,
    tableId: `table-id-${role}`,
    creationTime: '2026-01-01T00:00:00.000Z',
    account: '123456789012',
    region: 'ap-northeast-1',
    key,
    globalSecondaryIndexes: [],
    billingMode: 'PAY_PER_REQUEST',
    deletionProtection,
    encryption: 'KMS',
    kmsKeyDigest: createMigrationDigest(`${role}-key`),
    ttl: { status: 'DISABLED' },
    pitr: {
      status: 'ENABLED',
      earliestRestorableTime: '2026-07-01T00:00:00.000Z',
      latestRestorableTime: '2026-07-31T00:00:00.000Z',
    },
  }
}

/**
 * Returns the exact measured key schema for one source role.
 *
 * @param source - Fixed source role.
 * @returns Ordered partition and sort keys.
 */
function sourceKeyDescriptors(
  source: WorkspaceSearchMigrationSourceName,
): readonly MigrationKeyAttribute[] {
  if (source === 'project-directory') {
    return [
      { name: 'directoryId', role: 'HASH', type: 'S' },
      { name: 'entryKey', role: 'RANGE', type: 'S' },
    ]
  }
  if (source === 'work-items') {
    return [
      { name: 'directoryTeamId', role: 'HASH', type: 'S' },
      { name: 'issueId', role: 'RANGE', type: 'S' },
    ]
  }
  if (source === 'collaboration') {
    return [
      { name: 'entityKey', role: 'HASH', type: 'S' },
      { name: 'recordKey', role: 'RANGE', type: 'S' },
    ]
  }
  return [
    { name: 'workspaceId', role: 'HASH', type: 'S' },
    { name: 'recordKey', role: 'RANGE', type: 'S' },
  ]
}
