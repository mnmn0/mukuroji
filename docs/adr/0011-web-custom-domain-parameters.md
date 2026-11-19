# 0011. 独自 domain を CloudFormation parameter で受け、正規 URL を stack が決める

- 状態: 提案
- 日付: 2026-11-19
- 関連: Issue #439、ADR 0005

## 背景

Web app と `/api` は 1 つの CloudFront distribution（`dxxxx.cloudfront.net`）で配信している。
この domain は初回 deploy まで決まらず、SSO の callback や通知 Email の link に載せる正規の URL を前もって決められない。
会社の domain で配信したいが、独自 domain を持たない試用環境や既存環境はそのまま動かしたい。
ACM の公開証明書は無料で、Route 53 の hosted zone は環境によってあったりなかったりする。

## 決定

- `WebDomainName`、`WebCertificateArn`（us-east-1 の ACM）、`WebHostedZoneId` の 3 つの任意 parameter を追加する。
  既定値はすべて空で、CloudFormation の condition で distribution の alias・証明書と Route 53 の A / AAAA alias を切り替える。
- 証明書は stack では作らず、運用者が us-east-1 で発行した ARN を受け取る。
- アプリの正規 URL（`webOrigin`、output `WebUrl`）は、独自 domain があればその URL、なければ CloudFront の URL とし、
  通知 Email の deep link（`NOTIFICATION_EMAIL_APP_ORIGIN`）に渡す。CloudFront の domain も引き続き配信する。

## 検討した選択肢

- CDK context（`-c mukuroji:webDomain=...`）で受ける: L2 の `domainNames`・`certificate` をそのまま使えて template が読みやすい。
  一方、同じ template で domain の有無を切り替えられず、値は module の on/off ではないので既存の context の使い方とも合わない。
- stack が ACM 証明書を作る: DNS 検証まで自動にできるが、stack が us-east-1 以外のときは cross-region の stack か custom resource が要り、
  hosted zone のない環境では検証待ちで deploy が止まる。
- parameter で受け、L1 の `Fn::If` で設定する（採用）: 1 つの template で両方を表せ、空のままなら既存環境に resource の変更が出ない。

## 結果

- 独自 domain を持つ環境は parameter だけで切り替えられ、通知の link も同じ deploy で独自 domain になる。
- 証明書の発行と更新、Route 53 を使わない場合の CNAME は運用者の作業として残る（`cdk/README.md` に手順を書く）。
- cdk-nag の CFR4 は condition 付きの証明書を評価できないため、抑止を残して理由を更新する。
- Slack の通知や招待メールに app の link を載せるときは、同じ正規 URL を渡す。
