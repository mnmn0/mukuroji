import type { PlanningUpdateTarget, SetUpdateFeedReadStateInput, UpdateFeedReadState, UpdateFeedResponse } from '@mukuroji/contracts'
import { PlanningError } from '../../planning'
import type { UpdateFeedReader } from './read-update-feed'

/** Exact immutable report identity used by the read-state store. */
export type UpdateFeedReportReference = {
  /** Team-qualified target. */
  target: PlanningUpdateTarget
  /** Immutable version. */
  version: number
}

/** Principal-bound read-state persistence; no update content is stored. */
export interface UpdateFeedReadStateStore {
  /** Reads at most 100 exact keys using strongly consistent storage.
   * @param workspaceId - Server-resolved Workspace.
   * @param memberKey - Authenticated member identity.
   * @param reports - Authorized report versions, bounded by feed response size.
   * @returns Logical report keys mapped to personal state.
   */
  getMany(workspaceId: string, memberKey: string, reports: readonly UpdateFeedReportReference[]): Promise<ReadonlyMap<string, UpdateFeedReadState>>
  /** Atomically guards personal state and the Planning authorization revision.
   * @param workspaceId - Server-resolved Workspace.
   * @param memberKey - Authenticated member identity.
   * @param input - Desired state and expected personal revision.
   * @param planningRevision - Revision spanning authorization checks.
   * @returns Committed personal state.
   */
  set(workspaceId: string, memberKey: string, input: SetUpdateFeedReadStateInput, planningRevision: number): Promise<UpdateFeedReadState>
}

/** Returns an unambiguous public identity for an immutable report.
 * @param report - Qualified target and immutable version.
 * @returns Stable logical identity.
 */
export function updateFeedReportKey(report: UpdateFeedReportReference): string {
  const target = report.target
  return JSON.stringify(target.type === 'project' ? ['project', target.teamId, target.projectId, report.version] : ['initiative', target.entityId, report.version])
}

/** Adds personal state only after target/content authorization and response bounding.
 * @param store - Durable personal state port.
 * @param workspaceId - Server-resolved Workspace.
 * @param memberKey - Authenticated member identity.
 * @param feed - Authorized and bounded response.
 * @returns Feed with personal state for published reports only.
 */
export async function withUpdateFeedReadState(store: UpdateFeedReadStateStore, workspaceId: string, memberKey: string, feed: UpdateFeedResponse): Promise<UpdateFeedResponse> {
  const reports = feed.entries.flatMap((entry) => entry.latestUpdate ? [{ target: entry.target, version: entry.latestUpdate.version }] : [])
  const states = await store.getMany(workspaceId, memberKey, reports)
  return { ...feed, entries: feed.entries.map((entry) => entry.latestUpdate ? {
    ...entry,
    readState: states.get(updateFeedReportKey({ target: entry.target, version: entry.latestUpdate.version })) ?? { read: false, revision: 0 },
  } : entry) }
}

/** Validates an explicit personal state command without trusting client scope or identity.
 * @param value - Untrusted HTTP JSON body.
 * @returns Reconstructed command without client member or Workspace fields.
 */
export function parseUpdateFeedReadState(value: unknown): SetUpdateFeedReadStateInput {
  if (!isObject(value) || !isObject(value.target) || typeof value.read !== 'boolean' ||
    !Number.isSafeInteger(value.version) || typeof value.version !== 'number' || value.version < 1 ||
    !Number.isSafeInteger(value.expectedRevision) || typeof value.expectedRevision !== 'number' || value.expectedRevision < 0 || value.expectedRevision >= Number.MAX_SAFE_INTEGER) {
    throw new PlanningError(400, 'UpdateFeedReadStateInvalid', 'Invalid read-state command.')
  }
  const target = value.target
  if (target.type === 'project' && isIdentifier(target.teamId) && isIdentifier(target.projectId)) {
    return { target: { type: 'project', teamId: target.teamId, projectId: target.projectId }, version: value.version, read: value.read, expectedRevision: value.expectedRevision }
  }
  if (target.type === 'initiative' && isIdentifier(target.entityId)) {
    return { target: { type: 'initiative', entityId: target.entityId }, version: value.version, read: value.read, expectedRevision: value.expectedRevision }
  }
  throw new PlanningError(400, 'UpdateFeedReadStateInvalid', 'Invalid report target.')
}

/** Reauthorizes the exact visible report before a revision-guarded personal state write.
 * @param reader - Principal-bound graph and authorization ports.
 * @param store - Personal state persistence port.
 * @param workspaceId - Server-resolved Workspace.
 * @param input - Validated desired state and expected revision.
 * @returns Committed personal state.
 */
export async function setUpdateFeedReadState(reader: UpdateFeedReader, store: UpdateFeedReadStateStore, workspaceId: string, input: SetUpdateFeedReadStateInput): Promise<UpdateFeedReadState> {
  const snapshot = await reader.readSnapshot()
  const candidate = snapshot.updateTargets.find((summary) => updateFeedReportKey({ target: summary.target, version: input.version }) === updateFeedReportKey(input))
  const authorized = candidate && !candidate.archivedAt ? await reader.authorizeTarget(candidate, snapshot) : undefined
  if (!authorized?.latestUpdate || authorized.latestUpdate.version !== input.version) {
    throw new PlanningError(404, 'UpdateFeedReportUnavailable', 'This report is no longer available.')
  }
  return store.set(workspaceId, reader.memberKey, input, snapshot.revision)
}

/** Narrows a non-array object at the HTTP boundary. */
function isObject(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value)
}

/** Accepts bounded opaque identifiers without control characters. */
function isIdentifier(value: unknown): value is string {
  return typeof value === 'string' && value.length > 0 && value.length <= 512 &&
    Array.from(value).every((character) => character.charCodeAt(0) > 31 && character.charCodeAt(0) !== 127)
}
