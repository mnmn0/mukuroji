# Web のデータアクセス構成

## 目的

Web のデータアクセスは、HTTP 通信を行う実装と、React/SWR による取得状態・キャッシュ管理を分離する。

この分離によって、次の状態を保つ。

- API 通信処理を React から独立してテストできる
- Storybook、テスト、将来の別 UI から同じ API 関数を再利用できる
- ページが `fetch` や SWR key の詳細を持たない
- キャッシュ、再取得、mutation 後の更新方針を一箇所で管理できる

新規実装と大きな変更ではこの方針を適用する。既存コードは、対象画面や API を変更するタイミングで段階的に移行する。

## 基本構成

業務領域ごとに、通信、参照、更新、表示を分ける。

```text
<area>/
├── api/
│   ├── projectApi.ts       # fetch とレスポンス変換
│   └── projectTypes.ts     # API 専用型が必要な場合だけ
├── queries/
│   ├── useProjectDirectory.ts
│   └── useProjectMembers.ts
├── mutations/
│   └── useProjectMutations.ts
├── model/
│   └── projectSelectors.ts  # 通信に依存しない業務ロジック
├── ui/
│   └── ProjectSummary.tsx
└── fixtures.ts
```

既存の `projects/`、`issues/`、`work-items/`、`planning/`、`requests/` などの業務領域フォルダを活用する。いきなり全体を `entities` や `features` に移動する必要はない。

将来的に `entities` / `features` へ整理する場合も、同じ責務分割を保つ。

```text
entities/project/api/
entities/project/queries/
features/request-intake/api/
features/request-intake/queries/
```

## レイヤーの責務

### `api/`

`api/` は HTTP 通信の実装だけを担当する。

担当するもの:

- URL、HTTP method、header、body の組み立て
- `fetch` の実行
- JSON の読み取りと API response の変換
- API 固有のエラーを業務領域のエラーへ変換する処理
- `accessToken` や mutation context など、呼び出し側から渡された request context の利用

担当しないもの:

- `react`、`react-router`、`swr` の import
- `useSWR`、`useSWRMutation`、React state の利用
- SWR key の定義
- `getAuthSession()` などグローバルな認証状態の直接参照
- ページ遷移やトースト表示

API 関数は、可能な限り明示的な引数を受け取る。

```ts
export async function getProjectDirectory(
  accessToken: string,
  locale: Locale,
): Promise<ProjectDirectory> {
  const response = await fetch('/api/projects', {
    headers: {
      Authorization: `Bearer ${accessToken}`,
      'Accept-Language': locale,
    },
  })

  if (!response.ok) {
    throw new ProjectApiError(response.status)
  }

  const body: unknown = await response.json()
  return parseProjectDirectoryResponse(body)
}
```

`parseProjectDirectoryResponse` は schema parser など、API response の shape を検証する境界処理です。検証なしの型アサーションで response を信頼しません。

共通の fetch、JSON、header、mutation context の処理は `shared/api/` に置く。`shared/api/` は業務領域を import しない。

### `queries/`

`queries/` は SWR による参照処理のラッパーを担当する。

担当するもの:

- `useSWR` の呼び出し
- SWR key の定義
- `null` key による条件付き取得
- API 関数への引数の受け渡し
- loading、error、data、mutate の業務画面向けの整理
- 必要に応じた polling、deduplication、再試行設定

SWR key はページではなく query wrapper が所有する。

```ts
export function useProjectDirectory(
  accessToken: string | undefined,
  locale: Locale,
) {
  const key = accessToken
    ? ['project-directory', accessToken, locale] as const
    : null

  return useSWR(
    key,
    ([, token, currentLocale]) =>
      getProjectDirectory(token, currentLocale),
    apiSWRConfig,
  )
}
```

ページは `useSWR` を直接呼ばず、業務上意味のある query hook を呼ぶ。

```tsx
const {
  data: projectDirectory,
  error,
  isLoading,
} = useProjectDirectory(accessToken, locale)
```

複数の API を組み合わせて一つの画面用データを作る場合も、ページ内に取得処理を並べるのではなく、画面または feature 用の query wrapper にまとめる。

```text
features/work-items/queries/
└── useProjectWorkItemWorkbench.ts
```

### `mutations/`

`mutations/` は更新処理と、更新後のキャッシュ整合性を担当する。

```text
api/updateProject.ts              # 更新 HTTP リクエスト
mutations/useUpdateProject.ts     # 更新、mutate、競合処理
```

単純なフォーム送信でキャッシュ更新が不要な場合は、feature 内の mutation/controller から API 関数を直接呼んでもよい。ページや汎用 UI から直接 API を呼ばない。ただし、次の処理が必要なら mutation wrapper にまとめる。

