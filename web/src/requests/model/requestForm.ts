import type {
  CreateRequestFormInput,
  PublicRequestForm,
  RequestForm,
  RequestFormAccessMode,
  RequestFormConditionGroup,
  RequestFormDraft,
  RequestFormField,
  RequestFormFieldType,
  RequestFormRoutingTarget,
  RequestFormScope,
  RequestFormSection,
  RequestFormStatus,
  RequestLocale,
  RequestLocalizedText,
  RequestSubmission,
  RequestSubmissionStatus,
  UpdateRequestFormInput,
  WorkItemPriority,
} from '@mukuroji/contracts'
import type {
  RequestAnswerValue,
  RequestFieldValidation,
  RequestVisibilityCondition,
} from './requestFormLogic'

/**
 * Request form builder が提供する field type です。
 */
export type RequestBuilderFieldType =
  | 'text'
  | 'textarea'
  | 'email'
  | 'url'
  | 'number'
  | 'date'
  | 'select'
  | 'multi-select'
  | 'checkbox'
  | 'attachment'

/**
 * Select 系 request field の option draft です。
 */
export type RequestBuilderOption = {
  /** Option の安定 ID です。 */
  id: string
  /** Locale ごとの option label です。 */
  label: RequestLocalizedText
}

/**
 * Request form builder が編集する field draft です。
 */
export type RequestBuilderField = {
  /** Form version 内で一意な field ID です。 */
  id: string
  /** Browser control を決める field type です。 */
  type: RequestBuilderFieldType
  /** Locale ごとの field label です。 */
  label: RequestLocalizedText
  /** Locale ごとの補足文です。 */
  description: RequestLocalizedText
  /** Locale ごとの placeholder です。 */
  placeholder: RequestLocalizedText
  /** Visible 時に回答を必須にするかどうかです。 */
  required: boolean
  /** Field の表示条件です。 */
  condition?: RequestVisibilityCondition
  /** 型固有 validation です。 */
  validation?: RequestFieldValidation
  /** Select 系 field の選択肢です。 */
  options: RequestBuilderOption[]
}

/**
 * Request form builder が編集する section draft です。
 */
export type RequestBuilderSection = {
  /** Form version 内で一意な section ID です。 */
  id: string
  /** Locale ごとの section title です。 */
  title: RequestLocalizedText
  /** Locale ごとの section description です。 */
  description: RequestLocalizedText
  /** Section 全体の表示条件です。 */
  condition?: RequestVisibilityCondition
  /** 表示順に並んだ field 一覧です。 */
  fields: RequestBuilderField[]
}

/**
 * Versioned consent 設定です。
 */
export type RequestConsentDraft = {
  /** Submit 前に consent を要求するかどうかです。 */
  required: boolean
  /** Locale ごとの consent 文面です。 */
  text: RequestLocalizedText
  /** Consent から開く privacy policy URL です。 */
  privacyUrl: string
}

/**
 * Public request attachment の許可範囲です。
 */
export type RequestAttachmentPolicyDraft = {
  /** Attachment upload を有効にするかどうかです。 */
  enabled: boolean
  /** Submission 全体で許可する最大 file 数です。 */
  maxFiles: number
  /** 1 file の最大 byte 数です。 */
  maxSizeBytes: number
  /** 許可する MIME type 一覧です。 */
  allowedContentTypes: string[]
}

/**
 * Submission から Work Item への既定 routing です。
 */
export type RequestRoutingDraft = {
  /** Work Item を所有する Team ID です。 */
  teamId: string
  /** Work Item を割り当てる任意 Project ID です。 */
  projectId: string
  /** Work Item 作成時に適用する workflow status ID です。 */
  workflowStatusId: string
  /** Work Item 担当 member ID です。 */
  assigneeUserId: string
  /** Work Item の既定 priority です。 */
  priority: WorkItemPriority
  /** Submission 日から期限までの日数です。 */
  dueDateOffsetDays: number
  /** Work Item title に利用する answer field ID です。 */
  titleFieldId: string
  /** Work Item description に利用する answer field ID 一覧です。 */
  descriptionFieldIds: string[]
  /** 最初に一致した rule を採用する ordered routing rules です。 */
  rules: RequestRoutingRuleDraft[]
  /** Form field ID から Work Item custom field ID への対応です。 */
  customFieldMappings: Record<string, string>
}

/**
 * 回答条件に一致したとき利用する routing rule draft です。
 */
