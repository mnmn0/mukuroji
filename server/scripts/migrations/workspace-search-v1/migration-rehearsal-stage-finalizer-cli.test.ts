import { createHash } from 'node:crypto'
import {
  chmod,
  link,
  mkdtemp,
  readFile,
  readdir,
  rm,
  stat,
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
  createMigrationDigest,
  serializeCanonicalJson,
} from './migration-contract'
import type {
  WorkspaceSearchMigrationRehearsalScenarioName,
} from './migration-rehearsal-evidence'
import type {
  WorkspaceSearchMigrationRehearsalFaultPlan,
} from './migration-rehearsal-faults'
import {
  readWorkspaceSearchMigrationRehearsalPrivateInputFile,
} from './migration-rehearsal-private-input'
import {
  isWorkspaceSearchMigrationRehearsalGenericSuccessSelectedStage,
  type FinalizeWorkspaceSearchMigrationRehearsalStageReceiptInput,
  type WorkspaceSearchMigrationRehearsalGenericSuccessSelectedStage,
  type WorkspaceSearchMigrationRehearsalSupportedSelectedStage,
  type WorkspaceSearchMigrationRehearsalStageFinalizationProof,
} from './migration-rehearsal-stage-finalizer'
import {
  createWorkspaceSearchMigrationRehearsalStageChildMaterialTestFixture,
  createWorkspaceSearchMigrationRehearsalStageFaultMaterialTestFixture,
} from './migration-rehearsal-stage-child-material.test-fixture'
import {
  determineWorkspaceSearchMigrationRehearsalStageFinalizerProofRequirement,
  parseWorkspaceSearchMigrationRehearsalStageFinalizerCliArguments,
  readWorkspaceSearchMigrationRehearsalStageFinalizerKeyFile,
  runWorkspaceSearchMigrationRehearsalStageFinalizerCli,
  writeWorkspaceSearchMigrationRehearsalStageReceiptFileExclusive,
  WORKSPACE_SEARCH_MIGRATION_REHEARSAL_STAGE_FINALIZER_CLI_APPROVAL,
  WORKSPACE_SEARCH_MIGRATION_REHEARSAL_STAGE_FINALIZER_CLI_RESULT_KIND,
  workspaceSearchMigrationRehearsalStageReceiptNodePublicationDependencies,
  type WorkspaceSearchMigrationRehearsalStageFinalizerCliDependencies,
  type WorkspaceSearchMigrationRehearsalStageFinalizerProofRequirement,
} from './migration-rehearsal-stage-finalizer-cli'
import type {
  WorkspaceSearchMigrationRehearsalSelectedStage,
  WorkspaceSearchMigrationRehearsalStageCommand,
  WorkspaceSearchMigrationRehearsalStageOutcome,
} from './migration-rehearsal-stage-receipt'

/** Shared authenticated manifest fixture used for supported selections. */
const childFixture =
  createWorkspaceSearchMigrationRehearsalStageChildMaterialTestFixture()

/** Authentic stopped-fault fixture used by the injected boundary tests. */
const faultBoundaryFixture =
  createWorkspaceSearchMigrationRehearsalStageFaultMaterialTestFixture()

/** Authentic response-loss fixture used by the injected boundary tests. */
const faultCompletionFixture =
  createWorkspaceSearchMigrationRehearsalStageFaultMaterialTestFixture(true)

/** One valid authenticated receipt returned by the finite finalizer stub. */
const outputReceipt = faultBoundaryFixture.previousReceipt

/** Exact canonical UTF-8 encoder used by every file fixture. */
const encoder = new TextEncoder()

/** Temporary private directories removed after each filesystem test. */
const temporaryDirectories: string[] = []

/** Common strict input and output paths for the in-memory CLI harness. */
const paths = Object.freeze({
  manifest: '/restricted/stage-manifest.json',
  previousReceipt: '/restricted/previous-stage-receipt.json',
  material: '/restricted/stage-material.json',
  boundaryMaterial: '/restricted/boundary-stage-material.json',
  faultPlan: '/restricted/fault-plan.json',
  boundaryRateSegment: '/restricted/boundary-rate-segment.jsonl',
  finalRateSegment: '/restricted/final-rate-segment.jsonl',
  lifecycle: '/restricted/stage-lifecycle.json',
  parentAuthentication: '/restricted/parent-authentication.json',
  stageKey: '/restricted/stage.key',
  controlArguments: '/restricted/control-arguments.json',
  planningReceipt: '/restricted/planning-stage-receipt.json',
  reconciliationArtifact: '/restricted/reconciliation-artifact.json',
  targetPreimage: '/restricted/target-preimage.json',
  targetAuditKey: '/restricted/target-audit.key',
  output: '/restricted/final-stage-receipt.json',
})

/** Exact material prefix selected by one offline finalizer invocation. */
type MaterialProfile =
  | 'fault-boundary'
  | 'fault-completion'
  | 'success'

/** One injected selection and the material prefix presented to the CLI. */
type InjectedMaterialCase = {
  /** Strict operator material prefix. */
  readonly profile: MaterialProfile
  /** Authenticated selection returned by the injected selector. */
  readonly selection: WorkspaceSearchMigrationRehearsalSupportedSelectedStage
  /** Canonical reviewed fault plan parsed by fault material profiles. */
  readonly faultPlan: WorkspaceSearchMigrationRehearsalFaultPlan
}

/** One supported generic-success stage exercised by the CLI matrix. */
type SupportedStageCase = {
  /** Authenticated canonical scenario. */
  readonly scenario: Extract<
    WorkspaceSearchMigrationRehearsalScenarioName,
    'complete-apply-rollback' | 'happy-path-verified'
  >
  /** Authenticated generic-success command. */
  readonly command: Extract<
    WorkspaceSearchMigrationRehearsalStageCommand,
    'apply' | 'close-replan' | 'release' | 'rollback-complete' | 'verify'
  >
  /** Command-derived finalizer proof discriminator. */
  readonly proofKind:
    WorkspaceSearchMigrationRehearsalStageFinalizationProof['kind']
  /** Command-derived raw proof-file profile. */
  readonly requirement:
    WorkspaceSearchMigrationRehearsalStageFinalizerProofRequirement
}

