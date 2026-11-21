# 0036. 本番への deploy を GitHub Actions から OIDC の role で行い、deploy の値を SSM に置く

- 状態: 提案
- 日付: 2026-11-21
- 関連: Issue #362, #636, #438

## 背景

これまで deploy は、運用者が AWS の認証情報を持つ端末から `cdk/README.md` の手順を手で実行する前提だった。
最初の本番 deploy（#636）では、作業する人の端末にも作業用の環境にも AWS の認証情報がない。
長期の access key を GitHub に置くことは避けたい。環境は本番 1 つだけにし、staging は作らない（#438 は見送り）。
費用はできるだけ抑えたい。

## 決定

- GitHub Actions の `production` Environment で動く job だけが、OIDC で `mukuroji-github-deploy` role を引き受ける。
  trust policy は `aud=sts.amazonaws.com` と `sub=repo:mnmn0/mukuroji:environment:production` の完全一致にする。
  Environment は deployment branch を `main` に限り、required reviewer の承認を待つ。
- この role は CDK bootstrap の deploy / file-publishing / lookup role を引き受けて deploy する（CDK の標準の流れ）。
  自分で持つ権限は、stack の参照、Web bucket への upload と CloudFront の invalidation、runtime control の
  AppConfig 操作、deploy 用 SSM parameter の読み取りと新規作成（上書きは Deny）だけにする。
- role、GitHub の OIDC provider、alarm 用の SNS topic 2 つ、deploy の非 secret 値（初期 owner の email、
  Workspace ID、topic 名など）は、1 つの CloudFormation template（`cdk/deploy-access/`）で一度だけ作る。
  AWS console の CloudShell から 1 回実行できる大きさに保つ。
- stack の secret parameter（audit pseudonym key、token hash secret 2 つ、edge origin secret）は
  SSM Parameter Store の SecureString（`/mukuroji/deploy/secrets/`）に置く。stack ができる前の初回だけ deploy script が
  生成して保存し、stack ができた後に値がなければ deploy を止める。
- workflow は `scripts/github-deploy.ts` を呼ぶだけにする。deploy 手順の変更は通常の PR で script を変える。

## 検討した選択肢

- GitHub Actions + OIDC（採用）: public repository なので Actions の実行時間は無料。Environment の承認と
  deploy の記録が GitHub に残る。workflow file だけは GitHub App から push できないので、最初の 1 回は手で追加する。
- CodeBuild: AWS の中で動くので OIDC は不要。無料枠は月 100 分（general1.small）で、超えても 1 分 $0.005 程度と安い。
  ただし GitHub との接続（CodeConnections）の承認を console で行う必要があり、承認 gate を付けるには CodePipeline が
  要る。手作業が減らず、承認と記録の仕組みを別に作ることになる。
- GitHub の Environment secret に secret を置く: 値を誰かが生成して GitHub の画面に貼る手作業が 4 つ増える。
  SSM の SecureString（standard tier）は無料で、値が AWS の外に出ない。
- Secrets Manager に secret を置く: 1 つ月 $0.40 かかり、4 つで月 $1.6 になる。自動 rotation は使わないので見送る。
- staging を挟む: #438 の判断どおり作らない。必要になったら Environment と role を足す。

## 結果

- AWS の長期 key を持たずに、main の commit を承認付きで本番へ deploy できる。費用は SNS と SSM の無料枠の範囲。
- `cdk deploy` の実権限は CDK bootstrap の CloudFormation execution role（既定は AdministratorAccess）にある。
  bootstrap を `--cloudformation-execution-policies` で絞る判断は、stack の resource が固まった後に見直す。
- PR ごとの read-only な `cdk diff`、post-deploy の smoke e2e、承認前の diff 表示は今回入れていない（#362 の残り）。
  rollback は main で revert して deploy するか、`web-rollback` / `runtime-control-disable` を手動で実行する。
- 更新した文書: `cdk/README.md`（GitHub Actions から deploy する）、`docs/operational-readiness.md`。