export type RequestRoutingRuleDraft = {
  /** Form 内で安定した rule ID です。 */
  id: string
  /** 管理画面に表示する rule 名です。 */
  name: string
  /** 回答へ適用する all/any 条件です。 */
  condition: RequestVisibilityCondition
  /** 条件一致時に利用する Work Item target です。 */
  target: RequestRoutingTargetDraft
}

/**
 * Builder が編集する一つの Work Item routing target です。
 */
export type RequestRoutingTargetDraft = {
  /** Work Item を所有する Team ID です。 */
  teamId: string
  /** Work Item の任意 Project ID です。 */
  projectId: string
  /** Work Item の任意 workflow status ID です。 */
  workflowStatusId: string
  /** Work Item 担当 member ID です。 */
  assigneeUserId: string
  /** Work Item の既定 priority です。 */
  priority: WorkItemPriority
  /** Submission 日から期限までの日数です。 */
  dueDateOffsetDays: number
}

/**
 * RequestForm contract を操作可能な builder state へ正規化した model です。
 */
export type RequestFormDraftModel = {
  /** Request form ID です。新規作成前は空文字です。 */
  id: string
  /** 管理画面で識別する form 名です。 */
  name: string
  /** Form の管理/認可 scope です。 */
  scope: RequestFormScope
  /** Draft/published/archived の lifecycle 状態です。 */
  status: RequestFormStatus
  /** 公開 link の access mode です。 */
  accessMode: RequestFormAccessMode
  /** Link の任意 expiry timestamp です。 */
  expiresAt: string
  /** Link 共有に使う capability token です。 */
  linkToken: string
  /** Optimistic concurrency に使う revision です。 */
  revision: number
  /** 次回 publish で作成される version 番号です。 */
  versionNumber: number
  /** Form の既定 locale です。 */
  defaultLocale: RequestLocale
  /** Form が提供する locale 一覧です。 */
  locales: RequestLocale[]
  /** Locale ごとの form title です。 */
  title: RequestLocalizedText
  /** Locale ごとの form description です。 */
  description: RequestLocalizedText
  /** Locale ごとの submit 後 confirmation です。 */
  confirmation: RequestLocalizedText
  /** Confirmation 後の安全な redirect URL です。 */
  redirectUrl: string
  /** 表示順に並んだ section 一覧です。 */
  sections: RequestBuilderSection[]
  /** Versioned consent 設定です。 */
  consent: RequestConsentDraft
  /** Attachment upload policy です。 */
  attachmentPolicy: RequestAttachmentPolicyDraft
  /** Work Item conversion の既定 routing です。 */
  routing: RequestRoutingDraft
}

/**
 * Queue/detail で表示する versioned answer 行です。
 */
export type RequestSubmissionAnswerRow = {
  /** Answer field ID です。 */
  fieldId: string
  /** Historical version snapshot から解決した field label です。 */
  label: RequestLocalizedText
  /** Historical version snapshot に固定された選択肢です。 */
  options: RequestBuilderOption[]
  /** Submitter が保存した answer value です。 */
  value: RequestAnswerValue
}

/**
 * Request submission から作成された Work Item pointer です。
 */
export type RequestWorkItemPointer = {
  /** Work Item ID です。 */
  id: string
  /** Work Item を所有する Team ID です。 */
  teamId: string
  /** Work Item の任意 Project ID です。 */
  projectId?: string
}

/**
 * Intake queue と detail が利用する submission view model です。
 */
