import { describe, expect, test } from 'bun:test'
import type { DocumentOperation } from '@mukuroji/contracts'
import {
  documentRecordFixture,
  documentSummaryFixtures,
  whiteboardRecordFixture,
} from '../src/documents/fixtures'
import {
  applyDocumentOperationsLocally,
  buildDocumentTree,
  changesDocumentBacklinks,
  createDocumentMutationQueue,
  deduplicateDocumentRelationTargets,
  DocumentOperationChunkSaveError,
  isDocumentTitleCommitCurrent,
  isDocumentTitleDirty,
  refreshDocumentOperationCachesAfterFailure,
  resolveDocumentMutationRevision,
  resolvePendingPublicShareCreateRequest,
  resolveSafeEmbedUrl,
  runAfterSavingDocumentDraft,
  saveAllPendingDocumentChanges,
  saveDocumentOperationChunks,
  shouldAdoptIncomingDocument,
  shouldScheduleDocumentAutosave,
} from '../src/documents/model/document'

describe('Document tree model', () => {
  test('builds scoped recursive branches in lexical position order', () => {
    const branches = buildDocumentTree(
      documentSummaryFixtures,
      { type: 'workspace' },
    )

    expect(branches.map((branch) => branch.document.id)).toEqual([
      'product-handbook',
      'weekly-notes-template',
      'research-archive',
    ])
    expect(
      branches[0]?.children.map((branch) => branch.document.id),
    ).toEqual(['product-principles', 'decision-log'])
  })

  test('cuts parent cycles and keeps the affected nodes reachable', () => {
    const first = {
      ...documentSummaryFixtures[0]!,
      childCount: 1,
      id: 'cycle-a',
      parentId: 'cycle-b',
    }
    const second = {
      ...documentSummaryFixtures[0]!,
      childCount: 1,
      id: 'cycle-b',
      parentId: 'cycle-a',
    }

    const branches = buildDocumentTree(
      [first, second],
      { type: 'workspace' },
    )

    expect(branches.map((branch) => branch.document.id).sort()).toEqual([
      'cycle-a',
      'cycle-b',
    ])
  })
})

describe('Document backlink target collection', () => {
  test('deduplicates canonical targets before backlink requests', () => {
    expect(
      deduplicateDocumentRelationTargets([
        {
          id: 'relation-work-item-1',
          target: {
            kind: 'work-item',
            workItemId: 'team:core-team:issue:launch-review',
          },
        },
        {
          id: 'relation-work-item-2',
          target: {
            kind: 'work-item',
            workItemId: 'team:core-team:issue:launch-review',
          },
        },
        {
          id: 'relation-project',
          target: {
            kind: 'project',
            projectId: 'refero',
          },
        },
      ]),
    ).toEqual([
      {
        kind: 'work-item',
        workItemId: 'team:core-team:issue:launch-review',
      },
      {
        kind: 'project',
        projectId: 'refero',
      },
    ])
  })

  test('includes Whiteboard Work Item cards and deduplicates explicit targets', () => {
    expect(
      deduplicateDocumentRelationTargets(
        [{
          id: 'relation-work-item',
          target: {
            kind: 'work-item',
            workItemId: 'team/core/issue/launch',
          },
        }],
        [{
          bounds: {
            height: 100,
            width: 180,
            x: 0,
            y: 0,
          },
          id: 'work-item-card-1',
          type: 'work-item',
          workItemId: 'team/core/issue/launch',
          zIndex: 1,
        }, {
          bounds: {
            height: 100,
            width: 180,
            x: 200,
            y: 0,
          },
          id: 'work-item-card-2',
          type: 'work-item',
          workItemId: 'team/core/issue/follow-up',
          zIndex: 2,
        }],
      ),
    ).toEqual([
      {
        kind: 'work-item',
        workItemId: 'team/core/issue/launch',
      },
      {
        kind: 'work-item',
        workItemId: 'team/core/issue/follow-up',
      },
    ])
  })

  test('identifies every operation that can change explicit or system backlinks', () => {
    expect(changesDocumentBacklinks([{
      type: 'upsert-relation',
      operationId: 'relation-upsert',
      relation: {
        id: 'relation-1',
        source: { kind: 'document' },
        target: {
          kind: 'goal',
          goalId: 'goal-1',
        },
        createdByUserId: 'member-1',
        createdAt: '2026-07-19T00:00:00.000Z',
      },
    }])).toBe(true)
    expect(changesDocumentBacklinks([{
      type: 'delete-relation',
      operationId: 'relation-delete',
      relationId: 'relation-1',
    }])).toBe(true)
    const workItemObject = {
      bounds: {
        height: 100,
        width: 180,
        x: 0,
        y: 0,
      },
      id: 'work-item-card',
      type: 'work-item' as const,
      workItemId: 'team/core/issue/launch',
      zIndex: 1,
    }
    const systemBacklinkOperations = [{
      object: workItemObject,
      operationId: 'object-insert',
      type: 'insert-object',
    }, {
      object: {
        ...workItemObject,
        workItemId: 'team/core/issue/follow-up',
      },
      objectId: workItemObject.id,
      operationId: 'object-update',
      type: 'update-object',
    }, {
      objectId: workItemObject.id,
      operationId: 'object-delete',
      type: 'delete-object',
    }, {
      blockId: 'block-with-relation',
      operationId: 'block-delete',
      type: 'delete-block',
    }] satisfies DocumentOperation[]
    for (const operation of systemBacklinkOperations) {
      expect(changesDocumentBacklinks([operation])).toBe(true)
    }
    expect(changesDocumentBacklinks([{
      type: 'update-block',
      operationId: 'block-update',
      blockId: 'block-1',
      block: {
        id: 'block-1',
        type: 'paragraph',
        text: 'Unrelated edit',
      },
    }])).toBe(false)
  })
})

