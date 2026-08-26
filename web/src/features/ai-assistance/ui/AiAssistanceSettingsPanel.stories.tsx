import type { Meta, StoryObj } from '@storybook/react-vite'
import { fn } from 'storybook/test'
import { createTranslator } from '../../../shared/i18n/i18n'
import {
  aiAssistancePolicyFixture,
  aiAssistancePreferenceFixture,
} from '../fixtures'
import { AiAssistanceSettingsPanel } from './AiAssistanceSettingsPanel'

/** Storybook metadata for personal and manager-only AI assistance settings. */
const meta = {
  title: 'Application/AI Assistance/Settings',
  component: AiAssistanceSettingsPanel,
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
    canManagePolicy: false,
    onPolicyChange: fn(),
    onPolicyRetry: fn(),
    onPolicySave: fn(),
    onPreferenceChange: fn(),
    onPreferenceSave: fn(),
    preference: aiAssistancePreferenceFixture,
    t: createTranslator('en'),
  },
} satisfies Meta<typeof AiAssistanceSettingsPanel>

export default meta

/** Story type for the AI assistance settings panel. */
type Story = StoryObj<typeof meta>

/** Every member can explicitly save a personal opt-out without manager policy data in the DOM. */
export const MemberPreference: Story = {}

/** A member's changed opt-out enables only the personal explicit-save action. */
export const PersonalChangePending: Story = {
  args: {
    isPreferenceDirty: true,
    preference: { ...aiAssistancePreferenceFixture, enabled: false },
  },
}

/** Workspace administrators can explicitly replace the full revision-fenced Bedrock policy. */
export const AdministratorPolicy: Story = {
  args: {
    canManagePolicy: true,
    isPolicyDirty: true,
    policy: { ...aiAssistancePolicyFixture, retentionDays: 45 },
  },
}

/**
 * A stale policy save surfaces the refreshed-value review requirement beside its own action.
 *
 * @remarks This story keeps the save disabled until the operator chooses the
 * latest server revision.
 */
export const RevisionConflict: Story = {
  args: {
    canManagePolicy: true,
    hasPolicyRevisionConflict: true,
    isPolicyDirty: true,
    onPolicyUseLatest: fn(),
    policy: aiAssistancePolicyFixture,
    policyFeedback: 'conflict',
  },
}

/** A policy load failure remains isolated from the member's available personal setting. */
export const PolicyLoadError: Story = {
  args: {
    canManagePolicy: true,
    policyLoadError: true,
  },
}

/** The administrator policy can load independently without hiding the member preference. */
export const PolicyLoading: Story = {
  args: {
    canManagePolicy: true,
    isPolicyLoading: true,
  },
}

/**
 * Narrow member settings retain a full-width, accessible explicit-save action.
 *
 * @remarks The mobile viewport verifies that the personal setting remains
 * keyboard and touch reachable without horizontal overflow.
 */
export const MobileMemberPreference: Story = {
  globals: { viewport: { isRotated: false, value: 'mobile1' } },
}