/** Complete eight-stage supported generic-success matrix. */
const supportedStageCases: readonly SupportedStageCase[] = Object.freeze([
  {
    scenario: 'happy-path-verified',
    command: 'close-replan',
    proofKind: 'planning',
    requirement: 'none',
  },
  {
    scenario: 'happy-path-verified',
    command: 'apply',
    proofKind: 'apply',
    requirement: 'none',
  },
  {
    scenario: 'happy-path-verified',
    command: 'verify',
    proofKind: 'terminal',
    requirement: 'terminal',
  },
  {
    scenario: 'happy-path-verified',
    command: 'release',
    proofKind: 'release',
    requirement: 'none',
  },
  {
    scenario: 'complete-apply-rollback',
    command: 'close-replan',
    proofKind: 'planning',
    requirement: 'none',
  },
  {
    scenario: 'complete-apply-rollback',
    command: 'apply',
    proofKind: 'apply',
    requirement: 'complete-apply',
  },
  {
    scenario: 'complete-apply-rollback',
    command: 'rollback-complete',
    proofKind: 'terminal',
    requirement: 'terminal',
  },
  {
    scenario: 'complete-apply-rollback',
    command: 'release',
    proofKind: 'release',
    requirement: 'none',
  },
])

/** One expected proof requirement in the fixed 36-stage manifest. */
type ProofRequirementStageCase = {
  /** Authenticated canonical scenario. */
  readonly scenario: WorkspaceSearchMigrationRehearsalScenarioName
  /** One-based stage position within the scenario. */
  readonly scenarioStageOrdinal: number
  /** Authenticated stage command. */
  readonly command: WorkspaceSearchMigrationRehearsalStageCommand
  /** Authenticated finite process outcome. */
  readonly expectedOutcome: WorkspaceSearchMigrationRehearsalStageOutcome
  /** One-based process attempt within the scenario. */
  readonly attemptOrdinal: number
  /** Exact material prefix selected by the outcome. */
  readonly materialProfile: MaterialProfile
  /** Exact proof-file requirement derived after selection. */
  readonly requirement:
    WorkspaceSearchMigrationRehearsalStageFinalizerProofRequirement
}

