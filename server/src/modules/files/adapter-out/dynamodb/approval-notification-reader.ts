import { GetCommand } from '@aws-sdk/lib-dynamodb'
import type { ApprovalNotificationReader } from '../../approval-notification'
import { createFileProofingScopeKey } from '../../file-proofing'

/** Minimal strongly consistent metadata read boundary. */
type ApprovalNotificationClient = {
  /** Reads one canonical approval or file row. */
  send(command: GetCommand): Promise<{ /** Canonical metadata, absent when removed. */ Item?: Record<string, unknown> }>
}

/**
 * Creates a metadata-only reader for approval notification visibility.
 * @param client - DynamoDB document client supplied by the composition root.
 * @param tableName - Owning File Proofing table.
 * @returns A reader that rejects deleted files, revoked guest access and corrupt source identities.
 */
export function createApprovalNotificationReader(client: ApprovalNotificationClient, tableName: string): ApprovalNotificationReader {
  return async (source) => {
    const scopeKey = createFileProofingScopeKey({
      workspaceId: source.workspaceId, teamId: source.teamId, issueId: source.issueId, kind: 'work-item',
    })
    /** Reads a canonical row without using an eventually consistent index. */
    const read = async (recordKey: string) => (await client.send(new GetCommand({
      TableName: tableName, Key: { scopeKey, recordKey }, ConsistentRead: true,
    }))).Item
    const approvalKey = `APPROVAL#${source.approvalId}`
    const approval = await read(approvalKey)
    if (!approval) return false
    if (approval.scopeKey !== scopeKey || approval.recordKey !== approvalKey || approval.entryType !== 'approval' ||
      approval.workspaceId !== source.workspaceId || approval.teamId !== source.teamId || approval.issueId !== source.issueId ||
      approval.id !== source.approvalId) throw invalidSource()
    if (approval.subjectType === 'work-item') return source.fileId === undefined && !source.guest
    if (approval.subjectType !== undefined && approval.subjectType !== 'file-version' ||
      typeof approval.fileId !== 'string' || !approval.fileId.trim() ||
      typeof approval.versionId !== 'string' || !approval.versionId.trim()) throw invalidSource()
    if (source.fileId !== undefined && source.fileId !== approval.fileId) return false
    const fileKey = `FILE#${approval.fileId}`
    const file = await read(fileKey)
    if (!file) return false
    if (file.scopeKey !== scopeKey || file.recordKey !== fileKey || file.entryType !== 'file' ||
      file.workspaceId !== source.workspaceId || file.teamId !== source.teamId || file.issueId !== source.issueId ||
      file.fileId !== approval.fileId || typeof file.guestAccess !== 'boolean') throw invalidSource()
    return file.deletedAt === undefined && (!source.guest || file.guestAccess)
  }
}

/** Produces a safe error without persisted metadata or identifiers. */
function invalidSource(): Error { return new Error('Invalid approval notification source.') }
