import { z } from 'zod'
import {
  isCanonicalWorkItemKey,
  type PublicProjectCharter,
  AGENT_SETTINGS_BRIEF_MAX_BYTES, AGENT_SETTINGS_MAX_PROJECT_BRIEFS, AGENT_SETTINGS_MAX_READY_STATUSES,
  AGENT_SETTINGS_MAX_RESUMABLE_STATUSES, AGENT_RUN_QUESTIONS_MAX_ITEMS, AGENT_RUN_REPORT_ANSWER_READ_MAX_LENGTH,
  WORK_ITEM_ACCEPTANCE_CRITERIA_LIMIT, WORK_ITEM_ACCEPTANCE_CRITERION_TEXT_MAX_LENGTH, WORK_ITEM_COMPLETION_GATE_CONDITIONS,
} from '@mukuroji/contracts'
import type {
  AgentAttachmentDownload, AgentCatalog, AgentDocument, AgentRunRecord, AgentRunReportResult, AgentSettingsRecord, AgentTask, AgentTaskAttachment, AgentTaskDocument, AgentTaskQuestions,
  AgentWorkItemApi,
} from '../../application/work-item-api'
import { AgentTaskError } from '../../application/work-item-api'
import { createPublicApiRequest, pageSchema } from './public-api-request'