export type RequestSubmissionModel = {
  /** Submission ID です。 */
  id: string
  /** Submission を所有する Request Form ID です。 */
  formId: string
  /** Optimistic concurrency に使う revision です。 */
  revision: number
  /** Triage lifecycle status です。 */
  status: RequestSubmissionStatus
  /** Web form または email ingestion の source です。 */
  source: RequestSubmission['source']
  /** Submit に利用した form 名です。 */
  formName: string
  /** Submit に利用した immutable version 表示です。 */
  formVersionLabel: string
  /** Historical version snapshot の既定 locale です。 */
  formDefaultLocale: RequestLocale
  /** Submission 作成 timestamp です。 */
  receivedAt: string
  /** 外部へ返した安全な receipt 表示です。 */
  requesterLabel: string
  /** 一覧に表示する回答 summary です。 */
  summary: string
  /** 現在 triage を担当する member key です。 */
  assigneeUserId?: string
  /** Historical version label と value の回答一覧です。 */
  answers: RequestSubmissionAnswerRow[]
  /** Submission に関連付けた scan gated attachment です。 */
  attachments: RequestSubmission['attachments']
  /** 保存済み consent 文面です。 */
  consentText?: RequestLocalizedText
  /** Consent が取得済みかどうかです。 */
  consentAccepted: boolean
  /** Exact duplicate 候補 submission ID です。 */
  duplicateCandidateIds: string[]
  /** Convert 後の canonical Work Item pointer です。 */
  workItem?: RequestWorkItemPointer
  /** Internal/requester thread の plain text message です。 */
  messages: RequestSubmission['messages']
  /** Append-only activity です。 */
  events: RequestSubmission['events']
  /** Current principal の action capability です。 */
  capabilities: RequestSubmission['capabilities']
  /** Submit 時点で固定した routing target です。 */
  routing: RequestSubmission['routingTarget']
}

/**
 * Public DTO だけから構築する request form view model です。
 */
export type PublicRequestFormModel = {
  /** Published form ID です。 */
  formId: string
  /** Immutable form version 番号です。 */
  version: number
  /** Form の access mode です。 */
  accessMode: RequestFormAccessMode
  /** One-time submission session token です。 */
  sessionToken: string
  /** One-time submission session が失効する timestamp です。 */
  sessionExpiresAt: string
  /** Bot 対策で submit 可能になる timestamp です。 */
  minimumSubmitAt: string
  /** Form の既定 locale です。 */
  defaultLocale: RequestLocale
  /** Public form が提供する locale 一覧です。 */
  locales: RequestLocale[]
  /** Locale ごとの form title です。 */
  title: RequestLocalizedText
  /** Locale ごとの form description です。 */
  description: RequestLocalizedText
  /** Locale ごとの confirmation です。 */
  confirmation: RequestLocalizedText
  /** Confirmation 後に表示できる安全な URL です。 */
  redirectUrl?: string
  /** Public renderer が扱う section 一覧です。 */
  sections: RequestBuilderSection[]
  /** Versioned consent 設定です。 */
  consent: RequestConsentDraft
  /** Public attachment policy です。 */
  attachmentPolicy: RequestAttachmentPolicyDraft
}

/**
 * 空の request form builder model を生成します。
 */
export function createEmptyRequestFormDraft(): RequestFormDraftModel {
  return {
    accessMode: 'auth-required',
    attachmentPolicy: {
      allowedContentTypes: ['application/pdf', 'image/jpeg', 'image/png'],
      enabled: false,
      maxFiles: 3,
      maxSizeBytes: 10 * 1024 * 1024,
    },
    confirmation: { en: 'Your request has been received.', ja: 'リクエストを受け付けました。' },
    consent: { privacyUrl: '/privacy', required: false, text: { en: '', ja: '' } },
    defaultLocale: 'ja',
    description: { en: '', ja: '' },
    expiresAt: '',
    id: '',
    linkToken: '',
    locales: ['ja', 'en'],
    name: '',
    redirectUrl: '',
    revision: 0,
    routing: {
      assigneeUserId: '',
      customFieldMappings: {},
      descriptionFieldIds: [],
      dueDateOffsetDays: 7,
      priority: 'medium',
      projectId: '',
      teamId: '',
      titleFieldId: '',
      workflowStatusId: '',
      rules: [],
    },
    scope: { type: 'workspace' },
    sections: [createEmptyRequestSection('section-1')],
    status: 'draft',
    title: { en: '', ja: '' },
    versionNumber: 1,
  }
}

/**
 * Team scope の変更を default target と全 routing rule target へ同期します。
 *
 * Team が実際に変わる target では、旧 Team に属する Project と workflow status を除去します。
 *
 * @param routing - 現在の request routing draft です。
 * @param teamId - Form scope が固定する Team ID です。
 * @returns 全 target が指定 Team を参照する routing draft です。
 */
export function synchronizeRequestRoutingTeam(
  routing: RequestRoutingDraft,
  teamId: string,
): RequestRoutingDraft {
  const synchronizeTarget = (
    target: RequestRoutingTargetDraft,
  ): RequestRoutingTargetDraft => target.teamId === teamId
    ? target
    : {
        ...target,
        projectId: '',
        teamId,
        workflowStatusId: '',
      }
  const defaultTarget = synchronizeTarget(routing)

  return {
    ...routing,
    projectId: defaultTarget.projectId,
    teamId: defaultTarget.teamId,
    workflowStatusId: defaultTarget.workflowStatusId,
    rules: routing.rules.map((rule) => ({
      ...rule,
      target: synchronizeTarget(rule.target),
    })),
  }
}

