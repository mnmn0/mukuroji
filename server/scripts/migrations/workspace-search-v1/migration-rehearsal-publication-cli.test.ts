import { describe, expect, test } from 'bun:test'
import { createHash } from 'node:crypto'
import {
  chmod,
  link,
  mkdtemp,
  rm,
  symlink,
  writeFile,
} from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import {
  createMigrationDigest,
  serializeCanonicalJson,
} from './migration-contract'
import {
  WORKSPACE_SEARCH_MIGRATION_DESCRIBE_TABLE_PAGE_BASELINE_ATTEMPTS,
} from './migration-describe-table-rate-budget'
import {
  deriveWorkspaceSearchMigrationRehearsalKeys,
  WORKSPACE_SEARCH_MIGRATION_REHEARSAL_MASTER_KEY_BYTES,
  zeroizeWorkspaceSearchMigrationRehearsalKey,
} from './migration-rehearsal-key-derivation'
import {
  WORKSPACE_SEARCH_MIGRATION_REHEARSAL_RECONCILIATION_AUDIT_MAX_BYTES,
} from './migration-rehearsal-reconciliation-audit'
import {
  createWorkspaceSearchMigrationRehearsalRateAuthenticationKeyFingerprint,
} from './migration-rehearsal-rate-evidence'
import {
  parseWorkspaceSearchMigrationRehearsalPublicationCliArguments,
  readWorkspaceSearchMigrationRehearsalRestrictedInputFile,
  runWorkspaceSearchMigrationRehearsalPublicationCli,
  WORKSPACE_SEARCH_MIGRATION_REHEARSAL_ALARM_ARTIFACT_MAX_BYTES,
  WORKSPACE_SEARCH_MIGRATION_REHEARSAL_PUBLICATION_APPROVAL,
  WorkspaceSearchMigrationRehearsalPublicationCliError,
  type WorkspaceSearchMigrationRehearsalPublicationCliDependencies,
} from './migration-rehearsal-publication-cli'
import type {
  WorkspaceSearchMigrationRehearsalEvidenceSessionBinding,
} from './migration-rehearsal-evidence-aws'
import {
  readWorkspaceSearchMigrationRehearsalFinalizedStageChainReconciliationContexts,
} from './migration-rehearsal-stage-receipt'
import {
  assembleWorkspaceSearchMigrationRehearsalAuthenticatedSuite,
  consumeWorkspaceSearchMigrationRehearsalFinalizedSuitePreparation,
} from './migration-rehearsal-suite-finalizer'
import {
  createAuthenticWorkspaceSearchMigrationRehearsalAssemblerFixture,
  type AuthenticWorkspaceSearchMigrationRehearsalAssemblerFixture,
} from './migration-rehearsal-suite-finalizer.test-fixture'

const configurationHash = '1'.repeat(64)

/** Deterministic main rehearsal master kept distinct from alarm authority. */
const mainRehearsalMasterKey = new Uint8Array(32).fill(0x37)

/** Deterministic alarm-purpose master matching the authentic alarm fixture. */
const alarmRehearsalMasterKey = new Uint8Array(32).fill(7)

/** Derived digest-only permit bindings for the fixture master key. */
const publicationPermitKeyDigests = (() => {
  const keys = deriveWorkspaceSearchMigrationRehearsalKeys(
    mainRehearsalMasterKey,
  )
  try {
    return Object.freeze({
      evidenceKeyDigest: keys.runtimeKeyDigest,
      publicationKeyDigest: keys.publicationKeyDigest,
    })
  } finally {
    zeroizeWorkspaceSearchMigrationRehearsalKey(keys.runtimeKey)
    zeroizeWorkspaceSearchMigrationRehearsalKey(keys.publicationKey)
  }
})()

/** Derived digest-only bindings for the alarm-purpose fixture master key. */
const alarmAuthenticationKeyDigests = (() => {
  const keys = deriveWorkspaceSearchMigrationRehearsalKeys(
    alarmRehearsalMasterKey,
  )
  try {
    return Object.freeze({
      runtimeKeyDigest: keys.runtimeKeyDigest,
      publicationKeyDigest: keys.publicationKeyDigest,
    })
  } finally {
    zeroizeWorkspaceSearchMigrationRehearsalKey(keys.runtimeKey)
    zeroizeWorkspaceSearchMigrationRehearsalKey(keys.publicationKey)
  }
})()

/** Canonical scenario-ordered reconciliation input paths. */
const reconciliationAuditPaths: readonly string[] = Object.freeze([
  '/operator/reconciliation-happy-path-verified.json',
  '/operator/reconciliation-cursor-before-commit-kill.json',
  '/operator/reconciliation-cursor-after-commit-kill.json',
  '/operator/reconciliation-artifact-before-checkpoint-kill.json',
  '/operator/reconciliation-transaction-response-loss.json',
  '/operator/reconciliation-lease-expiry-takeover.json',
  '/operator/reconciliation-partial-apply-rollback.json',
  '/operator/reconciliation-complete-apply-rollback.json',
])

/** Canonical valid reviewed rate policy used by orchestration tests. */
const ratePolicyBytes = new TextEncoder().encode(serializeCanonicalJson({
  schemaVersion: 1,
  maximumAttemptsPerWindow: 400,
  maximumAttemptsPerLifecycle: 400,
  checkpointPageAttemptCapacity:
    WORKSPACE_SEARCH_MIGRATION_DESCRIBE_TABLE_PAGE_BASELINE_ATTEMPTS,
  windowMilliseconds: 1_000,
  minimumAttemptIntervalMilliseconds: 20,
  minimumPageIntervalMilliseconds: 1_000,
  maximumAdmissionWaitMilliseconds: 30_000,
  throttleBackoffInitialMilliseconds: 100,
  throttleBackoffMaximumMilliseconds: 2_000,
}))

/** Explicit resources accepted by the existing strict measure parser. */
const measureResourceArguments: readonly string[] = [
  '--account',
  '123456789012',
  '--region',
  'ap-northeast-1',
  '--profile',
  'migration-operator',
  '--commit',
  'a'.repeat(40),
  '--project-directory-table',
  'project-directory-table',
  '--work-items-table',
  'work-items-table',
  '--collaboration-table',
  'collaboration-table',
  '--documents-table',
  'documents-table',
  '--workspace-search-table',
  'workspace-search-table',
  '--migration-state-table',
  'migration-state-table',
  '--journal-bucket',
  'mukuroji-migration-journal',
  '--journal-key-arn',
  'arn:aws:kms:ap-northeast-1:123456789012:key/12345678-1234-1234-1234-123456789012',
]