/** Public API identifier: bounded, non-empty, and never a dot path segment. */
export const identifier = z.string().min(1).max(256).refine((value) => value !== '.' && value !== '..')
const category = z.enum(['backlog', 'unstarted', 'started', 'completed', 'canceled'])
const customValue = z.union([z.string(), z.number().finite(), z.boolean(), z.array(z.string()).max(100)])
const effortMinutes = z.number().int().nonnegative().max(Number.MAX_SAFE_INTEGER)
const scheduleBase = {
  calendarPolicy: z.object({
    timeZone: z.string().min(1),
    workingWeekdays: z.array(z.enum(['monday', 'tuesday', 'wednesday', 'thursday', 'friday', 'saturday', 'sunday'])),
    holidays: z.array(z.iso.date()),
  }),
  plannedEffortMinutes: effortMinutes.optional(),
}
const scheduleSchema = z.discriminatedUnion('mode', [
  z.object({ ...scheduleBase, mode: z.literal('unscheduled') }),
  z.object({ ...scheduleBase, mode: z.literal('due-date'), dueDate: z.iso.date() }),
  z.object({
    ...scheduleBase, mode: z.literal('date-range'), startDate: z.iso.date(), endDate: z.iso.date(),
    durationDays: z.number().int().positive(),
  }),
  z.object({
    ...scheduleBase, mode: z.literal('milestone'), startDate: z.iso.date(), endDate: z.iso.date(), durationDays: z.literal(0),
  }),
])
const charterPersonSchema = z.object({ memberId: identifier, displayName: z.string() })
const projectCharterSchema: z.ZodType<PublicProjectCharter> = z.object({
  schemaVersion: z.literal(1), teamId: identifier, projectId: identifier,
  lifecycleState: z.enum(['proposed', 'approved', 'active', 'on-hold', 'closed', 'archived']),
  revision: z.number().int().nonnegative(), updatedAt: z.iso.datetime().optional(),
  code: z.string().optional(), description: z.string().optional(), purpose: z.string().optional(),
  owner: charterPersonSchema.optional(), sponsor: charterPersonSchema.optional(),
  plannedStartDate: z.iso.date().optional(), plannedEndDate: z.iso.date().optional(),
  tags: z.array(z.string()), repositoryUrls: z.array(z.string()),
})
/** Validates a Work Item as the Public API returns it. */
export const taskSchema: z.ZodType<AgentTask> = z.object({
  id: identifier, teamId: identifier, revision: z.number().int().positive(),
  title: z.string(), description: z.string().optional(), assigneeUserId: identifier,
  assignedProjectId: identifier.optional(), workflowStatusId: identifier,
  workItemTypeId: identifier.optional(), statusCategory: category,
  priority: z.enum(['high', 'medium', 'low']), dueDate: z.union([z.literal(''), z.iso.date()]),
  schedule: scheduleSchema,
  createdAt: z.iso.datetime(), updatedAt: z.iso.datetime(),
  relationIds: z.array(z.string().regex(/^(parent|child|blocks|blockedBy|related|duplicate):.+$/)).max(100),
  customFieldValues: z.record(z.string(), customValue),
})
const effortSchema = z.object({
  schemaVersion: z.literal(1), teamId: identifier, workItemId: identifier, revision: z.number().int().positive(),
  plannedEffortMinutes: effortMinutes.optional(), remainingEffortMinutes: effortMinutes.optional(),
  progressPercent: z.number().int().min(0).max(100).optional(),
})
const actualDatesSchema = z.object({
  schemaVersion: z.literal(1), teamId: identifier, workItemId: identifier, revision: z.number().int().positive(),
  actualStartDate: z.iso.date().optional(), actualEndDate: z.iso.date().optional(),
})
const acceptanceCriteriaSchema = z.object({
  schemaVersion: z.literal(1), teamId: identifier, workItemId: identifier, revision: z.number().int().positive(),
  items: z.array(z.object({
    id: z.string().regex(/^[0-9a-f]{32}$/u),
    text: z.string().min(1).max(WORK_ITEM_ACCEPTANCE_CRITERION_TEXT_MAX_LENGTH),
    satisfied: z.boolean(),
  })).max(WORK_ITEM_ACCEPTANCE_CRITERIA_LIMIT),
})
const hierarchySchema = z.object({
  schemaVersion: z.literal(1), teamId: identifier, workItemId: identifier,
  parentWorkItemId: identifier.nullable(), childWorkItemIds: z.array(identifier),
  wbsNumber: z.string().regex(/^[1-9][0-9]*(\.[1-9][0-9]*)*$/u).optional(),
})
const completionGateSchema = z.object({
  schemaVersion: z.literal(1), teamId: identifier, workItemId: identifier, revision: z.number().int().positive(),
  conditions: z.array(z.object({
    condition: z.string().min(1).max(100),
    requirement: z.enum(['warn', 'required']),
    state: z.enum(['met', 'unmet', 'unavailable']),
    message: z.string().max(500).optional(),
  })).max(50),
  blocksCompletion: z.boolean(),
})
/** Validates the response of `GET /api/v1/work-items/{workItemId}/key`. */
export const keySchema = z.object({
  schemaVersion: z.literal(1), teamId: identifier, workItemId: identifier, createdAt: z.iso.datetime(),
  key: z.string().refine(isCanonicalWorkItemKey).optional(),
})
/** Validates a Team's Work Item Type catalog. */
export const catalogSchema: z.ZodType<AgentCatalog> = z.object({
  teamId: identifier, configurationRevision: z.number().int().nonnegative(),
  workItemTypes: z.array(z.object({
    id: identifier, name: z.string(),
    workflow: z.object({
      initialStatusId: identifier,
      statuses: z.array(z.object({
        id: identifier, name: z.string(), category, sortOrder: z.number(), color: z.string().optional(),
      })),
    }),
    customFields: z.array(z.record(z.string(), z.unknown())),
  })),
  // Templates come from their own endpoint; the type catalog never lists them.
  templates: z.array(z.never()).default([]),
})
/** Validates the Work Item templates a Team can create from. */
export const templateListSchema = z.object({
  teamId: identifier,
  templates: z.array(z.object({
    id: identifier, version: z.number().int().positive(), name: z.string(), title: z.string(),
    description: z.string().optional(), workItemTypeId: identifier.optional(), workflowStatusId: identifier.optional(),
    priority: z.enum(['high', 'medium', 'low']).optional(), acceptanceCriteria: z.array(z.string()),
  })),
})
/** Validates one Work Item comment. */
export const commentSchema = z.object({
  id: identifier, actorUserId: identifier, body: z.string(), createdAt: z.iso.datetime(),
})
const runSchema: z.ZodType<AgentRunRecord> = z.object({
  schemaVersion: z.literal(1), runId: z.string().regex(/^run_[0-9a-f-]{36}$/u), teamId: identifier,
  workItemId: identifier, assigneeUserId: identifier,
  runtime: z.enum(['claude-code', 'codex', 'kiro', 'other']), agentName: z.string().min(1).max(64),
  state: z.enum(['active', 'finished']),
  outcome: z.enum(['completed', 'paused', 'failed', 'released', 'superseded']).optional(),
  startRevision: z.number().int().positive(), leaseMinutes: z.number().int().positive(),
  startedAt: z.iso.datetime(), lastHeartbeatAt: z.iso.datetime(), leaseExpiresAt: z.iso.datetime(),
  stalled: z.boolean(), finishedAt: z.iso.datetime().optional(), finishedBy: z.string().min(1).optional(),
  reportCount: z.number().int().nonnegative(),
})
const reportSchema = z.object({
  schemaVersion: z.literal(1), runId: z.string().regex(/^run_[0-9a-f-]{36}$/u), teamId: identifier, workItemId: identifier,
  sequence: z.number().int().positive(), kind: z.enum(['progress', 'blocker', 'verification', 'artifact', 'handoff']),
  commentId: identifier,
  verifications: z.array(z.object({
    command: z.string().min(1), status: z.enum(['passed', 'failed', 'skipped']), summary: z.string().min(1).optional(),
  })).max(20),
  artifacts: z.array(z.object({
    type: z.enum(['pull-request', 'branch', 'commit', 'url']), url: z.string().startsWith('https://'), label: z.string().min(1).optional(),
  })).max(20),
  changedFileCount: z.number().int().nonnegative().optional(),
  createdAt: z.iso.datetime(),
  // Servers older than answers omit it.
  answer: z.object({
    body: z.string().min(1).max(AGENT_RUN_REPORT_ANSWER_READ_MAX_LENGTH), answeredBy: z.string().min(1),
    answeredAt: z.iso.datetime(), commentId: identifier,
  }).optional(),
})
const reportResultSchema: z.ZodType<AgentRunReportResult> = z.object({
  report: reportSchema,
  comment: commentSchema,
  run: runSchema,
})
const questionsSchema: z.ZodType<AgentTaskQuestions> = z.object({
  items: z.array(reportSchema).max(AGENT_RUN_QUESTIONS_MAX_ITEMS),
  hasMore: z.boolean(),
})
/** Agent brief, bounded in UTF-8 bytes like the server. */
const briefText = z.string().min(1).refine((value) => new TextEncoder().encode(value).byteLength <= AGENT_SETTINGS_BRIEF_MAX_BYTES)
const settingsSchema = z.object({
  schemaVersion: z.literal(1), teamId: identifier, revision: z.number().int().nonnegative(),
  leaseMinutes: z.number().int().positive(), allowTakeoverAfterLeaseExpiry: z.boolean(),
  updatedAt: z.iso.datetime().optional(), updatedBy: z.string().min(1).optional(),
})
const contextSchema = z.object({
  schemaVersion: z.literal(1), teamId: identifier, revision: z.number().int().nonnegative(),
  // Servers older than the switch omit it and always accept new runs.
  acceptNewRuns: z.boolean().default(true),
  readyStatusIds: z.array(identifier).max(AGENT_SETTINGS_MAX_READY_STATUSES),
  // Servers older than resuming omit this; nothing is offered for resume then, and resume_task fails there.
  resumableStatusIds: z.array(identifier).max(AGENT_SETTINGS_MAX_RESUMABLE_STATUSES).default([]),
  // Servers older than acceptance criteria omit these.
  requireAcceptanceCriteria: z.boolean().default(false),
  acceptanceCriteriaFieldId: identifier.optional(),
  brief: briefText.optional(),
  projectBriefs: z.record(identifier, briefText).refine((briefs) => Object.keys(briefs).length <= AGENT_SETTINGS_MAX_PROJECT_BRIEFS),
})
/** Linked Document entry of `GET work-items/{id}/documents`. */
export const linkedDocumentSchema: z.ZodType<AgentTaskDocument> = z.object({ id: identifier, title: z.string() })
const attachmentSchema: z.ZodType<AgentTaskAttachment> = z.object({
  id: identifier,
  name: z.string(),
  versionId: identifier,
  versionNumber: z.number().int().min(1),
  contentType: z.string(),
  sizeBytes: z.number().int().min(0),
  updatedAt: z.string(),
})
const attachmentListSchema = z.object({ items: z.array(attachmentSchema) })
const attachmentDownloadSchema: z.ZodType<AgentAttachmentDownload> = z.object({
  fileId: identifier,
  versionId: identifier,
  url: z.string().url(),
  expiresAt: z.string(),
})
/** Markdown Document content returned by the Public API Document reads and writes. */
export const documentSchema: z.ZodType<AgentDocument> = z.object({
  schemaVersion: z.literal(1), id: identifier, kind: z.enum(['page', 'template']), title: z.string(),
  revision: z.number().int().positive(), updatedAt: z.iso.datetime(), format: z.literal('markdown'), content: z.string(),
})
/** Trusted operator configuration for the single remote origin used by this process. */
export type AgentApiConfiguration = {
  /** Origin of the Mukuroji deployment, with no path, query, or embedded credentials. */
  origin: string
  /** Scoped API key or OAuth access token; never returned through MCP. */
  token: string
  /** Team fixed for this MCP connection. */
  teamId: string
}

