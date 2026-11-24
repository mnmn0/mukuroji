# 0068. 要員の負荷を Workspace の全 Team の record を合算して見せ、詳細は Team ごとの可視性で絞る

- 状態: 提案
- 日付: 2026-11-23
- 関連: Issue #342、#337（PR #734 の Workspace カレンダー継承）、ADR 0027

## 背景

capacity planning の state は Team ごとに DynamoDB の1 record（partition `workspaceId`、sort key
`CAPACITY#TEAM#<teamId>`）で、稼働プロファイル・time off・割り当てもすべて Team ごとに持つ。
同じメンバーが二つの Team に割り当てられ、合計で稼働可能時間を超えても、どちらの Team の画面にも出なかった。
Workspace の owner / admin が全メンバーの負荷を一覧する手段もなく、個人が複数 Team の工数をまとめて出す手段もなかった。

前提は安く作ること。想定規模は 50 人程度で、Team の record は 350 KB の byte budget に十分収まる。

## 決定

- 保存形は変えない。Workspace 横断の値は、Workspace partition を `begins_with(recordKey, 'CAPACITY#TEAM#')` の
  Query（ページング込み、強整合）で全 Team 分読み、その場で計算する。API role に capacity planning table の
  `dynamodb:Query` を足す。
- メンバーの Workspace 横断のキャパシティは、日ごとに「そのメンバーの各 Team の稼働プロファイルが与える値の最小」とする。
  どれかの Team で入れた休暇は全 Team で効く。Workspace カレンダーを継承するプロファイルは継承後の値で比べる。
- 割り当ての合計は、全 Team の取り消されていない割り当てを、各 Team の画面と同じ配り方（その Team のプロファイルで空いている日）で足す。
  機密の割り当てや見られない Team の割り当ても合計には含め、内訳には出さない。
- Team の workload snapshot の各 cell に `workspaceCapacityMinutes`・`workspaceAllocatedMinutes`・`workspaceStatus` を、
  メンバーに `workspaceOverloaded` を足す（既存 field の意味は変えない）。
- `GET /api/workload` は呼び出し元が見られる Team（Team route と同じ `requireTeamPermission` の viewer。guest は不可）だけを対象に、
  各 Team の既存の可視性（メンバーの allowlist、Project の allowlist、機密を見られるか）でメンバーと内訳を絞る。
  見られない分は `hiddenAllocatedMinutes` にまとめる。owner / admin は今の Team route と同じくすべてを見る。
- 個人の工数は、呼び出し元がメンバーの Team ごとに既存の Team timesheet submit と同じ処理を回す
  `POST /api/time-tracking/my-timesheet/submit` と、本人分だけを Team ごとに返す `GET /api/time-tracking/my-timesheet` で扱う。
  承認は各 Team の既存の流れのまま。

## 検討した選択肢

- 選択肢 A（採用）: 保存形を変えずに全 Team の record を読んで合算する。利点: migration なし、書き込み経路と CAS は今のまま。
  欠点: 横断 view と Team view の読み取りが Team 数に比例して重くなる。
- 選択肢 B: Workspace 単位のメンバープロファイルと、メンバー・期間で分割した割り当て row に移す。利点: 400 KB 制限に依存しない。
  欠点: migration と書き込み経路の作り直しが要り、今の規模では得るものが小さい。
- 選択肢 C: 他 Team の負荷を Team 管理者には一切見せない。利点: 情報が漏れない。欠点: 両 Team の画面で超過を出せず、issue の目的を満たさない。

## 結果

- 二つの Team の割り当てを合わせて超えるメンバーは、横断 view と両 Team の画面で `over` になる。
- Team 管理者は、自分の Team のメンバーについて他 Team の負荷の合計（内訳なし）を知ることになる。機密の中身は出ない。
- Team 外のメンバーを割り当てる依頼 → 承認の流れと、保存形の分割は作らない。Team 数・メンバー数が増えて Query が重くなるか、
  Team の record が budget に近づいたら選択肢 B を検討する。
- 更新した文書: `docs/capacity-planning.md`、`docs/time-tracking.md`、`docs/guide/pm.md`、`docs/guide/member.md`。
