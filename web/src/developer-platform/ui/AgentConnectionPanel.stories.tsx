import type { Meta, StoryObj } from '@storybook/react-vite'
import { useState } from 'react'
import type { PersonalAgentCredentialOverview } from '@mukuroji/contracts'
import { fn } from 'storybook/test'
import { createTranslator } from '../../shared/i18n/i18n'
import {
  AgentConnectionPanel,
  type AgentConnectionChoices,
  type AgentConnectionPanelProps,
  type PersonalKeyForm,
} from './AgentConnectionPanel'

const overview: PersonalAgentCredentialOverview = {
  memberId: 'taro@example.com',
  canIssue: true,
  policy: { selfIssuanceEnabled: true },
  scopes: ['work-items:read', 'work-items:write'],
  maxLifetimeDays: 90,
  apiKeys: [
    {
      id: 'key-laptop',
      name: 'MacBook の Claude Code',
      prefix: 'mk_key_4f2a91c',
      scopes: ['work-items:read', 'work-items:write'],
      status: 'active',
      createdByUserId: 'taro@example.com',
      createdAt: '2026-11-01T00:00:00.000Z',
      expiresAt: '2026-12-01T14:59:59.999Z',
      lastUsedAt: '2026-11-10T03:12:00.000Z',
    },
    {
      id: 'key-old',
      name: 'Old desktop',
      prefix: 'mk_key_93bd0e1',
      scopes: ['work-items:read'],
      status: 'revoked',
      createdByUserId: 'taro@example.com',
      createdAt: '2026-09-01T00:00:00.000Z',
      expiresAt: '2026-10-01T14:59:59.999Z',
      revokedAt: '2026-09-20T00:00:00.000Z',
    },
  ],
}

/** Keeps the choices and form interactive inside Storybook. */
function InteractivePanel(props: AgentConnectionPanelProps) {
  const [choices, setChoices] = useState<AgentConnectionChoices>(props.choices)
  const [form, setForm] = useState<PersonalKeyForm>(props.form)
  return (
    <AgentConnectionPanel
      {...props}
      choices={choices}
      form={form}
      onChoicesChange={setChoices}
      onFormChange={setForm}
    />
  )
}

const meta = {
  args: {
    t: createTranslator('ja'),
    overview,
    isLoading: false,
    hasLoadError: false,
    hasOperationError: false,
    origin: 'https://mukuroji.example.com',
    teams: [
      { id: 'team-core', name: 'Core' },
      { id: 'team-web', name: 'Web' },
    ],
    choices: { client: 'claude-code', teamId: 'team-core', shell: 'posix', mcpPath: '' },
    form: { name: '', expiryDate: '2026-12-10' },
    expiryBounds: { min: '2026-11-11', max: '2027-02-07' },
    formatDateTime: (value: string) => new Date(value).toLocaleString('ja-JP'),
    onChoicesChange: fn(),
    onFormChange: fn(),
    onIssue: fn(),
    onRotate: fn(),
    onRevoke: fn(),
    onDismissIssuedToken: fn(),
    onRetry: fn(),
  },
  component: AgentConnectionPanel,
  decorators: [(Story) => (
    <main className="min-h-screen bg-[var(--workbench-page)] p-6 max-[720px]:p-3">
      <div className="mx-auto max-w-5xl"><Story /></div>
    </main>
  )],
  parameters: { layout: 'fullscreen' },
  render: (args) => <InteractivePanel {...args} />,
  title: 'Application/Developer Platform/Agent Connection',
} satisfies Meta<typeof AgentConnectionPanel>

/** Storybook metadata for the page where a member connects their own coding agent. */
export default meta

/** Story shape for the agent connection page. */
type Story = StoryObj<typeof meta>

/** A member with one active and one revoked token. */
export const Member: Story = {}

/** Right after issuing a token, with the one-time value and environment command. */
export const JustIssued: Story = {
  args: {
    issuedToken: { name: 'MacBook の Claude Code', secret: 'mk_key_4f2a91c7d0e84b6fa3c2_example' },
  },
}

/** Windows with Codex selected. */
export const WindowsCodex: Story = {
  args: {
    choices: { client: 'codex', teamId: 'team-web', shell: 'powershell', mcpPath: 'C:\\Users\\taro\\mukuroji\\mcp.mjs' },
  },
}

/** An administrator turned off member-issued tokens. */
export const IssuanceTurnedOff: Story = {
  args: {
    overview: { ...overview, canIssue: false, issuanceBlockedReason: 'policy-disabled', policy: { selfIssuanceEnabled: false } },
  },
}

/** English copy with Kiro selected. */
export const EnglishKiro: Story = {
  args: {
    t: createTranslator('en'),
    choices: { client: 'kiro', teamId: 'team-core', shell: 'posix', mcpPath: '/Users/taro/mukuroji/mcp.mjs' },
  },
}
