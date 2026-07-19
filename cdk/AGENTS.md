# AGENTS.md

`cdk/` は AWS CDK によるインフラストラクチャ定義です。ここでは、変更を
再現可能・安全・レビュー可能な IaC として保つためのルールを定めます。
リポジトリ直下の `AGENTS.md` と共通ルールを共有し、より深い階層に別の
`AGENTS.md` がある場合は、その内容を優先してください。

## 基本方針

- CDK コードは AWS リソースを作るための宣言的な composition として扱い、
  実行時の業務ロジックやアプリケーションの処理を持ち込まない。
- 新しいコードはこのドキュメントの理想構成に従う。既存コードを変更する際は、
  触れた範囲から段階的に理想構成へ寄せる。
- logical ID、物理名、export 名、parameter 名など、既存リソースの識別子は
  意図なく変更しない。変更するとリソース置換やデータ消失につながる可能性がある。
- 変更前に対象スタックのリソース、依存関係、環境差分を確認する。
- AWS アカウントへ影響する操作は、ユーザーの明示的な依頼なしに実行しない。
- 依存関係の変更は CDK workspace の `package.json` に記録し、lockfile はルートの
  `bun.lock` に集約する。`cdk/` 配下に lockfile を作らない。

## コマンド

コマンドはリポジトリルートから実行します。

```sh
bun run cdk:build
bun run cdk:test
bun run cdk:synth
bun run oxc:lint
```

- `cdk:build`: CDK TypeScript の型チェック・コンパイル。
- `cdk:test`: Jest による Construct / Stack テスト。
- `cdk:synth`: CloudFormation template の合成。生成物の差分を確認する。
- `oxc:lint`: ルートの Oxlint を実行する。`cdk/**/*.ts` には
  `oxlint-plugin-awscdk` の推奨ルールが適用される。
- `cdk.out/` は生成物であり、コミットしない。

インストール・依存更新後は、必要に応じて次も実行します。

```sh
bun install
```

## 理想のディレクトリ構成

```text
cdk/
├── bin/
│   └── cdk.ts                    # composition root。App と Stack の接続だけ
├── lib/
│   ├── stacks/                   # 環境・境界単位の Stack
│   │   ├── foundation-stack.ts
│   │   ├── data-stack.ts
│   │   └── application-stack.ts
│   ├── constructs/               # 再利用可能な L3 Construct
│   │   ├── network/
│   │   ├── data/
│   │   ├── api/
│   │   └── observability/
│   ├── config/                   # 環境差分。秘密値は置かない
│   ├── policies/                 # IAM / SCP 等のポリシー組み立て
│   └── aspects/                  # 全体に適用する検査・安全性強制
├── test/
│   ├── stacks/
│   └── constructs/
├── cdk.json
├── package.json
└── tsconfig.json
```

### 各層の責務

- `bin/`: `App` の作成、context / environment の読み込み、Stack の生成だけを行う。
  AWS リソースの詳細や業務ルールは置かない。
- `lib/stacks/`: 複数の Construct を組み合わせ、Stack 間の参照や境界を定義する。
  リソースを大量に直接並べる場所にせず、必要なら Construct へ切り出す。
- `lib/constructs/`: 一つのインフラ機能を表す再利用単位。入力 Props を明示し、内部の
  AWS リソースと権限を閉じ込める。
- `lib/config/`: 型付きの非機密設定と環境差分だけを扱う。Secret、token、credential、
  個人情報は保存しない。
- `lib/policies/`: 複数の Stack / Construct で共有するポリシー定義。リソースの実体を
  作る責務は持たない。
- `lib/aspects/`: 暗号化、ログ保持、タグ、公開範囲など、横断的な不変条件を検査または
  強制する。個別リソースの構築処理を混ぜない。
- `test/`: `Template.fromStack` などを使い、合成された CloudFormation の契約を検証する。

`utils/`、`helpers/`、`common/`、`misc/` のような責務不明の置き場は作らない。
処理が複数の Stack / Construct で再利用される場合も、何を組み立てる処理かが分かる
名前の Construct、policy、config、aspect へ配置する。

## 依存方向

```text
bin
  ↓
stacks
  ↓
constructs ──→ config / policies / aspects
  ↓
AWS CDK L2/L1 constructs
```

- `bin` は `stacks` を参照する。`stacks` や `constructs` が `bin` を参照しない。
- `constructs` は別 Stack の実装詳細を参照しない。連携は Props、参照、明示的な公開面で行う。
- `config` はリソース構築を行わない。`policies` は Stack や具体的な Construct を生成しない。
- アプリケーションコードや `server/`、`web/` の実行時実装を CDK から import しない。
- CDK の token は合成時に解決できる値として扱い、token を通常の文字列として解析・分岐しない。

## Stack / Construct の設計

- Stack は環境やライフサイクルの境界として分割する。データを持つリソースと短命な
  アプリケーションリソースは、必要に応じて Stack を分ける。
- Stack の constructor は依存する設定と参照を Props で受け取る。深い層で
  `process.env`、context、Secrets Manager を直接読む設計にしない。
- Construct は一つの明確な機能を提供し、public property と method を最小限にする。
  外部から必要な ARN、grant、参照だけを型付きで公開する。
- Construct の Props に `Construct`、`Stack`、AWS client、mutable object を公開プロパティ
  として持たせない。必要な値は専用の型で受け取る。
- Construct の scope には原則として `this` を渡す。scope を隠れたグローバル値や別の
  親から取得しない。
- Construct ID はコード上で明示した PascalCase の安定値にする。変数、入力値、ループの
  index から ID を生成しない。親名を繰り返す冗長な suffix や `Stack` suffix を付けない。
- 同じ scope 内で Construct ID が衝突しないようにする。ID に環境名やランダム値を含めず、
  環境差分は Stack props、context、account / region で表現する。