/**
 * Builder model が server の strict draft validation に必要な入力を満たすか判定します。
 *
 * @param model - 保存または公開しようとしている request form draft です。
 * @returns 必須 localized text、routing、mapping、condition が揃っている場合は true です。
 */
export function isRequestFormDraftModelValid(model: RequestFormDraftModel) {
  const defaultLocale = model.defaultLocale
  const scopedTeamId = model.scope.type === 'team' ? model.scope.teamId : undefined
  const fields = model.sections.flatMap((section) => section.fields)
  const fieldIds = new Set(fields.map((field) => field.id))
  const sectionIds = new Set(model.sections.map((section) => section.id))
  const routingRuleIds = new Set(model.routing.rules.map((rule) => rule.id))
  const titleField = fields.find((field) => field.id === model.routing.titleFieldId)
  const hasLocalizedText = (text: RequestLocalizedText) =>
    Object.values(text).some((value) => Boolean(value?.trim()))
  const hasDefaultText = (text: RequestLocalizedText) => Boolean(text[defaultLocale]?.trim())
  const optionalDefaultTextIsValid = (text: RequestLocalizedText) =>
    !hasLocalizedText(text) || hasDefaultText(text)
  const targetIsValid = (target: RequestRoutingTargetDraft) =>
    Boolean(target.teamId.trim()) &&
    Boolean(target.assigneeUserId.trim()) &&
    Number.isInteger(target.dueDateOffsetDays) &&
    target.dueDateOffsetDays >= 0 &&
    (scopedTeamId === undefined || target.teamId === scopedTeamId)
  const conditionIsValid = (
    condition: RequestVisibilityCondition,
    allowedFieldIds: ReadonlySet<string> = fieldIds,
  ) =>
    condition.rules.length > 0 && condition.rules.every((rule) =>
      allowedFieldIds.has(rule.fieldId) && (
        rule.operator === 'is-empty' ||
        rule.operator === 'is-not-empty' ||
        (!Array.isArray(rule.value) && rule.value !== null && rule.value !== undefined)
      )
    )

  if (
    !model.name.trim() ||
    sectionIds.size !== model.sections.length ||
    fieldIds.size !== fields.length ||
    routingRuleIds.size !== model.routing.rules.length ||
    !model.locales.includes(defaultLocale) ||
    !hasDefaultText(model.title) ||
    !hasDefaultText(model.confirmation) ||
    !optionalDefaultTextIsValid(model.description) ||
    model.sections.length === 0 ||
    !targetIsValid(model.routing) ||
    !titleField ||
    titleField.type === 'attachment' ||
    titleField.type === 'checkbox'
  ) {
    return false
  }

  if (model.scope.type === 'team' && !model.scope.teamId?.trim()) return false

  const knownFieldIds = new Set<string>()
  for (const section of model.sections) {
    if (
      !section.id.trim() ||
      !hasDefaultText(section.title) ||
      !optionalDefaultTextIsValid(section.description) ||
      section.fields.length === 0 ||
      (section.condition && !conditionIsValid(section.condition, knownFieldIds))
    ) {
      return false
    }

    for (const field of section.fields) {
      if (!field.id.trim() || !hasDefaultText(field.label)) return false
      if (new Set(field.options.map((option) => option.id)).size !== field.options.length) {
        return false
      }
      if (field.condition && !conditionIsValid(field.condition, knownFieldIds)) return false
      if (
        (field.type === 'select' || field.type === 'multi-select') &&
        (field.options.length === 0 || field.options.some((option) =>
          !option.id.trim() || !hasDefaultText(option.label)
        ))
      ) {
        return false
      }
      if (field.type === 'attachment' && !model.attachmentPolicy.enabled) return false
      knownFieldIds.add(field.id)
    }
  }

  if (
    model.attachmentPolicy.enabled && (
      model.attachmentPolicy.maxFiles < 1 ||
      model.attachmentPolicy.maxSizeBytes < 1 ||
      model.attachmentPolicy.allowedContentTypes.length === 0
    )
  ) {
    return false
  }

  if (
    (model.consent.required || hasLocalizedText(model.consent.text)) &&
    !hasDefaultText(model.consent.text)
  ) {
    return false
  }

  if (model.routing.descriptionFieldIds.some((fieldId) => !fieldIds.has(fieldId))) return false
  const customFieldMappings = Object.entries(model.routing.customFieldMappings)
  if (customFieldMappings.some(
    ([fieldId, customFieldId]) => !fieldIds.has(fieldId) || !customFieldId.trim(),
  )) return false
  if (new Set(customFieldMappings.map(([, customFieldId]) => customFieldId)).size !== customFieldMappings.length) {
    return false
  }

  return model.routing.rules.every((rule) =>
    Boolean(rule.id.trim()) &&
    Boolean(rule.name.trim()) &&
    conditionIsValid(rule.condition) &&
    targetIsValid(rule.target)
  )
}