- 更新後に複数の SWR cache を再検証する
- optimistic update を行う
- 競合や revision error を画面向け状態に変換する
- 同じ更新処理を複数画面で共有する

`useSWRMutation` を使うか、通常の API 関数と `mutate` を組み合わせるかは、cache 更新の必要性と処理の複雑さで決める。

## 依存方向

依存方向は次の向きにする。

```text
pages / ui
    ↓
queries / mutations
    ↓
api
    ↓
shared/api
```

次の依存は禁止する。

- `api/` から `queries/`、`mutations/`、UI への依存
- `api/` から React、SWR への依存
- ページ間の依存
- ある feature から別の feature のページへの依存
- `shared/` から業務領域への依存

## 状態の所有場所

状態の種類ごとに、最も近い適切な所有者を一つだけ決める。

```text
API 由来の server state  → SWR の query/mutation
URL に持つ状態          → React Router の path/search params
一時的な UI 状態        → useState
フォーム入力             → フォームを所有する feature/UI
派生値                  → render 中の計算
高コストな派生値         → 必要な場合だけ useMemo
```

同じ値を URL、SWR、`useState` など複数の場所へ重複して保持しない。状態を別の状態から同期するためだけの state と `useEffect` も作らない。

server state の置き場所として Context や global store を使わない。新しい Context/store は、複数の離れた子孫が共有し、Context/store に置く意味がある安定した UI 状態に限る。

## API 型と画面モデル

- API request/response は、可能なら `@mukuroji/contracts` の共有型を利用する
- Web 側で同じ API DTO を再定義しない
- API response の transport 変換と validation は `api/` で行い、表示用ラベル、整形、並び順、集計、権限による表示可否は `model/` または feature で行う
- 複雑な画面へ raw API response をそのまま渡さない
- UI は API の transport details を知らない

## React の状態と `useEffect`

`useEffect` は原則として新しく追加しない。React の render とイベント処理で表現できる状態を、Effect で後から同期しない。

次の用途では `useEffect` を使わない。

- props や state から計算できる値の保持
- state の初期値やリセット処理
- ユーザー操作への反応
- API の取得や再取得
- フォーム入力の検証・整形

render 中の計算、event handler、`key` による再マウント、SWR の query/mutation wrapper を優先する。

DOM API、browser API、購読、タイマーなど React の外部システムとの同期は例外として `useEffect` を使える。ただし、dependency array が同期対象を正確に表し、購読・listener・timer には cleanup を実装する。`useLayoutEffect` も同じ原則で扱う。

複数の業務領域で使う UI や型がある場合は、安易に相手の画面コンポーネントを import せず、次のいずれかを検討する。

- `entities/<entity>/ui` に業務データの表示部品を置く
- `shared/ui` に業務知識を持たない部品を置く
- feature 間で共有する処理を、共通の entity/model/API として抽出する

## 命名

- HTTP 通信関数は `get...`、`create...`、`update...`、`delete...` など動詞で始める
- 参照 hook は `use...` で始め、`queries/` に置く
- 更新 hook は `use...` で始め、`mutations/` に置く
- query hook は画面が理解できる業務名を使う。`useData` や `useApi` は使わない
- SWR key は query hook 内に定義し、同じ領域の key 名を揃える
- `utils`、`services`、`hooks` のような所有者不明の汎用フォルダを新設しない

## テストと Storybook

API 関数は React を起動せずにテストできるようにする。HTTP response、エラー、入力変換は `api/` のテストで確認する。

Query/mutation hook は、必要な場合に限り SWR provider と組み合わせてテストする。画面表示のテストでは、可能なら API の fixture または query wrapper の境界を利用し、ページから実際の HTTP 通信を発生させない。

コンポーネントの Storybook story は、`api/` の fixture や controller fixture を利用する。Storybook 用のデータ取得実装を本番 API と同じファイルへ混在させない。

## 移行手順

既存コードを移行する場合は、次の順番を基本とする。

1. 対象ページから `useSWR` と fetch 関数の組み合わせを洗い出す
2. 既存の fetch 関数を `api/` に残し、React/SWR 依存がないことを確認する
3. 画面ごとの SWR 呼び出しを `queries/` の hook へ移す
4. ページから直接 API と SWR key を参照しないようにする
5. 更新処理が複数 cache に関係する場合だけ `mutations/` へ移す
6. API、query/mutation、画面の順にテストを移す

最初の移行対象には、複数ページで利用されている `getProjectDirectory` とその `useSWR` 呼び出しを選ぶ。共通化の効果と、cache key の責務分離を確認しやすい。
