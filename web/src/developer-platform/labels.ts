import type { Locale } from '../i18n'
import type { DeveloperPlatformLabels } from './DeveloperPlatformPanel'

/**
 * Developer Platform panel の日本語または英語 label set を作成します。
 *
 * @param locale - 表示する Workspace locale です。
 * @returns Panel、form、status、scope、event、connector catalog の全表示文言です。
 */
export function createDeveloperPlatformLabels(
  locale: Locale,
): DeveloperPlatformLabels {
  const ja = locale === 'ja'

  return {
    eyebrow: ja ? '開発者プラットフォーム' : 'Developer platform',
    title: ja ? 'API と外部連携' : 'API & integrations',
    description: ja
      ? '認証情報、署名付き webhook、外部 connector、Work Item の安全な移行を管理します。'
      : 'Manage credentials, signed webhooks, external connectors, and safe Work Item transfers.',
    readOnly: ja ? '参照のみ' : 'Read only',
    loading: ja
      ? '開発者プラットフォームを読み込み中'
      : 'Loading developer platform',
    loadError: ja
      ? '開発者プラットフォームの設定を読み込めませんでした。'
      : 'Developer platform settings could not be loaded.',
    operationError: ja
      ? '操作を完了できませんでした。入力を確認して再度お試しください。'
      : 'The operation could not be completed. Review the input and try again.',
    retry: ja ? '再試行' : 'Try again',
    tabs: {
      credentials: ja ? '認証情報' : 'Credentials',
      webhooks: ja ? 'Webhook' : 'Webhooks',
      connectors: ja ? 'Connector' : 'Connectors',
      imports: ja ? 'Import / Export' : 'Import & export',
    },
    statusLabels: {
      active: ja ? '有効' : 'Active',
      cancelled: ja ? 'キャンセル済み' : 'Cancelled',
      completed: ja ? '完了' : 'Completed',
      conflict: ja ? '競合あり' : 'Conflict',
      connected: ja ? '接続済み' : 'Connected',
      degraded: ja ? '一部障害' : 'Degraded',
      delivered: ja ? '配信済み' : 'Delivered',
      disabled: ja ? '無効' : 'Disabled',
      disconnected: ja ? '切断済み' : 'Disconnected',
      expired: ja ? '期限切れ' : 'Expired',
      failed: ja ? '失敗' : 'Failed',
      ignored: ja ? '無視' : 'Ignored',
      open: ja ? '未解決' : 'Open',
      paused: ja ? '一時停止' : 'Paused',
      pending: ja ? '保留中' : 'Pending',
      queued: ja ? '待機中' : 'Queued',
      retrying: ja ? '再試行中' : 'Retrying',
      resolved: ja ? '解決済み' : 'Resolved',
      revoked: ja ? '失効済み' : 'Revoked',
      running: ja ? '実行中' : 'Running',
      validating: ja ? '検証中' : 'Validating',
      'needs-reauth': ja ? '再認証が必要' : 'Needs reauthorization',
    },
    scopeOptions: [
      {
        value: 'work-items:read',
        label: ja ? 'Work Item の参照' : 'Read Work Items',
        description: ja
          ? '認証情報の所有者がアクセスできる Work Item を参照します。'
          : 'Read Work Items that the credential owner can access.',
      },
      {
        value: 'work-items:write',
        label: ja ? 'Work Item の更新' : 'Write Work Items',
        description: ja
          ? 'アクセス可能な Work Item を作成・更新します。'
          : 'Create and update accessible Work Items.',
      },
      {
        value: 'work-items:delete',
        label: ja ? 'Work Item の削除' : 'Delete Work Items',
        description: ja
          ? 'アクセス可能な Work Item を削除します。'
          : 'Delete accessible Work Items.',
      },
      {
        value: 'webhooks:read',
        label: ja ? 'Webhook の参照' : 'Read webhooks',
        description: ja
          ? '購読設定と配信 log を参照します。'
          : 'Inspect subscriptions and delivery logs.',
      },
      {
        value: 'webhooks:write',
        label: ja ? 'Webhook の管理' : 'Manage webhooks',
        description: ja
          ? '購読設定の作成と配信の再送を行います。'
          : 'Create subscriptions and replay deliveries.',
      },
      {
        value: 'integrations:read',
        label: ja ? '外部連携の参照' : 'Read integrations',
        description: ja
          ? 'Connector と外部 link を参照します。'
          : 'Inspect connector installations and external links.',
      },
      {
        value: 'integrations:write',
        label: ja ? '外部連携の管理' : 'Manage integrations',
        description: ja
          ? 'Provider の接続と同期競合の解決を行います。'
          : 'Connect providers and resolve synchronization conflicts.',
      },
      {
        value: 'imports:read',
        label: ja ? '移行履歴の参照' : 'Read transfers',
        description: ja
          ? 'Import / Export job を参照します。'
          : 'Inspect import and export jobs.',
      },
      {
        value: 'imports:write',
        label: ja ? '移行の実行' : 'Run transfers',
        description: ja
          ? 'Work Item import の dry-run と確定を実行します。'
          : 'Dry-run and commit Work Item imports.',
      },
    ],
    grantTypeOptions: [
      {
        value: 'client_credentials',
        label: ja ? 'Client credentials' : 'Client credentials',
        description: ja
          ? '信頼済み server 間の自動化を実行します。'
          : 'Run trusted server-to-server automation.',
      },
    ],
    webhookEventOptions: [
      {
        value: 'work-item.created',
        label: ja ? 'Work Item 作成' : 'Work Item created',
        description: ja
          ? 'Work Item が作成されたとき。'
          : 'A Work Item was created.',
      },
      {
        value: 'work-item.updated',
        label: ja ? 'Work Item 更新' : 'Work Item updated',
        description: ja
          ? 'Field または workflow 状態が変わったとき。'
          : 'Fields or workflow state changed.',
      },
      {
        value: 'work-item.deleted',
        label: ja ? 'Work Item 削除' : 'Work Item deleted',
        description: ja
          ? 'Work Item が削除されたとき。'
          : 'A Work Item was deleted.',
      },
      {
        value: 'external-link.created',
        label: ja ? '外部 link 作成' : 'External link created',
        description: ja
          ? '外部 resource への link が作成されたとき。'
          : 'An external resource link was created.',
      },
      {
        value: 'external-link.updated',
        label: ja ? '外部 link 更新' : 'External link updated',
        description: ja
          ? 'Link 先の provider resource が変わったとき。'
          : 'A linked provider resource changed.',
      },
      {
        value: 'sync-conflict.created',
        label: ja ? '同期競合の検出' : 'Sync conflict created',
        description: ja
          ? '双方向同期に判断が必要になったとき。'
          : 'Bidirectional synchronization needs a decision.',
      },
      {
        value: 'sync-conflict.resolved',
        label: ja ? '同期競合の解決' : 'Sync conflict resolved',
        description: ja
          ? '同期競合が解決されたとき。'
          : 'A synchronization conflict was resolved.',
      },
      {
        value: 'import.completed',
        label: ja ? 'Import 完了' : 'Import completed',
        description: ja
          ? '確定した import が完了したとき。'
          : 'A committed import finished.',
      },
      {
        value: 'import.failed',
        label: ja ? 'Import 失敗' : 'Import failed',
        description: ja
          ? 'Import が error で停止したとき。'
          : 'An import stopped with an error.',
      },
    ],
    connectorCatalog: [
      {
        provider: 'github',
        name: 'GitHub',
        description: ja
          ? 'Repository、issue、pull request、commit、deploy を対応付けます。'
          : 'Map repositories, issues, pull requests, commits, and deployments.',
        categoryLabel: ja ? 'Source control' : 'Source control',
        scopes: ['repo:read', 'issues:write'],
        searchTerms: ['repository', 'issue', 'pull request', 'commit', 'deploy'],
      },
      {
        provider: 'slack',
        name: 'Slack',
        description: ja
          ? 'Project の更新や会話を channel と連携します。'
          : 'Route project updates and actionable conversations to channels.',
        categoryLabel: ja ? 'Chat' : 'Chat',
        scopes: ['channels:read', 'chat:write'],
        searchTerms: ['workspace', 'channel', 'message'],
      },
      {
        provider: 'gmail',
        name: 'Gmail',
        description: ja
          ? 'Message と email thread を Work Item に link します。'
          : 'Link messages and email threads to Work Items.',
        categoryLabel: ja ? 'Email' : 'Email',
        scopes: ['mail:read', 'mail:link'],
        searchTerms: ['mailbox', 'message', 'thread'],
      },
      {
        provider: 'google-calendar',
        name: 'Google Calendar',
        description: ja
          ? 'Calendar と event を milestone や期日に対応付けます。'
          : 'Map calendars and events to milestones and delivery dates.',
        categoryLabel: ja ? 'Calendar' : 'Calendar',
        scopes: ['calendar:read', 'events:link'],
        searchTerms: ['calendar', 'event', 'meeting'],
      },
      {
        provider: 'google-drive',
        name: 'Google Drive',
        description: ja
          ? '共有 drive と folder を project file に対応付けます。'
          : 'Map shared drives and folders to project files.',
        categoryLabel: ja ? 'Cloud storage' : 'Cloud storage',
        scopes: ['drive:read', 'files:link'],
        searchTerms: ['drive', 'folder', 'file'],
      },
    ],
    importFieldOptions: [
      {
        value: 'title',
        label: ja ? 'タイトル' : 'Title',
        description: ja
          ? '必須の Work Item タイトルです。'
          : 'Required Work Item title.',
      },
      {
        value: 'description',
        label: ja ? '説明' : 'Description',
        description: ja
          ? 'Markdown 形式の説明です。'
          : 'Markdown Work Item description.',
      },
      {
        value: 'status',
        label: ja ? 'ステータス' : 'Status',
        description: ja
          ? '設定済み workflow の状態です。'
          : 'Configured workflow state.',
      },
      {
        value: 'priority',
        label: ja ? '優先度' : 'Priority',
        description: ja
          ? '設定済みの優先度です。'
          : 'Configured priority value.',
      },
      {
        value: 'assignee',
        label: ja ? '担当者' : 'Assignee',
        description: ja
          ? 'Workspace member の識別子です。'
          : 'Workspace member identifier.',
      },
    ],
    tableHeaders: {
      account: ja ? 'Account' : 'Account',
      actions: ja ? '操作' : 'Actions',
      attempts: ja ? '試行回数' : 'Attempts',
      created: ja ? '作成日時' : 'Created',
      creator: ja ? '作成者' : 'Creator',
      event: ja ? 'Event' : 'Event',
      expiry: ja ? '有効期限' : 'Expiry',
      failures: ja ? '連続失敗' : 'Consecutive failures',
      fingerprint: ja ? 'Key fingerprint' : 'Key fingerprint',
      lastDelivery: ja ? '最終配信' : 'Last delivery',
      lastSync: ja ? '最終同期' : 'Last sync',
      lastUsed: ja ? '最終利用' : 'Last used',
      name: ja ? '名前' : 'Name',
      response: ja ? 'Response' : 'Response',
      row: ja ? '行' : 'Row',
      scopes: ja ? 'Scope' : 'Scopes',
      status: ja ? '状態' : 'Status',
      updated: ja ? '更新日時' : 'Updated',
    },
    actions: {
      addAccount: ja ? 'Account を追加' : 'Add account',
      addMapping: ja ? 'Mapping を追加' : 'Add mapping',
      cancel: ja ? 'キャンセル' : 'Cancel',
      commitImport: ja ? 'Import を確定' : 'Commit import',
      connect: ja ? '接続' : 'Connect',
      connectAgain: ja ? '新しく再接続' : 'Connect again',
      chooseResolution: ja ? '解決方法を選択' : 'Choose a resolution',
      createApiKey: ja ? 'API key を作成' : 'Create API key',
      createOAuthApp: ja ? 'OAuth app を登録' : 'Register OAuth app',
      createWebhook: ja ? 'Webhook を追加' : 'Add webhook',
      disconnect: ja ? '切断' : 'Disconnect',
      dryRun: ja ? '検証を実行' : 'Run validation',
      'export-csv': ja ? 'CSV を export' : 'Export CSV',
      'export-json': ja ? 'JSON を export' : 'Export JSON',
      'keep-local': ja ? 'mukuroji を採用' : 'Keep mukuroji',
      'keep-remote': ja ? 'Provider を採用' : 'Keep provider',
      ignore: ja ? 'この競合を無視' : 'Ignore this conflict',
      loadMore: ja ? 'さらに読み込む' : 'Load more',
      loadingMore: ja ? '読み込み中…' : 'Loading…',
      merge: ja ? 'Field ごとに統合' : 'Merge fields',
      reauthorize: ja ? '再接続' : 'Reconnect',
      removeMapping: ja ? '削除' : 'Remove',
      replay: ja ? '再送' : 'Replay',
      resolve: ja ? '競合を解決' : 'Resolve conflict',
      revoke: ja ? '失効' : 'Revoke',
      rotate: ja ? 'Secret を rotation' : 'Rotate secret',
      'submit-api-key': ja ? 'API key を作成' : 'Create API key',
      'submit-oauth-app': ja ? 'App を登録' : 'Register app',
      'submit-webhook': ja ? 'Webhook を作成' : 'Create webhook',
    },
    fields: {
      conflictResolution: ja ? '解決方法' : 'Resolution',
      detectedAt: ja ? '検出日時' : 'Detected',
      events: ja ? 'Event' : 'Events',
      expiry: ja ? '有効期限' : 'Expiry date',
      grantTypes: ja ? 'Grant type' : 'Grant types',
      externalLink: ja ? 'External link' : 'External link',
      externalRevision: ja ? 'Provider revision' : 'Provider revision',
      externalValue: ja ? 'Provider の値' : 'Provider value',
      importFile: ja ? '移行元 file' : 'Source file',
      importProject: ja ? '既定 Project' : 'Default project',
      importTeam: ja ? '移行先 Team' : 'Destination team',
      localRevision: ja ? 'mukuroji revision' : 'mukuroji revision',
      localValue: ja ? 'mukuroji の値' : 'mukuroji value',
      mergedValues: ja ? '統合後の JSON value' : 'Merged JSON values',
      name: ja ? '名前' : 'Name',
      resourceSearch: ja
        ? 'Resource mapping を検索'
        : 'Search resource mappings',
      revisions: ja ? 'Revision' : 'Revisions',
      scopes: ja ? 'Scope' : 'Scopes',
      sourceField: ja ? '移行元 field' : 'Source field',
      targetField: ja ? 'Work Item field' : 'Work Item field',
      url: ja ? 'Endpoint URL' : 'Endpoint URL',
      webhookTeams: ja ? '配信を許可する Team' : 'Allowed teams',
      workItem: 'Work Item',
    },
    placeholders: {
      apiKeyName: ja ? '本番環境の自動化' : 'Production automation',
      importProject: ja ? '既定 Project なし' : 'No default project',
      oauthName: ja ? '集計連携' : 'Reporting integration',
      resourceSearch: ja
        ? 'Repository、channel、calendar、folder を検索…'
        : 'Search repositories, channels, calendars, folders…',
      sourceField: ja
        ? 'CSV header または JSON path'
        : 'CSV header or JSON path',
      targetField: ja
        ? 'Work Item field を選択'
        : 'Choose a Work Item field',
      webhookName: ja ? '本番 event 受信先' : 'Production event sink',
      webhookUrl: 'https://example.com/webhooks/mukuroji',
    },
    headings: {
      apiKeys: 'API keys',
      apiKeysEmpty: ja ? 'API key はまだありません' : 'No API keys yet',
      connectors: ja ? 'Connector catalog' : 'Connector catalog',
      connectorSearchEmpty: ja
        ? '一致する resource がありません'
        : 'No matching resources',
      'create-api-key': ja ? 'API key を作成' : 'Create an API key',
      'create-oauth-app': ja ? 'OAuth app を登録' : 'Register an OAuth app',
      'create-webhook': ja
        ? '署名付き webhook を作成'
        : 'Create a signed webhook',
      deliveries: ja ? '配信 log' : 'Delivery log',
      deliveriesEmpty: ja ? '配信履歴はまだありません' : 'No deliveries yet',
      exports: ja ? 'Work Item を export' : 'Export Work Items',
      importReport: ja ? 'Dry-run report' : 'Dry-run report',
      imports: ja ? 'Work Item を import' : 'Import Work Items',
      mapping: ja ? 'Field mapping' : 'Field mapping',
      oauthApps: 'OAuth apps',
      oauthAppsEmpty: ja ? 'OAuth app はまだありません' : 'No OAuth apps yet',
      'source-csv': 'CSV file',
      'source-json': 'JSON file',
      syncConflicts: ja ? '同期競合' : 'Sync conflicts',
      syncConflictsEmpty: ja ? '未解決の同期競合はありません' : 'No sync conflicts',
      webhooks: ja ? 'Webhook 購読' : 'Webhook subscriptions',
      webhooksEmpty: ja
        ? 'Webhook 購読はまだありません'
        : 'No webhook subscriptions yet',
    },
    helpText: {
      apiKeys: ja
        ? '自動化ごとに名前と最小 scope を付けます。完全な key はこの一覧に表示しません。'
        : 'Use a named, scoped key for each automation. The complete key is never shown in this ledger.',
      apiKeysEmpty: ja
        ? '最初の server-side 連携用に最小 scope の key を作成します。'
        : 'Create a narrowly scoped key for your first server-side integration.',
      connectorConflict: ja
        ? '同期は一時停止中です。上の同期競合一覧から差分を確認して復旧してください。'
        : 'Synchronization is paused. Review the field differences in the sync conflict list above to recover it.',
      connectorCount: ja ? '{count} account' : '{count} accounts',
      connectors: ja
        ? 'Provider と mapping 対象を検索し、接続または復旧します。'
        : 'Search providers and the resources they map, then connect or recover an installation.',
      connectorSearchEmpty: ja
        ? 'Provider 名、repository、channel、calendar、folder などで検索してください。'
        : 'Try a provider name or resource such as repository, channel, calendar, or folder.',
      disconnectConfirm: ja
        ? '{name} を切断しますか？関連する外部 link の同期は一時停止します。'
        : 'Disconnect {name}? Synchronization for its external links will be paused.',
      conflictResolveConfirm: ja
        ? '「{resolution}」で Work Item {workItem} の競合を解決しますか？この操作は同期先の値を変更する可能性があります。'
        : 'Resolve the conflict for Work Item {workItem} using “{resolution}”? This may change synchronized values.',
      'create-api-key': ja
        ? 'この自動化に必要な権限だけを選びます。後から rotation または失効できます。'
        : 'Choose only the permissions this automation needs. You can rotate or revoke it later.',
      'create-oauth-app': ja
        ? 'Server 間連携に必要な最小限の scope と有効期限を設定します。'
        : 'Choose the smallest scopes and an expiry for this server-to-server client.',
      'create-webhook': ja
        ? '配信 URL と必要な event だけを選びます。'
        : 'Choose a delivery URL and the events it should receive.',
      deliveries: ja
        ? '各試行を監査でき、失敗した配信は event を増やさず再送できます。'
        : 'Each attempt is auditable. Failed deliveries can be replayed without creating another event.',
      deliveriesEmpty: ja
        ? '購読した event が発生すると配信履歴が表示されます。'
        : 'Delivery attempts appear after a subscribed event occurs.',
      exports: ja
        ? 'UI と同じ権限モデルでアクセス可能な Work Item を download します。'
        : 'Download the Work Items you can access using the same permission model as the UI.',
      importPending: ja ? 'Import を準備しています。' : 'The import is still being prepared.',
      importReadOnly: ja
        ? '過去の job は参照できますが、この role では import を開始できません。'
        : 'You can review prior jobs, but your role cannot start an import.',
      importReport: ja
        ? 'すべての行が検証を通過した場合だけ確定できます。'
        : 'Commit is enabled only after every row passes validation.',
      imports: ja
        ? 'Source を選択し、field を mapping して全行を検証した後に確定します。'
        : 'Choose a source, map fields, validate every row, then explicitly commit.',
      installedConnector: ja
        ? 'Workspace に登録済みの provider account と同期状態です。'
        : 'Provider accounts installed in this Workspace and their synchronization state.',
      mapping: ja
        ? 'Source header または JSON path を標準 / custom field に対応付けます。'
        : 'Map source headers or JSON paths to canonical or custom Work Item fields.',
      mergedValues: ja
        ? '各 field に採用する値を JSON として入力します。文字列は二重引用符で囲んでください。'
        : 'Enter the chosen value for each field as JSON. Wrap string values in double quotes.',
      mergeInvalid: ja
        ? '統合後の値に無効な JSON があります。入力を確認してください。'
        : 'A merged value contains invalid JSON. Review the input.',
      never: ja ? '未使用' : 'Never',
      noConnectorAccounts: ja
        ? 'この provider に接続済み account はありません。'
        : 'No accounts have been connected for this provider.',
      noExpiry: ja ? '期限なし' : 'No expiry',
      noFile: ja ? 'File が選択されていません' : 'No file selected',
      notAvailable: ja ? '情報なし' : 'Not available',
      oauthApps: ja
        ? 'OAuth app は client credentials grant で server 間 access を提供します。'
        : 'OAuth apps provide server-to-server access with the client credentials grant.',
      oauthAppsEmpty: ja
        ? 'OAuth 認可が必要な連携用に app を登録します。'
        : 'Register an app when an integration needs OAuth authorization.',
      pending: ja ? '保留中' : 'Pending',
      revokeConfirm: ja
        ? 'この認証情報を失効しますか？利用中の連携は直ちに停止する可能性があります。'
        : 'Revoke this credential? Integrations using it may stop immediately.',
      secretCopyError: ja
        ? 'Clipboard へコピーできませんでした。値を選択して手動でコピーしてください。'
        : 'The secret could not be copied to the clipboard. Select the value and copy it manually.',
      selectionRequired: ja
        ? '少なくとも 1 つ選択してください。'
        : 'Select at least one option.',
      'source-csv': ja
        ? '安定した header 行を持つ表形式の移行に適しています。'
        : 'Best for tabular migrations with a stable header row.',
      'source-json': ja
        ? '入れ子の data や構造化 custom field に適しています。'
        : 'Best for nested source data and structured custom fields.',
      syncConflicts: ja
        ? 'mukuroji と Provider の値を比較し、競合 ID ごとに安全な復旧方法を選びます。'
        : 'Compare mukuroji and provider values, then choose a recovery for each conflict ID.',
      syncConflictsEmpty: ja
        ? '双方向同期は判断待ちになっていません。'
        : 'No bidirectional synchronization is waiting for a decision.',
      syncConflictsError: ja
        ? '同期競合を読み込めませんでした。再試行してください。'
        : 'Sync conflicts could not be loaded. Try again.',
      syncConflictsLoadMoreError: ja
        ? '同期競合の続きを読み込めませんでした。取得済みの競合はそのまま表示しています。'
        : 'More sync conflicts could not be loaded. Previously loaded conflicts are still shown.',
      syncConflictsLoading: ja
        ? '同期競合を読み込み中'
        : 'Loading sync conflicts',
      webhookDelivery: ja
        ? '配信には安定 event ID、指数 backoff、HMAC 署名を利用します。'
        : 'Deliveries use a stable event ID, exponential backoff, and an HMAC signature.',
      webhookSigning: ja
        ? 'Payload 処理前に timestamp 付き HMAC 署名を検証してください。Signing secret は一度だけ表示します。'
        : 'Verify the timestamped HMAC signature before processing a payload. Signing secrets are shown only once.',
      webhooks: ja
        ? '必要な event だけを購読し、すべての配信試行を監視します。'
        : 'Subscribe only to the events the endpoint needs and monitor every attempt.',
      webhooksEmpty: ja
        ? '署名付き event を受信する HTTPS endpoint を追加します。'
        : 'Add an HTTPS endpoint to begin receiving signed events.',
    },
    secretTitles: {
      'api-key': ja ? 'API key を今コピーしてください' : 'Copy the API key now',
      'oauth-app': ja
        ? 'Client secret を今コピーしてください'
        : 'Copy the client secret now',
      webhook: ja
        ? 'Signing secret を今コピーしてください'
        : 'Copy the signing secret now',
    },
    secretDescriptions: {
      'api-key': ja
        ? 'API request の Bearer credential として使用します。'
        : 'Use this value as the Bearer credential for API requests.',
      'oauth-app': ja
        ? 'Browser code ではなく OAuth client server に安全に保存します。'
        : 'Store this value in the OAuth client server, never in browser code.',
      webhook: ja
        ? '各配信の署名検証に使用します。'
        : 'Use this value to verify each delivery signature.',
    },
    secretWarning: ja
      ? 'この secret は一度だけ表示されます。閉じる前に安全な場所へ保存してください。'
      : 'This secret is displayed once. Store it securely before closing this dialog.',
    secretStoredConfirmation: ja
      ? '安全な場所に保存しました'
      : 'I stored this secret safely',
    copySecret: ja ? 'Secret をコピー' : 'Copy secret',
    copiedSecret: ja ? 'コピーしました' : 'Copied',
    closeDialog: ja ? '閉じる' : 'Close',
    importReportSummary: ja
      ? '{total} 行中 {valid} 行が有効です。{invalid} 行を修正してください。'
      : '{valid} of {total} rows are valid. {invalid} rows need attention.',
  }
}
