# 0079. GitHub の pull request は GitHub App の webhook を合図に読み直し、Planning table に snapshot として置いて Team の閲覧権限で見せる

- 状態: 提案
- 日付: 2026-11-28
- 関連: Issue #775, Issue #827, [docs/github-integration.md](../github-integration.md), [docs/architecture.md](../architecture.md)

## 背景

#775 は、自分が作った pull request とレビューを頼まれた pull request を mukuroji の「Reviews」画面にまとめ、
CI の失敗・conflict・レビュー依頼を受信箱に届けることを求めている。GitHub の情報を読むには認証が要り、
個人の token を預かると退職・権限の変更・漏えいの扱いが重くなる。webhook は届かないことも、順序が入れ替わることも、
偽装されることもある。Shinji の方針は「なるべく安く」で、まだ初回 deploy 前である（#636）。#827 も同じ GitHub App と
受け口を使う予定である。

## 決定

- **認証は GitHub App 1 つ**：Workspace に 1 つの App を Shinji が作り、App ID・秘密鍵・webhook secret を
  Secrets Manager の `GitHubAppSecret` に入れる。秘密鍵は RSA に限る。App JWT（RS256、有効 10 分）で installation token を
  発行し、期限の 5 分前まで使い回す。個人の OAuth token は預からない。Secret が placeholder のままなら全 runtime が
  「未設定」として扱い、webhook は `404`、reconcile は何もしない。webhook secret の入れ替えのため `previousWebhookSecret` も
  受け付ける。
- **webhook は合図だけにする**：`X-Hub-Signature-256` を body の解析前に定数時間で照合し、body は 5 MiB まで。
  中身は信用せず、installation・repository の ID と pull request の番号（または commit SHA・branch）だけの job を
  SQS（`GitHubSyncQueue`）に積んで `202` を返す。worker は repository の link と installation が一致するときだけ、
  GitHub の GraphQL から今の状態を読み直して保存する。`mergeable` が未計算なら 30 秒×回数だけ遅らせて最大 4 回読み直す。
- **保存先は Planning table**：新しい table は作らない。行は Workspace の pk の下に置く。
  - `GITHUB_REPOSITORY#<repositoryId>`：repository と Team の link（installation を固定、revision 付き）
  - `GITHUB_LOGIN#<小文字の login>` と `GITHUB_MEMBER#<member>`：member が自分で登録する GitHub login（1 login を 1 人に限る）
  - `GITHUB_PULL_REQUEST#<repositoryId>#<番号>`：pull request の snapshot（`syncedAt` が新しいときだけ上書き）
  link と login の変更は audit event を同じ transaction で書く。
- **取りこぼしは毎時の reconcile で直す**：EventBridge が 1 時間ごとに、link 済み repository の open な pull request と、
  保存済みで open のまま古い snapshot を読み直す。open な一覧は 1 repository につき 500 件まで pagination で読み、一覧に
  出なかった保存済みの open は番号で読み直す。link を外した repository の snapshot と、閉じて 30 日たった snapshot は消す。
  消すときは読んだ版と同じ `syncedAt` の行だけを消し、その間に同期が書いた新しい行は残す。
- **見せる範囲**：repository は Workspace 管理者が Team に link したものだけを扱う。Reviews の一覧は、閲覧者が読める
  Team に link された repository の pull request だけを返す。GitHub 側の閲覧権限ではなく mukuroji の Team の権限で絞る。
- **CDK は任意 module**：context `mukuroji:githubApp=true` のときだけ secret・queue・DLQ・worker・reconcile・alarm を作る。
  Runtime control は既存の `connector-sync`（queue worker）と `connector-poll`（reconcile）の surface に乗せる。

## 検討した選択肢

- member ごとの OAuth token で GitHub を読む：GitHub 側の権限がそのまま使えるが、token の保管・失効・退職の扱いが要る。却下。
- webhook の payload をそのまま保存する：読み直しの API 呼び出しは減るが、順序の入れ替わりと payload の偽装・欠落に弱い。却下。
- 専用の DynamoDB table を作る：tenant export と整合性検査に table を足す必要がある。行数は repository と open な
  pull request の数に比例して小さいので、Planning table で足りる。却下。
- poll だけにする：webhook の受け口は要らないが、レビュー依頼の通知が最大 1 時間遅れる。却下。

## 結果

- Shinji が GitHub App を作り secret を入れるまで、何も動かない（[docs/github-integration.md](../github-integration.md) の手順）。
- 費用は webhook 1 件につき Lambda 2 回と SQS 1 件、毎時の reconcile 1 回。link する repository が少なければ無料枠に収まる。
- Reviews 画面・個人設定・管理画面・受信箱の通知は続く PR で足す。#827 の取り込みも同じ App と受け口を使う。
- 更新した文書：`docs/github-integration.md`、`docs/architecture.md`。
