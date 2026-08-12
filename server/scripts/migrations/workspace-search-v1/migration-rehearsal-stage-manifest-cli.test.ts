import {
  chmod,
  mkdtemp,
  readFile,
  rm,
  symlink,
  writeFile,
} from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import {
  afterEach,
  describe,
  expect,
  test,
} from 'bun:test'
import {
  CROSS_DOMAIN_INTEGRITY_IMMUTABLE_RESOURCE_IDENTITY_SCHEME,
  CROSS_DOMAIN_INTEGRITY_RESOURCE_TARGETS,
} from '../../data-integrity/cross-domain-integrity'
import {
  createMigrationDigest,
  serializeCanonicalJson,
} from './migration-contract'
import type {
  WorkspaceSearchMigrationRehearsalScenarioName,
} from './migration-rehearsal-evidence'
import {
  readWorkspaceSearchMigrationRehearsalPrivateInputFile,
} from './migration-rehearsal-private-input'
import {
  createWorkspaceSearchMigrationRehearsalProductionAccountDigest,
  createWorkspaceSearchMigrationRehearsalPermit,
  WORKSPACE_SEARCH_MIGRATION_REHEARSAL_APPROVAL,
  WORKSPACE_SEARCH_MIGRATION_REHEARSAL_PERMIT_KIND,
  WORKSPACE_SEARCH_MIGRATION_REHEARSAL_PERMIT_VERSION,
  WORKSPACE_SEARCH_MIGRATION_REHEARSAL_STAGE,
  type WorkspaceSearchMigrationRehearsalPermit,
} from './migration-rehearsal-permit'
import {
  readWorkspaceSearchMigrationRehearsalPermitSigningKey,
  writeWorkspaceSearchMigrationRehearsalPermitFileExclusive,
  type WorkspaceSearchMigrationRehearsalPermitFileWriteOutcome,
} from './migration-rehearsal-permit-cli'
import {
  parseWorkspaceSearchMigrationRehearsalStageManifestDocument,
  WORKSPACE_SEARCH_MIGRATION_REHEARSAL_STAGE_MANIFEST_KIND,
  WORKSPACE_SEARCH_MIGRATION_REHEARSAL_STAGE_MANIFEST_VERSION,
  type WorkspaceSearchMigrationRehearsalStageCommand,
  type WorkspaceSearchMigrationRehearsalStageManifestClaims,
  type WorkspaceSearchMigrationRehearsalStageManifestEntry,
  type WorkspaceSearchMigrationRehearsalStageOutcome,
} from './migration-rehearsal-stage-manifest'
import {
  parseWorkspaceSearchMigrationRehearsalStageManifestCliArguments,
  runWorkspaceSearchMigrationRehearsalStageManifestCli,
  WORKSPACE_SEARCH_MIGRATION_REHEARSAL_STAGE_MANIFEST_CLI_RESULT_KIND,
  WORKSPACE_SEARCH_MIGRATION_REHEARSAL_STAGE_MANIFEST_ISSUANCE_APPROVAL,
  type WorkspaceSearchMigrationRehearsalStageManifestCliDependencies,
} from './migration-rehearsal-stage-manifest-cli'
import {
  deriveWorkspaceSearchMigrationRehearsalKeys,
  zeroizeWorkspaceSearchMigrationRehearsalKey,
} from './migration-rehearsal-key-derivation'

/** Exact reviewed implementation commit used by focused CLI fixtures. */
const commit = 'a'.repeat(40)

/** Exact requested-resource binding used by focused CLI fixtures. */
const requestedResourcesBinding = digest('requested-resources')

/** Exact authenticated #163 physical identity binding. */
const integrityResourceIdentityDigest = digest('integrity-resource-identity')

/** Exact canonical keyed physical-resource vector used by focused fixtures. */
const integrityResourceIdentities = Object.freeze(
  CROSS_DOMAIN_INTEGRITY_RESOURCE_TARGETS.map((target, index) =>
    Object.freeze({
      target,
      identityDigest: digest(`integrity-resource:${index}:${target}`),
    })
  ),
)

