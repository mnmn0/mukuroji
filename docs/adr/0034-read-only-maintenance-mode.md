# 0034. Runtime control に `read-only` mode を足し、API の入口で HTTP method と読み取り用 POST の一覧で変更を断る

- 状態: 提案
- 日付: 2026-11-21
- 関連: Issue #435, Issue #365（migration 中の書き込み停止）, PR #615（runtime control の切り替え command）

## 背景

AppConfig の runtime control は `enabled` / `disabled` の 2 値で、本番 migration や障害対応で書き込みを
止めたいときは読み取りも一緒に止まる。利用者には runtime control の `503` が障害なのか計画した maintenance
なのか分からず、編集中の内容を失う不安がある。

## 決定

- Runtime control document の `mode` に `read-only` を足す。AppConfig の JSON Schema validator、server の
  parser、operator script（`bun run runtime-control:read-only`）が受け付ける。
- `read-only` のとき API の runtime-control middleware（authentication・route より前）は次だけを通す。
  - `GET` と `HEAD`。
  - `server/src/app/middleware/read-only-request-registry.ts` に列挙した `POST`（sign-in、MFA challenge、
    token の更新、logout、SSO の開始と交換、Analytics query、各 preview）。照合には Hono の `TrieRouter` を使い、
    route と同じ path 規則で一致させる。
- それ以外の method と列挙していない `POST` は、`503`、`Retry-After: 15`、problem `code`
  `maintenance_read_only` で断る。新しい変更 route は一覧に足さなくても断られる（fail closed）。
- Worker、WebSocket、`/api/ready` は `read-only` を `disabled` と同じく扱う。background の処理は変更を伴い、
  ready は「新しい traffic を全面的に受けられる」ことを表すため。
- operator が配布した `disabled` は problem `code` `maintenance` で返し、AppConfig の取得失敗や不正 document の
  `temporarily_unavailable` と区別する。Public API（`/api/v1/`、`/api/developer/`）は problem `code` が公開済みの
  閉じた enum なので `temporarily_unavailable` のまま返し、header と `detail` で maintenance を伝える。maintenance の response には `Mukuroji-Maintenance` header
  （`read-only` / `stopped`）を付け、CORS で公開する。
- `GET /api/maintenance` を middleware の中で認証なしに答え、`none` / `read-only` / `stopped` / `unavailable`
  を返す。Web と operator script が使う。値は `contracts/src/maintenance.ts` が所有する。
- Web は `fetch` を包んで header から状態を知り、画面上部にバナーを出す。表示中は 30 秒ごとに
  `/api/maintenance` を読み、終われば消す。保存に失敗した画面は入力を消さずに残すので（session 切れの 503 と同じ扱い）、バナーで
  「再読み込みせず待つ」よう案内する。

## 検討した選択肢

- 各 route（約 180 の `POST` と `PUT` / `PATCH` / `DELETE`）に「変更か」の宣言を付ける: 漏れたときに書き込みが
  通る。method で判定し、読み取り用 `POST` だけを列挙する方が漏れても止まる側に倒れる。
- DynamoDB の adapter 層で書き込みを止める: 付随する書き込みまで止められるが、全 repository を変える必要があり、
  途中まで処理してから失敗する。入口で断る方が理由を返しやすい。
- `read-only` でも worker を動かす: 通知や同期は変更を伴い、migration 中に走らせたくない。却下。
- Web の maintenance 判定を `/api/ready` で行う: ready は DynamoDB も見ており、障害と maintenance を区別できない。

## 結果

- 閲覧と sign-in を続けたまま、利用者の変更だけを理由付きで断れる。
- 付随する書き込み（sign-in の rate limit、監査 event、sign-in 時の idempotent な membership 照合）は止まらない。
  書き込みを完全に止める必要がある作業では `disabled` を使う。
- `GET` / `HEAD` は HTTP の意味どおり読み取りとみなす。`GET` で付随して書き込む route があれば、その書き込みは
  read-only 中も行われる。
- この変更より前の code が動いている環境に `read-only` の document を配布すると、旧 parser は不正 document として
  扱い、fail closed（`disabled` 相当と configuration failure alarm）になる。API の deploy 後に使う。
- 読み取り用の `POST` を新しく足したときは、registry に足さない限り read-only 中は断られる。
- 操作の記録は PR #615 と同じく AppConfig の hosted version と deployment の description に残る。
  アプリの監査 log への自動保存は未実装のまま。
- 更新した文書: `cdk/README.md`、`docs/operational-readiness.md`、`docs/guide/member.md`、`docs/guide/admin.md`。
