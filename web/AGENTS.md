# Web の開発ガイド

このファイルは `web/` 配下の作業に適用します。リポジトリ全体の方針はルートの `AGENTS.md` に従い、このファイルでは React/TypeScript/Vite のフロントエンド固有のルールを定めます。

## 技術スタックとコマンド

`web/` は React 19、React Router、Tailwind CSS、SWR、Storybook を使います。

```sh
bun run web:dev
bun run web:lint
bun run web:build
bun run web:storybook
bun run web:build-storybook
```

UI 変更では、少なくとも次を確認します。

```sh
bun run web:lint
bun run web:build
bun run web:build-storybook
```

Storybook を起動できる場合は対象 Story をブラウザまたはスクリーンショットで確認します。`storybook-static/` は生成物なのでコミットしません。

## ディレクトリ構造

新しいコードは、URL、業務機能、業務データ、共通処理の責務が分かる場所に置きます。

```text
web/src/
├── app/
│   ├── App.tsx
│   ├── router.tsx
│   ├── layouts/
│   └── providers/
├── pages/
│   ├── auth/
│   ├── workspace/
│   └── public/
├── features/
├── entities/
├── shared/
├── assets/                 # 現行の web/src/assets
└── index.css
```

### `app/`

アプリケーションの起動、Router、Provider、アプリケーション全体のレイアウトを置きます。

- `App.tsx` は Router/Provider の組み立てに留める
- ルーティング定義は `app/router.tsx` または既存の `routes/router.tsx` に集約する
- 認証済み Workspace、公開ページなど、複数画面で共有するレイアウトを置く
- 業務 API の取得や画面固有の状態を置かない

### `pages/`

URL に対応する画面の組み立てを置きます。

- ページは route parameter の解決、feature の組み立て、画面遷移に集中する
- 大量の `fetch`、`useSWR`、フォーム状態、業務計算をページに集めない
- ページ同士で直接 import しない
- 認証、Workspace、公開ページなど、画面の利用境界が分かるサブディレクトリを使う

既存の `pages/TaskPage.tsx` や `pages/WorkspacePage.tsx` を移行する場合も、まず画面コンテナと feature を分け、その後にサブディレクトリへ移動する。

### `features/`

ユーザーが行う業務操作や、複数の entity を組み合わせる機能を置きます。

例:

```text
features/
├── request-intake/
├── automation-management/
├── issue-collaboration/
├── bulk-operations/
└── work-item-configuration/
```

feature の内部は、必要な範囲で次の構成にします。

```text
features/request-intake/
├── api/
├── queries/
├── mutations/
├── model/
├── ui/
└── fixtures.ts
```

feature から別 feature のページや内部 UI を直接 import しません。共有が必要な場合は entity、`shared/ui`、または共通の model/API へ責務を移します。

### `entities/`

Project、Team、User、Work Item、File、Notification など、業務データ単位の API、表示、業務ロジックを置きます。

```text
entities/work-item/
├── api/
├── queries/
├── mutations/
├── model/
├── ui/
└── fixtures.ts
```

Entity は feature や page に依存しません。複数の feature から再利用される業務データの取得・変換・表示部品は、まず entity への配置を検討します。

### `shared/`

特定の業務領域に依存しない処理だけを置きます。

```text
shared/
├── api/
├── ui/
├── i18n/
├── routing/
└── lib/
```

- `shared/api/`: fetch、JSON、header、mutation context などの通信基盤
- `shared/ui/`: 業務知識を持たない汎用 UI
- `shared/i18n/`: 翻訳の共通型、辞書の読み込み、locale 管理
- `shared/routing/`: 業務領域に依存しない routing helper
- `shared/lib/`: 業務領域に依存しない小さなライブラリ関数

`shared/` から `pages`、`features`、`entities` を import しません。アプリケーションの画像などは現行の `web/src/assets/` に置き、`shared/assets/` は新設しません。所有者が不明な `utils`、`services`、`hooks` フォルダも新設しないでください。

### 既存の業務領域フォルダ

現在の `automation/`、`files/`、`issues/`、`notifications/`、`planning/`、`projects/`、`requests/`、`work-items/` などは、段階移行の間は利用して構いません。

既存領域へ新しいコードを追加する場合は、可能なら次の責務分割を先に適用します。

```text
<area>/
├── api/
├── queries/
├── mutations/
├── model/
├── ui/
└── fixtures.ts
```

