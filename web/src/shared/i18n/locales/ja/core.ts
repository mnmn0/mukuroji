/**
 * Japanese messages for the core domain.
 */
export const coreMessages = {
  'app.title': 'mukuroji',
  'app.update.available': '新しいバージョンを利用できます。再読み込みすると更新されます。',
  'app.update.reload': '再読み込み',
  'app.update.dismiss': '後で',
  'app.buildDrift.available': '画面とサーバーのバージョンが異なります。再読み込みすると画面がサーバーに合わせて更新されます。',
  'app.buildDrift.persisting': '再読み込みしても画面とサーバーのバージョンが一致しません。更新の途中の可能性があるので、数分後にもう一度再読み込みしてください。',
  'app.connectivity.offline': 'オフラインです。表示中の内容は最新でない可能性があり、接続が戻るまで変更は保存できません。',
  'app.connectivity.online': 'オンラインに戻りました。最新の内容を読み込みます。',
  'app.maintenance.readOnly': 'メンテナンス中のため閲覧だけできます。変更は保存できません。入力中の内容はこの画面に残るので、再読み込みせず終了後に保存し直してください。',
  'app.maintenance.stopped': 'メンテナンス中のため一時的に利用できません。障害ではありません。入力中の内容はこの画面に残るので、再読み込みせず終了後にもう一度お試しください。',
  'app.maintenance.ended': 'メンテナンスが終わりました。変更を保存できます。',
  'language.aria': '表示言語を選択',
  'sidebar.nav.focus': 'フォーカス',
  'sidebar.nav.updates': 'アップデート',
  'sidebar.nav.reviews': 'レビュー',
} as const
// Update Feed navigation is separate from the event Inbox.
