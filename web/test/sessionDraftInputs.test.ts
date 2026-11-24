import { describe, expect, test } from 'bun:test'
import {
  createDocumentSessionDraftKey,
  parseDocumentSessionDraft,
} from '../src/documents/model/documentSessionDraft'
import {
  createTimeEntryFormSessionDraft,
  createTimeEntryFormSessionDraftKey,
  parseTimeEntryFormSessionDraft,
} from '../src/features/time-tracking/model/timeEntryFormSessionDraft'
import {
  createIssueCommentSessionDraftKey,
  createTargetedCommentSessionDraftKey,
  parseTargetedCommentSessionDraft,
} from '../src/issues/model/commentSessionDraft'
import {
  createWorkItemCreateSessionDraft,
  createWorkItemCreateSessionDraftKey,
  parseWorkItemCreateSessionDraft,
} from '../src/work-items/model/workItemCreateSessionDraft'

describe('reply and edit comment drafts', () => {
  const commentKey = createIssueCommentSessionDraftKey('core-team', 'launch-review')

  /** Verifies reply and edit inputs use their own keys beside the new-comment input. */
  test('keys a reply and an edit apart from the new comment', () => {
    const reply = createTargetedCommentSessionDraftKey(commentKey, 'reply')
    const edit = createTargetedCommentSessionDraftKey(commentKey, 'edit')
    expect(new Set([commentKey, reply, edit]).size).toBe(3)
  })

  /** Verifies a reply comes back with its target comment. */
  test('restores a reply with the comment it answers', () => {
    expect(parseTargetedCommentSessionDraft({
      bodyMarkdown: 'Agreed',
      commentId: 'comment-1',
      mentionMemberKeys: ['member-b', 3],
    })).toEqual({ bodyMarkdown: 'Agreed', commentId: 'comment-1', mentionMemberKeys: ['member-b'] })
  })

  /** Verifies an edit keeps the version it started from, so a newer comment still conflicts. */
  test('restores an edit only with the baseline it started from', () => {
    const edit = {
      bodyMarkdown: 'Updated text',
      commentId: 'comment-1',
      mentionMemberKeys: [],
      originalBodyMarkdown: 'Original text',
      originalMentionMemberKeys: [],
      originalVersion: 4,
    }
    expect(parseTargetedCommentSessionDraft(edit)).toEqual(edit)
    expect(parseTargetedCommentSessionDraft({ ...edit, originalBodyMarkdown: undefined })).toBeUndefined()
    expect(parseTargetedCommentSessionDraft({ ...edit, originalVersion: 'four' })).toBeUndefined()
    expect(parseTargetedCommentSessionDraft({ ...edit, commentId: '' })).toBeUndefined()
  })
})

describe('Document drafts', () => {
  const blockUpdate = {
    block: { id: 'block-1', text: 'Draft paragraph', type: 'paragraph' },
    blockId: 'block-1',
    operationId: 'operation-1',
    type: 'update-block',
  }

  /** Verifies unsaved operations and title come back with the revision they were made on. */
  test('restores unsaved operations and title with their base revision', () => {
    expect(createDocumentSessionDraftKey('doc-1')).not.toBe(createDocumentSessionDraftKey('doc-2'))
    expect(parseDocumentSessionDraft({
      baseRevision: 7,
      conflicted: true,
      operations: [blockUpdate, { blockId: 'block-2', index: 0, operationId: 'operation-2', type: 'move-block' }],
      title: 'Release plan',
    })).toEqual({
      baseRevision: 7,
      conflicted: true,
      operations: [blockUpdate, { blockId: 'block-2', index: 0, operationId: 'operation-2', type: 'move-block' }],
      title: 'Release plan',
    })
    expect(parseDocumentSessionDraft({ baseRevision: 7, operations: [], title: 'Only the title' })).toEqual({
      baseRevision: 7,
      conflicted: false,
      operations: [],
      title: 'Only the title',
    })
  })

  /** Verifies a kept value with an unknown or incomplete operation is not restored at all. */
  test('drops drafts with operations the Document API would not accept', () => {
    expect(parseDocumentSessionDraft({ baseRevision: 7, operations: [{ ...blockUpdate, type: 'rename-block' }] }))
      .toBeUndefined()
    expect(parseDocumentSessionDraft({ baseRevision: 7, operations: [{ ...blockUpdate, block: 'text' }] }))
      .toBeUndefined()
    expect(parseDocumentSessionDraft({ baseRevision: 7, operations: [{ ...blockUpdate, operationId: '' }] }))
      .toBeUndefined()
    expect(parseDocumentSessionDraft({ baseRevision: -1, operations: [blockUpdate] })).toBeUndefined()
    expect(parseDocumentSessionDraft({ baseRevision: 7, operations: [] })).toBeUndefined()
  })
})

describe('time entry form drafts', () => {
  /** Verifies Work Item time and indirect work forms keep their input apart per place. */
  test('keys each form by kind and place', () => {
    const keys = [
      createTimeEntryFormSessionDraftKey('work-item', ['timesheet']),
      createTimeEntryFormSessionDraftKey('indirect', ['timesheet']),
      createTimeEntryFormSessionDraftKey('work-item', ['work-item', 'core-team', 'launch-review']),
    ]
    expect(new Set(keys).size).toBe(3)
  })

  /** Verifies only the forms' named text fields are kept. */
  test('keeps the named text fields and the billable box', () => {
    const draft = createTimeEntryFormSessionDraft([
      ['date', '2026-11-24'],
      ['start', '09:30'],
      ['description', 'Design review'],
      ['billable', 'on'],
      ['unknown', 'ignored'],
    ], true)
    expect(draft).toEqual({
      billable: true,
      fields: { date: '2026-11-24', description: 'Design review', start: '09:30' },
    })
    expect(parseTimeEntryFormSessionDraft(draft)).toEqual(draft)
    expect(parseTimeEntryFormSessionDraft({ fields: { hours: 2 }, billable: false })).toEqual({
      billable: false,
      fields: {},
    })
    expect(parseTimeEntryFormSessionDraft({ fields: {}, billable: 'yes' })).toBeUndefined()
  })
})

describe('new Work Item form drafts', () => {
  /** Verifies Team and Project forms keep their text apart. */
  test('keys a Team form apart from a Project form', () => {
    expect(createWorkItemCreateSessionDraftKey(['team', 'core']))
      .not.toBe(createWorkItemCreateSessionDraftKey(['project', 'core']))
  })

  /** Verifies blank forms keep nothing and typed text comes back. */
  test('keeps typed title and description only', () => {
    expect(createWorkItemCreateSessionDraft('  ', '')).toBeUndefined()
    expect(createWorkItemCreateSessionDraft('Fix login', '')).toEqual({ description: '', title: 'Fix login' })
    expect(parseWorkItemCreateSessionDraft({ description: 'Steps', title: '' })).toEqual({
      description: 'Steps',
      title: '',
    })
    expect(parseWorkItemCreateSessionDraft({ description: 1, title: 'x' })).toBeUndefined()
    expect(parseWorkItemCreateSessionDraft({ description: '', title: '' })).toBeUndefined()
  })
})