全ファイルを一度に `features` / `entities` へ移動する大規模変更は避け、対象画面や API の変更に合わせて移行します。

## `model/` と `ui/` の分離

業務領域直下へ model 処理と React component を混在させず、責務に応じて `<area>/model/` と
`<area>/ui/` に分けます。route component は `pages/`、HTTP 通信は `api/`、SWR は
`queries/` / `mutations/` に置き、この分離へ混ぜません。

### `model/`

`model/` には React に依存しない業務型、入力の正規化、selector、権限判定、並び替え、
表示用 model・label の生成などを置きます。

- `react`、`react-router`、`swr`、DOM API を import しない
- `ui/`、`queries/`、`mutations/` の型や内部実装へ依存しない
- API response type を利用してよいが、HTTP 通信や cache 操作は行わない
- `model.ts` のような領域全体を抱える名前を避け、`requestForm.ts`、
  `workItemDisplay.ts` のように対象を表す
- model 同士を分割するときは、画面単位ではなく一緒に変更される業務概念を単位にする

### `ui/`

`ui/` には React component、component 専用の表示型・label・focus helper、および対応する
Storybook story を置きます。

- component と story は同じ `ui/` 配下に置く
- pure view は data と action を props で受け取り、HTTP/SWR の詳細を知らない
- query/mutation と view を結ぶ component は `*Container` として区別してよい
- route parameter、画面遷移、ページ全体の loading/error 境界を持つ component は
  `ui/` ではなく `pages/` に置く
- 複数領域で再利用する業務 UI は entity、業務知識を持たない UI は `shared/ui/` へ移す
- `ui.ts` のような集約ファイルを領域直下へ置かず、公開面が必要なら `ui/index.ts` を使う

依存方向は `pages → ui → model` を基本とし、`model/` から React component へ逆依存させません。

## API と SWR の分離

HTTP 通信の実装と、React/SWR による取得状態・キャッシュ管理を分離します。詳細は [`docs/frontend-data-access.md`](../docs/frontend-data-access.md) を参照してください。

### `api/`

`api/` は HTTP 通信を担当します。

- URL、method、header、body の組み立て
- `fetch` の実行
- JSON の読み取りと response の変換
- API 固有エラーの変換
- 呼び出し側から渡された access token や mutation context の利用

`api/` から `react`、`react-router`、`swr` を import しません。`useSWR`、React state、SWR key、ページ遷移、トースト表示、`getAuthSession()` の直接参照も行いません。

API 関数は可能な限り認証情報や locale などを明示的な引数で受け取ります。共通の通信処理は `shared/api/` に置きます。

業務領域の API は `<area>/api.ts` へ集約せず、リソースまたは一緒に変更される機能単位で
`<area>/api/<resource-or-capability>.ts` に分割します。

```text
projects/
├── api/
│   ├── directory.ts
│   ├── members.ts
│   ├── users.ts
│   └── index.ts
├── queries/
└── mutations/
```

- `get.ts` / `post.ts` のような HTTP method 単位では分割しない
- `DashboardApi.ts` のような page 単位では分割しない
- 同じリソースを扱う取得・作成・更新・削除は同じ API module に置く
- ファイル名には `common.ts`、`helpers.ts`、`management.ts` のような責務が広がりやすい名前を使わない
- endpoint 専用の request / response type は、その endpoint を所有する API module に置く
- 複数の API module で共有する業務型は `model/`、通信基盤は `shared/api/` に置く
- `api/index.ts` は領域の公開 API を明示するために利用してよい。領域内の module から
  `index.ts` を参照せず、循環依存を避けるため具体的な sibling module を import する
- 新しいコードでは、公開範囲を狭く保てる場合は `<area>/api/members` のように具体的な
  module を直接 import する

複数 endpoint の呼び出し、画面向けのデータ集約、SWR key や cache 操作は `api/` に置かず、
それぞれ `queries/` または `mutations/` に置きます。API module の分割と共通 transport の
抽出は別の変更として扱い、一度に無関係な通信処理まで書き換えません。

### `queries/`

`queries/` は `useSWR` を使う参照用 wrapper を置きます。

- SWR key は query wrapper が所有する
- 条件付き取得は `null` key で表現する
- API 関数への引数を wrapper 内で渡す
- loading、error、data、mutate を画面に適した形へ整理する
- polling、deduplication、retry の設定を必要な領域で管理する

ページから `useSWR` を直接呼ばず、`useProjectDirectory`、`usePlanningSnapshot` のような業務上意味のある hook を利用します。

