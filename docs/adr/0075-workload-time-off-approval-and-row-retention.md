# 0075. 要員計画の休暇は承認済みだけを capacity から引き、取消済みと古い row を書き込みのたびに整理する

- 状態: 提案
- 日付: 2026-11-23
- 関連: Issue #390、Issue #342（Workspace 単位の要員管理、ADR 0068）

## 背景

要員の heatmap は、休暇が承認済みか、割当が確定か仮かで意味が変わる。これまでは休暇を `planned` で登録しても
`approved` と同じように available minutes から引いていた。承認されていない休暇でも空きが減るので、
manager が「空いていない」と判断した後に休暇が取り消されると、計画の根拠が変わる。
また、取り消した依頼・割当と過去の期間の row は Team ごとに 1 件の DynamoDB record（`CAPACITY#TEAM#<teamId>`、
400 KB 制限の手前で 413 を返す）に残り続ける。

## 決定

### 休暇の承認

- 休暇の状態に `rejected` を加え、`planned`（承認待ち）・`approved`・`rejected`・`canceled` の 4 つにする。
- available minutes から引くのは `approved` だけにする。`planned` は cell の `pendingTimeOffMinutes`
  （承認済みの休暇で残った空きを上限）として別に返し、heatmap で「承認待ち」と表示する。
- 日付を変えずに状態だけを変える `PATCH /api/teams/:teamId/workload/profiles/:memberId/time-off/:timeOffId` を足す。
  休暇自身の `revision` と Team の revision で楽観的排他を取る。
  - `approved` と `rejected`、および本人以外の休暇の変更は Team manager（Workspace owner / admin / システム管理者を含む）だけ。
  - 本人は自分の休暇を `canceled`（取り下げ）と `planned`（再申請）にできる。
  - 承認・却下した人と日時を `reviewedBy` / `reviewedAt` に、承認待ちにした日時を `submittedAt` に残す。
- この変更より前に保存された休暇は `planned` でも capacity から引かれていた。deploy で空きが急に増えないよう、
  `submittedAt` のない `planned` の行は読み取り時に `approved` として扱い、Team の次の書き込みでそのまま保存する。
  schema version は上げず、別の migration も行わない（読み取り時の既定で、旧版の値の意味を保つ）。
- 既存の `PUT` で日付を変えた休暇は、送った状態（本人なら `planned`）に戻る。承認済みの休暇を本人が変えたら、承認し直しになる。
- snapshot の member 行に、表示開始日以降に終わる `canceled` 以外の休暇を返す。理由（`reason`）は本人と confidential を見られる人にだけ返す。
- snapshot に `viewer`（自分の member ID と Team manager かどうか）を返し、画面は承認ボタンや確定ボタンの表示に使う。権限の判断は API が行う。

### 割当の確定

- cell に、仮（`tentative`）の割当の分だけを `tentativeAllocatedMinutes` として返す（`allocatedMinutes` には仮も含む）。
- 依頼を取り消すときに `cancelAssignments: true` を送ると、その依頼を埋める割当を同じ書き込みで取り消す。
  confidential を見られない manager が、見えない confidential の割当を巻き込む取消は `409` で断る。
- 巻き込む割当は依頼と別の Project やメンバーに属しうるので、API は割当ごとに単独の割当 PATCH と同じ確認
  （Project の manager 権限とメンバーの可視性）をしてから取り消す。確認した後に割当が増えていれば `409` で断る。

### 監査と通知

- 休暇・依頼・割当の変更を、Team の record の Put と同じ TransactWrite で shared audit event（entity type
  `team-workload`、entity ID は Team ID、event type は `workload.time-off.*` / `workload.request.*` / `workload.assignment.*`）に書く。
  休暇の理由と confidential な依頼のタイトルは差分で伏せる。
- 通知は既存の audit projection に任せる。休暇の変更は本人へ（理由 `time-off-review`）、割当の変更は割当の前後のメンバーへ
  （理由 `workload-assignment`、通知の分類は「割り当て」）、metadata の `notificationCandidates` で知らせる。操作した本人には送らない。受け手の権限は projection が
  Team（割当に Project があれば Project）で確かめる。Project のない Team の workload event は、要員 API と同じく
  Team の Project のどれか 1 つを読めれば外部チャネル（メール・push・Slack）にも配信する（Analytics の Team レポートと同じ扱い）。
