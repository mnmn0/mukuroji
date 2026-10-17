# Web ディレクトリ構成の段階移行

`web/AGENTS.md` は `app → pages → features → entities → shared` を目標構成とし、既存の業務領域フォルダは段階移行の間だけ利用してよいと定めています。
この文書は、現在の `web/src` の業務領域を棚卸しし、各領域の移行先と移行順序を決めます。
ルール自体は `web/AGENTS.md` が正本です。この文書はルールを追加せず、移行の進め方だけを扱います。

## 現在の構成

2026-10 時点の `web/src` 直下には、目標構成のフォルダ (`app`、`pages`、`features`、`shared`、`assets`) と、移行前の業務領域フォルダが混在しています。
`entities/` はまだ存在しません。

| 領域 | 内部の分割 | 主な利用元 | 移行先 |
| --- | --- | --- | --- |
| `auth` | api, queries, model + 直下 3 file | 9 領域 | `entities/session` |
| `projects` | api, queries, model, ui | 12 領域 | `entities/project` |
| `work-items` | api, queries, model, ui | 11 領域 | `entities/work-item` |
| `workspace` | api, queries, mutations, model, ui | `app` と 9 領域 | `entities/workspace` |
| `issues` | api, queries, mutations, model, ui | tasks, task-views, files ほか | `entities/work-item` へ統合 |
| `tasks` | api, mutations, model, ui | issues, task-views, projects ほか | `entities/work-item` と `features/task-views` へ分割 |
| `task-views` | api, queries, mutations, model, ui | issues, tasks, workspace | `features/task-views` |
| `planning` | api, queries, mutations, model, ui | projects, tasks, work-items | `features/planning` |
| `files` | api, queries, mutations, ui + 直下 1 file | issues, requests, tasks | `entities/file` |
| `documents` | api, queries, model, ui + 直下 2 page | app, issues, tasks | `features/documents` と `pages/` |
| `requests` | api, queries, model, ui + 直下 2 page | app | `features/request-intake` と `pages/` |
| `search` | api, queries, model, ui + 直下 1 page | app, commands, task-views | `features/search` と `pages/` |
| `commands` | ui | app, task-views, tasks, workspace | `features/command-menu` |
| `customers` | api, queries, mutations, ui | tasks, triage | `features/customers` |
| `notifications` | api, queries, mutations, model, ui | workspace | `entities/notification` と `features/notification-preferences` へ分割 |
| `bulk-operations` | api, model, ui | tasks | `features/bulk-operations` |
| `analytics` | api, queries, model, ui + 直下 1 file | pages のみ | `features/analytics` |
| `automation` | api, queries, mutations, model, ui + 直下 1 file | pages のみ | `features/automation-management` |
| `developer-platform` | api, queries, mutations, model, ui | work-items | `features/developer-platform` |
| `security` | api, queries, model, ui | pages のみ | `features/enterprise-security` |
| `triage` | api, queries, mutations, model, ui | tasks | `features/triage` |
| `workload` | queries, mutations, model, ui + 直下 `api.ts` | pages のみ | `features/workload` |
| `service-worker` | model + `sw.ts` | 別 entry | 現状維持 (Vite の別 entry) |

「主な利用元」は、その領域を import している別の領域です。`pages/` からの import は数えていません。
利用元が多い領域ほど移動時の差分が大きくなるため、後半に回します。

## 目標構成との差分

移行前に解消すべき具体的な差分は次のとおりです。

1. **route component が `pages/` の外にある。**
   `documents/DocumentPage.tsx`、`documents/SharedDocumentPage.tsx`、`requests/PublicRequestFormPage.tsx`、`requests/RequestIntakePage.tsx`、`search/SearchPage.tsx` は router が直接参照する画面です。
   `web/AGENTS.md` では route component は `pages/` に置きます。
   このうち 4 file には隣接する `*.stories.tsx` があり、story も page を import するため、移動は story と一緒に行います。
2. **領域直下に責務の分からない file がある。**
   次の 2 file は既存の layer へそのまま移せます。
   - `analytics/liveQuery.ts` は `queryAnalytics` を直列化し、後続 request の開始時に前の request を中断する取得の調停だけを持つため、`analytics/queries/liveQuery.ts` へ移します。
   - `workload/api.ts` は Workload API の `fetch` 関数と request 型だけを持つため、`workload/api/index.ts` へ移します。既存の `'../api'` からの import はそのまま解決されます。
   `automation/managementData.ts` は複数 endpoint の読み込みなので `queries/` が移動先ですが、`ui/AutomationManagementPanel` から `AutomationWorkflowTargetOption` 型を import しています。
   そのまま `queries/` へ移すと `queries` から `ui` への逆向きの依存が残るため、先にこの型を `model/` へ移す別 PR を行い、その後に移動します。
   次の file は既存の layer に当てはまらないため、置き場所を先に決めます。
   - `files/pdfRuntime.ts` は PDF.js の worker 設定と読み込みだけを持ち、業務知識を持ちません。`shared/lib/` の「業務領域に依存しない小さなライブラリ関数」に当たるため、`shared/lib/pdf/` へ移します。
   - `auth/session.ts` は `localStorage` / `sessionStorage` への認証 session の永続化です。通信ではないため `api/` ではなく、副作用を持つため `model/` でもありません。
   - `auth/enterpriseSso.ts` も同じく、Enterprise SSO の redirect 中の request state を `sessionStorage` に保存・消費し、callback URL を `window.history.replaceState` で消去します。
     `web/AGENTS.md` の領域内 layer にはブラウザ storage と URL 操作の置き場所がないため、移動前に `web/AGENTS.md` へ置き場所（例: `entities/session/storage/`）を追加する別 PR が必要です。
     それまでは 2 file とも現在の場所に残し、`auth` を `entities/session` へ移す手順 7 もその PR の後に行います。
