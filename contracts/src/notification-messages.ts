/** Languages a notification message can be written in. */
export const NOTIFICATION_MESSAGE_LOCALES = ['ja', 'en'] as const

/** One language a notification message can be written in. */
export type NotificationMessageLocale = (typeof NOTIFICATION_MESSAGE_LOCALES)[number]

/**
 * Notification text written by the system, per code and language. `{name}` is replaced with the
 * message parameter of the same name. The English text is also stored as the notification
 * `summary`, so rows written before codes existed and clients that do not know a code still read.
 */
export const NOTIFICATION_MESSAGE_TEMPLATES = {
  'work-item.created-assigned': {
    en: 'Work Item was created and assigned.',
    ja: 'Work Item が作成され、担当に割り当てられました。',
  },
  'work-item.updated': {
    en: 'Work Item was updated.',
    ja: 'Work Item が更新されました。',
  },
  'work-item.archived': {
    en: 'Work Item was archived.',
    ja: 'Work Item がアーカイブされました。',
  },
  'work-item.restored': {
    en: 'Work Item was restored.',
    ja: 'Work Item が元に戻されました。',
  },
  'work-item.assignment-changed': {
    en: 'Work Item assignment changed.',
    ja: 'Work Item の担当が変わりました。',
  },
  'work-item.completed': {
    en: 'Work Item was completed.',
    ja: 'Work Item が完了しました。',
  },
  'work-item.status-changed': {
    en: 'Work Item status changed.',
    ja: 'Work Item の状態が変わりました。',
  },
  'work-item.schedule-changed': {
    en: 'Work Item schedule changed.',
    ja: 'Work Item の日程が変わりました。',
  },
  'work-item.baseline-slip': {
    en: 'Work Item now ends {delayDays} days after its schedule baseline.',
    ja: 'Work Item の終了がベースラインより {delayDays} 日遅れています。',
  },
  'work-item.blocker-removed': {
    en: 'A blocker was removed.',
    ja: 'この Work Item をブロックしていた項目が解除されました。',
  },
  'work-item.due-today': {
    en: 'Work Item "{title}" is due today.',
    ja: '「{title}」の期限は今日です。',
  },
  'work-item.due-soon': {
    en: 'Work Item "{title}" is due on {dueDate}.',
    ja: '「{title}」の期限は {dueDate} です。',
  },
  'work-item.overdue': {
    en: 'Work Item "{title}" is overdue.',
    ja: '「{title}」は期限を過ぎています。',
  },
  'work-item.overdue-reminder': {
    en: 'Work Item "{title}" was due on {dueDate} and is still overdue.',
    ja: '「{title}」は期限の {dueDate} を過ぎたままです。',
  },
  'work-item.overdue-escalation': {
    en: 'Work Item "{title}" was due on {dueDate} and has been overdue for at least {overdueDays} days.',
    ja: '「{title}」は期限の {dueDate} から {overdueDays} 日以上過ぎています。',
  },
  'work-item.stale': {
    en: 'Work Item "{title}" is in progress and has not been updated since {updatedOn}.',
    ja: '「{title}」は着手中のまま {updatedOn} から更新されていません。',
  },
  'timesheet.unsubmitted-one': {
    en: '1 time entry from {date} has not been submitted.',
    ja: '{date} の工数 1 件が提出されていません。',
  },
  'timesheet.unsubmitted-many': {
    en: '{count} time entries since {date} have not been submitted.',
    ja: '{date} 以降の工数 {count} 件が提出されていません。',
  },
  'weekly-report.unsubmitted': {
    en: 'Your weekly report for the week of {weekStart} has not been submitted.',
    ja: '{weekStart} の週の週報が提出されていません。',
  },
  'weekly-report.author-unsubmitted': {
    en: '{author} has not submitted the weekly report for the week of {weekStart}.',
    ja: '{author} さんが {weekStart} の週の週報を提出していません。',
  },
  'weekly-report.member-unsubmitted': {
    en: 'A member has not submitted the weekly report for the week of {weekStart}.',
    ja: '{weekStart} の週の週報を提出していないメンバーがいます。',
  },
  'workspace-member.access-expiring': {
    en: 'Access of {member} ends on {date}. Hand over their work before then.',
    ja: '{member} さんの利用期限は {date} です。それまでに担当を引き継いでください。',
  },
  'workspace-member.access-expiring-unnamed': {
    en: 'A member of your Project loses access on {date}. Hand over their work before then.',
    ja: 'Project のメンバーの利用期限が {date} に切れます。それまでに担当を引き継いでください。',
  },
  'project-budget.threshold-reached': {
    en: 'The Project budget is {percent}% used, reaching its {threshold}% alert.',
    ja: 'Project の予算消化率が {percent}% になり、通知の閾値 {threshold}% に達しました。',
  },
  'planning-update.health-changed': {
    en: 'Health changed to {health}: {excerpt}',
    ja: 'Health が{health}になりました: {excerpt}',
  },
  'planning-update.published': {
    en: 'Health update published ({health}): {excerpt}',
    ja: 'Health update が公開されました（{health}）: {excerpt}',
  },
  'automation.execution-dead-lettered': {
    en: 'Automation rule "{ruleName}" failed and stopped retrying.',
    ja: 'Automation rule「{ruleName}」の実行が失敗し、再試行を止めました。',
  },
  'automation.rule-rate-limited': {
    en: 'Automation rule "{ruleName}" was skipped because it reached its rate limit.',
    ja: 'Automation rule「{ruleName}」が実行回数の上限に達したため、実行を飛ばしました。',
  },
  'analytics.report-delivered': {
    en: 'A scheduled report snapshot is ready.',
    ja: '定期配信のスナップショットができました。',
  },
  'request.more-info-requested': {
    en: 'The team asked a question about your request.',
    ja: '依頼について担当から質問が届きました。',
  },
  'request.rejected': {
    en: 'Your request was declined.',
    ja: '依頼は見送られました。',
  },
  'request.duplicate': {
    en: 'Your request was closed as a duplicate of another request.',
    ja: '依頼は別の依頼と重複として整理されました。',
  },
  'request.accepted': {
    en: 'Your request was accepted as a Work Item.',
    ja: '依頼が受理され、Work Item になりました。',
  },
  'request.completed': {
    en: 'The Work Item for your request was completed.',
    ja: '依頼の Work Item が完了しました。',
  },
} as const satisfies Record<string, Record<NotificationMessageLocale, string>>

