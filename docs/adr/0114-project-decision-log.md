# 0114. 意思決定ログを Planning table の1決定1行で持ち、Team の一覧は読み取り時に Project をまたいで集める

- 状態: 提案
- 日付: 2026-11-28
- 関連: Issue #830、ADR 0024（リスク・課題・変更要求の登録簿）、ADR 0113（Slack の取り込み）

## 背景

会議・Slack・issue で決まったことを、決めた内容・理由・決めた人・日時・出典リンク付きで残し、Work Item・Project に
紐付けたい（#830）。Slack の会話は正本にしないので、決まったことはここへ移す。これまでは Work Item ごとの decision メモ
（collaboration の curated context）と、変更要求の承認・却下（ADR 0024 の登録簿）はあったが、Project を横断して決定を
一覧・検索する場所がなかった。設計の決定は従来どおり GitHub の ADR を正本にし、ログからリンクする。
費用は「なるべく安く」が方針なので、新しい table・index・常時課金のサービスは増やしたくない。

## 決定

1. 決定は既存の Planning table（`workspaceId` / `recordKey`）に1件1行で置く。record key は
   `PROJECT_DECISION#<teamId>#<projectId>#ENTRY#<entryId>`（各 ID は `encodeURIComponent`）、`entryType = project-decision-entry`。
   同じ prefix の `PROJECT_DECISION#<teamId>#<projectId>`（`entryType = project-decision-log`）に件数 counter を置き、
   追加の前に件数を読み、100 未満なら transaction でその件数のままであることを条件に1増やす（競合した追加は再試行を促す 503）。決定・counter・呼び出し元の認可 fence・audit event を
   1つの transaction で書く。更新は決定ごとの `revision` を CAS にする。削除はなく、状態（有効・置き換え済み・取り消し）で表す。
2. 決定は要約（200 文字）、決めた内容と理由（各 2,000 文字）、決めた人（Project member の member key、10 人まで）、
   Project 外の決めた人の自由記述（200 文字）、決めた日時（UTC、server 時刻より24時間を超えて先は不可、秒の小数はミリ秒まで）、関連 Work Item（同じ
   Project の Work Item、10 件まで）、出典（`https` / `http` の URL、認証情報を含まない 1,000 文字まで、5 件まで、表示名付き）、
   置き換えた決定（同じ Project の決定）、記録元（`project` / `work-item` / `document` / `slack`）、記録した人を持つ。
   記録元と記録した人は最初の記録のまま変えない。`slack` は Slack の shortcut だけが server 側で付け、HTTP の body からは受けない。
3. 決定 ID は Idempotency-Key・actor・Project から決まる hash にし、同じ request の再送は保存済みの決定を返す
   （ADR 0024 と同じ）。関連 Work Item は、呼び出し元が読めて同じ Project にあることを確かめ、Project 割り当ての fence を
   同じ transaction に入れる。決めた人は記録の時点で Project member であることを確かめ、後で抜けても記録には残すので fence は置かない。
4. 読み取りは Project の viewer、記録・編集は Project の member（Enterprise は `projects.read` / `projects.write`）で、
   リスク・課題・変更要求の登録簿と同じ判定にする。
5. Team の意思決定ログ（`GET /api/teams/:teamId/decision-log`）は、読み取りのたびに `begins_with(recordKey, PROJECT_DECISION#<teamId>#)`
   の Query（counter 行は filter で除く、eventually consistent）で Team の決定を読み、呼び出し元が見られる Project のものだけを残す。
   同じ Project の登録簿から承認・却下済みの変更要求を足し、決めた日時の新しい順に 100 件まで返す（それより多ければ `truncated`）。
   キーワード（100 文字まで）と Project で絞れる。Work Item の decision メモは既存の Workspace 検索（`context-item`）で読み、
   画面で同じページに出す。決定を検索 index には入れない。
6. 記録・更新は `project.decision_recorded` / `project.decision_updated` / `project.decision_superseded` /
   `project.decision_withdrawn` / `project.decision_reinstated` の audit event に残す。要約・内容・理由・決めた人・出典は
   値を伏せ、変わったことだけを残す（private channel の URL や member key を監査ログの写しに残さない）。

## 検討した選択肢

- Project ごとに1行: 読み書きが1回で済むが、自由記述と出典で DynamoDB の 400 KB の item 上限に当たる。
- 新しい table や GSI（Team・日時順）: Team の一覧を Query 1 回で日時順に読めるが、table・IAM・backup・backfill が増える。
  1 Team の決定は当面数百件で、読み取り時に集めても読み取り単位は小さい。
- 決定を Workspace 検索 index に入れる: 全文検索と「聞く」（#829）にそのまま使えるが、projection・backfill・ACL の同期が要る。
  まず Team 一覧のキーワード絞り込みで足りるかを見る。
- Work Item の curated `decision` を流用: Work Item ごとの注釈で、Project 単位の決定や Work Item のない決定を持てない。
- OpenSearch Serverless などの検索基盤: 常時課金で方針に合わない。

## 結果

- 1 Project 100 件まで保存できる。上限は、全件を返す Project の一覧が自由記述と出典を最大まで使っても Lambda の 6 MB
  応答上限に収まるように決めた。1 件は各項目の上限で約 14,000 文字になる。引用符やバックスラッシュは JSON で 2 バイト、
  Lambda の応答が本文をさらに JSON 文字列に入れると 4 バイトになるので、1 件は最大でおよそ 58 KB、100 件で約 5.8 MB になる。Team の一覧は 100 件までで、件数と同じく応答上限に収まる。
- Team の一覧は Team の決定を全件読むので、決定が増えると読み取り単位と応答時間が伸びる。数千件を超えるようなら、
  日時順の index か検索 index を足す新しい ADR を作る。
- Slack の message shortcut「決定として記録」は、ADR 0113 の Slack app に interactivity の受け口と Slack 利用者と
  member の対応づけが要るため、この変更では作らない。use case は `origin: 'slack'` を server 側で付けて呼べる形にしておく。
- Update feed への表示と「聞く」（#829）からの参照は、ここで残す audit event と一覧の API を材料に後から足す。
- 利用者ガイドは `docs/guide/pm.md` を更新した。
