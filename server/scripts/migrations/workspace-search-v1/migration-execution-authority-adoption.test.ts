import { describe, expect, test } from 'bun:test'
import {
  createMigrationDigest,
  serializeCanonicalJson,
} from './migration-contract'
import {
  createWorkspaceSearchMigrationExecutionAuthorityAdoptionCommandIdentity,
  createWorkspaceSearchMigrationExecutionAuthorityAdoptionReceipt,
  createWorkspaceSearchMigrationExecutionAuthorityAdoptionReceiptRecordKey,
  parseWorkspaceSearchMigrationExecutionAuthorityAdoptionReceipt,
  serializeWorkspaceSearchMigrationExecutionAuthorityAdoptionReceipt,
  type CreateWorkspaceSearchMigrationExecutionAuthorityAdoptionCommandIdentityInput,
  type CreateWorkspaceSearchMigrationExecutionAuthorityAdoptionReceiptInput,
  type WorkspaceSearchMigrationExecutionAuthorityAdoptionCommandIdentity,
  type WorkspaceSearchMigrationExecutionAuthorityAdoptionReceipt,
  WORKSPACE_SEARCH_MIGRATION_EXECUTION_AUTHORITY_ADOPTION_RECEIPT_MAX_BYTES,
  WORKSPACE_SEARCH_MIGRATION_EXECUTION_AUTHORITY_ADOPTION_RECEIPT_RECORD_KEY_PREFIX,
  WorkspaceSearchMigrationExecutionAuthorityAdoptionError,
} from './migration-execution-authority-adoption'
import {
  type WorkspaceSearchMigrationExecutionRunAuthorityBinding,
} from './migration-execution-run'
import {
  type WorkspaceSearchMigrationPrePlanAuthorityClaim,
} from './migration-pre-plan-authority-aws'

const stateTableId = '11111111-2222-3333-4444-555555555555'
const runId = 'execution-authority-adoption-test'
const ownerId = 'execution-authority-adoption-owner'
const evaluatedAt = '2026-07-31T02:00:00.000Z'
const committedAt = '2026-07-31T02:00:01.000Z'

