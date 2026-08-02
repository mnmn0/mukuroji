import { createHash } from 'node:crypto'
import {
  chmod,
  mkdir,
  mkdtemp,
  readFile,
  rm,
  symlink,
  writeFile,
} from 'node:fs/promises'
import { renameSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { describe, expect, test } from 'bun:test'
import { serializeCanonicalJson } from './migration-contract'
import {
  createWorkspaceSearchMigrationRehearsalStageChildMaterialTestFixture,
} from './migration-rehearsal-stage-child-material.test-fixture'
import {
  createWorkspaceSearchMigrationRehearsalStageReservation,
  type WorkspaceSearchMigrationRehearsalStageReservation,
} from './migration-rehearsal-stage-reservation'
import type {
  WorkspaceSearchMigrationRehearsalSelectedStage,
} from './migration-rehearsal-stage-receipt'
import {
  cleanupWorkspaceSearchMigrationRehearsalRuntimeKey,
  consumeWorkspaceSearchMigrationRehearsalRuntimeKeyCleanupAuthorization,
  readWorkspaceSearchMigrationRehearsalRuntimeKeyCleanupAuthorizationBinding,
  WORKSPACE_SEARCH_MIGRATION_REHEARSAL_RUNTIME_KEY_CLEANUP_COMPLETION_FILENAME,
  WORKSPACE_SEARCH_MIGRATION_REHEARSAL_RUNTIME_KEY_CLEANUP_INTENT_FILENAME,
  WORKSPACE_SEARCH_MIGRATION_REHEARSAL_RUNTIME_KEY_FILENAME,
  type WorkspaceSearchMigrationRehearsalRuntimeKeyCleanupAuthorization,
  type WorkspaceSearchMigrationRehearsalRuntimeKeyCleanupCheckpoint,
  type WorkspaceSearchMigrationRehearsalRuntimeKeyCleanupDependencies,
} from './migration-rehearsal-runtime-key-cleanup'

/** Canonical reservation creation time shared by cleanup tests. */
const reservedAt = '2026-08-02T00:00:00.000Z'

/** Canonical reservation expiry shared by ordinary cleanup tests. */
const expiresAt = '2026-08-02T00:30:00.000Z'

/** Canonical first cleanup-intent time. */
const preparedAt = '2026-08-02T00:05:00.000Z'

/** Canonical post-unlink cleanup-completion time. */
const completedAt = '2026-08-02T00:05:01.000Z'

/** Mutable real-filesystem fixture for one cleanup operation. */
type RuntimeKeyCleanupFixture = {
  /** Owner-only temporary evidence directory. */
  readonly directory: string
  /** Exact authenticated selected manifest entry. */
  readonly selection: WorkspaceSearchMigrationRehearsalSelectedStage
  /** Exact active reservation bound to the runtime key. */
  readonly reservation: WorkspaceSearchMigrationRehearsalStageReservation
  /** Runtime key copied for the test invocation. */
  readonly runtimeKey: Uint8Array
  /** Parent publication key copied for the test invocation. */
  readonly publicationKey: Uint8Array
}

/** Options for constructing one filesystem fixture. */
type CreateRuntimeKeyCleanupFixtureOptions = {
  /** Whether to create the fixed runtime-key path. */
  readonly createRuntimeKey?: boolean
  /** Optional initial runtime bytes replacing the authentic key. */
  readonly runtimeBytes?: Uint8Array
  /** Optional initial runtime-file permission mode. */
  readonly runtimeMode?: number
}

/** Creates a fresh reservation and fixed runtime-key path. */
async function createFixture(
  options: CreateRuntimeKeyCleanupFixtureOptions = {},
): Promise<RuntimeKeyCleanupFixture> {
  const material =
    createWorkspaceSearchMigrationRehearsalStageChildMaterialTestFixture()
  const runtimeKey = new Uint8Array(material.authenticationKey)
  const publicationKey = new Uint8Array(
    material.publicationAuthenticationKey,
  )
  const reservation =
    createWorkspaceSearchMigrationRehearsalStageReservation({
      selection: material.selection,
      nonce: createHash('sha256').update('cleanup-reservation').digest(),
      reservedAt,
      expiresAt,
      expectedPreviousRateSegment:
        material.manifest.integrityAttestationRoot.segment,
      expectedCurrentRateSegmentOrdinal: 1,
      expectedTargetPreimageArtifactContentDigest: null,
      signingKey: runtimeKey,
    })
  const directory = await mkdtemp(join(tmpdir(), 'mukuroji-key-cleanup-'))
  if (options.createRuntimeKey !== false) {
    await writeFile(
      runtimePath(directory),
      options.runtimeBytes ?? runtimeKey,
      { mode: options.runtimeMode ?? 0o600 },
    )
  }
  return Object.freeze({
    directory,
    selection: material.selection,
    reservation,
    runtimeKey,
    publicationKey,
  })
}

/** Runs cleanup with a deterministic finite trusted-clock sequence. */
async function cleanupFixture(
  fixture: RuntimeKeyCleanupFixture,
  timestamps: readonly string[] = [preparedAt, completedAt],
  dependencies?:
    WorkspaceSearchMigrationRehearsalRuntimeKeyCleanupDependencies,
): Promise<WorkspaceSearchMigrationRehearsalRuntimeKeyCleanupAuthorization> {
  let index = 0
  return await cleanupWorkspaceSearchMigrationRehearsalRuntimeKey({
    evidenceDirectory: fixture.directory,
    reservation: fixture.reservation,
    selection: fixture.selection,
    expectedRuntimeKey: fixture.runtimeKey,
    publicationAuthenticationKey: fixture.publicationKey,
    now: (): Date => {
      const timestamp = timestamps[index]
      index += 1
      if (timestamp === undefined) throw new Error('Unexpected clock read.')
      return new Date(timestamp)
    },
    ...(dependencies === undefined ? {} : { dependencies }),
  })
}

/** Returns the fixed runtime-key path for one evidence directory. */
function runtimePath(directory: string): string {
  return join(
    directory,
    WORKSPACE_SEARCH_MIGRATION_REHEARSAL_RUNTIME_KEY_FILENAME,
  )
}

/** Returns the fixed cleanup-intent path for one evidence directory. */
function intentPath(directory: string): string {
  return join(
    directory,
    WORKSPACE_SEARCH_MIGRATION_REHEARSAL_RUNTIME_KEY_CLEANUP_INTENT_FILENAME,
  )
}

/** Returns the fixed cleanup-completion path for one evidence directory. */
function completionPath(directory: string): string {
  return join(
    directory,
    WORKSPACE_SEARCH_MIGRATION_REHEARSAL_RUNTIME_KEY_CLEANUP_COMPLETION_FILENAME,
  )
}

/** Replaces one canonical artifact field while preserving canonical bytes. */
async function replaceArtifactField(
  path: string,
  field: string,
  value: unknown,
): Promise<void> {
  const parsed: unknown = JSON.parse(await readFile(path, 'utf8'))
  if (
    typeof parsed !== 'object' ||
    parsed === null ||
    Array.isArray(parsed)
  ) throw new Error('Unexpected cleanup artifact fixture.')
  const clone = Object.fromEntries(Object.entries(parsed))
  clone[field] = value
  await writeFile(path, serializeCanonicalJson(clone), { mode: 0o600 })
}

/** Executes one callback and always removes the fixture directory. */
async function withFixture(
  callback: (fixture: RuntimeKeyCleanupFixture) => Promise<void>,
  options?: CreateRuntimeKeyCleanupFixtureOptions,
): Promise<void> {
  const fixture = await createFixture(options)
  try {
    await callback(fixture)
  } finally {
    await rm(fixture.directory, { force: true, recursive: true })
  }
}

describe('runtime-key cleanup durability', () => {
  test('zeros through partial writes, fsyncs, unlinks, and mints a genuine capability', async () => {
    await withFixture(async (fixture) => {
      let progressWrites = 0
      const authorization = await cleanupFixture(
        fixture,
        [preparedAt, completedAt],
        {
          maximumWriteBytes: 3,
          onCheckpoint: (checkpoint): void => {
            if (checkpoint === 'runtime-key-zero-progress') {
              progressWrites += 1
            }
          },
        },
      )
      expect(progressWrites).toBe(11)
      await expect(readFile(runtimePath(fixture.directory))).rejects
        .toMatchObject({ code: 'ENOENT' })
      const binding =
        readWorkspaceSearchMigrationRehearsalRuntimeKeyCleanupAuthorizationBinding(
          authorization,
        )
      expect(binding).toMatchObject({
        reservationDigest: expect.any(String),
        parentLivenessProtocol: 'silent-fd4-v1',
        preparedAt,
        completedAt,
      })
      expect(await readFile(intentPath(fixture.directory), 'utf8'))
        .not.toContain(Buffer.from(fixture.runtimeKey).toString('hex'))
      expect(await readFile(completionPath(fixture.directory), 'utf8'))
        .not.toContain(Buffer.from(fixture.runtimeKey).toString('hex'))
    })
  })

  test('recovers crashes after intent, during zeroing, and after durable zeroing', async () => {
    for (const crashCheckpoint of [
      'intent-durable',
      'runtime-key-zero-progress',
      'runtime-key-zero-durable',
    ] satisfies readonly WorkspaceSearchMigrationRehearsalRuntimeKeyCleanupCheckpoint[]) {
      await withFixture(async (fixture) => {
        let crashed = false
        await expect(cleanupFixture(
          fixture,
          [preparedAt],
          {
            maximumWriteBytes: 7,
            onCheckpoint: (checkpoint): void => {
              if (!crashed && checkpoint === crashCheckpoint) {
                crashed = true
                throw new Error('SIMULATED_CRASH')
              }
            },
          },
        )).rejects.toThrow('INVALID_REHEARSAL_RUNTIME_KEY_CLEANUP')
        const authorization = await cleanupFixture(
          fixture,
          [completedAt],
          { maximumWriteBytes: 5 },
        )
        expect(
          readWorkspaceSearchMigrationRehearsalRuntimeKeyCleanupAuthorizationBinding(
            authorization,
          ).completedAt,
        ).toBe(completedAt)
      })
    }
  })

  test('recovers every intent artifact-publication crash state', async () => {
    for (const crashCheckpoint of [
      'intent-artifact-temp-durable',
      'intent-artifact-linked',
      'intent-artifact-link-durable',
      'intent-artifact-temp-unlinked',
    ] satisfies readonly WorkspaceSearchMigrationRehearsalRuntimeKeyCleanupCheckpoint[]) {
      await withFixture(async (fixture) => {
        await expect(cleanupFixture(
          fixture,
          [preparedAt],
          {
            onCheckpoint: (checkpoint): void => {
              if (checkpoint === crashCheckpoint) {
                throw new Error('SIMULATED_CRASH')
              }
            },
          },
        )).rejects.toThrow('INVALID_REHEARSAL_RUNTIME_KEY_CLEANUP')

        const requiresNewIntent =
          crashCheckpoint === 'intent-artifact-temp-durable'
        const authorization = await cleanupFixture(
          fixture,
          requiresNewIntent
            ? [preparedAt, completedAt]
            : [completedAt],
        )
        expect(
          readWorkspaceSearchMigrationRehearsalRuntimeKeyCleanupAuthorizationBinding(
            authorization,
          ).completedAt,
        ).toBe(completedAt)
      })
    }
  })

  test('recovers every completion artifact-publication crash state', async () => {
    for (const crashCheckpoint of [
      'completion-artifact-temp-durable',
      'completion-artifact-linked',
      'completion-artifact-link-durable',
      'completion-artifact-temp-unlinked',
    ] satisfies readonly WorkspaceSearchMigrationRehearsalRuntimeKeyCleanupCheckpoint[]) {
      await withFixture(async (fixture) => {
        await expect(cleanupFixture(
          fixture,
          [preparedAt, completedAt],
          {
            onCheckpoint: (checkpoint): void => {
              if (checkpoint === crashCheckpoint) {
                throw new Error('SIMULATED_CRASH')
              }
            },
          },
        )).rejects.toThrow('INVALID_REHEARSAL_RUNTIME_KEY_CLEANUP')

        const authorization = await cleanupFixture(
          fixture,
          crashCheckpoint === 'completion-artifact-temp-durable'
            ? [completedAt]
            : [],
        )
        expect(
          readWorkspaceSearchMigrationRehearsalRuntimeKeyCleanupAuthorizationBinding(
            authorization,
          ).completedAt,
        ).toBe(completedAt)
      })
    }
  })

  test('discards a partial temporary artifact without exposing a partial final path', async () => {
    await withFixture(async (fixture) => {
      const finalPath = intentPath(fixture.directory)
      await writeFile(`${finalPath}.tmp`, '{"incomplete":', { mode: 0o600 })
      await expect(readFile(finalPath)).rejects.toMatchObject({ code: 'ENOENT' })

      const authorization = await cleanupFixture(fixture)
      expect(
        readWorkspaceSearchMigrationRehearsalRuntimeKeyCleanupAuthorizationBinding(
          authorization,
        ).completedAt,
      ).toBe(completedAt)
      await expect(readFile(`${finalPath}.tmp`)).rejects
        .toMatchObject({ code: 'ENOENT' })
      expect(JSON.parse(await readFile(finalPath, 'utf8')))
        .toMatchObject({ preparedAt })
    })
  })

  test('recovers a crash after durable completion and runtime unlink', async () => {
    await withFixture(async (fixture) => {
      await expect(cleanupFixture(
        fixture,
        [preparedAt, completedAt],
        {
          onCheckpoint: (checkpoint): void => {
            if (checkpoint === 'runtime-key-unlinked') {
              throw new Error('SIMULATED_CRASH')
            }
          },
        },
      )).rejects.toThrow('INVALID_REHEARSAL_RUNTIME_KEY_CLEANUP')
      const authorization = await cleanupFixture(fixture, [])
      expect(
        readWorkspaceSearchMigrationRehearsalRuntimeKeyCleanupAuthorizationBinding(
          authorization,
        ).completedAt,
      ).toBe(completedAt)
    })
  })

  test('remints only from authenticated completion after a post-completion crash', async () => {
    await withFixture(async (fixture) => {
      await expect(cleanupFixture(
        fixture,
        [preparedAt, completedAt],
        {
          onCheckpoint: (checkpoint): void => {
            if (checkpoint === 'completion-durable') {
              throw new Error('SIMULATED_CRASH')
            }
          },
        },
      )).rejects.toThrow('INVALID_REHEARSAL_RUNTIME_KEY_CLEANUP')
      const authorization = await cleanupFixture(fixture, [])
      expect(
        readWorkspaceSearchMigrationRehearsalRuntimeKeyCleanupAuthorizationBinding(
          authorization,
        ).completedAt,
      ).toBe(completedAt)
    })
  })

  test('rejects missing runtime alone and every ambiguous artifact/path state', async () => {
    await withFixture(async (fixture) => {
      await expect(cleanupFixture(fixture))
        .rejects.toThrow('INVALID_REHEARSAL_RUNTIME_KEY_CLEANUP')
    }, { createRuntimeKey: false })

    await withFixture(async (fixture) => {
      await cleanupFixture(fixture)
      await writeFile(runtimePath(fixture.directory), fixture.runtimeKey, {
        mode: 0o600,
      })
      await expect(cleanupFixture(fixture, []))
        .rejects.toThrow('INVALID_REHEARSAL_RUNTIME_KEY_CLEANUP')
    })

    await withFixture(async (fixture) => {
      await cleanupFixture(fixture)
      await rm(intentPath(fixture.directory))
      await expect(cleanupFixture(fixture, []))
        .rejects.toThrow('INVALID_REHEARSAL_RUNTIME_KEY_CLEANUP')
    })
  })

  test('never writes without an intent when bytes are partial-zero or foreign', async () => {
    const partial = new Uint8Array(32)
    partial.fill(9)
    partial.fill(0, 0, 8)
    await withFixture(async (fixture) => {
      const before = await readFile(runtimePath(fixture.directory))
      await expect(cleanupFixture(fixture))
        .rejects.toThrow('INVALID_REHEARSAL_RUNTIME_KEY_CLEANUP')
      expect(await readFile(runtimePath(fixture.directory))).toEqual(before)
      await expect(readFile(intentPath(fixture.directory))).rejects
        .toMatchObject({ code: 'ENOENT' })
    }, { runtimeBytes: partial })

    await withFixture(async (fixture) => {
      const before = await readFile(runtimePath(fixture.directory))
      await expect(cleanupFixture(fixture))
        .rejects.toThrow('INVALID_REHEARSAL_RUNTIME_KEY_CLEANUP')
      expect(await readFile(runtimePath(fixture.directory))).toEqual(before)
    }, { runtimeBytes: createHash('sha256').update('foreign-key').digest() })
  })

  test('rejects tampered intent and completion MAC bindings', async () => {
    await withFixture(async (fixture) => {
      await expect(cleanupFixture(
        fixture,
        [preparedAt],
        {
          onCheckpoint: (checkpoint): void => {
            if (checkpoint === 'intent-durable') throw new Error('CRASH')
          },
        },
      )).rejects.toThrow()
      await replaceArtifactField(
        intentPath(fixture.directory),
        'runtimeKeyFingerprint',
        '0'.repeat(64),
      )
      await expect(cleanupFixture(fixture, [completedAt]))
        .rejects.toThrow('INVALID_REHEARSAL_RUNTIME_KEY_CLEANUP')
    })

    await withFixture(async (fixture) => {
      await cleanupFixture(fixture)
      await replaceArtifactField(
        completionPath(fixture.directory),
        'parentLivenessProtocol',
        'substituted-fd4-v1',
      )
      await expect(cleanupFixture(fixture, []))
        .rejects.toThrow('INVALID_REHEARSAL_RUNTIME_KEY_CLEANUP')
    })
  })

  test('rejects symlink, nonregular, wrong-mode, and wrong-size runtime paths', async () => {
    await withFixture(async (fixture) => {
      const target = join(fixture.directory, 'target.key')
      await writeFile(target, fixture.runtimeKey, { mode: 0o600 })
      await symlink(target, runtimePath(fixture.directory))
      await expect(cleanupFixture(fixture))
        .rejects.toThrow('INVALID_REHEARSAL_RUNTIME_KEY_CLEANUP')
    }, { createRuntimeKey: false })

    await withFixture(async (fixture) => {
      await mkdir(runtimePath(fixture.directory), { mode: 0o700 })
      await expect(cleanupFixture(fixture))
        .rejects.toThrow('INVALID_REHEARSAL_RUNTIME_KEY_CLEANUP')
    }, { createRuntimeKey: false })

    await withFixture(async (fixture) => {
      await chmod(runtimePath(fixture.directory), 0o640)
      await expect(cleanupFixture(fixture))
        .rejects.toThrow('INVALID_REHEARSAL_RUNTIME_KEY_CLEANUP')
    })

    await withFixture(async (fixture) => {
      await writeFile(runtimePath(fixture.directory), new Uint8Array(31))
      await expect(cleanupFixture(fixture))
        .rejects.toThrow('INVALID_REHEARSAL_RUNTIME_KEY_CLEANUP')
    })
  })

  test('rejects path-to-inode substitution after durable intent', async () => {
    await withFixture(async (fixture) => {
      const original = runtimePath(fixture.directory)
      const displaced = join(fixture.directory, 'displaced-runtime.key')
      await expect(cleanupFixture(
        fixture,
        [preparedAt],
        {
          onCheckpoint: (checkpoint): void => {
            if (checkpoint !== 'intent-durable') return
            renameSync(original, displaced)
            writeFileSync(original, fixture.runtimeKey, { mode: 0o600 })
          },
        },
      )).rejects.toThrow('INVALID_REHEARSAL_RUNTIME_KEY_CLEANUP')
      expect(Array.from(await readFile(original)))
        .toEqual(Array.from(fixture.runtimeKey))
      expect(Array.from(await readFile(displaced)))
        .toEqual(Array.from(fixture.runtimeKey))
    })
  })

  test('rejects nonmonotonic clocks and times before the reservation floor', async () => {
    await withFixture(async (fixture) => {
      await expect(cleanupFixture(
        fixture,
        ['2026-08-01T23:59:59.999Z'],
      )).rejects.toThrow('INVALID_REHEARSAL_RUNTIME_KEY_CLEANUP')
      expect(Array.from(await readFile(runtimePath(fixture.directory))))
        .toEqual(Array.from(fixture.runtimeKey))
    })

    await withFixture(async (fixture) => {
      await expect(cleanupFixture(
        fixture,
        [completedAt, preparedAt],
      )).rejects.toThrow('INVALID_REHEARSAL_RUNTIME_KEY_CLEANUP')
      expect(Array.from(await readFile(runtimePath(fixture.directory))))
        .toEqual(Array.from(new Uint8Array(32)))
    })
  })

  test('rejects forged, cloned, proxied, and replayed cleanup capabilities', async () => {
    await withFixture(async (fixture) => {
      const authorization = await cleanupFixture(fixture)
      await expect(Promise.resolve().then(() =>
        readWorkspaceSearchMigrationRehearsalRuntimeKeyCleanupAuthorizationBinding(
          Object.freeze({ ...authorization }),
        ),
      )).rejects.toThrow('INVALID_REHEARSAL_RUNTIME_KEY_CLEANUP')
      await expect(Promise.resolve().then(() =>
        readWorkspaceSearchMigrationRehearsalRuntimeKeyCleanupAuthorizationBinding(
          structuredClone(authorization),
        ),
      )).rejects.toThrow('INVALID_REHEARSAL_RUNTIME_KEY_CLEANUP')
      await expect(Promise.resolve().then(() =>
        readWorkspaceSearchMigrationRehearsalRuntimeKeyCleanupAuthorizationBinding(
          new Proxy(authorization, {}),
        ),
      )).rejects.toThrow('INVALID_REHEARSAL_RUNTIME_KEY_CLEANUP')

      const consumed =
        consumeWorkspaceSearchMigrationRehearsalRuntimeKeyCleanupAuthorization(
          authorization,
        )
      expect(consumed.completedAt).toBe(completedAt)
      expect(() =>
        consumeWorkspaceSearchMigrationRehearsalRuntimeKeyCleanupAuthorization(
          authorization,
        )
      ).toThrow('INVALID_REHEARSAL_RUNTIME_KEY_CLEANUP')
      expect(() =>
        readWorkspaceSearchMigrationRehearsalRuntimeKeyCleanupAuthorizationBinding(
          authorization,
        )
      ).toThrow('INVALID_REHEARSAL_RUNTIME_KEY_CLEANUP')

      const reminted = await cleanupFixture(fixture, [])
      expect(
        readWorkspaceSearchMigrationRehearsalRuntimeKeyCleanupAuthorizationBinding(
          reminted,
        ).cleanupCompletionDigest,
      ).toBe(consumed.cleanupCompletionDigest)
    })
  })
})