/** Complete expected proof and material matrix for all 36 manifest stages. */
const proofRequirementStageCases:
  readonly ProofRequirementStageCase[] = Object.freeze([
    {
      scenario: 'happy-path-verified',
      scenarioStageOrdinal: 1,
      command: 'close-replan',
      expectedOutcome: 'completed',
      attemptOrdinal: 1,
      materialProfile: 'success',
      requirement: 'none',
    },
    {
      scenario: 'happy-path-verified',
      scenarioStageOrdinal: 2,
      command: 'apply',
      expectedOutcome: 'completed',
      attemptOrdinal: 1,
      materialProfile: 'success',
      requirement: 'none',
    },
    {
      scenario: 'happy-path-verified',
      scenarioStageOrdinal: 3,
      command: 'verify',
      expectedOutcome: 'completed',
      attemptOrdinal: 1,
      materialProfile: 'success',
      requirement: 'terminal',
    },
    {
      scenario: 'happy-path-verified',
      scenarioStageOrdinal: 4,
      command: 'release',
      expectedOutcome: 'completed',
      attemptOrdinal: 1,
      materialProfile: 'success',
      requirement: 'none',
    },
    {
      scenario: 'cursor-before-commit-kill',
      scenarioStageOrdinal: 1,
      command: 'close-replan',
      expectedOutcome: 'completed',
      attemptOrdinal: 1,
      materialProfile: 'success',
      requirement: 'none',
    },
    {
      scenario: 'cursor-before-commit-kill',
      scenarioStageOrdinal: 2,
      command: 'apply',
      expectedOutcome: 'fault-reached',
      attemptOrdinal: 1,
      materialProfile: 'fault-boundary',
      requirement: 'none',
    },
    {
      scenario: 'cursor-before-commit-kill',
      scenarioStageOrdinal: 3,
      command: 'apply',
      expectedOutcome: 'takeover-completed',
      attemptOrdinal: 2,
      materialProfile: 'success',
      requirement: 'planning-receipt',
    },
    {
      scenario: 'cursor-before-commit-kill',
      scenarioStageOrdinal: 4,
      command: 'verify',
      expectedOutcome: 'completed',
      attemptOrdinal: 2,
      materialProfile: 'success',
      requirement: 'terminal',
    },
    {
      scenario: 'cursor-before-commit-kill',
      scenarioStageOrdinal: 5,
      command: 'release',
      expectedOutcome: 'completed',
      attemptOrdinal: 2,
      materialProfile: 'success',
      requirement: 'none',
    },
    {
      scenario: 'cursor-after-commit-kill',
      scenarioStageOrdinal: 1,
      command: 'close-replan',
      expectedOutcome: 'completed',
      attemptOrdinal: 1,
      materialProfile: 'success',
      requirement: 'none',
    },
    {
      scenario: 'cursor-after-commit-kill',
      scenarioStageOrdinal: 2,
      command: 'apply',
      expectedOutcome: 'fault-reached',
      attemptOrdinal: 1,
      materialProfile: 'fault-boundary',
      requirement: 'none',
    },
    {
      scenario: 'cursor-after-commit-kill',
      scenarioStageOrdinal: 3,
      command: 'apply',
      expectedOutcome: 'takeover-completed',
      attemptOrdinal: 2,
      materialProfile: 'success',
      requirement: 'planning-receipt',
    },
    {
      scenario: 'cursor-after-commit-kill',
      scenarioStageOrdinal: 4,
      command: 'verify',
      expectedOutcome: 'completed',
      attemptOrdinal: 2,
      materialProfile: 'success',
      requirement: 'terminal',
    },
    {
      scenario: 'cursor-after-commit-kill',
      scenarioStageOrdinal: 5,
      command: 'release',
      expectedOutcome: 'completed',
      attemptOrdinal: 2,
      materialProfile: 'success',
      requirement: 'none',
    },
    {
      scenario: 'artifact-before-checkpoint-kill',
      scenarioStageOrdinal: 1,
      command: 'close-replan',
      expectedOutcome: 'fault-reached',
      attemptOrdinal: 1,
      materialProfile: 'fault-boundary',
      requirement: 'none',
    },
    {
      scenario: 'artifact-before-checkpoint-kill',
      scenarioStageOrdinal: 2,
      command: 'close-replan',
      expectedOutcome: 'takeover-completed',
      attemptOrdinal: 2,
      materialProfile: 'success',
      requirement: 'none',
    },
    {
      scenario: 'artifact-before-checkpoint-kill',
      scenarioStageOrdinal: 3,
      command: 'apply',
      expectedOutcome: 'completed',
      attemptOrdinal: 2,
      materialProfile: 'success',
      requirement: 'none',
    },
    {
      scenario: 'artifact-before-checkpoint-kill',
      scenarioStageOrdinal: 4,
      command: 'verify',
      expectedOutcome: 'completed',
      attemptOrdinal: 2,
      materialProfile: 'success',
      requirement: 'terminal',
    },
    {
      scenario: 'artifact-before-checkpoint-kill',
      scenarioStageOrdinal: 5,
      command: 'release',
      expectedOutcome: 'completed',
      attemptOrdinal: 2,
      materialProfile: 'success',
      requirement: 'none',
    },
    {
      scenario: 'transaction-response-loss',
      scenarioStageOrdinal: 1,
      command: 'close-replan',
      expectedOutcome: 'response-loss-reconciled',
      attemptOrdinal: 1,
      materialProfile: 'fault-completion',
      requirement: 'none',
    },
    {
      scenario: 'transaction-response-loss',
      scenarioStageOrdinal: 2,
      command: 'apply',
      expectedOutcome: 'completed',
      attemptOrdinal: 1,
      materialProfile: 'success',
      requirement: 'none',
    },
    {
      scenario: 'transaction-response-loss',
      scenarioStageOrdinal: 3,
      command: 'verify',
      expectedOutcome: 'completed',
      attemptOrdinal: 1,
      materialProfile: 'success',
      requirement: 'terminal',
    },
    {
      scenario: 'transaction-response-loss',
      scenarioStageOrdinal: 4,
      command: 'release',
      expectedOutcome: 'completed',
      attemptOrdinal: 1,
      materialProfile: 'success',
      requirement: 'none',
    },
    {
      scenario: 'lease-expiry-takeover',
      scenarioStageOrdinal: 1,
      command: 'close-replan',
      expectedOutcome: 'fault-reached',
      attemptOrdinal: 1,
      materialProfile: 'fault-boundary',
      requirement: 'none',
    },
    {
      scenario: 'lease-expiry-takeover',
      scenarioStageOrdinal: 2,
      command: 'close-replan',
      expectedOutcome: 'takeover-completed',
      attemptOrdinal: 2,
      materialProfile: 'success',
      requirement: 'none',
    },
    {
      scenario: 'lease-expiry-takeover',
      scenarioStageOrdinal: 3,
      command: 'apply',
      expectedOutcome: 'completed',
      attemptOrdinal: 2,
      materialProfile: 'success',
      requirement: 'none',
    },
    {
      scenario: 'lease-expiry-takeover',
      scenarioStageOrdinal: 4,
      command: 'verify',
      expectedOutcome: 'completed',
      attemptOrdinal: 2,
      materialProfile: 'success',
      requirement: 'terminal',
    },
    {
      scenario: 'lease-expiry-takeover',
      scenarioStageOrdinal: 5,
      command: 'release',
      expectedOutcome: 'completed',
      attemptOrdinal: 2,
      materialProfile: 'success',
      requirement: 'none',
    },
    {
      scenario: 'partial-apply-rollback',
      scenarioStageOrdinal: 1,
      command: 'close-replan',
      expectedOutcome: 'completed',
      attemptOrdinal: 1,
      materialProfile: 'success',
      requirement: 'none',
    },
    {
      scenario: 'partial-apply-rollback',
      scenarioStageOrdinal: 2,
      command: 'apply',
      expectedOutcome: 'fault-reached',
      attemptOrdinal: 1,
      materialProfile: 'fault-boundary',
      requirement: 'complete-apply',
    },
    {
      scenario: 'partial-apply-rollback',
      scenarioStageOrdinal: 3,
      command: 'rollback-partial',
      expectedOutcome: 'takeover-completed',
      attemptOrdinal: 2,
      materialProfile: 'success',
      requirement: 'terminal',
    },
    {
      scenario: 'partial-apply-rollback',
      scenarioStageOrdinal: 4,
      command: 'release',
      expectedOutcome: 'completed',
      attemptOrdinal: 2,
      materialProfile: 'success',
      requirement: 'none',
    },
    {
      scenario: 'complete-apply-rollback',
      scenarioStageOrdinal: 1,
      command: 'close-replan',
      expectedOutcome: 'completed',
      attemptOrdinal: 1,
      materialProfile: 'success',
      requirement: 'none',
    },
    {
      scenario: 'complete-apply-rollback',
      scenarioStageOrdinal: 2,
      command: 'apply',
      expectedOutcome: 'completed',
      attemptOrdinal: 1,
      materialProfile: 'success',
      requirement: 'complete-apply',
    },
    {
      scenario: 'complete-apply-rollback',
      scenarioStageOrdinal: 3,
      command: 'rollback-complete',
      expectedOutcome: 'completed',
      attemptOrdinal: 1,
      materialProfile: 'success',
      requirement: 'terminal',
    },
    {
      scenario: 'complete-apply-rollback',
      scenarioStageOrdinal: 4,
      command: 'release',
      expectedOutcome: 'completed',
      attemptOrdinal: 1,
      materialProfile: 'success',
      requirement: 'none',
    },
  ])

afterEach(async () => {
  for (const directory of temporaryDirectories.splice(0)) {
    await rm(directory, { force: true, recursive: true })
  }
})

/** Encodes one value as exact compact canonical JSON bytes. */
function canonicalBytes(value: unknown): Uint8Array {
  return encoder.encode(serializeCanonicalJson(value))
}