- query hook は `<area>/queries/use<ResourceOrCapability>.ts` に置く
- SWR key、取得条件、pagination、polling、deduplication は query hook の外へ公開しない
- 複数 endpoint をまとめる React 非依存の loader も、その取得結果を所有する `queries/` に置く
- `useData.ts`、`useQueries.ts` のような対象が分からない名前を使わない
- page、UI、領域直下の `use*.ts` に `useSWR` / `useSWRInfinite` を残さない

### `mutations/`

`mutations/` は更新 API と更新後の cache 整合性をまとめる場所です。

- 更新後に複数の cache を再検証する
- optimistic update を行う
- revision conflict などを画面向け状態へ変換する
- 複数画面で同じ更新処理を共有する

単純なフォーム送信で cache 更新が不要なら、feature 内の mutation/controller から API 関数を直接呼んでも構いません。ページや汎用 UI から直接 API を呼ばないでください。`useSWRMutation` を使うか、API 関数と `mutate` を組み合わせるかは、cache 更新の必要性と処理の複雑さで決めます。

- mutation hook/controller は `<area>/mutations/use<ActionOrCapability>.ts` に置く
- 更新処理は必要な query hook またはその key を利用し、page に cache key を再定義しない
- 取得と更新をまとめて UI 向け controller を返す場合は `mutations/` に置き、取得部分は
  `queries/` の hook を組み合わせる
- `mutation.ts` や `useMutations.ts` が複数の無関係な更新を持つ場合は、resource/capability 単位へ分割する
- mutation から page、UI、別 feature の内部実装を import しない

依存方向は次の通りです。

```text
pages / ui
    ↓
queries / mutations
    ↓
api
    ↓
shared/api
```

## 状態の所有場所

状態の種類ごとに、最も近い適切な所有者を一つだけ決めます。

```text
API 由来の server state  → SWR の query/mutation
URL に持つ状態          → React Router の path/search params
一時的な UI 状態        → useState
フォーム入力             → フォームを所有する feature/UI
派生値                  → render 中の計算
高コストな派生値         → 必要な場合だけ useMemo
```

同じ値を URL、SWR、`useState` など複数の場所へ重複して保持しません。状態を別の状態から同期するためだけの state と `useEffect` も作りません。

新しい Context や global store を追加する前に、URL、SWR、親コンポーネントの state、feature の state で表現できないかを確認します。Context/store は、複数の離れた子孫が共有し、Context/store に置く意味がある安定した UI 状態に限って使います。server state の置き場所として Context/store を使いません。

## 依存境界

業務コードの依存方向は次の通りです。

```text
app
 ↓
pages
 ↓
features
 ↓
entities
 ↓
shared
```

次の依存を作りません。

- `shared` から `pages`、`features`、`entities` を import する
- `entities` から `features` や `pages` を import する
- feature から別 feature の page や内部 UI を直接 import する
- page から別 page を import する
- 業務領域の内部実装を、無関係な領域から直接参照する

ページは feature、entity、shared を組み立ててよいですが、業務操作や複雑な取得処理は feature の public な入口を通します。共有が必要な内部実装は、entity、`shared/ui`、または共通の model/API へ責務を移します。

## ページと feature の責務

ページは次の処理に集中します。

- route parameter の解決
- query/mutation hook の呼び出し
- feature の組み立て
- 画面遷移
- ページ全体の loading/error 境界

次の処理をページへ集めません。

- 大量の `fetch` や `useSWR`
- 複数業務領域にまたがる業務計算
- 複雑なフォーム状態と入力変換
- 同じ画面以外でも利用する更新処理

既存の `pages/TaskPage.tsx` や `pages/WorkspacePage.tsx` を変更する場合は、まず画面コンテナと feature を分けます。行数だけを機械的な基準にせず、責務が複数になった時点で分割します。

## 非同期画面の状態

API や query/mutation を使う画面・feature は、次の状態を設計してから実装します。

- loading: 初回取得中の表示
- error: 再試行や利用者への案内を含む失敗表示
- empty: 正常取得できたが対象がない場合の表示
- permission denied: 認証済みだが権限がない場合に必要な表示
- success: データがある場合の表示

error を空データとして扱ったり、例外を握りつぶしたりしません。再試行可能な query では、再取得の入口を画面上に用意します。mutation では成功、失敗、競合、処理中の二重送信防止を設計します。

## API 型と画面モデル