/**
 * RequestForm contract を builder model へ変換します。
 */
export function normalizeRequestForm(form: RequestForm): RequestFormDraftModel {
  const definition = form.draft.definition
  const target = form.draft.routing.defaultTarget

  return {
    accessMode: form.link.accessMode,
    attachmentPolicy: normalizeAttachmentPolicy(definition.attachments),
    confirmation: { ...definition.confirmation.message },
    consent: {
      privacyUrl: definition.consent?.privacyUrl ?? '',
      required: definition.consent?.required ?? false,
      text: { ...definition.consent?.label },
    },
    defaultLocale: definition.defaultLocale,
    description: { ...definition.description },
    expiresAt: form.link.expiresAt ?? '',
    id: form.id,
    linkToken: form.link.token,
    locales: [...definition.supportedLocales],
    name: form.name,
    redirectUrl: definition.confirmation.redirectUrl ?? '',
    revision: form.revision,
    routing: {
      ...normalizeRoutingTarget(target),
      customFieldMappings: { ...form.draft.routing.mapping.customFieldMappings },
      descriptionFieldIds: [...(form.draft.routing.mapping.descriptionFieldIds ?? [])],
      titleFieldId: form.draft.routing.mapping.titleFieldId,
      rules: form.draft.routing.rules.map((rule) => ({
        condition: normalizeCondition(rule.when) ?? { match: 'all', rules: [] },
        id: rule.id,
        name: rule.name,
        target: normalizeRoutingTarget(rule.target),
      })),
    },
    scope: { ...form.scope },
    sections: definition.sections.map(normalizeSection),
    status: form.status,
    title: { ...definition.title },
    versionNumber: (form.currentPublishedVersion ?? 0) + 1,
  }
}

/**
 * Builder model から新規 form API input を生成します。
 */
export function createRequestFormInput(model: RequestFormDraftModel): CreateRequestFormInput {
  return {
    accessMode: model.accessMode,
    draft: serializeDraft(model),
    expiresAt: model.expiresAt || undefined,
    name: model.name.trim(),
    scope: { ...model.scope },
  }
}

/**
 * Builder model から既存 form 更新 API input を生成します。
 */
export function updateRequestFormInput(model: RequestFormDraftModel): UpdateRequestFormInput {
  return {
    accessMode: model.accessMode,
    draft: serializeDraft(model),
    expectedRevision: model.revision,
    expiresAt: model.expiresAt || null,
    name: model.name.trim(),
    scope: { ...model.scope },
    ...(model.status === 'archived' || model.status === 'draft'
      ? { status: model.status }
      : {}),
  }
}

/**
 * 編集可能なら現在の builder draft を保存し、公開専用なら現在 revision を直接公開します。
 *
 * @param model - 公開対象の builder model です。
 * @param canEdit - Current principal が公開前に draft を更新できるかどうかです。
 * @param persist - 編集可能な場合に draft を保存する callback です。
 * @param publish - Expected revision を使って immutable version を公開する callback です。
 * @param onPublishRejected - 保存後の公開だけが失敗した場合に中間 revision を保持する callback です。
 * @returns 公開後の Request Form です。
 */
export async function persistAndPublishRequestForm(
  model: RequestFormDraftModel,
  canEdit: boolean,
  persist: (input: UpdateRequestFormInput) => Promise<RequestForm>,
  publish: (expectedRevision: number) => Promise<RequestForm>,
  onPublishRejected: (persisted: RequestForm) => void,
) {
  if (!model.id) throw new Error('Request form must be saved before publishing.')
  if (!canEdit) return publish(model.revision)
  const updated = await persist(updateRequestFormInput(model))
  try {
    return await publish(updated.revision)
  } catch (error) {
    onPublishRejected(updated)
    throw error
  }
}

