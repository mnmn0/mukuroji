import { describe, expect, test } from 'bun:test'
import { createApprovalNotificationReader } from './approval-notification-reader'
import { createFileProofingScopeKey } from '../../file-proofing'

/** Creates current canonical approval/file rows with controllable changes. */
function fixture() {
  const source = { workspaceId: 'workspace-1', teamId: 'core', issueId: 'item-1', approvalId: 'approval-1', fileId: 'file-1', guest: false }
  const scopeKey = createFileProofingScopeKey({ ...source, kind: 'work-item' })
  const approval: Record<string, unknown> = { ...source, scopeKey, recordKey: 'APPROVAL#approval-1',
    entryType: 'approval', id: source.approvalId, subjectType: 'file-version', versionId: 'version-1' }
  const file: Record<string, unknown> = { ...source, scopeKey, recordKey: 'FILE#file-1', entryType: 'file', guestAccess: true }
  const rows = new Map([['APPROVAL#approval-1', approval], ['FILE#file-1', file]])
  const read = createApprovalNotificationReader({ async send(command) {
    expect(command.input.ConsistentRead).toBe(true)
    expect(command.input.Key?.scopeKey).toBe(scopeKey)
    return { Item: rows.get(String(command.input.Key?.recordKey)) }
  } }, 'files')
  return { source, read, approval, file, rows }
}

describe('approval notification source visibility', () => {
  test('rechecks deletion and guest revocation on canonical rows, including legacy notifications', async () => {
    const f = fixture()
    expect(await f.read(f.source)).toBe(true)
    expect(await f.read({ ...f.source, guest: true })).toBe(true)
    f.file.guestAccess = false
    expect(await f.read({ ...f.source, guest: true })).toBe(false)
    expect(await f.read(f.source)).toBe(true)
    f.file.deletedAt = '2026-09-26T11:00:00Z'
    expect(await f.read(f.source)).toBe(false)
    const { fileId: _capturedFile, ...legacy } = f.source
    expect(await f.read(legacy)).toBe(false)
    delete f.file.deletedAt
    expect(await f.read(legacy)).toBe(true)
    f.rows.delete('FILE#file-1')
    expect(await f.read(f.source)).toBe(false)
    f.rows.delete('APPROVAL#approval-1')
    expect(await f.read(f.source)).toBe(false)
  })
  test('distinguishes Work Item subjects and denies changed file subjects', async () => {
    const f = fixture()
    expect(await f.read({ ...f.source, fileId: 'other-file' })).toBe(false)
    f.approval.subjectType = 'work-item'
    delete f.approval.fileId
    delete f.approval.versionId
    expect(await f.read(f.source)).toBe(false)
    const { fileId: _capturedFile, ...source } = f.source
    expect(await f.read(source)).toBe(true)
    expect(await f.read({ ...source, guest: true })).toBe(false)
  })
  test('surfaces corrupt identities and transient reads rather than silently discarding work', async () => {
    for (const subject of ['approval', 'file'] as const) {
      const f = fixture()
      f[subject].workspaceId = 'other-workspace'
      await expect(f.read(f.source)).rejects.toThrow('Invalid approval notification source')
    }
    const f = fixture()
    delete f.approval.fileId
    await expect(f.read(f.source)).rejects.toThrow('Invalid approval notification source')
    const read = createApprovalNotificationReader({ async send() { throw new Error('Unavailable') } }, 'files')
    await expect(read(f.source)).rejects.toThrow('Unavailable')
  })
})
