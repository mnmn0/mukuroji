import type { Meta, StoryObj } from '@storybook/react-vite'
import { WorkItemConfigurationPanel } from './WorkItemConfigurationPanel'
import {
  teamWorkItemConfigurationFixture,
  workspaceWorkItemConfigurationFixture,
} from './fixtures'

const scopeOptions = [
  {
    value: 'workspace',
    label: 'Workspace default',
    description: 'All Teams inherit this configuration unless they have an override.',
  },
  {
    value: 'team:core-team',
    label: 'Core team',
    description: 'A Team override can evolve without changing other Teams.',
  },
]

/**
 * WorkItemConfigurationPanel の Storybook metadata です。
 */
const meta = {
  title: 'Application/Work Items/Configuration Panel',
  component: WorkItemConfigurationPanel,
  parameters: {
    layout: 'fullscreen',
  },
  decorators: [
    (Story) => (
      <main className="min-h-screen bg-[var(--workbench-page)] p-6 max-[720px]:p-3">
        <Story />
      </main>
    ),
  ],
  args: {
    configuration: workspaceWorkItemConfigurationFixture,
    locale: 'ja',
    onSave: async () => undefined,
    onScopeChange: () => undefined,
    scopeOptions,
    selectedScopeValue: 'workspace',
  },
} satisfies Meta<typeof WorkItemConfigurationPanel>

export default meta

/**
 * WorkItemConfigurationPanel stories の型です。
 */
type Story = StoryObj<typeof meta>

/**
 * Workspace の workflow と全 custom field type を編集する標準状態です。
 */
export const WorkspaceDefault: Story = {}

/**
 * Team 固有 override を英語 locale で編集する状態です。
 */
export const TeamOverride: Story = {
  args: {
    configuration: teamWorkItemConfigurationFixture,
    locale: 'en',
    selectedScopeValue: 'team:core-team',
  },
}

/**
 * Team が Workspace configuration を継承している状態です。
 */
export const InheritedFromWorkspace: Story = {
  args: {
    inheritedFrom: 'workspace',
    selectedScopeValue: 'team:core-team',
  },
}

/**
 * 権限が無い利用者向けの参照専用状態です。
 */
export const ReadOnly: Story = {
  args: {
    readOnly: true,
  },
}

/**
 * Configuration API の loading 状態です。
 */
export const Loading: Story = {
  args: {
    isLoading: true,
  },
}

/**
 * API error を設定面の外周へ表示する状態です。
 */
export const ErrorState: Story = {
  args: {
    errorMessage: '別の管理者が設定を更新しました。最新の revision を読み込んでください。',
  },
}
