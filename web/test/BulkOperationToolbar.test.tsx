import { describe, expect, test } from 'bun:test'
import { AUTOMATION_SCHEMA_VERSION } from '@mukuroji/contracts'
import { renderToStaticMarkup } from 'react-dom/server'
import {
  BulkOperationToolbar,
  type BulkOperationSelection,
} from '../src/bulk-operations/BulkOperationToolbar'
import { BulkOperationResultPanel } from '../src/bulk-operations/BulkOperationResultPanel'
import {
  clearSucceededBulkSelection,
  createBulkEditPatch,
  getResumableBulkOperationItems,
  getRetryableBulkOperationItems,
  updateBulkItemSelection,
  updateVisibleBulkSelection,
} from '../src/bulk-operations/helpers'
import { createTranslator } from '../src/i18n'

const selections: BulkOperationSelection[] = [
  {
    expectedRevision: 1,
    label: 'Core item',
    selectionKey: 'refero:core-team:same-id',
    teamId: 'core-team',
    workItemId: 'same-id',
  },
  {
    expectedRevision: 4,
    label: 'Design item',
    selectionKey: 'refero:design-team:same-id',
    teamId: 'design-team',
    workItemId: 'same-id',
  },
  {
    expectedRevision: 2,
    label: 'Retry item',
    selectionKey: 'refero:core-team:retry-me',
    teamId: 'core-team',
    workItemId: 'retry-me',
  },
]

const partialOperation = {
  action: { archived: true, type: 'archive' as const },
  actorMemberKey: 'member-owner',
  createdAt: '2026-07-16T00:00:00.000Z',
  id: 'bulk-1',
  revision: 4,
  items: [
    {
      expectedRevision: 1,
      retryable: false,
      status: 'succeeded' as const,
      teamId: 'core-team',
      undoable: true,
      workItemId: 'same-id',
    },
    {
      errorCode: 'WorkItemRevisionConflict',
      errorMessage: 'Revision changed.',
      expectedRevision: 4,
      retryable: false,
      status: 'failed' as const,
      teamId: 'design-team',
      undoable: false,
      workItemId: 'same-id',
    },
    {
      errorCode: 'TransientFailure',
      errorMessage: 'Retry this item.',
      expectedRevision: 2,
      retryable: true,
      status: 'failed' as const,
      teamId: 'core-team',
      undoable: false,
      workItemId: 'retry-me',
    },
  ],
  schemaVersion: AUTOMATION_SCHEMA_VERSION,
  status: 'partial' as const,
  updatedAt: '2026-07-16T00:00:01.000Z',
  workspaceId: 'workspace-1',
}

const runningOperation = {
  ...partialOperation,
  items: [
    ...partialOperation.items,
    {
      expectedRevision: 3,
      retryable: false,
      status: 'ready' as const,
      teamId: 'core-team',
      undoable: false,
      workItemId: 'not-started',
    },
  ],
  status: 'running' as const,
}

describe('BulkOperationToolbar', () => {
  test('normalizes the date input value to the Work Item storage format', () => {
    expect(createBulkEditPatch('dueDate', ' 2026-07-31 ')).toEqual({
      dueDate: '2026/07/31',
    })
    expect(createBulkEditPatch('workflowStatusId', ' active ')).toEqual({
      workflowStatusId: 'active',
    })
  })

  test('selects only visible rows while preserving hidden selections', () => {
    expect(updateVisibleBulkSelection(
      ['hidden'],
      ['visible-1', 'visible-2'],
      true,
    )).toEqual(['hidden', 'visible-1', 'visible-2'])
    expect(updateVisibleBulkSelection(
      ['hidden', 'visible-1', 'visible-2'],
      ['visible-1', 'visible-2'],
      false,
    )).toEqual(['hidden'])
  })

  test('keeps the selection-time revision snapshot until an item is reselected', () => {
    const selectedSnapshot = selections[0]
    const refreshedItem = { ...selectedSnapshot, expectedRevision: 2 }

    expect(updateBulkItemSelection(
      [selectedSnapshot],
      [refreshedItem],
      [selectedSnapshot.selectionKey],
      true,
    )).toEqual([selectedSnapshot])
    expect(updateBulkItemSelection(
      [],
      [refreshedItem],
      [selectedSnapshot.selectionKey],
      true,
    )).toEqual([refreshedItem])
  })

  test('clears only succeeded item selections across duplicate IDs in different Teams', () => {
    expect(clearSucceededBulkSelection(
      selections.map((item) => item.selectionKey),
      selections,
      partialOperation,
    )).toEqual([
      'refero:design-team:same-id',
      'refero:core-team:retry-me',
    ])
  })

  test('offers retry only for retryable failed items and labels conflicts separately', () => {
    const t = createTranslator('en')
    const html = renderToStaticMarkup(
      <BulkOperationResultPanel
        operation={partialOperation}
        t={t}
        onClose={() => undefined}
        onRetry={() => undefined}
        onUndo={() => undefined}
      />,
    )

    expect(getRetryableBulkOperationItems(partialOperation).map((item) => item.workItemId))
      .toEqual(['retry-me'])
    expect(html).toContain('Retry 1 failed')
    expect(html).toContain('Conflict')
    expect(html).toContain('Retry this item.')
    expect(html).toContain('Undo succeeded items')
  })

  test('offers one apply-resume action for ready and retryable items while running', () => {
    const t = createTranslator('en')
    const html = renderToStaticMarkup(
      <BulkOperationResultPanel
        operation={runningOperation}
        t={t}
        onClose={() => undefined}
        onResume={() => undefined}
        onRetry={() => undefined}
        onUndo={() => undefined}
      />,
    )

    expect(getResumableBulkOperationItems(runningOperation).map((item) => item.workItemId))
      .toEqual(['retry-me', 'not-started'])
    expect(html).toContain('Resume 2 unfinished')
    expect(html).not.toContain('Retry 1 failed')
    expect(html).not.toContain('Undo succeeded items')
  })

  test('disables selection and actions in read-only mode', () => {
    const html = renderToStaticMarkup(
      <BulkOperationToolbar
        readOnly
        selectedItems={[]}
        t={createTranslator('en')}
        visibleItems={selections}
        workspaceId="workspace-1"
        onVisibleSelectionChange={() => undefined}
      />,
    )

    expect(html).toContain('Select all visible')
    expect(html).toContain('You do not have permission to run bulk operations')
    expect(html.match(/disabled=""/g)?.length).toBeGreaterThanOrEqual(4)
  })
})