/** One concise reviewed stage before global ordinals are assigned. */
type FixtureStage = {
  /** Exact existing control command. */
  readonly command: WorkspaceSearchMigrationRehearsalStageCommand
  /** Expected authenticated process result. */
  readonly outcome: WorkspaceSearchMigrationRehearsalStageOutcome
  /** Whether the entry carries the scenario's reviewed fault plan. */
  readonly fault: boolean
  /** One-based logical process attempt. */
  readonly attemptOrdinal: number
}

/** Optional finite effects supplied to one in-memory CLI harness. */
type HarnessOptions = {
  /** Optional trusted issuance clock used by permit-active checks. */
  readonly clock?: () => Date
  /** Exact canonical or intentionally malformed claims bytes. */
  readonly claimsBytes: Uint8Array
  /** Exact canonical or intentionally malformed permit bytes. */
  readonly permitBytes: Uint8Array
  /** Reader-owned key buffer whose zeroization is observable. */
  readonly readerKey: Uint8Array
  /** Optional durable-writer result. */
  readonly writeOutcome?:
    WorkspaceSearchMigrationRehearsalPermitFileWriteOutcome
  /** Whether the durable writer rejects. */
  readonly writeFailure?: boolean
}

/** Mutable observations retained outside one captured dependency object. */
type HarnessObservations = {
  /** Exact secret-free success lines. */
  stdoutLines: string[]
  /** Exact stable failure lines. */
  stderrLines: string[]
  /** Exact canonical manifest bytes offered to the durable writer. */
  outputBytes?: Uint8Array
  /** Number of output-writer calls. */
  writeCount: number
}

/** Temporary directories removed after each filesystem boundary test. */
const temporaryDirectories: string[] = []

afterEach(async () => {
  for (const directory of temporaryDirectories.splice(0)) {
    await rm(directory, { force: true, recursive: true })
  }
})

/** Creates one deterministic conventional digest. */
function digest(label: string): string {
  return createMigrationDigest({ label })
}

/** Creates one structurally strict clean ordinal-zero root projection. */
function createIntegrityAttestationRoot(
  productionAccount: string,
): WorkspaceSearchMigrationRehearsalPermit[
  'integrityAttestationRoot'
] {
  const policyVersion = digest('policy')
  const aggregate = Object.freeze({
    version: 2,
    policyVersion,
    attemptCount: 12,
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
    maximumInFlight: 1,
  })
  return Object.freeze({
    kind:
      'mukuroji-workspace-search-migration-rehearsal-integrity-attestation-root-projection',
    version: 1,
    deploymentTargetId: 'manifest-cli-fixture',
    productionAccountDigest:
      createWorkspaceSearchMigrationRehearsalProductionAccountDigest(
        productionAccount,
      ),
    configurationBindingDigest: digest('configuration'),
    policyVersion,
    attestation: Object.freeze({
      contentMac: digest('attestation-content'),
      byteLength: 1_024,
    }),
    segment: Object.freeze({
      authenticationKeyFingerprint: digest('rate-key-fingerprint'),
      segmentLocatorDigest: digest('root-segment-locator'),
      segmentOrdinal: 0,
      firstEventSequence: 1,
      eventCount: 24,
      firstCommittedEventSequence: 1,
      lastCommittedEventSequence: 24,
      terminalRecordMac: digest('root-terminal-record'),
      segmentDigest: digest('root-segment'),
    }),
    interval: Object.freeze({
      kind:
        'mukuroji-workspace-search-migration-rehearsal-integrity-rate-interval',
      version: 1,
      phase: 'integrity-check',
      tablePassCount: 1,
      describeTableCallCount: 6,
      firstAttemptSequence: 7,
      lastAttemptSequence: 12,
      attemptSequences: Object.freeze([7, 8, 9, 10, 11, 12]),
      firstEventSequence: 13,
      lastEventSequence: 24,
      eventSequences: Object.freeze(
        Array.from({ length: 12 }, (_value, index) => index + 13),
      ),
      cadenceWaitCount: 0,
      cadenceWaitMilliseconds: 0,
      startedAt: '2026-08-01T23:59:59.700Z',
      completedAt: '2026-08-01T23:59:59.900Z',
    }),
    aggregate,
    aggregateDigest: createMigrationDigest(aggregate),
    tableOrderBindingMac: digest('table-order'),
    rootMac: digest('root'),
    startedAt: '2026-08-01T23:59:59.000Z',
    completedAt: '2026-08-01T23:59:59.999Z',
  })
}

