import type { PlanningUpdateTarget } from '@mukuroji/contracts'

/** Compact, noncanonical activity for one target's latest immutable update. */
export type PlanningUpdateActivity = {
  /** Qualified canonical target. */ target: PlanningUpdateTarget
  /** Immutable version these signals describe. */ version: number
  /** Independent optimistic revision, never a Planning graph revision. */ revision: number
  /** Most recent successfully added comment timestamp. */ commentAt?: string
  /** Most recent successfully added reaction timestamp, including subsequently removed reactions. */ reactionAt?: string
  /** At most 32 most recently active distinct members; no comment text or reaction values. */ participants: { /** Normalized actor. */ memberKey: string; /** Latest successful interaction time. */ at: string }[]
}

/** Advances compact activity after a source annotation commits atomically.
 * @param previous - Prior target projection, possibly for an older immutable version.
 * @param target - Current canonical target.
 * @param version - Current immutable version.
 * @param kind - Successfully added annotation kind.
 * @param memberKey - Server-resolved actor.
 * @param at - Source annotation timestamp.
 * @returns Monotonic compact activity with a bounded recent-member window.
 */
export function advancePlanningUpdateActivity(previous: PlanningUpdateActivity | undefined, target: PlanningUpdateTarget, version: number, kind: 'comment' | 'reaction', memberKey: string, at: string): PlanningUpdateActivity {
  const current = previous?.version === version ? previous : undefined
  const previousAt = kind === 'comment' ? current?.commentAt : current?.reactionAt
  const member = memberKey.trim().toLowerCase()
  const existing = current?.participants.find((participant) => participant.memberKey === member)
  const participants = [...(current?.participants.filter((participant) => participant.memberKey !== member) ?? []), { memberKey: member, at: existing && existing.at > at ? existing.at : at }]
    .sort((a, b) => b.at.localeCompare(a.at) || a.memberKey.localeCompare(b.memberKey)).slice(0, 32)
  return { target, version, revision: (previous?.revision ?? 0) + 1, ...(current?.commentAt ? { commentAt: current.commentAt } : {}), ...(current?.reactionAt ? { reactionAt: current.reactionAt } : {}), [kind === 'comment' ? 'commentAt' : 'reactionAt']: previousAt && previousAt > at ? previousAt : at, participants }
}

/** Validates untrusted compact projection content without retaining unknown fields.
 * @param value - Persisted projection value.
 * @returns Validated projection, or undefined for corrupt/unknown content.
 */
export function readPlanningUpdateActivity(value: unknown): PlanningUpdateActivity | undefined {
  if (!record(value) || !record(value.target) || !positive(value.version) || !positive(value.revision) || value.revision >= Number.MAX_SAFE_INTEGER || !Array.isArray(value.participants) || value.participants.length > 32 || !value.participants.every(participant) || new Set(value.participants.map((item) => item.memberKey)).size !== value.participants.length || value.commentAt !== undefined && !timestamp(value.commentAt) || value.reactionAt !== undefined && !timestamp(value.reactionAt)) return undefined
  const target = value.target.type === 'project' && identifier(value.target.teamId) && identifier(value.target.projectId) ? { type: 'project', teamId: value.target.teamId, projectId: value.target.projectId } satisfies PlanningUpdateTarget : value.target.type === 'initiative' && identifier(value.target.entityId) ? { type: 'initiative', entityId: value.target.entityId } satisfies PlanningUpdateTarget : undefined
  if (!target) return undefined
  return { target, version: value.version, revision: value.revision, ...(timestamp(value.commentAt) ? { commentAt: value.commentAt } : {}), ...(timestamp(value.reactionAt) ? { reactionAt: value.reactionAt } : {}), participants: value.participants.map(({ memberKey, at }) => ({ memberKey, at })) }
}
/** Narrows a persisted JSON object. */
function record(value: unknown): value is Record<string, unknown> { return typeof value === 'object' && value !== null && !Array.isArray(value) }
/** Narrows a bounded opaque identity. */
function identifier(value: unknown): value is string { return typeof value === 'string' && value.length > 0 && value.length <= 512 && value.trim() === value }
/** Narrows a monotonic version/revision. */
function positive(value: unknown): value is number { return typeof value === 'number' && Number.isSafeInteger(value) && value > 0 }
/** Narrows a canonical UTC source timestamp for stable ordering. */
function timestamp(value: unknown): value is string { return typeof value === 'string' && Number.isFinite(Date.parse(value)) && new Date(value).toISOString() === value }
/** Narrows a normalized recent participant record. */
function participant(value: unknown): value is PlanningUpdateActivity['participants'][number] { return record(value) && identifier(value.memberKey) && value.memberKey.toLowerCase() === value.memberKey && timestamp(value.at) }
