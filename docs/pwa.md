# Installable PWA

mukuroji の Web は manifest と service worker を持ち、mobile / desktop へ install できます。
この文書は現在の範囲、cache の安全境界、hosting 要件を定めます。push の配信、share target、
offline read cache、encrypted mutation queue は Issue #38 の後続範囲です。push の購読登録と service worker での表示は
[Notifications](./notifications.md#web-push-の購読) を参照してください。

## 現在の範囲

- `web/public/manifest.webmanifest`: `start_url` は `/home`、`display` は `standalone`。
  192px / 512px / maskable 512px の PNG icon と、マイタスク・インボックス・フォーカスへの shortcut を持ちます。
- `web/src/service-worker/sw.ts`: Vite の別 entry として build し、site root の `/sw.js` に出力します。
  production build かつ secure context の場合だけ `window.load` 後に登録します。開発 server では登録しません。
- install: browser 標準の install UI (Chromium の address bar / menu、iOS Safari の「ホーム画面に追加」) に加えて、
  Chromium が `beforeinstallprompt` を発火した場合は設定画面に「アプリとしてインストール」を表示します。
  `main.tsx` の起動時に event を捕捉して browser の mini-infobar を抑止し、利用者が押した時に一度だけ dialog を出します。
  `appinstalled` 後と standalone 表示中（`display-mode: standalone` または iOS の `navigator.standalone`。badge の許可導線と同じ `standaloneDisplay.ts` で判定）は「インストール済み」を表示し、対応しない browser では何も表示しません。
  dialog 表示中は button を `aria-disabled` のまま残してフォーカスを失わせず、閉じた後は承認 / キャンセルの結果を
  `role="status"` で通知してフォーカスを移します。キャンセル直後に Chromium が `beforeinstallprompt` を再発火してインストールが再び可能になっても、結果は次に「インストール」を押すまで通知したままにします。承認後に `appinstalled` が届いた場合も、インストール済みの通知へフォーカスを保ちます（表示言語を切り替えてもフォーカスは移しません）。browser が dialog を開けなかった場合は
  例外を出さずに失敗を通知し、browser のメニューからのインストールを案内します。
- badge: install 済み app の icon に受信箱の未読数を Badging API (`navigator.setAppBadge`) で表示します。
  数値だけを渡すため Workspace の内容は露出せず、読み込みに成功した未読 0 と、session を破棄するすべての経路（`clearAuthSession`）で消去します。badge は installed app 全体で 1 つなので、
  複数 window の 1 つが閉じても消去しません。tab ごとに別の session がある場合、ある tab の sign-out で badge を消すと
  `BroadcastChannel`（`mukuroji-app-badge`）で通知し、sign-in したままの tab が自分の未読数を再表示します。
  通知は badge の消去が終わってから送り、再表示は受け取った tab の token が storage に残っている場合だけ行います
  （remember した session は tab 間で共有されるため、別 tab の sign-out で破棄された session の未読数は戻しません）。
  読み込みに成功した未読 0 で badge を消した場合も同じ通知を送り、受け取った tab は未読数を取得し直してから再表示します。
  通知を受けて取得し直した未読数が 0 の場合も、同じ順序付きの消去（消去の完了後に通知）を使うため、遅れて届いた消去が他の tab の再表示を上書きしません。0 になった tab はその後の通知（自分の通知を含む）に反応しないため、消去の通知が往復し続けることはありません。
  同じ tab で sign-out 直後に sign-in した場合も、消去の完了後に新しい session が未読数を再表示します。
  session のない画面（sign-in 前に開いた tab など）は badge に触れず、他の tab の未読数を消しません。再表示の可否は localStorage と sessionStorage の両方で、その tab の token を個別に確認します。
  未読数の読み込み中や失敗時は前回の badge をそのまま残します。
  対応しない browser と API の失敗は無視します。Android の Chromium など Badging API を持たない端末もあるため、
  install の説明では badge を「対応した端末では」と条件付きで案内します。
  iOS / iPadOS のホーム画面 web app と macOS Safari の「Dock に追加」した web app は `setAppBadge()` を公開していますが、通知の許可がない限り badge を表示しません。
  そのため設定画面のインストール card は、installed な standalone app として動作し、badge の表示に通知の許可が必要な platform
  （Apple の WebKit。`navigator.standalone` の有無、iPhone / iPad / iPod の user agent、touch 対応の `MacIntel`、
  または Chromium / Edge / Opera / Firefox の token を含まない macOS Safari の user agent で判定）で、Badging API と `Notification` があり、
  `Notification.permission` が `default`（未回答）の場合だけ「アイコンのバッジを許可」button を表示します
  （`web/src/shared/lib/pwa/badgePermission.ts`）。`Notification.requestPermission()` は button の click handler から同期的に呼び、
  自動では要求しません。許可されると `refreshAppBadge()` でその tab の session が未読数を取得し直して badge を再表示します。
  許可 / ブロック / 未選択 / 確認できない（API がない・browser が拒否した）の結果は `role="status"` で通知し、
  button が消える場合もフォーカスを結果へ移します。再試行の開始時に前回の結果を消すため、同じ結果（未選択の繰り返しなど）も再度通知します。
  端末の設定で通知を変更して再読み込みせずに戻った場合は、`focus` / `visibilitychange` と、対応する browser では
  Permissions API の `change` で許可状態を読み直し、一致しなくなった結果を消します。許可に変わった場合は結果を「許可」として通知し（フォーカスを持ち得る行を消さないため）、badge も再表示します。結果を表示中に取り消し / リセットされた場合も、結果を消さずに「ブロック」/「未選択」へ置き換えて通知します。
  許可済みまたはブロック済みの端末では再度尋ねません。以前にブロックした端末では、再読み込み後も現在の許可状態から
  「ブロックされているため端末の設定から変更できる」案内を表示します（尋ねず、live region やフォーカス移動も伴いません）。Windows / macOS / ChromeOS の Chrome・Edge など、通知の許可なしに badge を表示する
  platform では、不要な通知の許可を求めないよう button を表示しません。
  この app は push 通知を送信せず、通知の許可は badge の表示にだけ使うことを文言でも案内します。
- 表示言語: 更新通知は route の外にあるため、保存された locale 設定を購読し、言語切替に追従します。
- 更新: 新しい worker は既存ページを自動で奪いません。`待機中` になると画面下部に再読み込みの通知を出し、
  利用者が承認した時だけ有効化して再読み込みします。別 tab で既に有効化済みなら、そのまま再読み込みします。ページが visible に戻るたびに更新を確認します。

## Cache の安全境界

worker が保存するのは tenant に依存しない静的 build 成果物だけです。

| Request | 扱い |
| --- | --- |
| 同一 origin の navigation | network-first。保存しない。network 失敗時だけ `/offline.html` を返す |
| `/offline.css`、`/offline.js`、`/pwa-192x192.png` (query なし、GET) | install 時に `/offline.html` と一緒に precache し、cache-first で返す |
| 同一 origin の `/assets/*` (query なし、GET) | cache-first。200 の `basic` response だけを最大 120 件保存 |
| `/api/*`、`/v1/*`、`/developer/*`、その他 | 介入しない |
| GET 以外、`Range` 付き、cross-origin | 介入しない |

ページ HTML、API response、share link、request intake link は保存しません。cache の形式を変える場合は
`sw.ts` の `cacheLayoutVersion` を上げ、activate 時に旧 cache を削除させます。

`sw.js` は classic worker として登録するため、他 chunk を import できません。`src/service-worker/` を app
code から import すると共有 chunk が生まれるため、`vite.config.ts` の plugin が build を失敗させます。
app 側の skip-waiting message は worker model と重複定義し、unit test で一致を検証します。

## Hosting 要件

frontend の配信基盤 (CDK 外) は次を満たしてください。

- `/sw.js` を `Cache-Control: no-cache` (または `max-age=0`) で配信する。長期 cache すると更新が届きません。
- `/manifest.webmanifest` を `application/manifest+json` で配信する。
- `/sw.js`、`/manifest.webmanifest`、`/offline.html`、`/offline.css`、`/offline.js`、icon を SPA の index.html fallback 対象から除外する。
- CSP を導入する場合は `worker-src 'self'` と `manifest-src 'self'` を許可する。`offline.html` は inline の
  script / style を持たないため、`script-src 'self'` と `style-src 'self'` のままで再試行と自動再読み込みが動きます。

## Icon の生成

PNG icon は `web/src/assets/mukuroji-icon.svg` から `bun run pwa:icons` で再生成します。
Playwright の Chromium で描画するため、system の Chromium を使う場合は
`PWA_ICON_CHROMIUM_PATH` に実行ファイルを指定します。同じ Chromium では byte 単位で同じ出力になります。

| File | SHA-256 |
| --- | --- |
| `apple-touch-icon.png` | `51124bf9568990c58fa0b3f85498169cbc591965ad11532df5cf18ac5bc12266` |
| `pwa-192x192.png` | `b0db95a82269e2cc3b77d0aad790b4710cbef4e810fc9b677a9c98ff960b4629` |
| `pwa-512x512.png` | `06c5a3d6b9a26e3ca9d9013702f42dfc30e23309758ef982d7edea8a47f885bb` |
| `pwa-maskable-512x512.png` | `12b2f599a1c6c60d3c2811fd463b33fc188cd82cb72df20c7ebd5f0a961d71fd` |

## Rollback

worker の不具合で配信を止める場合は、`startAppServiceWorker()` の呼び出しを外すだけでは既存の登録が残ります。
次の内容の `sw.js` を同じ URL で配信すると、既存 client は次回の更新確認で自身の cache を消して登録を解除します。

```js
self.addEventListener('install', () => self.skipWaiting())
self.addEventListener('activate', (event) => {
  event.waitUntil((async () => {
    for (const name of await caches.keys()) {
      if (name.startsWith('mukuroji-')) await caches.delete(name)
    }
    await self.registration.unregister()
  })())
})
```

## 検証

```sh
bun run web:test      # request 振り分け、cache 削除、更新 controller、通知 UI
bun run web:e2e       # 通常の E2E の後に PWA の E2E も実行
bun run web:e2e:pwa   # production preview で manifest、offline fallback、cache 内容を検証
```

`web:e2e:pwa` は `playwright.pwa.config.ts` の `mobile-pwa` project で、Pixel 7 相当の viewport / touch で
`web/e2e/pwa.spec.ts` を実行します。`web:build` 後の `web:preview` に対して動くため設定を分けています。
`web:e2e:desktop` や `playwright test` は dev server だけを起動し、production build を必要としません。
