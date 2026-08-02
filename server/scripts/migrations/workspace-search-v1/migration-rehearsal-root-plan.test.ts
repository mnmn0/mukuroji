import { Buffer } from 'node:buffer'
import assert from 'node:assert/strict'
import { describe, mock, test } from 'bun:test'
import {
  CROSS_DOMAIN_INTEGRITY_FILE_BUCKET_MARKER_KEY,
} from '../../data-integrity/cross-domain-integrity'
import { serializeCanonicalJson } from './migration-contract'
import {
  createWorkspaceSearchMigrationRequestedResourcesBinding,
} from './migration-identity'

/** Dedicated environment selector used only by isolated mock workers. */
const workerScenarioEnvironmentName =
  'MUKUROJI_ROOT_PLAN_TEST_WORKER_SCENARIO'

/** Exact enabled target identifier supplied only by the isolated mock. */
const enabledTargetId = 'root-plan-test'

/** Exact disabled target identifier supplied only by the isolated mock. */
const disabledTargetId = 'root-plan-disabled-test'

/** Exact non-production account supplied by the isolated mock. */
const deploymentAccount = '123456789012'

/** Exact non-production Region supplied by the isolated mock. */
const deploymentRegion = 'ap-northeast-1'

/** Exact test-only deployment trust-root digest. */
const deploymentTrustRootDigest = 'a'.repeat(64)

/** Exact test-only distinct production-account digest. */
const productionAccountDigest = 'b'.repeat(64)

/** Exact canonical base64 SHA-256 marker checksum. */
const markerChecksum = Buffer.alloc(32, 7).toString('base64')

/**
 * Creates one complete mutable valid root-plan candidate.
 *
 * @returns Fresh owner-only test plan safe for case-local mutation.
 */
function createValidPlan() {
  return {
    kind: 'mukuroji-workspace-search-migration-rehearsal-root-plan',
    version: 1,
    approval:
      'bootstrap-reviewed-non-production-migration-rehearsal-root',
    deploymentTargetId: enabledTargetId,
    expectedCallerArn:
      `arn:aws:sts::${deploymentAccount}:assumed-role/MigrationRehearsal/root-plan-test`,
    expectedConfigurationBindingDigest: 'd'.repeat(64),
    requestedResources: {
      account: deploymentAccount,
      region: deploymentRegion,
      profile: 'migration-rehearsal-test',
      commit: 'c'.repeat(40),
      tables: {
        'project-directory': 'root-project-directory',
        'work-items': 'root-work-items',
        collaboration: 'root-collaboration',
        documents: 'root-documents',
        'workspace-search': 'root-workspace-search',
        'migration-state': 'root-migration-state',
      },
      journalBucket: 'root-migration-journal',
      journalKeyArn:
        `arn:aws:kms:${deploymentRegion}:${deploymentAccount}:key/11111111-2222-3333-4444-555555555555`,
    },
    integrityResources: {
      tables: {
        'audit-events': 'root-audit-events',
        'file-proofing': 'root-file-proofing',
        'project-directory': 'root-project-directory',
        'work-item-configuration': 'root-work-item-configuration',
        'work-items': 'root-work-items',
        'workspace-access': 'root-workspace-access',
      },
      fileBucket: 'root-file-bucket',
      marker: {
        key: CROSS_DOMAIN_INTEGRITY_FILE_BUCKET_MARKER_KEY,
        versionId: 'marker-version-id',
        checksumSha256: markerChecksum,
        size: 128,
      },
    },
    maximumDurationMilliseconds: 60_000,
  }
}

/**
 * Encodes one test plan as exact canonical UTF-8 JSON bytes.
 *
 * @param plan - JSON-compatible root-plan candidate.
 * @returns Exact canonical UTF-8 bytes.
 */
function encodeCanonicalPlan(plan: ReturnType<typeof createValidPlan>): Uint8Array {
  return new TextEncoder().encode(serializeCanonicalJson(plan))
}

/**
 * Requires one operation to fail only with the stable root-plan boundary.
 *
 * @param operation - Candidate invalid parse operation.
 */
function assertInvalidRootPlan(operation: () => unknown): void {
  assert.throws(operation, {
    name: 'WorkspaceSearchMigrationRehearsalRootPlanError',
    message: 'INVALID_REHEARSAL_ROOT_PLAN',
  })
}

/**
 * Mutates one fresh valid plan and requires the in-memory parser to reject it.
 *
 * @param parse - Production in-memory parser imported by the mock worker.
 * @param mutate - Case-local invalid mutation.
 */
