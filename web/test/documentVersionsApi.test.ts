import { afterEach, describe, expect, test } from 'bun:test'
import type { ApprovalRequest } from '@mukuroji/contracts'
import { getDocumentApprovals, getDocumentVersion } from '../src/documents/api/versions'
import { documentRecordFixture, whiteboardRecordFixture } from '../src/documents/fixtures'

const originalFetch = globalThis.fetch

afterEach(() => {
  globalThis.fetch = originalFetch
})

/**
 * Replaces fetch with a fake that answers every request with one JSON body.
 *
 * @param body - JSON response body.
 */
function installFetch(body: unknown) {
  const fakeFetch: typeof fetch = async () => Response.json(body)
  globalThis.fetch = fakeFetch
}

const version = {
  schemaVersion: 1,
  id: `${documentRecordFixture.id}:1`,
  documentId: documentRecordFixture.id,
  revision: 1,
  kind: 'page',
  title: 'Spec v1',
  reason: 'edit',
  createdByUserId: 'owner@example.com',
  createdAt: '2026-11-01T00:00:00.000Z',
}

const approval: ApprovalRequest = {
  id: 'approval-1',
  subjectType: 'document-version',
  documentId: documentRecordFixture.id,
  versionId: version.id,
  teamId: 'core',
  issueId: 'ENG-1',
  revision: 1,
  status: 'pending',
  reviewers: [{ memberKey: 'reviewer@example.com', status: 'pending' }],
  dueAt: '2026-11-30T00:00:00.000Z',
  requestedByMemberKey: 'owner@example.com',
  requestedByKind: 'member',
  createdAt: '2026-11-02T00:00:00.000Z',
  updatedAt: '2026-11-02T00:00:00.000Z',
  capabilities: { canDecide: false, canCancel: false },
}

describe('Document version API response validation', () => {
  test('reads page and whiteboard snapshots with the content of their kind', async () => {
    installFetch({ version: { version, document: documentRecordFixture } })
    await expect(getDocumentVersion('token', documentRecordFixture.id, version.id))
      .resolves.toMatchObject({ document: { id: documentRecordFixture.id } })

    installFetch({ version: { version, document: whiteboardRecordFixture } })
    await expect(getDocumentVersion('token', documentRecordFixture.id, version.id))
      .resolves.toMatchObject({ document: { kind: 'whiteboard' } })
  })

  test('rejects a snapshot that lacks the content of its kind', async () => {
    for (const document of [
      { id: 'd', title: 'T', revision: 1, kind: 'whiteboard' },
      { id: 'd', title: 'T', revision: 1, kind: 'page', blocks: [null] },
      { id: 'd', title: 'T', kind: 'page', blocks: [] },
    ]) {
      installFetch({ version: { version, document } })
      await expect(getDocumentVersion('token', documentRecordFixture.id, version.id))
        .rejects.toMatchObject({ status: 502, code: 'InvalidDocumentVersionResponse' })
    }
  })

  test('reads approvals and fails the whole list on one malformed approval', async () => {
    installFetch({ approvals: [approval] })
    await expect(getDocumentApprovals('token', documentRecordFixture.id)).resolves.toEqual([approval])

    for (const malformed of [
      { ...approval, reviewers: [null] },
      { ...approval, reviewers: [{ memberKey: 'reviewer@example.com', status: 'unknown' }] },
      { ...approval, status: 'archived' },
      { ...approval, dueAt: undefined },
      { ...approval, capabilities: undefined },
    ]) {
      installFetch({ approvals: [approval, malformed] })
      await expect(getDocumentApprovals('token', documentRecordFixture.id))
        .rejects.toMatchObject({ status: 502, code: 'InvalidDocumentVersionResponse' })
    }
  })
})