describe('Document operation reducer', () => {
  test('applies canonical block operations without mutating the source', () => {
    const originalText =
      documentRecordFixture.kind === 'page'
        ? documentRecordFixture.blocks[1]?.type === 'paragraph'
          ? documentRecordFixture.blocks[1].text
          : undefined
        : undefined
    const operation: DocumentOperation = {
      block: {
        id: 'paragraph-context',
        text: 'A locally edited paragraph',
        type: 'paragraph',
      },
      blockId: 'paragraph-context',
      operationId: 'operation-update-paragraph',
      type: 'update-block',
    }

    const updated = applyDocumentOperationsLocally(
      documentRecordFixture,
      [operation],
    )

    expect(updated.kind).toBe('page')
    expect(
      updated.kind === 'page' &&
        updated.blocks.find((block) => block.id === 'paragraph-context'),
    ).toEqual(operation.block)
    expect(originalText).toContain('Keep the product rationale')
  })

  test('removes connectors and frame membership with a deleted object', () => {
    const updated = applyDocumentOperationsLocally(
      whiteboardRecordFixture,
      [{
        objectId: 'board-note',
        operationId: 'operation-delete-note',
        type: 'delete-object',
      }],
    )

    expect(updated.kind).toBe('whiteboard')
    if (updated.kind !== 'whiteboard') return
    expect(updated.whiteboard.objects.map((object) => object.id)).toEqual([
      'board-work-item',
    ])
    expect(updated.whiteboard.connectors).toEqual([])
    expect(updated.whiteboard.frames[0]?.objectIds).toEqual([
      'board-work-item',
    ])
  })
})

describe('Concurrent editor adoption guard', () => {
  test('does not replace pending or saving local edits with polling data', () => {
    expect(shouldAdoptIncomingDocument({
      incomingRevision: 9,
      localRevision: 7,
      pendingOperationCount: 1,
      saveStatus: 'saving',
    })).toBe(false)
    expect(shouldAdoptIncomingDocument({
      incomingRevision: 9,
      localRevision: 7,
      pendingOperationCount: 0,
      saveStatus: 'saving',
    })).toBe(false)
    expect(shouldAdoptIncomingDocument({
      hasDirtyTitle: true,
      incomingRevision: 9,
      localRevision: 7,
      pendingOperationCount: 0,
      saveStatus: 'saved',
    })).toBe(false)
    expect(shouldAdoptIncomingDocument({
      incomingRevision: 9,
      localRevision: 7,
      pendingOperationCount: 0,
      saveStatus: 'conflict',
    })).toBe(false)
    expect(shouldAdoptIncomingDocument({
      incomingRevision: 9,
      localRevision: 7,
      pendingOperationCount: 0,
      saveStatus: 'error',
    })).toBe(false)
  })

  test('adopts a newer concurrent revision after the local queue clears', () => {
    expect(shouldAdoptIncomingDocument({
      incomingRevision: 9,
      localRevision: 8,
      pendingOperationCount: 0,
      saveStatus: 'saved',
    })).toBe(true)
    expect(shouldAdoptIncomingDocument({
      incomingRevision: 7,
      localRevision: 8,
      pendingOperationCount: 0,
      saveStatus: 'saved',
    })).toBe(false)
  })

  test('requires explicit overwrite before a conflicted batch can autosave', () => {
    expect(shouldScheduleDocumentAutosave('conflict')).toBe(false)
    expect(shouldScheduleDocumentAutosave('error')).toBe(false)
    expect(shouldScheduleDocumentAutosave('saving')).toBe(true)
  })
})

