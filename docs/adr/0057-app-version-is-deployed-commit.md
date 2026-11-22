# 0057. アプリ全体の version は deploy した commit とし、変更履歴は deploy ごとの比較 link で残す

- 状態: 提案
- 日付: 2026-11-22
- 関連: Issue #440、Issue #358、ADR 0039

## 背景

Issue #440 で「アプリ全体の version と変更履歴の付け方を決める」ことになった。現状は次のとおり。

- 本番は 1 環境だけで、`main` の先頭を GitHub Actions から deploy する（ADR 0039）。古い commit の
  再実行は deploy を断り、戻すときは `main` で revert して deploy し直す。
- Web は build に埋め込んだ commit SHA を Help 画面に出し、API は `/api/health` の
  `applicationCommitSha` で返す。両者が違うと画面が再読み込みを促す（PR #717）。
- 社外へ配る物は coding agent MCP の `mcp.mjs` だけで、これは Semantic Versioning の version と
  `CHANGELOG.md` を持つ（Issue #358）。
- `web/package.json` などの `version` は `0.0.0` のまま使っていない。

## 決定

- アプリ（Web・API・worker・CDK）全体の version は、deploy した commit の full SHA とする。
  semver や日付の version 番号は付けず、package の `version` も上げない。利用者と運用者が見る場所は
  Help 画面の Web build と `/api/health` の `applicationCommitSha` で、2 つが一致していることが
  「同じ version」を意味する。
- 変更履歴は deploy ごとに残す。`scripts/github-deploy.ts` は deploy 前に稼働中の
  `/api/health` から前の commit を読み、job summary に前の commit と今回の commit、GitHub の
  比較 link（`<repository>/compare/<前>...<今回>`）を書く。`main` は PR の squash merge で進むので、
  比較 link の commit 一覧がそのまま PR 単位の変更履歴になる。前の commit が読めない初回などは
  「前の commit 不明」と書く。
- `CHANGELOG.md` は引き続き MCP と、MCP が使う server API の破壊的変更・非推奨だけを書く場所にする。
  アプリ全体の変更は書かない。

## 検討した選択肢

- アプリにも Semantic Versioning と手書きの CHANGELOG を持つ: 1 環境への継続 deploy では
  version を上げる契機がなく、PR ごとの手書きは漏れやすい。互換性を約束する相手（外部の client）も
  MCP 以外にない。
- 日付ベースの version（`2026.11.22` など）を build 時に付ける: commit SHA と別の識別子が増えるだけで、
  同じ日の複数 deploy を区別するには結局 SHA が要る。
- deploy ごとの変更一覧を S3 や DynamoDB に保存して画面に出す: 新しい保存先と画面が要る。GitHub の
  比較 link と job summary（Actions の保持期間内）で運用者には足りる。

## 結果

- version の番号付けや CHANGELOG の追記を PR ごとに行う必要がない。
- 「いつ何が入ったか」は deploy workflow の job summary の比較 link で辿る。GitHub Actions の
  run の保持期間を過ぎた summary は消えるが、`main` の履歴と `/api/health` の SHA から同じ比較を作れる。
- 利用者向けの「新機能のお知らせ」は持たない。必要になったら別に判断する。
- 更新した文書: `cdk/README.md`（GitHub Actions から deploy する）、`CHANGELOG.md` の冒頭。
