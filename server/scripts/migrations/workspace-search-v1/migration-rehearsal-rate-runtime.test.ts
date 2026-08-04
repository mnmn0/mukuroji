import { createHash } from 'node:crypto'
import {
  mkdtemp,
  readFile,
  rm,
  stat,
  symlink,
} from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { describe, expect, test } from 'bun:test'
import type {
  WorkspaceSearchMigrationDescribeTableRateObservation,
} from './migration-describe-table-rate-budget'
import {
  WORKSPACE_SEARCH_MIGRATION_DESCRIBE_TABLE_RATE_OBSERVATION_VERSION,
} from './migration-describe-table-rate-budget'
import {
  createWorkspaceSearchMigrationRehearsalRateRuntime,
  type WorkspaceSearchMigrationRehearsalRateRuntimeDependencies,
  type WorkspaceSearchMigrationRehearsalRateRuntimeSegmentFile,
} from './migration-rehearsal-rate-runtime'

const key = new Uint8Array(32).fill(51)
const policyVersion = digest('reviewed-policy')
const configurationHash = digest('reviewed-configuration')

/** In-memory segment file retaining one exact chunk per durable append. */
class RecordingSegmentFile
  implements WorkspaceSearchMigrationRehearsalRateRuntimeSegmentFile {
  /** Exact complete record chunks accepted by the fake fsync boundary. */
  readonly chunks: Uint8Array[] = []

  /** One-based append invocation that fails, or undefined. */
  failAtAppend: number | undefined

  /** Number of close requests. */
  closeCount = 0

  /** Appends one detached record or raises the configured durability failure. */
  async appendRecordDurably(bytes: Uint8Array): Promise<void> {
    if (this.chunks.length + 1 === this.failAtAppend) {
      throw new Error('raw fsync failure')
    }
    this.chunks.push(bytes.slice())
  }

  /** Records descriptor closure. */
  async close(): Promise<void> {
    this.closeCount += 1
  }
}

/** Captured deterministic runtime dependency harness. */
type RuntimeHarness = {
  /** Exact injectable runtime dependencies. */
  readonly dependencies:
    WorkspaceSearchMigrationRehearsalRateRuntimeDependencies
  /** Newly opened fake segment files. */
  readonly files: RecordingSegmentFile[]
  /** Requested new output paths. */
  readonly openedPaths: string[]
  /** Requested predecessor paths. */
  readonly previousPaths: string[]
}

/** Creates one conventional lowercase SHA-256 digest. */
function digest(label: string): string {
  return createHash('sha256').update(label, 'utf8').digest('hex')
}

/** Creates one sanitized physical DescribeTable start observation. */
function attemptObservation(
  sequence: number,
  observedAtMilliseconds: number,
): WorkspaceSearchMigrationDescribeTableRateObservation {
  return {
    version:
      WORKSPACE_SEARCH_MIGRATION_DESCRIBE_TABLE_RATE_OBSERVATION_VERSION,
    kind: 'attempt',
    phase: 'checkpoint-page',
    sequence,
    observedAtMilliseconds,
    remainingNormalAdmissionAttempts: 100,
    remainingWindowAttempts: 10,
    remainingPageAttempts: 5,
    inFlight: 1,
  }
}

/** Concatenates exact append chunks into one process segment. */
function concatenate(chunks: readonly Uint8Array[]): Uint8Array {
  const byteLength = chunks.reduce(
    (total, chunk) => total + chunk.byteLength,
    0,
  )
  const bytes = new Uint8Array(byteLength)
  let offset = 0
  for (const chunk of chunks) {
    bytes.set(chunk, offset)
    offset += chunk.byteLength
  }
  return bytes
}

/** Parses one canonical line from a fake durable chunk. */
function parseChunk(bytes: Uint8Array): Readonly<Record<string, unknown>> {
  const text = new TextDecoder().decode(bytes)
  const value: unknown = JSON.parse(text.slice(0, -1))
  if (typeof value !== 'object' || value === null || Array.isArray(value)) {
    throw new Error('Invalid test record.')
  }
  const result: Record<string, unknown> = {}
  for (const key of Object.keys(value)) {
    const descriptor = Object.getOwnPropertyDescriptor(value, key)
    if (descriptor === undefined || !Object.hasOwn(descriptor, 'value')) {
      throw new Error('Invalid test record property.')
    }
    result[key] = descriptor.value
  }
  return result
}

