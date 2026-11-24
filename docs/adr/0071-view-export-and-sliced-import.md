# 0071. 表示中の view の書き出しはブラウザで作り、大きな import は worker が時間で区切って次の message に引き継ぐ

- 状態: 提案
- 日付: 2026-11-23
- 関連: Issue #394、#339（import・export の形式と階層）、#381（view の保存）、ADR 0060

## 背景

進捗報告では「この Project の WBS を CSV / Excel に出す」ことが日常的にある。これまでの export は
Workspace 管理者だけが Developer Platform の画面から実行でき、閲覧できる全 Work Item が対象で絞り込めなかった。
import は 1 回 1,000 行・2 MB までで、実際の backlog は手で分けて取り込む必要があった。

import の worker は SQS の 1 message を 1 回の Lambda 実行で最後まで処理する。行ごとに receipt と
checkpoint を残すので失敗時は途中から再開できるが、1 回の実行が Lambda の上限（15 分）を超える大きさの
import は、毎回 timeout して retry を使い切る。

## 決定

1. **表示中の view の書き出し**: Project の表・Team の表・マイタスクの表・ガントに「CSV で書き出す」
   「Excel で書き出す」を置く。file はブラウザが、画面に読み込み済みの Work Item から、view の filter・
   並び順・列を適用した行と、画面に表示している文字列で作る。新しい server の endpoint や権限は足さない。
   画面に出ている Work Item と値は、一覧の API が既に権限で絞ったものなので、読めない Work Item や
   値は file に入らない。CSV は UTF-8 の BOM 付きで、`=`・`+`・`-`・`@` で始まる値には `'` を付けて
   数式として実行されないようにする。
2. **export API の絞り込み**: `GET /api/developer/exports` と `GET /api/developer/work-item-exports` に
   `teamId`・`assignedProjectId`・`assigneeUserId`・`workflowStatusId`・`workItemTypeId`・`updatedAfter`
   を足す。閲覧できない Team・Project を指定したときは 404 ではなく空の export を返し、存在を明かさない。
   実行できるのは従来どおり Workspace 管理者。
3. **import の上限**: 1 回 10,000 行・4 MB にする。API は Lambda の同期呼び出しで、request の payload は
   6 MB までなので、mapping と event の分を残した値。4 MB は source を request の JSON 文字列にし、
   さらに API Gateway が Lambda event の JSON 文字列に入れた後の大きさ（`"`・`\`・改行・制御文字は
   2 回 escape される）で数える（contracts の `measureWorkItemImportContentBytes`）。引用符や改行の多い
   CSV が escape で 6 MB を超え、Lambda に届く前に落ちるのを防ぐため。Web の画面も送る前に同じ数え方で
   確かめる。5,000 行の WBS は
   1〜2 MB 程度で収まる。
   これより大きい source は、S3 へ直接 upload する経路が要るので今回は作らない。
4. **時間で区切る処理**: worker は claim してから 10 分（`WORK_ITEM_IMPORT_SLICE_SECONDS`）を過ぎたら、
   次の行や link に進む前に lease を外し、同じ job の message を queue に積んで今の message を正常終了する。
   次の実行は checkpoint の次の手順から続ける。1 回の実行は少なくとも 1 手順を記録してから区切るので、
   検証が長くかかっても job は必ず進む。lease を先に外すので、次の実行がすぐ claim できる。
   lease を外すときは期限だけを過去にして lease owner は残す。message を積めなかったときは claim し直して
   今の message を retry にする（checkpoint があるので重複は起きない）。claim し直しも失敗した最後の受信でも、
   owner が残っているので retry 切れとして job を `failed` にでき、`running` のまま止まらない。
   worker の role に import queue への `sqs:SendMessage` を足す。同じ queue へ積むので Lambda の再帰ループ検出
   （約 16 回で止める）に当たらないよう、関数に `RecursiveLoop: Allow` を設定する。1 回の実行は必ず 1 手順以上進め、
   手順数は job の行と link の数までなので、連鎖は有限で終わる。
5. **進捗**: worker は検証のたびに行と link の数を execution に `plannedSteps` として残す。
   `GET /api/developer/imports/{importJobId}/progress` が作成済みの行・適用済みの link とそれぞれの総数を返し、
   Developer Platform の画面は job が終わるまで 3 秒ごとに読む。`ImportJob` は閉じた schema なので、
   進捗は別の endpoint にした。
6. **Project manager の import**: 今回は開かない。import は Team の全行を作ってから親子・依存を付け、
   依存は Planning の manager 権限で付ける。Project manager だけに開くと、Team 横断の link と Project 外の
   行の扱いを別に決める必要がある。Developer Platform の画面と API は Workspace 管理者のまま残す。

## 検討した選択肢

- 書き出しを server の新しい endpoint（view ID を受けて server が filter を評価する）で作る: 画面にない
  行まで正しく出せるが、view の filter・並び順・列・表示文字列の評価を server に複製する必要がある。
  表示中の view を出す用途では、画面の行と一致することのほうが大事なので採らない。
- 大きな import を API 側で複数の job に分ける: 行どうしの親子・依存が job をまたぐと link の段階を
  job の外で調整する必要がある。1 job のまま実行だけを区切るほうが、既存の checkpoint と receipt を使える。
- Step Functions で区切る: 新しいサービスを足すことになり、既存の SQS と lease で足りる。

## 結果

- PM は Project の表から、絞り込んだ Work Item をそのまま CSV / Excel に書き出せる。
  画面に読み込んでいない行（ガント・カレンダーで期間外の行など）と、折りたたんだ親の子は file に入らない。
- 5,000 行を 1 回の dry-run と取り込みで扱える。実行が 10 分を超えても、次の message が続きを処理する。
- 区切りごとに source の読み直しと全行の再検証が入るので、大きな import ほど検証の回数が増える。
  1 回の検証は 5,000 行で 1 秒程度（ローカルの Floci）で、行の作成より十分短い。
- 更新した文書: `docs/public-api.md`、`docs/guide/pm.md`、`docs/guide/member.md`、`docs/guide/admin.md`