/** Encodes one value as exact canonical UTF-8 JSON bytes. */
function canonicalBytes(value: unknown): Uint8Array {
  return new TextEncoder().encode(serializeCanonicalJson(value))
}

/** Returns the exact reviewed stage shape for one required scenario. */
function fixtureStages(
  scenario: WorkspaceSearchMigrationRehearsalScenarioName,
): readonly FixtureStage[] {
  const completed = (
    command: WorkspaceSearchMigrationRehearsalStageCommand,
    attemptOrdinal: number,
  ): FixtureStage => ({
    command,
    outcome: 'completed',
    fault: false,
    attemptOrdinal,
  })
  if (scenario === 'happy-path-verified') {
    return [
      completed('close-replan', 1),
      completed('apply', 1),
      completed('verify', 1),
      completed('release', 1),
    ]
  }
  if (scenario === 'complete-apply-rollback') {
    return [
      completed('close-replan', 1),
      completed('apply', 1),
      completed('rollback-complete', 1),
      completed('release', 1),
    ]
  }
  if (scenario === 'partial-apply-rollback') {
    return [
      completed('close-replan', 1),
      {
        command: 'apply',
        outcome: 'fault-reached',
        fault: true,
        attemptOrdinal: 1,
      },
      {
        command: 'rollback-partial',
        outcome: 'takeover-completed',
        fault: false,
        attemptOrdinal: 2,
      },
      completed('release', 2),
    ]
  }
  if (scenario === 'transaction-response-loss') {
    return [
      {
        command: 'close-replan',
        outcome: 'response-loss-reconciled',
        fault: true,
        attemptOrdinal: 1,
      },
      completed('apply', 1),
      completed('verify', 1),
      completed('release', 1),
    ]
  }
  const faultCommand =
    scenario === 'artifact-before-checkpoint-kill' ||
      scenario === 'lease-expiry-takeover'
      ? 'close-replan'
      : 'apply'
  const stages: FixtureStage[] = []
  if (faultCommand === 'apply') stages.push(completed('close-replan', 1))
  stages.push({
    command: faultCommand,
    outcome: 'fault-reached',
    fault: true,
    attemptOrdinal: 1,
  })
  stages.push({
    command: faultCommand,
    outcome: 'takeover-completed',
    fault: false,
    attemptOrdinal: 2,
  })
  if (faultCommand === 'close-replan') {
    stages.push(completed('apply', 2))
  }
  stages.push(completed('verify', 2), completed('release', 2))
  return stages
}

/** Creates every globally ordered reviewed manifest entry. */
function createManifestEntries():
  readonly WorkspaceSearchMigrationRehearsalStageManifestEntry[] {
  const scenarios:
    readonly WorkspaceSearchMigrationRehearsalScenarioName[] = [
      'happy-path-verified',
      'cursor-before-commit-kill',
      'cursor-after-commit-kill',
      'artifact-before-checkpoint-kill',
      'transaction-response-loss',
      'lease-expiry-takeover',
      'partial-apply-rollback',
      'complete-apply-rollback',
    ]
  const entries: WorkspaceSearchMigrationRehearsalStageManifestEntry[] = []
  for (const scenario of scenarios) {
    const stages = fixtureStages(scenario)
    for (let index = 0; index < stages.length; index += 1) {
      const stage = stages[index]
      if (stage === undefined) throw new Error('Fixture stage is missing.')
      entries.push(Object.freeze({
        ordinal: entries.length + 1,
        scenario,
        scenarioStageOrdinal: index + 1,
        command: stage.command,
        controlArgumentsDigest: digest(
          `control:${scenario}:${index + 1}`,
        ),
        attemptOrdinal: stage.attemptOrdinal,
        faultPlanDigest: stage.fault
          ? digest(`fault:${scenario}`)
          : null,
        expectedOutcome: stage.outcome,
      }))
    }
  }
  return Object.freeze(entries)
}

