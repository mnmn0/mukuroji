import {
  AGENT_RUN_HEARTBEAT_INTERVAL_SECONDS,
  type AgentRunReportAnswer,
  type AgentSettings,
  type WorkspaceAgentDefaults,
} from '@mukuroji/contracts'
import {
  applyWorkspaceAgentDefaults,
  calculateLeaseExpiry,
  createDefaultAgentSettings,
  createDefaultWorkspaceAgentDefaults,
  createSavedAgentSettings,
  createSavedWorkspaceAgentDefaults,
  isClaimHeldBy,
  type StoredAgentRun,
  type AgentRunRevocation,
  type StoredAgentRunClaim,
  type ResolvedAgentSettings,
  type ValidatedAgentSettingsUpdate,
  type ValidatedWorkspaceAgentDefaultsUpdate,
} from '../../domain/agent-run'
import type { StoredAgentRunReport } from '../../domain/agent-run-report'
import {
  AgentRunError,
  createAgentRunCommitConflictError,
  createAgentRunIntegrityError,
  createAgentRunNotActiveError,
} from '../../domain/agent-run-error'
import {
  DynamoDbAgentRunStore,
  isSameSettingsSave,
  isSameWorkspaceDefaultsSave,
  type AgentRunFenceInput,
  type AgentRunFinishedGroup,
  type AgentRunFinishedPage,
  type AgentRunPage,
  type AgentRunReportPage,
  type AgentRunStore,
  type AgentRunTransactItem,
  type AgentRunTriageOutboxEntry,
  type AgentRunStallPosition,
  type AgentRunTriageStore,
  type AgentRunTriageTeam,
  type AgentRunTriageTeamPage,
} from '../dynamodb/agent-run-store'