function assertMutationRejected(
  parse: (value: unknown) => unknown,
  mutate: (plan: ReturnType<typeof createValidPlan>) => void,
): void {
  const plan = createValidPlan()
  mutate(plan)
  assertInvalidRootPlan(() => parse(plan))
}

/**
 * Runs one scenario in a fresh process so Bun's persistent module mock cannot
 * affect any other test file in the full suite.
 *
 * @param scenario - Exact isolated worker scenario name.
 */
async function runIsolatedWorker(scenario: string): Promise<void> {
  const subprocess = Bun.spawn({
    cmd: [process.execPath, import.meta.path],
    env: {
      ...process.env,
      [workerScenarioEnvironmentName]: scenario,
    },
    stdout: 'pipe',
    stderr: 'pipe',
  })
  const [exitCode, standardOutput, standardError] = await Promise.all([
    subprocess.exited,
    new Response(subprocess.stdout).text(),
    new Response(subprocess.stderr).text(),
  ])
  assert.equal(
    exitCode,
    0,
    `isolated root-plan worker failed: ${standardError}${standardOutput}`,
  )
}

/**
 * Executes one valid-path scenario after installing a process-isolated target
 * resolver mock and dynamically importing the production parser.
 *
 * @param scenario - Exact isolated scenario name.
 */
