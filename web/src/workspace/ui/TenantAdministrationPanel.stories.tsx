import type { Meta, StoryObj } from '@storybook/react-vite'
import type {
  TenantAdministrationSnapshot,
  TenantOperation,
} from '@mukuroji/contracts'
import { createTranslator } from '../../shared/i18n/i18n'
import { TenantAdministrationPanel } from './TenantAdministrationPanel'

const snapshot = {
  schemaVersion: 3,
  profile: {
    workspaceId: 'workspace-1',
    ownerMemberKey: 'owner@example.com',
    region: 'ap-northeast-1',
    locale: 'ja',
    defaultPolicy: {
      defaultMemberRole: 'member',
    },
    status: 'active',
    revision: 2,
    createdAt: '2026-07-01T00:00:00.000Z',
    updatedAt: '2026-08-01T00:00:00.000Z',
  },
  recentOperations: [],
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

const completedClosure = {
  operationId: 'closure-operation-1',
  workspaceId: 'workspace-1',
  kind: 'closure',
  status: 'completed',
  requestedBy: 'owner@example.com',
  requestedAt: '2026-08-02T00:00:00.000Z',
  updatedAt: '2026-08-02T00:20:00.000Z',
  updatedBy: 'executor:tenant-closure-verification',
  currentStep: 'verify',
  completedSteps: [
    'export',
    'revoke-access',
    'anonymize-members',
    'delete-data',
    'delete-secrets',
    'verify',
  ],
  lastEvidenceReference: `evidence:sha256:${'a'.repeat(64)}`,
  revision: 7,
} satisfies TenantOperation

const failedExport = {
  operationId: 'export-operation-1',
  workspaceId: 'workspace-1',
  kind: 'export',
  status: 'failed',
  requestedBy: 'owner@example.com',
  requestedAt: '2026-08-01T00:00:00.000Z',
  updatedAt: '2026-08-01T00:03:00.000Z',
  updatedBy: 'executor:tenant-export',
  currentStep: 'prepare-artifact',
  completedSteps: ['snapshot'],
  lastEvidenceReference: `evidence:sha256:${'b'.repeat(64)}`,
  failureCode: 'EXPORT_ARTIFACT_FAILED',
  exportFormat: 'jsonl',
  revision: 3,
} satisfies TenantOperation

const meta = {
  args: {
    activeOperation: undefined,
    closureConfirmation: '',
    data: snapshot,
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

/** Standard tenant control-plane state with Workspace governance and lifecycle history. */
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

/** Closing state with auditable terminal and failed operation history. */
export const ClosingWithHistory: Story = {
  args: {
    activeOperation: completedClosure,
    data: {
      ...snapshot,
      profile: {
        ...snapshot.profile,
        status: 'closing',
        revision: 3,
        updatedAt: '2026-08-02T00:00:00.000Z',
      },
      activeOperation: completedClosure,
      recentOperations: [completedClosure, failedExport],
    },
    profile: {
      ...snapshot.profile,
      status: 'closing',
      revision: 3,
      updatedAt: '2026-08-02T00:00:00.000Z',
    },
  },
}