/** Builds one exact final-publication command with a real measure suffix. */
function createPublicationArguments(
  expectedConfigurationHash: string = configurationHash,
): string[] {
  return [
    '--rehearsal-alarm-artifact-file',
    '/operator/rehearsal-alarms.json',
    '--rehearsal-permit-file',
    '/operator/rehearsal-permit.json',
    '--rehearsal-authentication-key-file',
    '/operator/rehearsal-authentication.key',
    '--rehearsal-alarm-authentication-key-file',
    '/operator/rehearsal-alarm-authentication.key',
    '--rehearsal-stage-receipt-manifest-file',
    '/operator/rehearsal-stage-receipts.json',
    '--rehearsal-stage-receipt-file',
    '/operator/rehearsal-stage-receipt-0001.json',
    '--rehearsal-stage-receipt-file',
    '/operator/rehearsal-stage-receipt-0002.json',
    ...reconciliationAuditPaths.flatMap((path) => [
      '--rehearsal-reconciliation-audit-file',
      path,
    ]),
    '--rehearsal-rate-configuration-hash',
    expectedConfigurationHash,
    '--rehearsal-rate-segment-file',
    '/operator/rate-segment-0001.json',
    '--rehearsal-rate-segment-file',
    '/operator/rate-segment-0002.json',
    '--rehearsal-final-rate-segment-file',
    '/operator/rate-segment-final.json',
    '--request-timeout-milliseconds',
    '5000',
    '--approval',
    WORKSPACE_SEARCH_MIGRATION_REHEARSAL_PUBLICATION_APPROVAL,
    '--',
    'measure',
    ...measureResourceArguments,
    '--rate-policy-file',
    '/operator/rate-policy.json',
  ]
}

/** Replaces one required path in a detached publication argument vector. */
function replaceRequiredPublicationPath(
  arguments_: string[],
  currentPath: string,
  replacementPath: string,
): void {
  const index = arguments_.indexOf(currentPath)
  if (index < 0) throw new Error('Expected publication path argument.')
  arguments_[index] = replacementPath
}

/** Requires one operation to fail with the stable publication CLI error. */
async function requirePublicationCliFailure(
  operation: () => unknown | Promise<unknown>,
  code: WorkspaceSearchMigrationRehearsalPublicationCliError['code'],
): Promise<void> {
  try {
    await operation()
  } catch (error: unknown) {
    expect(error).toBeInstanceOf(
      WorkspaceSearchMigrationRehearsalPublicationCliError,
    )
    if (!(error instanceof WorkspaceSearchMigrationRehearsalPublicationCliError)) {
      throw error
    }
    expect(error.code).toBe(code)
    return
  }
  throw new Error('Expected final publication CLI failure.')
}

/** Creates the live session binding authenticated by the fixture permit. */
function createFixtureSessionBinding(
  fixture: AuthenticWorkspaceSearchMigrationRehearsalAssemblerFixture,
): WorkspaceSearchMigrationRehearsalEvidenceSessionBinding {
  return Object.freeze({
    commit: fixture.expected.commit,
    configurationHash: fixture.expected.configurationHash,
    evidenceKeyDigest: publicationPermitKeyDigests.evidenceKeyDigest,
    publicationKeyDigest: publicationPermitKeyDigests.publicationKeyDigest,
    attestation: fixture.expected.attestation,
  })
}

