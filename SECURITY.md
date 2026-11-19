# セキュリティポリシー

mukuroji は社内のプロジェクト・タスク・工数・顧客情報を扱う基盤です。脆弱性を見つけた場合は、
公開の Issue・Pull Request・Discussion には書かず、以下の非公開窓口から報告してください。

## 報告窓口

GitHub の **Private vulnerability reporting** を使います。

1. リポジトリの **Security** タブを開く
2. **Report a vulnerability** を選ぶ
3. 下記「報告に含めてほしい内容」を記入して送信する

報告は repository maintainer だけが閲覧できる Security Advisory の下書きとして作られ、
修正 PR もその advisory に紐づく非公開 fork で進めます。窓口が使えない場合は、
repository owner（`CODEOWNERS` に記載）へ GitHub 経由で非公開に連絡してください。

### 報告に含めてほしい内容

- 影響を受ける機能・API・画面（例: `/api/...`、SCIM、Public API、Coding Agent MCP）
- 再現手順と、確認した commit SHA または環境（ローカル Floci / AWS）
- 想定される影響（権限昇格、tenant 越境、情報漏えい、改ざん、サービス停止など）
- 必要なら PoC。実データ・実在する個人情報・secret は含めないでください

## 対応の目安（SLA）

営業日は日本の平日です。期間は報告受領からの目安で、内容によって前後します。

| 段階 | 目安 |
| --- | --- |
| 受領の連絡 | 3 営業日以内 |
| 再現確認と重大度の判定 | 7 営業日以内 |
| 修正の公開（Critical） | 判定から 7 日以内 |
| 修正の公開（High） | 判定から 30 日以内 |
| 修正の公開（Medium） | 判定から 90 日以内 |
| 修正の公開（Low） | 通常の計画に組み込む |

重大度は CVSS v4.0 を参考に、tenant 越境・認証回避・監査証跡の改ざんを特に重く扱います。
修正の公開後に Security Advisory を公開し、報告者の同意があればクレジットを記載します。

## 対象範囲

- `main` ブランチの最新 commit と、そこからデプロイされた環境
- `web/`、`server/`、`contracts/`、`cdk/`、`scripts/`、Coding Agent MCP（`bun run mcp:start`）

リリース版の個別サポートは現在行っていません。古い commit で見つかった問題も、`main` で
再現する場合は対象です。

### 対象外

- 第三者サービス（AWS、Cognito Hosted UI、外部 IdP、GitHub など）自体の脆弱性
- ローカル開発用の Floci・DynamoDB Admin など、loopback だけに公開する開発補助の設定
- 自動スキャナーの結果だけで、具体的な影響が示されていないもの
- サービス停止を目的とした負荷試験、ソーシャルエンジニアリング、物理的な攻撃

## 調査時のお願い

- 自分が管理する workspace・アカウント・ローカル環境だけで検証してください
- 他の利用者のデータへアクセス・変更・削除しないでください。意図せず見えた場合は
  その時点で中断し、報告に記載してください
- 修正が公開されるまで内容を第三者に共有しないでください

## 関連文書

- 認証・SSO・SCIM: [`docs/enterprise-identity.md`](docs/enterprise-identity.md)
- 監査ログ: [`docs/event-audit.md`](docs/event-audit.md)
- Public API の credential: [`docs/public-api.md`](docs/public-api.md)
- incident response と運用: [`docs/operational-readiness.md`](docs/operational-readiness.md)
