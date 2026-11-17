/**
 * Japanese messages for password reset, password change, and authenticator (MFA) setup.
 */
export const accountSecurityMessages = {
  'passwordReset.eyebrow': 'アカウント復旧',
  'passwordReset.title': 'パスワードを再設定する',
  'passwordReset.intro':
    'ログイン用メールアドレスに確認コードを送ります。届いたコードと新しいパスワードを入力すれば、管理者に頼まずにログインを再開できます。',
  'passwordReset.requestTitle': '確認コードを送る',
  'passwordReset.requestDescription':
    'アカウントの登録有無は画面に表示しません。登録済みのアドレスにだけコードが届きます。',
  'passwordReset.email': 'ログイン用メールアドレス',
  'passwordReset.emailPlaceholder': 'name@example.com',
  'passwordReset.emailError': '有効なメールアドレスを入力してください。',
  'passwordReset.send': '確認コードを送る',
  'passwordReset.sending': '送信中',
  'passwordReset.sentNotice':
    '{email} が登録済みのアカウントなら、確認コードを送りました。届くまで数分かかることがあります。',
  'passwordReset.adminResetNotice':
    '管理者がパスワードを無効にしました。メールに届いた確認コードで新しいパスワードを設定してください。',
  'passwordReset.confirmTitle': '新しいパスワードを設定',
  'passwordReset.code': '確認コード',
  'passwordReset.codePlaceholder': 'メールに記載の6桁',
  'passwordReset.codeError': 'メールに記載の6桁の確認コードを入力してください。',
  'passwordReset.newPassword': '新しいパスワード',
  'passwordReset.confirmPassword': '新しいパスワード（確認）',
  'passwordReset.passwordHint':
    '12文字以上で、英大文字・英小文字・数字・記号をそれぞれ1文字以上含めてください。',
  'passwordReset.mismatch': '確認用パスワードが一致しません。',
  'passwordReset.submit': 'パスワードを再設定',
  'passwordReset.submitting': '設定中',
  'passwordReset.resend': '確認コードを再送する',
  'passwordReset.changeEmail': '別のメールアドレスを使う',
  'passwordReset.doneTitle': 'パスワードを再設定しました',
  'passwordReset.doneDescription': '新しいパスワードでログインしてください。',
  'passwordReset.goToLogin': 'ログインへ進む',
  'passwordReset.helpTitle': 'メールが届かない場合',
  'passwordReset.helpDescription':
    '迷惑メールフォルダを確認してください。それでも届かない場合は、ワークスペース管理者にメンバー一覧から「パスワード再設定を送る」を依頼できます。パスワードや確認コードは管理者にも伝えないでください。',
  'passwordReset.supportAction': 'サポート案内を見る',
  'passwordReset.error.codeInvalid':
    '確認コードが正しくないか、有効期限が切れています。新しいコードを送ってやり直してください。',
  'passwordReset.error.passwordPolicy':
    '新しいパスワードがパスワードポリシーを満たしていません。条件を確認して入力し直してください。',
  'passwordReset.error.rateLimited':
    '試行回数が上限に達しました。しばらく待ってからやり直してください。',
  'passwordReset.error.sso':
    'このメールアドレスはシングルサインオンでログインします。パスワードは所属組織の ID 管理画面で変更してください。',
  'passwordReset.error.unavailable':
    '再設定を受け付けられませんでした。時間をおいて再試行してください。',
  'mfaSetup.title': '認証アプリを登録',
  'mfaSetup.subtitle': 'ログインを続けるには多要素認証の設定が必要です',
  'mfaSetup.intro':
    'Google Authenticator、Microsoft Authenticator、1Password などの認証アプリを使います。',
  'mfaSetup.policyNotice':
    'このワークスペースでは多要素認証が必須です。認証アプリを登録すると、ログインを続けられます。',
  'mfaSetup.start': '登録を始める',
  'mfaSetup.starting': '準備中',
  'mfaSetup.scanStep': '1. 認証アプリで QR コードを読み取ります。',
  'mfaSetup.qrAlt': '認証アプリ登録用の QR コード',
  'mfaSetup.manualKey': '読み取れない場合は、このキーを手入力してください。',
  'mfaSetup.copyKey': 'キーをコピー',
  'mfaSetup.copied': 'コピーしました',
  'mfaSetup.codeStep': '2. 認証アプリに表示された6桁のコードを入力します。',
  'mfaSetup.code': '確認コード',
  'mfaSetup.codePlaceholder': '6桁のコード',
  'mfaSetup.verify': '登録する',
  'mfaSetup.verifying': '確認中',
  'mfaSetup.cancel': 'キャンセル',
  'mfaSetup.loginDone':
    '認証アプリを登録しました。もう一度ログインし、認証アプリに表示されたコードを入力してください。',
  'mfaSetup.error.code': '6桁のコードを入力してください。',
  'mfaSetup.error.invalid':
    'コードが一致しません。認証アプリに表示されている最新のコードを入力してください。',
  'mfaSetup.error.rateLimited':
    '試行回数が上限に達しました。しばらく待ってからやり直してください。',
  'mfaSetup.error.alreadyEnabled': 'すでに認証アプリが登録されています。',
  'mfaSetup.error.expired':
    '登録の有効期限が切れました。もう一度ログインしてやり直してください。',
  'mfaSetup.error.unavailable':
    '登録を完了できませんでした。時間をおいて再試行してください。',
  'accountSecurity.title': 'ログインとセキュリティ',
  'accountSecurity.description': 'パスワードと多要素認証（認証アプリ）を管理します。',
  'accountSecurity.loading': '読み込み中',
  'accountSecurity.loadError': 'ログイン設定を読み込めませんでした。',
  'accountSecurity.reloadError': 'ログイン設定を再読み込みできませんでした。表示が古い可能性があります。',
  'accountSecurity.retry': '再読み込み',
  'accountSecurity.password.title': 'パスワード',
  'accountSecurity.password.sso':
    'シングルサインオンでログインしているため、パスワードは所属組織の ID 管理画面で変更します。',
  'accountSecurity.password.current': '現在のパスワード',
  'accountSecurity.password.new': '新しいパスワード',
  'accountSecurity.password.confirm': '新しいパスワード（確認）',
  'accountSecurity.password.submit': 'パスワードを変更',
  'accountSecurity.password.submitting': '変更中',
  'accountSecurity.password.changed': 'パスワードを変更しました。',
  'accountSecurity.password.error.current': '現在のパスワードが正しくありません。',
  'accountSecurity.password.error.unknown':
    'パスワードを変更できませんでした。時間をおいて再試行してください。',
  'accountSecurity.mfa.title': '多要素認証（認証アプリ）',
  'accountSecurity.mfa.enabled': '登録済み',
  'accountSecurity.mfa.disabled': '未登録',
  'accountSecurity.mfa.enabledDescription': 'ログイン時に認証アプリのコードを確認します。',
  'accountSecurity.mfa.disabledDescription':
    '認証アプリを登録すると、パスワードに加えてコードでも本人確認します。',
  'accountSecurity.mfa.requiredByPolicy':
    'ワークスペースのセキュリティポリシーで必須のため、解除できません。認証アプリを紛失した場合は、管理者に MFA のリセットを依頼してください。',
  'accountSecurity.mfa.sso': 'シングルサインオンの多要素認証は ID プロバイダーで管理されます。',
  'accountSecurity.mfa.register': '認証アプリを登録',
  'accountSecurity.mfa.registered':
    '認証アプリを登録しました。次回のログインからコードを確認します。',
  'accountSecurity.mfa.disable': '登録を解除',
  'accountSecurity.mfa.disableConfirm':
    '認証アプリの登録を解除しますか？ログイン時のコード確認がなくなります。',
  'accountSecurity.mfa.disableConfirmAction': '解除する',
  'accountSecurity.mfa.disabling': '解除中',
  'accountSecurity.mfa.disabledNotice': '認証アプリの登録を解除しました。',
  'accountSecurity.mfa.error.recentSignIn':
    '安全のため、ログインし直してから解除してください。',
  'accountSecurity.mfa.error.disable': '登録を解除できませんでした。時間をおいて再試行してください。',
  'memberSecurity.mfa.enrolled': 'MFA登録済み',
  'memberSecurity.mfa.not-enrolled': 'MFA未登録',
  'memberSecurity.mfa.sso': 'SSO',
  'memberSecurity.mfa.unknown': 'MFA状況不明',
  'memberSecurity.summary': 'MFA 未登録のアクティブメンバー: {count} 人',
  'memberSecurity.loadError': 'MFA の登録状況を読み込めませんでした。',
  'memberSecurity.retry': '再読み込み',
  'memberSecurity.action.passwordReset': 'パスワード再設定を送る',
  'memberSecurity.action.mfaReset': 'MFAをリセット',
  'memberSecurity.dialog.passwordResetTitle': 'パスワード再設定を送りますか？',
  'memberSecurity.dialog.passwordResetDescription':
    '{name} の現在のパスワードは無効になり、ログイン中のセッションも終了します。登録メールアドレスに確認コードが届き、本人が新しいパスワードを設定します。この操作は監査ログに記録されます。',
  'memberSecurity.dialog.mfaResetTitle': 'MFA をリセットしますか？',
  'memberSecurity.dialog.mfaResetDescription':
    '{name} の認証アプリの登録を解除します。本人が認証アプリを紛失した場合に使います。MFA が必須なら、本人は次回ログイン時に認証アプリを登録し直します。この操作は監査ログに記録されます。',
  'memberSecurity.done.passwordReset': '{name} に確認コードを送りました。',
  'memberSecurity.done.mfaReset': '{name} の MFA をリセットしました。',
  'memberSecurity.error.invitationPending':
    'このメンバーはまだ招待を受け入れていません。招待を再送してください。',
  'memberSecurity.error.sso': 'このメンバーはシングルサインオンでログインします。',
  'memberSecurity.error.unavailable':
    '操作できませんでした。メンバーのメールアドレスが確認済みか確かめてください。',
  'memberSecurity.error.inProgress': '前回の操作をまだ処理しています。1 分ほど待ってからもう一度お試しください。',
  'memberSecurity.error.expired':
    '前回の操作は途中で止まりました。メンバーのログイン状況を確認してから、もう一度実行してください。',
  'memberSecurity.error.notEnrolled': 'このメンバーは認証アプリを登録していません。',
  'security.sessions.mfaImpact.count':
    'MFA を登録していないアクティブメンバーが {count} 人います。保存すると、その人は次回ログイン時に認証アプリの登録を求められます。',
  'security.sessions.mfaImpact.unknown': '{count} 人は登録状況を確認できませんでした。',
  'security.dialog.mfaRequiredTitle': 'MFA を必須にしますか？',
  'security.dialog.mfaRequiredConfirm': '必須にして保存',
} as const
