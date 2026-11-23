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
  - 承認・却下した人と日時を `reviewedBy` / `reviewedAt` に残す。
- 既存の `PUT` で日付を変えた休暇は、送った状態（本人なら `planned`）に戻る。承認済みの休暇を本人が変えたら、承認し直しになる。
- snapshot の member 行に、表示開始日以降に終わる `canceled` 以外の休暇を返す。理由（`reason`）は本人と confidential を見られる人にだけ返す。
- snapshot に `viewer`（自分の member ID と Team manager かどうか）を返し、画面は承認ボタンや確定ボタンの表示に使う。権限の判断は API が行う。

### 割当の確定

- cell に、仮（`tentative`）の割当の分だけを `tentativeAllocatedMinutes` として返す（`allocatedMinutes` には仮も含む）。
- 依頼を取り消すときに `cancelAssignments: true` を送ると、その依頼を埋める割当を同じ書き込みで取り消す。
  confidential を見られない manager が、見えない confidential の割当を巻き込む取消は `409` で断る。

### 監査と通知

- 休暇・依頼・割当の変更を、Team の record の Put と同じ TransactWrite で shared audit event（entity type
  `team-workload`、entity ID は Team ID、event type は `workload.time-off.*` / `workload.request.*` / `workload.assignment.*`）に書く。
  休暇の理由と confidential な依頼のタイトルは差分で伏せる。
- 通知は既存の audit projection に任せる。休暇の変更は本人へ（理由 `time-off-review`）、割当の変更は割当の前後のメンバーへ
  （理由 `workload-assignment`、通知の分類は「割り当て」）、metadata の `notificationCandidates` で知らせる。操作した本人には送らない。受け手の権限は projection が
  Team（割当に Project があれば Project）で確かめる。
- 監査を書く書き込みだけ TransactWrite にする。IAM は既存の capacity table の `PutItem` と audit table の書き込み権限で足りる。

### row の整理

保存のたびに、次の row を Team の record から消す。

- `canceled` / `rejected` の休暇・割当と `canceled` の依頼で、終了日から 30 日を過ぎたもの
- 状態にかかわらず、終了日から 400 日を過ぎたもの（snapshot の最大期間 366 日より長い）
- ただし、残る割当が参照する依頼は残す

整理は別の job を作らず、書き込みの中で行う。書き込みのない Team の record は小さいままなので問題にならない。
監査ログには変更が残るので、消した row の履歴は audit から辿れる。

## 検討した代替案

- **`planned` も引き続き capacity から引き、承認済みとの差だけを表示する**: issue の完了条件（承認済みだけを引く）に合わない。
- **却下を `canceled` で表す**: 本人の取り下げと manager の却下を区別できず、本人への通知の文面も分けられない。
- **整理を定期 job で行う**: Team の record を走査する Lambda と schedule が増える。書き込みのたびに整理すれば record が上限に近づくことを防げる。
- **row ごとの item に分ける（#342 の保存形の分割）**: ADR 0068 で見送った。今回も record の形は変えない。

## 影響

- 以前 `planned` で登録した休暇は、deploy 後は capacity から引かれず「承認待ち」になる。manager が承認すると以前と同じ値になる。
  data migration は行わない（状態はそのまま正しい意味で読める）。
- `WorkloadCell` と `WorkloadMemberSummary` に必須の field が増える。Web と server は同じ deploy で更新する。
- 30 日を過ぎた取消済みの依頼は一覧から消える。
