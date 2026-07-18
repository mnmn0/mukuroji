import {
  REQUEST_FORM_SCHEMA_VERSION,
  REQUEST_SUBMISSION_SCHEMA_VERSION,
  type PublicRequestForm,
  type RequestForm,
  type RequestFormDraft,
  type RequestFormVersion,
  type RequestSubmission,
  type RequestSubmissionReceipt,
} from '@mukuroji/contracts'

const requestFormDraft: RequestFormDraft = {
  definition: {
    attachments: {
      allowedMediaTypes: ['application/pdf', 'image/png'],
      enabled: true,
      maxFiles: 3,
      maxSizeBytes: 10 * 1024 * 1024,
    },
    confirmation: {
      message: {
        en: 'Thank you. Your request is now in the intake queue.',
        ja: 'ありがとうございます。リクエストを受付キューへ登録しました。',
      },
    },
    consent: {
      label: {
        en: 'I agree to the handling of the submitted information.',
        ja: '送信情報の取り扱いに同意します。',
      },
      privacyUrl: '/privacy',
      required: true,
    },
    defaultLocale: 'ja' as const,
    description: {
      en: 'Share the context the team needs to triage your request.',
      ja: 'チームが判断するために必要な背景を入力してください。',
    },
    sections: [
      {
        fields: [
          {
            id: 'requester-email',
            label: { en: 'Email', ja: 'メールアドレス' },
            placeholder: { en: 'you@example.com', ja: 'you@example.com' },
            type: 'email' as const,
            validation: { required: true },
          },
          {
            id: 'request-kind',
            label: { en: 'Request type', ja: '依頼種別' },
            options: [
              { id: 'bug', label: { en: 'Bug', ja: '不具合' } },
              { id: 'question', label: { en: 'Question', ja: '質問' } },
            ],
            type: 'single-select' as const,
            validation: { required: true },
          },
          {
            helpText: { en: 'Include expected and actual behavior.', ja: '期待値と実際の結果を含めてください。' },
            id: 'summary',
            label: { en: 'Summary', ja: '依頼内容' },
            type: 'long-text' as const,
            validation: { maxLength: 2_000, minLength: 8, required: true },
          },
          {
            id: 'reproduction',
            label: { en: 'Reproduction steps', ja: '再現手順' },
            type: 'long-text' as const,
            validation: { required: true },
            visibleWhen: {
              conditions: [{ fieldId: 'request-kind', operator: 'equals' as const, value: 'bug' }],
              mode: 'all' as const,
            },
          },
          {
            id: 'files',
            label: { en: 'Attachments', ja: '添付' },
            type: 'attachment' as const,
          },
        ],
        id: 'request-details',
        title: { en: 'Request details', ja: '依頼内容' },
      },
    ],
    supportedLocales: ['ja', 'en'] as const,
    title: { en: 'Product support request', ja: 'プロダクトサポート依頼' },
  },
  routing: {
    defaultTarget: {
      assigneeUserId: 'demo@example.com',
      dueDateOffsetDays: 7,
      priority: 'medium' as const,
      projectId: 'refero',
      teamId: 'core-team',
      workflowStatusId: 'todo',
    },
    mapping: {
      customFieldMappings: { 'request-kind': 'request-category' },
      descriptionFieldIds: ['requester-email', 'summary', 'reproduction'],
      titleFieldId: 'summary',
    },
    rules: [
      {
        id: 'bug-routing',
        name: 'Bug routing',
        target: {
          assigneeUserId: 'design@example.com',
          dueDateOffsetDays: 2,
          priority: 'high',
          projectId: 'shared-launch',
          teamId: 'design-team',
          workflowStatusId: 'triage',
        },
        when: {
          conditions: [{ fieldId: 'request-kind', operator: 'equals', value: 'bug' }],
          mode: 'all',
        },
      },
    ],
  },
}

/**
 * Request form builder stories で利用する form fixture です。
 */
