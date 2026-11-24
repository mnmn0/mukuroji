# 0056. 独自 domain を `cdk.json` の CDK context で受け、synth 時に distribution・DNS・正規 URL を決める

- 状態: 提案
- 日付: 2026-11-22
- 関連: Issue #439、Issue #636、ADR 0011（置き換え）、ADR 0039

## 背景

ADR 0011 では独自 domain を CloudFormation parameter（`WebDomainName`、`WebCertificateArn`、`WebHostedZoneId`）で受け、
distribution の alias・証明書と Route 53 の record を condition で切り替えていた。

本番の deploy は GitHub Actions の script（ADR 0039）が行い、script は渡さない parameter を前回値のまま残す。
そのため domain を変えるには script を直すか console で parameter を変える必要があり、何が設定されているかが
repository から読めない。運用者からは「domain は `cdk.json` で変えられるようにしたい」という要望があった。
任意 module の on/off もすでに `cdk.json` の context で決めており、GitHub Actions の deploy は `cdk.json` の値を使う。
初回 deploy（#636）はまだで、parameter で domain を設定した stack は存在しない。

## 決定

- 独自 domain を `cdk/cdk.json` の context `mukuroji:webDomainName`、`mukuroji:webCertificateArn`（us-east-1 の ACM）、
  `mukuroji:webHostedZoneId` で受ける。3つとも空なら CloudFront の domain だけで配信する。`cdk.json` には空の値で置く。
- context は composition root（`bin/`）だけが読み、stack には Props で渡す。stack は synth 時に値の形式と組み合わせ
  （domain と証明書は対、hosted zone は domain が要る）を検証し、不正なら synth を止める。
- distribution は L2 の `domainNames`・`certificate`（TLSv1.2_2021、SNI）で設定し、hosted zone があるときだけ
  A / AAAA alias を作る。正規 URL（`webOrigin`、output `WebUrl`）は独自 domain があればその URL の固定文字列とし、
  通知 Email、Cognito の招待・再設定メール、file bucket の CORS が同じ値から決まる。
- 3つの CloudFormation parameter と condition・rule は削除する。
- SSO の app client は stack の外にあり callback は1件だけなので、独自 domain の指定中は `CognitoSsoRedirectUri` が
  空か `https://<domain>/auth/sso/callback` でないと deploy 前に止める rule（`WebSsoCallbackOnCustomDomain`）を置く。

## 検討した選択肢

- parameter のまま、GitHub Actions の script に domain の入力を足す: 1つの template で両方を表せるが、値が SSM などの
  repository の外に置かれ、変更履歴が PR に残らない。
- parameter と context の両方を受ける: 移行はしやすいが、どちらが効いているか分かりにくく、parameter で設定した
  stack がまだないので移行の必要がない。
- context で受ける（採用）: `cdk.json` を変える PR で domain が切り替わり、レビューと履歴が残る。template は値が
  固定になり読みやすく、cdk-nag の CFR4 も独自 domain の証明書を評価できる。

## 結果

- domain の変更は `cdk.json` の PR と通常の deploy で済み、通知・招待メールの link と CORS も同じ deploy で変わる。
- 同じ template で domain の有無を切り替えることはできなくなり、環境ごとに値を変える場合は `-c` で上書きする。
- 証明書の発行と更新、Route 53 を使わない場合の CNAME、SSO app client の callback の変更は運用者の作業として残る
  （`cdk/README.md`「独自 domain で配信する」）。実 AWS での疎通確認は #636 の deploy 後確認で行う。
- 独自 domain を使わない環境では、CloudFront の default 証明書について CFR4 の抑止を残す。