/**
 * Japanese words for parameter values that are codes. English keeps the code itself, as the
 * stored summary always has.
 */
const NOTIFICATION_MESSAGE_PARAM_LABELS_JA: Readonly<Record<string, Readonly<Record<string, string>>>> = {
  health: { unknown: '未評価', 'on-track': '順調', 'at-risk': '要注意', 'off-track': '計画外' },
}

/** Code of one system-written notification text. */
export type NotificationMessageCode = keyof typeof NOTIFICATION_MESSAGE_TEMPLATES

/** One value substituted into a notification message. */
export type NotificationMessageParam = string | number

/** A system-written notification text as a code and the values it needs, not as a sentence. */
export type NotificationMessage = {
  /** Which text to show. */
  code: NotificationMessageCode
  /** Values for the text's `{name}` placeholders. */
  params?: Record<string, NotificationMessageParam>
}

/** Largest number of parameters accepted in one stored message. */
const NOTIFICATION_MESSAGE_PARAMS_MAXIMUM = 8

/**
 * Longest parameter value accepted in one stored message, in UTF-16 code units. It holds every
 * value producers copy in, such as a 256-code-point Work Item title or a 500-code-point display
 * name, even when each code point needs two code units.
 */
const NOTIFICATION_MESSAGE_PARAM_MAX_LENGTH = 1_024

/**
 * Builds a notification message.
 *
 * @param code - Which text to show.
 * @param params - Values for the text's placeholders.
 * @returns The message, without `params` when there are none.
 */
export function createNotificationMessage(
  code: NotificationMessageCode,
  params?: Record<string, NotificationMessageParam>,
): NotificationMessage {
  return params && Object.keys(params).length > 0 ? { code, params } : { code }
}

/**
 * Writes a notification message in one language.
 *
 * @param message - Code and parameters.
 * @param locale - Reader's language.
 * @returns The text, with each `{name}` replaced; a placeholder without a value stays as written.
 */
export function formatNotificationMessage(message: NotificationMessage, locale: NotificationMessageLocale): string {
  const template: string = NOTIFICATION_MESSAGE_TEMPLATES[message.code][locale]
  return template.replace(/\{([A-Za-z]+)\}/g, (placeholder, name: string) => {
    const value = message.params?.[name]
    if (value === undefined) return placeholder
    const label = locale === 'ja' ? NOTIFICATION_MESSAGE_PARAM_LABELS_JA[name]?.[String(value)] : undefined
    return label ?? String(value)
  })
}

/**
 * Reports whether a string is a known notification message code.
 *
 * @param value - Candidate code.
 * @returns Whether the code has templates.
 */
export function isNotificationMessageCode(value: unknown): value is NotificationMessageCode {
  return typeof value === 'string' && Object.hasOwn(NOTIFICATION_MESSAGE_TEMPLATES, value)
}

/**
 * Reads a notification message from a stored row or an API response.
 *
 * @param value - Untrusted value.
 * @returns The message, or undefined when the value is absent, malformed, has an unknown code, or
 *   lacks a value its template needs, so the reader falls back to the stored summary text.
 */
export function parseNotificationMessage(value: unknown): NotificationMessage | undefined {
  if (typeof value !== 'object' || value === null || Array.isArray(value)) return undefined
  const code: unknown = Reflect.get(value, 'code')
  if (!isNotificationMessageCode(code)) return undefined
  const storedParams: unknown = Reflect.get(value, 'params')
  const params: unknown = storedParams === undefined ? {} : storedParams
  if (typeof params !== 'object' || params === null || Array.isArray(params)) return undefined
  const entries = Object.entries(params)
  if (entries.length > NOTIFICATION_MESSAGE_PARAMS_MAXIMUM) return undefined
  const parsed: Record<string, NotificationMessageParam> = {}
  for (const [name, param] of entries) {
    if (!/^[A-Za-z]+$/.test(name)) return undefined
    if (typeof param === 'number' ? !Number.isFinite(param) : typeof param !== 'string' || param.length > NOTIFICATION_MESSAGE_PARAM_MAX_LENGTH) {
      return undefined
    }
    parsed[name] = param
  }
  // A template value that is missing would show its placeholder, so the stored text is better.
  const template: string = NOTIFICATION_MESSAGE_TEMPLATES[code].en
  for (const match of template.matchAll(/\{([A-Za-z]+)\}/g)) {
    if (match[1] === undefined || !Object.hasOwn(parsed, match[1])) return undefined
  }
  return createNotificationMessage(code, parsed)
}