describe('Workspace Search migration execution authority adoption', () => {
  test('round-trips one canonical immutable mutable-predecessor receipt', () => {
    const command = createCommandIdentity()
    const input = createReceiptInput(command)
    const receipt =
      createWorkspaceSearchMigrationExecutionAuthorityAdoptionReceipt(
        input,
      )
    const bytes =
      serializeWorkspaceSearchMigrationExecutionAuthorityAdoptionReceipt(
        receipt,
      )
    const parsed =
      parseWorkspaceSearchMigrationExecutionAuthorityAdoptionReceipt(
        bytes,
      )

    expect(parsed).toEqual(receipt)
    expect(
      serializeWorkspaceSearchMigrationExecutionAuthorityAdoptionReceipt(
        parsed,
      ),
    ).toEqual(bytes)
    expect(receipt).toMatchObject({
      commandDigest: command.commandDigest,
      predecessorKind: 'mutable-execution-state',
      predecessorExecutionStateVersion: 2,
      predecessorRevision: command.expectedRevision,
      successorRevision: command.expectedRevision + 1,
      maintenanceEvidenceRenewalCount: 1,
      currentAuthority: input.currentAuthority,
      committedAt,
    })

    const receiptFields = structuredClone(receipt)
    Reflect.deleteProperty(receiptFields, 'receiptDigest')
    expect(receipt.receiptDigest).toBe(
      createMigrationDigest(receiptFields),
    )
  })

  test('binds every run and current-authority claim field into command identity', () => {
    const first = createCommandIdentity()
    const repeated = createCommandIdentity()
    expect(repeated).toEqual(first)

    const differentTable =
      createWorkspaceSearchMigrationExecutionAuthorityAdoptionCommandIdentity(
        {
          ...createCommandInput(),
          stateTableId:
            'aaaaaaaa-bbbb-cccc-dddd-eeeeeeeeeeee',
        },
      )
    const differentConfiguration =
      createWorkspaceSearchMigrationExecutionAuthorityAdoptionCommandIdentity(
        {
          ...createCommandInput(),
          configurationHash: digest('other-configuration'),
        },
      )
    const differentRunInput = createCommandInput()
    const differentRunClaim = createAuthorityClaim()
    Reflect.set(
      differentRunInput,
      'runId',
      'other-execution-run',
    )
    Reflect.set(
      differentRunClaim.lease,
      'runId',
      'other-execution-run',
    )
    Reflect.set(
      differentRunInput,
      'authorityClaim',
      differentRunClaim,
    )
    const differentRun =
      createWorkspaceSearchMigrationExecutionAuthorityAdoptionCommandIdentity(
        differentRunInput,
      )
    const differentExecutionRun =
      createWorkspaceSearchMigrationExecutionAuthorityAdoptionCommandIdentity(
        {
          ...createCommandInput(),
          executionRunDigest: digest('other-execution-run'),
        },
      )
    const differentRevision =
      createWorkspaceSearchMigrationExecutionAuthorityAdoptionCommandIdentity(
        {
          ...createCommandInput(),
          expectedRevision: 8,
        },
      )
    const differentOwnerInput = createCommandInput()
    Reflect.set(
      differentOwnerInput.authorityClaim.lease,
      'ownerId',
      'other-authority-owner',
    )
    const differentOwner =
      createWorkspaceSearchMigrationExecutionAuthorityAdoptionCommandIdentity(
        differentOwnerInput,
      )
    const differentFenceInput = createCommandInput()
    Reflect.set(
      differentFenceInput.authorityClaim.lease,
      'fenceToken',
      10,
    )
    const differentFence =
      createWorkspaceSearchMigrationExecutionAuthorityAdoptionCommandIdentity(
        differentFenceInput,
      )
    const differentPointerInput = createCommandInput()
    Reflect.set(
      differentPointerInput.authorityClaim,
      'maintenanceEvidencePointerRevision',
      18,
    )
    const differentPointer =
      createWorkspaceSearchMigrationExecutionAuthorityAdoptionCommandIdentity(
        differentPointerInput,
      )
    const differentReceiptInput = createCommandInput()
    Reflect.set(
      differentReceiptInput.authorityClaim,
      'maintenanceEvidenceReceiptDigest',
      digest('other-maintenance-receipt'),
    )
    const differentReceipt =
      createWorkspaceSearchMigrationExecutionAuthorityAdoptionCommandIdentity(
        differentReceiptInput,
      )

    for (
      const identity of [
        differentTable,
        differentConfiguration,
        differentRun,
        differentExecutionRun,
        differentRevision,
        differentOwner,
        differentFence,
        differentPointer,
        differentReceipt,
      ]
    ) {
      expect(identity.commandDigest).not.toBe(first.commandDigest)
    }

    const key =
      createWorkspaceSearchMigrationExecutionAuthorityAdoptionReceiptRecordKey(
        first,
      )
    expect(key).toBe(
      `${WORKSPACE_SEARCH_MIGRATION_EXECUTION_AUTHORITY_ADOPTION_RECEIPT_RECORD_KEY_PREFIX}/${first.commandDigest}/receipt`,
    )
    expect(
      createWorkspaceSearchMigrationExecutionAuthorityAdoptionReceiptRecordKey(
        repeated,
      ),
    ).toBe(key)
  })

  test('represents direct admission without a mutable-state version', () => {
    const command =
      createWorkspaceSearchMigrationExecutionAuthorityAdoptionCommandIdentity(
        {
          ...createCommandInput(),
          expectedRevision: 1,
        },
      )
    const input = createReceiptInput(command)
    Reflect.set(
      input,
      'predecessorKind',
      'execution-run-admission',
    )
    Reflect.deleteProperty(
      input,
      'predecessorExecutionStateVersion',
    )
    Reflect.set(
      input,
      'predecessorExecutionStateDigest',
      command.executionRunDigest,
    )
    Reflect.set(input, 'successorRevision', 2)
    Reflect.set(input, 'maintenanceEvidenceRenewalCount', 1)
    const receipt =
      createWorkspaceSearchMigrationExecutionAuthorityAdoptionReceipt(
        input,
      )

    expect(receipt.predecessorKind).toBe(
      'execution-run-admission',
    )
    expect(
      Object.hasOwn(
        receipt,
        'predecessorExecutionStateVersion',
      ),
    ).toBe(false)
    expect(receipt.predecessorRevision).toBe(1)
    expect(receipt.predecessorExecutionStateDigest).toBe(
      command.executionRunDigest,
    )

    const admissionWithVersion = structuredClone(input)
    Reflect.set(
      admissionWithVersion,
      'predecessorExecutionStateVersion',
      1,
    )
    expectAdoptionFailure(() =>
      createWorkspaceSearchMigrationExecutionAuthorityAdoptionReceipt(
        admissionWithVersion,
      )
    )

    const mutableWithoutVersion = createReceiptInput(
      createCommandIdentity(),
    )
    Reflect.deleteProperty(
      mutableWithoutVersion,
      'predecessorExecutionStateVersion',
    )
    expectAdoptionFailure(() =>
      createWorkspaceSearchMigrationExecutionAuthorityAdoptionReceipt(
        mutableWithoutVersion,
      )
    )
  })

  test('rejects invalid revision, predecessor, authority, renewal, and time bindings', () => {
    const command = createCommandIdentity()

    const wrongSuccessor = createReceiptInput(command)
    Reflect.set(
      wrongSuccessor,
      'successorRevision',
      command.expectedRevision + 2,
    )
    expectAdoptionFailure(() =>
      createWorkspaceSearchMigrationExecutionAuthorityAdoptionReceipt(
        wrongSuccessor,
      )
    )

    const wrongAuthority = createReceiptInput(command)
    Reflect.set(
      wrongAuthority.currentAuthority,
      'maintenanceEvidencePointerRevision',
      wrongAuthority.currentAuthority
          .maintenanceEvidencePointerRevision + 1,
    )
    expectAdoptionFailure(() =>
      createWorkspaceSearchMigrationExecutionAuthorityAdoptionReceipt(
        wrongAuthority,
      )
    )

    const wrongOwner = createReceiptInput(command)
    Reflect.set(
      wrongOwner.currentAuthority,
      'ownerId',
      'other-owner',
    )
    expectAdoptionFailure(() =>
      createWorkspaceSearchMigrationExecutionAuthorityAdoptionReceipt(
        wrongOwner,
      )
    )

    const invalidRenewalCount = createReceiptInput(command)
    Reflect.set(
      invalidRenewalCount,
      'maintenanceEvidenceRenewalCount',
      0,
    )
    expectAdoptionFailure(() =>
      createWorkspaceSearchMigrationExecutionAuthorityAdoptionReceipt(
        invalidRenewalCount,
      )
    )

    const excessiveRenewalCount = createReceiptInput(command)
    Reflect.set(
      excessiveRenewalCount,
      'maintenanceEvidenceRenewalCount',
      excessiveRenewalCount.successorRevision,
    )
    expectAdoptionFailure(() =>
      createWorkspaceSearchMigrationExecutionAuthorityAdoptionReceipt(
        excessiveRenewalCount,
      )
    )

    const skippedFirstRenewal = createReceiptInput(command)
    Reflect.set(
      skippedFirstRenewal,
      'maintenanceEvidenceRenewalCount',
      2,
    )
    expectAdoptionFailure(() =>
      createWorkspaceSearchMigrationExecutionAuthorityAdoptionReceipt(
        skippedFirstRenewal,
      )
    )

    const legacyWithPredecessorCount =
      createReceiptInput(command)
    Reflect.set(
      legacyWithPredecessorCount,
      'predecessorMaintenanceEvidenceRenewalCount',
      1,
    )
    expectAdoptionFailure(() =>
      createWorkspaceSearchMigrationExecutionAuthorityAdoptionReceipt(
        legacyWithPredecessorCount,
      )
    )

    const v3WithoutPredecessorCount =
      createReceiptInput(command)
    Reflect.set(
      v3WithoutPredecessorCount,
      'predecessorExecutionStateVersion',
      3,
    )
    Reflect.set(
      v3WithoutPredecessorCount,
      'maintenanceEvidenceRenewalCount',
      2,
    )
    expectAdoptionFailure(() =>
      createWorkspaceSearchMigrationExecutionAuthorityAdoptionReceipt(
        v3WithoutPredecessorCount,
      )
    )

    const v3SkippedRenewal = createReceiptInput(command)
    Reflect.set(
      v3SkippedRenewal,
      'predecessorExecutionStateVersion',
      3,
    )
    Reflect.set(
      v3SkippedRenewal,
      'predecessorMaintenanceEvidenceRenewalCount',
      2,
    )
    Reflect.set(
      v3SkippedRenewal,
      'maintenanceEvidenceRenewalCount',
      4,
    )
    expectAdoptionFailure(() =>
      createWorkspaceSearchMigrationExecutionAuthorityAdoptionReceipt(
        v3SkippedRenewal,
      )
    )

    const validV3 = createReceiptInput(command)
    Reflect.set(
      validV3,
      'predecessorExecutionStateVersion',
      3,
    )
    Reflect.set(
      validV3,
      'predecessorMaintenanceEvidenceRenewalCount',
      2,
    )
    Reflect.set(
      validV3,
      'maintenanceEvidenceRenewalCount',
      3,
    )
    const validV3Receipt =
      createWorkspaceSearchMigrationExecutionAuthorityAdoptionReceipt(
        validV3,
      )
    expect(validV3Receipt).toMatchObject({
      predecessorExecutionStateVersion: 3,
      predecessorMaintenanceEvidenceRenewalCount: 2,
      maintenanceEvidenceRenewalCount: 3,
    })
    expect(
      parseWorkspaceSearchMigrationExecutionAuthorityAdoptionReceipt(
        serializeWorkspaceSearchMigrationExecutionAuthorityAdoptionReceipt(
          validV3Receipt,
        ),
      ),
    ).toEqual(validV3Receipt)

    const earlyCommit = createReceiptInput(command)
    Reflect.set(
      earlyCommit,
      'committedAt',
      '2026-07-31T01:59:59.000Z',
    )
    expectAdoptionFailure(() =>
      createWorkspaceSearchMigrationExecutionAuthorityAdoptionReceipt(
        earlyCommit,
      )
    )

    const invalidVersion = createReceiptInput(command)
    Reflect.set(
      invalidVersion,
      'predecessorExecutionStateVersion',
      4,
    )
    expectAdoptionFailure(() =>
      createWorkspaceSearchMigrationExecutionAuthorityAdoptionReceipt(
        invalidVersion,
      )
    )

    const firstRevisionMutable =
      createReceiptInput(
        createWorkspaceSearchMigrationExecutionAuthorityAdoptionCommandIdentity(
          {
            ...createCommandInput(),
            expectedRevision: 1,
          },
        ),
      )
    Reflect.set(firstRevisionMutable, 'successorRevision', 2)
    expectAdoptionFailure(() =>
      createWorkspaceSearchMigrationExecutionAuthorityAdoptionReceipt(
        firstRevisionMutable,
      )
    )
  })

  test('rejects tampered and noncanonical serialized receipts', () => {
    const receipt = createReceipt()
    const canonical =
      serializeWorkspaceSearchMigrationExecutionAuthorityAdoptionReceipt(
        receipt,
      )
    const text = new TextDecoder().decode(canonical)

    expectAdoptionFailure(() =>
      parseWorkspaceSearchMigrationExecutionAuthorityAdoptionReceipt(
        new TextEncoder().encode(` ${text}`),
      )
    )

    const tamperedSuccessor = structuredClone(receipt)
    Reflect.set(
      tamperedSuccessor,
      'successorRunStateDigest',
      digest('tampered-successor-run-state'),
    )
    expectAdoptionFailure(() =>
      parseWorkspaceSearchMigrationExecutionAuthorityAdoptionReceipt(
        encodeCanonicalJson(tamperedSuccessor),
      )
    )

    const tamperedAuthority = structuredClone(receipt)
    Reflect.set(
      tamperedAuthority.currentAuthority,
      'maintenanceEvidencePointerRevision',
      tamperedAuthority.currentAuthority
          .maintenanceEvidencePointerRevision + 1,
    )
    replaceReceiptDigest(tamperedAuthority)
    expectAdoptionFailure(() =>
      parseWorkspaceSearchMigrationExecutionAuthorityAdoptionReceipt(
        encodeCanonicalJson(tamperedAuthority),
      )
    )

    const wrongVersion = structuredClone(receipt)
    Reflect.set(wrongVersion, 'receiptVersion', 2)
    expectAdoptionFailure(() =>
      parseWorkspaceSearchMigrationExecutionAuthorityAdoptionReceipt(
        encodeCanonicalJson(wrongVersion),
      )
    )

    expectAdoptionFailure(() =>
      parseWorkspaceSearchMigrationExecutionAuthorityAdoptionReceipt(
        new Uint8Array(
          WORKSPACE_SEARCH_MIGRATION_EXECUTION_AUTHORITY_ADOPTION_RECEIPT_MAX_BYTES +
            1,
        ),
      )
    )

    const hostileBytes = new Uint8Array(1)
    Object.defineProperty(hostileBytes, 'byteLength', {
      get() {
        const failure =
          new WorkspaceSearchMigrationExecutionAuthorityAdoptionError()
        failure.message = 'tenant-secret-byte-length'
        throw failure
      },
    })
    expectAdoptionFailure(() =>
      parseWorkspaceSearchMigrationExecutionAuthorityAdoptionReceipt(
        hostileBytes,
      )
    )
  })

  test('rejects hostile command, input, and runtime receipt objects without leaking values', () => {
    const commandAccessor = createCommandInput()
    let commandGetterInvoked = false
    Object.defineProperty(
      commandAccessor.authorityClaim.lease,
      'ownerId',
      {
        enumerable: true,
        get() {
          commandGetterInvoked = true
          return 'raw-command-getter-secret'
        },
      },
    )
    expectAdoptionFailure(() =>
      createWorkspaceSearchMigrationExecutionAuthorityAdoptionCommandIdentity(
        commandAccessor,
      )
    )
    expect(commandGetterInvoked).toBe(false)

    const receiptInput = createReceiptInput(
      createCommandIdentity(),
    )
    Reflect.set(receiptInput, 'rawTenantSecret', true)
    expectAdoptionFailure(() =>
      createWorkspaceSearchMigrationExecutionAuthorityAdoptionReceipt(
        receiptInput,
      )
    )

    const proxy = new Proxy(createReceiptInput(createCommandIdentity()), {
      ownKeys() {
        throw new Error('raw-proxy-secret')
      },
    })
    expectAdoptionFailure(() =>
      createWorkspaceSearchMigrationExecutionAuthorityAdoptionReceipt(
        proxy,
      )
    )

    const symbolic = createReceiptInput(createCommandIdentity())
    Reflect.set(symbolic.currentAuthority, Symbol('hidden'), true)
    expectAdoptionFailure(() =>
      createWorkspaceSearchMigrationExecutionAuthorityAdoptionReceipt(
        symbolic,
      )
    )

    const runtimeReceipt = structuredClone(createReceipt())
    let receiptGetterInvoked = false
    Object.defineProperty(runtimeReceipt, 'runId', {
      enumerable: true,
      get() {
        receiptGetterInvoked = true
        return 'raw-receipt-getter-secret'
      },
    })
    expectAdoptionFailure(() =>
      serializeWorkspaceSearchMigrationExecutionAuthorityAdoptionReceipt(
        runtimeReceipt,
      )
    )
    expect(receiptGetterInvoked).toBe(false)
  })

  test('rejects a tampered command digest before deriving a receipt key', () => {
    const command = structuredClone(createCommandIdentity())
    Reflect.set(
      command,
      'commandDigest',
      digest('tampered-command'),
    )

    expectAdoptionFailure(() =>
      createWorkspaceSearchMigrationExecutionAuthorityAdoptionReceiptRecordKey(
        command,
      )
    )
  })
})

