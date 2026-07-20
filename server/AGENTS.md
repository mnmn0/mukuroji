# AGENTS.md

このファイルは `server/` 配下の作業に適用します。共通ルールはリポジトリルートの `AGENTS.md` に従ってください。

## 責務境界

- `src/index.ts` は Bun / Lambda の安定した entrypoint とし、runtime adapter と public re-export 以外の責務を増やさない。
- Hono app の組み立てと既存 route registration は `src/api/app.ts` が担う。新規または変更する feature 単位の route group は `src/api/routes/` へ分離する。
- AWS SDK adapter と domain rule を `src/api/app.ts` へ追加せず、機能別の data access / domain module に置く。
- route handler では入力検証、認可、domain 呼び出し、response mapping の境界を明確にする。
- `/api` の canonical route、Function URL 直下 event の prefix normalization、公開 export の互換性を維持する。
- 外部 service は型付けした dependency として注入し、test が実 AWS resource に接続しないようにする。
- test support は `src/test-support/` に集約し、機能別 test file から共有する。test file を追加した場合は `package.json` の test script から実行対象になることを確認する。

## 検証

```sh
bun run server:test
bun run server:build:lambda
bun run oxc:lint
```
