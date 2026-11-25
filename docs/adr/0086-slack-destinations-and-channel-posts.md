# 0086. Slack の送信先を画面から登録し、Project・Team の channel 投稿を既存の Slack index に相乗りさせる

- 状態: 提案
- 日付: 2026-11-24
- 関連: Issue #399、ADR 0005

## 背景

Slack 配信は個人あての通知だけで、送信先の Incoming Webhook は管理者が受信者ごとに Secrets Manager の
`mukuroji/automation-webhooks/<sha256(workspace)>/slack/<sha256(member)>` へ手で登録していた。
社内の Team は Project ごとの chat channel で仕事をしているが、Project や Team の channel を送信先にする設定はなく、
通知の理由も内部の key（`assignee` など）のまま本文に出ていた。

制約は次のとおり。

- なるべく安く運用する。GSI・Lambda・外部サービスを増やさない。
- Webhook URL は secret なので、API response・log・audit・通知 row に出さない。
- 社内規模（1 Workspace に数十 Project）で、channel 投稿は 1 日に数十件程度。

## 決定

- 個人の送信先は、本人が設定画面から登録・テスト・削除する
  （`/api/notification-preferences/slack-destination`）。secret 名は従来と同じで、管理者が登録した既存の secret も
  そのまま使える。
- Team と Project の送信先（`/api/teams/:teamId/notification-channel`、
  `/api/teams/:teamId/projects/:projectId/notification-channel`）は、Webhook URL を同じ Workspace namespace の
  `slack-channel/<sha256(team#… / project#…)>/<version>` に置き、名前・言語・revision・使う URL の version だけを
  Notifications table の `<workspaceId>#!channel-destinations` partition に置く。新しい URL は新しい version に書き、
  fence 付きの設定保存が commit されたときだけ切り替える。拒否された保存は投稿先を変えない。削除は revision を残した
  tombstone にし、登録し直しても revision が戻らないようにする。Team は Team マネージャー、Project は Project か Team の
  マネージャーが変更でき、変更は revision 条件・呼び出し元の権限 fence・audit event と同じ transaction で保存する。
  audit と request digest には URL を入れない。
- channel に投稿するのは health update の公開（悪化を含む）、Milestone の完了・日程変更、Work Item の期限当日と期限超過。
  collaboration projection が既存の再認可と現在の Team・Project の再解決を通った event について、Project の送信先、
  なければ Team の送信先を探し、`<workspaceId>#!channel-posts` partition に event ID ごとの投稿 row を条件付き put する
  （projection の再試行でも 1 件）。
- 投稿 row は既存の `SlackDeliveryIndex` に `slack-channel#0..3` という別 partition で載せる。個人あての Slack worker は
  `slack#<n>` しか読まないので混ざらない。毎分の Slack job が個人あてと channel を独立に処理し、channel は lease・
  version 条件・最大 5 回の backoff 再試行（`Retry-After` を尊重）・失敗 partition `slack-channel-failed#<n>` を持つ。
  送信時に送信先が削除済みなら投稿しない。送信直前に Workspace が有効なことと、投稿元（Work Item・health update の
  対象・Milestone）が今も同じ Team・Project にあること（期限の投稿は未完了・同じ期限・同じ段階であること）を読み直し、
  その後に lease を更新してから送る。
- Enterprise の route 権限は Team の送信先が `teams.read` / `teams.manage`、Project の送信先が `projects.read` /
  `projects.manage`、本人の送信先が `workspace.read`。
- 本文の理由と channel 投稿の見出しは contracts の ja / en の文言で書く。個人あては受信者の表示言語、channel は
  送信先に保存した言語を使う。未知の理由 key は本文に出さない。
- API Lambda に `slack/*` と `slack-channel/*` だけへの Create / Put / Delete / DescribeSecret を、Slack job に
  `slack-channel/*` の GetSecretValue を追加する。Workspace 閉鎖時は既存の `automation-webhooks/<workspace>/` prefix の
  削除処理が両方を消す。

## 検討した選択肢

- channel 投稿用に GSI を追加する: index は分かれるが、件数が少ないのに常設の GSI と CDK 変更が増える。
  partition 値で分ければ既存 index で足りる。
- 送信先 URL を DynamoDB に KMS 暗号化して置く: 読み取りは 1 回減るが、Secrets Manager の既存 namespace・
  Workspace 閉鎖時の削除・IAM の絞り込みを使えなくなる。
- Team の channel にも Project の投稿を常に流す: Project に channel があるときに二重投稿になる。Project を優先し、
  なければ Team に流す。
- hourly / daily の頻度で複数通知を 1 投稿にまとめる digest、Microsoft Teams の Incoming Webhook: 送信先 row に
  provider を持たせたので後から足せるが、今回は入れない。

## 結果

- メンバーとマネージャーが管理者を待たずに Slack の送信先を登録でき、テスト送信で確かめられる。
- channel の参加者は投稿を読めるので、channel の選び方はマネージャーの責任になる（設定画面と利用者ガイドに書く）。
- Team の送信先は、その Team の Project のうち自分の送信先を持たないものの投稿も受ける。
- URL を差し替えた直後は、古い version を読みかけた投稿が secret を見つけられないことがある。その投稿は再試行で
  新しい version を読む。
- 設定の削除や URL の差し替えが commit された後に古い version の secret の削除が失敗すると、その secret は
  どの設定からも参照されないまま残る。version は推測できない UUID で、Workspace 閉鎖時の prefix 削除で消える。
  削除の再試行キューは作らない。
- Notifications table に送信先 row と投稿 row（TTL 30 日）が増える。GSI・Lambda は増えない。
- Agent Run の判断待ちは監査 event がまだないため channel には投稿しない。
- 更新した文書: `docs/notifications.md`、`docs/guide/member.md`、`docs/guide/pm.md`。
