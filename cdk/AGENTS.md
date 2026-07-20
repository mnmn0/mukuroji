# AGENTS.md

このファイルは `cdk/` 配下の作業に適用します。共通ルールはリポジトリルートの `AGENTS.md` に従ってください。

## 互換性

- 既存 resource の Construct ID、scope、CloudFormation logical ID、Output 名を維持する。
- 整理目的の変更で resource を子 Construct に移さない。scope の追加は stateful resource の置換につながるため、明示的な migration 計画なしに行わない。
- DynamoDB などの stateful resource は既存の Retain と PITR 設定を維持する。
- seed / bootstrap payload と resource 定義を分離しても、transaction の条件、key、timestamp、冪等性を変えない。
- deploy、hotswap、AWS account に影響する lookup はユーザーの明示確認なしに実行しない。

## 検証

```sh
bun run cdk:build
bun run cdk:test
bun run cdk:synth
```

整理前後の synthesized template では、少なくとも stateful resource の logical ID と Outputs が一致することを確認する。