/** Returns whether every byte in one owned key was overwritten. */
function isZeroized(value: Uint8Array): boolean {
  return value.every((byte) => byte === 0)
}

/** Creates one new owner-only temporary test directory. */
async function createPrivateTemporaryDirectory(): Promise<string> {
  const directory = await mkdtemp(join(tmpdir(), 'mukuroji-finalizer-cli-'))
  await chmod(directory, 0o700)
  temporaryDirectories.push(directory)
  return directory
}

/**
 * Selects one actual authenticated manifest entry and narrows its support.
 *
 * @param stageCase - Canonical scenario and command pair.
 * @returns Detached supported selection for the finite CLI boundary.
 */
function createSupportedSelection(
  stageCase: SupportedStageCase,
): WorkspaceSearchMigrationRehearsalGenericSuccessSelectedStage {
  const entry = childFixture.manifest.entries.find((candidate) =>
    candidate.scenario === stageCase.scenario &&
      candidate.command === stageCase.command &&
      candidate.attemptOrdinal === 1 &&
      candidate.expectedOutcome === 'completed'
  )
  if (entry === undefined) throw new Error('Missing supported fixture entry.')
  const selection: WorkspaceSearchMigrationRehearsalSelectedStage =
    Object.freeze({
      manifest: childFixture.manifest,
      manifestDigest: createMigrationDigest(childFixture.manifest),
      entry,
      previousStageReceiptDigest:
        entry.ordinal === 1
          ? null
          : createMigrationDigest({ predecessor: entry.ordinal - 1 }),
    })
  if (!isWorkspaceSearchMigrationRehearsalGenericSuccessSelectedStage(
    selection,
  )) throw new Error('Fixture selection is not generic-success.')
  return selection
}

/**
 * Selects one exact entry from the complete authenticated fixture manifest.
 *
 * @param stageCase - Expected scenario-local identity and finite outcome.
 * @returns Detached selection whose entry exactly matches the matrix row.
 */
function createProofRequirementSelection(
  stageCase: ProofRequirementStageCase,
): WorkspaceSearchMigrationRehearsalSupportedSelectedStage {
  const entry = childFixture.manifest.entries.find((candidate) =>
    candidate.scenario === stageCase.scenario &&
      candidate.scenarioStageOrdinal === stageCase.scenarioStageOrdinal
  )
  if (
    entry === undefined ||
    entry.command !== stageCase.command ||
    entry.expectedOutcome !== stageCase.expectedOutcome ||
    entry.attemptOrdinal !== stageCase.attemptOrdinal
  ) throw new Error('Fixture manifest entry does not match the matrix.')
  return Object.freeze({
    manifest: childFixture.manifest,
    manifestDigest: createMigrationDigest(childFixture.manifest),
    entry,
    previousStageReceiptDigest:
      entry.ordinal === 1
        ? null
        : createMigrationDigest({ predecessor: entry.ordinal - 1 }),
  })
}

/** Returns the exact command suffix selected by an authenticated stage. */
function createProofArguments(
  requirement:
    WorkspaceSearchMigrationRehearsalStageFinalizerProofRequirement,
): string[] {
  if (requirement === 'none') return []
  if (requirement === 'planning-receipt') {
    return [
      '--planning-receipt-file',
      paths.planningReceipt,
    ]
  }
  if (requirement === 'complete-apply') {
    return [
      '--target-preimage-audit-file',
      paths.targetPreimage,
      '--target-audit-key-file',
      paths.targetAuditKey,
    ]
  }
  return [
    '--planning-receipt-file',
    paths.planningReceipt,
    '--reconciliation-artifact-file',
    paths.reconciliationArtifact,
  ]
}

/**
 * Returns the exact ordered material prefix selected by one process outcome.
 *
 * @param profile - Strict success, stopped-fault, or response-loss protocol.
 * @returns Ordered material-specific CLI arguments.
 */
function createMaterialArguments(profile: MaterialProfile): string[] {
  const common = [
    '--material-file',
    paths.material,
  ]
  if (profile === 'success') return common
  if (profile === 'fault-boundary') {
    return [
      ...common,
      '--fault-plan-file',
      paths.faultPlan,
      '--boundary-rate-segment-file',
      paths.boundaryRateSegment,
    ]
  }
  return [
    ...common,
    '--boundary-material-file',
    paths.boundaryMaterial,
    '--fault-plan-file',
    paths.faultPlan,
    '--boundary-rate-segment-file',
    paths.boundaryRateSegment,
    '--final-rate-segment-file',
    paths.finalRateSegment,
  ]
}

/**
 * Builds one exact strictly ordered finalizer command.
 *
 * @param requirement - Authenticated stage-derived proof profile.
 * @param materialProfile - Authenticated outcome-derived material profile.
 * @returns Exact ordered offline finalizer argument vector.
 */
function createCliArguments(
  requirement:
    WorkspaceSearchMigrationRehearsalStageFinalizerProofRequirement,
  materialProfile: MaterialProfile = 'success',
): string[] {
  return [
    '--manifest-file',
    paths.manifest,
    '--previous-receipt-file',
    paths.previousReceipt,
    ...createMaterialArguments(materialProfile),
    '--lifecycle-file',
    paths.lifecycle,
    '--parent-authentication-file',
    paths.parentAuthentication,
    '--stage-key-file',
    paths.stageKey,
    '--control-arguments-file',
    paths.controlArguments,
    ...createProofArguments(requirement),
    '--output-file',
    paths.output,
    '--approval',
    WORKSPACE_SEARCH_MIGRATION_REHEARSAL_STAGE_FINALIZER_CLI_APPROVAL,
  ]
}

/**
 * Creates one recording finite dependency boundary for a selected stage.
 *
 * @param selection - Authenticated supported stage returned after selection.
 * @param faultPlan - Canonical fault plan read before authenticated selection.
 * @returns Dependencies and retained observations for zeroization assertions.
 */