- API request/response は、可能なら `@mukuroji/contracts` の共有型を利用する
- Web 側で同じ API DTO を再定義しない
- API response の transport 変換と validation は `api/` で行い、表示用ラベル、整形、並び順、集計、権限による表示可否は `model/` または feature で行う
- 複雑な画面へ raw API response をそのまま渡さない
- UI コンポーネントは、API の transport details や DynamoDB/HTTP の都合を知らない

通信処理と表示都合の変換を一つの API 関数へ詰め込みません。

## React の状態と `useEffect`

`useEffect` は原則として新しく追加しません。React の render とイベント処理で表現できる状態を、Effect で後から同期しないでください。

次の用途では `useEffect` を使いません。

- props や state から計算できる値の保持
- state の初期値やリセット処理
- ユーザー操作への反応
- API の取得や再取得
- フォーム入力の検証・整形
- コンポーネント間の値の受け渡し

代わりに、次を優先します。

- render 中の計算、必要なら `useMemo`
- event handler 内の処理
- `key` を変えた再マウントによる state のリセット
- SWR の query/mutation wrapper
- 親子コンポーネント間の props、または適切な状態の所有者

例外として、DOM API、browser API、購読、タイマーなど React の外部システムとの同期が必要な場合は `useEffect` を使えます。その場合も次を満たします。

- Effect が本当に外部システムとの同期を必要としている
- dependency array が同期対象を正確に表している
- 購読、イベント listener、タイマーなどは cleanup する
- 既存の query hook や event handler で表現できないことを確認している

既存コードの `useEffect` は直ちに全て移行しません。ただし、新規コードでは原則追加せず、既存コンポーネントを変更するときは不要な Effect の削減を検討します。`useLayoutEffect` も同じ原則で扱います。

## UI と Storybook

- UI の表示文言は i18n 対応を前提にする
- 固定文言をコンポーネントに閉じ込めない
- グローバル CSS は `web/src/index.css` を最小限に保ち、UI は Tailwind のユーティリティを中心に実装する
- 既存の `web/src/i18n.ts` と `createTranslator` / `createSidebarLabels` の方針に合わせる
- 画面に表示する文言は i18n key を使い、key は `tasks.*`、`requests.*` のように業務領域の namespace を付ける
- ブランド表現には `BrandMark` と `mukuroji` 表記を使う
- Storybook のカテゴリは `Application/...` と `Design System/...` を基本にする
- コンポーネントを追加・変更したら、単体確認できる Story を追加・更新する
- Storybook 用 fixture と本番 API の取得処理を同じファイルへ混在させない
- インタラクティブな UI は semantic HTML を優先し、label、focus、keyboard 操作、適切な accessible name を用意する
- ARIA 属性は native HTML semantics で表現できない場合に限って追加し、role と keyboard 操作をセットで実装する

## テスト

- API 関数は React を起動せずにテストする
- API response、エラー、入力変換は `api/` のテストで確認する
- query/mutation hook は必要な場合だけ SWR provider と組み合わせてテストする
- 画面テストでは、可能なら API fixture または query wrapper の境界を使い、実際の HTTP 通信を発生させない
- unit test は対象コードの近く、または既存の `web/test/` の構成に合わせる
- e2e test は `web/e2e/` に置く

## TypeScript

- exported 宣言には TSDoc を付ける
- export 有無にかかわらず `type` / `interface` は宣言本体と各プロパティに TSDoc を付ける
- `class` は宣言本体とメンバー変数に TSDoc を付ける
- API response と request input は、可能なら `@mukuroji/contracts` の共有型を利用する
- `any` は新規コードで使わない。外部入力や未知の API response は `unknown` から型を絞り込む
- 型アサーションは境界に限定し、検証なしに `as` で API response を信頼しない
- `useMemo` は高コストな計算または参照安定性が必要な場合だけ使い、通常の値の計算を隠すために使わない

## 移行方針

既存コードを整理するときは、次の順番を基本とします。

1. 対象ページから fetch と `useSWR` の組み合わせを洗い出す
2. fetch 関数を業務領域の `api/` へ分離する
3. `useSWR` と SWR key を `queries/` へ移す
4. ページから直接 API と SWR key を参照しないようにする
5. cache 更新が複数箇所に及ぶ場合だけ `mutations/` へ移す
6. API、query/mutation、画面の順にテストを移す

最初の移行対象には、複数ページで利用されている `getProjectDirectory` とその `useSWR` 呼び出しを選びます。
