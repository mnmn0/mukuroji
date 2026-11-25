import type { NotificationMessageLocale } from './notification-messages'

/**
 * Labels of the recipient reasons a notification carries, per language. External channels show
 * these instead of the internal reason keys.
 */
export const NOTIFICATION_REASON_LABELS = {
  mention: { en: 'For you', ja: 'あなた宛て' },
  reply: { en: 'Reply', ja: '返信' },
  assignee: { en: 'Assigned', ja: '担当' },
  assignment: { en: 'Assigned', ja: '担当' },
  'triage-assignment': { en: 'Triage assignee', ja: 'Triage 担当' },
  watcher: { en: 'Watching', ja: 'ウォッチ中' },
  'project-watcher': { en: 'Watching the Project', ja: 'Project をウォッチ中' },
  'project-member': { en: 'Project member', ja: 'Project メンバー' },
  'update-author': { en: 'Your update', ja: 'あなたの update' },
  'update-owner': { en: 'Update owner', ja: 'Update 担当' },
  creator: { en: 'You created it', ja: '作成者' },
  escalation: { en: 'Project manager', ja: 'Project マネージャー' },
  'triage-escalation': { en: 'Triage escalation', ja: 'Triage のエスカレーション' },
  'triage-sla': { en: 'Triage SLA', ja: 'Triage の SLA' },
  due: { en: 'Due today', ja: '今日が期限' },
  'due-soon': { en: 'Due soon', ja: '期限間近' },
  overdue: { en: 'Overdue', ja: '期限切れ' },
  stale: { en: 'No recent update', ja: '更新なし' },
  'report-recipient': { en: 'Recipient', ja: '配信先' },
  timesheet: { en: 'Unsubmitted time', ja: '工数の未提出' },
  'weekly-report': { en: 'Unsubmitted weekly report', ja: '週報の未提出' },
  'weekly-report-escalation': { en: 'Member weekly report unsubmitted', ja: 'メンバーの週報が未提出' },
  'approval-requested': { en: 'Approval requested', ja: '承認の依頼' },
  automation: { en: 'Automation', ja: 'Automation' },
} as const satisfies Record<string, Record<NotificationMessageLocale, string>>

/** Reason key that has a translated label. */
export type NotificationReasonLabelKey = keyof typeof NOTIFICATION_REASON_LABELS

/**
 * Reports whether a reason key has a translated label.
 *
 * @param reason - Stored reason key.
 * @returns True when {@link NOTIFICATION_REASON_LABELS} has the key.
 */
function isNotificationReasonLabelKey(reason: string): reason is NotificationReasonLabelKey {
  return Object.hasOwn(NOTIFICATION_REASON_LABELS, reason)
}

/**
 * Writes the reasons of a notification as one line in the reader's language.
 *
 * Unknown keys are left out, so a reason added later never shows its internal key, and reasons
 * with the same label are shown once.
 *
 * @param reasons - Stored reason keys of the notification.
 * @param locale - Reader's language.
 * @returns Labels joined by the language's separator, or an empty string when none is known.
 */
export function formatNotificationReasons(
  reasons: readonly string[],
  locale: NotificationMessageLocale,
): string {
  const labels = new Set<string>()
  for (const reason of reasons) {
    const key = reason.trim().toLowerCase()
    if (isNotificationReasonLabelKey(key)) labels.add(NOTIFICATION_REASON_LABELS[key][locale])
  }
  return [...labels].join(locale === 'ja' ? '、' : ', ')
}