/** Creates one authenticated short-lived permit and its retained key. */
function createPermit(): {
  /** Caller-owned master key supplied to the issuance CLI. */
  readonly key: Uint8Array
  /** Derived runtime key that authenticates the permit and manifest. */
  readonly runtimeKey: Uint8Array
  /** Exact authenticated permit. */
  readonly permit: WorkspaceSearchMigrationRehearsalPermit
} {
  const key = Uint8Array.from({ length: 32 }, (_value, index) => index + 1)
  const derivedKeys = deriveWorkspaceSearchMigrationRehearsalKeys(key)
  const productionAccount = '222222222222'
  const integrityAttestationRoot =
    createIntegrityAttestationRoot(productionAccount)
  const permit = createWorkspaceSearchMigrationRehearsalPermit({
    claims: {
      kind: WORKSPACE_SEARCH_MIGRATION_REHEARSAL_PERMIT_KIND,
      permitVersion: WORKSPACE_SEARCH_MIGRATION_REHEARSAL_PERMIT_VERSION,
      stage: WORKSPACE_SEARCH_MIGRATION_REHEARSAL_STAGE,
      approval: WORKSPACE_SEARCH_MIGRATION_REHEARSAL_APPROVAL,
      account: '111111111111',
      productionAccount,
      region: 'ap-northeast-1',
      callerArn:
        'arn:aws:sts::111111111111:assumed-role/Rehearsal/manifest-test',
      commit,
      deploymentTargetId: integrityAttestationRoot.deploymentTargetId,
      requestedResourcesBinding,
      integrityResourceIdentityScheme:
        CROSS_DOMAIN_INTEGRITY_IMMUTABLE_RESOURCE_IDENTITY_SCHEME,
      integrityResourceIdentities,
      integrityResourceIdentityDigest,
      evidenceKeyDigest: derivedKeys.runtimeKeyDigest,
      publicationKeyDigest: derivedKeys.publicationKeyDigest,
      deploymentTrustRootDigest: digest('deployment-trust-root'),
      configurationBindingDigest:
        integrityAttestationRoot.configurationBindingDigest,
      policyVersion: integrityAttestationRoot.policyVersion,
      integrityAttestationRoot,
      issuedAt: '2026-08-02T00:00:00.000Z',
      expiresAt: '2026-08-02T01:00:00.000Z',
    },
    signingKey: derivedKeys.runtimeKey,
  })
  zeroizeWorkspaceSearchMigrationRehearsalKey(derivedKeys.publicationKey)
  return Object.freeze({ key, runtimeKey: derivedKeys.runtimeKey, permit })
}

/** Creates exact reviewed claims bound to one authenticated permit. */
function createManifestClaims(
  permit: WorkspaceSearchMigrationRehearsalPermit,
): WorkspaceSearchMigrationRehearsalStageManifestClaims {
  return Object.freeze({
    kind: WORKSPACE_SEARCH_MIGRATION_REHEARSAL_STAGE_MANIFEST_KIND,
    manifestVersion:
      WORKSPACE_SEARCH_MIGRATION_REHEARSAL_STAGE_MANIFEST_VERSION,
    stage: WORKSPACE_SEARCH_MIGRATION_REHEARSAL_STAGE,
    commit,
    permitDigest: createMigrationDigest(permit),
    evidenceKeyDigest: permit.evidenceKeyDigest,
    publicationKeyDigest: permit.publicationKeyDigest,
    deploymentTrustRootDigest: permit.deploymentTrustRootDigest,
    requestedResourcesBinding,
    integrityResourceIdentityScheme:
      permit.integrityResourceIdentityScheme,
    integrityResourceIdentities: permit.integrityResourceIdentities,
    integrityResourceIdentityDigest,
    integrityAttestationRoot: permit.integrityAttestationRoot,
    configurationBindingDigest: permit.configurationBindingDigest,
    policyVersion: permit.policyVersion,
    reviewedAt: '2026-08-02T00:30:00.000Z',
    entries: createManifestEntries(),
  })
}

