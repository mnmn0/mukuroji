# Installable PWA

mukuroji の Web は manifest と service worker を持ち、mobile / desktop へ install できます。
この文書は現在の範囲、cache の安全境界、hosting 要件を定めます。push、share target、
offline read cache、encrypted mutation queue は Issue #38 の後続範囲です。

## 現在の範囲

- `web/public/manifest.webmanifest`: `start_url` は `/home`、`display` は `standalone`。
  192px / 512px / maskable 512px の PNG icon と、マイタスク・インボックス・フォーカスへの shortcut を持ちます。
- `web/src/service-worker/sw.ts`: Vite の別 entry として build し、site root の `/sw.js` に出力します。
  production build かつ secure context の場合だけ `window.load` 後に登録します。開発 server では登録しません。
- install: browser 標準の install UI (Chromium の address bar / menu、iOS Safari の「ホーム画面に追加」) を使います。
  `beforeinstallprompt` を使う独自の install 導線は後続範囲です。
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