/** In-memory state of one store. */
type InMemoryAgentRunState = {
  /** Runs by `<directoryId>|<teamId>|<runId>`. */
  runs: Map<string, StoredAgentRun>
  /** Claims by `<directoryId>|<teamId>|<workItemId>`. */
  claims: Map<string, StoredAgentRunClaim>
  /** Newest run ID by `<directoryId>|<teamId>|<workItemId>`. */
  latestRuns: Map<string, string>
  /** Revoked instances by `<directoryId>|<teamId>|<workItemId>|<assigneeUserId>|<instanceIdHash>`. */
  revocations: Set<string>
  /** Settings by `<directoryId>|<teamId>`. */
  settings: Map<string, AgentSettings>
  /** Workspace agent defaults by `<directoryId>`. */
  workspaceDefaults: Map<string, WorkspaceAgentDefaults>
  /** Structured reports by `<directoryId>|<teamId>|<runId>|<sequence>`. */
  reports: Map<string, StoredAgentRunReport>
  /** Failed runs waiting to be filed to Triage, by `<directoryId>|<teamId>|<runId>`. */
  triageOutbox: Set<string>
  /** Outbox order of failed runs whose filing failed, by `<directoryId>|<teamId>|<runId>`. */
  triageOutboxDeferrals: Map<string, string>
  /** Stall sweep watermarks by `<directoryId>|<teamId>`. */
  stallWatermarks: Map<string, string>
  /** Stall sweep resume positions by `<directoryId>|<teamId>`. */
  stallResumes: Map<string, string>
  /** Team the next stall sweep resumes from. */
  triageSweepResumeTeam?: AgentRunTriageTeam
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
export class InMemoryAgentRunStore implements AgentRunStore, AgentRunTriageStore {
  /** Current state. */
  readonly state: InMemoryAgentRunState = {
    runs: new Map(), claims: new Map(), latestRuns: new Map(), revocations: new Set(), settings: new Map(), workspaceDefaults: new Map(), reports: new Map(),
    triageOutbox: new Set(), triageOutboxDeferrals: new Map(), stallWatermarks: new Map(), stallResumes: new Map(),
  }
  /** Builder that produces DynamoDB-shaped items. */
  readonly #builder = new DynamoDbAgentRunStore({
    send: async () => {
      throw new Error('The in-memory Agent Run store does not send DynamoDB commands.')
    },
  }, 'in-memory-agent-runs')
  /** Effects of the items this store produced. */
  readonly #effects = new WeakMap<AgentRunTransactItem, InMemoryEffect>()
  /** Settings each committed save key produced, by Team and key. */
  readonly #settingsReceipts = new Map<string, AgentSettings>()
  /** Workspace defaults each committed save key produced, by Workspace and key. */
  readonly #workspaceDefaultsReceipts = new Map<string, WorkspaceAgentDefaults>()

  /**
   * Seeds a run as the Work Item's newest run and, for an active run, its claim.
   * @param run - Run to store.
   */
  seed(run: StoredAgentRun): void {
    this.state.runs.set(key(run.directoryId, run.teamId, run.runId), structuredClone(run))
    this.state.latestRuns.set(key(run.directoryId, run.teamId, run.workItemId), run.runId)
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
  async getLatestRunId(directoryId: string, teamId: string, workItemId: string): Promise<string | undefined> {
    return this.state.latestRuns.get(key(directoryId, teamId, workItemId))
  }

  /** @inheritdoc */
  async isInstanceRevoked(directoryId: string, teamId: string, revocation: AgentRunRevocation): Promise<boolean> {
    return this.state.revocations.has(revocationKey(directoryId, teamId, revocation))
  }

  /** @inheritdoc */
  async getSettings(directoryId: string, teamId: string): Promise<ResolvedAgentSettings> {
    const settings = this.state.settings.get(`${directoryId}|${teamId}`) ?? createDefaultAgentSettings(teamId)
    return structuredClone(applyWorkspaceAgentDefaults(settings, await this.getWorkspaceAgentDefaults(directoryId)))
  }

  /** @inheritdoc */
  async getWorkspaceAgentDefaults(directoryId: string): Promise<WorkspaceAgentDefaults> {
    return structuredClone(this.state.workspaceDefaults.get(directoryId) ?? createDefaultWorkspaceAgentDefaults())
  }

  /** @inheritdoc */
  async saveWorkspaceAgentDefaults(
    directoryId: string,
    update: ValidatedWorkspaceAgentDefaultsUpdate,
    actorMemberKey: string,
    now: Date,
    mutationKey: string,
  ): Promise<WorkspaceAgentDefaults> {
    const receiptKey = `${directoryId}|${mutationKey}`
    const receipt = this.#workspaceDefaultsReceipts.get(receiptKey)
    if (receipt) {
      if (isSameWorkspaceDefaultsSave(receipt, update)) return structuredClone(receipt)
      throw new AgentRunError('conflict', 'This Idempotency-Key was already used for a different defaults save.')
    }
    // No await between the receipt and revision checks and the write, so concurrent saves see each other.
    const currentRevision = this.state.workspaceDefaults.get(directoryId)?.revision ?? 0
    if (currentRevision !== update.expectedRevision) {
      throw new AgentRunError('conflict', 'Workspace agent defaults changed. Reload them before saving.', {
        pointer: '/expectedRevision',
      })
    }
    const defaults = createSavedWorkspaceAgentDefaults(update, actorMemberKey, now)
    this.state.workspaceDefaults.set(directoryId, defaults)
    this.#workspaceDefaultsReceipts.set(receiptKey, defaults)
    return structuredClone(defaults)
  }

  /** @inheritdoc */
  async saveSettings(
    directoryId: string,
    teamId: string,
    update: ValidatedAgentSettingsUpdate,
    actorMemberKey: string,
    now: Date,
    mutationKey: string,
  ): Promise<AgentSettings> {
    const settingsKey = `${directoryId}|${teamId}`
    const receiptKey = `${settingsKey}|${mutationKey}`
    const receipt = this.#settingsReceipts.get(receiptKey)
    if (receipt) {
      if (isSameSettingsSave(receipt, update)) return structuredClone(receipt)
      throw new AgentRunError('conflict', 'This Idempotency-Key was already used for a different settings save.')
    }
    const current = await this.getSettings(directoryId, teamId)
    if (current.revision !== update.expectedRevision) {
      throw new AgentRunError('conflict', 'Agent settings changed. Reload them before saving.', { pointer: '/expectedRevision' })
    }
    const settings = createSavedAgentSettings(teamId, update, actorMemberKey, now)
    this.state.settings.set(settingsKey, settings)
    this.#settingsReceipts.set(receiptKey, settings)
    return structuredClone(settings)
  }

  /** @inheritdoc */
  async listTriageTeams(cursor: string | undefined, limit: number, from?: AgentRunTriageTeam): Promise<AgentRunTriageTeamPage> {
    const fromKey = cursor === undefined && from !== undefined ? `${from.directoryId}|${from.teamId}` : undefined
    const teams = [...this.state.settings.entries()]
      .filter(([, settings]) => settings.fileFailedRunsToTriage || settings.fileStalledRunsToTriage || settings.notifyAssigneeOfRunEvents)
      .map(([settingsKey, settings]) => ({ directoryId: settingsKey.slice(0, settingsKey.lastIndexOf('|')), teamId: settings.teamId }))
      .sort((left, right) => `${left.directoryId}|${left.teamId}`.localeCompare(`${right.directoryId}|${right.teamId}`))
      .filter((team) => fromKey === undefined || `${team.directoryId}|${team.teamId}` >= fromKey)
    const start = cursor === undefined ? 0 : Number(cursor)
    const page = teams.slice(start, start + limit)
    const next = start + limit
    return { teams: page, ...(next < teams.length ? { nextCursor: String(next) } : {}) }
  }

  /** @inheritdoc */
  async readTriageSweepResumeTeam(): Promise<AgentRunTriageTeam | undefined> {
    return this.state.triageSweepResumeTeam
  }

  /** @inheritdoc */
  async saveTriageSweepResumeTeam(team: AgentRunTriageTeam | undefined): Promise<void> {
    if (team === undefined) delete this.state.triageSweepResumeTeam
    else this.state.triageSweepResumeTeam = { ...team }
  }

  /** @inheritdoc */
  async readStallPosition(team: AgentRunTriageTeam): Promise<AgentRunStallPosition> {
    const teamKey = `${team.directoryId}|${team.teamId}`
    const watermark = this.state.stallWatermarks.get(teamKey)
    const resume = this.state.stallResumes.get(teamKey)
    return { ...(watermark === undefined ? {} : { watermark }), ...(resume === undefined ? {} : { resume }) }
  }

  /** @inheritdoc */
  async saveStallResume(team: AgentRunTriageTeam, run: StoredAgentRun | undefined): Promise<void> {
    const teamKey = `${team.directoryId}|${team.teamId}`
    if (run === undefined) this.state.stallResumes.delete(teamKey)
    else this.state.stallResumes.set(teamKey, `${run.leaseExpiresAt}#${run.runId}`)
  }

  /** @inheritdoc */
  async listStallCandidates(team: AgentRunTriageTeam, after: string | undefined, cursor: string | undefined, limit: number): Promise<AgentRunPage> {
    const runs = [...this.state.runs.values()]
      .filter((run) => run.directoryId === team.directoryId && run.teamId === team.teamId && run.state === 'active')
      .filter((run) => after === undefined || `${run.leaseExpiresAt}#${run.runId}` > after)
      .sort((left, right) => `${left.leaseExpiresAt}#${left.runId}`.localeCompare(`${right.leaseExpiresAt}#${right.runId}`))
    return this.#page(runs, cursor, limit)
  }

  /** @inheritdoc */
  async saveStallWatermark(run: StoredAgentRun): Promise<void> {
    const teamKey = `${run.directoryId}|${run.teamId}`
    const watermark = `${run.leaseExpiresAt}#${run.runId}`
    const current = this.state.stallWatermarks.get(teamKey)
    if (current === undefined || current < watermark) this.state.stallWatermarks.set(teamKey, watermark)
  }

  /** @inheritdoc */
  async listFailedRunsToTriage(limit: number): Promise<AgentRunTriageOutboxEntry[]> {
    return [...this.state.triageOutbox]
      .flatMap((runKey) => {
        const run = this.state.runs.get(runKey)
        return run ? [{ run, order: `${this.state.triageOutboxDeferrals.get(runKey) ?? run.finishedAt ?? ''}#${run.runId}` }] : []
      })
      .sort((left, right) => left.order.localeCompare(right.order))
      .slice(0, limit)
      .map(({ run }) => ({ directoryId: run.directoryId, teamId: run.teamId, runId: run.runId }))
  }

  /** @inheritdoc */
  async deferFailedRunTriage(entry: AgentRunTriageOutboxEntry, now: Date): Promise<void> {
    const runKey = key(entry.directoryId, entry.teamId, entry.runId)
    if (this.state.triageOutbox.has(runKey)) this.state.triageOutboxDeferrals.set(runKey, now.toISOString())
  }

  /** @inheritdoc */
  async clearFailedRunTriage(entry: AgentRunTriageOutboxEntry): Promise<void> {
    this.state.triageOutboxDeferrals.delete(key(entry.directoryId, entry.teamId, entry.runId))
    this.state.triageOutbox.delete(key(entry.directoryId, entry.teamId, entry.runId))
  }

  /** @inheritdoc */
  async markStallTriaged(run: StoredAgentRun, now: Date): Promise<boolean> {
    const runKey = key(run.directoryId, run.teamId, run.runId)
    const current = this.state.runs.get(runKey)
    if (current?.state !== 'active' || current.leaseExpiresAt !== run.leaseExpiresAt) return false
    this.state.runs.set(runKey, { ...current, stallTriagedAt: now.toISOString() })
    return true
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
  async listFinishedRunsByTime(
    directoryId: string,
    teamId: string,
    group: AgentRunFinishedGroup,
    since: string | undefined,
    cursor: string | undefined,
    limit: number,
    until?: string,
  ): Promise<AgentRunFinishedPage> {
    const entries = [...this.state.runs.values()].flatMap((run) => {
      if (run.directoryId !== directoryId || run.teamId !== teamId || run.state !== 'finished') return []
      if (run.outcome === undefined || run.finishedAt === undefined) return []
      if ((run.outcome === 'failed') !== (group === 'failed')) return []
      if (since !== undefined && `${run.finishedAt}#${run.runId}` < since) return []
      if (until !== undefined && `${run.finishedAt}#${run.runId}` > `${until}#~`) return []
      return [{ runId: run.runId, workItemId: run.workItemId, outcome: run.outcome, finishedAt: run.finishedAt }]
    }).sort((left, right) => `${right.finishedAt}#${right.runId}`.localeCompare(`${left.finishedAt}#${left.runId}`))
    const offset = cursor === undefined ? 0 : Number(cursor)
    if (!Number.isSafeInteger(offset) || offset < 0) {
      throw new AgentRunError('validation_failed', 'The cursor is invalid.', { pointer: '/cursor' })
    }
    return {
      runs: entries.slice(offset, offset + limit),
      ...(offset + limit < entries.length ? { nextCursor: String(offset + limit) } : {}),
    }
  }

  /** @inheritdoc */
  async listWorkItemReports(directoryId: string, teamId: string, workItemId: string, cursor: string | undefined, limit: number): Promise<AgentRunReportPage> {
    /**
     * Builds the creation-time sort key the DynamoDB store uses.
     *
     * @param report - Report.
     * @returns Sort key.
     */
    const order = (report: StoredAgentRunReport) => `${report.createdAt}#${report.runId}#${String(report.sequence).padStart(6, '0')}`
    const reports = [...this.state.reports.values()]
      .filter((report) => report.directoryId === directoryId && report.teamId === teamId && report.workItemId === workItemId)
      .sort((left, right) => order(right).localeCompare(order(left)))
    const offset = cursor === undefined ? 0 : Number(cursor)
    if (!Number.isSafeInteger(offset) || offset < 0) {
      throw new AgentRunError('validation_failed', 'The cursor is invalid.', { pointer: '/cursor' })
    }
    return {
      reports: reports.slice(offset, offset + limit).map((report) => structuredClone(report)),
      ...(offset + limit < reports.length ? { nextCursor: String(offset + limit) } : {}),
    }
  }

  /** @inheritdoc */
  createReportItems(run: StoredAgentRun, report: StoredAgentRunReport, now: Date): AgentRunTransactItem[] {
    const [runUpdate, claimCheck, reportPut] = this.#builder.createReportItems(run, report, now)
    if (!runUpdate || !claimCheck || !reportPut) throw new Error('The report builder returned an unexpected item count.')
    const runKey = key(run.directoryId, run.teamId, run.runId)
    const claimKey = key(run.directoryId, run.teamId, run.workItemId)
    const reportKey = `${key(run.directoryId, run.teamId, run.runId)}|${report.sequence}`
    const leaseExpiresAt = calculateLeaseExpiry(now, run.leaseMinutes)
    return [
      this.#register(runUpdate, {
        check: (state) => {
          const current = state.runs.get(runKey)
          return current?.state === 'active' && current.instanceIdHash === run.instanceIdHash &&
            current.reportCount === run.reportCount && current.lastHeartbeatAt <= report.createdAt
        },
        apply: (state) => {
          const current = state.runs.get(runKey)
          if (!current) return
          state.runs.set(runKey, {
            ...current,
            reportCount: report.sequence,
            lastReportKind: report.kind,
            lastReportAt: report.createdAt,
            lastHeartbeatAt: report.createdAt,
            leaseExpiresAt,
          })
        },
      }),
      this.#register(claimCheck, {
        check: (state) => {
          const claim = state.claims.get(claimKey)
          return claim?.runId === run.runId && claim.instanceIdHash === run.instanceIdHash
        },
        apply: () => undefined,
      }),
      this.#register(reportPut, {
        check: (state) => !state.reports.has(reportKey),
        apply: (state) => { state.reports.set(reportKey, structuredClone(report)) },
      }),
    ]
  }

  /** @inheritdoc */
  async getRunReport(run: StoredAgentRun, sequence: number): Promise<StoredAgentRunReport | undefined> {
    const report = this.state.reports.get(`${key(run.directoryId, run.teamId, run.runId)}|${sequence}`)
    return report === undefined ? undefined : structuredClone(report)
  }

  /** @inheritdoc */
  createReportAnswerItems(report: StoredAgentRunReport, answer: AgentRunReportAnswer): AgentRunTransactItem[] {
    const [reportUpdate] = this.#builder.createReportAnswerItems(report, answer)
    if (!reportUpdate) throw new Error('The answer builder returned an unexpected item count.')
    const reportKey = `${key(report.directoryId, report.teamId, report.runId)}|${report.sequence}`
    return [
      this.#register(reportUpdate, {
        check: (state) => {
          const current = state.reports.get(reportKey)
          return current !== undefined && current.commentId === report.commentId && current.answer?.commentId === report.answer?.commentId
        },
        apply: (state) => {
          const current = state.reports.get(reportKey)
          if (current) state.reports.set(reportKey, { ...current, answer: { ...answer } })
        },
      }),
    ]
  }

  /** @inheritdoc */
  createStartItems(run: StoredAgentRun, latest?: {
    /** Newest run ID the caller read, or undefined when it read none. */
    runId: string | undefined
  }): AgentRunTransactItem[] {
    const [runPut, claimPut, revocationDelete, latestPut] = this.#builder.createStartItems(run, latest)
    if (!runPut || !claimPut || !revocationDelete || !latestPut) throw new Error('The start builder returned an unexpected item count.')
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
      this.#register(latestPut, {
        check: (state) => latest === undefined || state.latestRuns.get(claimKey) === latest.runId,
        apply: (state) => { state.latestRuns.set(claimKey, run.runId) },
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
  createSettingsRevisionChecks(
    directoryId: string,
    teamId: string,
    settings: Pick<ResolvedAgentSettings, 'revision' | 'workspaceDefaultsRevision'>,
  ): AgentRunTransactItem[] {
    const [teamCheck, defaultsCheck] = this.#builder.createSettingsRevisionChecks(directoryId, teamId, settings)
    if (!teamCheck) throw new Error('The settings check builder returned no items.')
    return [
      this.#register(teamCheck, {
        check: (state) => (state.settings.get(`${directoryId}|${teamId}`)?.revision ?? 0) === settings.revision,
        apply: () => undefined,
      }),
      ...(defaultsCheck
        ? [this.#register(defaultsCheck, {
            check: (state) => (state.workspaceDefaults.get(directoryId)?.revision ?? 0) === settings.workspaceDefaultsRevision,
            apply: () => undefined,
          })]
        : []),
    ]
  }

  /** @inheritdoc */
  createCloseItems(run: StoredAgentRun, expectedInstanceIdHash?: string, fenceProgress = false): AgentRunTransactItem[] {
    const [runUpdate, claimDelete, revocationPut] = this.#builder.createCloseItems(run, expectedInstanceIdHash, fenceProgress)
    if (!runUpdate || !claimDelete) throw new Error('The close builder returned an unexpected item count.')
    const runKey = key(run.directoryId, run.teamId, run.runId)
    const claimKey = key(run.directoryId, run.teamId, run.workItemId)
    return [
      this.#register(runUpdate, {
        check: (state) => {
          const current = state.runs.get(runKey)
          return current?.state === 'active' &&
            (expectedInstanceIdHash === undefined || current.instanceIdHash === expectedInstanceIdHash) &&
            (!fenceProgress || (current.reportCount === run.reportCount && current.lastHeartbeatAt === run.lastHeartbeatAt))
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
          if (run.outcome === 'failed') state.triageOutbox.add(runKey)
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
  createTakeOverItems(superseded: StoredAgentRun, successor: StoredAgentRun): AgentRunTransactItem[] {
    const [runUpdate, claimPut, revocationPut, runPut, revocationDelete, latestPut] = this.#builder.createTakeOverItems(superseded, successor)
    if (!runUpdate || !claimPut || !revocationPut || !runPut || !revocationDelete || !latestPut) {
      throw new Error('The take over builder returned an unexpected item count.')
    }
    const supersededKey = key(superseded.directoryId, superseded.teamId, superseded.runId)
    const successorKey = key(successor.directoryId, successor.teamId, successor.runId)
    const claimKey = key(successor.directoryId, successor.teamId, successor.workItemId)
    return [
      this.#register(runUpdate, {
        check: (state) => {
          const current = state.runs.get(supersededKey)
          return current?.state === 'active' && current.instanceIdHash === superseded.instanceIdHash &&
            current.leaseExpiresAt < successor.lastHeartbeatAt
        },
        apply: (state) => {
          const current = state.runs.get(supersededKey)
          if (!current) return
          const { lastHeartbeatRequestAt: _lastHeartbeatRequestAt, ...rest } = current
          state.runs.set(supersededKey, {
            ...rest,
            state: 'finished',
            outcome: 'superseded',
            ...(superseded.finishedAt ? { finishedAt: superseded.finishedAt } : {}),
            ...(superseded.finishedBy ? { finishedBy: superseded.finishedBy } : {}),
          })
        },
      }),
      this.#register(claimPut, {
        check: (state) => isClaimHeldBy(state.claims.get(claimKey), superseded),
        apply: (state) => {
          state.claims.set(claimKey, {
            workItemId: successor.workItemId,
            runId: successor.runId,
            instanceIdHash: successor.instanceIdHash,
            assigneeUserId: successor.assigneeUserId,
          })
        },
      }),
      this.#register(revocationPut, {
        check: () => true,
        apply: (state) => { state.revocations.add(revocationKey(superseded.directoryId, superseded.teamId, superseded)) },
      }),
      this.#register(runPut, {
        check: (state) => !state.runs.has(successorKey),
        apply: (state) => { state.runs.set(successorKey, structuredClone(successor)) },
      }),
      this.#register(revocationDelete, {
        check: () => true,
        apply: (state) => { state.revocations.delete(revocationKey(successor.directoryId, successor.teamId, successor)) },
      }),
      this.#register(latestPut, {
        check: () => true,
        apply: (state) => { state.latestRuns.set(claimKey, successor.runId) },
      }),
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
