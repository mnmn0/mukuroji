import {
  AGENT_SETTINGS_BRIEF_MAX_BYTES,
  AGENT_SETTINGS_SCHEMA_VERSION,
  type AgentSettings,
} from '@mukuroji/contracts'
import type { Meta, StoryObj } from '@storybook/react-vite'
import { fn } from 'storybook/test'
import { createTranslator } from '../../../shared/i18n/i18n'
import {
  agentSettingsConfigurationFixture,
  agentSettingsFixture,
  agentSettingsTeamsFixture,
} from '../fixtures'
import {
  createAgentSettingsDraft,
  listAgentAcceptanceCriteriaFieldOptions,
  listAgentProjectBriefTargets,
  listAgentReadyStatusOptions,
} from '../model/agentSettingsForm'
import { AgentSettingsPanel } from './AgentSettingsPanel'

const loadedDraft = createAgentSettingsDraft(agentSettingsFixture)

/** Settings of a Team that never saved its own. */
const defaultSettings: AgentSettings = {
  schemaVersion: AGENT_SETTINGS_SCHEMA_VERSION,
  teamId: 'team-growth',
  revision: 0,
  leaseMinutes: 30,
  allowTakeoverAfterLeaseExpiry: false,
  readyStatusIds: [],
  requireAcceptanceCriteria: false,
  projectBriefs: {},
  fileFailedRunsToTriage: false,
  fileStalledRunsToTriage: false,
}

/** Storybook metadata for the Team Agent settings panel. */
const meta = {
  title: 'Application/Agent Settings/Panel',
  component: AgentSettingsPanel,
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
    acceptanceCriteriaFieldOptions: listAgentAcceptanceCriteriaFieldOptions(
      agentSettingsConfigurationFixture,
      loadedDraft.acceptanceCriteriaFieldId,
    ),
    configurationState: 'ready',
    draft: loadedDraft,
    hasLoadError: false,
    hasRevisionConflict: false,
    isDirty: false,
    isLoading: false,
    isSaving: false,
    locale: 'en',
    onConfigurationRetry: fn(),
    onDraftChange: fn(),
    onReload: fn(),
    onRetry: fn(),
    onSave: fn(),
    onTeamChange: fn(),
    projectBriefTargets: listAgentProjectBriefTargets(
      agentSettingsTeamsFixture[0]?.projects ?? [],
      agentSettingsFixture.projectBriefs,
    ),
    readOnly: false,
    readyStatusOptions: listAgentReadyStatusOptions(agentSettingsConfigurationFixture, loadedDraft.readyStatusIds),
    selectedTeamId: agentSettingsFixture.teamId,
    settings: agentSettingsFixture,
    t: createTranslator('en'),
    teamOptions: agentSettingsTeamsFixture,
  },
} satisfies Meta<typeof AgentSettingsPanel>

export default meta

/** Story type for the Agent settings panel. */
type Story = StoryObj<typeof meta>

/** A Team manager edits loaded settings; the save is enabled once a value changes. */
export const ManagerEditing: Story = {
  args: {
    draft: { ...loadedDraft, leaseMinutes: '60', readyStatusIds: ['ready', 'triage'] },
    isDirty: true,
  },
}

/** The settings were saved. */
export const Saved: Story = {
  args: { feedback: { kind: 'saved' } },
}

/** A member who is not a Team manager reviews the settings without a save action. */
export const ReadOnly: Story = {
  args: { readOnly: true },
}

/** The settings are being read for the first time. */
export const Loading: Story = {
  args: { draft: undefined, isLoading: true, settings: undefined },
}

/** Reading the settings failed; the error stays visible with a retry action. */
export const LoadError: Story = {
  args: { draft: undefined, hasLoadError: true, settings: undefined },
}

/** The Team's workflow and fields could not be loaded; the rest of the form stays usable. */
export const ConfigurationError: Story = {
  args: { configurationState: 'error' },
}

/** Someone else saved the settings first; the save is blocked until the operator reloads. */
export const Conflict: Story = {
  args: {
    draft: { ...loadedDraft, leaseMinutes: '90' },
    feedback: { kind: 'conflict' },
    isDirty: true,
  },
}

/** A brief over the size limit blocks the save and shows its counter as an error. */
export const OverLimit: Story = {
  args: {
    draft: { ...loadedDraft, brief: 'x'.repeat(AGENT_SETTINGS_BRIEF_MAX_BYTES + 120) },
    isDirty: true,
  },
}

/** A Team whose settings were never saved, without Projects or selected statuses. */
export const Defaults: Story = {
  args: {
    acceptanceCriteriaFieldOptions: listAgentAcceptanceCriteriaFieldOptions(agentSettingsConfigurationFixture, ''),
    draft: createAgentSettingsDraft(defaultSettings),
    projectBriefTargets: [],
    readyStatusOptions: listAgentReadyStatusOptions(agentSettingsConfigurationFixture, []),
    selectedTeamId: defaultSettings.teamId,
    settings: defaultSettings,
  },
}

/** Japanese labels for the manager view. */
export const Japanese: Story = {
  args: { locale: 'ja', t: createTranslator('ja') },
}
