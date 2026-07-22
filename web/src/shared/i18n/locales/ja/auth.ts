/**
 * Japanese messages for the auth domain.
 */
export const authMessages = {
  'login.title': 'ログイン',
  'login.subtitle': 'アカウントにサインインしてください',
  'login.emailFirstSubtitle':
    '仕事用メールアドレスから安全なログイン方法を確認します',
  'login.passwordSubtitle': 'パスワードを入力して続行してください',
  'login.email': 'メールアドレス',
  'login.emailPlaceholder': 'メールアドレスを入力',
  'login.discoveryHelp':
    '管理対象ドメインでは、パスワードを送信せず組織の SSO へ移動します。',
  'login.changeEmail': '変更',
  'login.continue': '続行',
  'login.continuing': 'ログイン方法を確認中',
  'login.password': 'パスワード',
  'login.passwordPlaceholder': 'パスワードを入力',
  'login.showPassword': 'パスワードを表示',
  'login.hidePassword': 'パスワードを非表示',
  'login.remember': 'ログイン状態を保持',
  'login.submit': 'ログイン',
  'login.loading': 'ログイン中',
  'login.errorInvalid': 'メールアドレスまたはパスワードが正しくありません。',
  'login.errorUnavailable':
    'ローカル Cognito がまだ準備できていません。Floci の起動状態を確認してください。',
  'login.errorUnknown':
    'ログインに失敗しました。時間をおいてもう一度お試しください。',
  'login.errorSso':
    'シングルサインオンを開始できませんでした。時間をおいてもう一度お試しください。',
  'login.ssoCallback.title': 'シングルサインオンを完了しています',
  'login.ssoCallback.description':
    '認証結果を安全に確認しています。この画面を閉じずにお待ちください。',
  'login.ssoCallback.errorTitle': 'シングルサインオンを完了できませんでした',
  'login.ssoCallback.errorDescription':
    '認証リクエストが期限切れか、確認できませんでした。ログイン画面からもう一度開始してください。',
  'login.ssoCallback.retry': 'ログイン画面へ戻る',
  'login.forgotPassword': 'パスワードを忘れた場合',
  'login.challenge.title': '新しいパスワードを設定',
  'login.challenge.subtitle': '初回ログインを完了してください',
  'login.challenge.account': '{email} の初回パスワードを更新します。',
  'login.challenge.newPassword': '新しいパスワード',
  'login.challenge.newPasswordPlaceholder': '新しいパスワードを入力',
  'login.challenge.confirmPassword': '新しいパスワード（確認）',
  'login.challenge.confirmPasswordPlaceholder': 'もう一度入力',
  'login.challenge.passwordHint': '8文字以上で、所属組織のパスワードポリシーを満たす値を設定してください。',
  'login.challenge.submit': 'パスワードを設定して続行',
  'login.challenge.loading': '設定中',
  'login.challenge.backToLogin': '通常ログインへ戻る',
  'login.challenge.errorMismatch': '確認用パスワードが一致しません。',
  'login.challenge.errorPasswordPolicy':
    '新しいパスワードが組織のパスワードポリシーを満たしていません。条件を確認して入力し直してください。',
  'login.challenge.errorExpired':
    '初回ログインセッションが期限切れです。通常ログインからもう一度開始してください。',
  'login.challenge.errorUnavailable':
    '認証または Workspace の準備処理へ接続できませんでした。通常ログインへ戻り、時間をおいて再試行してください。',
  'login.challenge.error':
    '初回ログインの完了処理に失敗しました。新しいパスワードが保存済みの場合があります。',
  'login.challenge.retryTitle': '通常ログインから処理を再開できます',
  'login.challenge.retryDescription':
    '新しいパスワードが Cognito に保存され、Workspace 更新だけが失敗した場合も、通常ログインで同じメールアドレスと新しいパスワードを入力すると復旧処理が再開されます。',
  'login.mfa.title': '確認コードを入力',
  'login.mfa.subtitle': '多要素認証を完了してください',
  'login.mfa.verifyTitle': '本人確認が必要です',
  'login.mfa.authenticatorDescription':
    '認証アプリに表示されている確認コードを入力してください。',
  'login.mfa.codeDescription':
    '登録済みの認証手段へ送信された確認コードを入力してください。',
  'login.mfa.deliveryDescription':
    '{destination} に送信された確認コードを入力してください。',
  'login.mfa.code': '確認コード',
  'login.mfa.codePlaceholder': '6〜8桁のコード',
  'login.mfa.codeHelp':
    '数字のみを入力してください。確認コードや challenge session はブラウザに保存しません。',
  'login.mfa.verify': '確認してログイン',
  'login.mfa.verifying': '確認中',
  'login.mfa.restart': 'メールアドレスからやり直す',
  'login.mfa.errorCode': '6〜8桁の確認コードを入力してください。',
  'login.mfa.errorInvalid':
    '確認コードが正しくないか、有効期限が切れています。新しいコードを確認してください。',
  'login.mfa.errorExpired':
    '本人確認セッションが期限切れです。メールアドレスからログインをやり直してください。',
  'login.mfa.errorRateLimited':
    '確認の試行回数が上限に達しました。時間をおいてからやり直してください。',
  'login.mfa.errorUnavailable':
    '本人確認サービスへ接続できませんでした。時間をおいて再試行してください。',
  'login.mfa.errorUnknown':
    '確認を完了できませんでした。コードを確認してもう一度お試しください。',
} as const