/** Creates a no-AWS harness that retains all final assembler trust boundaries. */
function createFinalPublicationWiringHarness(
  fixture: AuthenticWorkspaceSearchMigrationRehearsalAssemblerFixture,
  sessionBindingOverride?: WorkspaceSearchMigrationRehearsalEvidenceSessionBinding,
) {
  const events: string[] = []
  const returnedBuffers: Uint8Array[] = []
  const transferredKeys: Uint8Array[] = []
  const transferredKeyBindings: string[] = []
  const stdout: string[] = []
  const stderr: string[] = []
  let publicationCount = 0
  let exerciseCount = 0
  /** Retains only the purpose and digest of a transferred secret key. */
  const recordTransferredKey = (
    purpose: string,
    key: Uint8Array,
  ): void => {
    transferredKeys.push(key)
    transferredKeyBindings.push(
      `${purpose}:${createHash('sha256').update(key).digest('hex')}`,
    )
  }
  const dependencies:
    WorkspaceSearchMigrationRehearsalPublicationCliDependencies = {
      readRestrictedFile: async (path, maximumBytes) => {
        events.push(`read:${path}`)
        if (reconciliationAuditPaths.includes(path)) {
          expect(maximumBytes).toBe(
            WORKSPACE_SEARCH_MIGRATION_REHEARSAL_RECONCILIATION_AUDIT_MAX_BYTES,
          )
        }
        if (path.endsWith('rehearsal-alarm-authentication.key')) {
          expect(maximumBytes).toBe(
            WORKSPACE_SEARCH_MIGRATION_REHEARSAL_MASTER_KEY_BYTES,
          )
        }
        let bytes: Uint8Array
        if (path.endsWith('rehearsal-alarms.json')) {
          bytes = new Uint8Array(fixture.input.alarmArtifactBytes)
        } else if (path.endsWith('rehearsal-alarm-authentication.key')) {
          bytes = new Uint8Array(alarmRehearsalMasterKey)
        } else if (path.endsWith('.key')) {
          bytes = new Uint8Array(mainRehearsalMasterKey)
        } else if (path.endsWith('rehearsal-permit.json')) {
          bytes = new TextEncoder().encode(serializeCanonicalJson(
            publicationPermitKeyDigests,
          ))
        } else if (path.endsWith('rate-policy.json')) {
          bytes = new Uint8Array(ratePolicyBytes)
        } else if (reconciliationAuditPaths.includes(path)) {
          bytes = new Uint8Array([
            reconciliationAuditPaths.indexOf(path) + 1,
          ])
        } else {
          bytes = new Uint8Array([Math.max(1, path.length % 251)])
        }
        returnedBuffers.push(bytes)
        return bytes
      },
      deriveStageChain: (input) => {
        events.push('derive-stage-chain')
        recordTransferredKey('stage-runtime', input.verificationKey)
        recordTransferredKey(
          'stage-publication',
          input.publicationVerificationKey,
        )
        expect(input.expectedPermitDigest).toBe(
          createMigrationDigest(publicationPermitKeyDigests),
        )
        return fixture.input.stageChain
      },
      verifyPermit: (input) => {
        events.push('verify-permit')
        recordTransferredKey(
          'permit-preflight-runtime',
          input.verificationKey,
        )
        return publicationPermitKeyDigests
      },
      readStageReconciliationContexts: (value) => {
        events.push('read-reconciliation-contexts')
        return readWorkspaceSearchMigrationRehearsalFinalizedStageChainReconciliationContexts(
          value,
        )
      },
      finalizeReconciliation: (
        input,
        runtimeVerificationKey,
        publicationVerificationKey,
      ) => {
        events.push('finalize-reconciliation')
        recordTransferredKey(
          'reconciliation-runtime',
          runtimeVerificationKey,
        )
        recordTransferredKey(
          'reconciliation-publication',
          publicationVerificationKey,
        )
        expect(input.artifacts).toHaveLength(8)
        expect(input.artifacts.map(
          (artifact) => artifact.artifactBytes[0],
        )).toEqual([1, 2, 3, 4, 5, 6, 7, 8])
        return fixture.input.reconciliation
      },
      createRateRuntime: async (input) => {
        events.push('create-rate-runtime')
        recordTransferredKey('rate-runtime', input.authenticationKey)
        const committedSegment = Object.freeze({
          authenticationKeyFingerprint:
            createWorkspaceSearchMigrationRehearsalRateAuthenticationKeyFingerprint(
              input.authenticationKey,
            ),
          segmentLocatorDigest: '2'.repeat(64),
          segmentOrdinal: 1,
          firstEventSequence: 1,
          eventCount: 0,
          firstCommittedEventSequence: null,
          lastCommittedEventSequence: null,
          terminalRecordMac: '3'.repeat(64),
          segmentDigest: '4'.repeat(64),
          canonicalBytes: new Uint8Array([1]),
        })
        const recorder = Object.freeze({
          record: (): void => {},
          appendForfeitedAttempt: async (): Promise<void> => {},
          appendForfeitedReservation: async (): Promise<void> => {},
          flush: async () => committedSegment,
          close: async (): Promise<void> => {},
        })
        return Object.freeze({
          recorder,
          flush: async () => {
            events.push('flush-rate-runtime')
            return committedSegment
          },
          close: async (): Promise<void> => {
            events.push('close-rate-runtime')
          },
        })
      },
      createSession: async (input) => {
        events.push('create-session')
        recordTransferredKey('permit-runtime', input.permitVerificationKey)
        return {
          measureConfigurationHash: async () => {
            events.push('measure-configuration')
            return fixture.expected.configurationHash
          },
          exerciseDescribeTableThrottle: async () => {
            events.push('exercise-describe-table-throttle')
            exerciseCount += 1
            if (exerciseCount !== 1) {
              throw new Error('Final publication rate exercise replayed.')
            }
            return Object.freeze({
              version: 1,
              awsSuccessfulAttemptCount: 1,
              rehearsalInjectedThrottleCount: 1,
              rehearsalInjectedBudgetStopCount: 1,
            })
          },
          interruptDescribeTableRate: (): void => {},
          createRehearsalArtifactPublisher: () => unexpectedTestEffect(),
          createRehearsalEvidencePublisher: () => unexpectedTestEffect(),
          readRehearsalEvidenceSessionBinding: () =>
            sessionBindingOverride ?? createFixtureSessionBinding(fixture),
          readDescribeTableRateEvidence: () => fixture.expected.rateAggregate,
          readRehearsalPermitValidity: () => unexpectedTestEffect(),
          close: async (): Promise<void> => {
            events.push('close-session')
          },
        }
      },
      finalizeRate: (input) => {
        events.push('finalize-rate')
        recordTransferredKey('rate-finalizer', input.authenticationKey)
        return fixture.input.rate
      },
      assembleSuite: (input) => {
        events.push('assemble-suite')
        recordTransferredKey(
          'alarm-signal',
          input.alarmSignalVerificationKey,
        )
        recordTransferredKey(
          'alarm-publication',
          input.alarmPublicationVerificationKey,
        )
        return assembleWorkspaceSearchMigrationRehearsalAuthenticatedSuite(
          input,
        )
      },
      publishSuite: async (input) => {
        events.push('publish-suite')
        publicationCount += 1
        recordTransferredKey('publication', input.evidenceSigningKey)
        const material =
          consumeWorkspaceSearchMigrationRehearsalFinalizedSuitePreparation(
            input.suite,
          )
        expect(material.bindings).toEqual(fixture.expected)
        expect(material.artifacts).toHaveLength(10)
        input.evidenceSigningKey.fill(0)
        await input.session.close()
        return Object.freeze({
          kind:
            'mukuroji-workspace-search-migration-rehearsal-publication-result',
          publicationVersion: 1,
          artifactCount: 10,
          artifactManifestDigest: '5'.repeat(64),
          byteLength: 1,
          contentDigest: '6'.repeat(64),
          immutableVersionDigest: '7'.repeat(64),
          storageLocatorDigest: '8'.repeat(64),
          retainedUntil: fixture.expected.completedAt,
        })
      },
      clock: () => new Date(fixture.expected.completedAt),
      writeStdoutLine: (line) => {
        stdout.push(line)
      },
      writeStderrLine: (line) => {
        stderr.push(line)
      },
    }
  return Object.freeze({
    dependencies,
    events,
    returnedBuffers,
    transferredKeys,
    transferredKeyBindings,
    stdout,
    stderr,
    /** Returns how many authenticated suites reached publication. */
    readPublicationCount: (): number => publicationCount,
    /** Returns how many times the one-shot final rate exercise ran. */
    readExerciseCount: (): number => exerciseCount,
  })
}