function createCliHarness(
  selection: WorkspaceSearchMigrationRehearsalSupportedSelectedStage,
  faultPlan: unknown = faultBoundaryFixture.faultPlan,
) {
  const files = new Map<string, Uint8Array>([
    [paths.manifest, canonicalBytes({ manifest: true })],
    [paths.previousReceipt, canonicalBytes(null)],
    [paths.material, canonicalBytes({ material: true })],
    [paths.boundaryMaterial, canonicalBytes({ boundaryMaterial: true })],
    [paths.faultPlan, canonicalBytes(faultPlan)],
    [paths.boundaryRateSegment, encoder.encode('boundary-rate-segment')],
    [paths.finalRateSegment, encoder.encode('final-rate-segment')],
    [paths.lifecycle, canonicalBytes({ lifecycle: true })],
    [paths.parentAuthentication, canonicalBytes({ authentication: true })],
    [paths.controlArguments, canonicalBytes(['reviewed-control'])],
    [paths.planningReceipt, canonicalBytes(outputReceipt)],
    [
      paths.reconciliationArtifact,
      canonicalBytes({ reconciliation: 'actual-artifact' }),
    ],
    [paths.targetPreimage, canonicalBytes({ target: 'preimage' })],
  ])
  const readerOwnedBuffers: Uint8Array[] = []
  const readerOwnedKeys: Uint8Array[] = []
  const finalizerInputs:
    FinalizeWorkspaceSearchMigrationRehearsalStageReceiptInput[] = []
  const selectionInputs: Parameters<
    WorkspaceSearchMigrationRehearsalStageFinalizerCliDependencies[
      'selectStage'
    ]
  >[0][] = []
  const reconciliationArtifactCopies: Uint8Array[] = []
  const outputBufferReferences: Uint8Array[] = []
  const outputCopies: Uint8Array[] = []
  const stdoutLines: string[] = []
  const stderrLines: string[] = []
  const dependencies:
    WorkspaceSearchMigrationRehearsalStageFinalizerCliDependencies = {
      readPrivateInputFile: async (path, maximumBytes) => {
        const source = files.get(path)
        if (source === undefined || source.byteLength > maximumBytes) {
          throw new Error('Private fixture is unavailable.')
        }
        const owned = new Uint8Array(source)
        readerOwnedBuffers.push(owned)
        return owned
      },
      readKeyFile: async (path) => {
        if (
          path !== paths.stageKey &&
          path !== paths.targetAuditKey
        ) throw new Error('Key fixture is unavailable.')
        const owned = new Uint8Array(32).fill(
          path === paths.stageKey ? 11 : 37,
        )
        readerOwnedKeys.push(owned)
        return owned
      },
      selectStage: (input) => {
        selectionInputs.push(input)
        return selection
      },
      finalizeStageReceipt: (input) => {
        finalizerInputs.push(input)
        if (input.proof.kind === 'terminal') {
          reconciliationArtifactCopies.push(
            new Uint8Array(input.proof.reconciliationArtifactBytes),
          )
        }
        return outputReceipt
      },
      writeReceiptFileExclusive: async (_outputPath, receiptBytes) => {
        outputBufferReferences.push(receiptBytes)
        outputCopies.push(new Uint8Array(receiptBytes))
        return 'created'
      },
      writeStdoutLine: (line) => {
        stdoutLines.push(line)
      },
      writeStderrLine: (line) => {
        stderrLines.push(line)
      },
    }
  return {
    dependencies,
    finalizerInputs,
    reconciliationArtifactCopies,
    outputBufferReferences,
    outputCopies,
    readerOwnedBuffers,
    readerOwnedKeys,
    selectionInputs,
    stderrLines,
    stdoutLines,
  }
}

describe('Workspace Search migration rehearsal stage finalizer CLI parser', () => {
  test('accepts exactly the three material and four proof profiles', () => {
    for (const materialProfile of [
      'success',
      'fault-boundary',
      'fault-completion',
    ] satisfies readonly MaterialProfile[]) {
      for (const requirement of [
        'none',
        'planning-receipt',
        'complete-apply',
        'terminal',
      ] satisfies readonly WorkspaceSearchMigrationRehearsalStageFinalizerProofRequirement[]) {
        const parsed =
          parseWorkspaceSearchMigrationRehearsalStageFinalizerCliArguments(
            createCliArguments(requirement, materialProfile),
          )
        expect(parsed.materialKind).toBe(materialProfile)
        expect(parsed.proofFiles.kind).toBe(requirement)
        expect(parsed.outputFile).toBe(paths.output)
        if (parsed.materialKind === 'fault-boundary') {
          expect(parsed.faultPlanFile).toBe(paths.faultPlan)
          expect(parsed.boundaryRateSegmentFile).toBe(
            paths.boundaryRateSegment,
          )
        }
        if (parsed.materialKind === 'fault-completion') {
          expect(parsed.boundaryMaterialFile).toBe(paths.boundaryMaterial)
          expect(parsed.faultPlanFile).toBe(paths.faultPlan)
          expect(parsed.boundaryRateSegmentFile).toBe(
            paths.boundaryRateSegment,
          )
          expect(parsed.finalRateSegmentFile).toBe(paths.finalRateSegment)
        }
      }
    }
  })

  test('rejects incomplete, reordered, mixed, and aliased material profiles', () => {
    const boundary = createCliArguments('none', 'fault-boundary')
    const completion = createCliArguments('none', 'fault-completion')
    const boundaryReordered = boundary.map((value) => {
      if (value === '--fault-plan-file') return '--boundary-rate-segment-file'
      if (value === '--boundary-rate-segment-file') return '--fault-plan-file'
      return value
    })
    const completionReordered = completion.map((value) => {
      if (value === '--boundary-material-file') return '--fault-plan-file'
      if (value === '--fault-plan-file') return '--boundary-material-file'
      return value
    })
    const aliasedBoundary = boundary.map((value) =>
      value === paths.faultPlan ? paths.material : value
    )
    const lifecycleOffset = boundary.indexOf('--lifecycle-file')
    if (lifecycleOffset < 0) throw new Error('Missing lifecycle flag.')
    const mixedBoundary = [
      ...boundary.slice(0, lifecycleOffset),
      '--final-rate-segment-file',
      paths.finalRateSegment,
      ...boundary.slice(lifecycleOffset),
    ]
    for (const invalid of [
      boundary.slice(0, 8),
      completion.slice(0, 12),
      boundaryReordered,
      completionReordered,
      aliasedBoundary,
      mixedBoundary,
    ]) {
      expect(() =>
        parseWorkspaceSearchMigrationRehearsalStageFinalizerCliArguments(
          invalid,
        )
      ).toThrow('INVALID_USAGE')
    }
  })

  test('rejects reordering, extras, aliases, derived claims, and bad approval', () => {
    const valid = createCliArguments('none')
    const reordered = [...valid]
    const firstFlag = reordered[0]
    const secondFlag = reordered[2]
    if (firstFlag === undefined || secondFlag === undefined) {
      throw new Error('Missing parser fixture flags.')
    }
    reordered[0] = secondFlag
    reordered[2] = firstFlag
    const aliased = valid.map((value) =>
      value === paths.output ? paths.manifest : value
    )
    const badApproval = valid.map((value) =>
      value ===
          WORKSPACE_SEARCH_MIGRATION_REHEARSAL_STAGE_FINALIZER_CLI_APPROVAL
        ? 'not-approved'
        : value
    )
    const derivedClaim = [
      ...valid.slice(0, -4),
      '--writer-fence-digest',
      'a'.repeat(64),
      ...valid.slice(-4),
    ]
    for (const invalid of [
      valid.slice(0, -1),
      [...valid, '--extra'],
      reordered,
      aliased,
      badApproval,
      derivedClaim,
    ]) {
      expect(() =>
        parseWorkspaceSearchMigrationRehearsalStageFinalizerCliArguments(
          invalid,
        )
      ).toThrow('INVALID_USAGE')
    }
  })
})