describe('Document operation chunk saving', () => {
  const operations = Array.from(
    { length: 9 },
    (_, index): DocumentOperation => ({
      block: {
        id: `paragraph-${index}`,
        text: `Change ${index}`,
        type: 'paragraph',
      },
      blockId: `paragraph-${index}`,
      operationId: `operation-${index}`,
      type: 'update-block',
    }),
  )

  test('limits chunks to the transaction-safe size and chains each returned revision', async () => {
    const calls: Array<{ revision: number; size: number }> = []
    const saved = await saveDocumentOperationChunks(
      operations,
      7,
      async (revision, chunk) => {
        calls.push({ revision, size: chunk.length })
        return {
          committedRevision: revision + 1,
          document: {
            ...documentRecordFixture,
            revision: revision + 100,
          },
        }
      },
    )

    expect(calls).toEqual([
      { revision: 7, size: 4 },
      { revision: 8, size: 4 },
      { revision: 9, size: 1 },
    ])
    expect(saved?.committedRevision).toBe(10)
    expect(saved?.document.revision).toBe(109)
  })

  test('retains the failed chunk and all unsent operations after partial success', async () => {
    let calls = 0
    let capturedError: unknown
    try {
      await saveDocumentOperationChunks(
        operations,
        7,
        async (revision) => {
          calls += 1
          if (calls === 2) throw new Error('network failure')
          return {
            committedRevision: revision + 1,
            document: {
              ...documentRecordFixture,
              revision: revision + 100,
            },
          }
        },
      )
    } catch (error) {
      capturedError = error
    }

    expect(capturedError).toBeInstanceOf(
      DocumentOperationChunkSaveError,
    )
    const chunkError =
      capturedError as DocumentOperationChunkSaveError
    expect(chunkError.lastCommittedRevision).toBe(8)
    expect(chunkError.lastSavedDocument?.revision).toBe(107)
    expect(chunkError.remainingOperations).toHaveLength(5)
    expect(chunkError.remainingOperations[0]?.operationId).toBe(
      'operation-4',
    )
  })

  test('refreshes every affected cache after a partial operation save', async () => {
    const lastSavedDocument = {
      ...documentRecordFixture,
      revision: 8,
    }
    const error = new DocumentOperationChunkSaveError(
      new Error('network failure'),
      [{
        blockId: 'block-with-relation',
        operationId: 'delete-related-block',
        type: 'delete-block',
      }],
      {
        committedRevision: 8,
        document: lastSavedDocument,
      },
    )
    const events: string[] = []
    let selectedDocument: typeof lastSavedDocument | undefined

    await refreshDocumentOperationCachesAfterFailure(
      error,
      [
        ...operations.slice(0, 4),
        ...error.remainingOperations,
      ],
      {
        refreshBacklinks: async () => {
          events.push('backlinks')
        },
        refreshDocuments: async () => {
          events.push('documents')
          throw new Error('collection refresh failed')
        },
        refreshSelectedDocument: async (document) => {
          events.push('selected')
          selectedDocument = document
        },
        refreshVersions: async () => {
          events.push('versions')
        },
      },
    )

    expect(events.sort()).toEqual([
      'backlinks',
      'documents',
      'selected',
      'versions',
    ])
    expect(selectedDocument?.revision).toBe(8)
  })
})