describe('migration rehearsal final publication CLI parser', () => {
  test('accepts only the ordered reviewed command with a measure suffix', () => {
    const parsed =
      parseWorkspaceSearchMigrationRehearsalPublicationCliArguments(
        createPublicationArguments(),
      )

    expect(parsed.configurationHash).toBe(configurationHash)
    expect(parsed.authenticationKeyFile).toBe(
      '/operator/rehearsal-authentication.key',
    )
    expect(parsed.alarmAuthenticationKeyFile).toBe(
      '/operator/rehearsal-alarm-authentication.key',
    )
    expect(parsed.stageReceiptFiles).toEqual([
      '/operator/rehearsal-stage-receipt-0001.json',
      '/operator/rehearsal-stage-receipt-0002.json',
    ])
    expect(parsed.reconciliationAuditFiles).toEqual(
      reconciliationAuditPaths,
    )
    expect(parsed.rateSegmentFiles).toEqual([
      '/operator/rate-segment-0001.json',
      '/operator/rate-segment-0002.json',
    ])
    expect(parsed.finalRateSegmentFile).toBe(
      '/operator/rate-segment-final.json',
    )
    expect(parsed.requestTimeoutMilliseconds).toBe(5_000)
    expect(parsed.measure.command).toBe('measure')
    expect(parsed.measure.rateBootstrap).toBe(false)
  })

  test('requires the ordered distinct alarm authentication key path', async () => {
    const missingArguments = createPublicationArguments()
    const alarmKeyIndex = missingArguments.indexOf(
      '--rehearsal-alarm-authentication-key-file',
    )
    missingArguments.splice(alarmKeyIndex, 2)
    await requirePublicationCliFailure(
      () => parseWorkspaceSearchMigrationRehearsalPublicationCliArguments(
        missingArguments,
      ),
      'INVALID_USAGE',
    )

    const reorderedArguments = createPublicationArguments()
    const mainKeyFlagIndex = reorderedArguments.indexOf(
      '--rehearsal-authentication-key-file',
    )
    const alarmKeyFlagIndex = reorderedArguments.indexOf(
      '--rehearsal-alarm-authentication-key-file',
    )
    reorderedArguments[mainKeyFlagIndex] =
      '--rehearsal-alarm-authentication-key-file'
    reorderedArguments[alarmKeyFlagIndex] =
      '--rehearsal-authentication-key-file'
    await requirePublicationCliFailure(
      () => parseWorkspaceSearchMigrationRehearsalPublicationCliArguments(
        reorderedArguments,
      ),
      'INVALID_USAGE',
    )

    const aliasedArguments = createPublicationArguments()
    const alarmKeyPathIndex = aliasedArguments.indexOf(
      '/operator/rehearsal-alarm-authentication.key',
    )
    aliasedArguments[alarmKeyPathIndex] =
      '/operator/rehearsal-authentication.key'
    await requirePublicationCliFailure(
      () => parseWorkspaceSearchMigrationRehearsalPublicationCliArguments(
        aliasedArguments,
      ),
      'INVALID_USAGE',
    )
  })

  test('rejects the removed operator-authored prestage document flag', async () => {
    const arguments_ = createPublicationArguments()
    arguments_.splice(
      0,
      0,
      '--rehearsal-suite-input-file',
      '/operator/rehearsal-suite.json',
    )

    await requirePublicationCliFailure(
      () => parseWorkspaceSearchMigrationRehearsalPublicationCliArguments(
        arguments_,
      ),
      'INVALID_USAGE',
    )
  })

  test('rejects omitted durable predecessor segments', async () => {
    const arguments_ = createPublicationArguments()
    const firstSegmentIndex = arguments_.indexOf(
      '--rehearsal-rate-segment-file',
    )
    arguments_.splice(firstSegmentIndex, 4)

    await requirePublicationCliFailure(
      () => parseWorkspaceSearchMigrationRehearsalPublicationCliArguments(
        arguments_,
      ),
      'INVALID_USAGE',
    )
  })

  test('rejects removed caller-selected alarm and reconciliation keys', async () => {
    const arguments_ = createPublicationArguments()
    const firstAuditIndex = arguments_.indexOf(
      '--rehearsal-reconciliation-audit-file',
    )
    arguments_.splice(
      firstAuditIndex,
      0,
      '--rehearsal-alarm-signal-key-file',
      '/operator/rehearsal-alarm-signals.key',
    )

    await requirePublicationCliFailure(
      () => parseWorkspaceSearchMigrationRehearsalPublicationCliArguments(
        arguments_,
      ),
      'INVALID_USAGE',
    )

    const reconciliationArguments = createPublicationArguments()
    const reconciliationAuditIndex = reconciliationArguments.indexOf(
      '--rehearsal-reconciliation-audit-file',
    )
    reconciliationArguments.splice(
      reconciliationAuditIndex,
      0,
      '--rehearsal-reconciliation-key-file',
      '/operator/rehearsal-reconciliation.key',
    )
    await requirePublicationCliFailure(
      () => parseWorkspaceSearchMigrationRehearsalPublicationCliArguments(
        reconciliationArguments,
      ),
      'INVALID_USAGE',
    )
  })

  test('rejects an omitted explicit stage receipt vector', async () => {
    const arguments_ = createPublicationArguments()
    const firstReceiptIndex = arguments_.indexOf(
      '--rehearsal-stage-receipt-file',
    )
    arguments_.splice(firstReceiptIndex, 4)

    await requirePublicationCliFailure(
      () => parseWorkspaceSearchMigrationRehearsalPublicationCliArguments(
        arguments_,
      ),
      'INVALID_USAGE',
    )
  })

  test('rejects fewer or more than eight ordered reconciliation audits', async () => {
    const fewerArguments = createPublicationArguments()
    const firstAuditIndex = fewerArguments.indexOf(
      '--rehearsal-reconciliation-audit-file',
    )
    fewerArguments.splice(firstAuditIndex, 2)
    await requirePublicationCliFailure(
      () => parseWorkspaceSearchMigrationRehearsalPublicationCliArguments(
        fewerArguments,
      ),
      'INVALID_USAGE',
    )

    const extraArguments = createPublicationArguments()
    const rateConfigurationIndex = extraArguments.indexOf(
      '--rehearsal-rate-configuration-hash',
    )
    extraArguments.splice(
      rateConfigurationIndex,
      0,
      '--rehearsal-reconciliation-audit-file',
      '/operator/reconciliation-extra.json',
    )
    await requirePublicationCliFailure(
      () => parseWorkspaceSearchMigrationRehearsalPublicationCliArguments(
        extraArguments,
      ),
      'INVALID_USAGE',
    )
  })

  test('rejects the removed raw integrity and target-audit surface', async () => {
    const integrityArguments = createPublicationArguments()
    const firstIntegrityAuditIndex = integrityArguments.indexOf(
      '--rehearsal-reconciliation-audit-file',
    )
    integrityArguments.splice(
      firstIntegrityAuditIndex,
      0,
      '--rehearsal-integrity-key-file',
      '/operator/rehearsal-integrity.key',
    )
    await requirePublicationCliFailure(
      () => parseWorkspaceSearchMigrationRehearsalPublicationCliArguments(
        integrityArguments,
      ),
      'INVALID_USAGE',
    )

    const targetArguments = createPublicationArguments()
    const firstAuditIndex = targetArguments.indexOf(
      '--rehearsal-reconciliation-audit-file',
    )
    targetArguments[firstAuditIndex] =
      '--rehearsal-target-preimage-audit-file'
    await requirePublicationCliFailure(
      () => parseWorkspaceSearchMigrationRehearsalPublicationCliArguments(
        targetArguments,
      ),
      'INVALID_USAGE',
    )
  })

  test('rejects reconciliation flag reordering and repeated file paths', async () => {
    const reorderedArguments = createPublicationArguments()
    const firstAuditIndex = reorderedArguments.indexOf(
      '--rehearsal-reconciliation-audit-file',
    )
    reorderedArguments[firstAuditIndex] =
      '--rehearsal-rate-configuration-hash'
    await requirePublicationCliFailure(
      () => parseWorkspaceSearchMigrationRehearsalPublicationCliArguments(
        reorderedArguments,
      ),
      'INVALID_USAGE',
    )

    const replayArguments = createPublicationArguments()
    const auditIndexes = replayArguments.flatMap((value, index) =>
      value === '--rehearsal-reconciliation-audit-file' ? [index] : [])
    const first = auditIndexes[0]
    const second = auditIndexes[1]
    if (first === undefined || second === undefined) {
      throw new Error('Expected two reconciliation audit arguments.')
    }
    replayArguments[second + 1] = replayArguments[first + 1] ?? ''
    await requirePublicationCliFailure(
      () => parseWorkspaceSearchMigrationRehearsalPublicationCliArguments(
        replayArguments,
      ),
      'INVALID_USAGE',
    )
  })

  test('rejects path reuse across every restricted input and output class', async () => {
    const stageReplayArguments = createPublicationArguments()
    replaceRequiredPublicationPath(
      stageReplayArguments,
      '/operator/rehearsal-stage-receipt-0001.json',
      '/operator/rehearsal-alarms.json',
    )
    await requirePublicationCliFailure(
      () => parseWorkspaceSearchMigrationRehearsalPublicationCliArguments(
        stageReplayArguments,
      ),
      'INVALID_USAGE',
    )

    const outputReplayArguments = createPublicationArguments()
    replaceRequiredPublicationPath(
      outputReplayArguments,
      '/operator/rate-segment-final.json',
      '/operator/rate-segment-0001.json',
    )
    await requirePublicationCliFailure(
      () => parseWorkspaceSearchMigrationRehearsalPublicationCliArguments(
        outputReplayArguments,
      ),
      'INVALID_USAGE',
    )

    const policyReplayArguments = createPublicationArguments()
    replaceRequiredPublicationPath(
      policyReplayArguments,
      '/operator/rate-policy.json',
      '/operator/rehearsal-permit.json',
    )
    await requirePublicationCliFailure(
      () => parseWorkspaceSearchMigrationRehearsalPublicationCliArguments(
        policyReplayArguments,
      ),
      'INVALID_USAGE',
    )
  })

  test('rejects an unreviewed approval and a non-measure suffix', async () => {
    const approvalArguments = createPublicationArguments()
    const approvalIndex = approvalArguments.indexOf('--approval')
    approvalArguments[approvalIndex + 1] = 'publish-without-review'
    await requirePublicationCliFailure(
      () => parseWorkspaceSearchMigrationRehearsalPublicationCliArguments(
        approvalArguments,
      ),
      'INVALID_USAGE',
    )

    const mutationArguments = createPublicationArguments()
    const separatorIndex = mutationArguments.indexOf('--')
    mutationArguments.splice(separatorIndex + 1, mutationArguments.length, 'help')
    await requirePublicationCliFailure(
      () => parseWorkspaceSearchMigrationRehearsalPublicationCliArguments(
        mutationArguments,
      ),
      'INVALID_USAGE',
    )
  })
})

