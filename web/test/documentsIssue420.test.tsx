import { describe, expect, test } from 'bun:test'
import { renderToStaticMarkup } from 'react-dom/server'
import type {
  DocumentChecklistBlock,
  WhiteboardNoteObject,
} from '@mukuroji/contracts'
import { documentRecordFixture } from '../src/documents/fixtures'
import {
  buildBuiltInDocumentTemplate,
  formatLocalCalendarDate,
  parseTemplateParticipants,
} from '../src/documents/model/builtInTemplates'
import {
  isChecklistItemOverdue,
  resolveChecklistAssigneeLabel,
  updateChecklistItemOwnership,
} from '../src/documents/model/checklistItems'
import {
  createChecklistItemWorkItemRelation,
  createDocumentWorkItemRelation,
  createDocumentWorkItemSourceKey,
  findChecklistItemWorkItemId,
  findDocumentWorkItemId,
  findWhiteboardNoteWorkItemId,
} from '../src/documents/model/checklistWorkItems'
import { DocumentEditor } from '../src/documents/ui/DocumentEditor'
import { DocumentHome } from '../src/documents/ui/DocumentHome'
import { NoteWorkItemAction } from '../src/documents/ui/WhiteboardCanvas'
import { projectDirectoryFixtures } from '../src/projects/fixtures'
import { createTranslator } from '../src/shared/i18n/i18n'

/**
 * Returns sequential IDs so built template blocks are deterministic.
 *
 * @returns ID factory.
 */
function createSequentialId() {
  let next = 0
  return (prefix: string) => `${prefix}-${++next}`
}

describe('bundled Document templates', () => {
  test('substitutes the date, Project, and participants into Japanese meeting notes', () => {
    const content = buildBuiltInDocumentTemplate(
      'meeting-notes',
      'ja',
      { date: '2026-11-19', participants: ['山田', ' 佐藤 '], projectName: '基盤刷新' },
      createSequentialId(),
    )

    expect(content.title).toBe('議事録 2026-11-19 基盤刷新')
    const texts = content.blocks.map((block) =>
      block.type === 'checklist' ? '[checklist]' : 'text' in block ? block.text : '')
    expect(texts).toContain('日時: 2026-11-19')
    expect(texts).toContain('Project: 基盤刷新')
    expect(texts).toContain('参加者: 山田、佐藤')
    expect(texts).toContain('宿題')
    expect(content.blocks.at(-1)?.type).toBe('checklist')
    const ids = content.blocks.map((block) => block.id)
    expect(new Set(ids).size).toBe(ids.length)
  })

  test('leaves the Project out of the title and shows placeholders when values are missing', () => {
    const content = buildBuiltInDocumentTemplate(
      'retrospective',
      'ja',
      { date: '2026-11-19', participants: [] },
      createSequentialId(),
    )

    expect(content.title).toBe('振り返り（KPT） 2026-11-19')
    const paragraphs = content.blocks.flatMap((block) =>
      block.type === 'paragraph' ? [block.text] : [])
    expect(paragraphs).toContain('日時: 2026-11-19 / Project: （Project なし）')
    expect(paragraphs).toContain('参加者: （参加者を記入）')
  })

  test('builds every bundled template in English', () => {
    for (const key of ['meeting-notes', 'design-doc', 'retrospective'] as const) {
      const content = buildBuiltInDocumentTemplate(
        key,
        'en',
        { date: '2026-01-02', participants: ['Alex'], projectName: 'Atlas' },
        createSequentialId(),
      )
      expect(content.title).toContain('Atlas')
      expect(content.blocks.length).toBeGreaterThan(3)
    }
  })

  test('formats local dates and splits participant text', () => {
    expect(formatLocalCalendarDate(new Date(2026, 0, 5))).toBe('2026-01-05')
    expect(parseTemplateParticipants('山田、佐藤, Alex\n ')).toEqual(['山田', '佐藤', 'Alex'])
  })

  test('lists the bundled templates on the Documents home', () => {
    const html = renderToStaticMarkup(
      <DocumentHome
        documents={[]}
        t={createTranslator('ja')}
        teams={projectDirectoryFixtures}
        onCreateFromBuiltInTemplate={() => undefined}
        onSelectDocument={() => undefined}
      />,
    )

    expect(html).toContain('同梱テンプレート')
    expect(html).toContain('議事録')
    expect(html).toContain('設計書')
    expect(html).toContain('振り返り（KPT）')
  })
})

