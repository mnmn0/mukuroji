# 0041. Document の変更を既存の WebSocket で通知し、画面の polling を間引く

- 状態: 提案
- 日付: 2026-11-21
- 関連: Issue #436、[ADR 0040](0040-xray-tracing-off-by-default.md)、[docs/documents.md](../documents.md)、[docs/collaboration.md](../collaboration.md)

## 背景

Document 画面は本文を 3.5 秒、comment と presence を 4 秒ごとに再取得していた。1 時間開いておくだけで
約 3,400 回の API request になり、既定構成の従量費の大半を占めていた（`cdk/README.md` の試算）。
Work Item の comment と presence には、API Gateway WebSocket と `RealtimeSessionsTable` を使った
scope ごとの invalidation が既にある。Shinji は 2026-11-21 に「WebSocket で変更を通知」する方式を選んだ。

## 決定

- Document 用の subscription ticket を `POST /api/documents/{documentId}/realtime/tickets` で発行する。
  ticket の発行は通常の Document API と同じ認証（Bearer token、Enterprise session の鮮度）と
  `canView` の判定を通った request だけに許す。scope key は `<workspaceId>#document#<documentId>`。
- Document の subscription は 5 分（token の有効期限が先ならそれまで）で失効させ、延長しない。
  client は失効の 30 秒前に新しい ticket で接続し直す。これで ACL の変更（private 化、share の削除、
  member の無効化）が最長 5 分で効く。
- realtime Lambda は接続時と fan-out ごとに、Team や Work Item に依存しない確認を Work Item の購読と
  同じように行う：member の active 状態、system admin の Cognito group、break-glass でない場合の SSO と
  provider binding、guest・外部 collaborator・deprovision の境界、外部 member には外部用の上限を使う
  Enterprise session の鮮度。Document の session からの typing・presence の送信は拒否する。
- API Lambda が変更後に `{type: 'document.changed', documentId, part, originClientId?, occurredAt}` を
  scope の接続へ送る。signal は本文・comment・名前を含まず、client は認可済みの HTTP API で取り直す。
  送信は best effort とし、失敗は log に残すだけで変更 request は成功させる。送信の待ちは最長 2 秒
  （Management API の client にも接続 1 秒・応答 2 秒の上限）とし、超えたら通知を諦めて応答を返す。
- presence の heartbeat（12 秒ごと）は lease の延長だけなら通知しない。client は参加直後と selection が
  変わったときだけ `announce: true` を付け、離脱（DELETE）は常に通知する。heartbeat ごとに通知すると、
  閲覧者 N 人では各閲覧者が 1 時間に約 300 × (N − 1) 回 presence を取り直し、5 人以上で従来の polling
  （4 秒ごと、約 900 回）を上回るため。
- client は受信専用の socket でも 30 秒ごとに `ping` を送り、接続の最終利用時刻を更新する
  （Workspace の idle timeout は最短 1 分のため）。
- client は接続中は本文・comment・presence の再取得を 60 秒ごとに落とし、接続がない環境（ローカル、
  WebSocket 未設定、接続断）では従来の polling に戻す。初回の接続と、接続が途切れた後に戻ったときは
  全部を取り直す（最初の読み込みから購読開始までの変更も拾うため）。

## 検討した選択肢

- presence を見て他の人がいないときだけ polling を遅くする：API だけで済むが、同時編集中は従来と同じ
  request 数になる。
- WebSocket で本文の差分を送る：request は最も減るが、message ごとの ACL 判定と本文の秘匿が必要になり、
  API Gateway の message 上限（128 KB）にも当たる。
- AppSync / IoT Core などの別 service：新しい service と費用が増える。既存の WebSocket API で足りる。

## 結果

- Document を 1 時間開いたときの HTTP request は、接続中は約 500 回（ticket 12 回、heartbeat、60 秒ごとの
  確認と変更時の再取得）に減る。別に WebSocket の ping が 1 時間 120 回（message 料金と realtime Lambda の
  実行）かかる。
- 同時閲覧者が N 人いるとき、presence の取り直しは他の閲覧者の参加・selection の移動・離脱の回数だけ
  増える。selection を 1 分に 1 回動かすとすると 1 人あたり 1 時間に約 60 × (N − 1) 回で、10 人でも
  約 540 回と従来の polling の presence 取得（約 900 回）より少ない。費用の試算は 1 人で開いている
  前提で、同時閲覧が多い Workspace ではこの分が加わる。
- API Lambda の role に WebSocket の `execute-api:ManageConnections` を追加し、runtime 設定に
  `WEBSOCKET_CALLBACK_ENDPOINT` を加える。
- signal の取りこぼしは 60 秒ごとの確認と再接続時の全取り直しで補う。整合性は従来どおり
  `expectedRevision` などの version 条件で守る。
- 更新した文書：`docs/documents.md`、`docs/collaboration.md`、`cdk/README.md`。
