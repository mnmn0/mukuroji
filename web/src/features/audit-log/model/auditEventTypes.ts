import type { Locale } from '../../../shared/i18n/i18n'

/** Japanese and English label of one word in an event type. */
type LocalizedWord = {
  /** Japanese label. */
  readonly ja: string
  /** English label. */
  readonly en: string
}

/**
 * Labels of the resource part of an event type, keyed by everything before the last `.`.
 */
const resourceLabels: Readonly<Record<string, LocalizedWord>> = {
  'agent-run': { ja: 'Agent Run', en: 'Agent Run' },
  'agent-settings': { ja: 'Agent 設定', en: 'Agent settings' },
  'ai-assistance.policy': { ja: 'AI 支援のポリシー', en: 'AI assistance policy' },
  'ai-assistance.provider-credential': { ja: 'AI の接続キー', en: 'AI provider key' },
  annotation: { ja: '注記', en: 'Annotation' },
  'api-key': { ja: 'API キー', en: 'API key' },
  approval: { ja: '承認', en: 'Approval' },
  audit: { ja: '監査ログ', en: 'Audit log' },
  automation: { ja: 'Automation', en: 'Automation' },
  'break-glass': { ja: '緊急アクセス', en: 'Break-glass access' },
  'break-glass-account': { ja: '緊急アクセス用アカウント', en: 'Break-glass account' },
  comment: { ja: 'コメント', en: 'Comment' },
  connector: { ja: 'コネクタ', en: 'Connector' },
  'connector.credential': { ja: 'コネクタの認証情報', en: 'Connector credential' },
  'context-item': { ja: 'コンテキスト', en: 'Context item' },
  'credential-policy': { ja: '認証情報のポリシー', en: 'Credential policy' },
  'custom-role': { ja: 'カスタムロール', en: 'Custom role' },
  'directory-group-mapping': { ja: 'グループの対応付け', en: 'Directory group mapping' },
  document: { ja: 'Document', en: 'Document' },
  'document.comment': { ja: 'Document のコメント', en: 'Document comment' },
  'enterprise-security': { ja: 'Enterprise セキュリティ', en: 'Enterprise security' },
  'external-link': { ja: '外部リンク', en: 'External link' },
  file: { ja: 'ファイル', en: 'File' },
  form: { ja: 'フォーム', en: 'Form' },
  'identity-domain': { ja: 'ドメイン', en: 'Identity domain' },
  'identity-provider': { ja: 'ID プロバイダー', en: 'Identity provider' },
  import: { ja: '取り込み', en: 'Import' },
  invitation: { ja: '招待', en: 'Invitation' },
  member: { ja: 'メンバー', en: 'Member' },
  'notification-reminders': { ja: '通知リマインダー', en: 'Notification reminders' },
  'planning-entity': { ja: '計画', en: 'Planning item' },
  'planning-update': { ja: '計画の更新', en: 'Planning update' },
  project: { ja: 'Project', en: 'Project' },
  provisioning: { ja: 'プロビジョニング', en: 'Provisioning' },
  'role-assignment': { ja: 'ロールの割り当て', en: 'Role assignment' },
  'runtime-control': { ja: '稼働モード', en: 'Runtime control' },
  'scim-credential': { ja: 'SCIM の認証情報', en: 'SCIM credential' },
  'scim-group': { ja: 'SCIM グループ', en: 'SCIM group' },
  'scim-user': { ja: 'SCIM ユーザー', en: 'SCIM user' },
  'security-policy': { ja: 'セキュリティポリシー', en: 'Security policy' },
  'service-account': { ja: 'サービスアカウント', en: 'Service account' },
  'service-account-credential': { ja: 'サービスアカウントの認証情報', en: 'Service account credential' },
  'sync-conflict': { ja: '同期の競合', en: 'Sync conflict' },
  'tenant.export': { ja: 'Workspace の export', en: 'Workspace export' },
  'tenant.governance': { ja: 'データ保持の設定', en: 'Data governance' },
  'tenant.profile': { ja: 'Workspace のプロフィール', en: 'Workspace profile' },
  'time-budget': { ja: '工数の予算', en: 'Time budget' },
  'time-entry': { ja: '工数', en: 'Time entry' },
  'time-period': { ja: '工数の締め期間', en: 'Time period' },
  timer: { ja: 'タイマー', en: 'Timer' },
  triage: { ja: 'トリアージ', en: 'Triage' },
  'update-feed': { ja: '更新フィード', en: 'Update feed' },
  watcher: { ja: 'ウォッチ', en: 'Watch' },
  webhook: { ja: 'Webhook', en: 'Webhook' },
  'work-item': { ja: 'Work Item', en: 'Work Item' },
  workflow: { ja: 'Workflow', en: 'Workflow' },
}