describe('Document mutation and navigation guards', () => {
  test('reuses the first absolute public share expiry after response loss', () => {
    const first = resolvePendingPublicShareCreateRequest(
      undefined,
      'document-1',
      7,
      true,
      Date.parse('2026-07-18T00:00:00.000Z'),
    )
    const retry = resolvePendingPublicShareCreateRequest(
      first,
      'document-1',
      7,
      true,
      Date.parse('2026-07-18T12:00:00.000Z'),
    )
    const changedIntent = resolvePendingPublicShareCreateRequest(
      first,
      'document-1',
      30,
      true,
      Date.parse('2026-07-18T12:00:00.000Z'),
    )

    expect(retry).toBe(first)
    expect(retry.input.expiresAt).toBe('2026-07-25T00:00:00.000Z')
    expect(retry.fingerprint).toBe(first.fingerprint)
    expect(changedIntent).not.toBe(first)
    expect(changedIntent.input.expiresAt).toBe(
      '2026-08-17T12:00:00.000Z',
    )
  })

  test('flushes operations queued while a title commit is in flight', async () => {
    let titleCommitActive = true
    let pendingOperations = false
    let resolveTitleCommit:
      | ((saved: boolean) => void)
      | undefined
    const titleCommit = new Promise<boolean>((resolve) => {
      resolveTitleCommit = resolve
    })
    const events: string[] = []
    const savedPromise = saveAllPendingDocumentChanges({
      commitTitle: async () => true,
      flushOperations: async () => {
        events.push('flush-operations')
        pendingOperations = false
        return true
      },
      getActiveOperationFlush: () => undefined,
      getActiveTitleCommit: () =>
        titleCommitActive ? titleCommit : undefined,
      getSaveStatus: () => 'saving',
      hasDirtyTitle: () => false,
      hasPendingOperations: () => pendingOperations,
    })

    pendingOperations = true
    titleCommitActive = false
    resolveTitleCommit?.(true)

    expect(await savedPromise).toBe(true)
    expect(events).toEqual(['flush-operations'])
  })

  test('does not adopt a title response after newer input', () => {
    expect(isDocumentTitleCommitCurrent(3, 3)).toBe(true)
    expect(isDocumentTitleCommitCurrent(3, 4)).toBe(false)
  })

  test('uses the revision produced by draft flush for the next mutation', () => {
    expect(resolveDocumentMutationRevision(7, 9)).toBe(9)
    expect(resolveDocumentMutationRevision(10, 9)).toBe(10)
    expect(resolveDocumentMutationRevision(7)).toBe(7)
  })

  test('keeps a reverted title dirty while another title is committing', () => {
    expect(isDocumentTitleDirty('A', 'A', true)).toBe(true)
    expect(isDocumentTitleDirty('A', 'A', false)).toBe(false)
    expect(isDocumentTitleDirty('B', 'A', false)).toBe(true)
  })

  test('waits for pending save before running a destructive action', async () => {
    const events: string[] = []
    let finishSave: ((saved: boolean) => void) | undefined
    const completedPromise = runAfterSavingDocumentDraft(
      {
        hasUnsavedChanges: () => true,
        savePendingChanges: () =>
          new Promise<boolean>((resolve) => {
            events.push('save')
            finishSave = resolve
          }),
      },
      () => {
        events.push('archive')
      },
    )

    await Promise.resolve()
    expect(events).toEqual(['save'])
    finishSave?.(true)
    const completed = await completedPromise
    expect(completed).toBe(true)
    expect(events).toEqual(['save', 'archive'])
  })

  test('stops navigation when pending save fails', async () => {
    let navigated = false
    const completed = await runAfterSavingDocumentDraft(
      {
        hasUnsavedChanges: () => true,
        savePendingChanges: async () => false,
      },
      () => {
        navigated = true
      },
    )

    expect(completed).toBe(false)
    expect(navigated).toBe(false)
  })

  test('keeps FIFO order after a rejected document mutation', async () => {
    const enqueue = createDocumentMutationQueue()
    const events: string[] = []
    const first = enqueue(async () => {
      events.push('first')
      throw new Error('failed')
    }).catch(() => undefined)
    const second = enqueue(async () => {
      events.push('second')
      return 'saved'
    })

    await first
    expect(await second).toBe('saved')
    expect(events).toEqual(['first', 'second'])
  })
})

describe('Safe embed URLs', () => {
  test('allows same-origin and HTTPS while rejecting active schemes', () => {
    expect(
      resolveSafeEmbedUrl('/documents/example', 'https://app.example.test'),
    ).toBe('https://app.example.test/documents/example')
    expect(
      resolveSafeEmbedUrl(
        'https://docs.example.test/guide',
        'https://app.example.test',
      ),
    ).toBe('https://docs.example.test/guide')
    expect(
      resolveSafeEmbedUrl(
        'javascript:alert(1)',
        'https://app.example.test',
      ),
    ).toBeUndefined()
    expect(
      resolveSafeEmbedUrl(
        'http://docs.example.test',
        'https://app.example.test',
      ),
    ).toBeUndefined()
  })
})