/**
 * RequestSubmission contract を queue/detail model へ変換します。
 */
export function normalizeRequestSubmission(submission: RequestSubmission): RequestSubmissionModel {
  const definition = submission.formSnapshot.snapshot.definition
  const fields = definition.sections.flatMap((section) => section.fields)
  const locale = submission.locale
  const titleAnswer = submission.answers[submission.workItemMapping.titleFieldId]
  const mappedSummary = answerValueToText(titleAnswer).trim()
  const firstAnswer = Object.values(submission.answers).find(
    (value) => typeof value === 'string' && value.trim(),
  )
  const summary = mappedSummary || firstAnswer

  return {
    answers: fields.flatMap((field) => {
      const value = submission.answers[field.id]
      return value === undefined
        ? []
        : [{
            fieldId: field.id,
            label: { ...field.label },
            options: field.options?.map((option) => ({
              id: option.id,
              label: { ...option.label },
            })) ?? [],
            value,
          }]
    }),
    attachments: submission.attachments.map((attachment) => ({ ...attachment })),
    assigneeUserId: submission.triageAssigneeUserId,
    capabilities: { ...submission.capabilities },
    consentAccepted: submission.consent?.accepted ?? false,
    consentText: submission.consent?.label,
    duplicateCandidateIds: [...submission.duplicateCandidateIds],
    events: submission.events.map((event) => ({ ...event })),
    formId: submission.formId,
    formName: definition.title[locale] ?? definition.title[definition.defaultLocale] ?? submission.formId,
    formDefaultLocale: definition.defaultLocale,
    formVersionLabel: `v${submission.formVersion}`,
    id: submission.id,
    messages: submission.messages.map((message) => ({ ...message })),
    receivedAt: submission.createdAt,
    requesterLabel: submission.receiptId,
    revision: submission.revision,
    routing: { ...submission.routingTarget },
    source: submission.source,
    status: submission.status,
    summary: typeof summary === 'string' ? summary : submission.receiptId,
    workItem: submission.workItem
      ? {
          id: submission.workItem.workItemId,
          projectId: submission.workItem.projectId,
          teamId: submission.workItem.teamId,
        }
      : undefined,
  }
}

function answerValueToText(value: RequestAnswerValue | undefined) {
  if (value === undefined) return ''
  if (Array.isArray(value)) return value.join(', ')
  return String(value)
}

/**
 * PublicRequestForm contract を公開 renderer 専用 model へ変換します。
 */
export function normalizePublicRequestForm(form: PublicRequestForm): PublicRequestFormModel {
  const definition = form.definition

  return {
    accessMode: form.accessMode,
    attachmentPolicy: normalizeAttachmentPolicy(definition.attachments),
    confirmation: { ...definition.confirmation.message },
    consent: {
      privacyUrl: definition.consent?.privacyUrl ?? '',
      required: definition.consent?.required ?? false,
      text: { ...definition.consent?.label },
    },
    defaultLocale: definition.defaultLocale,
    description: { ...definition.description },
    formId: form.formId,
    locales: [...definition.supportedLocales],
    minimumSubmitAt: form.submissionSession.minimumSubmitAt,
    redirectUrl: definition.confirmation.redirectUrl,
    sections: definition.sections.map(normalizeSection),
    sessionExpiresAt: form.submissionSession.expiresAt,
    sessionToken: form.submissionSession.token,
    title: { ...definition.title },
    version: form.version,
  }
}

/**
 * 新しい section draft を作成します。
 */
export function createEmptyRequestSection(id: string): RequestBuilderSection {
  return {
    description: { en: '', ja: '' },
    fields: [createEmptyRequestField(`${id}-field-1`)],
    id,
    title: { en: '', ja: '' },
  }
}

/**
 * 新しい field draft を作成します。
 */
export function createEmptyRequestField(id: string): RequestBuilderField {
  return {
    description: { en: '', ja: '' },
    id,
    label: { en: '', ja: '' },
    options: [],
    placeholder: { en: '', ja: '' },
    required: false,
    type: 'text',
  }
}

/**
 * Field type を変更するとき、非対応の options と validation を除去します。
 *
 * @param field - 変更前の field draft です。
 * @param type - 変更後の field type です。
 * @returns 変更後の型で server validation を通過できる field draft です。
 */