export const requestFormFixture: RequestForm = {
  capabilities: { canEdit: true, canManageLink: true, canPublish: true },
  createdAt: '2026-07-16T00:00:00.000Z',
  currentPublishedVersion: 1,
  draft: requestFormDraft,
  id: 'support-request',
  link: {
    accessMode: 'public',
    expiresAt: '2026-12-31T15:00:00.000Z',
    linkId: 'support-public',
    token: 'public-support-request-token',
  },
  name: 'Product support intake',
  publishedVersions: [1],
  revision: 3,
  scope: { type: 'workspace' },
  status: 'published',
  updatedAt: '2026-07-16T01:00:00.000Z',
}

/**
 * Historical response 表示に利用する immutable form version fixture です。
 */
export const requestFormVersionFixture: RequestFormVersion = {
  createdAt: '2026-07-16T00:30:00.000Z',
  createdBy: 'admin@example.com',
  formId: requestFormFixture.id,
  schemaVersion: REQUEST_FORM_SCHEMA_VERSION,
  snapshot: requestFormDraft,
  version: 1,
}

/**
 * Queue/detail stories で利用する submission fixture です。
 */
export const requestSubmissionFixture: RequestSubmission = {
  answers: {
    'request-kind': 'bug',
    'requester-email': 'external@example.com',
    reproduction: '1. Open the form\n2. Submit\n3. Observe the error',
    summary: 'The public request form returns an error after submit.',
  },
  attachments: [
    {
      contentType: 'image/png',
      fieldId: 'files',
      fileName: 'error-screen.png',
      id: 'attachment-1',
      scanStatus: 'available',
      sizeBytes: 240_000,
    },
  ],
  capabilities: {
    canAssign: true,
    canConvert: true,
    canMarkDuplicate: true,
    canReject: true,
    canRequestMoreInfo: true,
  },
  consent: {
    accepted: true,
    acceptedAt: '2026-07-16T02:00:00.000Z',
    label: requestFormDraft.definition.consent?.label ?? {},
  },
  createdAt: '2026-07-16T02:00:00.000Z',
  duplicateCandidateIds: ['submission-previous'],
  events: [
    {
      actorId: 'external',
      createdAt: '2026-07-16T02:00:00.000Z',
      id: 'event-1',
      summary: 'Public form submission received.',
      type: 'submitted',
    },
  ],
  formId: requestFormFixture.id,
  formSnapshot: requestFormVersionFixture,
  formVersion: 1,
  id: 'submission-1',
  locale: 'ja',
  messages: [
    {
      body: 'The issue started this morning.',
      createdAt: '2026-07-16T02:00:00.000Z',
      direction: 'requester',
      id: 'message-1',
      source: 'web',
    },
  ],
  receiptId: 'REQ-7J3K',
  revision: 1,
  routingTarget: requestFormDraft.routing.defaultTarget,
  schemaVersion: REQUEST_SUBMISSION_SCHEMA_VERSION,
  source: 'web',
  status: 'received',
  updatedAt: '2026-07-16T02:00:00.000Z',
  workItemMapping: requestFormDraft.routing.mapping,
}

/**
 * Public form story が利用する allowlist 済み DTO fixture です。
 */
export const publicRequestFormFixture: PublicRequestForm = {
  accessMode: 'public',
  definition: requestFormDraft.definition,
  formId: requestFormFixture.id,
  schemaVersion: REQUEST_FORM_SCHEMA_VERSION,
  submissionSession: {
    expiresAt: '2026-07-16T03:00:00.000Z',
    minimumSubmitAt: '2026-07-16T02:00:03.000Z',
    token: 'one-time-submission-session',
  },
  version: 1,
}

/**
 * Public submit 完了 story が利用する receipt fixture です。
 */
export const requestSubmissionReceiptFixture: RequestSubmissionReceipt = {
  confirmationMessage: 'ありがとうございます。リクエストを受付キューへ登録しました。',
  receiptId: 'REQ-7J3K',
  submittedAt: '2026-07-16T02:00:00.000Z',
  threadToken: 'requester-thread-token',
}