3. **同じ業務データを複数の領域が持っている。**
   `issues`、`tasks`、`work-items` は、いずれも canonical Work Item の取得・表示・更新を扱います。
   entity へ移すときに一つの `entities/work-item` へ統合します。
4. **`entities/` がない。**
   多くの領域から使われる `projects`、`work-items`、`workspace`、`auth` は、現在は feature と同じ階層にあります。
   ただし、このうち `projects`、`workspace`、`issues`、`tasks`、`work-items` は feature 候補の領域を import しています（例: `issues` と `tasks` から `task-views`、`workspace` から `notifications` と `commands`、`work-items` から `developer-platform`）。
   そのまま `entities/` へ移すと、`entities` から `features` への依存を禁止するルールに違反します。
5. **routing 用の layout と provider が `app/` の外にある。**
   `workspace/ui/WorkspaceRoute.tsx`、`workspace/ui/WorkspaceRouteProvider.tsx`、`commands/ui/WorkspaceCommandMenu.tsx` の `WorkspaceCommandMenuLayout` は router が複数画面で共有する layout / provider です。
   `web/AGENTS.md` ではこれらを `app/layouts/` と `app/providers/` に置きます。
   ただし、どちらもそのまま移せる薄い layout / provider ではありません。
   `WorkspaceCommandMenuLayout` は command menu の feature 本体と同じ file にあり、`WorkspaceRouteProvider` は project、notification、auth、AI の query を自ら呼んでいます。
6. **feature 候補の領域同士が内部実装を import している。**
   `web/AGENTS.md` は feature から別 feature の page や内部 UI を直接 import することを禁止していますが、`.dependency-cruiser.cjs` には feature 同士の依存を検査するルールがありません。
   現在は次の import があります。
   - `triage`、`search`、`requests`、`documents`、`planning` から `features/ai-assistance` の `ui/`、`mutations/`、`model/`
   - `triage` から `customers/api`、`task-views` から `search/api/errors`、`commands` から `search/api`
   - `task-views` から `commands/ui/WorkspaceCommandMenuContext`
   - 逆方向として、既存の `features/ai-assistance/model/aiGenerationValidation.ts` から `search/model/searchFilterTransportBudget`
   これらを残したまま `features/` へ移すと、移動後に禁止された依存がそのまま残ります。
7. **notification の業務データと設定 UI が一つの領域にある。**
   受信箱と未読数は workspace の layout / provider と inbox page の両方が使う業務データです。
   一方、通知設定の編集は設定画面だけが使う業務操作です。
   一つの feature として移すと、`entities` へ移る workspace 側から feature を参照することになるため、受信箱・未読数の取得と表示を `entities/notification`、通知設定の管理を `features/notification-preferences` に分けます。

## 移行の順序

一度に全フォルダを移動せず、次の順序で小さな PR に分けます。
各 PR は `bun run dependencies:check` と `bun run knip:check` を通し、移動以外の変更を混ぜません。

`web/AGENTS.md` の「移行方針」は、最初の移行対象を `getProjectDirectory` とその `useSWR` 呼び出しの `api/` / `queries/` への分離としています。
この文書の手順はその後に行うフォルダ移動の順序であり、その分離を置き換えません。

0. **`getProjectDirectory` を分離する。**
   `web/AGENTS.md` の「移行方針」に従い、fetch を `projects/api/`、`useSWR` と SWR key を `projects/queries/` へ移します。
   取得処理の変更を含むため、フォルダ移動の PR とは分けます。