/** Creates deterministic AWS-free runtime effects. */
function createRuntimeHarness(
  previousBytes?: Uint8Array,
  entropyByte = 7,
): RuntimeHarness {
  const files: RecordingSegmentFile[] = []
  const openedPaths: string[] = []
  const previousPaths: string[] = []
  return {
    files,
    openedPaths,
    previousPaths,
    dependencies: {
      openSegmentFileExclusive: async (path) => {
        openedPaths.push(path)
        const file = new RecordingSegmentFile()
        files.push(file)
        return file
      },
      readPreviousSegmentFile: async (path) => {
        previousPaths.push(path)
        if (previousBytes === undefined) throw new Error('missing predecessor')
        return previousBytes.slice()
      },
      createSegmentEntropy: () => new Uint8Array(32).fill(entropyByte),
      wallClock: () => new Date('2026-08-02T00:00:00.000Z'),
      monotonicClock: () => 10_000,
    },
  }
}

/** Creates the common strict runtime input for one output path. */
function createRuntimeInput(segmentFile: string) {
  return {
    segmentFile,
    expectedPolicyVersion: policyVersion,
    expectedConfigurationBindingDigest: configurationHash,
    authenticationKey: key,
  }
}

describe('migration rehearsal durable rate runtime', () => {
  test('installs an HMAC recorder whose header and every observation cross the durable append boundary', async () => {
    const harness = createRuntimeHarness()
    const runtime = await createWorkspaceSearchMigrationRehearsalRateRuntime(
      createRuntimeInput('/private/rate-segment-0.ndjson'),
      harness.dependencies,
    )
    const file = harness.files[0]
    if (file === undefined) throw new Error('Expected opened segment file.')
    expect(file.chunks).toHaveLength(1)
    const header = parseChunk(file.chunks[0] ?? new Uint8Array())
    expect(header.segmentOrdinal).toBe(0)
    expect(header.firstEventSequence).toBe(1)
    expect(header.policyVersion).toBe(policyVersion)
    expect(header.configurationBindingDigest).toBe(configurationHash)
    expect(header.segmentLocatorDigest).toMatch(/^[0-9a-f]{64}$/)

    runtime.recorder.record(attemptObservation(1, 10_000))
    const committed = await runtime.flush()

    expect(file.chunks).toHaveLength(3)
    expect(committed.eventCount).toBe(2)
    expect(committed.firstCommittedEventSequence).toBe(1)
    expect(committed.lastCommittedEventSequence).toBe(2)
    await runtime.close()
    expect(file.closeCount).toBe(1)
  })

  test('creates a unique successor and restores ordinal, sequence, digest, and MAC from the authenticated predecessor prefix', async () => {
    const firstHarness = createRuntimeHarness(undefined, 1)
    const first = await createWorkspaceSearchMigrationRehearsalRateRuntime(
      createRuntimeInput('/private/rate-segment-0.ndjson'),
      firstHarness.dependencies,
    )
    first.recorder.record(attemptObservation(1, 10_000))
    const firstCommitted = await first.flush()
    await first.close()
    const interrupted = new Uint8Array(firstCommitted.canonicalBytes.byteLength + 4)
    interrupted.set(firstCommitted.canonicalBytes)
    interrupted.set(new TextEncoder().encode('{"x'), firstCommitted.canonicalBytes.byteLength)

    const secondHarness = createRuntimeHarness(interrupted, 2)
    const second = await createWorkspaceSearchMigrationRehearsalRateRuntime({
      ...createRuntimeInput('/private/rate-segment-1.ndjson'),
      previousSegmentFile: '/private/rate-segment-0.ndjson',
    }, secondHarness.dependencies)
    const secondFile = secondHarness.files[0]
    if (secondFile === undefined) throw new Error('Expected successor file.')
    const header = parseChunk(secondFile.chunks[0] ?? new Uint8Array())

    expect(secondHarness.previousPaths).toEqual([
      '/private/rate-segment-0.ndjson',
    ])
    expect(header.segmentOrdinal).toBe(1)
    expect(header.firstEventSequence).toBe(3)
    expect(header.previousSegmentDigest).toBe(firstCommitted.segmentDigest)
    expect(header.previousRecordMac).toBe(firstCommitted.terminalRecordMac)
    expect(header.segmentLocatorDigest).not.toBe(
      firstCommitted.segmentLocatorDigest,
    )
    await second.close()
  })

  test('durably forfeits an authenticated pending predecessor charge before exposing the successor runtime', async () => {
    const firstHarness = createRuntimeHarness()
    const first = await createWorkspaceSearchMigrationRehearsalRateRuntime(
      createRuntimeInput('/private/rate-segment-0.ndjson'),
      firstHarness.dependencies,
    )
    const firstFile = firstHarness.files[0]
    if (firstFile === undefined) throw new Error('Expected first segment file.')
    firstFile.failAtAppend = 3
    first.recorder.record(attemptObservation(1, 10_000))
    await expect(first.flush()).rejects.toMatchObject({
      code: 'DURABILITY_FAILED',
    })
    const predecessorBytes = concatenate(firstFile.chunks)
    await expect(first.close()).rejects.toMatchObject({
      code: 'DURABILITY_FAILED',
    })

    const secondHarness = createRuntimeHarness(predecessorBytes)
    const second = await createWorkspaceSearchMigrationRehearsalRateRuntime({
      ...createRuntimeInput('/private/rate-segment-1.ndjson'),
      previousSegmentFile: '/private/rate-segment-0.ndjson',
    }, secondHarness.dependencies)
    const secondFile = secondHarness.files[0]
    if (secondFile === undefined) {
      throw new Error('Expected successor segment file.')
    }

    expect(secondFile.chunks).toHaveLength(2)
    expect(parseChunk(secondFile.chunks[0] ?? new Uint8Array())).toMatchObject({
      segmentOrdinal: 1,
      firstEventSequence: 2,
    })
    expect(parseChunk(secondFile.chunks[1] ?? new Uint8Array())).toMatchObject({
      kind: 'attempt-forfeited',
      eventSequence: 2,
      attemptSequence: 1,
      phase: 'checkpoint-page',
      reason: 'segment-cutoff-before-durable-start',
    })
    await second.close()
  })

  test('rejects a tampered predecessor before creating the fresh output file', async () => {
    const firstHarness = createRuntimeHarness()
    const first = await createWorkspaceSearchMigrationRehearsalRateRuntime(
      createRuntimeInput('/private/rate-segment-0.ndjson'),
      firstHarness.dependencies,
    )
    first.recorder.record(attemptObservation(1, 10_000))
    const committed = await first.flush()
    await first.close()
    const tampered = committed.canonicalBytes.slice()
    tampered[tampered.byteLength - 3] = 0x39
    const secondHarness = createRuntimeHarness(tampered)

    await expect(createWorkspaceSearchMigrationRehearsalRateRuntime({
      ...createRuntimeInput('/private/rate-segment-1.ndjson'),
      previousSegmentFile: '/private/rate-segment-0.ndjson',
    }, secondHarness.dependencies)).rejects.toMatchObject({
      code: 'INVALID_ARGUMENT',
    })
    expect(secondHarness.openedPaths).toHaveLength(0)
  })

  test('turns an asynchronous append failure into a stable flush failure and still closes the file', async () => {
    const harness = createRuntimeHarness()
    const runtime = await createWorkspaceSearchMigrationRehearsalRateRuntime(
      createRuntimeInput('/private/rate-segment.ndjson'),
      harness.dependencies,
    )
    const file = harness.files[0]
    if (file === undefined) throw new Error('Expected segment file.')
    file.failAtAppend = 2
    runtime.recorder.record(attemptObservation(1, 10_000))

    await expect(runtime.flush()).rejects.toMatchObject({
      code: 'DURABILITY_FAILED',
    })
    await expect(runtime.close()).rejects.toMatchObject({
      code: 'DURABILITY_FAILED',
    })
    expect(file.closeCount).toBe(1)
  })

  test('uses real no-follow exclusive mode-0600 files and rejects predecessor symlinks', async () => {
    const directory = await mkdtemp(join(tmpdir(), 'mukuroji-rate-runtime-'))
    try {
      const firstPath = join(directory, 'segment-0.ndjson')
      const runtime = await createWorkspaceSearchMigrationRehearsalRateRuntime(
        createRuntimeInput(firstPath),
      )
      runtime.recorder.record(attemptObservation(1, Math.floor(performance.now())))
      const committed = await runtime.flush()
      await runtime.close()
      const status = await stat(firstPath)
      expect(status.mode & 0o777).toBe(0o600)
      expect([...new Uint8Array(await readFile(firstPath))]).toEqual(
        [...committed.canonicalBytes],
      )

      await expect(
        createWorkspaceSearchMigrationRehearsalRateRuntime(
          createRuntimeInput(firstPath),
        ),
      ).rejects.toMatchObject({ code: 'FILE_BOUNDARY_FAILED' })

      const linkPath = join(directory, 'previous-link.ndjson')
      await symlink(firstPath, linkPath)
      await expect(createWorkspaceSearchMigrationRehearsalRateRuntime({
        ...createRuntimeInput(join(directory, 'segment-1.ndjson')),
        previousSegmentFile: linkPath,
      })).rejects.toMatchObject({ code: 'FILE_BOUNDARY_FAILED' })
    } finally {
      await rm(directory, { recursive: true, force: true })
    }
  })
})
