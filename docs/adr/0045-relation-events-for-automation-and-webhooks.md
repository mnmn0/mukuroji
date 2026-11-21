# 0045. Work Item relation の event を Automation trigger と webhook の event type に使い、webhook の event type は追加していく

- 状態: 提案
- 日付: 2026-11-21
- 関連: Issue #377、PR #572・#661（relation の audit と blocker 解除の通知）、[ADR 0008](0008-audit-stream-two-readers-and-worker-secrets.md)、[docs/automation.md](../automation.md)、[docs/public-api.md の Signed webhook](../public-api.md#signed-webhook)、[docs/event-audit.md](../event-audit.md#work-item-relation-の-event)

## 背景

PR #572 と #661 で、Work Item の親子・blocker・関連 link の変更と兄弟の並べ替えは、両端の Work Item に
`work-item.parent-changed` や `work-item.blocker-removed` などの audit event として、relation と同じ
transaction で記録されるようになった。Issue #377 の残りは、これらを Automation の trigger と外部 webhook の
event type として使えるようにすることだった。

制約は 3 つあった。

- 相手の Work Item は、event を受け取る人や subscription 作成者が見られない Project にあることがある。
  そのため相手の ID は公開 view に出ない `metadata` にだけ保存している。
- Webhook の配信は event の `metadata.teamId` と `metadata.projectId` で作成者の現在の権限を確かめる。
  ところが relation の event は `work-item.blocker-removed` 以外 `projectId` を持っていなかった。そのまま
  webhook に流すと、Project に割り当てられた Work Item の変更が Team だけの権限で配信されてしまう。
- Public API の互換チェック（`scripts/check-public-api-contract.ts`）は response の enum が広がることを
  破壊的変更として拒否する。`WebhookEventType` は subscription と delivery log の response に出るので、
  event type を足すとこのチェックが落ちる。

Shinji の方針は「なるべく安く」で、常時動く resource は増やさない。

## 決定

- relation の audit event は、記録する側の Work Item が Project に割り当てられていれば `metadata.projectId`
  を持つ。値は同じ transaction の endpoint guard（`assignedProjectId` の条件）が確かめた snapshot から取る。
  `work-item.blocker-removed` の通知もこの値を使う。
- Automation に `relation` trigger を足す。`eventTypes`（1〜10 件）で relation の event type を選び、省略すると
  すべての relation 変更で動く。event は既存の Audit stream reader（Automation 側、ADR 0008）がそのまま読む。
- Webhook の event type に 10 種の relation event を足す。payload は既存の公開 view で、相手の Work Item を
  含まない。配信の可否はほかの Work Item event と同じく、記録した側の Team と Project に対する作成者の
  現在の権限で決める。必要な scope は `work-items:read`。
- Webhook の event type は今後も追加するものとし、consumer は知らない `type` の delivery を `2xx` で受けて
  無視する、と `docs/public-api.md` に書く。event type の一覧は contracts の `WEBHOOK_EVENT_TYPES` 1 か所に
  置き、server の検証はそこから読む。

## 検討した選択肢

- relation の event を 1 種類の `work-item.relation-changed` にまとめて webhook に出す: 追加する enum 値は
  1 つで済むが、Automation と audit が使う名前とずれ、consumer が中身で分岐する必要がある。互換チェックが
  落ちることは変わらない。
- 相手の Work Item も payload に入れ、配信時に作成者が相手も見られるか確かめる: 外部連携には便利だが、
  1 event につき権限確認が 2 回になり、片方だけ見られる場合の扱いも決める必要がある。今回は入れず、
  必要になったら別の判断にする。
- webhook の配信時に Work Item を読み直して Project を決める: 古い event にも効くが、配信ごとに Work Item の
  read が増える。新しい event は transaction で確かめた値を持てるので、書き込み側で入れる方を選んだ。
- webhook は見送り、Automation trigger だけ入れる: 互換チェックの問題は避けられるが、Issue #377 の範囲が残る。

## 結果

- 「blocker が外れたら担当者に通知」「親が変わったら外部の課題管理に知らせる」といったルールや連携が、
  新しい常時起動の resource なしで作れる。
- relation の変更が Project に割り当てられた Work Item で起きた場合、その Project を見られない作成者の
  webhook には配信されない。
- この変更より前に書かれた relation の event は `projectId` を持たない。webhook の projection は Audit stream の
  新しい INSERT だけを読むので、古い event が配信されることはない。
- Public API の互換チェックは、`WebhookEventType` への値の追加を一度だけ受け入れる必要がある（扱いは PR で決める）。
- 更新した文書: `docs/automation.md`、`docs/public-api.md`、`docs/event-audit.md`、`docs/guide/admin.md`。
