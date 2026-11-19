import { describe, expect, test } from 'bun:test'
import { renderToStaticMarkup } from 'react-dom/server'
import type { DocumentChecklistBlock } from '@mukuroji/contracts'
import { documentRecordFixture } from '../src/documents/fixtures'
import {
  buildBuiltInDocumentTemplate,
  formatLocalCalendarDate,
  parseTemplateParticipants,
} from '../src/documents/model/builtInTemplates'
import {
  createChecklistItemWorkItemRelation,
  findChecklistItemWorkItemId,
} from '../src/documents/model/checklistWorkItems'
import { DocumentEditor } from '../src/documents/ui/DocumentEditor'
import { DocumentHome } from '../src/documents/ui/DocumentHome'
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