async function executeWorkerScenario(scenario: string): Promise<void> {
  const resolvedTargetIds: string[] = []

  /**
   * Resolves the sole test target while preserving disabled and unknown paths.
   *
   * @param targetId - Exact parser-supplied target identifier.
   * @returns Complete enabled non-production trust root.
   */
  function resolveTestTarget(targetId: string) {
    resolvedTargetIds.push(targetId)
    if (targetId === disabledTargetId) {
      throw new Error('Workspace Search migration rehearsal target is not enabled.')
    }
    if (targetId !== enabledTargetId) {
      throw new Error('Unknown Workspace Search migration deployment target.')
    }
    return Object.freeze({
      targetId,
      version: 1,
      environment: 'non-production',
      deploymentAccount,
      productionAccountDigest,
      region: deploymentRegion,
      rehearsalEnabled: true,
      digest: deploymentTrustRootDigest,
    })
  }

  mock.module('./migration-deployment-targets', () => ({
    resolveWorkspaceSearchMigrationRehearsalDeploymentTarget:
      resolveTestTarget,
  }))
  const rootPlan = await import('./migration-rehearsal-root-plan')
  const parse = rootPlan.parseWorkspaceSearchMigrationRehearsalRootPlan
  const parseDocument =
    rootPlan.parseWorkspaceSearchMigrationRehearsalRootPlanDocument

  switch (scenario) {
    case 'valid-canonical': {
      const input = createValidPlan()
      const result = parse(input)
      assert.equal(result.document.deploymentTargetId, enabledTargetId)
      assert.equal(
        result.deploymentTrustRootDigest,
        deploymentTrustRootDigest,
      )
      assert.equal(result.productionAccountDigest, productionAccountDigest)
      assert.equal(
        result.requestedResourcesBinding,
        createWorkspaceSearchMigrationRequestedResourcesBinding(
          result.document.requestedResources,
        ),
      )
      assert.equal(
        result.configurationBindingDigest,
        input.expectedConfigurationBindingDigest,
      )
      assert.deepEqual(result.allowedDescribeTableNames, [
        'root-project-directory',
        'root-work-items',
        'root-collaboration',
        'root-documents',
        'root-workspace-search',
        'root-migration-state',
        'root-audit-events',
        'root-file-proofing',
        'root-work-item-configuration',
        'root-workspace-access',
      ])
      assert.equal(new Set(result.allowedDescribeTableNames).size, 10)
      assert.deepEqual(resolvedTargetIds, [enabledTargetId])

      const parsedDocument = parseDocument(encodeCanonicalPlan(input))
      assert.deepEqual(parsedDocument.document, result.document)
      assert.deepEqual(resolvedTargetIds, [enabledTargetId, enabledTargetId])
      return
    }
    case 'target-selection': {
      assertMutationRejected(parse, (plan) => {
        plan.deploymentTargetId = disabledTargetId
      })
      assertMutationRejected(parse, (plan) => {
        plan.deploymentTargetId = 'unknown-root-plan-target'
      })
      assert.deepEqual(resolvedTargetIds, [
        disabledTargetId,
        'unknown-root-plan-target',
      ])
      return
    }
    case 'identity-drift': {
      assertMutationRejected(parse, (plan) => {
        plan.expectedCallerArn =
          'arn:aws:iam::123456789012:role/MigrationRehearsal'
      })
      assertMutationRejected(parse, (plan) => {
        plan.expectedCallerArn =
          'arn:aws:sts::999999999999:assumed-role/MigrationRehearsal/root-plan-test'
      })
      assertMutationRejected(parse, (plan) => {
        plan.requestedResources.account = '999999999999'
        plan.requestedResources.journalKeyArn =
          `arn:aws:kms:${deploymentRegion}:999999999999:key/11111111-2222-3333-4444-555555555555`
      })
      assertMutationRejected(parse, (plan) => {
        plan.requestedResources.region = 'us-west-2'
        plan.requestedResources.journalKeyArn =
          `arn:aws:kms:us-west-2:${deploymentAccount}:key/11111111-2222-3333-4444-555555555555`
      })
      return
    }
    case 'table-collisions': {
      assertMutationRejected(parse, (plan) => {
        plan.integrityResources.tables['project-directory'] =
          'different-project-directory'
      })
      assertMutationRejected(parse, (plan) => {
        plan.integrityResources.tables['audit-events'] =
          plan.requestedResources.tables.documents
      })
      assertMutationRejected(parse, (plan) => {
        plan.integrityResources.tables['file-proofing'] =
          plan.integrityResources.tables['audit-events']
      })
      assertMutationRejected(parse, (plan) => {
        plan.requestedResources.tables.documents =
          plan.requestedResources.tables.collaboration
      })
      return
    }
    case 'resource-fields': {
      assertMutationRejected(parse, (plan) => {
        plan.requestedResources.tables.documents = 'x'
      })
      assertMutationRejected(parse, (plan) => {
        plan.requestedResources.journalBucket = 'xn--reserved-bucket'
      })
      assertMutationRejected(parse, (plan) => {
        plan.integrityResources.fileBucket = '192.168.0.1'
      })
      assertMutationRejected(parse, (plan) => {
        plan.requestedResources.journalKeyArn =
          `arn:aws:kms:us-west-2:${deploymentAccount}:key/11111111-2222-3333-4444-555555555555`
      })
      assertMutationRejected(parse, (plan) => {
        plan.requestedResources.commit = 'C'.repeat(40)
      })
      assertMutationRejected(parse, (plan) => {
        plan.requestedResources.profile = '../unsafe-profile'
      })
      assertMutationRejected(parse, (plan) => {
        plan.integrityResources.marker.key = 'wrong-marker-key'
      })
      assertMutationRejected(parse, (plan) => {
        plan.integrityResources.marker.versionId = 'null'
      })
      assertMutationRejected(parse, (plan) => {
        plan.integrityResources.marker.checksumSha256 = 'not-a-checksum'
      })
      assertMutationRejected(parse, (plan) => {
        plan.integrityResources.marker.size = -1
      })
      assertMutationRejected(parse, (plan) => {
        plan.integrityResources.marker.size = Number.POSITIVE_INFINITY
      })
      assertMutationRejected(parse, (plan) => {
        plan.maximumDurationMilliseconds = 0
      })
      assertMutationRejected(parse, (plan) => {
        plan.maximumDurationMilliseconds =
          rootPlan.WORKSPACE_SEARCH_MIGRATION_REHEARSAL_ROOT_PLAN_MAX_DURATION_MILLISECONDS +
          1
      })
      return
    }
    case 'strict-shape': {
      const accessorPlan = createValidPlan()
      let getterCalled = false
      Object.defineProperty(accessorPlan, 'kind', {
        configurable: true,
        enumerable: true,
        get() {
          getterCalled = true
          return 'mukuroji-workspace-search-migration-rehearsal-root-plan'
        },
      })
      assertInvalidRootPlan(() => parse(accessorPlan))
      assert.equal(getterCalled, false)

      const nestedAccessorPlan = createValidPlan()
      Object.defineProperty(
        nestedAccessorPlan.integrityResources.marker,
        'versionId',
        {
          configurable: true,
          enumerable: true,
          get() {
            throw new Error('must not execute')
          },
        },
      )
      assertInvalidRootPlan(() => parse(nestedAccessorPlan))
      assertInvalidRootPlan(() => parse(new Proxy(createValidPlan(), {})))

      const extraPlan = createValidPlan()
      Object.defineProperty(extraPlan, 'unexpected', {
        enumerable: true,
        value: true,
      })
      assertInvalidRootPlan(() => parse(extraPlan))

      const nestedExtraPlan = createValidPlan()
      Object.defineProperty(nestedExtraPlan.requestedResources.tables, 'extra', {
        enumerable: true,
        value: 'extra-table',
      })
      assertInvalidRootPlan(() => parse(nestedExtraPlan))

      const noncanonical = new TextEncoder().encode(
        JSON.stringify(createValidPlan()),
      )
      assertInvalidRootPlan(() => parseDocument(noncanonical))
      const canonical = encodeCanonicalPlan(createValidPlan())
      const newlineTerminated = new Uint8Array(canonical.byteLength + 1)
      newlineTerminated.set(canonical)
      newlineTerminated[canonical.byteLength] = 0x0a
      assertInvalidRootPlan(() => parseDocument(newlineTerminated))
      assertInvalidRootPlan(() => parseDocument(new Proxy(canonical, {})))
      assertInvalidRootPlan(() => parseDocument(new Uint8Array([
        0xc3,
        0x28,
      ])))
      assertInvalidRootPlan(() => parseDocument(new Uint8Array(
        rootPlan.WORKSPACE_SEARCH_MIGRATION_REHEARSAL_ROOT_PLAN_MAX_BYTES +
          1,
      )))
      return
    }
    case 'mutation-isolation': {
      const input = createValidPlan()
      const result = parse(input)
      const originalRequestedBinding = result.requestedResourcesBinding
      input.requestedResources.tables.documents = 'mutated-documents'
      input.integrityResources.tables['audit-events'] = 'mutated-audit'
      input.integrityResources.marker.versionId = 'mutated-version'
      input.expectedCallerArn =
        `arn:aws:sts::${deploymentAccount}:assumed-role/Changed/changed-session`
      assert.equal(
        result.document.requestedResources.tables.documents,
        'root-documents',
      )
      assert.equal(
        result.document.integrityResources.tables['audit-events'],
        'root-audit-events',
      )
      assert.equal(
        result.document.integrityResources.marker.versionId,
        'marker-version-id',
      )
      assert.equal(
        result.document.expectedCallerArn,
        `arn:aws:sts::${deploymentAccount}:assumed-role/MigrationRehearsal/root-plan-test`,
      )
      assert.equal(result.requestedResourcesBinding, originalRequestedBinding)
      assert.equal(Object.isFrozen(result), true)
      assert.equal(Object.isFrozen(result.document), true)
      assert.equal(Object.isFrozen(result.document.requestedResources), true)
      assert.equal(
        Object.isFrozen(result.document.requestedResources.tables),
        true,
      )
      assert.equal(Object.isFrozen(result.document.integrityResources), true)
      assert.equal(
        Object.isFrozen(result.document.integrityResources.tables),
        true,
      )
      assert.equal(
        Object.isFrozen(result.document.integrityResources.marker),
        true,
      )
      assert.equal(Object.isFrozen(result.allowedDescribeTableNames), true)
      assert.equal(
        Reflect.set(
          result.document.requestedResources.tables,
          'documents',
          'cannot-mutate',
        ),
        false,
      )

      const bytes = encodeCanonicalPlan(createValidPlan())
      const parsed = parseDocument(bytes)
      bytes.fill(0)
      assert.equal(
        parsed.document.requestedResources.tables.documents,
        'root-documents',
      )
      return
    }
    default:
      throw new Error('Unknown isolated root-plan test scenario.')
  }
}

const workerScenario = process.env[workerScenarioEnvironmentName]

if (workerScenario !== undefined) {
  await executeWorkerScenario(workerScenario)
} else {
  describe('migration rehearsal root plan', () => {
    test('parses canonical plans through the source resolver path', async () => {
      await runIsolatedWorker('valid-canonical')
    })

    test('rejects disabled and unknown deployment targets', async () => {
      await runIsolatedWorker('target-selection')
    })

    test('rejects caller, account, and Region drift', async () => {
      await runIsolatedWorker('identity-drift')
    })

    test('requires the exact ten-table collision-free union', async () => {
      await runIsolatedWorker('table-collisions')
    })

    test('rejects invalid resources, commits, profiles, markers, and bounds', async () => {
      await runIsolatedWorker('resource-fields')
    })

    test('rejects accessors, proxies, extras, and noncanonical bytes', async () => {
      await runIsolatedWorker('strict-shape')
    })

    test('returns detached deeply frozen owner-only values', async () => {
      await runIsolatedWorker('mutation-isolation')
    })
  })
}