/**
 * Labels of the action part of an event type: a Japanese noun and an English past participle.
 */
const actionLabels: Readonly<Record<string, LocalizedWord>> = {
  accepted: { ja: '承諾', en: 'accepted' },
  activated: { ja: '有効化', en: 'activated' },
  'activation-revoked': { ja: '有効化の取り消し', en: 'activation revoked' },
  added: { ja: '追加', en: 'added' },
  applied: { ja: '適用', en: 'applied' },
  archived: { ja: 'アーカイブ', en: 'archived' },
  assigned: { ja: '割り当て', en: 'assigned' },
  attached: { ja: '添付', en: 'attached' },
  authenticated: { ja: '認証', en: 'authenticated' },
  backfilled: { ja: '過去データの補完', en: 'backfilled' },
  'blocker-added': { ja: 'ブロッカーの追加', en: 'blocker added' },
  'blocker-removed': { ja: 'ブロッカーの解除', en: 'blocker removed' },
  'blocking-added': { ja: 'ブロック先の追加', en: 'blocked item added' },
  'blocking-removed': { ja: 'ブロック先の解除', en: 'blocked item removed' },
  cancelled: { ja: '取り消し', en: 'cancelled' },
  'change-completed': { ja: '切り替えの完了', en: 'change completed' },
  'change-failed': { ja: '切り替えの失敗', en: 'change failed' },
  'change-started': { ja: '切り替えの開始', en: 'change started' },
  'child-added': { ja: '子の追加', en: 'child added' },
  'child-removed': { ja: '子の削除', en: 'child removed' },
  closing: { ja: '解約の開始', en: 'closure started' },
  commented: { ja: 'コメント', en: 'commented' },
  completed: { ja: '完了', en: 'completed' },
  created: { ja: '作成', en: 'created' },
  deactivated: { ja: '無効化', en: 'deactivated' },
  decided: { ja: '判断', en: 'decided' },
  deleted: { ja: '削除', en: 'deleted' },
  digest: { ja: 'ダイジェストの送信', en: 'digest sent' },
  'directory-deprovisioned': { ja: 'ディレクトリによる削除', en: 'deprovisioned by directory' },
  'directory-reactivated': { ja: 'ディレクトリによる再開', en: 'reactivated by directory' },
  'directory-reconciled': { ja: 'ディレクトリとの照合', en: 'reconciled with directory' },
  'directory-provisioned': { ja: 'ディレクトリによる追加', en: 'provisioned by directory' },
  edited: { ja: '編集', en: 'edited' },
  downloaded: { ja: 'ダウンロード', en: 'downloaded' },
  'enforcement-updated': { ja: '強制設定の変更', en: 'enforcement updated' },
  'export-downloaded': { ja: 'export のダウンロード', en: 'export downloaded' },
  'export-requested': { ja: 'export の依頼', en: 'export requested' },
  exported: { ja: 'export', en: 'exported' },
  failed: { ja: '失敗', en: 'failed' },
  installed: { ja: '導入', en: 'installed' },
  issued: { ja: '発行', en: 'issued' },
  'mfa-reset': { ja: '認証アプリのリセット', en: 'MFA reset' },
  moved: { ja: '移動', en: 'moved' },
  'owner-reconciled': { ja: 'オーナーの照合', en: 'owner reconciled' },
  'parent-changed': { ja: '親の変更', en: 'parent changed' },
  'password-reset-requested': { ja: 'パスワード再設定の依頼', en: 'password reset requested' },
  previewed: { ja: 'プレビュー', en: 'previewed' },
  reactivated: { ja: '利用再開', en: 'reactivated' },
  received: { ja: '受信', en: 'received' },
  reconciled: { ja: '照合', en: 'reconciled' },
  'relation-added': { ja: '関連の追加', en: 'relation added' },
  'relation-removed': { ja: '関連の削除', en: 'relation removed' },
  rejected: { ja: '却下', en: 'rejected' },
  removed: { ja: '除外', en: 'removed' },
  renamed: { ja: '名前の変更', en: 'renamed' },
  reordered: { ja: '並べ替え', en: 'reordered' },
  replaced: { ja: '置き換え', en: 'replaced' },
  reopened: { ja: '再開', en: 'reopened' },
  replied: { ja: '返信', en: 'replied' },
  'request-rejected': { ja: '要求の拒否', en: 'request rejected' },
  requested: { ja: '依頼', en: 'requested' },
  resolved: { ja: '解決', en: 'resolved' },
  restored: { ja: '復元', en: 'restored' },
  retried: { ja: '再試行', en: 'retried' },
  revoked: { ja: '失効', en: 'revoked' },
  'role-changed': { ja: 'ロールの変更', en: 'role changed' },
  rotated: { ja: 'ローテーション', en: 'rotated' },
  schedule: { ja: 'スケジュール実行', en: 'scheduled run' },
  'schedule-cascade-updated': { ja: '日程の連動更新', en: 'schedule cascaded' },
  'sibling-order-changed': { ja: '並び順の変更', en: 'sibling order changed' },
  started: { ja: '開始', en: 'started' },
  submitted: { ja: '送信', en: 'submitted' },
  subscribed: { ja: 'ウォッチ開始', en: 'subscribed' },
  superseded: { ja: '置き換え', en: 'superseded' },
  unsubscribed: { ja: 'ウォッチ解除', en: 'unsubscribed' },
  updated: { ja: '更新', en: 'updated' },
  'upload-completed': { ja: 'アップロードの完了', en: 'upload completed' },
  'version-created': { ja: '新しい版の作成', en: 'version created' },
  viewed: { ja: '閲覧', en: 'viewed' },
}