export function normalizeRequestBuilderFieldForType(
  field: RequestBuilderField,
  type: RequestBuilderFieldType,
): RequestBuilderField {
  const current = field.validation
  let validation: RequestFieldValidation | undefined

  if (current && ['text', 'textarea', 'email', 'url', 'date'].includes(type)) {
    validation = compactRequestFieldValidation({
      maxLength: current.maxLength,
      minLength: current.minLength,
      pattern: current.pattern,
    })
  } else if (current && type === 'number') {
    validation = compactRequestFieldValidation({
      max: current.max,
      min: current.min,
    })
  }

  return {
    ...field,
    options: type === 'select' || type === 'multi-select' ? field.options : [],
    type,
    validation,
  }
}

function serializeDraft(model: RequestFormDraftModel): RequestFormDraft {
  const description = compactLocalizedText(model.description)
  const consentLabel = compactLocalizedText(model.consent.text)
  const customFieldMappings = Object.fromEntries(
    Object.entries(model.routing.customFieldMappings)
      .map(([fieldId, customFieldId]) => [fieldId, customFieldId.trim()] as const)
      .filter(([, customFieldId]) => Boolean(customFieldId)),
  )

  return {
    definition: {
      ...(model.attachmentPolicy.enabled
        ? {
            attachments: {
              allowedMediaTypes: [...model.attachmentPolicy.allowedContentTypes],
              enabled: true,
              maxFiles: model.attachmentPolicy.maxFiles,
              maxSizeBytes: model.attachmentPolicy.maxSizeBytes,
            },
          }
        : {}),
      confirmation: {
        message: compactLocalizedText(model.confirmation) ?? {},
        redirectUrl: model.redirectUrl || undefined,
      },
      ...(model.consent.required || consentLabel
        ? {
            consent: {
              label: consentLabel ?? {},
              privacyUrl: model.consent.privacyUrl || undefined,
              required: model.consent.required,
            },
          }
        : {}),
      defaultLocale: model.defaultLocale,
      ...(description ? { description } : {}),
      sections: model.sections.map(serializeSection),
      supportedLocales: [...model.locales],
      title: compactLocalizedText(model.title) ?? {},
    },
    routing: {
      defaultTarget: serializeRoutingTarget(model.routing),
      mapping: {
        ...(model.routing.descriptionFieldIds.length > 0
          ? { descriptionFieldIds: [...model.routing.descriptionFieldIds] }
          : {}),
        ...(Object.keys(customFieldMappings).length > 0 ? { customFieldMappings } : {}),
        titleFieldId: model.routing.titleFieldId,
      },
      rules: model.routing.rules.map((rule) => ({
        id: rule.id,
        name: rule.name.trim(),
        target: serializeRoutingTarget(rule.target),
        when: serializeCondition(rule.condition) ?? { conditions: [], mode: 'all' },
      })),
    },
  }
}

/** Conditional visibility を明示する section contract です。 */
type RequestSectionWithCondition = RequestFormSection & {
  /** Section 全体の optional conditional visibility です。 */
  visibleWhen?: RequestFormConditionGroup
}

function normalizeSection(section: RequestSectionWithCondition): RequestBuilderSection {
  return {
    condition: normalizeCondition(section.visibleWhen),
    description: { ...section.description },
    fields: section.fields.map(normalizeField),
    id: section.id,
    title: { ...section.title },
  }
}

function normalizeField(field: RequestFormField): RequestBuilderField {
  return {
    condition: normalizeCondition(field.visibleWhen),
    description: { ...field.helpText },
    id: field.id,
    label: { ...field.label },
    options: field.options?.map((option) => ({ id: option.id, label: { ...option.label } })) ?? [],
    placeholder: { ...field.placeholder },
    required: field.validation?.required ?? false,
    type: toBuilderFieldType(field.type),
    validation: field.validation
      ? {
          max: field.validation.max,
          maxLength: field.validation.maxLength,
          min: field.validation.min,
          minLength: field.validation.minLength,
          pattern: field.validation.pattern,
        }
      : undefined,
  }
}

function serializeSection(section: RequestBuilderSection): RequestSectionWithCondition {
  const description = compactLocalizedText(section.description)

  return {
    ...(description ? { description } : {}),
    fields: section.fields.map(serializeField),
    id: section.id,
    title: compactLocalizedText(section.title) ?? {},
    visibleWhen: serializeCondition(section.condition),
  }
}