/**
 * Builds an HTTP adapter with a fixed origin, bounded bodies, deadlines, and safe errors.
 * @param config - Validated operator configuration.
 * @param fetcher - HTTP transport, injectable for isolated tests.
 * @returns Canonical Work Item port backed by the versioned public API.
 */
export function createAgentWorkItemApi(
  config: AgentApiConfiguration,
  fetcher: (url: URL, init: RequestInit) => Promise<Response> = fetch,
): AgentWorkItemApi {
  if (!identifier.safeParse(config.teamId).success) {
    throw new AgentTaskError('configuration', 'A valid API token and Team ID are required.')
  }
  const request = createPublicApiRequest(config, fetcher)

  /** Checks that a run belongs to the configured Team before exposing it. */
  function scopedRun(run: AgentRunRecord, runId?: string): AgentRunRecord {
    if (run.teamId !== config.teamId || (runId !== undefined && run.runId !== runId)) {
      throw new AgentTaskError('invalid_response', 'The API returned a mismatched run scope.')
    }
    return run
  }

  /** Checks the response scope before exposing a task to the caller. */
  function scoped(task: AgentTask, id?: string): AgentTask {
    if (task.teamId !== config.teamId || (id !== undefined && task.id !== id)) {
      throw new AgentTaskError('invalid_response', 'The API returned a mismatched task scope.')
    }
    return task
  }

  return {
    /** Reads and validates the current Team catalog. */
    async catalog(assignedProjectId) {
      const [catalog, templateList] = await Promise.all([
        request('work-item-types', catalogSchema, 'GET', undefined, undefined, { assignedProjectId }),
        // A server older than template support has no such endpoint, so it offers no templates.
        request('work-item-templates', templateListSchema).catch((error: unknown) => {
          if (error instanceof AgentTaskError && error.code === 'not_found') return { teamId: config.teamId, templates: [] }
          throw error
        }),
      ])
      if (catalog.teamId !== config.teamId || templateList.teamId !== config.teamId) {
        throw new AgentTaskError('invalid_response', 'The API returned a mismatched catalog scope.')
      }
      return { ...catalog, templates: templateList.templates }
    },
    /** Reads one Team-qualified task. */
    async get(id) { return scoped(await request(`work-items/${encodeURIComponent(id)}`, taskSchema), id) },
    /** Retains upstream pagination and validates every returned Team identity. */
    async list(filters, cursor, limit = 50) {
      const page = await request('work-items', pageSchema(taskSchema), 'GET', undefined, undefined, { ...filters, cursor, limit })
      return { ...page, items: page.items.map((item) => scoped(item)) }
    },
    /** Creates a canonical task with the original idempotency key. */
    async create(input, key) { return scoped(await request('work-items', taskSchema, 'POST', { ...input, teamId: config.teamId }, key)) },
    /** Forwards revision, run fence, and idempotency without silently retrying conflicts. */
    async update(id, input, key, fence) { return scoped(await request(`work-items/${encodeURIComponent(id)}`, taskSchema, 'PATCH', { ...input, ...fence }, key), id) },
    /** Reads a bounded canonical discussion page. */
    async comments(id, cursor, limit = 50, assignedProjectId) { return request(`work-items/${encodeURIComponent(id)}/comments`, pageSchema(commentSchema), 'GET', undefined, undefined, { cursor, limit, assignedProjectId }) },
    /** Appends one idempotent progress comment, fenced by the run when one is given. */
    async comment(id, body, key, assignedProjectId, assigneeUserId, fence) { return request(`work-items/${encodeURIComponent(id)}/comments`, commentSchema, 'POST', { body, ...fence }, key, { assignedProjectId, assigneeUserId }) },
    /** Claims a task through the run start endpoint. */
    async startRun(id, input, key) {
      const started = await request(`work-items/${encodeURIComponent(id)}/agent-runs`, z.object({ run: runSchema, workItem: taskSchema }), 'POST', input, key)
      return { run: scopedRun(started.run), task: scoped(started.workItem, id) }
    },
    /** Takes over a stalled run with the original idempotency key. */
    async takeOverRun(id, runId, input, key) {
      const taken = await request(
        `work-items/${encodeURIComponent(id)}/agent-runs/${encodeURIComponent(runId)}/take-over`,
        z.object({ run: runSchema, supersededRun: runSchema }), 'POST', input, key,
      )
      const run = scopedRun(taken.run)
      const supersededRun = scopedRun(taken.supersededRun, runId)
      if (run.workItemId !== id || supersededRun.workItemId !== id) {
        throw new AgentTaskError('invalid_response', 'The API returned runs for another task.')
      }
      return { run, supersededRun }
    },
    /** Resumes a started task with the original idempotency key. */
    async resumeRun(id, input, key) {
      const resumed = await request(
        `work-items/${encodeURIComponent(id)}/agent-runs/resume`,
        z.object({ run: runSchema, resumedFromRun: runSchema.optional() }), 'POST', input, key,
      )
      const run = scopedRun(resumed.run)
      const resumedFromRun = resumed.resumedFromRun === undefined ? undefined : scopedRun(resumed.resumedFromRun)
      if (run.workItemId !== id || (resumedFromRun !== undefined && resumedFromRun.workItemId !== id)) {
        throw new AgentTaskError('invalid_response', 'The API returned runs for another task.')
      }
      return { run, ...(resumedFromRun === undefined ? {} : { resumedFromRun }) }
    },
    /** Reads the newest run of a task from its run history. */
    async latestRun(id) {
      const page = await request(`work-items/${encodeURIComponent(id)}/agent-runs`, pageSchema(runSchema), 'GET', undefined, undefined, { limit: 1 })
      const [run] = page.items.map((item) => scopedRun(item))
      if (run && run.workItemId !== id) throw new AgentTaskError('invalid_response', 'The API returned a run for another task.')
      return run
    },
    /** Lists one page of active runs. */
    async listActiveRuns(filters, cursor) {
      const page = await request('agent-runs', pageSchema(runSchema), 'GET', undefined, undefined, { state: 'active', ...filters, cursor, limit: 100 })
      return { ...page, items: page.items.map((run) => scopedRun(run)) }
    },
    /** Strongly reads the run that currently claims one task. */
    async claimedRun(id, owner = {}) {
      const page = await request('agent-runs', pageSchema(runSchema), 'GET', undefined, undefined, {
        state: 'active', workItemId: id, assigneeUserId: owner.assigneeUserId, instanceId: owner.instanceId, limit: 1,
      })
      const [run] = page.items.map((item) => scopedRun(item))
      if (run && run.workItemId !== id) throw new AgentTaskError('invalid_response', 'The API returned a run for another task.')
      if (run && owner.assigneeUserId !== undefined && run.assigneeUserId !== owner.assigneeUserId) {
        throw new AgentTaskError('invalid_response', 'The API returned a run of another assignee.')
      }
      return run
    },
    /** Saves a structured report with the original idempotency key. */
    async reportRun(runId, instanceId, input, key, assignedProjectId) {
      const saved = await request(
        `agent-runs/${encodeURIComponent(runId)}/reports`, reportResultSchema, 'POST', { instanceId, ...input }, key, { assignedProjectId },
      )
      if (saved.report.runId !== runId || saved.report.teamId !== config.teamId) {
        throw new AgentTaskError('invalid_response', 'The API returned a report for another run.')
      }
      return { ...saved, run: scopedRun(saved.run, runId) }
    },
    /** Reads one run. */
    async getRun(runId) { return scopedRun(await request(`agent-runs/${encodeURIComponent(runId)}`, runSchema), runId) },
    /** Extends a run lease; heartbeats need no idempotency key. */
    async heartbeat(runId, instanceId) {
      return scopedRun(await request(`agent-runs/${encodeURIComponent(runId)}/heartbeat`, runSchema, 'POST', { instanceId }), runId)
    },
    /** Closes a run with the original idempotency key. */
    async finishRun(runId, outcome, instanceId, key) {
      return scopedRun(await request(`agent-runs/${encodeURIComponent(runId)}/finish`, runSchema, 'POST', { outcome, instanceId }, key), runId)
    },
    /** Reads Team Agent settings together with the Ready statuses and briefs. */
    async agentSettings(): Promise<AgentSettingsRecord> {
      const [settings, context] = await Promise.all([request('agent-settings', settingsSchema), readAgentContext()])
      if (settings.teamId !== config.teamId || (context !== undefined && context.teamId !== config.teamId)) {
        throw new AgentTaskError('invalid_response', 'The API returned mismatched Agent settings.')
      }
      return {
        ...settings,
        // Servers older than the switch always accept new runs.
        acceptNewRuns: context?.acceptNewRuns ?? true,
        readyStatusIds: context?.readyStatusIds ?? [],
        resumableStatusIds: context?.resumableStatusIds ?? [],
        requireAcceptanceCriteria: context?.requireAcceptanceCriteria ?? false,
        ...(context?.acceptanceCriteriaFieldId === undefined ? {} : { acceptanceCriteriaFieldId: context.acceptanceCriteriaFieldId }),
        ...(context?.brief === undefined ? {} : { brief: context.brief }),
        projectBriefs: context?.projectBriefs ?? {},
      }
    },
    /** Reads a task's acceptance criteria; a server older than the endpoint has none. */
    async acceptanceCriteria(id) {
      let criteria: z.infer<typeof acceptanceCriteriaSchema>
      try {
        criteria = await request(`work-items/${encodeURIComponent(id)}/acceptance-criteria`, acceptanceCriteriaSchema)
      } catch (error) {
        if (error instanceof AgentTaskError && error.code === 'not_found') return []
        throw error
      }
      if (criteria.teamId !== config.teamId || criteria.workItemId !== id) {
        throw new AgentTaskError('invalid_response', 'The API returned acceptance criteria of another task.')
      }
      return criteria.items
    },
    /** Reads a task's estimate, remaining effort, and progress; a server older than the endpoint has none. */
    async effort(id) {
      let effort: z.infer<typeof effortSchema>
      try {
        effort = await request(`work-items/${encodeURIComponent(id)}/effort`, effortSchema)
      } catch (error) {
        if (error instanceof AgentTaskError && error.code === 'not_found') return undefined
        throw error
      }
      if (effort.teamId !== config.teamId || effort.workItemId !== id) {
        throw new AgentTaskError('invalid_response', 'The API returned the effort of another task.')
      }
      return {
        revision: effort.revision,
        ...(effort.plannedEffortMinutes === undefined ? {} : { plannedEffortMinutes: effort.plannedEffortMinutes }),
        ...(effort.remainingEffortMinutes === undefined ? {} : { remainingEffortMinutes: effort.remainingEffortMinutes }),
        ...(effort.progressPercent === undefined ? {} : { progressPercent: effort.progressPercent }),
      }
    },
    /** Reads a task's actual start and end dates; a server older than the endpoint has none. */
    async actualDates(id) {
      let found: z.infer<typeof actualDatesSchema>
      try {
        found = await request(`work-items/${encodeURIComponent(id)}/actual-dates`, actualDatesSchema)
      } catch (error) {
        if (error instanceof AgentTaskError && error.code === 'not_found') return undefined
        throw error
      }
      if (found.teamId !== config.teamId || found.workItemId !== id) {
        throw new AgentTaskError('invalid_response', 'The API returned the actual dates of another task.')
      }
      return {
        revision: found.revision,
        ...(found.actualStartDate === undefined ? {} : { actualStartDate: found.actualStartDate }),
        ...(found.actualEndDate === undefined ? {} : { actualEndDate: found.actualEndDate }),
      }
    },
    /** Reads a task's parent, children, and WBS number; a server older than the endpoint has none. */
    async hierarchy(id) {
      let found: z.infer<typeof hierarchySchema>
      try {
        found = await request(`work-items/${encodeURIComponent(id)}/hierarchy`, hierarchySchema)
      } catch (error) {
        if (error instanceof AgentTaskError && error.code === 'not_found') return undefined
        throw error
      }
      if (found.teamId !== config.teamId || found.workItemId !== id) {
        throw new AgentTaskError('invalid_response', 'The API returned the hierarchy of another task.')
      }
      return {
        parentWorkItemId: found.parentWorkItemId,
        childWorkItemIds: found.childWorkItemIds,
        ...(found.wbsNumber === undefined ? {} : { wbsNumber: found.wbsNumber }),
      }
    },
    /** Evaluates the Team's completion Gate against a task; a server older than the endpoint has none. */
    async completionGate(id) {
      let found: z.infer<typeof completionGateSchema>
      try {
        found = await request(`work-items/${encodeURIComponent(id)}/completion-gate`, completionGateSchema)
      } catch (error) {
        if (error instanceof AgentTaskError && error.code === 'not_found') return undefined
        throw error
      }
      if (found.teamId !== config.teamId || found.workItemId !== id) {
        throw new AgentTaskError('invalid_response', 'The API returned the completion Gate of another task.')
      }
      return {
        revision: found.revision,
        // A newer server may evaluate conditions this client does not know; blocksCompletion still counts them.
        conditions: found.conditions.flatMap(({ condition, requirement, state, message }) => {
          const known = WORK_ITEM_COMPLETION_GATE_CONDITIONS.find((candidate) => candidate === condition)
          return known === undefined
            ? []
            : [{ condition: known, requirement, state, ...(message === undefined ? {} : { message }) }]
        }),
        blocksCompletion: found.blocksCompletion,
      }
    },
    /** Reads a task's key and its Work Item's creation time; a server older than the endpoint has neither. */
    async taskKey(id) {
      let found: z.infer<typeof keySchema>
      try {
        found = await request(`work-items/${encodeURIComponent(id)}/key`, keySchema)
      } catch (error) {
        if (error instanceof AgentTaskError && error.code === 'not_found') return undefined
        throw error
      }
      if (found.teamId !== config.teamId || found.workItemId !== id) {
        throw new AgentTaskError('invalid_response', 'The API returned the key of another task.')
      }
      return { createdAt: found.createdAt, ...(found.key === undefined ? {} : { key: found.key }) }
    },
    /** Reads one page of a task's visible linked Documents; a server older than the endpoint has none. */
    async relatedDocuments(id, cursor, limit = 20) {
      try {
        return await request(`work-items/${encodeURIComponent(id)}/documents`, pageSchema(linkedDocumentSchema), 'GET', undefined, undefined, { cursor, limit })
      } catch (error) {
        if (error instanceof AgentTaskError && error.code === 'not_found') return undefined
        throw error
      }
    },
    /** Reads a task's agent questions with their answers; a server older than the endpoint has none. */
    async questions(id) {
      let found: AgentTaskQuestions
      try {
        found = await request(`work-items/${encodeURIComponent(id)}/agent-run-questions`, questionsSchema)
      } catch (error) {
        if (error instanceof AgentTaskError && error.code === 'not_found') return undefined
        throw error
      }
      if (found.items.some((report) => report.teamId !== config.teamId || report.workItemId !== id)) {
        throw new AgentTaskError('invalid_response', 'The API returned the questions of another task.')
      }
      return found
    },
    /** Reads a Project charter of the configured Team; a server older than the endpoint has none. */
    async projectCharter(projectId) {
      let found: PublicProjectCharter
      try {
        found = await request(`projects/${encodeURIComponent(projectId)}/charter`, projectCharterSchema)
      } catch (error) {
        if (error instanceof AgentTaskError && error.code === 'not_found') return undefined
        throw error
      }
      if (found.teamId !== config.teamId || found.projectId !== projectId) {
        throw new AgentTaskError('invalid_response', 'The API returned the charter of another Project.')
      }
      return found
    },
    /** Reads one linked Document as Markdown. */
    async document(id, documentId) {
      const found = await request(`work-items/${encodeURIComponent(id)}/documents/${encodeURIComponent(documentId)}`, documentSchema)
      if (found.id !== documentId) throw new AgentTaskError('invalid_response', 'The API returned another Document.')
      return found
    },
    /** Lists a task's downloadable attachments; a server older than the endpoint has none. */
    async attachments(id) {
      try {
        return (await request(`work-items/${encodeURIComponent(id)}/attachments`, attachmentListSchema)).items
      } catch (error) {
        if (error instanceof AgentTaskError && error.code === 'not_found') return undefined
        throw error
      }
    },
    /** Issues a short-lived download URL for one attachment. */
    async attachmentDownload(id, fileId) {
      const found = await request(`work-items/${encodeURIComponent(id)}/attachments/${encodeURIComponent(fileId)}/download`, attachmentDownloadSchema)
      if (found.fileId !== fileId) throw new AgentTaskError('invalid_response', 'The API returned another attachment.')
      return found
    },
  }

  /**
   * Reads the Ready statuses and briefs.
   *
   * @returns The context, or undefined from a server older than the endpoint, which has neither.
   */
  async function readAgentContext() {
    try {
      return await request('agent-context', contextSchema)
    } catch (error) {
      if (error instanceof AgentTaskError && error.code === 'not_found') return undefined
      throw error
    }
  }
}