describe('Workspace Search migration rehearsal stage proof requirements', () => {
  test('derives the exact proof profile for all 36 authenticated stages', () => {
    expect(childFixture.manifest.entries).toHaveLength(36)
    expect(proofRequirementStageCases).toHaveLength(36)
    for (const [index, stageCase] of proofRequirementStageCases.entries()) {
      const selection = createProofRequirementSelection(stageCase)
      expect(selection.entry.ordinal).toBe(index + 1)
      expect(
        determineWorkspaceSearchMigrationRehearsalStageFinalizerProofRequirement(
          selection,
        ),
      ).toBe(stageCase.requirement)
      const outcomeMaterialProfile: MaterialProfile =
        selection.entry.expectedOutcome === 'fault-reached'
          ? 'fault-boundary'
          : selection.entry.expectedOutcome === 'response-loss-reconciled'
          ? 'fault-completion'
          : 'success'
      expect(outcomeMaterialProfile).toBe(stageCase.materialProfile)
    }
  })
})

describe('Workspace Search migration rehearsal stage finalizer CLI', () => {
  for (const stageCase of supportedStageCases) {
    test(`derives proof and finalizes ${stageCase.scenario} ${stageCase.command}`, async () => {
      const selection = createSupportedSelection(stageCase)
      expect(
        determineWorkspaceSearchMigrationRehearsalStageFinalizerProofRequirement(
          selection,
        ),
      ).toBe(stageCase.requirement)
      const harness = createCliHarness(selection)

      expect(await runWorkspaceSearchMigrationRehearsalStageFinalizerCli(
        createCliArguments(stageCase.requirement),
        harness.dependencies,
      )).toBe(0)

      expect(harness.finalizerInputs).toHaveLength(1)
      const finalizerInput = harness.finalizerInputs[0]
      if (finalizerInput === undefined) {
        throw new Error('Finalizer input was not captured.')
      }
      expect(finalizerInput.proof.kind).toBe(stageCase.proofKind)
      if (finalizerInput.proof.kind === 'apply') {
        expect(finalizerInput.proof.targetPreimageAudit === null).toBe(
          stageCase.scenario === 'happy-path-verified',
        )
      }
      if (finalizerInput.proof.kind === 'terminal') {
        expect(harness.reconciliationArtifactCopies).toEqual([
          canonicalBytes({ reconciliation: 'actual-artifact' }),
        ])
        expect(isZeroized(
          finalizerInput.proof.reconciliationArtifactBytes,
        )).toBe(true)
      }
      expect(harness.outputCopies).toEqual([
        canonicalBytes(outputReceipt),
      ])
      const expectedDigest = createHash('sha256')
        .update(canonicalBytes(outputReceipt))
        .digest('hex')
      expect(harness.stdoutLines).toEqual([
        serializeCanonicalJson({
          kind:
            WORKSPACE_SEARCH_MIGRATION_REHEARSAL_STAGE_FINALIZER_CLI_RESULT_KIND,
          status: 'succeeded',
          receiptDigest: expectedDigest,
        }),
      ])
      expect(harness.stderrLines).toEqual([])
      for (const buffer of [
        ...harness.readerOwnedBuffers,
        ...harness.readerOwnedKeys,
        ...harness.outputBufferReferences,
      ]) expect(isZeroized(buffer)).toBe(true)
      expect(isZeroized(finalizerInput.runtimeAuthenticationKey)).toBe(true)
      expect(isZeroized(
        finalizerInput.publicationAuthenticationKey,
      )).toBe(true)
      if (finalizerInput.proof.kind === 'apply' &&
        finalizerInput.proof.targetPreimageAudit !== null) {
        expect(isZeroized(
          finalizerInput.proof.targetPreimageAudit.verificationKey,
        )).toBe(true)
      }
    })
  }

  test('loads planning-receipt proof for a takeover-completed apply', async () => {
    const stageCase = proofRequirementStageCases.find((candidate) =>
      candidate.scenario === 'cursor-before-commit-kill' &&
        candidate.scenarioStageOrdinal === 3
    )
    if (stageCase === undefined) throw new Error('Missing takeover fixture.')
    const selection = createProofRequirementSelection(stageCase)
    const harness = createCliHarness(selection)

    expect(await runWorkspaceSearchMigrationRehearsalStageFinalizerCli(
      createCliArguments('planning-receipt'),
      harness.dependencies,
    )).toBe(0)

    const finalizerInput = harness.finalizerInputs[0]
    if (finalizerInput === undefined) {
      throw new Error('Finalizer input was not captured.')
    }
    expect(finalizerInput.materialKind).toBe('success')
    expect(finalizerInput.proof.kind).toBe('apply')
    if (finalizerInput.proof.kind !== 'apply') {
      throw new Error('Expected apply proof.')
    }
    expect(finalizerInput.proof.planningReceipt).toEqual(outputReceipt)
    expect(finalizerInput.proof.targetPreimageAudit).toBeNull()
  })

  test('routes stopped-fault and response-loss material unions', async () => {
    const materialCases: readonly InjectedMaterialCase[] = Object.freeze([
      Object.freeze({
        profile: 'fault-boundary',
        selection: faultBoundaryFixture.selection,
        faultPlan: faultBoundaryFixture.faultPlan,
      }),
      Object.freeze({
        profile: 'fault-completion',
        selection: faultCompletionFixture.selection,
        faultPlan: faultCompletionFixture.faultPlan,
      }),
    ])
    for (const materialCase of materialCases) {
      const harness = createCliHarness(
        materialCase.selection,
        materialCase.faultPlan,
      )

      expect(await runWorkspaceSearchMigrationRehearsalStageFinalizerCli(
        createCliArguments('none', materialCase.profile),
        harness.dependencies,
      )).toBe(0)

      expect(harness.selectionInputs).toHaveLength(1)
      expect(harness.selectionInputs[0]?.faultPlanDigest).toBe(
        createMigrationDigest(materialCase.faultPlan),
      )
      const finalizerInput = harness.finalizerInputs[0]
      if (finalizerInput === undefined) {
        throw new Error('Finalizer input was not captured.')
      }
      expect(finalizerInput.materialKind).toBe(materialCase.profile)
      expect(finalizerInput.persistedMaterialEvidence).toEqual({
        material: true,
      })
      if (finalizerInput.materialKind === 'fault-boundary') {
        expect(finalizerInput.faultPlan).toEqual(materialCase.faultPlan)
        expect(isZeroized(
          finalizerInput.boundaryRateSegmentBytes,
        )).toBe(true)
      }
      if (finalizerInput.materialKind === 'fault-completion') {
        expect(finalizerInput.persistedBoundaryMaterialEvidence).toEqual({
          boundaryMaterial: true,
        })
        expect(finalizerInput.faultPlan).toEqual(materialCase.faultPlan)
        expect(isZeroized(
          finalizerInput.boundaryRateSegmentBytes,
        )).toBe(true)
        expect(isZeroized(finalizerInput.finalRateSegmentBytes)).toBe(true)
      }
    }
  })

  test('fails closed when material profile disagrees with outcome', async () => {
    const happySelection = createSupportedSelection({
      scenario: 'happy-path-verified',
      command: 'close-replan',
      proofKind: 'planning',
      requirement: 'none',
    })
    const mismatches: readonly InjectedMaterialCase[] = Object.freeze([
      Object.freeze({
        selection: faultBoundaryFixture.selection,
        faultPlan: faultBoundaryFixture.faultPlan,
        profile: 'success',
      }),
      Object.freeze({
        selection: faultCompletionFixture.selection,
        faultPlan: faultCompletionFixture.faultPlan,
        profile: 'fault-boundary',
      }),
      Object.freeze({
        selection: happySelection,
        faultPlan: faultBoundaryFixture.faultPlan,
        profile: 'fault-boundary',
      }),
    ])
    for (const mismatch of mismatches) {
      const harness = createCliHarness(mismatch.selection, mismatch.faultPlan)

      expect(await runWorkspaceSearchMigrationRehearsalStageFinalizerCli(
        createCliArguments('none', mismatch.profile),
        harness.dependencies,
      )).toBe(2)
      expect(harness.finalizerInputs).toEqual([])
      expect(harness.stdoutLines).toEqual([])
      expect(harness.stderrLines).toEqual([
        serializeCanonicalJson({
          kind:
            WORKSPACE_SEARCH_MIGRATION_REHEARSAL_STAGE_FINALIZER_CLI_RESULT_KIND,
          status: 'error',
          code: 'UNSUPPORTED_STAGE',
        }),
      ])
    }
  })

  test('fails closed when proof flags disagree with authenticated selection', async () => {
    const selection = createSupportedSelection({
      scenario: 'complete-apply-rollback',
      command: 'apply',
      proofKind: 'apply',
      requirement: 'complete-apply',
    })
    const harness = createCliHarness(selection)

    expect(await runWorkspaceSearchMigrationRehearsalStageFinalizerCli(
      createCliArguments('none'),
      harness.dependencies,
    )).toBe(2)
    expect(harness.finalizerInputs).toEqual([])
    expect(harness.stdoutLines).toEqual([])
    expect(harness.stderrLines).toEqual([
      serializeCanonicalJson({
        kind:
          WORKSPACE_SEARCH_MIGRATION_REHEARSAL_STAGE_FINALIZER_CLI_RESULT_KIND,
        status: 'error',
        code: 'INVALID_PROOF',
      }),
    ])
    for (const key of harness.readerOwnedKeys) {
      expect(isZeroized(key)).toBe(true)
    }
  })
})