- public Props に未使用のプロパティを残さない。mutable な public property を避け、
  構築後に設定を変更する API を作らない。
- Construct の public API、Props の型とプロパティ、export された設定には TSDoc を付ける。
  CDK plugin の `require-jsdoc` を strict にできる状態を保つ。

## AWS リソースとセキュリティ

- IAM は最小権限にする。`*` の action / resource、広すぎる Principal、不要な managed
  policy を使わず、対象リソースの grant API を優先する。
- Bucket、Table、Key、LogGroup などは、サービスの性質に応じて暗号化、TLS、versioning、
  access log、retention、backup、removal policy を明示する。デフォルトに依存しない。
- S3 bucket、DynamoDB table、Secrets Manager secret などのデータ保持リソースに対して、
  開発環境以外で暗黙の destroy や `RemovalPolicy.DESTROY` を使わない。
- 公開アクセスは明示的な要件がある場合だけ許可し、public access block、resource policy、
  security group、network boundary をテストで固定する。
- Secret、API key、password、certificate の秘密値をソース、context、template、ログへ
  書かない。CloudFormation に渡る値も機密性を確認し、必要なら dynamic reference や
  Secrets Manager の参照を使う。
- security group の ingress / egress、KMS key policy、IAM trust policy は、追加するたびに
  目的と対象をレビューできる名前にする。
- AWS のデフォルト値を使う場合も、可用性、暗号化、保持、公開範囲に関わる値は明示する。
- ARN、名前、URL、account / region を文字列連結で組み立てず、CDK の参照、`Arn.format`、
  `Stack.of(this)` など型付きの仕組みを使う。

## 安定性とデプロイ安全性

- logical ID と物理名は、リファクタリングでも維持する。Construct の移動、scope 変更、
  ID 変更、resource type 変更は CloudFormation の差分と置換可能性を確認してから行う。
- デプロイ済み Stack の Construct ID は CDK が生成する一部の logical ID に影響するため、
  lint ルールに合わせる目的だけで変更しない。既存 ID がルールに抵触する場合は、対象行に
  理由付きの lint exception を置き、template のリソースキー差分と置換可能性を確認する。
- stateful resource を変更するときは、保持ポリシー、snapshot、migration、replacement の
  可能性を確認する。コードレビューでは「更新」ではなく「置換」になっていないかを見る。
- Stack 間参照は循環させない。export / import の公開面を増やすより、境界を見直し、必要なら
  parameter、既存リソース参照、明示的なデータ境界を使う。
- context、account、region、stage の組み合わせを型で表現し、暗黙の fallback を作らない。
  未知の stage や必須設定は fail fast する。
- `cdk synth` の template をレビューし、想定外の公開、権限、置換、asset、依存関係がないことを
  確認する。CI では synth を成功条件に含める。
- `cdk deploy`、`cdk destroy`、`cdk bootstrap`、AWS リソースへの直接変更は、ユーザーの
  明示的な依頼と対象環境の確認なしに実行しない。

## Oxlint / oxlint-plugin-awscdk

- `oxlint-plugin-awscdk` は CDK workspace の開発依存です。リポジトリ直下の
  `.oxlintrc.json` で `cdk/**/*.ts` にだけ plugin の recommended ルールを適用します。
- plugin は experimental で、ルール・preset・config shape が将来変更される可能性があります。
  更新時は lockfile の差分とルール変更を確認し、`oxc:lint`、build、test、synth を実行する。
- 次の CDK ルールを満たすことを原則とします。
  - Construct の constructor property を明示する。
  - interface や Construct の public property に Construct を埋め込まない。
  - mutable な Props / public property を公開しない。
  - Construct ID を変数化せず、PascalCase の安定値にする。
  - grant API を優先し、手書きの権限を増やさない。
  - Construct scope には `this` を渡す。
- 既存のデプロイ済み Stack ID に限り、`bin/cdk.ts` の対象行に理由付き exception を置く。
  それ以外でルールを無効化する場合も対象を限定し、なぜ安全性または合成結果上問題ないかを
  コードの近くに残す。ファイル全体への disable や、lint を通すためだけの弱体化は行わない。

## テスト

- 実際の AWS アカウントへ接続せず、合成 template と Construct の公開 API をテストする。
- Stack テストでは、次のうち対象に関係する不変条件を明示的に検証する。
  - resource type、主要 property、暗号化、versioning、retention、backup
  - IAM action / resource / Principal の最小権限
  - public access、TLS、security group、network boundary
  - environment / stage ごとの条件、参照、Outputs
  - event source、retry、dead-letter、log retention、alarm
- snapshot だけに依存せず、重要な security property と replacement に関わる property を
  semantic assertion で固定する。
- Construct テストは正常系だけでなく、必須設定不足、未知の stage、無効な組み合わせ、
  破壊的な設定を拒否することも確認する。
- 既存 template の意図しない差分を見つけた場合、テストを更新して隠すのではなく、まず
  logical ID、resource replacement、権限、保持ポリシーへの影響を調査する。

## 変更時の手順

1. 対象 Stack の依存関係と現行 `cdk synth` 結果を確認する。
2. 変更責務に合う `stacks`、`constructs`、`config`、`policies`、`aspects` の境界を選ぶ。
3. 安定した ID、最小権限、保持・暗号化・公開範囲を先に設計する。
4. Construct / Stack テストを追加または更新する。
5. `bun run oxc:lint`、`bun run cdk:build`、`bun run cdk:test`、`bun run cdk:synth` を実行する。
6. 合成 template の差分とリソース置換の有無を確認し、結果を変更概要に記録する。
7. デプロイが必要な場合は、対象環境と実行内容をユーザーに明示してから行う。
