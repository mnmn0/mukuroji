# 0082. 通知 Email の digest を配信時にまとめ、SES の bounce・complaint を EventBridge と SQS で受けて宛先を止める

- 状態: 提案
- 日付: 2026-11-24
- 関連: Issue #351、ADR 0005（一部を置き換え）、ADR 0081

## 背景

ADR 0005 の Email 配信は frequency（hourly / daily / weekly）を配信予定の遅延として扱うだけで、通知ごとに
1 通送っていた。Issue #351 の完了条件は「daily digest が 1 通にまとまる」ことと「bounce した宛先が suppression
され、運用者が確認できる」ことで、どちらも足りなかった。bounce と complaint は SES の account-level suppression
list に任せていたが、アプリからは止まったことが見えず、配信は成功扱いのまま SES に捨てられていた。

制約は次のとおり。

- 配信予定・lease・再認可・quiet hours・再試行は ADR 0005 の queue をそのまま使い、table と GSI を増やさない。
- scheduled-jobs Lambda の role は managed policy が上限の 10 個に達している（ADR 0081）。
- SNS topic は今の stack に 1 つもなく、alarm 通知の topic も運用者が外から渡している。
- アドレスは保存しない。ログにもアドレス・recipient key・本文を出さない。
- AWS 環境はまだなく、検証はエミュレータで行う。

## 決定

### digest

- 通知 row に既に書いている `deliveryFrequency` を配信 queue の読み取り結果に含める。instant 以外の row が
  期限に達したら、それを「まとめの起点」にして、同じ recipient のほかの instant 以外の Email row を同じ shard
  から集め、1 通の digest として送る。期限前の row も、`pending` で一度も試行していないものは含める（起点の
  遅延の間にたまった通知を一緒に送るため）。再試行の待ち中や他の worker の lease 中の row は含めない。
- 集めるのは sparse GSI `EmailDeliveryIndex` の同じ shard を、起点の時刻から 8 日先までの範囲で recipient key で
  絞って読む（1 MB の page を最大 10 page）。1 通に入れるのは 50 件までで、残りは次の実行で送る。page を
  使い切っても shard の終わりに届かなかった場合と、壊れた row があった場合は、見つけた分を送ったうえで job を失敗にして知らせる。
- 各 row は単独の送信と同じく 1 件ずつ claim し、試行回数・保持期限・opt-in・種類とミュート・再認可・quiet hours・
  snooze を確かめる。通らない row はその場で終える。送信直前に全 row の lease を延長し、延長できた row だけを
  本文に入れ、SES の結果（送信済み・再試行・失敗）を全 row に同じく記録する。延長が25秒を超えたら、最初の
  lease（60秒）が送信（最大30秒）中に切れないよう、送らずに lease を返す。
- claim の条件に「自分の channel の期限内の lease がない」を足す。期限前の row を読むようになったため、他の worker が
  lease 中の row を取らないようにする。
- digest は Email だけに適用する。Slack と Web Push は通知ごとに送る。

### bounce と complaint

- stack に SES の configuration set を 1 つ作り、bounce と complaint の event を EventBridge の default bus に出す。
  rule が `ses:configuration-set` tag でこの set の event だけを SQS queue（SQS 管理の暗号化、5 回で DLQ）へ送る。
- Email job は configuration set を指定して送り、message tag `mukuroji-recipient` に recipient key の base64url を
  付ける。IAM の `ses:SendEmail` は configuration set の ARN も対象にする。
- 毎分の scheduled job `email-feedback` が queue を読み、permanent bounce と complaint（`not-spam` を除く）を
  Notifications table の `<recipientKey>` / `!EMAIL_SUPPRESSION` row に記録する。保存するのはアドレスの SHA-256、
  理由、時刻だけで、古い event は新しい記録を上書きしない。transient の bounce、tag のない mail は何もしない。
  読めない event は queue に残し、DLQ と alarm に回す。権限は文が 2 つなので shared role の inline policy に置く。
- Email job は宛先を読んだ後に suppression を読み、ハッシュが今のアドレスと一致すれば `EmailRecipientSuppressed`
  で抑止する（alarm は出さない）。アドレスを変えた場合と、記録の後に Email を無効にしてから有効にし直した場合
  （`emailEnabledAt` が新しくなる）は送る。configuration set でも SES の suppression list を有効にし、同じアドレスで
  再開するときは運用者が SES から外す（外さなければ SES の bounce でまた記録される）。recipient key が SES の
  tag 値の上限（256文字）に収まらない宛先は tag なしで送り、SES の suppression list だけに任せる。
- 運用者は `EmailRecipientSuppressed` ログ、`Mukuroji/Notifications` の `EmailSuppressions` metric、row の
  `emailLastCode` で確認する。

## 検討した選択肢

- 配信予定を frequency の窓（毎時 0 分、毎日 9 時など）にそろえて書く: projection と delivery plan の両方を
  変える必要があり、既存 row は窓がそろわない。配信時にまとめれば既存 row もそのまま digest になる。
- recipient ごとの digest 用 row を別に持つ: 通知 row との 2 重管理になり、再認可や snooze を row ごとに
  確かめられない。
- SES → SNS topic → Lambda: SNS topic の暗号化と SES 用の key policy、新しい Lambda と runtime control の
  面が増える。EventBridge → SQS → 既存の scheduled-jobs なら、topic も Lambda も増えない。event の中身は同じ。
- SES の account-level suppression list だけに任せる: 送らないことは同じだが、アプリでは送信済みに見え、
  運用者も利用者の設定画面も止まったことを知れない。

## 結果

- hourly / daily / weekly を選んだメンバーは、最初の通知から frequency の時間が過ぎると、それまでにたまった通知を
  1 通で受け取る。instant は従来どおり 1 通ずつ。
- permanent bounce と complaint の宛先には送らなくなり、row の状態とログで確かめられる。
- SES の configuration set・EventBridge rule・SQS queue と DLQ、DLQ の alarm が 1 つずつ増える。GSI と table は
  増えない。
- 他の機能から Email に送る境界は、新しい outbox を作らず、既存の audit outbox event → collaboration projection → 配信 queue とする（Analytics の定期配信 `analytics.report.delivered` が既にこの形で、#348 の定期配信もこれで代替済み）。Update Feed の Inbox digest（#241）は in-app 専用の設計のまま Email に載せない。
- 更新した文書: `docs/notifications.md`、`docs/operational-readiness.md`、`docs/guide/member.md`、`cdk/README.md`。
