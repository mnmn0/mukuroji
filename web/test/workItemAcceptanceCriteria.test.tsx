import { describe, expect, test } from 'bun:test'
import { renderToStaticMarkup } from 'react-dom/server'
import type { WorkItemAcceptanceCriterion } from '@mukuroji/contracts'
import {
  ACCEPTANCE_CRITERIA_DRAFT_FORM_FIELD,
  countSatisfiedAcceptanceCriteria,
  createEmptyAcceptanceCriterionDraftRow,
  parseAcceptanceCriterionDraftRows,
  readAcceptanceCriteriaDraftSubmission,
  serializeAcceptanceCriterionDraftRows,
  toAcceptanceCriterionDraftRows,
} from '../src/work-items/model/acceptanceCriteria'
import { WorkItemAcceptanceCriteriaEditor } from '../src/work-items/ui/WorkItemAcceptanceCriteriaEditor'

const criteria: WorkItemAcceptanceCriterion[] = [
  { id: 'a'.repeat(32), text: 'Tests pass', satisfied: true },
  { id: 'b'.repeat(32), text: 'Docs updated', satisfied: false },
]

/**
 * Builds form data with a serialized draft, as the editor's hidden field submits it.
 *
 * @param value - Field value.
 * @returns Form data carrying the draft field.
 */
function draftFormData(value: string): FormData {
  const formData = new FormData()
  formData.set(ACCEPTANCE_CRITERIA_DRAFT_FORM_FIELD, value)
  return formData
}

describe('acceptance criteria draft model', () => {
  test('round-trips stored criteria through editable rows, keeping IDs and trimming text', () => {
    const rows = toAcceptanceCriterionDraftRows(criteria)
    expect(parseAcceptanceCriterionDraftRows(rows)).toEqual({
      criteria: [
        { id: 'a'.repeat(32), text: 'Tests pass', satisfied: true },
        { id: 'b'.repeat(32), text: 'Docs updated', satisfied: false },
      ],
    })
    const added = [...rows, { ...createEmptyAcceptanceCriterionDraftRow('new-1'), text: '  Deployed  ' }]
    expect(parseAcceptanceCriterionDraftRows(added)).toMatchObject({
      criteria: [{}, {}, { text: 'Deployed', satisfied: false }],
    })
    // A new criterion has no ID; the server assigns one.
    const parsed = parseAcceptanceCriterionDraftRows(added)
    expect('criteria' in parsed && 'id' in (parsed.criteria[2] ?? {})).toBe(false)
  })

  test('reports blank, too long, and too many criteria', () => {
    expect(parseAcceptanceCriterionDraftRows([createEmptyAcceptanceCriterionDraftRow('new-1')]))
      .toEqual({ error: 'missing-text', rowKey: 'new-1' })
    expect(parseAcceptanceCriterionDraftRows([{ key: 'long', text: 'x'.repeat(1025), satisfied: false }]))
      .toEqual({ error: 'text-too-long', rowKey: 'long' })
    const many = Array.from({ length: 21 }, (_, index) => ({ key: `r${index}`, text: `C${index}`, satisfied: false }))
    expect(parseAcceptanceCriterionDraftRows(many)).toEqual({ error: 'too-many' })
    // An empty list removes every criterion.
    expect(parseAcceptanceCriterionDraftRows([])).toEqual({ criteria: [] })
  })

  test('reads the hidden form field and rejects a malformed draft', () => {
    expect(readAcceptanceCriteriaDraftSubmission(new FormData())).toBeUndefined()
    expect(readAcceptanceCriteriaDraftSubmission(draftFormData(serializeAcceptanceCriterionDraftRows(
      toAcceptanceCriterionDraftRows(criteria),
    )))).toEqual({ criteria: criteria.map(({ id, text, satisfied }) => ({ id, text, satisfied })) })
    expect(readAcceptanceCriteriaDraftSubmission(draftFormData('{'))).toEqual({ error: 'invalid-draft' })
    expect(readAcceptanceCriteriaDraftSubmission(draftFormData('[{"key":"a","text":"x","satisfied":"yes"}]')))
      .toEqual({ error: 'invalid-draft' })
  })

  test('counts met criteria', () => {
    expect(countSatisfiedAcceptanceCriteria(criteria)).toEqual({ satisfied: 1, total: 2 })
    expect(countSatisfiedAcceptanceCriteria(undefined)).toEqual({ satisfied: 0, total: 0 })
  })
})

describe('acceptance criteria editor', () => {
  test('shows progress and each criterion with its state, and an edit button only when editable', () => {
    const editable = renderToStaticMarkup(
      <WorkItemAcceptanceCriteriaEditor
        criteria={criteria}
        draftState={{ draft: { nextRowNumber: 1 }, setDraft: () => undefined }}
        formId="editor"
        locale="en"
      />,
    )
    expect(editable).toContain('1 of 2 met')
    expect(editable).toContain('Met: </span>Tests pass')
    expect(editable).toContain('Not met: </span>Docs updated')
    expect(editable).toContain('Edit acceptance criteria')
    const readOnly = renderToStaticMarkup(
      <WorkItemAcceptanceCriteriaEditor
        criteria={criteria}
        draftState={{ draft: { nextRowNumber: 1 }, setDraft: () => undefined }}
        formId="editor"
        locale="en"
        readOnly
      />,
    )
    expect(readOnly).not.toContain('Edit acceptance criteria')
  })

  test('submits an open draft through the owning form', () => {
    const markup = renderToStaticMarkup(
      <WorkItemAcceptanceCriteriaEditor
        criteria={criteria}
        draftState={{ draft: { nextRowNumber: 1, rows: toAcceptanceCriterionDraftRows(criteria) }, setDraft: () => undefined }}
        formId="editor"
        locale="en"
      />,
    )
    expect(markup).toContain(`form="editor" type="hidden" name="${ACCEPTANCE_CRITERIA_DRAFT_FORM_FIELD}"`)
    expect(markup).toContain('Save changes to save the acceptance criteria as well.')
  })
})
