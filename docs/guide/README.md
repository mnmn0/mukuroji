# mukuroji 利用者ガイド

mukuroji は、社内のプロジェクトを WBS で管理し、週次の進捗報告から coding agent による実装（Software factory）
までを1つの Workspace で扱うアプリケーションです。このガイドは画面の使い方を役割別にまとめたものです。
保存形式や API などの技術的な仕様は `docs/` 直下の各文書にあり、各ページの末尾から参照しています。

## 役割別のガイド

| ガイド | 対象 | 主な内容 |
| --- | --- | --- |
| [PM ガイド](pm.md) | Project を進める人 | Project の立ち上げ、WBS、日程と依存関係、計画、週次の近況報告、レポート、終結 |
| [メンバーガイド](member.md) | タスクを担当する人 | ホーム、マイタスク、タスク詳細、フォーカス、受信箱、工数、依頼 |
| [管理者ガイド](admin.md) | Workspace の owner・admin、Team の管理者 | 招待と権限、Work Item の設定、オートメーション、リクエスト受付、API、エージェント設定、ID・セキュリティ |
| [coding agent 利用者ガイド](coding-agent.md) | agent に作業させる開発者 | token の発行、接続設定、作業の流れ、Factory board |

はじめての人は、まず [メンバーガイド](member.md) の「1日の流れ」を読んでください。

## 基本の考え方

- **Workspace**: 会社全体の作業場所。メンバーは owner / admin / member / guest のいずれかのロールを持ちます。
- **Team**: タスク（Work Item）を持つ単位。状態の流れや入力項目、Triage、エージェント設定は Team ごとに決められます。
- **Project**: Team の中で期限と目的を持って進める単位。Project ごとに manager / member / viewer のロールがあります。
- **Work Item**: タスク・課題の1件。`PT-12` のようなキーで参照でき、親子にすると WBS になります。

ほかの用語は [用語集](../glossary.md) を参照してください。

## よくある作業

| やりたいこと | 参照先 |
| --- | --- |
| Project を作って WBS を組む | [PM ガイド 1〜4](pm.md#1-project-を作る) |
| 週次の近況を報告する | [PM ガイド 7](pm.md#7-毎週近況を公開する) |
| 自分のタスクを進める | [メンバーガイド](member.md#マイタスク) |
| 作業時間を記録・提出する | [メンバーガイド](member.md#工数を記録する) |
| メンバーを招待する | [管理者ガイド](admin.md#メンバーを招待する外す) |
| 状態の流れや入力項目を変える | [管理者ガイド](admin.md#work-item-の設定ワークフローとフィールド) |
| coding agent を接続する | [coding agent 利用者ガイド](coding-agent.md#接続する) |

## 画面の画像について

ガイドの画像は、visual regression test の基準画像（`web/visual/__screenshots__/`）を再利用しています。
Storybook のサンプルデータで描画したもので、実際の Workspace の内容とは異なります。

## ガイドの更新

利用者から見える動作を変える PR では、該当するガイドのページも更新してください
（[CONTRIBUTING.md](../../CONTRIBUTING.md)）。
