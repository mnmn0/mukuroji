# 0078. 変更要求の承認は、日程の連鎖とベースラインの差し替えを既存の API で順に行い、判断を最後に記録する

- 状態: 提案
- 日付: 2026-11-23
- 関連: Issue #344、ADR 0016、ADR 0024、ADR 0043

## 背景

#344 では、承認された変更要求を baseline と Work Item の日程に反映し、却下したときは何も変えないことが完了条件になっている。
変更要求は Project の登録簿（ADR 0024、Planning table の1登録1行）にある。

日程の連鎖は Work Item の schedule confirm（preview で出した impact と完全一致したときだけ、関連する Work Item を
1つの TransactWrite で更新する）が持っている。ベースラインの差し替えは schedule baseline capture（ADR 0016・0043）が持っている。
どちらも自分で TransactWrite を送り、外から item を足す口がない。

さらに、日程の更新は Work Item ごとに active baseline 行の revision を ConditionCheck する。
そのため、同じ transaction で baseline を差し替えると同じ item を2回扱うことになり、DynamoDB が拒否する。
連鎖で最大 24 件 × 3 item に baseline の item を足すと、100 item の上限にも近い。

## 決定

- 変更要求に `scheduleChanges`（関連 Work Item ごとに `move` か `resize` を1つ、最大10件）を持たせる。
  対象は `relatedWorkItemIds` の中の Work Item に限る。リスク・課題には持たせない。
- 承認・却下は `POST /api/teams/:teamId/projects/:projectId/raid-log/entries/:entryId/decision`
  （`{ expectedRevision, outcome, baselineId? }`）で記録する。判断は登録を close し、`decision`
  （outcome・日時・判断した member・差し替えた baseline）を残す。判断済みの登録は更新できない。
- 判断できるのは Project のマネージャーだけにする（baseline の capture と同じ）。Enterprise では Project に対する `projects.manage` で判定する。
- 承認の操作は Web が次の順で行う。
  1. `POST .../entries/:entryId/approval-hold`（`{ expectedRevision }`、マネージャーだけ）で変更要求に承認中の保留
     （`approvalHold`: 保留した member・開始日時・期限）を付ける。revision が上がる。ほかの人が先に編集・判断・クローズしていたら
     （revision が違うか open でない）、日程に触れずに衝突として止める。保留は 10 分で切れる。
     期限内は、保留した本人以外の却下・編集・保留を `409 ProjectRaidChangeRequestHeld` で断る。本人は保留を延長できる。
     承認の判断は、判断する本人の保留が付いた revision でしか記録できない（`409 ProjectRaidApprovalHoldRequired`）。
     期限を過ぎても revision が変わっていなければ（誰も却下・編集していなければ）承認できる。期限後にほかの人が却下・編集すると
     revision が変わり、承認は衝突として止まる。編集と判断は保留を外す。保留は Public API には出さない。
     Web は日程を当てる2巡目以降の各巡と capture の前に、直前の revision で保留を延長する。延長が断られたら（期限後にほかの人が
     却下・編集・保留した）、そこで止めて次の日程に触れない。
  2. 各 `scheduleChanges` を、Work Item 画面と同じ preview → confirm で適用する。関連 Work Item が別の Project に
     移っていたら止める。すでに反映済みのものは飛ばす。依存のある Work Item 同士では、適用の順番や後の連鎖で
     結果が変わるため、全件を適用したあと全件が要求どおりの日付かを確かめる。外れたものがあれば、もう一巡適用する。
     件数より多く巡っても全件がそろわなければ、衝突として止める。
  3. 指定があれば、反映後の計画を `変更要求: <件名>` という名前で baseline に capture する。
  4. 判断を記録する。保留で上がった revision を `expectedRevision` にする。approve で `baselineId` を渡した場合、server はそれが Project の active baseline であることを確かめる。
     判断の応答が失われたとき（5xx や通信の失敗）は、次の操作で日程と capture をやり直さず、同じ判断を
     同じ Idempotency-Key で送り直す。承認と却下のどちらを押しても、先に送った判断の結果がわかるまでは
     その判断を送り直す。結果のわからない却下のあとに承認を押しても、日程は変わらない。
- 却下は判断の記録だけで、日程と baseline には触れない。

## 検討した選択肢

- 保留なしで、承認の前に登録を読み直すだけにする: 日程の反映中にほかのマネージャーが却下すると、却下は記録されるが
  反映済みの日程は戻らず、「却下では何も変えない」が守れない。
- 承認中は保留する代わりに、却下の制約を文書に書くだけにする: 実装は軽いが、上と同じく完了条件を満たさない。

- 承認・日程更新・baseline 差し替えを1つの TransactWrite にする: 上の同じ item の二重チェックと 100 item の上限に当たる。
  schedule confirm と baseline の store を分解して組み直すことになり、既存の idempotency と conflict 判定の書き直しが大きい。
- Server が承認の中で手順を進める（saga）: 失敗時の再開を server に持たせられる。ただし既存の route 内にある
  schedule confirm の手順を共有用に切り出す必要があり、今回の範囲を超える。
- 既存の承認フロー（file / Work Item の approval）を使う: subject が file version と Work Item に限られていて、
  Project 単位の対象を足すには scope・権限・通知の拡張が要る。

## 結果

- 承認中の保留で、承認が日程を動かし始めてから判断を記録するまで、ほかの人の却下・編集は入らない。
  保留した人が途中で画面を閉じた場合は、期限が切れるまでほかの人は待つことになる。
  保留の確認は Work Item の日程の書き込みと同じ transaction ではない。1巡（最大 10 件の preview と confirm）が 10 分を超え、
  その間に期限が切れてほかの人が却下した場合だけ、その巡の日程が残りうる。
  また、承認が途中で失敗したあとに保留した本人が却下すると、反映済みの日程はそのまま残る（自動では戻さない）。
  ガイドでは、その場合は Work Item で日程を戻すよう案内する。
  保留の付与・延長は `raid_change_request_approval_held` として監査に残る（member key は残さない）。
- 手順は原子的ではない。日程の反映後や capture 後に失敗すると、変更要求は open のまま残る。
  もう一度承認すると、反映済みの日程は impact がなくなるため飛ばされ、残りから進む。
- capture 後に判断の記録が失敗し、画面を開き直してから承認し直したとき、判断が 4xx で断られたあとに承認し直したとき、
  capture の応答が失われたが保存はされていたときは、もう一度 capture するため「変更要求: <件名>」の baseline が複数残る。
  比較の基準になるのは最後に capture したもので、判断はそれを指す。基準でないものは保存済みの 20 件の上限で
  古い順に消える（ADR 0043）。同じ画面で判断の応答が失われただけ（5xx や通信の失敗）なら、同じ baseline で送り直すので増えない。
- 各手順は既存 API の権限・conflict・audit をそのまま使う。日程の連鎖には member 権限が要り、
  capture と判断には Project のマネージャー権限が要る。
- 判断が指す baseline は記録用の参照で、後で別の baseline に切り替えても判断は書き換えない。
- 1件あたりのサイズは `scheduleChanges` 10件（ID 128 文字と日付）と `decision`・`approvalHold` の分だけ増える。
  300 件すべてが上限まで使っても、一覧の応答は Lambda の 6 MB に収まる。既存行は値を持たないだけなので、
  schema version は変えない。
