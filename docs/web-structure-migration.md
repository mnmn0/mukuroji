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
| `notifications` | api, queries, mutations, model, ui | workspace | `features/notifications` |
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
   `analytics/liveQuery.ts`、`automation/managementData.ts`、`workload/api.ts` は、`api/`、`queries/`、`model/` のいずれかへ移せます。
   次の 2 file は既存の layer に当てはまらないため、置き場所を先に決めます。
   - `files/pdfRuntime.ts` は PDF.js の worker 設定と読み込みだけを持ち、業務知識を持ちません。`shared/lib/` の「業務領域に依存しない小さなライブラリ関数」に当たるため、`shared/lib/pdf/` へ移します。
   - `auth/session.ts` は `localStorage` / `sessionStorage` への認証 session の永続化です。通信ではないため `api/` ではなく、副作用を持つため `model/` でもありません。
     `web/AGENTS.md` の領域内 layer にはブラウザ storage の置き場所がないため、移動前に `web/AGENTS.md` へ置き場所（例: `entities/auth/storage/`）を追加する別 PR が必要です。それまでは現在の場所に残します。
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

## 移行の順序

一度に全フォルダを移動せず、次の順序で小さな PR に分けます。
各 PR は `bun run dependencies:check` と `bun run knip:check` を通し、移動以外の変更を混ぜません。

`web/AGENTS.md` の「移行方針」は、最初の移行対象を `getProjectDirectory` とその `useSWR` 呼び出しの `api/` / `queries/` への分離としています。
この文書の手順はその後に行うフォルダ移動の順序であり、その分離を置き換えません。

0. **`getProjectDirectory` を分離する。**
   `web/AGENTS.md` の「移行方針」に従い、fetch を `projects/api/`、`useSWR` と SWR key を `projects/queries/` へ移します。
   取得処理の変更を含むため、フォルダ移動の PR とは分けます。
1. **route component を `pages/` へ移す。**
   差分 1 の 5 file と、隣接する story を対応する `pages/<boundary>/` へ移します。
   移動だけの PR とし、画面固有の取得処理の `queries/` / `mutations/` への切り出しは、移動後の別 PR で行います。
2. **領域直下の file を下位 layer へ移す。**
   差分 2 の file を、責務に応じて `api/`、`queries/`、`model/`、`shared/lib/` へ移します。
   `auth/session.ts` は置き場所が `web/AGENTS.md` に追加されるまで移しません。
3. **利用元が pages だけの領域を `features/` へ移す。**
   `analytics`、`automation`、`security`、`workload` は他の領域から import されないため、移動の影響が page と story に限られます。
4. **利用元が少数の領域を `features/` へ移す。**
   `triage`、`customers`、`bulk-operations`、`notifications`、`developer-platform`、`commands`、`search`、`requests`、`documents`、`planning`、`task-views` の順に移します。
5. **routing 用の layout と provider を `app/` へ移す。**
   差分 5 の layout を `app/layouts/`、provider を `app/providers/` へ移します。
   `workspace` を `entities/` へ移す前に行い、`entities/workspace` に routing の責務が残らないようにします。
6. **共有される業務データを `entities/` へ移す。**
   移す前に、差分 4 の feature への依存を解消します。
   feature の UI や処理を組み立てている部分は、`pages/` または対応する `features/` 側へ移すか、entity が受け取る props / callback に置き換えます。
   依存が解消された領域から順に、`files`、`auth`、`projects`、`workspace` を移し、最後に `issues`、`tasks`、`work-items` を `entities/work-item` へ統合します。

## 移動時の確認

- `.dependency-cruiser.cjs` の既存ルールは、`pages`、`shared`、`model`、`api` の境界を検査します。
  `entities/` を作るときは、`entities` から `features` と `pages` への依存を禁止するルールを同じ PR で追加します。
- 移動だけの PR では、移動前後で文の内容が変わらないことを確認します。
  変わるのは import の path と、別 module から参照されるようになった宣言の `export` だけにします。
- 新しく export した宣言には TSDoc を付けます。
- Storybook の story は、移動先の `ui/` に component と一緒に置きます。
- `web:build`、`web:lint:ci`、`web:test`、`web:build-storybook` を実行します。
  画面の構成を変える場合は `web:e2e` も実行します。