/** Creates exact ordered command arguments with no ambient defaults. */
function createArguments(
  outputFile = 'manifest.json',
): readonly string[] {
  return Object.freeze([
    '--claims-file',
    'claims.json',
    '--permit-file',
    'permit.json',
    '--signing-key-file',
    'key.bin',
    '--output-file',
    outputFile,
    '--approval',
    WORKSPACE_SEARCH_MIGRATION_REHEARSAL_STAGE_MANIFEST_ISSUANCE_APPROVAL,
  ])
}

/** Creates one finite in-memory CLI boundary and mutable observations. */
function createHarness(options: HarnessOptions): {
  /** Captured finite CLI effects. */
  readonly dependencies:
    WorkspaceSearchMigrationRehearsalStageManifestCliDependencies
  /** Mutable effects produced by one run. */
  readonly observations: HarnessObservations
} {
  const observations: HarnessObservations = {
    stdoutLines: [],
    stderrLines: [],
    writeCount: 0,
  }
  const dependencies:
    WorkspaceSearchMigrationRehearsalStageManifestCliDependencies =
      Object.freeze({
        clock: options.clock ??
          (() => new Date('2026-08-02T00:45:00.000Z')),
        readInputFile: async (path, maximumBytes): Promise<Uint8Array> => {
          const selected = path === 'claims.json'
            ? options.claimsBytes
            : path === 'permit.json'
            ? options.permitBytes
            : undefined
          if (
            selected === undefined ||
            selected.byteLength > maximumBytes
          ) {
            throw new Error('INPUT_FAILED')
          }
          return selected.slice()
        },
        readSigningKeyFile: async (): Promise<Uint8Array> =>
          options.readerKey,
        writeManifestFileExclusive: async (
          _outputPath,
          manifestBytes,
        ): Promise<WorkspaceSearchMigrationRehearsalPermitFileWriteOutcome> => {
          observations.writeCount += 1
          if (options.writeFailure === true) {
            throw new Error('WRITE_FAILED')
          }
          observations.outputBytes = manifestBytes.slice()
          return options.writeOutcome ?? 'created'
        },
        writeStdoutLine: (line): void => {
          observations.stdoutLines.push(line)
        },
        writeStderrLine: (line): void => {
          observations.stderrLines.push(line)
        },
      })
  return Object.freeze({ dependencies, observations })
}

/** Requires one harness output that should exist after successful issuance. */
function requireOutputBytes(
  observations: HarnessObservations,
): Uint8Array {
  const outputBytes = observations.outputBytes
  if (outputBytes === undefined) throw new Error('Manifest output is missing.')
  return outputBytes
}

/** Requires every byte in one reader-owned key to have been zeroized. */
function expectZeroized(key: Uint8Array): void {
  expect(Array.from(key)).toEqual(
    Array.from({ length: key.byteLength }, () => 0),
  )
}

