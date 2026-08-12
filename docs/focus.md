# Focus queue

Focus は「今も解消していない注意事項」を利用者ごとに並べる read model です。通知 Inbox のような出来事の履歴ではなく、現在参照できる canonical Work Item、Planning dependency、Approval、mention notification、watch 状態を request ごとに再評価します。

## Signal と解消条件

1つの利用者・Work Item を1つの Focus item とし、同じ原因から届いた event は cause ID で重複排除します。v1 は次の signal を扱います。

| Signal | Canonical source | 解消条件 |
| --- | --- | --- |
| `blocker` | canonical `blockedBy` relation / Planning の incoming Work Item dependency | relation/dependency の削除、または predecessor の完了・キャンセル |
| `urgent` | Work Item の `high` priority | priority の変更、または Work Item の完了 |
| `overdue` / `due-soon` | canonical schedule / due date | 期限変更、または Work Item の完了 |
| `approval` | Work Item approval summary | pending approval の判断・取消 |
| `review-request` | reviewer projection | 現在 reviewer の判断完了・取消 |
| `mention` | permission-filtered notification event | source の削除、または対象 Work Item の完了 |
| `sla` | Work Item 作成時刻と effective policy | Work Item の完了、または SLA window 内への復帰 |
| `cycle` | Planning Work Item link と cycle forecast | cycle 変更、または Work Item の完了 |

各 signal は source ID/event ID、原因が実際に生じた日時、再評価時刻、存在する場合は source revision、解消条件、source を開ける現在権限を返します。priority、期限、approval は aggregate 全体の汎用更新時刻ではなく、それぞれの causal timestamp を使います。移行前の Work Item に field-specific timestamp がない場合だけ、無関係な後続編集で原因を新しく見せないよう `createdAt` へ保守的に fallback します。relation/dependency、review request、mention、cycle は source 自身の作成時刻・event ID・revision を保持します。画面はこの情報から「なぜ入ったか」と「何をすれば消えるか」を表示し、独自の順位計算は行いません。

response の `metrics.blocked` は個人 queue への採否とは分け、現在の利用者が参照できる全 active Work Item の実 relation/dependency から算出します。priority を blocker の代用にはしません。

## 順位と section

順位は effective policy の weight による contribution の合計です。tie は score 降順、最短期限、古い発生時刻、Team ID / Work Item ID の順で決定し、同じ snapshot では常に同じ順になります。policy は product default、Team override、personal override の順で疎な override を合成し、response に base / Team / resolved settings、weight、contribution、fingerprint、provenance を含めます。個人 policy は本人、Team policy は現在その Team を管理できる利用者だけが version 付きで更新します。

- `Now`: 閾値以上で、現在実行できる作業
- `Next`: signal はあるが Now の閾値未満の作業
- `Waiting`: blocker や外部の判断待ちだけで、現在の利用者が進められない作業
- `Snoozed`: 現在の cause fingerprint に対する snooze 期限内の作業
- `Done`: 完了・キャンセル状態で、canonical最終更新から30日以内の短期表示

snooze は Work Item ID だけでなく cause fingerprint に束縛します。期限・dependency・review request などの原因が変わって再発した signal は、古い snooze に隠れません。

Focus item の `version` は Work Item snapshot、signal、rank、effective policy、capability、snooze、watch の状態から安定した canonical hash を作り、評価時計だけの変化では更新しません。snooze row の CAS には独立した `snoozeRevision` を使うため、古い client が新しい原因を隠したり、解除済み snooze を上書きしたりできません。

## API と永続化

```text
GET /api/focus
PUT /api/focus/policies
PUT /api/focus/items/{teamId}/{workItemId}/snooze
PUT /api/focus/items/{teamId}/{workItemId}/watch
```

complete、assign、status、schedule は canonical Work Item API、watch は Collaboration API と同じ正本を利用します。Focus 固有の Team/user policy と snooze だけを `FocusTable` に保存します。table は delimiter-safe な Workspace scope を含む `scopeKey` / `recordKey`、PITR、retain、期限行の TTL を使用し、通知 timeline や canonical Work Item row には混在させません。snooze は現在時刻から365日以内だけを受け付け、解除後も CAS history を90日保持します。

3つの `PUT` は `Idempotency-Key` を必須とし、同じ利用者・method・path・body の再送では compact な成功 outcome と現在の認可済み state を照合して応答を再構成します。同じ key を異なる payload に使った場合や、初回成功後に権限・policy・Work Item・signal・snooze・watch state が変わった場合は `409` または `403` で fail closed し、古い response body は保存・再公開しません。

## Bounded read

Focus は部分的な queue を正常応答として隠しません。Workspace aggregate は最大20 Team、全体200 Work Item、各 Team partition 1,000 rowを上限とし、超過時は既存の Work Item aggregate と同じ `413` で fail closed します。source ごとの上限は次のとおりです。

- reviewer approval: 100件 × 4 page、全体400件
- mention notification: state filterごとに50件 × 4 page、過去90日、全体200件、Work Itemごと10件
- recipient snooze/tombstone: 250件 × 4 page、全体1,000件

上限到達時に continuation が残る場合、または cursor が進まない場合は `503` とし、欠けた source で順位や件数を確定しません。watch state は16件ずつの bounded batch で読みます。

## 権限と Inbox の分離

Focus は、既存の Work Item aggregate readに加え、Planning と approval は各 source の `planning.read` / `files.read`、mention は notification visibility filterを通過した情報だけから組み立てます。source 権限がなければその signal 自体を省き、識別子や期限も返しません。GET と mutation のたびに現在権限と Work Item revision を再評価するため、Project 移動、membership 無効化、permission loss 後の item や signal は返しません。watch は Focus read 権限だけでは実行できず、Workspaceが書き込み可能で、対象 Work Item の現在の `work-items.write` も必要です。

Inbox は immutable event の履歴として read/archive/snooze を保持します。Inbox の状態変更は Focus signal を解消しません。同じ notification event は `eventId` で Focus signal と関連付け、Inbox から該当 Work Item の Focus item、Focus から認可済み source へ相互に遷移できます。