describe('checklist items as Work Items', () => {
  const block: DocumentChecklistBlock = {
    id: 'block-actions',
    items: [
      { checked: false, id: 'item-linked', text: 'Send the estimate' },
      { checked: false, id: 'item-open', text: 'Book the review' },
      { checked: false, id: 'item-empty', text: '' },
    ],
    type: 'checklist',
  }
  const relation = createChecklistItemWorkItemRelation(
    block.id,
    'item-linked',
    'team/core/issue/ISSUE-1',
    new Date('2026-11-19T00:00:00Z'),
  )

  test('finds the Work Item linked to one checklist item only', () => {
    expect(relation.source).toEqual({ blockId: 'block-actions', kind: 'block' })
    expect(findChecklistItemWorkItemId([relation], block.id, 'item-linked'))
      .toBe('team/core/issue/ISSUE-1')
    expect(findChecklistItemWorkItemId([relation], block.id, 'item-open'))
      .toBeUndefined()
    expect(findChecklistItemWorkItemId([relation], 'other-block', 'item-linked'))
      .toBeUndefined()
  })

  test('offers to create a Work Item for unlinked items and opens linked ones', () => {
    if (documentRecordFixture.kind !== 'page') {
      throw new Error('Expected a page fixture.')
    }
    const html = renderToStaticMarkup(
      <DocumentEditor
        checklistWorkItems={{
          onCreate: () => undefined,
          onOpen: () => undefined,
          relations: [relation],
        }}
        document={{ ...documentRecordFixture, blocks: [block], relations: [relation] }}
        editable
        saveStatus="idle"
        t={createTranslator('en')}
        onDeleteBlock={() => undefined}
        onMoveBlock={() => undefined}
        onUpsertBlock={() => undefined}
      />,
    )

    expect(html.match(/Make Work Item/g)?.length).toBe(1)
    expect(html.match(/Open Work Item/g)?.length).toBe(1)
  })

  test('shows linked Work Items to read-only viewers without offering creation', () => {
    if (documentRecordFixture.kind !== 'page') {
      throw new Error('Expected a page fixture.')
    }
    const html = renderToStaticMarkup(
      <DocumentEditor
        checklistWorkItems={{
          onCreate: () => undefined,
          onOpen: () => undefined,
          relations: [relation],
        }}
        document={{ ...documentRecordFixture, blocks: [block], relations: [relation] }}
        editable={false}
        saveStatus="idle"
        t={createTranslator('en')}
        onDeleteBlock={() => undefined}
        onMoveBlock={() => undefined}
        onUpsertBlock={() => undefined}
      />,
    )

    expect(html).toContain('Open Work Item')
    expect(html).not.toContain('Make Work Item')
  })
})

describe('Whiteboard notes as Work Items', () => {
  const note: WhiteboardNoteObject = {
    bounds: { height: 120, width: 160, x: 0, y: 0 },
    id: 'note-decision',
    text: 'Draft the rollout plan',
    type: 'note',
    zIndex: 1,
  }
  const relation = createDocumentWorkItemRelation(
    { documentId: 'doc-board', kind: 'whiteboard-note', objectId: note.id },
    'team/core/issue/ISSUE-2',
    new Date('2026-11-20T00:00:00Z'),
  )

  test('links the Work Item to the note object, not a checklist block', () => {
    expect(relation.id).toBe('whiteboard-note:note-decision')
    expect(relation.id.startsWith('system:')).toBe(false)
    expect(relation.source).toEqual({ kind: 'whiteboard-object', objectId: note.id })
    expect(findWhiteboardNoteWorkItemId([relation], note.id))
      .toBe('team/core/issue/ISSUE-2')
    expect(findWhiteboardNoteWorkItemId([relation], 'note-other')).toBeUndefined()
    expect(findDocumentWorkItemId([relation], {
      documentId: 'doc-board',
      kind: 'whiteboard-note',
      objectId: note.id,
    })).toBe('team/core/issue/ISSUE-2')
  })

  test('keeps note and checklist retries in separate idempotency contexts', () => {
    const checklistKey = createDocumentWorkItemSourceKey({
      blockId: 'note-decision',
      documentId: 'doc-board',
      itemId: 'item',
      kind: 'checklist-item',
    })
    const noteKey = createDocumentWorkItemSourceKey({
      documentId: 'doc-board',
      kind: 'whiteboard-note',
      objectId: 'note-decision',
    })

    expect(checklistKey).toBe(JSON.stringify(['doc-board', 'note-decision', 'item']))
    expect(noteKey).not.toBe(checklistKey)
  })

  test('offers creation for an unlinked note and opens a linked one', () => {
    const t = createTranslator('ja')
    const controls = {
      onCreate: () => undefined,
      onOpen: () => undefined,
      relations: [relation],
    }
    const unlinked = renderToStaticMarkup(
      <NoteWorkItemAction
        controls={controls}
        note={{ ...note, id: 'note-new' }}
        t={t}
      />,
    )
    const linked = renderToStaticMarkup(
      <NoteWorkItemAction controls={controls} note={note} t={t} />,
    )
    const empty = renderToStaticMarkup(
      <NoteWorkItemAction
        controls={controls}
        note={{ ...note, id: 'note-empty', text: '  ' }}
        t={t}
      />,
    )

    expect(unlinked).toContain('Work Item にする')
    expect(linked).toContain('Work Item を開く')
    expect(linked).not.toContain('Work Item にする')
    expect(empty).toBe('')
  })

  test('hides creation when the viewer cannot edit', () => {
    const html = renderToStaticMarkup(
      <NoteWorkItemAction
        controls={{ relations: [] }}
        note={note}
        t={createTranslator('en')}
      />,
    )

    expect(html).toBe('')
  })
})

