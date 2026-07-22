/**
 * Japanese messages for the security domain.
 */
export const securityMessages = {
  'security.recovery.header': 'セキュリティ復旧',
  'security.recovery.eyebrow': '緊急アクセス',
  'security.recovery.title': '安全に管理アクセスを復旧する',
  'security.recovery.description':
    '通常の管理経路が利用できない場合に限り、事前登録済みの緊急管理者として短時間だけアクセスを昇格します。',
  'security.recovery.step.verify.title': '本人性と端末を再確認',
  'security.recovery.step.verify.description':
    '多要素認証と直近の再認証を満たすセッションだけが復旧を開始できます。',
  'security.recovery.step.audit.title': '具体的な理由を記録',
  'security.recovery.step.audit.description':
    '理由、実行者、開始・終了時刻は監査ログに残り、後から確認できます。',
  'security.recovery.step.expire.title': '必要最小限の時間で自動終了',
  'security.recovery.step.expire.description':
    '選択した時間を過ぎると昇格は自動で失効します。作業後は通常の権限へ戻ります。',
  'security.recovery.form.label': 'Break-glass activation',
  'security.recovery.form.title': '復旧アクセスを開始',
  'security.recovery.warning.title': '緊急時だけ使用してください',
  'security.recovery.warning.description':
    'この操作は強い管理権限を一時的に付与し、監査対象になります。',
  'security.recovery.reason': '復旧が必要な理由',
  'security.recovery.reasonPlaceholder':
    '例: SSO 設定の障害を復旧し、通常の管理者アクセスを再開する',
  'security.recovery.reasonHelp':
    '10文字以上で具体的に入力してください。理由は監査ログに保存されます。',
  'security.recovery.duration': '有効時間',
  'security.recovery.duration.five': '5分',
  'security.recovery.duration.fifteen': '15分',
  'security.recovery.duration.thirty': '30分',
  'security.recovery.durationHelp':
    '必要な作業を終えられる最短の時間を選んでください。',
  'security.recovery.activate': '復旧アクセスを開始',
  'security.recovery.activating': '本人性を確認して開始中…',
  'security.recovery.reauthenticate': '本人確認のためログインし直す',
  'security.recovery.cancel': 'ダッシュボードへ戻る',
  'security.recovery.error.reason': '復旧理由を10文字以上で入力してください。',
  'security.recovery.error.denied':
    'このアカウントは緊急管理者として事前登録されていません。別の復旧担当者へ連絡してください。',
  'security.recovery.error.mfa':
    '多要素認証を確認できませんでした。MFA を使ってログインし直してください。',
  'security.recovery.error.reauthentication':
    '直近の本人確認が必要です。ログインし直してから、もう一度お試しください。',
  'security.recovery.error.duration':
    '選択した有効時間はこの緊急管理者に許可されていません。短い時間を選んでください。',
  'security.recovery.error.session':
    'ログインセッションを確認できませんでした。ログインし直してください。',
  'security.recovery.error.unknown':
    '復旧アクセスを開始できませんでした。接続を確認して、もう一度お試しください。',
  'security.recovery.active.title': '緊急復旧アクセスが有効です',
  'security.recovery.active.description':
    '{time} に自動終了します。復旧作業が終わったら、予定より早く終了してください。',
  'security.recovery.active.revoke': '今すぐ終了',
  'security.recovery.active.revoking': '終了中…',
  'security.page.eyebrow': 'Enterprise 管理',
  'security.page.title': 'ID・セキュリティ',
  'security.page.description':
    '組織の認証、プロビジョニング、アクセス制御、セッションと緊急アクセスを一元管理します。',
  'security.eyebrow': 'Enterprise security',
  'security.title': '組織のセキュリティ管理',
  'security.description':
    '変更前の前提条件と影響を確認しながら、IDライフサイクルと特権アクセスを安全に運用します。',
  'security.tabsAria': 'Enterprise セキュリティ設定',
  'security.tab.overview': '概要',
  'security.tab.identity': 'ID',
  'security.tab.provisioning': 'プロビジョニング',
  'security.tab.access': 'マッピング・ロール',
  'security.tab.sessions': 'セッション',
  'security.tab.privileged': '特権アクセス',
  'security.mode.admin': '管理可能',
  'security.mode.readOnly': '読み取り専用',
  'security.readOnly':
    'この設定は読み取り専用です。変更するには Enterprise security の管理権限が必要です。',
  'security.action.retryLoad': '再読み込み',
  'security.action.refresh': '最新状態を取得',
  'security.action.testing': '保存・テスト中',
  'security.action.rotating': 'ローテーション中',
  'security.action.previewing': '差分を確認中',
  'security.action.retrying': '再試行中',
  'security.action.remove': '削除',
  'security.action.saving': '保存中',
  'security.action.save': '保存',
  'security.action.close': '閉じる',
  'security.action.working': '実行中',
  'security.action.cancel': 'キャンセル',
  'security.action.copy': 'コピー',
  'security.action.copied': 'コピー済み',
  'security.action.signInAgain': '本人確認をやり直す',
  'security.action.recoverAccess': '復旧アクセスへ進む',
  'security.error.load': 'Enterprise セキュリティ設定を読み込めませんでした。',
  'security.error.stale':
    '表示中の内容は古い可能性があります。更新操作を行う前に再読み込みしてください。',
  'security.error.forbidden': 'この操作を実行する権限がありません。',
  'security.error.authenticationRequired':
    'セッションの有効期限、MFA、または再認証ポリシーにより、もう一度本人確認が必要です。安全のため一時的な認証情報は画面から消去されました。',
  'security.error.ipDenied':
    '現在のネットワークは Workspace の IP 許可リストに含まれていません。承認済みネットワークへ切り替えてから再読み込みしてください。',
  'security.error.ipDeniedRecovery':
    '現在のネットワークは Workspace の IP 許可リストに含まれていません。承認済みネットワークへ切り替えるか、事前登録済みの緊急管理者は復旧アクセスへ進んでください。',
  'security.error.conflict':
    '別の管理者が設定を更新しました。最新状態を確認してから再実行してください。',
  'security.error.invalid': '入力内容を確認してから再実行してください。',
  'security.error.prerequisite':
    '安全に実行するための前提条件が不足しています。チェックリストを確認してください。',
  'security.error.operation': 'セキュリティ設定を更新できませんでした。',
  'security.error.refreshAfterMutation':
    '変更は適用されましたが、最新状態を再取得できませんでした。状態を再読み込みしてください。',
  'security.error.refreshAfterCredential':
    '認証情報は発行済みですが、最新状態を再取得できませんでした。表示中の認証情報を安全な場所に保存してから、状態を再読み込みしてください。',
  'security.value.notConfigured': '未設定',
  'security.value.none': 'なし',
  'security.value.never': '未実行',
  'security.unit.minutes': '分',
  'security.unit.days': '日',
  'security.overview.metric.sso': 'SSO 強制',
  'security.overview.metric.scim': 'SCIM',
  'security.overview.metric.provisioningErrors': '同期の要対応',
  'security.overview.metric.privileged': '特権経路',
  'security.overview.enforced': '強制中',
  'security.overview.notEnforced': '任意',
  'security.overview.privilegedCount':
    'Service {service}件・緊急 {breakGlass}件',
  'security.overview.readinessEyebrow': '安全な有効化',
  'security.overview.readinessTitle': 'SSO 強制の準備状況',
  'security.overview.readinessDescription':
    '接続確認、ドメイン所有、緊急管理者の3条件を満たしてから、管理対象ドメインへSSOを強制します。',
  'security.overview.card.identityTitle': 'ID 接続を確認',
  'security.overview.card.identityDescription':
    'IdP、管理対象ドメイン、SSO強制の前提条件を確認します。',
  'security.overview.card.provisioningTitle': '同期の影響を確認',
  'security.overview.card.provisioningDescription':
    'SCIMトークン、dry-run差分、失敗ログと再試行を管理します。',
  'security.overview.card.sessionsTitle': 'セッションを制御',
  'security.overview.card.sessionsDescription':
    'MFA、有効期間、再認証、IP、ゲスト上限を設定します。',
  'security.overview.open': '開く',
  'security.prerequisite.ready': '有効化可能',
  'security.prerequisite.actionRequired': '要対応',
  'security.prerequisite.identity': 'IdP の接続テストが成功している',
  'security.prerequisite.domain': '確認済みドメインが1件以上ある',
  'security.prerequisite.breakGlass':
    'MFA設定済みの緊急管理者が有効になっている',
  'security.prerequisite.complete': '完了',
  'security.prerequisite.incomplete': '未完了',
  'security.prerequisite.unavailable': '現在の権限では状態を確認できません',
  'security.identity.status.not-configured': '未設定',
  'security.identity.status.draft': '下書き',
  'security.identity.status.verified': '接続確認済み',
  'security.identity.status.error': '要確認',
  'security.identity.providerTitle': 'ID プロバイダー',
  'security.identity.providerDescription':
    'SAMLまたはOIDCの公開設定を保存し、接続テストで利用可能性を確認します。',
  'security.identity.protocol': 'プロトコル',
  'security.identity.displayName': '表示名',
  'security.identity.issuer': 'Issuer / Entity ID',
  'security.identity.metadataUrl': 'SAML metadata URL',
  'security.identity.metadataUrlHelp':
    'HTTPSでmetadata XMLを取得し、Entity ID、SSO URL、署名証明書を接続テストで検証します。',
  'security.identity.ssoUrl': 'SSO URL',
  'security.identity.clientId': 'Client ID / Audience',
  'security.identity.saveAndTest': '保存して接続テスト',
  'security.identity.lastTested': '最終接続テスト: {date}',
  'security.identity.domainsTitle': '管理対象ドメイン',
  'security.identity.domainsDescription':
    'DNS TXTレコードで所有権を確認し、SSO対象を明示します。',
  'security.identity.domainLabel': 'ドメイン',
  'security.identity.claimDomain': 'ドメインを追加',
  'security.identity.verifyDomain': '所有権を確認',
  'security.identity.domainsEmpty': '管理対象ドメインはまだありません。',
  'security.identity.verificationRecordName': 'TXT レコード名',
  'security.domainChallenge.title': '{domain} の DNS 検証値',
  'security.domainChallenge.description':
    'この TXT 値は再表示されません。DNS に設定するまで安全な場所に保存してください。',
  'security.domainChallenge.recordName': 'TXT レコード名',
  'security.domainChallenge.recordValue': 'TXT 値（一回限り表示）',
  'security.domain.status.pending': '確認待ち',
  'security.domain.status.verified': '確認済み',
  'security.domain.status.conflict': '競合',
  'security.identity.enforcementTitle': 'SSO 強制',
  'security.identity.enforcementDescription':
    '管理対象ドメインのログイン経路をIdPへ統一します。緊急経路を確保してから有効化してください。',
  'security.identity.enforcementReady':
    'すべての前提条件を満たしています。影響を確認してSSOを強制できます。',
  'security.identity.enforcementBlocked':
    '未完了の前提条件があります。チェックリストを完了すると有効化できます。',
  'security.identity.disableEnforcement': 'SSO強制を解除',
  'security.identity.enableEnforcement': 'SSOを強制',
  'security.scim.status.disabled': '無効',
  'security.scim.status.ready': '利用可能',
  'security.scim.status.syncing': '同期中',
  'security.scim.status.error': '要確認',
  'security.provisioning.scimTitle': 'SCIM 接続',
  'security.provisioning.scimDescription':
    'IdPへ渡すendpointと、保存済みcredentialの安全なメタデータを確認します。',
  'security.provisioning.endpoint': 'Endpoint',
  'security.provisioning.tokenGeneration': 'Token',
  'security.provisioning.generation':
    'Generation {generation}・末尾 {lastFour}',
  'security.provisioning.lastSync': '最終同期',
  'security.provisioning.tokenHelp':
    '新しいtokenは発行直後に一度だけ表示されます。先にIdPへ登録できる準備をしてください。',
  'security.provisioning.rotateToken': 'Tokenをローテーション',
  'security.provisioning.createToken': 'Tokenを発行',
  'security.provisioning.scimTokenLabel': 'SCIM bearer token',
  'security.provisioning.reconcileTitle': 'Directory reconciliation',
  'security.provisioning.reconcileDescription':
    '適用前にdry-runを実行し、作成・更新・無効化・session失効の件数を確認します。',
  'security.provisioning.dryRunTitle': '変更せずに差分を確認',
  'security.provisioning.dryRunDescription':
    '現在のdirectory状態とWorkspaceを比較し、短時間有効なpreviewを作成します。',
  'security.provisioning.preview': 'Dry-runを実行',
  'security.provisioning.logsTitle': '実行ログ',
  'security.provisioning.logsDescription':
    '秘密情報を除外した同期履歴とcorrelation IDを確認します。',
  'security.provisioning.logStatus.pending': '待機中',
  'security.provisioning.logStatus.running': '実行中',
  'security.provisioning.logStatus.succeeded': '成功',
  'security.provisioning.logStatus.partial': '一部失敗',
  'security.provisioning.logStatus.failed': '失敗',
  'security.provisioning.summary.pending':
    'プロビジョニング処理は実行待ちです。',
  'security.provisioning.summary.running':
    'プロビジョニング処理を実行しています。',
  'security.provisioning.summary.succeeded':
    'プロビジョニング処理が完了しました。',
  'security.provisioning.summary.partial':
    'プロビジョニング処理の一部に対応が必要です。',
  'security.provisioning.summary.failed':
    'プロビジョニング処理に失敗しました。詳細は監査ログで確認してください。',
  'security.provisioning.operation.scim': 'SCIM',
  'security.provisioning.operation.dry-run': 'Dry-run',
  'security.provisioning.operation.reconcile': 'Reconcile',
  'security.provisioning.operation.deprovision': 'Deprovision',
  'security.provisioning.attempts': '試行 {count}回',
  'security.provisioning.retry': '再試行',
  'security.provisioning.logsEmpty': '実行ログはまだありません。',
  'security.provisioning.impactTitle': '適用される変更',
  'security.provisioning.previewExpires': 'Preview期限: {date}',
  'security.provisioning.previewExpired':
    'このpreviewは期限切れです。適用前にもう一度dry-runを実行してください。',
  'security.provisioning.previewExpiredAction': '期限切れ・再確認が必要',
  'security.provisioning.previewBlocked':
    '保護対象への影響が含まれるため適用できません。警告の対象をDirectory変更から除外して、dry-runをやり直してください。',
  'security.provisioning.previewBlockedAction': '保護対象への影響を解消',
  'security.provisioning.blockingChanges': '適用不可',
  'security.provisioning.warningSummary':
    'このpreviewには要確認の影響が{count}件あります。件数と保護状態を確認し、詳細は監査ログで確認してください。',
  'security.provisioning.changesFound': '差分あり',
  'security.provisioning.noChanges': '差分なし',
  'security.provisioning.impact.usersCreated': 'User作成',
  'security.provisioning.impact.usersUpdated': 'User更新',
  'security.provisioning.impact.usersDeactivated': 'User無効化',
  'security.provisioning.impact.groupsCreated': 'Group作成',
  'security.provisioning.impact.groupsUpdated': 'Group更新',
  'security.provisioning.impact.sessionsRevoked': 'Session失効',
  'security.provisioning.apply': 'この差分を適用',
  'security.access.mappingsTitle': 'Directory group mapping',
  'security.access.mappingsDescription':
    'IdPのgroupをWorkspace、Team、Projectのroleへ決定的に割り当てます。',
  'security.access.directoryGroupName': 'Directory group名',
  'security.access.directoryGroupId': 'Directory group ID',
  'security.access.scope': '適用範囲',
  'security.access.role': 'ロール',
  'security.access.selectRole': 'ロールを選択',
  'security.access.addMapping': 'Mappingを追加',
  'security.scope.workspace': 'Workspace',
  'security.scope.team': 'Team',
  'security.scope.project': 'Project',
  'security.access.column.group': 'Directory group',
  'security.access.column.scope': '適用範囲',
  'security.access.column.role': 'ロール',
  'security.access.column.action': '操作',
  'security.access.mappingsEmpty': 'Group mappingはまだありません。',
  'security.access.rolesTitle': 'ロールと権限',
  'security.access.rolesDescription':
    '権限を用途別に比較し、custom roleだけを編集できます。',
  'security.access.roleName': 'ロール名',
  'security.access.roleDescription': '説明',
  'security.access.rolePermissions': '付与する権限',
  'security.access.permissionRequired': '少なくとも1つの権限を選択してください。',
  'security.access.permissionGrantCeilingHelp':
    '現在の自分が持つ権限だけを新しいロールへ付与できます。付与できない権限は無効で表示されます。',
  'security.access.permissionOutsideGrantCeiling':
    '現在の自分には、この権限をロールへ付与する権限がありません。',
  'security.access.roleOutsideGrantCeiling':
    'このロールには現在の自分が付与できない権限が含まれるため、編集できません。',
  'security.access.guestAssignable': 'Guestへの割り当てを許可',
  'security.access.guestAssignableWarning':
    '有効にすると、外部Guestへこのロールのすべての権限を付与できます。Guest policyと権限内容を確認してください。',
  'security.access.createRole': 'Custom roleを作成',
  'security.access.permission': '権限',
  'security.access.privilegedPermission': '高権限',
  'security.access.saveCustomRoles': 'Custom roleの変更を保存',
  'security.access.saveRole': '保存',
  'security.access.deleteRole': '削除',
  'security.access.roleInUse': '割り当て中のロールは削除できません。',
  'security.access.roleImpactBlocked':
    'このロールは直接割り当て{assignments}件・Group mapping {mappings}件・Service account {serviceAccounts}件から参照されています。参照を解除してから削除してください。',
  'security.access.systemManaged': 'System管理',
  'security.role.kind.built-in': 'Built-in',
  'security.role.kind.custom': 'Custom',
  'security.role.name.workspaceOwner': 'Workspaceオーナー',
  'security.role.name.workspaceAdmin': 'Workspace管理者',
  'security.role.name.workspaceMember': 'Workspaceメンバー',
  'security.role.name.workspaceGuest': 'ゲスト',
  'security.role.name.teamManager': 'Team管理者',
  'security.role.name.teamMember': 'Teamメンバー',
  'security.role.name.projectManager': 'Project管理者',
  'security.role.name.projectMember': 'Projectメンバー',
  'security.role.name.projectViewer': 'Project閲覧者',
  'security.permission.localizedName': '{resource}：{action}',
  'security.permission.localizedDescription':
    '「{permission}」の権限を付与します。',
  'security.permission.resource.workspace': 'Workspace',
  'security.permission.resource.members': 'メンバー',
  'security.permission.resource.teams': 'Team',
  'security.permission.resource.projects': 'Project',
  'security.permission.resource.workItems': 'Work Item',
  'security.permission.resource.files': 'ファイル',
  'security.permission.resource.requests': 'リクエスト',
  'security.permission.resource.planning': '計画',
  'security.permission.resource.automation': 'オートメーション',
  'security.permission.resource.audit': '監査ログ',
  'security.permission.resource.identity': 'ID管理',
  'security.permission.resource.security': 'セキュリティ',
  'security.permission.resource.serviceAccounts': 'Service account',
  'security.permission.resource.content': 'コンテンツ',
  'security.permission.action.read': '閲覧',
  'security.permission.action.write': '編集',
  'security.permission.action.manage': '管理',
  'security.permission.action.approve': '承認',
  'security.permission.action.export': 'エクスポート',
  'security.permission.action.use': '利用',
  'security.permission.action.configure': '設定',
  'security.permissionGroup.workspace': 'Workspace',
  'security.permissionGroup.members': 'メンバー',
  'security.permissionGroup.content': 'コンテンツ',
  'security.permissionGroup.security': 'セキュリティ',
  'security.permissionGroup.automation': 'オートメーション',
  'security.sessions.authenticationTitle': '認証とセッション',
  'security.sessions.authenticationDescription':
    '時間の単位と上限を明示して、通常操作と機密操作の再認証境界を設定します。',
  'security.sessions.mfaRequired': 'MFAを必須にする',
  'security.sessions.mfaDescription':
    'Workspaceのhuman memberへ多要素認証を要求します。',
  'security.sessions.lifetime': 'セッション有効期間',
  'security.sessions.lifetimeDescription':
    'ログインから強制終了までの絶対時間です。',
  'security.sessions.idleTimeout': 'アイドルタイムアウト',
  'security.sessions.idleTimeoutDescription':
    '操作がないセッションを終了するまでの時間です。',
  'security.sessions.reauthentication': '通常の再認証間隔',
  'security.sessions.reauthenticationDescription':
    '通常のセッションで本人確認をやり直すまでの時間です。',
  'security.sessions.sensitiveReauthentication': '機密操作の再認証間隔',
  'security.sessions.sensitiveReauthenticationDescription':
    'セキュリティ設定などの機密操作で本人確認をやり直すまでの時間です。',
  'security.sessions.unitHelpTitle': '時間設定の関係',
  'security.sessions.unitHelpDescription':
    'アイドル時間と通常の再認証はセッション有効期間以下、機密操作の再認証は通常の再認証以下にしてください。',
  'security.sessions.reauthenticationError':
    'セッション、アイドル、通常操作、機密操作の時間関係を確認してください。',
  'security.sessions.networkTitle': 'ネットワーク境界',
  'security.sessions.networkDescription':
    'Workspaceへ接続できるIPv4/IPv6 CIDRを1行ずつ指定します。',
  'security.sessions.ipAllowlist': 'IP allowlist',
  'security.sessions.ipAllowlistHelp':
    '空欄では制限しません。現在の接続元を除外しないよう確認してください。',
  'security.sessions.guestsTitle': 'Guest・外部協力者',
  'security.sessions.guestsDescription':
    'Guest利用の可否、session有効時間、許可するメールドメインを制限します。',
  'security.sessions.guestsAllowed': 'Guestを許可',
  'security.sessions.guestsAllowedDescription':
    '限定されたroleを持つ外部協力者をWorkspaceへ追加できます。',
  'security.sessions.externalCollaboratorsAllowed':
    '外部コラボレーターを許可',
  'security.sessions.externalCollaboratorsAllowedDescription':
    '確認済みドメイン外のmemberをWorkspaceへ追加できます。Guestとは別に制御されます。',
  'security.sessions.guestSessionLifetime': 'Guest sessionの最大有効時間',
  'security.sessions.guestSessionLifetimeDescription':
    'Guestのinteractive sessionが継続できる最大時間です。アカウントの有効期限ではありません。',
  'security.sessions.allowedGuestDomains': '許可するGuestドメイン',
  'security.sessions.allowedGuestDomainsHelp':
    'Guestと外部コラボレーターに許可する小文字のドメインを1行ずつ入力します。空欄では限定しません。',
  'security.sessions.save': 'セキュリティポリシーを保存',
  'security.privileged.serviceAccountsTitle': 'Service account',
  'security.privileged.serviceAccountsDescription':
    '人のセッションと分離した認証主体へ、必要最小限のroleとcredentialを付与します。',
  'security.privileged.serviceAccountName': 'Service account名',
  'security.privileged.serviceAccountScope': '許可するリソース範囲',
  'security.privileged.selectScope': 'Scopeを選択',
  'security.privileged.selectRole': 'ロールを選択',
  'security.privileged.role': '最小権限ロール',
  'security.privileged.credentialLifetime': 'Credential有効期間',
  'security.privileged.credentialLifetimeHelp':
    'ローテーション後も維持する1〜365日の絶対有効期間です。',
  'security.privileged.allowedSourceCidrs': '許可する送信元CIDR',
  'security.privileged.allowedSourceCidrsHelp':
    '1行に1つ入力します。空欄では送信元ネットワークを限定しません。',
  'security.privileged.impactSummary': '作成されるアクセス境界',
  'security.privileged.impactSummaryDescription':
    'Scope: {scope}。Credentialは{days}日後に失効します。送信元: {source}',
  'security.privileged.serviceAccountScopeValue': 'Scope: {scope}',
  'security.privileged.credentialExpires': 'Credential失効: {date}',
  'security.privileged.sourceCidrsRestricted': '送信元CIDR {count}件に限定',
  'security.privileged.sourceCidrsUnrestricted': '送信元ネットワークの限定なし',
  'security.privileged.createServiceAccount': 'Accountを作成',
  'security.privileged.credentialGeneration': 'Credential generation {generation}',
  'security.privileged.lastUsed': '最終利用: {date}',
  'security.privileged.rotateCredential': 'Credentialをローテーション',
  'security.privileged.revoke': '失効',
  'security.privileged.serviceAccountsEmpty': 'Service accountはまだありません。',
  'security.service.status.active': '有効',
  'security.service.status.revoked': '失効済み',
  'security.privileged.breakGlassTitle': '緊急管理者',
  'security.privileged.breakGlassDescription':
    '確認済みドメイン外の復旧担当者を事前登録します。SSO強制にはMFAと30日以内のaccess testが必要です。',
  'security.privileged.recoveryOnly': '緊急時のみ',
  'security.privileged.breakGlassEmail': '緊急管理者のメールアドレス',
  'security.privileged.registerBreakGlass': '緊急管理者を事前登録',
  'security.privileged.testBreakGlass': '現在の復旧経路をテスト',
  'security.privileged.testingBreakGlass': '復旧経路をテスト中',
  'security.privileged.mfaConfigured': 'MFA設定済み',
  'security.privileged.mfaRequired': 'MFA設定が必要',
  'security.privileged.lastTested': '最終テスト: {date}',
  'security.privileged.deactivate': '無効化',
  'security.privileged.breakGlassEmpty': '緊急管理者が設定されていません。',
  'security.breakGlass.status.active': '有効',
  'security.breakGlass.status.disabled': '無効',
  'security.secret.title': '今だけ表示される秘密情報',
  'security.secret.scimDescription':
    'このSCIM tokenは再表示できません。今すぐIdPの安全な保管先へ保存してください。',
  'security.secret.serviceAccountDescription':
    'このservice account tokenは再表示できません。今すぐ秘密情報管理へ保存してください。',
  'security.dialog.retryHint':
    '設定は確定していません。最新状態を確認してから再試行できます。',
  'security.dialog.ssoEnableTitle': 'SSOを強制しますか？',
  'security.dialog.ssoEnableDescription':
    '管理対象ドメインの通常ログインがIdPへ統一されます。緊急管理者で復旧できることを確認してください。',
  'security.dialog.ssoDisableTitle': 'SSO強制を解除しますか？',
  'security.dialog.ssoDisableDescription':
    '管理対象ドメインでSSO以外のログイン経路が再び利用可能になります。',
  'security.dialog.provisioningTitle': 'Directory差分を適用しますか？',
  'security.dialog.provisioningDescription':
    '{count}件の変更を適用します。無効化されたuserのsessionは直ちに失効する場合があります。',
  'security.dialog.sessionPolicyTitle':
    '現在の接続元を除外して保存しますか？',
  'security.dialog.sessionPolicyDescription':
    '更新後のIP許可リストでは現在の接続元（{ip}）が拒否されます。保存直後にこの管理画面へ接続できなくなる可能性があります。',
  'security.dialog.sessionPolicyUnknownIp': '解決できない接続元IP',
  'security.dialog.sessionPolicyConfirm': '理解して保存',
  'security.dialog.scimRotateTitle': 'SCIM tokenをローテーションしますか？',
  'security.dialog.scimRotateDescription':
    '現在のSCIM tokenは直ちに利用できなくなります。IdP側のcredentialを切り替えられる状態で続行してください。',
  'security.dialog.serviceAccountRotateTitle':
    'Service account credentialをローテーションしますか？',
  'security.dialog.serviceAccountRotateDescription':
    '{name} の現在のcredentialは直ちに利用できなくなり、新しいcredentialには同じ有効期間ポリシーが適用されます。利用中の連携を切り替えられる状態で続行してください。',
  'security.dialog.mappingDeleteTitle': 'Group mappingを削除しますか？',
  'security.dialog.mappingDeleteDescription':
    '{group} の {scope} / {role} mappingを削除します。このGroupから付与されたアクセスは直ちに失われる可能性があります。',
  'security.dialog.mappingUpdateTitle': 'Group mappingを変更しますか？',
  'security.dialog.mappingUpdateDescription':
    '{group} を {scope} / {role} へ変更します。現在のmappingから付与されたアクセスは直ちに変わる可能性があります。',
  'security.dialog.serviceAccountTitle': 'Service accountを失効しますか？',
  'security.dialog.serviceAccountDescription':
    '{name} のcredentialが直ちに利用できなくなります。利用中の連携を先に切り替えてください。',
  'security.dialog.breakGlassTitle': '緊急管理者を無効化しますか？',
  'security.dialog.breakGlassDescription':
    '{email} を無効化すると、IdP障害時の復旧経路が減少します。',
  'security.dialog.roleUpdateTitle': 'ロール権限を減らしますか？',
  'security.dialog.roleUpdateDescription':
    '{name} から{permissions}件の権限を外します。直接割り当て{assignments}件・Group mapping {mappings}件・Service account {serviceAccounts}件へ直ちに反映されます。',
  'security.dialog.roleGuestTitle': 'Guestへの割り当て境界を変更しますか？',
  'security.dialog.roleGuestEnableDescription':
    '{name} を外部Guestへ割り当て可能にします。このロールのすべての権限がGuestへ付与され得ます。',
  'security.dialog.roleGuestDisableDescription':
    '{name} を新たに外部Guestへ割り当てられない状態へ変更します。既存の割り当てへの影響を確認してください。',
  'security.dialog.roleTitle': 'Custom roleを削除しますか？',
  'security.dialog.roleDescription':
    '{name} を削除します。確認時点の直接割り当ては{assignments}件、Group mappingは{mappings}件、Service accountは{serviceAccounts}件です。',
} as const
