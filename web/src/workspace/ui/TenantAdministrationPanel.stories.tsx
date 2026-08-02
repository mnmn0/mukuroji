import type { Meta, StoryObj } from '@storybook/react-vite'
import type { TenantAdministrationSnapshot } from '@mukuroji/contracts'
import { createTranslator } from '../../shared/i18n/i18n'
import { TenantAdministrationPanel } from './TenantAdministrationPanel'

const snapshot = {
  schemaVersion: 2,
  profile: {
    workspaceId: 'workspace-1',
    ownerMemberKey: 'owner@example.com',
    region: 'ap-northeast-1',
    locale: 'ja',
    defaultPolicy: {
      allowExternalCollaborators: false,
      requireMfa: true,
      defaultMemberRole: 'member',
    },
    revision: 2,
    createdAt: '2026-07-01T00:00:00.000Z',
    updatedAt: '2026-08-01T00:00:00.000Z',
  },
  entitlement: {
    workspaceId: 'workspace-1',
    plan: 'growth',
    features: ['documents', 'analytics', 'automation'],
    seatLimit: 25,
    usageQuota: 100_000,
    gracePeriodDays: 7,
    revision: 3,
    updatedAt: '2026-08-01T00:00:00.000Z',
  },
  usage: {
    workspaceId: 'workspace-1',
    activeSeats: 18,
    periodUsage: 42_350,
    periodStart: '2026-08-01T00:00:00.000Z',
    periodEnd: '2026-09-01T00:00:00.000Z',
    revision: 18,
    updatedAt: '2026-08-02T00:00:00.000Z',
  },
  billingPeriods: [
    {
      workspaceId: 'workspace-1',
      periodStart: '2026-08-01T00:00:00.000Z',
      periodEnd: '2026-09-01T00:00:00.000Z',
      meteredUnits: 42_350,
      activeSeatHighWaterMark: 19,
      revision: 18,
      updatedAt: '2026-08-02T00:00:00.000Z',
    },
    {
      workspaceId: 'workspace-1',
      periodStart: '2026-07-01T00:00:00.000Z',
      periodEnd: '2026-08-01T00:00:00.000Z',
      meteredUnits: 91_420,
      activeSeatHighWaterMark: 18,
      revision: 51,
      updatedAt: '2026-07-31T23:30:00.000Z',
    },
  ],
  governance: {
    workspaceId: 'workspace-1',
    auditRetentionDays: 365,
    legalHold: false,
    dataResidency: 'ap-northeast-1',
    encryptionKeyPolicy: 'aws-managed',
    revision: 1,
    updatedAt: '2026-08-01T00:00:00.000Z',
    updatedBy: 'owner@example.com',
  },
  governanceEnforcement: {
    dataResidency: 'ap-northeast-1',
    encryptionKeyPolicy: 'aws-managed',
  },
} satisfies TenantAdministrationSnapshot

const meta = {
  args: {
    activeOperation: undefined,
    closureConfirmation: '',
    data: snapshot,
    entitlement: snapshot.entitlement,
    exportFormat: 'jsonl',
    governance: snapshot.governance,
    isSaving: false,
    locale: 'ja',
    onChangeClosureConfirmation: () => undefined,
    onChangeExportFormat: () => undefined,
    onChangeGovernance: () => undefined,
    onChangeProfile: () => undefined,
    onPauseOperation: () => undefined,
    onRequestClosure: () => undefined,
    onRequestExport: () => undefined,
    onResumeOperation: () => undefined,
    onSaveGovernance: () => undefined,
    onSaveProfile: () => undefined,
    onVerifyClosure: () => undefined,
    profile: snapshot.profile,
    t: createTranslator('ja'),
  },
  component: TenantAdministrationPanel,
  parameters: { layout: 'padded' },
  title: 'Application/Settings/Tenant Administration Panel',
} satisfies Meta<typeof TenantAdministrationPanel>

/** Tenant administration Storybook metadata. */
export default meta

/** Tenant administration story type. */
type Story = StoryObj<typeof meta>

/** Standard tenant control-plane state with recent billing history. */
export const Standard: Story = {}

/** Legal-hold reconciliation state that blocks account closure. */
export const LegalHold: Story = {
  args: {
    data: {
      ...snapshot,
      governance: { ...snapshot.governance, legalHold: true, revision: 2 },
      retentionReconciliation: {
        workspaceId: 'workspace-1',
        governanceRevision: 2,
        status: 'running',
        retentionDays: 365,
        legalHold: true,
        processedEvents: 264,
        cursorEventId: 'audit-event-264',
        revision: 11,
        updatedAt: '2026-08-02T00:10:00.000Z',
        updatedBy: 'executor:tenant-retention',
      },
    },
    governance: { ...snapshot.governance, legalHold: true, revision: 2 },
  },
}
