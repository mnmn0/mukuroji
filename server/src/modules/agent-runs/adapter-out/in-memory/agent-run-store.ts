import {
  AGENT_RUN_HEARTBEAT_INTERVAL_SECONDS,
  AGENT_SETTINGS_SCHEMA_VERSION,
  type AgentSettings,
  type UpdateAgentSettingsRequest,
} from '@mukuroji/contracts'
import {
  calculateLeaseExpiry,
  createDefaultAgentSettings,
  type StoredAgentRun,
  type AgentRunRevocation,
  type StoredAgentRunClaim,
} from '../../domain/agent-run'
import {
  AgentRunError,
  createAgentRunCommitConflictError,
  createAgentRunIntegrityError,
  createAgentRunNotActiveError,
} from '../../domain/agent-run-error'
import {
  DynamoDbAgentRunStore,
  type AgentRunCloseOptions,
  type AgentRunFenceInput,
  type AgentRunPage,
  type AgentRunStore,
  type AgentRunTransactItem,
} from '../dynamodb/agent-run-store'

/** In-memory state of one store. */
type InMemoryAgentRunState = {
  /** Runs by `<directoryId>|<teamId>|<runId>`. */
  runs: Map<string, StoredAgentRun>
  /** Claims by `<directoryId>|<teamId>|<workItemId>`. */
  claims: Map<string, StoredAgentRunClaim>
  /** Revoked instances by `<directoryId>|<teamId>|<workItemId>|<assigneeUserId>|<instanceIdHash>`. */
  revocations: Set<string>
  /** Settings by `<directoryId>|<teamId>`. */
  settings: Map<string, AgentSettings>
}

/** Condition and effect of one transaction item, evaluated against in-memory state. */
type InMemoryEffect = {
  /**
   * Checks the item's condition.
   * @param state - Current state.
   * @returns True when the condition holds.
   */
  check(state: InMemoryAgentRunState): boolean
  /**
   * Applies the item's write.
   * @param state - State to mutate.
   */
  apply(state: InMemoryAgentRunState): void
}

/** Transaction cancellation shaped like the DynamoDB error the real store classifies. */
export class InMemoryTransactionCanceledError extends Error {
  /** Per-item cancellation reasons in transaction order. */
  readonly CancellationReasons: { Code: string }[]

  /**
   * Creates the error.
   * @param reasons - Per-item reasons.
   */
  constructor(reasons: { Code: string }[]) {
    super('Transaction cancelled.')
    this.name = 'TransactionCanceledException'
    this.CancellationReasons = reasons
  }
}

/**
 * Builds a run map key.
 *
 * @param directoryId - Workspace ID.
 * @param teamId - Team ID.
 * @param id - Run or Work Item ID.
 * @returns Map key.
 */
function key(directoryId: string, teamId: string, id: string): string {
  return `${directoryId}|${teamId}|${id}`
}

/**
 * Builds a revocation set key.
 *
 * @param directoryId - Workspace ID.
 * @param teamId - Team ID.
 * @param revocation - Work Item, member, and instance hash.
 * @returns Set key.
 */
function revocationKey(directoryId: string, teamId: string, revocation: AgentRunRevocation): string {
  return `${directoryId}|${teamId}|${revocation.workItemId}|${revocation.assigneeUserId}|${revocation.instanceIdHash}`
}

/**
 * Agent Run store for tests and local composition without DynamoDB. It produces the same
 * transaction items as the DynamoDB store and evaluates their conditions in memory, so code that
 * commits Agent Run items with another writer can call {@link InMemoryAgentRunStore.applyTransactItems}.
 */
