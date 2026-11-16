import type { WorkItemRelation } from '@mukuroji/contracts'
import type { Meta, StoryObj } from '@storybook/react-vite'
import { useState } from 'react'
import { expect, userEvent, within } from 'storybook/test'
import type { Locale } from '../../shared/i18n/i18n'
import { WorkItemFieldsEditor } from './WorkItemFieldsEditor'
import {
  WorkItemRelationsEditor,
  type WorkItemRelationEditorInput,
} from './WorkItemRelationsEditor'
import {
  workItemCustomFieldValueFixture,
  workItemPersonOptionFixtures,
  workItemRelationCandidateFixtures,
  workItemRelationFixtures,
  workspaceWorkItemConfigurationFixture,
} from '../fixtures'

function WorkItemEditorsPreview({
  locale = 'ja',
  readOnly = false,
}: {
  /** Preview locale です。 */
  locale?: Locale
  /** Editor を参照専用にするかどうかです。 */
  readOnly?: boolean
}) {
  const [relations, setRelations] = useState<WorkItemRelation[]>([...workItemRelationFixtures])
  const handleAddRelation = async (input: WorkItemRelationEditorInput) => {
    // A Work Item has one parent, so adding a parent replaces the current one like the API does.
    setRelations((current) => [
      ...current.filter((relation) => input.type !== 'parent' || relation.type !== 'parent'),
      {
        sourceWorkItemId: 'WI-104',
        targetWorkItemId: input.targetWorkItemId,
        type: input.type,
      },
    ])
  }
  const handleDeleteRelation = async (relation: WorkItemRelation) => {
    setRelations((current) => current.filter((candidate) => candidate !== relation))
  }

  return (
    <main className="min-h-screen bg-[var(--workbench-page)] p-6 max-[720px]:p-3">
      <div className="mx-auto grid max-w-6xl gap-5 lg:grid-cols-[minmax(0,1.15fr)_minmax(360px,0.85fr)]">
        <section className="workbench-panel p-5">
          <WorkItemFieldsEditor
            definitions={workspaceWorkItemConfigurationFixture.customFields}
            locale={locale}
            personOptions={workItemPersonOptionFixtures}
            projectId="refero"
            readOnly={readOnly}
            values={workItemCustomFieldValueFixture}
          />
        </section>
        <WorkItemRelationsEditor
          candidates={workItemRelationCandidateFixtures}
          currentWorkItemId="WI-104"
          locale={locale}
          onAddRelation={handleAddRelation}
          onDeleteRelation={handleDeleteRelation}
          readOnly={readOnly}
          relations={relations}
        />
      </div>
    </main>
  )
}

/**
 * Work Item field と relation editor の Storybook metadata です。
 */
const meta = {
  title: 'Application/Work Items/Detail Editors',
  component: WorkItemEditorsPreview,
  parameters: {
    layout: 'fullscreen',
  },
} satisfies Meta<typeof WorkItemEditorsPreview>

export default meta

/**
 * Work Item detail editor stories の型です。
 */
type Story = StoryObj<typeof meta>

/**
 * 全 custom field type と relation mutation を確認する標準状態です。
 */
export const Default: Story = {}

/**
 * 親がある Work Item で親を選ぶと、追加ではなく付け替えになることを確認します。
 */
export const ParentReplacement: Story = {
  play: async ({ canvasElement }) => {
    const canvas = within(canvasElement)
    const editor = within(canvas.getByTestId('work-item-relations-editor'))

    await userEvent.selectOptions(editor.getByLabelText('関係'), 'parent')
    await userEvent.click(editor.getByRole('button', { name: '親を付け替え' }))

    await expect(editor.queryByTestId('work-item-relation-parent-WI-100')).toBeNull()
    await expect(editor.getByTestId('work-item-relation-parent-WI-121')).toBeVisible()
  },
}

/**
 * 英語 locale かつ参照専用の表示状態です。
 */
export const EnglishReadOnly: Story = {
  args: {
    locale: 'en',
    readOnly: true,
  },
}