/**
 * Event types offered as search suggestions, grouped by the resource they belong to.
 *
 * The audit log can hold other types too, which the search still accepts as typed.
 */
export const suggestedAuditEventTypes: readonly string[] = [
  'work-item.created',
  'work-item.updated',
  'work-item.deleted',
  'work-item.parent-changed',
  'comment.created',
  'comment.edited',
  'comment.deleted',
  'member.created',
  'member.role-changed',
  'member.removed',
  'invitation.created',
  'invitation.revoked',
  'invitation.accepted',
  'role-assignment.created',
  'role-assignment.deleted',
  'custom-role.updated',
  'project.created',
  'project.updated',
  'project.renamed',
  'project.archived',
  'project.restored',
  'file.created',
  'file.deleted',
  'approval.requested',
  'approval.rejected',
  'api-key.created',
  'api-key.rotated',
  'api-key.revoked',
  'service-account.created',
  'service-account.revoked',
  'connector.installed',
  'external-link.created',
  'security-policy.updated',
  'identity-provider.updated',
  'break-glass.activated',
  'tenant.profile.updated',
  'tenant.governance.updated',
  'ai-assistance.policy.updated',
  'runtime-control.change-completed',
  'audit.viewed',
  'audit.export-requested',
  'audit.export-downloaded',
]

/**
 * Resource types offered by the target filter, as stored in `target.type`.
 */
export const suggestedAuditTargetTypes: readonly string[] = [
  'work-item',
  'comment',
  'member',
  'invitation',
  'project',
  'workflow',
  'file',
  'approval',
  'document',
  'audit-log',
]

/**
 * Builds the display label of an event type, such as `Work Item の更新` or `Work Item updated`.
 *
 * The resource is everything before the last `.` and the action is what follows it.
 * An unknown action keeps its raw name after the resource label, and an unknown resource
 * returns the raw event type, so a new event type still reads as itself.
 *
 * @param eventType - Event type recorded by the server.
 * @param locale - Display locale.
 * @returns The localized label.
 */
export function formatAuditEventType(eventType: string, locale: Locale): string {
  const separator = eventType.lastIndexOf('.')
  if (separator <= 0) return eventType
  const resource = resourceLabels[eventType.slice(0, separator)]
  if (!resource) return eventType
  const actionName = eventType.slice(separator + 1)
  const action = actionLabels[actionName]
  // A Latin word such as `Work Item` keeps a space before the particle, as the Japanese copy does.
  const particle = /[A-Za-z0-9]$/u.test(resource.ja) ? ' の' : 'の'
  if (locale === 'ja') return action ? `${resource.ja}${particle}${action.ja}` : `${resource.ja}: ${actionName}`
  return action ? `${resource.en} ${action.en}` : `${resource.en}: ${actionName}`
}

/**
 * Builds the display label of a resource type such as `work-item`.
 *
 * @param resourceType - Resource type recorded by the server.
 * @param locale - Display locale.
 * @returns The localized label, or the raw type when it is unknown.
 */
export function formatAuditResourceType(resourceType: string, locale: Locale): string {
  if (resourceType === 'audit-log') return locale === 'ja' ? '監査ログ' : 'Audit log'
  return resourceLabels[resourceType]?.[locale] ?? resourceType
}