/**
 * Creates one strict command input fixture.
 *
 * @returns Exact authority-adoption command identity input.
 */
function createCommandInput():
  CreateWorkspaceSearchMigrationExecutionAuthorityAdoptionCommandIdentityInput {
  return {
    stateTableId,
    configurationHash: digest('configuration'),
    runId,
    executionRunDigest: digest('execution-run'),
    expectedRevision: 7,
    authorityClaim: createAuthorityClaim(),
  }
}

/**
 * Creates one strict live authority claim fixture.
 *
 * @returns Exact lease, pointer, and receipt claim.
 */
function createAuthorityClaim():
  WorkspaceSearchMigrationPrePlanAuthorityClaim {
  return {
    lease: {
      runId,
      ownerId,
      fenceToken: 9,
    },
    maintenanceEvidenceReceiptDigest:
      digest('maintenance-receipt'),
    maintenanceEvidencePointerRevision: 17,
  }
}

/**
 * Creates one strict deterministic command identity fixture.
 *
 * @returns Exact authority-adoption command identity.
 */
function createCommandIdentity():
  WorkspaceSearchMigrationExecutionAuthorityAdoptionCommandIdentity {
  return createWorkspaceSearchMigrationExecutionAuthorityAdoptionCommandIdentity(
    createCommandInput(),
  )
}