1. **route component を `pages/` へ移す。**
   差分 1 の 5 file と隣接する story を、route の認証境界に合わせて既存の `pages/workspace/` と `pages/public/` へ移します。

   | 移動元 | route | 移動先 |
   | --- | --- | --- |
   | `documents/DocumentPage.tsx` と `DocumentPage.stories.tsx` | `/documents`、`/documents/:documentId`（workspace layout 内） | `pages/workspace/DocumentPage.tsx` と `.stories.tsx` |
   | `documents/SharedDocumentPage.tsx` と `SharedDocumentPage.stories.tsx` | `/share/documents/:shareToken`（未認証） | `pages/public/SharedDocumentPage.tsx` と `.stories.tsx` |
   | `requests/RequestIntakePage.tsx` と `RequestIntakePage.stories.tsx` | `/requests`（workspace layout 内） | `pages/workspace/RequestIntakePage.tsx` と `.stories.tsx` |
   | `requests/PublicRequestFormPage.tsx` と `PublicRequestFormPage.stories.tsx` | `/request/:linkToken`（未認証） | `pages/public/PublicRequestFormPage.tsx` と `.stories.tsx` |
   | `search/SearchPage.tsx`（story なし） | `/search`（workspace layout 内） | `pages/workspace/SearchPage.tsx` |

   移動だけの PR とし、画面固有の取得処理の `queries/` / `mutations/` への切り出しは、移動後の別 PR で行います。
2. **領域直下の file を下位 layer へ移す。**
   差分 2 の file を、責務に応じて `api/`、`queries/`、`model/`、`shared/lib/` へ移します。
   `automation/managementData.ts` は、`AutomationWorkflowTargetOption` 型を `model/` へ移す別 PR の後に `queries/` へ移します。
   `auth/session.ts` と `auth/enterpriseSso.ts` は、置き場所が `web/AGENTS.md` に追加されるまで移しません。
3. **利用元が pages だけの領域を `features/` へ移す。**
   `analytics`、`automation`、`security`、`workload` は他の領域から import されないため、移動の影響が page と story に限られます。
4. **feature 候補の領域同士の依存を解消する。**
   移動の前に、差分 6 の import を一つずつ解消します。移動を伴わない PR とし、領域ごとに分けて構いません。
   - 複数の領域から使われる API や error（`customers/api`、`search/api/errors`）は、entity または共通の `api/` へ移します。
   - `searchFilterTransportBudget` のように別 feature の model から参照される上限値は、契約として `@mukuroji/contracts` か entity の `model/` へ移します。
   - `features/ai-assistance` の UI を組み込んでいる箇所は、page が AI の component を組み立てて props / slot として渡す形にするか、`features/ai-assistance` の public な入口（`index.ts`）だけを参照する形にします。
   - `WorkspaceCommandMenuContext` のように画面をまたいで共有する UI 状態は、`app/providers/` に置き、feature は callback を受け取る形にします。
   最後に、feature から別 feature の public な入口以外への依存を禁止するルールを `.dependency-cruiser.cjs` へ追加し、以降の移動で依存が戻らないようにします。
5. **利用元が少数の領域を `features/` へ移す。**
   `triage`、`customers`、`bulk-operations`、`developer-platform`、`commands`、`search`、`requests`、`documents`、`planning`、`task-views` の順に移します。
   `notifications` は差分 7 のとおり分割し、通知設定の管理だけをこの段階で `features/notification-preferences` へ移します。
6. **routing 用の layout と provider を分割し、`app/` へ移す。**
   差分 5 の file は移動だけでは済まないため、先に分割します。
   - `WorkspaceCommandMenuLayout` を command menu の feature 本体から別 file へ切り出します。
   - `WorkspaceRouteProvider` が呼んでいる project、notification、auth、AI の query は、それぞれの entity / feature の query hook に移し、provider はそれらを組み立てて context に渡すだけにします。
   分割を移動とは別の PR で行い、薄くなった layout を `app/layouts/`、provider を `app/providers/` へ移す PR は移動だけにします。
   `workspace` を `entities/` へ移す前に行い、`entities/workspace` に routing の責務が残らないようにします。
7. **共有される業務データを `entities/` へ移す。**
   移す前に、差分 4 の feature への依存を解消します。
   feature の UI や処理を組み立てている部分は、`pages/` または対応する `features/` 側へ移すか、entity が受け取る props / callback に置き換えます。
   依存が解消された領域から順に、`files`、`notifications` の残り（受信箱と未読数、`entities/notification`）、`auth`、`projects`、`workspace` を移し、最後に `issues`、`tasks`、`work-items` を `entities/work-item` へ統合します。

## 移動時の確認

- `.dependency-cruiser.cjs` の既存ルールは、`pages`、`shared`、`model`、`api` の境界を検査します。
  `entities/` を作るときは、`entities` から `features` と `pages` への依存を禁止するルールを同じ PR で追加します。
  feature 同士のルールは手順 4 で追加します。
- 移動だけの PR では、移動前後で文の内容が変わらないことを確認します。
  変わるのは import の path と、別 module から参照されるようになった宣言の `export` だけにします。
- 新しく export した宣言には TSDoc を付けます。
- Storybook の story は、移動先の `ui/` に component と一緒に置きます。
  ただし手順 1 の route component の story は、表のとおり `pages/workspace/` / `pages/public/` の page の隣に置きます。
- `web:build`、`web:lint:ci`、`web:test`、`web:build-storybook` を実行します。
  画面の構成を変える場合は `web:e2e` も実行します。