describe('Workspace Search migration rehearsal stage finalizer private I/O', () => {
  test('private readers reject symlinks, non-private mode, and hard links', async () => {
    const directory = await createPrivateTemporaryDirectory()
    const document = join(directory, 'document.json')
    const documentSymlink = join(directory, 'document-symlink.json')
    const documentHardlink = join(directory, 'document-hardlink.json')
    const key = join(directory, 'stage.key')
    const keySymlink = join(directory, 'stage-symlink.key')
    const keyHardlink = join(directory, 'stage-hardlink.key')
    await writeFile(document, canonicalBytes({ private: true }), {
      flag: 'wx',
      mode: 0o600,
    })
    await writeFile(key, new Uint8Array(32).fill(73), {
      flag: 'wx',
      mode: 0o600,
    })
    expect(await readWorkspaceSearchMigrationRehearsalPrivateInputFile(
      document,
      1_024,
    )).toEqual(canonicalBytes({ private: true }))
    expect(await readWorkspaceSearchMigrationRehearsalStageFinalizerKeyFile(
      key,
    )).toEqual(new Uint8Array(32).fill(73))

    await symlink(document, documentSymlink)
    await symlink(key, keySymlink)
    await expect(
      readWorkspaceSearchMigrationRehearsalPrivateInputFile(
        documentSymlink,
        1_024,
      ),
    ).rejects.toThrow()
    await expect(
      readWorkspaceSearchMigrationRehearsalStageFinalizerKeyFile(keySymlink),
    ).rejects.toThrow('INVALID_STAGE_KEY')

    await chmod(document, 0o640)
    await chmod(key, 0o640)
    await expect(
      readWorkspaceSearchMigrationRehearsalPrivateInputFile(document, 1_024),
    ).rejects.toThrow()
    await expect(
      readWorkspaceSearchMigrationRehearsalStageFinalizerKeyFile(key),
    ).rejects.toThrow('INVALID_STAGE_KEY')

    await chmod(document, 0o600)
    await chmod(key, 0o600)
    await link(document, documentHardlink)
    await link(key, keyHardlink)
    await expect(
      readWorkspaceSearchMigrationRehearsalPrivateInputFile(document, 1_024),
    ).rejects.toThrow()
    await expect(
      readWorkspaceSearchMigrationRehearsalStageFinalizerKeyFile(key),
    ).rejects.toThrow('INVALID_STAGE_KEY')
  })

  test('publishes canonical mode-0600 single-link output atomically', async () => {
    const directory = await createPrivateTemporaryDirectory()
    const output = join(directory, 'receipt.json')
    const receiptBytes = canonicalBytes({ receipt: 'created' })

    expect(
      await writeWorkspaceSearchMigrationRehearsalStageReceiptFileExclusive(
        output,
        receiptBytes,
      ),
    ).toBe('created')
    expect(Array.from(await readFile(output))).toEqual(
      Array.from(receiptBytes),
    )
    const status = await stat(output)
    expect(status.mode & 0o7777).toBe(0o600)
    expect(status.nlink).toBe(1)
    expect((await readdir(directory)).some((name) =>
      name.startsWith('.mukuroji-stage-receipt-')
    )).toBe(false)
  })

  test('rejects existing, symlinked, non-private, and hard-linked outputs', async () => {
    const receiptBytes = canonicalBytes({ receipt: 'collision' })

    const existingDirectory = await createPrivateTemporaryDirectory()
    const existingOutput = join(existingDirectory, 'receipt.json')
    await writeFile(existingOutput, receiptBytes, { mode: 0o600 })
    expect(
      await writeWorkspaceSearchMigrationRehearsalStageReceiptFileExclusive(
        existingOutput,
        receiptBytes,
      ),
    ).toBe('exists')

    const symlinkDirectory = await createPrivateTemporaryDirectory()
    const symlinkTarget = join(symlinkDirectory, 'target.json')
    const symlinkOutput = join(symlinkDirectory, 'receipt.json')
    await writeFile(symlinkTarget, receiptBytes, { mode: 0o600 })
    await symlink(symlinkTarget, symlinkOutput)
    expect(
      await writeWorkspaceSearchMigrationRehearsalStageReceiptFileExclusive(
        symlinkOutput,
        receiptBytes,
      ),
    ).toBe('exists')

    const modeDirectory = await createPrivateTemporaryDirectory()
    const modeOutput = join(modeDirectory, 'receipt.json')
    await chmod(modeDirectory, 0o750)
    await expect(
      writeWorkspaceSearchMigrationRehearsalStageReceiptFileExclusive(
        modeOutput,
        receiptBytes,
      ),
    ).rejects.toThrow('OUTPUT_FILE_WRITE_FAILED')

    const hardlinkDirectory = await createPrivateTemporaryDirectory()
    const hardlinkSource = join(hardlinkDirectory, 'source.json')
    const hardlinkOutput = join(hardlinkDirectory, 'receipt.json')
    await writeFile(hardlinkSource, receiptBytes, { mode: 0o600 })
    await link(hardlinkSource, hardlinkOutput)
    expect(
      await writeWorkspaceSearchMigrationRehearsalStageReceiptFileExclusive(
        hardlinkOutput,
        receiptBytes,
      ),
    ).toBe('exists')
  })

  test('reconciles link success followed by response loss', async () => {
    const directory = await createPrivateTemporaryDirectory()
    const output = join(directory, 'receipt.json')
    const receiptBytes = canonicalBytes({ receipt: 'response-loss' })

    expect(
      await writeWorkspaceSearchMigrationRehearsalStageReceiptFileExclusive(
        output,
        receiptBytes,
        {
          ...workspaceSearchMigrationRehearsalStageReceiptNodePublicationDependencies,
          linkFile: async (temporaryPath, finalPath) => {
            await link(temporaryPath, finalPath)
            throw new Error('simulated response loss')
          },
        },
      ),
    ).toBe('reconciled')
    expect(Array.from(await readFile(output))).toEqual(
      Array.from(receiptBytes),
    )
    expect((await stat(output)).nlink).toBe(1)
    expect((await readdir(directory)).some((name) =>
      name.startsWith('.mukuroji-stage-receipt-')
    )).toBe(false)
  })

  test('rejects non-canonical and over-128-KiB receipt bytes', async () => {
    const directory = await createPrivateTemporaryDirectory()
    await expect(
      writeWorkspaceSearchMigrationRehearsalStageReceiptFileExclusive(
        join(directory, 'non-canonical.json'),
        encoder.encode('{ "receipt": true }'),
      ),
    ).rejects.toThrow('OUTPUT_FILE_WRITE_FAILED')
    await expect(
      writeWorkspaceSearchMigrationRehearsalStageReceiptFileExclusive(
        join(directory, 'oversized.json'),
        canonicalBytes('x'.repeat(128 * 1_024)),
      ),
    ).rejects.toThrow('OUTPUT_FILE_WRITE_FAILED')
  })
})