/**
 * Creates one compact execution authority matching the command claim.
 *
 * @returns Exact authority binding persisted by the successor.
 */
function createCurrentAuthority():
  WorkspaceSearchMigrationExecutionRunAuthorityBinding {
  const claim = createAuthorityClaim()
  return {
    ownerId: claim.lease.ownerId,
    fenceToken: claim.lease.fenceToken,
    maintenanceEvidencePointerRevision:
      claim.maintenanceEvidencePointerRevision,
    maintenanceEvidenceReceiptDigest:
      claim.maintenanceEvidenceReceiptDigest,
    evaluatedAt,
  }
}

/**
 * Creates one strict receipt-construction fixture.
 *
 * @param command - Deterministic command identity to bind.
 * @returns Exact authority-adoption receipt construction input.
 */
function createReceiptInput(
  command:
    WorkspaceSearchMigrationExecutionAuthorityAdoptionCommandIdentity,
): CreateWorkspaceSearchMigrationExecutionAuthorityAdoptionReceiptInput {
  return {
    commandIdentity: command,
    predecessorKind: 'mutable-execution-state',
    predecessorExecutionStateVersion: 2,
    predecessorExecutionStateDigest:
      digest('predecessor-execution-state'),
    predecessorRunStateDigest:
      digest('predecessor-run-state'),
    successorRevision: command.expectedRevision + 1,
    successorExecutionStateDigest:
      digest('successor-execution-state'),
    successorRunStateDigest: digest('successor-run-state'),
    maintenanceEvidenceRenewalCount: 1,
    currentAuthority: createCurrentAuthority(),
    committedAt,
  }
}

