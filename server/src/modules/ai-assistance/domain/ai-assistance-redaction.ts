import type {
  AiAssistanceCitation,
  AiAssistanceDraft,
  AiAssistanceUncertainty,
  GenerateAiAssistanceRequest,
} from '@mukuroji/contracts'

const PRIVATE_KEY_PATTERN = /-----BEGIN [^-\r\n]*PRIVATE KEY-----[\s\S]*?-----END [^-\r\n]*PRIVATE KEY-----/giu
const AUTHORIZATION_HEADER_PATTERN = /\b((?:proxy-)?authorization\s*:\s*)(?:[^\r\n]*)/giu
const COOKIE_HEADER_PATTERN = /\b((?:set-cookie|cookie)\s*:)\s*[^\r\n]*/giu
const URL_USERINFO_PATTERN = /\b([A-Za-z][A-Za-z0-9+.-]*:\/\/)(?=[^\s/?#]+@)[^\s/?#]*@(?=[^\s/?#])/gu
const PRESIGNED_URL_QUERY_PATTERN = /([?&](?:x-amz-(?:signature|credential|security-token)|x-goog-(?:signature|credential|security-token)|awsaccesskeyid|googleaccessid|signature|sig)=)(?!\[REDACTED_PRESIGNED_URL\])[^&#\s"'<>]+/giu
const BEARER_PATTERN = /\bBearer\s+[A-Za-z0-9._~+/=-]+/giu
const JWT_PATTERN = /(^|[^A-Za-z0-9_-])(eyJ[A-Za-z0-9_-]{5,}\.[A-Za-z0-9_-]{5,}\.[A-Za-z0-9_-]{5,})(?=$|[^A-Za-z0-9_-])/gu
const AWS_ACCESS_KEY_PATTERN = /\b(?:AKIA|ASIA|AIDA|AROA|AIPA|ANPA|ANVA)[A-Z0-9]{16}\b/gu
const PREFIXED_TOKEN_PATTERN = /\b(?:github_pat_[A-Za-z0-9_]{20,}|gh[pousr]_[A-Za-z0-9]{20,}|xox[baprsce]-[A-Za-z0-9.-]{20,}|xapp-[A-Za-z0-9.-]{20,}|sk-[A-Za-z0-9_-]{16,}|(?:sk|rk)_(?:live|test)_[A-Za-z0-9]{16,}|gsk_[A-Za-z0-9]{20,}|AIza[A-Za-z0-9_-]{35}|npm_[A-Za-z0-9]{20,}|glpat-[A-Za-z0-9_-]{20,}|hf_[A-Za-z0-9]{20,}|SG\.[A-Za-z0-9_-]{16,}\.[A-Za-z0-9_-]{16,})\b/gu
const SECRET_ASSIGNMENT_PATTERN = /(["']?\b(?:password|passwd|api[_-]?key|access[_-]?token|refresh[_-]?token|id[_-]?token|auth[_-]?token|csrf[_-]?token|xsrf[_-]?token|client[_-]?secret|private[_-]?token|aws[_-]?secret[_-]?access[_-]?key|aws[_-]?session[_-]?token|secret[_-]?access[_-]?key|session(?:[_-]?(?:id|token))?|j[_-]?session[_-]?id|php[_-]?sessid|asp\.net[_-]?session[_-]?id|connect\.sid|(?:next-auth|authjs)\.session-token|cookie|secret|token)["']?)(\s*[:=]\s*)(?!\[REDACTED_(?:SECRET|COOKIE|PRESIGNED_URL)\])(?:"((?:\\.|[^"\\])*)"|'((?:\\.|[^'\\])*)'|([^\s,;}\])"'&#]+))/giu
const EMAIL_PATTERN = /\b[A-Z0-9._%+-]+@[A-Z0-9.-]+\.[A-Z]{2,}\b/giu
const JSON_PERSON_IDENTIFIER_PATTERN = /("(?:displayName|fullName|contactName|requesterName|applicantName|personName)"\s*:\s*")(?!\[REDACTED_PERSON\])(?:\\.|[^"\\])*(")/giu
const LABELED_PERSON_PATTERN = /((?:\b(?:full\s+name|contact\s+name|requester\s+name|applicant\s+name|person\s+name)|(?:氏名|お名前|姓名|担当者名|申請者名|連絡先氏名))\s*[：:=])(?!\s*\[REDACTED_PERSON\])(\s*)([^,;|\r\n。]{1,120})/giu
const JAPANESE_SPACED_PERSON_PATTERN = /(?<![\p{L}\p{N}])\p{Script=Han}{1,4}[ \u3000]+\p{Script=Han}{0,3}(?:子|郎|太|美|香|奈|菜|花|華|也|介|助|人|樹|希|恵|愛|優|翔|斗|真|司|一|二|三|雄|夫|明|彩|里|莉|葵|結|衣|音|咲|健|浩|誠|直|亮|大|拓|陸|蓮)(?![\p{L}\p{N}])/gu
const LABELED_PHONE_PATTERN = /((?:\b(?:phone|telephone|mobile|cell|tel(?:ephone)?\s*(?:number)?)|(?:電話番号?|携帯番号?|連絡先電話))\s*[：:=])(?!\s*\[REDACTED_PHONE\])(\s*)([^,;|\r\n。]{3,80})/giu
const INTERNATIONAL_PHONE_PATTERN = /(?<![\dA-Za-z])(?:\+\d{1,3}[\s.-]?)?(?:\(?\d{2,4}\)?[\s.-])\d{2,4}[\s.-]\d{3,4}(?![\dA-Za-z])/gu
const JAPANESE_MOBILE_PHONE_PATTERN = /(?<!\d)0(?:50|70|80|90)\d{8}(?!\d)/gu
const LABELED_ADDRESS_PATTERN = /((?:\b(?:postal\s+address|street\s+address|home\s+address|mailing\s+address|residential\s+address)|(?:住所|所在地|居住地|送付先))\s*[：:=])(?!\s*\[REDACTED_ADDRESS\])(\s*)([^;|\r\n。]{2,180})/giu
const JAPANESE_POSTAL_ADDRESS_PATTERN = /〒\s*\d{3}-?\d{4}(?:\s*[^,;|\r\n。]{0,120})?/gu
const JAPANESE_PREFECTURE_ADDRESS_PATTERN = /(?:東京都|北海道|(?:京都|大阪)府|(?:青森|岩手|宮城|秋田|山形|福島|茨城|栃木|群馬|埼玉|千葉|神奈川|新潟|富山|石川|福井|山梨|長野|岐阜|静岡|愛知|三重|滋賀|兵庫|奈良|和歌山|鳥取|島根|岡山|広島|山口|徳島|香川|愛媛|高知|福岡|佐賀|長崎|熊本|大分|宮崎|鹿児島|沖縄)県)[^,;|\r\n。]{2,120}/gu
const ENGLISH_STREET_ADDRESS_PATTERN = /(?<![\dA-Za-z])\d{1,6}\s+[A-Za-z][A-Za-z0-9 .'-]{1,70}\s(?:Street|St|Road|Rd|Avenue|Ave|Boulevard|Blvd|Lane|Ln|Drive|Dr|Court|Ct)\b(?:[,.]?\s+[A-Za-z][A-Za-z .'-]{1,40})?/giu

/** Exact sensitive identifier replacement used before generic prose redaction. */
export type AiAssistanceTextAlias = {
  /** Canonical identifier that must never reach the model. */
  value: string
  /** Generation-local non-identifying alias. */
  alias: string
  /** Whether a current-authorization disclosure alias is applied after generic redaction. */
  applyAfterRedaction?: boolean
}

/** Request-field metadata used for deterministic field-aware PII masking. */
export type AiAssistancePromptField = {
  /** Stable form-local field identifier. */
  fieldId: string
  /** Localized human-readable field label. */
  label: string
  /** Request Intake field type. */
  fieldType: string | undefined
  /** Validated answer value before model projection. */
  value: unknown
}

/** Deterministic marker used for one semantically sensitive prompt field. */
export type AiAssistanceSensitiveFieldMarker =
  | '[REDACTED_EMAIL]'
  | '[REDACTED_PERSON]'
  | '[REDACTED_PHONE]'
  | '[REDACTED_ADDRESS]'

/** Private member identifiers carrying one resolver-supplied provider-safe alias table. */
export type AiAssistancePrivateIdentifierGroup = {
  /** Canonical active member identifier. */
  memberId: string
  /** Cryptographically random provider-local alias for this resolver pass. */
  providerAlias: string
  /** Current display identifiers associated with the member. */
  identifiers: readonly string[]
}

/**
 * Redacts common credentials, direct identifiers, phone numbers, and postal addresses.
 *
 * @param value - Bounded text that may contain sensitive material.
 * @returns Deterministically redacted text.
 */
export function redactAiAssistanceText(value: string): string {
  return value
    .replace(PRIVATE_KEY_PATTERN, '[REDACTED_PRIVATE_KEY]')
    .replace(AUTHORIZATION_HEADER_PATTERN, (_match, prefix: string) =>
      `${prefix}[REDACTED_TOKEN]`)
    .replace(COOKIE_HEADER_PATTERN, (_match, header: string) =>
      `${header} [REDACTED_COOKIE]`)
    .replace(URL_USERINFO_PATTERN, (_match, scheme: string) =>
      `${scheme}[REDACTED_CREDENTIALS]@`)
    .replace(PRESIGNED_URL_QUERY_PATTERN, (_match, prefix: string) =>
      `${prefix}[REDACTED_PRESIGNED_URL]`)
    .replace(BEARER_PATTERN, 'Bearer [REDACTED_TOKEN]')
    .replace(JWT_PATTERN, (_match, prefix: string) =>
      `${prefix}[REDACTED_JWT]`)
    .replace(AWS_ACCESS_KEY_PATTERN, '[REDACTED_AWS_ACCESS_KEY]')
    .replace(PREFIXED_TOKEN_PATTERN, '[REDACTED_PREFIXED_TOKEN]')
    .replace(
      SECRET_ASSIGNMENT_PATTERN,
      (
        _match,
        label: string,
        separator: string,
        doubleQuotedValue: string | undefined,
        singleQuotedValue: string | undefined,
      ) => {
        const replacement = doubleQuotedValue !== undefined
          ? '"[REDACTED_SECRET]"'
          : singleQuotedValue !== undefined
            ? "'[REDACTED_SECRET]'"
            : '[REDACTED_SECRET]'
        return `${label}${separator}${replacement}`
      },
    )
    .replace(EMAIL_PATTERN, '[REDACTED_EMAIL]')
    .replace(
      JSON_PERSON_IDENTIFIER_PATTERN,
      (_match, prefix: string, suffix: string) =>
        `${prefix}[REDACTED_PERSON]${suffix}`,
    )
    .replace(
      LABELED_PERSON_PATTERN,
      (_match, prefix: string, spacing: string) =>
        `${prefix}${spacing}[REDACTED_PERSON]`,
    )
    .replace(JAPANESE_SPACED_PERSON_PATTERN, '[REDACTED_PERSON]')
    .replace(
      LABELED_PHONE_PATTERN,
      (_match, prefix: string, spacing: string) =>
        `${prefix}${spacing}[REDACTED_PHONE]`,
    )
    .replace(INTERNATIONAL_PHONE_PATTERN, (match) =>
      match.replace(/\D/gu, '').length >= 10 ? '[REDACTED_PHONE]' : match)
    .replace(JAPANESE_MOBILE_PHONE_PATTERN, '[REDACTED_PHONE]')
    .replace(
      LABELED_ADDRESS_PATTERN,
      (_match, prefix: string, spacing: string) =>
        `${prefix}${spacing}[REDACTED_ADDRESS]`,
    )
    .replace(JAPANESE_POSTAL_ADDRESS_PATTERN, '[REDACTED_ADDRESS]')
    .replace(JAPANESE_PREFECTURE_ADDRESS_PATTERN, '[REDACTED_ADDRESS]')
    .replace(ENGLISH_STREET_ADDRESS_PATTERN, '[REDACTED_ADDRESS]')
}

/**
 * Redacts one Request Intake answer using its trusted field metadata before serialization.
 *
 * @param field - Server-owned field descriptor and validated answer value.
 * @returns A value with every classified sensitive scalar deterministically masked.
 */
export function redactAiAssistancePromptFieldValue(
  field: AiAssistancePromptField,
): unknown {
  const marker = classifyAiAssistanceSensitivePromptField(field)
  if (marker !== undefined) {
    if (Array.isArray(field.value)) {
      return field.value.map(() => marker)
    }
    return marker
  }
  if (typeof field.value === 'string') return redactAiAssistanceText(field.value)
  if (Array.isArray(field.value)) {
    return field.value.map((entry) =>
      typeof entry === 'string' ? redactAiAssistanceText(entry) : entry
    )
  }
  return field.value
}

/**
 * Classifies trusted field metadata without inspecting or inferring from its value.
 *
 * Person-typed custom fields are always sensitive. Text and numeric fields are classified by
 * semantic name/identifier tokens so business fields such as Project name remain usable.
 *
 * @param field - Server-owned field identifier, label, and declared type.
 * @returns A deterministic privacy marker, or undefined for a non-sensitive field.
 */
export function classifyAiAssistanceSensitivePromptField(
  field: Pick<AiAssistancePromptField, 'fieldId' | 'label' | 'fieldType'>,
): AiAssistanceSensitiveFieldMarker | undefined {
  if (field.fieldType === 'email') return '[REDACTED_EMAIL]'
  if (field.fieldType === 'person') return '[REDACTED_PERSON]'
  const normalizedLabel = field.label.normalize('NFKC').trim()
  const label = normalizedLabel.toLocaleLowerCase('en-US')
  const semanticLabel = normalizeSensitivePromptFieldLabel(normalizedLabel)
  const fieldId = normalizeSensitivePromptFieldLabel(
    field.fieldId.normalize('NFKC').trim(),
  )
  const semanticCandidates = [semanticLabel, fieldId]
  if (
    /(?:メール|電子メール)/u.test(label) ||
    semanticCandidates.some((candidate) =>
      /(?:^|\s)(?:e\s+mail|email)(?:\s|$)/u.test(candidate)
    )
  ) return '[REDACTED_EMAIL]'
  if (
    /(?:氏名|お名前|姓名|担当者名|申請者名|連絡先氏名)/u.test(label) ||
    semanticCandidates.some((candidate) =>
      /^(?:name|your name|your full name|first name|last name|given name|surname|family name)$/u.test(candidate) ||
      /(?:^|\s)(?:full|contact|requester|applicant|person|customer|employee|user)\s+names?(?:\s|$)/u
        .test(candidate)
    )
  ) return '[REDACTED_PERSON]'
  if (
    /(?:電話|携帯|連絡先電話)/u.test(label) ||
    semanticCandidates.some((candidate) =>
      /(?:^|\s)(?:phone|telephone|mobile|cell|tel)(?:\s|$)/u.test(candidate)
    )
  ) return '[REDACTED_PHONE]'
  if (
    /(?:住所|所在地|居住地|送付先)/u.test(label) ||
    semanticCandidates.some((candidate) =>
      /^(?:address)$/u.test(candidate) ||
      /(?:^|\s)(?:postal|street|home|mailing|residential|customer|contact)\s+address(?:\s|$)/u
        .test(candidate)
    )
  ) return '[REDACTED_ADDRESS]'
  return undefined
}

/**
 * Replaces exact identifier tokens without replacing substrings of larger identifiers.
 *
 * @param value - Permission-filtered source prose.
 * @param aliases - Canonical identifiers and generation-local aliases.
 * @returns Text with exact identifier occurrences replaced.
 */
export function aliasAiAssistanceTextIdentifiers(
  value: string,
  aliases: readonly AiAssistanceTextAlias[],
): string {
  return [...aliases]
    .sort((left, right) => right.value.length - left.value.length)
    .reduce((current, entry) => {
      if (!entry.value) return current
      const escaped = escapeRegularExpression(entry.value)
      const pattern = new RegExp(
        `(^|[^A-Za-z0-9._%+@-])${escaped}(?=$|[^A-Za-z0-9._%+@-])`,
        'gu',
      )
      return current.replace(pattern, (_match, prefix: string) => `${prefix}${entry.alias}`)
    }, value)
}

/**
 * Creates exact replacements from supplied aliases for every member identifier.
 *
 * Duplicate display identifiers map to a redaction marker instead of one member alias.
 *
 * @param members - Complete bounded active-member identifier set for one resolver pass.
 * @returns Exact text aliases safe to apply before prompt truncation.
 */
export function createAiAssistancePrivateTextAliases(
  members: readonly AiAssistancePrivateIdentifierGroup[],
): AiAssistanceTextAlias[] {
  const aliasByMemberId = new Map(
    members.map((member) => [member.memberId, member.providerAlias]),
  )
  const aliasesByIdentifier = new Map<string, Set<string>>()
  for (const member of members) {
    const alias = aliasByMemberId.get(member.memberId)
    if (alias === undefined) continue
    for (const identifier of member.identifiers) {
      const normalized = identifier.trim()
      if (!normalized || normalized === member.memberId) continue
      const aliases = aliasesByIdentifier.get(normalized) ?? new Set<string>()
      aliases.add(alias)
      aliasesByIdentifier.set(normalized, aliases)
    }
  }
  return [
    ...members.map((member) => ({
      value: member.memberId,
      alias: member.providerAlias,
    })),
    ...[...aliasesByIdentifier.entries()]
      .sort(([left], [right]) => left.localeCompare(right))
      .map(([value, aliases]) => ({
        value,
        alias: aliases.size === 1
          ? [...aliases][0] ?? '[REDACTED_PERSON]'
          : '[REDACTED_PERSON]',
      })),
  ]
}

/**
 * Copies a generation request while redacting every operator-controlled prose field.
 *
 * Source identifiers and expected revisions remain unchanged for later authorization checks.
 *
 * @param request - Strictly validated generation request.
 * @param aliases - Private identifiers replaced before generic request redaction.
 * @returns Request safe for model input, audit retention, and authorization rechecks.
 */
export function redactGenerateAiAssistanceRequest(
  request: GenerateAiAssistanceRequest,
  aliases: readonly AiAssistanceTextAlias[] = [],
): GenerateAiAssistanceRequest {
  if (request.task === 'search') {
    return { ...request, query: redactAliasedAiAssistanceText(request.query, aliases) }
  }
  if (request.task === 'summary') {
    return {
      ...request,
      ...(request.focus === undefined
        ? {}
        : { focus: redactAliasedAiAssistanceText(request.focus, aliases) }),
    }
  }
  return {
    ...request,
    ...(request.guidance === undefined
      ? {}
      : { guidance: redactAliasedAiAssistanceText(request.guidance, aliases) }),
  }
}

/**
 * Redacts citation display text while preserving the server-validated identifier and path.
 *
 * @param citation - Permission-safe citation from the source resolver.
 * @param aliases - Provider or post-authorization disclosure aliases for citation prose.
 * @returns Defense-in-depth redacted citation.
 */
export function redactAiAssistanceCitation(
  citation: AiAssistanceCitation,
  aliases: readonly AiAssistanceTextAlias[] = [],
): AiAssistanceCitation {
  return {
    ...citation,
    label: redactAliasedAiAssistanceText(citation.label, aliases),
    ...(citation.excerpt === undefined
      ? {}
      : { excerpt: redactAliasedAiAssistanceText(citation.excerpt, aliases) }),
  }
}

/**
 * Redacts generated prose and replaces model-owned display row identifiers.
 *
 * Canonical allowlisted identifiers and citation IDs remain unchanged.
 *
 * @param draft - Strictly parsed model draft.
 * @param aliases - Provider or post-authorization disclosure aliases for generated prose.
 * @returns Draft with redacted prose and deterministic server-owned row identifiers.
 */
export function redactAiAssistanceDraft(
  draft: AiAssistanceDraft,
  aliases: readonly AiAssistanceTextAlias[] = [],
): AiAssistanceDraft {
  if (draft.kind === 'triage') {
    return {
      ...draft,
      ...(draft.title
        ? { title: redactSuggestedText(draft.title, aliases) }
        : {}),
      ...(draft.description
        ? { description: redactSuggestedText(draft.description, aliases) }
        : {}),
      ...(draft.priority
        ? { priority: redactSuggestedReason(draft.priority, aliases) }
        : {}),
      ...(draft.assigneeUserId
        ? { assigneeUserId: redactSuggestedReason(draft.assigneeUserId, aliases) }
        : {}),
      ...(draft.teamId
        ? { teamId: redactSuggestedReason(draft.teamId, aliases) }
        : {}),
      ...(draft.projectId
        ? { projectId: redactSuggestedReason(draft.projectId, aliases) }
        : {}),
      customFields: draft.customFields.map((field) => ({
        ...field,
        value: redactCustomFieldValue(field.value, aliases),
        reason: redactAliasedAiAssistanceText(field.reason, aliases),
      })),
    }
  }
  if (draft.kind === 'summary') {
    return {
      ...draft,
      overview: {
        ...draft.overview,
        id: 'summary-overview-1',
        text: redactAliasedAiAssistanceText(draft.overview.text, aliases),
      },
      decisions: draft.decisions.map((item, index) => ({
        ...item,
        id: `summary-decision-${index + 1}`,
        text: redactAliasedAiAssistanceText(item.text, aliases),
      })),
      actions: draft.actions.map((item, index) => ({
        ...item,
        id: `summary-action-${index + 1}`,
        text: redactAliasedAiAssistanceText(item.text, aliases),
      })),
      risks: draft.risks.map((item, index) => ({
        ...item,
        id: `summary-risk-${index + 1}`,
        text: redactAliasedAiAssistanceText(item.text, aliases),
      })),
    }
  }
  if (draft.kind === 'search') {
    return {
      ...draft,
      interpretation: redactAliasedAiAssistanceText(draft.interpretation, aliases),
      filters: {
        ...draft.filters,
        ...(draft.filters.keyword === undefined
          ? {}
          : { keyword: redactAliasedAiAssistanceText(draft.filters.keyword, aliases) }),
        customFields: draft.filters.customFields?.map((filter) => ({
          ...filter,
          ...(filter.value === undefined
            ? {}
            : { value: redactCustomFieldValue(filter.value, aliases) }),
        })),
      },
      caveats: draft.caveats.map((caveat) =>
        redactAliasedAiAssistanceText(caveat, aliases)
      ),
    }
  }
  return {
    ...draft,
    ...(draft.title ? { title: redactSuggestedText(draft.title, aliases) } : {}),
    ...(draft.description
      ? { description: redactSuggestedText(draft.description, aliases) }
      : {}),
    ...(draft.priority ? { priority: redactSuggestedReason(draft.priority, aliases) } : {}),
    ...(draft.status ? { status: redactSuggestedReason(draft.status, aliases) } : {}),
    ...(draft.plannedEffortMinutes
      ? {
          plannedEffortMinutes: redactSuggestedReason(
            draft.plannedEffortMinutes,
            aliases,
          ),
        }
      : {}),
    subtasks: draft.subtasks.map((subtask, index) => ({
      ...subtask,
      id: `planning-subtask-${index + 1}`,
      title: redactAliasedAiAssistanceText(subtask.title, aliases),
      ...(subtask.description === undefined
        ? {}
        : { description: redactAliasedAiAssistanceText(subtask.description, aliases) }),
      reason: redactAliasedAiAssistanceText(subtask.reason, aliases),
    })),
    dependencies: draft.dependencies.map((dependency, index) => ({
      ...dependency,
      id: `planning-dependency-${index + 1}`,
      reason: redactAliasedAiAssistanceText(dependency.reason, aliases),
    })),
    ...(draft.statusUpdate === undefined
      ? {}
      : {
          statusUpdate: {
            ...draft.statusUpdate,
            summary: redactAliasedAiAssistanceText(draft.statusUpdate.summary, aliases),
            riskSummary: redactAliasedAiAssistanceText(
              draft.statusUpdate.riskSummary,
              aliases,
            ),
            decisionSummary: redactAliasedAiAssistanceText(
              draft.statusUpdate.decisionSummary,
              aliases,
            ),
            helpNeeded: redactAliasedAiAssistanceText(
              draft.statusUpdate.helpNeeded,
              aliases,
            ),
            nextAction: redactAliasedAiAssistanceText(
              draft.statusUpdate.nextAction,
              aliases,
            ),
          },
        }),
  }
}

/**
 * Redacts the model-generated uncertainty explanation.
 *
 * @param uncertainty - Strictly parsed uncertainty disclosure.
 * @param aliases - Provider or post-authorization disclosure aliases for the rationale.
 * @returns Uncertainty whose prose follows the same privacy boundary as the draft.
 */
export function redactAiAssistanceUncertainty(
  uncertainty: AiAssistanceUncertainty,
  aliases: readonly AiAssistanceTextAlias[] = [],
): AiAssistanceUncertainty {
  return {
    ...uncertainty,
    reason: redactAliasedAiAssistanceText(uncertainty.reason, aliases),
  }
}

/** Redacts one string-valued suggestion and its rationale. */
function redactSuggestedText<Value extends { value: string; reason: string }>(
  suggestion: Value,
  aliases: readonly AiAssistanceTextAlias[],
): Value {
  return {
    ...suggestion,
    value: redactAliasedAiAssistanceText(suggestion.value, aliases),
    reason: redactAliasedAiAssistanceText(suggestion.reason, aliases),
  }
}

/** Redacts only the generated rationale while preserving a canonical typed value. */
function redactSuggestedReason<Value extends { reason: string }>(
  suggestion: Value,
  aliases: readonly AiAssistanceTextAlias[],
): Value {
  return {
    ...suggestion,
    reason: redactAliasedAiAssistanceText(suggestion.reason, aliases),
  }
}

/** Redacts string-bearing custom field values without changing their scalar type. */
function redactCustomFieldValue(
  value: string | number | boolean | string[] | null,
  aliases: readonly AiAssistanceTextAlias[],
): string | number | boolean | string[] | null {
  if (typeof value === 'string') return redactAliasedAiAssistanceText(value, aliases).trim()
  if (Array.isArray(value)) {
    return value.map((entry) => redactAliasedAiAssistanceText(entry, aliases).trim())
  }
  return value
}

/** Applies provider aliases before redaction and authorized disclosure aliases afterward. */
function redactAliasedAiAssistanceText(
  value: string,
  aliases: readonly AiAssistanceTextAlias[],
): string {
  if (
    aliases.length > 0 &&
    aliases.every((entry) => entry.applyAfterRedaction === true)
  ) {
    return aliasAiAssistanceTextIdentifiers(redactAiAssistanceText(value), aliases)
  }
  return redactAiAssistanceText(aliasAiAssistanceTextIdentifiers(value, aliases))
}

/**
 * Removes punctuation and non-semantic form requirement qualifiers from one field label.
 *
 * @param label - NFKC-normalized field label or identifier.
 * @returns Token-normalized label suitable for exact sensitive-field classification.
 */
function normalizeSensitivePromptFieldLabel(label: string): string {
  return label
    .replace(/([a-z0-9])([A-Z])/gu, '$1 $2')
    .replace(/([A-Z])([A-Z][a-z])/gu, '$1 $2')
    .toLocaleLowerCase('en-US')
    .replace(/[\p{P}\p{S}]+/gu, ' ')
    .split(/\s+/u)
    .filter((token) =>
      token.length > 0 &&
      !/^(?:required|optional|mandatory|必須|任意)$/u.test(token)
    )
    .join(' ')
}

/** Escapes an exact identifier before constructing a token-boundary expression. */
function escapeRegularExpression(value: string): string {
  return value.replace(/[.*+?^${}()|[\]\\]/gu, '\\$&')
}