- DynamoDB の transaction は 100 item までなので、1 回の書き込みの audit event は 99 件までにする。
  依頼の取消で巻き込める割当は 98 件までとし、超えるときは `413 ResourceRequestCascadeTooLarge` で断る（先に割当をいくつか個別に取り消す）。
  まとめた 1 件の event にすると、割当ごとの target で audit を検索・export できなくなるため。
- 割当をまとめて取り消すときの Project・メンバーの確認は、route が読んだ Team の revision が要求の `expectedTeamRevision` と
  一致するときだけ有効とする。違えば確認の前に `409 CapacityPlanningRevisionConflict` を返す。一致すれば保存は同じ revision を
  CAS 条件にするので、確認した割当と取り消す割当は同じになる。
- transaction の取消は、audit event の条件だけが失敗したとき（同じ idempotency key の再送）に `409 CapacityPlanningDuplicateRequest`、
  Team の revision が失敗したときに `409 CapacityPlanningRevisionConflict` を返す。throttling や transaction conflict は
  基盤のエラーのまま返し、記録して再試行できるようにする。
- 応答が失われた承認・却下の再送は、休暇がその要求の revision の次の版で、同じ判断・同じ承認者になっていれば、
  保存済みの休暇を成功として返す（書き込みも audit も増やさない）。そうでなければ従来どおり revision の 409 になる。
  Team の revision が要求の `expectedTeamRevision` より進んでいることも条件にする。
  休暇の状態そのものが durable receipt になるので、別の receipt 行は作らない。
  終了から 30 日を過ぎた休暇の却下は、同じ書き込みで行が消えて本人も再送も結果を見つけられないため、
  `400 WorkloadDateOutOfRetention` で断る（承認は 400 日まで残るので受け付ける）。
- 監査を書く書き込みだけ TransactWrite にする。IAM は既存の capacity table の `PutItem` と audit table の書き込み権限で足りる。

### row の整理

保存のたびに、次の row を Team の record から消す。

- `canceled` / `rejected` の休暇・割当と `canceled` の依頼で、終了日から 30 日を過ぎたもの
- 状態にかかわらず、終了日から 400 日を過ぎたもの（snapshot の最大期間 366 日より長い）
- ただし、残る割当が参照する依頼は残す

古い割当を消すと依頼の充足（`open` / `partially-filled` / `filled`）が変わりうるので、整理は変更を適用する前にも行い、
残った割当から充足を求め直す。変更の応答と audit は保存される状態と一致する。整理で変わった充足は派生値なので
依頼の revision は上げず、画面が読んだ revision のまま次の変更ができる。

終了日が 400 日より前になる休暇・依頼・割当の作成と日付変更は `400 WorkloadDateOutOfRetention` で断る。保存と同時に
整理で消える row を成功として返さないため。30〜400 日前の row を取り消す・却下するのは受け付け、その row は同じ書き込みで消える
（古い row を閉じる操作の結果として消えるのは意図どおり）。

整理は別の job を作らず、書き込みの中で行う。書き込みのない Team の record は小さいままなので問題にならない。
監査ログには変更が残るので、消した row の履歴は audit から辿れる。

## 検討した代替案

- **`planned` も引き続き capacity から引き、承認済みとの差だけを表示する**: issue の完了条件（承認済みだけを引く）に合わない。
- **却下を `canceled` で表す**: 本人の取り下げと manager の却下を区別できず、本人への通知の文面も分けられない。
- **整理を定期 job で行う**: Team の record を走査する Lambda と schedule が増える。書き込みのたびに整理すれば record が上限に近づくことを防げる。
- **row ごとの item に分ける（#342 の保存形の分割）**: ADR 0068 で見送った。今回も record の形は変えない。

## 影響

- 以前 `planned` で登録した休暇は承認済みとして読むので、deploy の前後で capacity は変わらない。
  取り消したい休暇は manager が「承認待ちに戻す」か、本人が取り下げる。
- `WorkloadCell` と `WorkloadMemberSummary` に必須の field が増える。Web と server は同じ deploy で更新する。
- 30 日を過ぎた取消済みの依頼は一覧から消える。
- `rejected` の休暇を保存した後に server をこの変更より前へ戻すと、古い reader は `rejected` を知らないため、その Team の
  要員計画が `500 InvalidCapacityPlanningState` になる。戻す場合は Web と一緒に戻し、却下済みの休暇を `canceled` に書き換えてから戻す。
