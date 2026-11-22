import { expect, test } from 'bun:test'
import type { DocumentDetail, DocumentRelation } from '@mukuroji/contracts'
import {
  isWorkItemCompletionRelationId,
  planWorkItemCompletionOperations,
} from './work-item-completion'

const workItemId = 'team/team-a/issue/work-item-1'

/**
 * Builds a relation to the completed Work Item for the planning tests.
 *
 * @param id - Relation ID.
 * @param source - Relation source.
 * @param target - Linked Work Item.
 * @returns Document relation.
 */
function relation(
  id: string,
  source: DocumentRelation['source'],
  target = workItemId,
): DocumentRelation {
  return {
    createdAt: '2026-11-22T00:00:00.000Z',
    createdByUserId: 'owner@example.com',
    id,
    source,
    target: { kind: 'work-item', workItemId: target },
  }
}

/** Common Document fields the planner does not read. */
const base: Omit<Extract<DocumentDetail, { kind: 'page' }>, 'kind' | 'blocks' | 'relations'> = {
  schemaVersion: 1,
  id: 'document-1',
  scope: { type: 'workspace' },
  title: 'Minutes',
  revision: 3,
  position: 'a0',
  favorite: false,
  capabilities: {
    canView: true,
    canEdit: true,
    canComment: true,
    canShare: false,
    canManagePermissions: false,
    canArchive: false,
    canRestore: false,
    canExport: true,
  },
  permission: { mode: 'inherit', memberGrants: [] },
  createdByUserId: 'owner@example.com',
  updatedByUserId: 'owner@example.com',
  createdAt: '2026-11-22T00:00:00.000Z',
  updatedAt: '2026-11-22T00:00:00.000Z',
}

test('checks only the checklist items turned into the completed Work Item', () => {
  const page: DocumentDetail = {
    ...base,
    kind: 'page',
    blocks: [{
      id: 'actions',
      type: 'checklist',
      items: [
        { id: 'linked', text: 'Send the estimate', checked: false },
        { id: 'other', text: 'Book the room', checked: false },
        { id: 'other-work-item', text: 'Write notes', checked: false },
      ],
    }],
    relations: [
      relation('checklist-item:actions:linked', { kind: 'block', blockId: 'actions' }),
      relation('plain-link', { kind: 'block', blockId: 'actions' }),
      relation(
        'checklist-item:actions:other-work-item',
        { kind: 'block', blockId: 'actions' },
        'team/team-a/issue/work-item-2',
      ),
    ],
  }

  expect(planWorkItemCompletionOperations(page, workItemId, 'completion:event-1')).toEqual([{
    type: 'update-block',
    operationId: 'completion:event-1:block:actions',
    blockId: 'actions',
    block: {
      id: 'actions',
      type: 'checklist',
      items: [
        { id: 'linked', text: 'Send the estimate', checked: true },
        { id: 'other', text: 'Book the room', checked: false },
        { id: 'other-work-item', text: 'Write notes', checked: false },
      ],
    },
  }])
})

test('changes nothing when the linked item is already checked or was deleted', () => {
  const page: DocumentDetail = {
    ...base,
    kind: 'page',
    blocks: [{
      id: 'actions',
      type: 'checklist',
      items: [{ id: 'linked', text: 'Send the estimate', checked: true }],
    }],
    relations: [
      relation('checklist-item:actions:linked', { kind: 'block', blockId: 'actions' }),
      relation('checklist-item:actions:deleted', { kind: 'block', blockId: 'actions' }),
    ],
  }

  expect(planWorkItemCompletionOperations(page, workItemId, 'completion:event-1')).toEqual([])
})

test('marks the linked Whiteboard note done and ignores Work Item cards', () => {
  const whiteboard: DocumentDetail = {
    ...base,
    kind: 'whiteboard',
    whiteboard: {
      objects: [
        { id: 'note-1', type: 'note', text: 'Fix it', bounds: { x: 0, y: 0, width: 100, height: 80 }, zIndex: 1 },
        { id: 'card-1', type: 'work-item', workItemId, bounds: { x: 0, y: 0, width: 100, height: 80 }, zIndex: 2 },
      ],
      connectors: [],
      frames: [],
    },
    relations: [
      relation('whiteboard-note:note-1', { kind: 'whiteboard-object', objectId: 'note-1' }),
      relation('whiteboard-note:card-1', { kind: 'whiteboard-object', objectId: 'card-1' }),
    ],
  }

  expect(planWorkItemCompletionOperations(whiteboard, workItemId, 'completion:event-1')).toEqual([{
    type: 'update-object',
    operationId: 'completion:event-1:object:note-1',
    objectId: 'note-1',
    object: {
      id: 'note-1',
      type: 'note',
      text: 'Fix it',
      bounds: { x: 0, y: 0, width: 100, height: 80 },
      zIndex: 1,
      done: true,
    },
  }])
})

test('recognizes only checklist item and note relation IDs', () => {
  expect(isWorkItemCompletionRelationId('checklist-item:block:item')).toBe(true)
  expect(isWorkItemCompletionRelationId('whiteboard-note:note-1')).toBe(true)
  expect(isWorkItemCompletionRelationId('system:whiteboard-work-item:card-1')).toBe(false)
  expect(isWorkItemCompletionRelationId('plain-link')).toBe(false)
})