/**
 * Creates one strict immutable authority-adoption receipt fixture.
 *
 * @returns Canonical immutable authority-adoption receipt.
 */
function createReceipt():
  WorkspaceSearchMigrationExecutionAuthorityAdoptionReceipt {
  return createWorkspaceSearchMigrationExecutionAuthorityAdoptionReceipt(
    createReceiptInput(createCommandIdentity()),
  )
}

/**
 * Recomputes a receipt self digest after a test-owned semantic mutation.
 *
 * @param receipt - Mutable structured clone selected by one tamper test.
 */
function replaceReceiptDigest(
  receipt:
    WorkspaceSearchMigrationExecutionAuthorityAdoptionReceipt,
): void {
  const fields = structuredClone(receipt)
  Reflect.deleteProperty(fields, 'receiptDigest')
  Reflect.set(
    receipt,
    'receiptDigest',
    createMigrationDigest(fields),
  )
}

/**
 * Creates one stable fixture digest.
 *
 * @param label - Nonsecret fixture label.
 * @returns Lowercase SHA-256 digest.
 */
function digest(label: string): string {
  return createMigrationDigest({ label })
}

/**
 * Encodes one value using the migration canonical JSON serializer.
 *
 * @param value - Candidate JSON-compatible value.
 * @returns Canonical UTF-8 bytes.
 */
function encodeCanonicalJson(value: unknown): Uint8Array {
  return new TextEncoder().encode(
    serializeCanonicalJson(value),
  )
}

/**
 * Expects one operation to fail with the stable raw-value-free error.
 *
 * @param operation - Candidate invalid authority-adoption operation.
 */
function expectAdoptionFailure(operation: () => unknown): void {
  let failure: unknown
  try {
    operation()
  } catch (error: unknown) {
    failure = error
  }
  expect(failure).toBeInstanceOf(
    WorkspaceSearchMigrationExecutionAuthorityAdoptionError,
  )
  if (!(failure instanceof Error)) {
    throw new Error('Expected one authority-adoption Error.')
  }
  expect(failure.message).toBe(
    'INVALID_MIGRATION_EXECUTION_AUTHORITY_ADOPTION_RECEIPT',
  )
  expect(failure.message).not.toContain('secret')
}