describe('migration rehearsal restricted publication input reader', () => {
  test('reads one stable owner-only regular file exactly', async () => {
    const directory = await mkdtemp(join(tmpdir(), 'mukuroji-publish-input-'))
    try {
      const path = join(directory, 'input.json')
      const expected = new TextEncoder().encode('{"value":1}')
      await writeFile(path, expected, { mode: 0o600 })

      const actual =
        await readWorkspaceSearchMigrationRehearsalRestrictedInputFile(
          path,
          WORKSPACE_SEARCH_MIGRATION_REHEARSAL_ALARM_ARTIFACT_MAX_BYTES,
        )

      expect(actual).toEqual(expected)
      expect(actual).not.toBe(expected)
    } finally {
      await rm(directory, { force: true, recursive: true })
    }
  })

  test('rejects broad permissions, symlinks, and multiply linked files', async () => {
    const directory = await mkdtemp(join(tmpdir(), 'mukuroji-publish-input-'))
    try {
      const broadPath = join(directory, 'broad.json')
      await writeFile(broadPath, '{}', { mode: 0o600 })
      await chmod(broadPath, 0o640)
      await requirePublicationCliFailure(
        () => readWorkspaceSearchMigrationRehearsalRestrictedInputFile(
          broadPath,
          1_024,
        ),
        'INPUT_FILE_INVALID',
      )
      const originalPath = join(directory, 'original.json')
      const symlinkPath = join(directory, 'symlink.json')
      await writeFile(originalPath, '{}', { mode: 0o600 })
      await symlink(originalPath, symlinkPath)
      await requirePublicationCliFailure(
        () => readWorkspaceSearchMigrationRehearsalRestrictedInputFile(
          symlinkPath,
          1_024,
        ),
        'INPUT_FILE_UNREADABLE',
      )

      const hardlinkPath = join(directory, 'hardlink.json')
      await link(originalPath, hardlinkPath)
      await requirePublicationCliFailure(
        () => readWorkspaceSearchMigrationRehearsalRestrictedInputFile(
          originalPath,
          1_024,
        ),
        'INPUT_FILE_INVALID',
      )
    } finally {
      await rm(directory, { force: true, recursive: true })
    }
  })
})

