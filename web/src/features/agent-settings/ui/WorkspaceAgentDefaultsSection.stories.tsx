import {
  AGENT_SETTINGS_BRIEF_MAX_BYTES,
  AGENT_SETTINGS_SCHEMA_VERSION,
  type WorkspaceAgentDefaults,
} from '@mukuroji/contracts'
import type { Meta, StoryObj } from '@storybook/react-vite'
import { fn } from 'storybook/test'
import { createTranslator } from '../../../shared/i18n/i18n'
import { createWorkspaceAgentDefaultsDraft } from '../model/agentSettingsForm'
import { WorkspaceAgentDefaultsSection } from './WorkspaceAgentDefaultsSection'

/** Saved Workspace agent defaults shown by the stories. */
const savedDefaults: WorkspaceAgentDefaults = {
  schemaVersion: AGENT_SETTINGS_SCHEMA_VERSION,
  revision: 3,
  leaseMinutes: 45,
  allowTakeoverAfterLeaseExpiry: true,
  requireAcceptanceCriteria: true,
  brief: '## Workspace rules\n\n- Run `bun test` before pushing.\n- Keep pull requests small.',
  updatedAt: '2026-11-25T09:00:00.000Z',
  updatedBy: 'admin-1',
}

/** Storybook metadata for the Workspace agent defaults section. */
const meta = {
  title: 'Application/Agent Settings/Workspace Defaults',
  component: WorkspaceAgentDefaultsSection,
  parameters: { layout: 'fullscreen' },
  decorators: [
    (Story) => (
      <main className="min-h-screen bg-[var(--workbench-canvas)] p-6 max-[480px]:p-3">
        <div className="mx-auto max-w-5xl">
          <Story />
        </div>
      </main>
    ),
  ],
  args: {
    defaults: savedDefaults,
    draft: createWorkspaceAgentDefaultsDraft(savedDefaults),
    hasLoadError: false,
    hasRevisionConflict: false,
    isDirty: false,
    isLoading: false,
    isSaving: false,
    locale: 'en',
    t: createTranslator('en'),
    onDraftChange: fn(),
    onReload: fn(),
    onRetry: fn(),
    onSave: fn(),
  },
} satisfies Meta<typeof WorkspaceAgentDefaultsSection>

export default meta

/** One story of the Workspace agent defaults section. */
type Story = StoryObj<typeof meta>

/** Saved defaults with a brief. */
export const Saved: Story = {}

/** Built-in defaults that were never saved, in Japanese. */
export const Unsaved: Story = {
  args: {
    defaults: { schemaVersion: AGENT_SETTINGS_SCHEMA_VERSION, revision: 0, leaseMinutes: 30, allowTakeoverAfterLeaseExpiry: false, requireAcceptanceCriteria: false },
    draft: { leaseMinutes: '30', allowTakeoverAfterLeaseExpiry: false, requireAcceptanceCriteria: false, brief: '' },
    locale: 'ja',
    t: createTranslator('ja'),
  },
}

/** First load in progress. */
export const Loading: Story = {
  args: { defaults: undefined, draft: undefined, isLoading: true },
}

/** First load failed, with a retry. */
export const LoadError: Story = {
  args: { defaults: undefined, draft: undefined, hasLoadError: true },
}

/** Edited with an invalid lease and an oversized brief, so the save is blocked. */
export const Invalid: Story = {
  args: {
    draft: { ...createWorkspaceAgentDefaultsDraft(savedDefaults), leaseMinutes: '0', brief: 'x'.repeat(AGENT_SETTINGS_BRIEF_MAX_BYTES + 1) },
    isDirty: true,
  },
}

/** Saving an edit. */
export const Saving: Story = {
  args: { draft: { ...createWorkspaceAgentDefaultsDraft(savedDefaults), leaseMinutes: '60' }, isDirty: true, isSaving: true },
}

/** Another administrator saved meanwhile; the edit must be reloaded. */
export const Conflict: Story = {
  args: { draft: { ...createWorkspaceAgentDefaultsDraft(savedDefaults), leaseMinutes: '60' }, hasRevisionConflict: true, isDirty: true },
}

/** The save succeeded. */
export const SavedFeedback: Story = {
  args: { feedback: { kind: 'saved' } },
}