export class InMemoryAgentRunStore implements AgentRunStore {
  /** Current state. */
  readonly state: InMemoryAgentRunState = { runs: new Map(), claims: new Map(), revocations: new Set(), settings: new Map() }
  /** Builder that produces DynamoDB-shaped items. */
  readonly #builder = new DynamoDbAgentRunStore({
    send: async () => {
      throw new Error('The in-memory Agent Run store does not send DynamoDB commands.')
    },
  }, 'in-memory-agent-runs')
  /** Effects of the items this store produced. */
  readonly #effects = new WeakMap<AgentRunTransactItem, InMemoryEffect>()

  /**
   * Seeds a run as the Work Item's newest run and, for an active run, its claim.
   * @param run - Run to store.
   */
  seed(run: StoredAgentRun): void {
    this.state.runs.set(key(run.directoryId, run.teamId, run.runId), structuredClone(run))
    if (run.outcome === 'released' || run.outcome === 'superseded') {
      this.state.revocations.add(revocationKey(run.directoryId, run.teamId, run))
    }
    if (run.state === 'active') {
      this.state.claims.set(key(run.directoryId, run.teamId, run.workItemId), {
        workItemId: run.workItemId,
        runId: run.runId,
        instanceIdHash: run.instanceIdHash,
        assigneeUserId: run.assigneeUserId,
      })
    }
  }

  /** @inheritdoc */
  async getRun(directoryId: string, teamId: string, runId: string): Promise<StoredAgentRun | undefined> {
    const run = this.state.runs.get(key(directoryId, teamId, runId))
    return run ? structuredClone(run) : undefined
  }

  /** @inheritdoc */
  async getClaim(directoryId: string, teamId: string, workItemId: string): Promise<StoredAgentRunClaim | undefined> {
    const claim = this.state.claims.get(key(directoryId, teamId, workItemId))
    return claim ? { ...claim } : undefined
  }

  /** @inheritdoc */
  async isInstanceRevoked(directoryId: string, teamId: string, revocation: AgentRunRevocation): Promise<boolean> {
    return this.state.revocations.has(revocationKey(directoryId, teamId, revocation))
  }

  /** @inheritdoc */
  async getSettings(directoryId: string, teamId: string): Promise<AgentSettings> {
    return { ...(this.state.settings.get(`${directoryId}|${teamId}`) ?? createDefaultAgentSettings(teamId)) }
  }

  /** @inheritdoc */
  async saveSettings(
    directoryId: string,
    teamId: string,
    update: UpdateAgentSettingsRequest,
    actorMemberKey: string,
    now: Date,
  ): Promise<AgentSettings> {
    const current = await this.getSettings(directoryId, teamId)
    if (current.revision !== update.expectedRevision) {
      throw new AgentRunError('conflict', 'Agent settings changed. Reload them before saving.', { pointer: '/expectedRevision' })
    }
    const settings: AgentSettings = {
      schemaVersion: AGENT_SETTINGS_SCHEMA_VERSION,
      teamId,
      revision: update.expectedRevision + 1,
      leaseMinutes: update.leaseMinutes,
      allowTakeoverAfterLeaseExpiry: update.allowTakeoverAfterLeaseExpiry,
      updatedAt: now.toISOString(),
      updatedBy: actorMemberKey,
    }
    this.state.settings.set(`${directoryId}|${teamId}`, settings)
    return { ...settings }
  }

  /** @inheritdoc */
  async listWorkItemRuns(directoryId: string, teamId: string, workItemId: string, cursor: string | undefined, limit: number): Promise<AgentRunPage> {
    const runs = [...this.state.runs.values()]
      .filter((run) => run.directoryId === directoryId && run.teamId === teamId && run.workItemId === workItemId)
      .sort((left, right) => `${right.startedAt}#${right.runId}`.localeCompare(`${left.startedAt}#${left.runId}`))
    return this.#page(runs, cursor, limit)
  }

  /** @inheritdoc */
  async listActiveRuns(directoryId: string, teamId: string, cursor: string | undefined, limit: number): Promise<AgentRunPage> {
    const runs = [...this.state.runs.values()]
      .filter((run) => run.directoryId === directoryId && run.teamId === teamId && run.state === 'active')
      .sort((left, right) => `${left.leaseExpiresAt}#${left.runId}`.localeCompare(`${right.leaseExpiresAt}#${right.runId}`))
    return this.#page(runs, cursor, limit)
  }

  /** @inheritdoc */
  async listFinishedRuns(directoryId: string, teamId: string, cursor: string | undefined, limit: number): Promise<AgentRunPage> {
    const runs = [...this.state.runs.values()]
      .filter((run) => run.directoryId === directoryId && run.teamId === teamId && run.state === 'finished')
      .sort((left, right) => left.runId.localeCompare(right.runId))
    return this.#page(runs, cursor, limit)
  }

  /** @inheritdoc */
  createStartItems(run: StoredAgentRun): AgentRunTransactItem[] {
    const [runPut, claimPut, revocationDelete] = this.#builder.createStartItems(run)
    if (!runPut || !claimPut || !revocationDelete) throw new Error('The start builder returned an unexpected item count.')
    const runKey = key(run.directoryId, run.teamId, run.runId)
    const claimKey = key(run.directoryId, run.teamId, run.workItemId)
    return [
      this.#register(runPut, {
        check: (state) => !state.runs.has(runKey),
        apply: (state) => { state.runs.set(runKey, structuredClone(run)) },
      }),
      this.#register(claimPut, {
        check: (state) => !state.claims.has(claimKey),
        apply: (state) => {
          state.claims.set(claimKey, {
            workItemId: run.workItemId,
            runId: run.runId,
            instanceIdHash: run.instanceIdHash,
            assigneeUserId: run.assigneeUserId,
          })
        },
      }),
      this.#register(revocationDelete, {
        check: () => true,
        apply: (state) => { state.revocations.delete(revocationKey(run.directoryId, run.teamId, run)) },
      }),
    ]
  }

  /** @inheritdoc */
  createMutationFenceConditionChecks(input: AgentRunFenceInput): AgentRunTransactItem[] {
    const items = this.#builder.createMutationFenceConditionChecks(input)
    return this.#registerFence(items, input)
  }

  /** @inheritdoc */
  createClaimAbsentCheck(directoryId: string, teamId: string, workItemId: string): AgentRunTransactItem {
    const claimKey = key(directoryId, teamId, workItemId)
    return this.#register(this.#builder.createClaimAbsentCheck(directoryId, teamId, workItemId), {
      check: (state) => !state.claims.has(claimKey),
      apply: () => undefined,
    })
  }

  /** @inheritdoc */
  createCloseItems(run: StoredAgentRun, expectedInstanceIdHash?: string, options?: AgentRunCloseOptions): AgentRunTransactItem[] {
    const [runUpdate, claimDelete, revocationPut] = this.#builder.createCloseItems(run, expectedInstanceIdHash, options)
    if (!runUpdate || !claimDelete) throw new Error('The close builder returned an unexpected item count.')
    const runKey = key(run.directoryId, run.teamId, run.runId)
    const claimKey = key(run.directoryId, run.teamId, run.workItemId)
    return [
      this.#register(runUpdate, {
        check: (state) => {
          const current = state.runs.get(runKey)
          return current?.state === 'active' &&
            (expectedInstanceIdHash === undefined || current.instanceIdHash === expectedInstanceIdHash)
        },
        apply: (state) => {
          const current = state.runs.get(runKey)
          if (!current) return
          const { lastHeartbeatRequestAt: _lastHeartbeatRequestAt, ...rest } = current
          state.runs.set(runKey, {
            ...rest,
            state: 'finished',
            ...(run.outcome ? { outcome: run.outcome } : {}),
            ...(run.finishedAt ? { finishedAt: run.finishedAt } : {}),
            ...(run.finishedBy ? { finishedBy: run.finishedBy } : {}),
          })
        },
      }),
      this.#register(claimDelete, {
        check: (state) => state.claims.get(claimKey)?.runId === run.runId,
        apply: (state) => { state.claims.delete(claimKey) },
      }),
      ...(revocationPut
        ? [this.#register(revocationPut, {
            check: () => true,
            apply: (state) => { state.revocations.add(revocationKey(run.directoryId, run.teamId, run)) },
          })]
        : []),
    ]
  }

  /** @inheritdoc */
  async commit(items: readonly AgentRunTransactItem[], fenceItemCount: number): Promise<void> {
    try {
      this.applyTransactItems(items)
    } catch (error) {
      if (
        error instanceof InMemoryTransactionCanceledError &&
        error.CancellationReasons.slice(0, fenceItemCount).some((reason) => reason.Code === 'ConditionalCheckFailed')
      ) {
        throw createAgentRunNotActiveError()
      }
      if (error instanceof InMemoryTransactionCanceledError) throw createAgentRunCommitConflictError()
      throw error
    }
  }

  /**
   * Applies items this store produced atomically; items from other writers are accepted unchanged.
   * @param items - Transaction items in order.
   */
  applyTransactItems(items: readonly AgentRunTransactItem[]): void {
    const reasons = items.map((item) => {
      const effect = this.#effects.get(item)
      return { Code: effect && !effect.check(this.state) ? 'ConditionalCheckFailed' : 'None' }
    })
    if (reasons.some((reason) => reason.Code !== 'None')) throw new InMemoryTransactionCanceledError(reasons)
    for (const item of items) this.#effects.get(item)?.apply(this.state)
  }

  /** @inheritdoc */
  async heartbeat(
    run: StoredAgentRun,
    instanceIdHash: string,
    now: Date,
    conditionChecks: readonly AgentRunTransactItem[] = [],
  ): Promise<StoredAgentRun> {
    // Checks on other tables are evaluated by their own writers; this store accepts them unchanged.
    void conditionChecks
    const runKey = key(run.directoryId, run.teamId, run.runId)
    const current = this.state.runs.get(runKey)
    if (!current || current.state !== 'active' || current.instanceIdHash !== instanceIdHash) throw createAgentRunNotActiveError()
    const claim = this.state.claims.get(key(run.directoryId, run.teamId, run.workItemId))
    if (claim?.runId !== run.runId || claim.instanceIdHash !== instanceIdHash) throw createAgentRunIntegrityError()
    if (current.lastHeartbeatRequestAt !== undefined) {
      const nextAllowed = Date.parse(current.lastHeartbeatRequestAt) + AGENT_RUN_HEARTBEAT_INTERVAL_SECONDS * 1_000
      if (nextAllowed > now.getTime()) {
        throw new AgentRunError('rate_limited', `Send at most one heartbeat every ${AGENT_RUN_HEARTBEAT_INTERVAL_SECONDS} seconds per run.`, {
          retryAfterSeconds: Math.max(1, Math.ceil((nextAllowed - now.getTime()) / 1_000)),
        })
      }
    }
    if (Date.parse(current.lastHeartbeatAt) >= now.getTime()) return structuredClone(current)
    const updated: StoredAgentRun = {
      ...current,
      lastHeartbeatAt: now.toISOString(),
      lastHeartbeatRequestAt: now.toISOString(),
      leaseExpiresAt: calculateLeaseExpiry(now, current.leaseMinutes),
    }
    this.state.runs.set(runKey, updated)
    return structuredClone(updated)
  }

  /** @inheritdoc */
  async extendLeaseAfterMutation(run: StoredAgentRun, now: Date): Promise<void> {
    const runKey = key(run.directoryId, run.teamId, run.runId)
    const current = this.state.runs.get(runKey)
    if (!current || current.state !== 'active' || Date.parse(current.lastHeartbeatAt) >= now.getTime()) return
    this.state.runs.set(runKey, {
      ...current,
      lastHeartbeatAt: now.toISOString(),
      leaseExpiresAt: calculateLeaseExpiry(now, current.leaseMinutes),
    })
  }

  /**
   * Registers fence effects for items built by the DynamoDB builder.
   * @param items - Built items.
   * @param input - Fence input.
   * @returns The same items.
   */
  #registerFence(items: AgentRunTransactItem[], input: AgentRunFenceInput): AgentRunTransactItem[] {
    const claimKey = key(input.directoryId, input.teamId, input.workItemId)
    const run = input.run
    if (!run) {
      const [claimCheck, revocationCheck] = items
      if (!claimCheck || !revocationCheck) throw new Error('The fence builder returned an unexpected item count.')
      this.#register(claimCheck, {
        check: (state) => {
          const claim = state.claims.get(claimKey)
          return !claim || (claim.instanceIdHash === input.instanceIdHash && claim.assigneeUserId === input.assigneeUserId)
        },
        apply: () => undefined,
      })
      this.#register(revocationCheck, {
        check: (state) => !state.revocations.has(revocationKey(input.directoryId, input.teamId, input)),
        apply: () => undefined,
      })
      return items
    }
    const [runItem, claimCheck] = items
    if (!runItem || !claimCheck) throw new Error('The fence builder returned an unexpected item count.')
    const runKey = key(input.directoryId, input.teamId, run.runId)
    this.#register(runItem, {
      check: (state) => {
        const current = state.runs.get(runKey)
        return current?.state === 'active' && current.workItemId === input.workItemId && current.instanceIdHash === input.instanceIdHash
      },
      apply: () => undefined,
    })
    this.#register(claimCheck, {
      check: (state) => {
        const claim = state.claims.get(claimKey)
        return claim?.runId === run.runId && claim.instanceIdHash === input.instanceIdHash
      },
      apply: () => undefined,
    })
    return items
  }

  /**
   * Associates an effect with an item.
   * @param item - Transaction item.
   * @param effect - Its condition and write.
   * @returns The item.
   */
  #register(item: AgentRunTransactItem, effect: InMemoryEffect): AgentRunTransactItem {
    this.#effects.set(item, effect)
    return item
  }

  /**
   * Builds an offset-cursor page.
   * @param runs - Ordered runs.
   * @param cursor - Offset cursor.
   * @param limit - Page size.
   * @returns Page.
   */
  #page(runs: StoredAgentRun[], cursor: string | undefined, limit: number): AgentRunPage {
    const offset = cursor === undefined ? 0 : Number(cursor)
    if (!Number.isSafeInteger(offset) || offset < 0) {
      throw new AgentRunError('validation_failed', 'The cursor is invalid.', { pointer: '/cursor' })
    }
    const page = runs.slice(offset, offset + limit).map((run) => structuredClone(run))
    return {
      runs: page,
      ...(offset + limit < runs.length ? { nextCursor: String(offset + limit) } : {}),
    }
  }
}
