import { mkdtemp, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { describe, expect, test } from 'bun:test'
import { createMigrationDigest, serializeCanonicalJson } from './migration-contract'
import type {
  WorkspaceSearchMigrationRequestedResources,
} from './migration-identity'
import {
  createWorkspaceSearchMigrationRehearsalStageChildMaterialTestFixture,
  type WorkspaceSearchMigrationRehearsalStageChildMaterialTestFixture,
} from './migration-rehearsal-stage-child-material.test-fixture'
import {
  cleanupWorkspaceSearchMigrationRehearsalRuntimeKey,
  consumeWorkspaceSearchMigrationRehearsalRuntimeKeyCleanupAuthorization,
  WORKSPACE_SEARCH_MIGRATION_REHEARSAL_RUNTIME_KEY_FILENAME,
} from './migration-rehearsal-runtime-key-cleanup'
import {
  parseWorkspaceSearchMigrationRehearsalStageAbandonCliArguments,
  runWorkspaceSearchMigrationRehearsalStageAbandonCli,
  WORKSPACE_SEARCH_MIGRATION_REHEARSAL_STAGE_ABANDON_CLI_APPROVAL,
  WORKSPACE_SEARCH_MIGRATION_REHEARSAL_STAGE_ABANDON_CLI_RESULT_KIND,
  type WorkspaceSearchMigrationRehearsalStageAbandonCliDependencies,
} from './migration-rehearsal-stage-abandon-cli'
import {
  createWorkspaceSearchMigrationRehearsalStageReservationAbandonment,
  verifyWorkspaceSearchMigrationRehearsalStageReservationAbandonment,
} from './migration-rehearsal-stage-reservation-abandonment'

/** Complete explicit resources used by the shared authentic fixture. */
const resources: WorkspaceSearchMigrationRequestedResources = Object.freeze({
  account: '111111111111',
  region: 'us-east-1',
  profile: 'migration-rehearsal-fixture',
  commit: 'a'.repeat(40),
  tables: Object.freeze({
    'project-directory': 'fixture-project-directory',
    'work-items': 'fixture-work-items',
    collaboration: 'fixture-collaboration',
    documents: 'fixture-documents',
    'workspace-search': 'fixture-workspace-search',
    'migration-state': 'fixture-migration-state',
  }),
  journalBucket: 'fixture-migration-journal',
  journalKeyArn:
    'arn:aws:kms:us-east-1:111111111111:key/12345678-1234-1234-1234-123456789012',
})

/** Private fixture paths accepted only through the injected reader. */
const paths = Object.freeze({
  ratePolicy: '/private/abandon-rate-policy.json',
  permit: '/private/abandon-permit.json',
  masterKey: '/private/abandon-master.key',
  manifest: '/private/abandon-manifest.json',
  reservation: '/private/abandon-reservation.json',
})

/** Mutable focused CLI harness with real cleanup filesystem state. */
type StageAbandonCliHarness = {
  /** Authentic stage-one fixture. */
  readonly fixture:
    WorkspaceSearchMigrationRehearsalStageChildMaterialTestFixture
  /** Owner-only evidence directory containing the fixed runtime key. */
  readonly directory: string
  /** Complete strict CLI argument vector. */
  readonly arguments_: readonly string[]
  /** Injectable dependencies with real cleanup and fake AWS boundaries. */
  readonly dependencies:
    WorkspaceSearchMigrationRehearsalStageAbandonCliDependencies
  /** Captured digest-only stdout lines. */
  readonly stdoutLines: string[]
  /** Captured stable-code stderr lines. */
  readonly stderrLines: string[]
  /** Returns the number of strong-head reads. */
  readonly readHeadCalls: () => number
  /** Returns the number of abandonment CAS calls. */
  readonly abandonCalls: () => number
}

/** Creates one complete strict abandonment command. */
function createArguments(directory: string): readonly string[] {
  return Object.freeze([
    '--account', resources.account,
    '--region', resources.region,
    '--profile', resources.profile,
    '--commit', resources.commit,
    '--project-directory-table', resources.tables['project-directory'],
    '--work-items-table', resources.tables['work-items'],
    '--collaboration-table', resources.tables.collaboration,
    '--documents-table', resources.tables.documents,
    '--workspace-search-table', resources.tables['workspace-search'],
    '--migration-state-table', resources.tables['migration-state'],
    '--journal-bucket', resources.journalBucket,
    '--journal-key-arn', resources.journalKeyArn,
    '--rate-policy-file', paths.ratePolicy,
    '--permit-file', paths.permit,
    '--rehearsal-authentication-key-file', paths.masterKey,
    '--stage-manifest-file', paths.manifest,
    '--stage-reservation-file', paths.reservation,
    '--evidence-directory', directory,
    '--approval',
    WORKSPACE_SEARCH_MIGRATION_REHEARSAL_STAGE_ABANDON_CLI_APPROVAL,
  ])
}

/** Encodes one exact canonical JSON fixture document. */
function encodeCanonical(value: unknown): Uint8Array {
  return new TextEncoder().encode(serializeCanonicalJson(value))
}

/** Creates a real cleanup directory plus fake strong-read and CAS ports. */
async function createHarness(): Promise<StageAbandonCliHarness> {
  const fixture =
    createWorkspaceSearchMigrationRehearsalStageChildMaterialTestFixture()
  const directory = await mkdtemp(join(tmpdir(), 'mukuroji-abandon-cli-'))
  await writeFile(
    join(directory, WORKSPACE_SEARCH_MIGRATION_REHEARSAL_RUNTIME_KEY_FILENAME),
    fixture.authenticationKey,
    { mode: 0o600 },
  )
  const stdoutLines: string[] = []
  const stderrLines: string[] = []
  let readHeadCalls = 0
  let abandonCalls = 0
  const documents = new Map<string, Uint8Array>([
    [paths.ratePolicy, new Uint8Array(fixture.ratePolicyBytes)],
    [paths.permit, encodeCanonical(fixture.permit)],
    [paths.masterKey, new Uint8Array(fixture.masterAuthenticationKey)],
    [paths.manifest, encodeCanonical(fixture.manifest)],
    [paths.reservation, encodeCanonical(fixture.stageReservation)],
  ])
  const dependencies:
    WorkspaceSearchMigrationRehearsalStageAbandonCliDependencies = {
      readPrivateInputFile: async (path): Promise<Uint8Array> => {
        const bytes = documents.get(path)
        if (bytes === undefined) throw new Error('UNEXPECTED_INPUT')
        return new Uint8Array(bytes)
      },
      readStageHead: async () => {
        readHeadCalls += 1
        return fixture.claimedStageHead
      },
      cleanupRuntimeKey:
        cleanupWorkspaceSearchMigrationRehearsalRuntimeKey,
      abandonStageReservation: async (input) => {
        abandonCalls += 1
        const transition =
          verifyWorkspaceSearchMigrationRehearsalStageReservationAbandonment({
            abandonment:
              input.stageReservationAbandonment.abandonment,
            reservation: input.stageReservationAbandonment.reservation,
            selection: input.stageReservationAbandonment.selection,
            runtimeVerificationKey:
              input.stageReservationAbandonment.runtimeVerificationKey,
            publicationVerificationKey:
              input.stageReservationAbandonment.publicationVerificationKey,
          })
        consumeWorkspaceSearchMigrationRehearsalRuntimeKeyCleanupAuthorization(
          input.stageReservationAbandonment
            .runtimeKeyCleanupAuthorization,
        )
        return Object.freeze({
          ...fixture.claimedStageHead,
          activeReservationDigest: null,
          activeStageOrdinal: null,
          activeExpiresAt: null,
          abandonmentCount: transition.abandonmentCount,
          abandonmentRootDigest: transition.abandonmentRootDigest,
          revision: transition.abandonmentRevision,
        })
      },
      now: (): Date => new Date('2026-08-02T01:55:00.000Z'),
      writeStdoutLine: (line): void => {
        stdoutLines.push(line)
      },
      writeStderrLine: (line): void => {
        stderrLines.push(line)
      },
    }
  return Object.freeze({
    fixture,
    directory,
    arguments_: createArguments(directory),
    dependencies,
    stdoutLines,
    stderrLines,
    readHeadCalls: () => readHeadCalls,
    abandonCalls: () => abandonCalls,
  })
}

/** Runs one harness callback and removes its real private directory. */
async function withHarness(
  callback: (harness: StageAbandonCliHarness) => Promise<void>,
): Promise<void> {
  const harness = await createHarness()
  try {
    await callback(harness)
  } finally {
    await rm(harness.directory, { force: true, recursive: true })
  }
}

describe('stage abandonment CLI', () => {
  test('core abandonment rejects one millisecond before and accepts the deadline', () => {
    const fixture =
      createWorkspaceSearchMigrationRehearsalStageChildMaterialTestFixture()
    const createAt = (abandonedAt: string): ReturnType<
      typeof createWorkspaceSearchMigrationRehearsalStageReservationAbandonment
    > =>
      createWorkspaceSearchMigrationRehearsalStageReservationAbandonment({
        reservation: fixture.stageReservation,
        selection: fixture.selection,
        reservationClaimRevision: fixture.claimedStageHead.revision,
        previousAbandonmentCount:
          fixture.claimedStageHead.abandonmentCount,
        previousAbandonmentRootDigest:
          fixture.claimedStageHead.abandonmentRootDigest,
        abandonedAt,
        runtimeKeyCleanupCompletionDigest: 'f'.repeat(64),
        runtimeVerificationKey: fixture.authenticationKey,
        publicationSigningKey: fixture.publicationAuthenticationKey,
      })
    expect(() => createAt('2026-08-02T01:54:59.999Z'))
      .toThrow('INVALID_STAGE_RESERVATION_ABANDONMENT')
    const abandonment = createAt('2026-08-02T01:55:00.000Z')
    expect(verifyWorkspaceSearchMigrationRehearsalStageReservationAbandonment({
      abandonment,
      reservation: fixture.stageReservation,
      selection: fixture.selection,
      runtimeVerificationKey: fixture.authenticationKey,
      publicationVerificationKey: fixture.publicationAuthenticationKey,
    })).toEqual(abandonment)
  })

  test('accepts no operator transition or cleanup artifact flags', () => {
    const configuration =
      parseWorkspaceSearchMigrationRehearsalStageAbandonCliArguments(
        createArguments('/private/abandon-evidence'),
      )
    expect(configuration.evidenceDirectory)
      .toBe('/private/abandon-evidence')
    expect(() =>
      parseWorkspaceSearchMigrationRehearsalStageAbandonCliArguments([
        ...createArguments('/private/abandon-evidence'),
        '--cleanup-intent-file',
        '/private/forged-cleanup.json',
      ])
    ).toThrow('INVALID_USAGE')
    expect(() =>
      parseWorkspaceSearchMigrationRehearsalStageAbandonCliArguments([
        ...createArguments('/private/abandon-evidence'),
        '--abandonment-file',
        '/private/forged-transition.json',
      ])
    ).toThrow('INVALID_USAGE')
  })

  test('abandons at the exact recovery deadline only after strong read and cleanup', async () => {
    await withHarness(async (harness) => {
      await expect(runWorkspaceSearchMigrationRehearsalStageAbandonCli(
        harness.arguments_,
        harness.dependencies,
      )).resolves.toBe(0)
      expect(harness.readHeadCalls()).toBe(1)
      expect(harness.abandonCalls()).toBe(1)
      expect(harness.stderrLines).toEqual([])
      expect(harness.stdoutLines).toHaveLength(1)
      const output: unknown = JSON.parse(harness.stdoutLines[0] ?? '')
      expect(output).toMatchObject({
        kind:
          WORKSPACE_SEARCH_MIGRATION_REHEARSAL_STAGE_ABANDON_CLI_RESULT_KIND,
        status: 'succeeded',
        stageOrdinal: 1,
        revision: 2,
      })
      expect(harness.stdoutLines[0]).not.toContain(harness.directory)
      expect(harness.stdoutLines[0]).not.toContain(resources.account)
      expect(harness.stdoutLines[0]).not.toContain(
        Buffer.from(harness.fixture.authenticationKey).toString('hex'),
      )
    })
  })

  test('requires recovery before the deadline without reading or cleaning', async () => {
    await withHarness(async (harness) => {
      let cleanupCalls = 0
      const dependencies:
        WorkspaceSearchMigrationRehearsalStageAbandonCliDependencies = {
          ...harness.dependencies,
          cleanupRuntimeKey: async (input) => {
            cleanupCalls += 1
            return await harness.dependencies.cleanupRuntimeKey(input)
          },
          now: (): Date => new Date('2026-08-02T01:54:59.999Z'),
        }
      await expect(runWorkspaceSearchMigrationRehearsalStageAbandonCli(
        harness.arguments_,
        dependencies,
      )).resolves.toBe(1)
      expect({
        readHeadCalls: harness.readHeadCalls(),
        cleanupCalls,
        abandonCalls: harness.abandonCalls(),
      }).toEqual({
        readHeadCalls: 0,
        cleanupCalls: 0,
        abandonCalls: 0,
      })
      expect(harness.stdoutLines).toEqual([])
      expect(harness.stderrLines).toEqual([
        serializeCanonicalJson({
          code: 'RECOVERY_REQUIRED',
          kind:
            WORKSPACE_SEARCH_MIGRATION_REHEARSAL_STAGE_ABANDON_CLI_RESULT_KIND,
          status: 'error',
        }),
      ])
    })
  })

  test('never calls the abandonment CAS when durable cleanup fails', async () => {
    await withHarness(async (harness) => {
      const dependencies:
        WorkspaceSearchMigrationRehearsalStageAbandonCliDependencies = {
          ...harness.dependencies,
          cleanupRuntimeKey: async () => {
            throw new Error('INJECTED_CLEANUP_FAILURE')
          },
        }
      await expect(runWorkspaceSearchMigrationRehearsalStageAbandonCli(
        harness.arguments_,
        dependencies,
      )).resolves.toBe(1)
      expect(harness.abandonCalls()).toBe(0)
      expect(harness.stdoutLines).toEqual([])
      expect(harness.stderrLines[0]).toContain('CLEANUP_FAILED')
    })
  })

  test('rejects missing or foreign runtime keys before the CAS boundary', async () => {
    for (const runtimeBytes of [
      undefined,
      new Uint8Array(32).fill(0xa5),
    ]) {
      await withHarness(async (harness) => {
        const runtimePath = join(
          harness.directory,
          WORKSPACE_SEARCH_MIGRATION_REHEARSAL_RUNTIME_KEY_FILENAME,
        )
        await rm(runtimePath)
        if (runtimeBytes !== undefined) {
          await writeFile(runtimePath, runtimeBytes, { mode: 0o600 })
        }
        await expect(runWorkspaceSearchMigrationRehearsalStageAbandonCli(
          harness.arguments_,
          harness.dependencies,
        )).resolves.toBe(1)
        expect(harness.abandonCalls()).toBe(0)
        expect(harness.stderrLines[0]).toContain('CLEANUP_FAILED')
      })
    }
  })

  test('rejects head, protocol, and trusted-time substitution before cleanup or CAS', async () => {
    await withHarness(async (harness) => {
      let cleanupCalls = 0
      const dependencies:
        WorkspaceSearchMigrationRehearsalStageAbandonCliDependencies = {
          ...harness.dependencies,
          readStageHead: async () => Object.freeze({
            ...harness.fixture.claimedStageHead,
            activeReservationDigest: createMigrationDigest({ forged: true }),
          }),
          cleanupRuntimeKey: async (input) => {
            cleanupCalls += 1
            return await harness.dependencies.cleanupRuntimeKey(input)
          },
        }
      await expect(runWorkspaceSearchMigrationRehearsalStageAbandonCli(
        harness.arguments_,
        dependencies,
      )).resolves.toBe(1)
      expect(cleanupCalls).toBe(0)
      expect(harness.abandonCalls()).toBe(0)
    })

    await withHarness(async (harness) => {
      const dependencies:
        WorkspaceSearchMigrationRehearsalStageAbandonCliDependencies = {
          ...harness.dependencies,
          now: (): Date => new Date('2026-08-02T02:30:00.000Z'),
        }
      await expect(runWorkspaceSearchMigrationRehearsalStageAbandonCli(
        harness.arguments_,
        dependencies,
      )).resolves.toBe(1)
      expect(harness.readHeadCalls()).toBe(0)
      expect(harness.abandonCalls()).toBe(0)
    })

    await withHarness(async (harness) => {
      const reservation = Object.freeze({
        ...harness.fixture.stageReservation,
        parentLivenessProtocol: 'substituted-fd4-v1',
      })
      const readPrivateInputFile = harness.dependencies.readPrivateInputFile
      const dependencies:
        WorkspaceSearchMigrationRehearsalStageAbandonCliDependencies = {
          ...harness.dependencies,
          readPrivateInputFile: async (path, maximumBytes) =>
            path === paths.reservation
              ? encodeCanonical(reservation)
              : await readPrivateInputFile(path, maximumBytes),
        }
      await expect(runWorkspaceSearchMigrationRehearsalStageAbandonCli(
        harness.arguments_,
        dependencies,
      )).resolves.toBe(1)
      expect(harness.readHeadCalls()).toBe(0)
      expect(harness.abandonCalls()).toBe(0)
    })
  })
})