describe('workspace search migration rehearsal stage manifest CLI', () => {
  test('parses only the exact ordered acknowledged command', () => {
    expect(
      parseWorkspaceSearchMigrationRehearsalStageManifestCliArguments(
        createArguments(),
      ),
    ).toEqual({
      claimsFile: 'claims.json',
      permitFile: 'permit.json',
      signingKeyFile: 'key.bin',
      outputFile: 'manifest.json',
      approval:
        WORKSPACE_SEARCH_MIGRATION_REHEARSAL_STAGE_MANIFEST_ISSUANCE_APPROVAL,
    })
    const reordered = [...createArguments()]
    const firstFlag = reordered[0]
    const secondFlag = reordered[2]
    if (firstFlag === undefined || secondFlag === undefined) {
      throw new Error('Argument fixture is incomplete.')
    }
    reordered[0] = secondFlag
    reordered[2] = firstFlag
    expect(() =>
      parseWorkspaceSearchMigrationRehearsalStageManifestCliArguments(
        reordered,
      )
    ).toThrow('INVALID_USAGE')
  })

  test('authenticates canonical inputs and writes one canonical manifest', async () => {
    const { key, permit, runtimeKey } = createPermit()
    const claims = createManifestClaims(permit)
    const readerKey = key.slice()
    const harness = createHarness({
      claimsBytes: canonicalBytes(claims),
      permitBytes: canonicalBytes(permit),
      readerKey,
    })

    const exitCode =
      await runWorkspaceSearchMigrationRehearsalStageManifestCli(
        createArguments(),
        harness.dependencies,
      )

    expect(exitCode).toBe(0)
    expect(harness.observations.stderrLines).toEqual([])
    expect(harness.observations.writeCount).toBe(1)
    const outputBytes = requireOutputBytes(harness.observations)
    const manifest =
      parseWorkspaceSearchMigrationRehearsalStageManifestDocument(
        outputBytes,
        runtimeKey,
      )
    expect(manifest).toMatchObject(claims)
    expect(harness.observations.stdoutLines).toEqual([
      serializeCanonicalJson({
        entryCount: claims.entries.length,
        kind:
          WORKSPACE_SEARCH_MIGRATION_REHEARSAL_STAGE_MANIFEST_CLI_RESULT_KIND,
        manifestDigest: createMigrationDigest(manifest),
      }),
    ])
    expectZeroized(readerKey)
  })

  test('rejects non-canonical claims and permit documents', async () => {
    const { key, permit } = createPermit()
    const claims = createManifestClaims(permit)
    const candidates = [
      {
        claimsBytes: new TextEncoder().encode(
          JSON.stringify(claims, undefined, 2),
        ),
        permitBytes: canonicalBytes(permit),
        expectedCode: 'INVALID_CLAIMS_FILE',
      },
      {
        claimsBytes: canonicalBytes(claims),
        permitBytes: new TextEncoder().encode(
          `${serializeCanonicalJson(permit)}\n`,
        ),
        expectedCode: 'INVALID_PERMIT_FILE',
      },
    ]
    for (const candidate of candidates) {
      const readerKey = key.slice()
      const harness = createHarness({
        claimsBytes: candidate.claimsBytes,
        permitBytes: candidate.permitBytes,
        readerKey,
      })
      const exitCode =
        await runWorkspaceSearchMigrationRehearsalStageManifestCli(
          createArguments(),
          harness.dependencies,
        )
      expect(exitCode).toBe(2)
      expect(harness.observations.stdoutLines).toEqual([])
      expect(harness.observations.writeCount).toBe(0)
      expect(harness.observations.stderrLines).toEqual([
        serializeCanonicalJson({
          code: candidate.expectedCode,
          kind:
            WORKSPACE_SEARCH_MIGRATION_REHEARSAL_STAGE_MANIFEST_CLI_RESULT_KIND,
          status: 'error',
        }),
      ])
    }
  })

  test('rejects a canonical permit with a tampered HMAC and zeroizes the key', async () => {
    const { key, permit } = createPermit()
    const claims = createManifestClaims(permit)
    const tamperedPermit = {
      ...permit,
      permitMac: permit.permitMac === '0'.repeat(64)
        ? '1'.repeat(64)
        : '0'.repeat(64),
    }
    const readerKey = key.slice()
    const harness = createHarness({
      claimsBytes: canonicalBytes(claims),
      permitBytes: canonicalBytes(tamperedPermit),
      readerKey,
    })

    const exitCode =
      await runWorkspaceSearchMigrationRehearsalStageManifestCli(
        createArguments(),
        harness.dependencies,
      )

    expect(exitCode).toBe(2)
    expect(harness.observations.writeCount).toBe(0)
    expect(harness.observations.stderrLines[0]).toContain(
      'INVALID_PERMIT_FILE',
    )
    expectZeroized(readerKey)
  })

  test('rejects the wrong same-length key and zeroizes it', async () => {
    const { permit } = createPermit()
    const claims = createManifestClaims(permit)
    const wrongKey = new Uint8Array(32).fill(99)
    const harness = createHarness({
      claimsBytes: canonicalBytes(claims),
      permitBytes: canonicalBytes(permit),
      readerKey: wrongKey,
    })

    const exitCode =
      await runWorkspaceSearchMigrationRehearsalStageManifestCli(
        createArguments(),
        harness.dependencies,
      )

    expect(exitCode).toBe(2)
    expect(harness.observations.stderrLines[0]).toContain(
      'INVALID_SIGNING_KEY',
    )
    expectZeroized(wrongKey)
  })

  test('rejects every manifest-to-permit binding mismatch', async () => {
    const { key, permit } = createPermit()
    const claims = createManifestClaims(permit)
    const mismatchedClaims = [
      { ...claims, commit: 'b'.repeat(40) },
      { ...claims, permitDigest: digest('different-permit') },
      {
        ...claims,
        requestedResourcesBinding: digest('different-resources'),
      },
      {
        ...claims,
        integrityResourceIdentityDigest: digest('different-integrity'),
      },
      {
        ...claims,
        integrityResourceIdentities:
          claims.integrityResourceIdentities.map((identity, index) =>
            index === 0
              ? { ...identity, identityDigest: digest('different-vector') }
              : identity
          ),
      },
      {
        ...claims,
        integrityAttestationRoot: {
          ...claims.integrityAttestationRoot,
          rootMac: digest('different-root'),
        },
      },
      { ...claims, reviewedAt: permit.expiresAt },
    ]
    for (const candidate of mismatchedClaims) {
      const readerKey = key.slice()
      const harness = createHarness({
        claimsBytes: canonicalBytes(candidate),
        permitBytes: canonicalBytes(permit),
        readerKey,
      })
      const exitCode =
        await runWorkspaceSearchMigrationRehearsalStageManifestCli(
          createArguments(),
          harness.dependencies,
        )
      expect(exitCode).toBe(2)
      expect(harness.observations.writeCount).toBe(0)
      expectZeroized(readerKey)
    }
    const beforeRootCompletionKey = key.slice()
    const beforeRootCompletion = createHarness({
      claimsBytes: canonicalBytes({
        ...claims,
        reviewedAt: '2026-08-01T23:59:59.998Z',
      }),
      permitBytes: canonicalBytes(permit),
      readerKey: beforeRootCompletionKey,
    })
    expect(await runWorkspaceSearchMigrationRehearsalStageManifestCli(
      createArguments(),
      beforeRootCompletion.dependencies,
    )).toBe(2)
    expect(beforeRootCompletion.observations.writeCount).toBe(0)
    expect(beforeRootCompletion.observations.stderrLines[0]).toContain(
      'INVALID_CLAIMS_FILE',
    )
    expect(Array.from(beforeRootCompletionKey)).toEqual(Array.from(key))
    const invalidStageHarness = createHarness({
      claimsBytes: canonicalBytes({ ...claims, stage: 'production' }),
      permitBytes: canonicalBytes(permit),
      readerKey: key.slice(),
    })
    expect(await runWorkspaceSearchMigrationRehearsalStageManifestCli(
      createArguments(),
      invalidStageHarness.dependencies,
    )).toBe(2)
    expect(invalidStageHarness.observations.stderrLines[0]).toContain(
      'INVALID_CLAIMS_FILE',
    )
  })

  test('requires the permit to remain active through publication', async () => {
    const { key, permit } = createPermit()
    const claims = createManifestClaims(permit)
    let clockReadCount = 0
    const readerKey = key.slice()
    const harness = createHarness({
      claimsBytes: canonicalBytes(claims),
      permitBytes: canonicalBytes(permit),
      readerKey,
      clock: (): Date => {
        clockReadCount += 1
        return new Date(
          clockReadCount === 1
            ? '2026-08-02T00:45:00.000Z'
            : '2026-08-02T01:00:00.000Z',
        )
      },
    })

    expect(
      await runWorkspaceSearchMigrationRehearsalStageManifestCli(
        createArguments(),
        harness.dependencies,
      ),
    ).toBe(2)
    expect(harness.observations.writeCount).toBe(0)
    expect(harness.observations.stderrLines).toEqual([
      serializeCanonicalJson({
        code: 'INVALID_PERMIT_FILE',
        kind:
          WORKSPACE_SEARCH_MIGRATION_REHEARSAL_STAGE_MANIFEST_CLI_RESULT_KIND,
        status: 'error',
      }),
    ])
    expectZeroized(readerKey)
  })

  test('zeroizes the reader-owned key when durable publication fails', async () => {
    const { key, permit } = createPermit()
    const readerKey = key.slice()
    const harness = createHarness({
      claimsBytes: canonicalBytes(createManifestClaims(permit)),
      permitBytes: canonicalBytes(permit),
      readerKey,
      writeFailure: true,
    })

    expect(await runWorkspaceSearchMigrationRehearsalStageManifestCli(
      createArguments(),
      harness.dependencies,
    )).toBe(1)
    expect(harness.observations.stderrLines[0]).toContain(
      'OUTPUT_FILE_WRITE_FAILED',
    )
    expectZeroized(readerKey)
  })

  test('treats a symlink output as a no-replace collision', async () => {
    const directory = await mkdtemp(
      join(tmpdir(), 'mukuroji-stage-manifest-cli-'),
    )
    temporaryDirectories.push(directory)
    const { key, permit } = createPermit()
    const claimsPath = join(directory, 'claims.json')
    const permitPath = join(directory, 'permit.json')
    const keyPath = join(directory, 'key.bin')
    const victimPath = join(directory, 'victim.json')
    const outputPath = join(directory, 'manifest.json')
    await writeFile(claimsPath, canonicalBytes(createManifestClaims(permit)))
    await writeFile(permitPath, canonicalBytes(permit))
    await writeFile(keyPath, key)
    await chmod(keyPath, 0o600)
    await chmod(claimsPath, 0o600)
    await chmod(permitPath, 0o600)
    await writeFile(victimPath, 'unchanged')
    await symlink(victimPath, outputPath)
    const stdoutLines: string[] = []
    const stderrLines: string[] = []
    const dependencies:
      WorkspaceSearchMigrationRehearsalStageManifestCliDependencies =
        Object.freeze({
          clock: () => new Date('2026-08-02T00:45:00.000Z'),
          readInputFile:
            readWorkspaceSearchMigrationRehearsalPrivateInputFile,
          readSigningKeyFile:
            readWorkspaceSearchMigrationRehearsalPermitSigningKey,
          writeManifestFileExclusive:
            writeWorkspaceSearchMigrationRehearsalPermitFileExclusive,
          writeStdoutLine: (line): void => {
            stdoutLines.push(line)
          },
          writeStderrLine: (line): void => {
            stderrLines.push(line)
          },
        })

    const exitCode =
      await runWorkspaceSearchMigrationRehearsalStageManifestCli([
        '--claims-file',
        claimsPath,
        '--permit-file',
        permitPath,
        '--signing-key-file',
        keyPath,
        '--output-file',
        outputPath,
        '--approval',
        WORKSPACE_SEARCH_MIGRATION_REHEARSAL_STAGE_MANIFEST_ISSUANCE_APPROVAL,
      ], dependencies)

    expect(exitCode).toBe(1)
    expect(stdoutLines).toEqual([])
    expect(stderrLines[0]).toContain('OUTPUT_FILE_EXISTS')
    expect(await readFile(victimPath, 'utf8')).toBe('unchanged')
  })
})
