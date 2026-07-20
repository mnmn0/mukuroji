import type { Locale } from '../../shared/i18n/i18n'
import type { WorkItemExternalLinksLabels } from './WorkItemExternalLinksPanel'

/**
 * External link panel の日本語または英語 label set を作成します。
 *
 * @param locale - 表示 locale です。
 * @returns Panel で使う全表示文言です。
 */
export function createWorkItemExternalLinksLabels(
  locale: Locale,
): WorkItemExternalLinksLabels {
  const ja = locale === 'ja'

  return {
    title: ja ? '外部リンク' : 'External links',
    description: ja
      ? 'Issue、merge request、commit、deploy をこの Work Item と同期します。'
      : 'Synchronize issues, merge requests, commits, and deployments with this Work Item.',
    readOnly: ja ? '参照のみ' : 'Read only',
    loading: ja ? '外部リンクを読み込み中' : 'Loading external links',
    loadError: ja ? '外部リンクを読み込めませんでした。' : 'External links could not be loaded.',
    loadMoreError: ja
      ? '外部リンクの続きを読み込めませんでした。取得済みのリンクはそのまま表示しています。'
      : 'More external links could not be loaded. Previously loaded links are still shown.',
    operationError: ja
      ? '外部リンクの操作を完了できませんでした。入力と接続状態を確認してください。'
      : 'The external link operation could not be completed. Check the input and connection.',
    retry: ja ? '再読み込み' : 'Reload',
    emptyTitle: ja ? '外部 resource はまだありません' : 'No external resources yet',
    emptyDescription: ja
      ? 'Provider の resource を追加すると、進捗と状態をこの Work Item から追跡できます。'
      : 'Add a provider resource to track its progress and state from this Work Item.',
    noInstallationsTitle: ja ? '接続済み account が必要です' : 'A connected account is required',
    noInstallationsDescription: ja
      ? 'Workspace 設定の Developer Platform で provider account を接続してください。'
      : 'Connect a provider account in Developer Platform workspace settings.',
    addLink: ja ? '外部 resource を追加' : 'Add external resource',
    createLink: ja ? 'Link を作成' : 'Create link',
    cancel: ja ? 'キャンセル' : 'Cancel',
    installation: ja ? '接続済み account' : 'Connected account',
    resourceType: ja ? 'Resource 種別' : 'Resource type',
    externalId: 'External ID',
    externalUrl: 'HTTPS URL',
    displayKey: ja ? '表示 key（任意）' : 'Display key (optional)',
    syncDirection: ja ? '同期方向' : 'Sync direction',
    lastSynced: ja ? '最終同期' : 'Last synchronized',
    never: ja ? '未実行' : 'Never',
    unlink: ja ? 'Link を解除' : 'Unlink',
    unlinkConfirm: ja
      ? '{name} の link を解除しますか？同期は停止し、再開には link の再作成が必要です。'
      : 'Unlink {name}? Synchronization will stop and the link must be recreated to resume.',
    reconnectRequired: ja
      ? '同期方向を変更するには、Developer Platform でこの account を再接続してください。'
      : 'Reconnect this account in Developer Platform before changing synchronization.',
    unknownProvider: ja ? '接続情報なし' : 'Connection unavailable',
    loadMore: ja ? 'さらに読み込む' : 'Load more',
    loadingMore: ja ? '読み込み中…' : 'Loading…',
    externalIdPlaceholder: ja ? '例: 12345 または commit SHA' : 'e.g. 12345 or commit SHA',
    externalUrlPlaceholder: 'https://github.com/org/repository/issues/123',
    displayKeyPlaceholder: ja ? '例: GH-123' : 'e.g. GH-123',
    resourceTypeLabels: {
      issue: 'Issue',
      'merge-request': 'Merge request',
      commit: 'Commit',
      deploy: ja ? 'Deploy' : 'Deployment',
    },
    syncDirectionLabels: {
      inbound: 'Provider → mukuroji',
      outbound: 'mukuroji → Provider',
      bidirectional: ja ? '双方向' : 'Bidirectional',
      none: ja ? '一時停止' : 'Paused',
    },
    statusLabels: {
      pending: ja ? '同期待ち' : 'Pending',
      synced: ja ? '同期済み' : 'Synchronized',
      conflict: ja ? '競合あり' : 'Conflict',
      failed: ja ? '同期失敗' : 'Failed',
      paused: ja ? '一時停止' : 'Paused',
    },
  }
}
