# AGENTS.md

このファイルは `contracts/` 配下の作業に適用します。共通ルールはリポジトリルートの `AGENTS.md` に従ってください。

## 責務境界

- `src/index.ts` は domain module を公開する barrel に保つ。
- contract は Web / Server のどちらにも依存せず、runtime side effect や infrastructure 固有処理を持たせない。
- contract は CDK にも依存しない。`web`、`server`、`cdk` は consumer であり、`contracts` から逆参照しない。
- schema version、request、response、共有 value type は機能単位の module にまとめる。
- exported 宣言と type / interface の各 property には用途と互換性が分かる TSDoc を付ける。
- contract 変更時は Web と Server の consumer を両方 build または test する。
- domain module から `src/index.ts` を参照せず、依存する具体的な sibling domain module を import する。これらの境界は dependency-cruiser で検査する。