describe('checklist item owners and deadlines', () => {
  const block: DocumentChecklistBlock = {
    id: 'block-actions',
    items: [
      {
        assigneeMemberKey: 'sato@example.com',
        checked: false,
        dueDate: '2026-11-20',
        id: 'item-owned',
        text: 'Send the estimate',
      },
      { checked: false, id: 'item-open', text: 'Book the review' },
    ],
    type: 'checklist',
  }
  const assignees = [{ id: 'sato@example.com', label: 'Ichiro Sato' }]

  test('sets and clears the owner and deadline without empty values', () => {
    const assigned = updateChecklistItemOwnership(block, 'item-open', {
      assigneeMemberKey: 'yamada@example.com',
      dueDate: '2026-12-01',
    })
    expect(assigned.items[1]).toEqual({
      assigneeMemberKey: 'yamada@example.com',
      checked: false,
      dueDate: '2026-12-01',
      id: 'item-open',
      text: 'Book the review',
    })
    expect(assigned.items[0]).toBe(block.items[0])

    const cleared = updateChecklistItemOwnership(block, 'item-owned', { dueDate: '' })
    expect(cleared.items[0]).toEqual({
      assigneeMemberKey: 'sato@example.com',
      checked: false,
      id: 'item-owned',
      text: 'Send the estimate',
    })
    expect(updateChecklistItemOwnership(block, 'item-owned', { assigneeMemberKey: '' }).items[0])
      .not.toHaveProperty('assigneeMemberKey')
  })

  test('marks only open items whose deadline has passed as overdue', () => {
    expect(isChecklistItemOverdue({ checked: false, dueDate: '2026-11-20' }, '2026-11-21')).toBe(true)
    expect(isChecklistItemOverdue({ checked: false, dueDate: '2026-11-21' }, '2026-11-21')).toBe(false)
    expect(isChecklistItemOverdue({ checked: true, dueDate: '2026-11-20' }, '2026-11-21')).toBe(false)
    expect(isChecklistItemOverdue({ checked: false }, '2026-11-21')).toBe(false)
  })

  test('shows an owner who is no longer offered by the saved member key', () => {
    expect(resolveChecklistAssigneeLabel(assignees, 'sato@example.com')).toBe('Ichiro Sato')
    expect(resolveChecklistAssigneeLabel(assignees, 'left@example.com')).toBe('left@example.com')
    expect(resolveChecklistAssigneeLabel(assignees, undefined)).toBeUndefined()
  })

  test('offers owner and deadline fields to editors', () => {
    if (documentRecordFixture.kind !== 'page') {
      throw new Error('Expected a page fixture.')
    }
    const html = renderToStaticMarkup(
      <DocumentEditor
        checklistWorkItems={{ assignees, relations: [] }}
        document={{ ...documentRecordFixture, blocks: [block], relations: [] }}
        editable
        saveStatus="idle"
        t={createTranslator('en')}
        onDeleteBlock={() => undefined}
        onMoveBlock={() => undefined}
        onUpsertBlock={() => undefined}
      />,
    )

    expect(html).toContain('aria-label="Owner of checklist item 1"')
    expect(html).toContain('aria-label="Due date of checklist item 2"')
    expect(html).toContain('value="2026-11-20"')
  })

  test('reports a failed owner read with a reload action', () => {
    if (documentRecordFixture.kind !== 'page') {
      throw new Error('Expected a page fixture.')
    }
    const html = renderToStaticMarkup(
      <DocumentEditor
        checklistWorkItems={{ assignees, onRetryAssignees: () => undefined, relations: [] }}
        document={{ ...documentRecordFixture, blocks: [block], relations: [] }}
        editable
        saveStatus="idle"
        t={createTranslator('en')}
        onDeleteBlock={() => undefined}
        onMoveBlock={() => undefined}
        onUpsertBlock={() => undefined}
      />,
    )

    expect(html).toContain('role="alert"')
    expect(html).toContain('Reload')
  })

  test('shows the owner and deadline to read-only viewers', () => {
    if (documentRecordFixture.kind !== 'page') {
      throw new Error('Expected a page fixture.')
    }
    const html = renderToStaticMarkup(
      <DocumentEditor
        checklistWorkItems={{ assignees, relations: [] }}
        document={{ ...documentRecordFixture, blocks: [block], relations: [] }}
        editable={false}
        saveStatus="idle"
        t={createTranslator('en')}
        onDeleteBlock={() => undefined}
        onMoveBlock={() => undefined}
        onUpsertBlock={() => undefined}
      />,
    )

    expect(html).toContain('Owner: Ichiro Sato')
    expect(html).toContain('Due 2026-11-20')
    expect(html).not.toContain('Owner of checklist item')
  })
})