describe('migration rehearsal final publication orchestration', () => {

  test('rejects authenticated permit key substitution before stage routing', async () => {
    const fixture =
      await createAuthenticWorkspaceSearchMigrationRehearsalAssemblerFixture()
    const harness = createFinalPublicationWiringHarness(fixture)
    let preflightKey: Uint8Array | undefined
    const dependencies:
      WorkspaceSearchMigrationRehearsalPublicationCliDependencies = {
        ...harness.dependencies,
        verifyPermit: (input) => {
          harness.events.push('reject-permit-key-bindings')
          preflightKey = input.verificationKey
          return Object.freeze({
            evidenceKeyDigest: '0'.repeat(64),
            publicationKeyDigest: '1'.repeat(64),
          })
        },
      }

    const exitCode =
      await runWorkspaceSearchMigrationRehearsalPublicationCli(
        createPublicationArguments(fixture.expected.configurationHash),
        dependencies,
      )

    expect(exitCode).toBe(1)
    expect(harness.events).toContain('reject-permit-key-bindings')
    expect(harness.events).not.toContain('derive-stage-chain')
    expect(preflightKey).toEqual(new Uint8Array(32))
    expect(harness.returnedBuffers).toHaveLength(18)
    expect(harness.returnedBuffers.every((bytes) =>
      bytes.every((byte) => byte === 0)
    )).toBe(true)
  })

  test('reads and later overwrites every restricted input before AWS', async () => {
    const events: string[] = []
    const returnedBuffers: Uint8Array[] = []
    const stderr: string[] = []
    let observedStageKey: Uint8Array | undefined
    let observedStagePublicationKey: Uint8Array | undefined
    let observedPermitPreflightKey: Uint8Array | undefined
    const dependencies:
      WorkspaceSearchMigrationRehearsalPublicationCliDependencies = {
        readRestrictedFile: async (path) => {
          events.push(`read:${path}`)
          const bytes = createRestrictedFixtureBytes(path)
          returnedBuffers.push(bytes)
          return bytes
        },
        deriveStageChain: (input) => {
          events.push('derive-stage-chain')
          observedStageKey = input.verificationKey
          observedStagePublicationKey = input.publicationVerificationKey
          throw new Error('raw-stage-canary')
        },
        verifyPermit: (input) => {
          events.push('verify-permit')
          observedPermitPreflightKey = input.verificationKey
          return publicationPermitKeyDigests
        },
        readStageReconciliationContexts: () => unexpectedTestEffect(),
        finalizeReconciliation: () => unexpectedTestEffect(),
        createRateRuntime: () => {
          events.push('create-rate-runtime')
          return unexpectedTestEffect()
        },
        createSession: () => {
          events.push('create-session')
          return unexpectedTestEffect()
        },
        finalizeRate: () => unexpectedTestEffect(),
        assembleSuite: () => unexpectedTestEffect(),
        publishSuite: () => unexpectedTestEffect(),
        clock: () => new Date('2026-01-01T00:00:00.000Z'),
        writeStdoutLine: () => unexpectedTestEffect(),
        writeStderrLine: (line) => {
          stderr.push(line)
        },
      }

    const exitCode =
      await runWorkspaceSearchMigrationRehearsalPublicationCli(
        createPublicationArguments(),
        dependencies,
      )

    expect(exitCode).toBe(1)
    expect(events.at(-1)).toBe('derive-stage-chain')
    expect(events).not.toContain('create-rate-runtime')
    expect(events).not.toContain('create-session')
    expect(events.filter((event) => event.startsWith('read:'))).toHaveLength(18)
    expect(returnedBuffers.every((bytes) =>
      bytes.every((byte) => byte === 0)
    )).toBe(true)
    expect(observedStageKey).toEqual(new Uint8Array(32))
    expect(observedStagePublicationKey).toEqual(new Uint8Array(32))
    expect(observedPermitPreflightKey).toEqual(new Uint8Array(32))
    expect(stderr).toEqual([
      '{"code":"OPERATION_FAILED","kind":"mukuroji-workspace-search-migration-rehearsal-publication-cli-result","status":"error"}',
    ])
  })

  test('rejects byte-equal main and alarm masters before AWS composition', async () => {
    const fixture =
      await createAuthenticWorkspaceSearchMigrationRehearsalAssemblerFixture()
    const harness = createFinalPublicationWiringHarness(fixture)
    let rejectedAlarmMaster: Uint8Array | undefined
    const dependencies:
      WorkspaceSearchMigrationRehearsalPublicationCliDependencies = {
        ...harness.dependencies,
        readRestrictedFile: async (path, maximumBytes) => {
          if (path.endsWith('rehearsal-alarm-authentication.key')) {
            harness.events.push(`read:${path}`)
            rejectedAlarmMaster = new Uint8Array(mainRehearsalMasterKey)
            return rejectedAlarmMaster
          }
          return await harness.dependencies.readRestrictedFile(
            path,
            maximumBytes,
          )
        },
      }

    const exitCode =
      await runWorkspaceSearchMigrationRehearsalPublicationCli(
        createPublicationArguments(fixture.expected.configurationHash),
        dependencies,
      )

    expect(exitCode).toBe(2)
    expect(harness.events).not.toContain('derive-stage-chain')
    expect(harness.events).not.toContain('create-rate-runtime')
    expect(harness.events).not.toContain('create-session')
    expect(rejectedAlarmMaster).toEqual(new Uint8Array(32))
    expect(harness.returnedBuffers.every((bytes) =>
      bytes.every((byte) => byte === 0)
    )).toBe(true)
    expect(harness.stderr).toEqual([
      '{"code":"INPUT_FILE_INVALID","kind":"mukuroji-workspace-search-migration-rehearsal-publication-cli-result","status":"error"}',
    ])
  })

  test('overwrites ordered audit bytes and both keys when reconciliation fails', async () => {
    const fixture =
      await createAuthenticWorkspaceSearchMigrationRehearsalAssemblerFixture()
    const harness = createFinalPublicationWiringHarness(fixture)
    let transferredReconciliationKey: Uint8Array | undefined
    let transferredReconciliationPublicationKey: Uint8Array | undefined
    let transferredAuditBytes: readonly Uint8Array[] | undefined
    const dependencies:
      WorkspaceSearchMigrationRehearsalPublicationCliDependencies = {
        ...harness.dependencies,
        finalizeReconciliation: (
          input,
          verificationKey,
          publicationVerificationKey,
        ) => {
          harness.events.push('reject-reconciliation')
          transferredReconciliationKey = verificationKey
          transferredReconciliationPublicationKey =
            publicationVerificationKey
          transferredAuditBytes = input.artifacts.map(
            (artifact) => artifact.artifactBytes,
          )
          throw new Error('reconciliation-canary')
        },
      }

    const exitCode =
      await runWorkspaceSearchMigrationRehearsalPublicationCli(
        createPublicationArguments(fixture.expected.configurationHash),
        dependencies,
      )

    expect(exitCode).toBe(1)
    expect(harness.events).toContain('reject-reconciliation')
    expect(harness.events).not.toContain('create-rate-runtime')
    expect(harness.returnedBuffers).toHaveLength(18)
    expect(harness.returnedBuffers.every((bytes) =>
      bytes.every((byte) => byte === 0)
    )).toBe(true)
    expect(transferredReconciliationKey).toEqual(new Uint8Array(32))
    expect(transferredReconciliationPublicationKey).toEqual(
      new Uint8Array(32),
    )
    expect(transferredAuditBytes).toHaveLength(8)
    expect(transferredAuditBytes?.every((bytes) =>
      bytes.every((byte) => byte === 0)
    )).toBe(true)
  })

  test('rejects reconciliation artifacts outside canonical scenario order', async () => {
    const fixture =
      await createAuthenticWorkspaceSearchMigrationRehearsalAssemblerFixture()
    const harness = createFinalPublicationWiringHarness(fixture)
    const arguments_ = createPublicationArguments(
      fixture.expected.configurationHash,
    )
    const firstPathIndex = arguments_.indexOf(reconciliationAuditPaths[0] ?? '')
    const secondPathIndex = arguments_.indexOf(
      reconciliationAuditPaths[1] ?? '',
    )
    if (firstPathIndex < 0 || secondPathIndex < 0) {
      throw new Error('Expected canonical reconciliation audit paths.')
    }
    const firstPath = arguments_[firstPathIndex]
    const secondPath = arguments_[secondPathIndex]
    if (firstPath === undefined || secondPath === undefined) {
      throw new Error('Expected complete reconciliation audit paths.')
    }
    arguments_[firstPathIndex] = secondPath
    arguments_[secondPathIndex] = firstPath

    const exitCode =
      await runWorkspaceSearchMigrationRehearsalPublicationCli(
        arguments_,
        harness.dependencies,
      )

    expect(exitCode).toBe(1)
    expect(harness.readPublicationCount()).toBe(0)
    expect(harness.events).toContain('finalize-reconciliation')
    expect(harness.events).not.toContain('create-rate-runtime')
    expect(harness.returnedBuffers.every((bytes) =>
      bytes.every((byte) => byte === 0)
    )).toBe(true)
  })

  test('rejects live session identity substitutions before publication', async () => {
    for (const variant of [
      'session',
      'attestation',
      'evidence-key',
      'publication-key',
      'commit',
      'configuration',
    ]) {
      const fixture =
        await createAuthenticWorkspaceSearchMigrationRehearsalAssemblerFixture()
      const expected = createFixtureSessionBinding(fixture)
      let substituted:
        WorkspaceSearchMigrationRehearsalEvidenceSessionBinding
      switch (variant) {
        case 'session':
          substituted = Object.freeze({
            commit: 'b'.repeat(40),
            configurationHash: '0'.repeat(64),
            evidenceKeyDigest: '2'.repeat(64),
            publicationKeyDigest: '3'.repeat(64),
            attestation: Object.freeze({
              ...expected.attestation,
              callerAttestationDigest: '4'.repeat(64),
            }),
          })
          break
        case 'attestation':
          substituted = Object.freeze({
            ...expected,
            attestation: Object.freeze({
              ...expected.attestation,
              resourceAttestationDigest: '5'.repeat(64),
            }),
          })
          break
        case 'evidence-key':
          substituted = Object.freeze({
            ...expected,
            evidenceKeyDigest: '6'.repeat(64),
          })
          break
        case 'publication-key':
          substituted = Object.freeze({
            ...expected,
            publicationKeyDigest: '7'.repeat(64),
          })
          break
        case 'commit':
          substituted = Object.freeze({
            ...expected,
            commit: 'b'.repeat(40),
          })
          break
        case 'configuration':
          substituted = Object.freeze({
            ...expected,
            configurationHash: '0'.repeat(64),
          })
          break
        default:
          throw new Error('Unexpected session substitution variant.')
      }
      const harness = createFinalPublicationWiringHarness(
        fixture,
        substituted,
      )

      const exitCode =
        await runWorkspaceSearchMigrationRehearsalPublicationCli(
          createPublicationArguments(fixture.expected.configurationHash),
          harness.dependencies,
        )

      expect(exitCode).toBe(1)
      expect(harness.events).toContain('assemble-suite')
      expect(harness.events).not.toContain('publish-suite')
      expect(harness.events.at(-1)).toBe('close-session')
      expect(harness.returnedBuffers).toHaveLength(19)
      expect(harness.returnedBuffers.every((bytes) =>
        bytes.every((byte) => byte === 0)
      )).toBe(true)
      expect(harness.transferredKeys.every((key) =>
        key.every((byte) => byte === 0)
      )).toBe(true)
    }
  })

  test('never flushes or publishes without one exact final rate exercise', async () => {
    for (const variant of ['missing', 'malformed']) {
      const fixture =
        await createAuthenticWorkspaceSearchMigrationRehearsalAssemblerFixture()
      const harness = createFinalPublicationWiringHarness(fixture)
      const dependencies:
        WorkspaceSearchMigrationRehearsalPublicationCliDependencies = {
          ...harness.dependencies,
          createSession: async (input) => {
            const session = await harness.dependencies.createSession(input)
            if (variant === 'missing') {
              Reflect.deleteProperty(
                session,
                'exerciseDescribeTableThrottle',
              )
            } else {
              Object.defineProperty(
                session,
                'exerciseDescribeTableThrottle',
                {
                  enumerable: true,
                  configurable: true,
                  value: async () => Object.freeze({
                    version: 1,
                    awsSuccessfulAttemptCount: 1,
                    rehearsalInjectedThrottleCount: 1,
                    rehearsalInjectedBudgetStopCount: 0,
                  }),
                },
              )
            }
            return session
          },
        }

      const exitCode =
        await runWorkspaceSearchMigrationRehearsalPublicationCli(
          createPublicationArguments(fixture.expected.configurationHash),
          dependencies,
        )

      expect(exitCode).toBe(1)
      expect(harness.readPublicationCount()).toBe(0)
      expect(harness.events).toContain('measure-configuration')
      expect(harness.events).not.toContain('flush-rate-runtime')
      expect(harness.events).not.toContain('finalize-rate')
      expect(harness.events).not.toContain('assemble-suite')
      expect(harness.events).not.toContain('publish-suite')
      expect(harness.events.at(-1)).toBe('close-session')
      expect(harness.stdout).toHaveLength(0)
      expect(harness.stderr).toEqual([
        '{"code":"OPERATION_FAILED","kind":"mukuroji-workspace-search-migration-rehearsal-publication-cli-result","status":"error"}',
      ])
    }
  })

  test('wires every authentic capability into the final assembler', async () => {
    const fixture =
      await createAuthenticWorkspaceSearchMigrationRehearsalAssemblerFixture()
    const harness = createFinalPublicationWiringHarness(fixture)

    const exitCode =
      await runWorkspaceSearchMigrationRehearsalPublicationCli(
        createPublicationArguments(fixture.expected.configurationHash),
        harness.dependencies,
      )

    expect(exitCode).toBe(0)
    expect(harness.readPublicationCount()).toBe(1)
    expect(harness.readExerciseCount()).toBe(1)
    expect(harness.events).toContain('assemble-suite')
    expect(harness.events).toContain('publish-suite')
    expect(
      harness.events.indexOf('measure-configuration'),
    ).toBeLessThan(
      harness.events.indexOf('exercise-describe-table-throttle'),
    )
    expect(
      harness.events.indexOf('exercise-describe-table-throttle'),
    ).toBeLessThan(harness.events.indexOf('flush-rate-runtime'))
    expect(harness.events.at(-1)).toBe('close-session')
    expect(harness.returnedBuffers).toHaveLength(19)
    expect(harness.returnedBuffers.every((bytes) =>
      bytes.every((byte) => byte === 0)
    )).toBe(true)
    expect(harness.transferredKeys).toHaveLength(11)
    expect(harness.transferredKeys.every((key) =>
      key.every((byte) => byte === 0)
    )).toBe(true)
    expect(harness.transferredKeyBindings).toEqual([
      `permit-preflight-runtime:${publicationPermitKeyDigests.evidenceKeyDigest}`,
      `stage-runtime:${publicationPermitKeyDigests.evidenceKeyDigest}`,
      `stage-publication:${publicationPermitKeyDigests.publicationKeyDigest}`,
      `reconciliation-runtime:${publicationPermitKeyDigests.evidenceKeyDigest}`,
      `reconciliation-publication:${publicationPermitKeyDigests.publicationKeyDigest}`,
      `rate-runtime:${publicationPermitKeyDigests.evidenceKeyDigest}`,
      `permit-runtime:${publicationPermitKeyDigests.evidenceKeyDigest}`,
      `rate-finalizer:${publicationPermitKeyDigests.evidenceKeyDigest}`,
      `alarm-signal:${alarmAuthenticationKeyDigests.runtimeKeyDigest}`,
      `alarm-publication:${alarmAuthenticationKeyDigests.publicationKeyDigest}`,
      `publication:${publicationPermitKeyDigests.publicationKeyDigest}`,
    ])
    expect(harness.stderr).toHaveLength(0)
    expect(harness.stdout).toHaveLength(1)
  })

  test('does not publish when the authentic final rate is not measurement', async () => {
    const fixture =
      await createAuthenticWorkspaceSearchMigrationRehearsalAssemblerFixture({
        finalMeasurementPhase: 'checkpoint-page',
      })
    const harness = createFinalPublicationWiringHarness(fixture)

    const exitCode =
      await runWorkspaceSearchMigrationRehearsalPublicationCli(
        createPublicationArguments(fixture.expected.configurationHash),
        harness.dependencies,
      )

    expect(exitCode).toBe(1)
    expect(harness.readPublicationCount()).toBe(0)
    expect(harness.events).toContain('assemble-suite')
    expect(harness.events).not.toContain('publish-suite')
    expect(harness.events.at(-1)).toBe('close-session')
    expect(harness.returnedBuffers.every((bytes) =>
      bytes.every((byte) => byte === 0)
    )).toBe(true)
    expect(harness.transferredKeys.every((key) =>
      key.every((byte) => byte === 0)
    )).toBe(true)
    expect(harness.stdout).toHaveLength(0)
    expect(harness.stderr).toEqual([
      '{"code":"OPERATION_FAILED","kind":"mukuroji-workspace-search-migration-rehearsal-publication-cli-result","status":"error"}',
    ])
  })
})

/** Creates one path-specific restricted file payload for orchestration. */
function createRestrictedFixtureBytes(path: string): Uint8Array {
  if (path.endsWith('rehearsal-alarm-authentication.key')) {
    return new Uint8Array(alarmRehearsalMasterKey)
  }
  if (path.endsWith('.key')) return new Uint8Array(mainRehearsalMasterKey)
  if (path.endsWith('rehearsal-permit.json')) {
    return new TextEncoder().encode(serializeCanonicalJson(
      publicationPermitKeyDigests,
    ))
  }
  if (path.endsWith('rate-policy.json')) {
    return new Uint8Array(ratePolicyBytes)
  }
  return new Uint8Array([1])
}

/** Raises when an effect expected to stay unreachable is invoked. */
function unexpectedTestEffect(): never {
  throw new Error('Unexpected test effect.')
}