function serializeField(field: RequestBuilderField): RequestFormField {
  const normalizedField = normalizeRequestBuilderFieldForType(field, field.type)
  const helpText = compactLocalizedText(normalizedField.description)
  const placeholder = compactLocalizedText(normalizedField.placeholder)

  return {
    ...(helpText ? { helpText } : {}),
    id: normalizedField.id,
    label: compactLocalizedText(normalizedField.label) ?? {},
    options: normalizedField.options.length > 0
      ? normalizedField.options.map((option) => ({
          id: option.id,
          label: compactLocalizedText(option.label) ?? {},
        }))
      : undefined,
    ...(placeholder ? { placeholder } : {}),
    type: toContractFieldType(normalizedField.type),
    validation: {
      ...normalizedField.validation,
      required: normalizedField.required,
    },
    visibleWhen: serializeCondition(normalizedField.condition),
  }
}

function compactRequestFieldValidation(
  validation: RequestFieldValidation,
): RequestFieldValidation | undefined {
  const entries = Object.entries(validation).filter(([, value]) => value !== undefined)
  return entries.length > 0 ? Object.fromEntries(entries) : undefined
}

function normalizeCondition(
  condition: RequestFormConditionGroup | undefined,
): RequestVisibilityCondition | undefined {
  return condition
    ? {
        match: condition.mode,
        rules: condition.conditions.map((rule) => ({ ...rule })),
      }
    : undefined
}

function serializeCondition(
  condition: RequestVisibilityCondition | undefined,
): RequestFormConditionGroup | undefined {
  return condition
    ? {
        conditions: condition.rules.flatMap((rule) =>
          Array.isArray(rule.value) || rule.value === null
            ? []
            : [{ ...rule, value: rule.value }],
        ),
        mode: condition.match,
      }
    : undefined
}

function normalizeAttachmentPolicy(
  policy: PublicRequestForm['definition']['attachments'],
): RequestAttachmentPolicyDraft {
  return {
    allowedContentTypes: [...(policy?.allowedMediaTypes ?? [])],
    enabled: policy?.enabled ?? false,
    maxFiles: policy?.maxFiles ?? 3,
    maxSizeBytes: policy?.maxSizeBytes ?? 10 * 1024 * 1024,
  }
}

function normalizeRoutingTarget(target: RequestFormRoutingTarget): RequestRoutingTargetDraft {
  return {
    assigneeUserId: target.assigneeUserId,
    dueDateOffsetDays: target.dueDateOffsetDays,
    priority: target.priority,
    projectId: target.projectId ?? '',
    teamId: target.teamId,
    workflowStatusId: target.workflowStatusId ?? '',
  }
}

function serializeRoutingTarget(target: RequestRoutingTargetDraft): RequestFormRoutingTarget {
  return {
    assigneeUserId: target.assigneeUserId.trim(),
    dueDateOffsetDays: target.dueDateOffsetDays,
    priority: target.priority,
    projectId: target.projectId || undefined,
    teamId: target.teamId,
    workflowStatusId: target.workflowStatusId || undefined,
  }
}

function compactLocalizedText(text: RequestLocalizedText) {
  const ja = text.ja?.trim()
  const en = text.en?.trim()
  const compact = {
    ...(ja ? { ja } : {}),
    ...(en ? { en } : {}),
  }

  return Object.keys(compact).length > 0 ? compact : undefined
}

function toBuilderFieldType(type: RequestFormFieldType): RequestBuilderFieldType {
  const mapping: Record<RequestFormFieldType, RequestBuilderFieldType> = {
    'short-text': 'text',
    'long-text': 'textarea',
    email: 'email',
    url: 'url',
    number: 'number',
    boolean: 'checkbox',
    date: 'date',
    'single-select': 'select',
    'multi-select': 'multi-select',
    attachment: 'attachment',
  }

  return mapping[type]
}

function toContractFieldType(type: RequestBuilderFieldType): RequestFormFieldType {
  const mapping: Record<RequestBuilderFieldType, RequestFormFieldType> = {
    text: 'short-text',
    textarea: 'long-text',
    email: 'email',
    url: 'url',
    number: 'number',
    checkbox: 'boolean',
    date: 'date',
    select: 'single-select',
    'multi-select': 'multi-select',
    attachment: 'attachment',
  }

  return mapping[type]
}
