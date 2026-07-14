import type { WorkItemRelation } from '@mukuroji/contracts'
import type { Meta, StoryObj } from '@storybook/react-vite'
import { useState } from 'react'
import type { Locale } from '../i18n'
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
} from './fixtures'

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
    setRelations((current) => [
      ...current,
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
 * 英語 locale かつ参照専用の表示状態です。
 */
export const EnglishReadOnly: Story = {
  args: {
    locale: 'en',
    readOnly: true,
  },
}
