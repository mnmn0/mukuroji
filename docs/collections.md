# Collections

Issue #238 の最初の段階として、canonical Work Item を複製せずに複数の文脈から参照できる整理用の Collection を追加します。
Collection は workflow、assignee、status を持たず、Work Item の所有 Team（`teamId`）と primary Project（`assignedProjectId`）は変更しません。

## 用語

- **所有 Team**: Work Item の正本を持つ Team。Work Item ID、conversation、decision、activity、dependency はここに残ります。
- **primary Project**: 実行を担う Project。0 または 1 つで、既存の `assignedProjectId` がこれに当たります。
- **Collection**: Workspace 全体で共有する整理用の入れ物。一つの Work Item を複数の Collection に入れられます。

## 権限と可視性

- Collection の一覧・作成・名前変更・削除・Work Item の追加と削除は、Workspace の business read / write 権限で行います。Guest は利用できません。
  Enterprise principal は `work-items.read`（参照）、`work-items.write` または `workspace.write`（変更）が必要です。Collection は Workspace 全体の resource なので、これらの権限は Workspace scope の割り当てで判定し、Team / Project scope だけの grant では Collection を参照・変更できません。Team / Project scope の割り当ては Item の可視性判定にだけ使います。`/api/collections` 配下の path に含まれる `projects/<id>` や `teams/<id>` などの segment（Item の Team ID と Work Item ID）は認可対象の resource として解釈せず、常に Workspace で判定します。
  一覧 response の `canWrite` は変更できるかどうかを返し、Web は変更できない member に編集操作を表示しません。
- Collection は閲覧権限を広げません。Item の一覧は、Work Item detail と同じ Team / primary Project の viewer 判定を通った Work Item だけを返し、読めない Work Item は存在を示さずに省きます。
- Work Item の追加と参照の削除には、操作する人がその Work Item を読める必要があります。読めない Work Item と存在しない Work Item は同じ `404 CollectionWorkItemNotFound` を返すため、ID を推測して隠れた参照の有無を確かめることはできません。
- Collection から開いた Work Item は、通常の canonical Work Item detail と mutation を使います。Collection ごとの別データは作りません。
- Work Item の追加候補は `GET /api/collections/candidates?keyword=` で探します。Workspace 検索 index を `entityTypes: ["work-item"]` に固定して引くため、`workspace.read` ではなく Collection と同じ `work-items.read` で利用でき、結果は呼び出し元が読める Work Item に限られます。keyword が空の場合は `400 InvalidCollectionCandidateQuery` です。検索は権限で絞り込まれた cursor pagination なので、大きな Workspace でも全 Work Item を一度に読み込みません。検索 index は best-effort の projection で、projection に失敗した Work Item は index に現れないため、最初の page（cursor なし）から keyword を Work Item ID として canonical Work Item も直接引きます。まず読み込み済みの directory と Project access から呼び出し元が読める Team だけに絞り（Work Item は読まない）、その Team を最大 100 件まで 10 件ずつ並行して読み、Item 一覧と同じ Team / primary Project の viewer 判定を通った完全一致だけを、Team 順で結果の先頭に置きます。page の件数は完全一致を含めて `limit` 以下です。完全一致が page に収まらない間は `exact:<offset>` cursor で続きを返し、完全一致を出し切った page の残り枠だけ index の最初の page で埋めて index の cursor を返します。index の結果からは、どの page でも、対象 Team で keyword を Work Item ID とする結果を除きます（完全一致としてすでに返したか、canonical Work Item として読めないもののため）。これにより同じ Work Item が page をまたいで重複しません。すでに Collection に入っている Work Item は候補数に数えずに次の page を読みます。cursor が残る限り次の page を読み（検索 server は 1 page ごとに評価する行数が限られ、他の種類の entity だけで空の page になることがあるため）、異常な走査に備えて最大 100 page で止めます。応答が以前の cursor を繰り返した場合は、不正または version の食い違った応答として結果の終わりとは扱わず、失敗（`502` 相当）として表示します。Web の候補検索 keyword は canonical な Work Item ID と同じ 256 文字まで入力できます。Web の候補検索は入力のたびではなく、検索 button（form の submit）で明示的に実行するため、入力の debounce は不要です。
- 追加・削除は、可視性確認で読んだ canonical Work Item の revision を、Collection の書き込みと同じ DynamoDB transaction の ConditionCheck で確認します。Enterprise 以外の member は Project membership の行を通じて Work Item を読むため、可視性を与えた Project membership（primary Project があればその Project、無ければ Team を読める Project の一つ）も同じ transaction で確認します。Project の archive は membership の行ではなく Project の行を変えるため、その Project と Team が active であることも同じ transaction で確認します（system admin、Team への直接 grant、Enterprise の Project grant は Enterprise control の fence で確認します）。確認後に Work Item が削除・移動・変更された場合や Project membership が外された場合、Project・Team が archive された場合は書き込まず、Work Item と呼び出し元の Project access を読み直して可視性を再確認してから再試行します（外された grant 以外に Team を読める Project があれば、その membership で再試行します）。読めなくなっていれば `404 CollectionWorkItemNotFound`、再試行を使い切った場合は `409 CollectionWorkItemChanged` です。Membership などの権限が書き込み後に変わっても、一覧は読むたびに可視性を再判定するため、読めない Work Item は表示されません。
- Team ID と Work Item ID は Collection 側で形式を狭めず、Planning と同じ canonical な識別子（前後に空白がなく 256 文字以内、制御文字なし。Unicode や `/` を含む ID も可）を受け付けます。
- Workspace 検索の Work Item document は `team/<teamId>/issue/<issueId>` を identity にします。`/` を含まない Team ID は `team/` の後の最初の `/` で終わるため、Work Item ID が `/` や `/issue/` を含んでも identity は一つの Work Item だけを指します。Team ID は文字・数字・`-` から生成され `/` を含まないため既存 document は再 projection 不要です。`/` を含む Team ID の Work Item は別の Work Item と identity が衝突し得るため index へ書かず、そのような document も検索結果に解決しません（候補には上の ID 完全一致で現れます）。

## 保存

Collection は既存の Planning table に `COLLECTION#<collectionId>` row として保存し、参照する Work Item の `teamId` / `issueId` を最大 200 件まで row 内に持ちます。
Workspace あたりの Collection は 200 件までです。保存済み row の参照が 200 件を超えている場合や同じ Work Item を重複して参照している場合は破損として扱い、読み取りを `502 CollectionCorruptState` で止めます。上限は `COLLECTION_COUNT` counter row を作成・削除と同じ transaction で条件付き更新して強制し、同時作成でも超えません。作成・削除とも既存の counter row を条件にします。counter row が無い場合（Workspace の最初の作成や、counter を含まない restore の後）、作成は live な Collection row を一覧と同じ metadata の projection で読み（応答から参照を除き、200 件を超えた時点で止める bounded Query）、すべての row を一覧と同じ規則で検証してから件数で counter row を作り直して再試行します。Workspace・record key・entry type・schema version・metadata が不正な row が一つでもあれば、counter も Collection も書かずに `502 CollectionCorruptState` です。counter が無い間は作成も削除も commit できないため、数えた件数と live row はずれません。既存の counter row も作成のたびに live row の件数と照合し、作成の counter 更新はその照合した値のままであることを条件にします。restore や手動修復で counter が live row より少ない・多い場合は書き込まずに `502 CollectionCorruptState` を返し、照合中に counter が変わった場合（同時の作成・削除）は `409 CollectionConflict` です。live row の一覧は複数 page にまたがることがあり、その間の削除と作成で件数が元に戻ると件数だけでは同時書き込みを見分けられません。そのため counter row は作成・削除のたびに増える `generation` も持ち、照合のずれは `generation` が変わっていれば `409 CollectionConflict`、変わっていなければ `502 CollectionCorruptState` とします。200 件を超える live row は `502 CollectionCorruptState` です。Collection 一覧は metadata の attribute だけを projection して読み、row 内の参照は応答に含めません。ただし DynamoDB は projection 前の item サイズで読み取り容量を消費し page を区切るため、参照を多く持つ row の一覧は row 全体を読むのと同じ読み取りコストがかかります。projection で減るのは転送量と parse だけです。

- 作成は `Idempotency-Key` header を必須とし、同じ key の再送は最初に作った Collection を返します。作成時の request fingerprint を row に保存するため、その後に名前変更や Work Item の追加があっても再送は成功します。
- 削除すると同じ transaction で `COLLECTION_DELETED#<collectionId>` marker を残します。marker には作成 request の fingerprint も残すため、削除後に元の作成 request を再送しても Collection は復活せず `409 CollectionDeleted` を返し、同じ key を別の内容で再利用した場合は `409 CollectionIdempotencyConflict` を返します。marker の Workspace・record key・entry type・Collection ID・fingerprint が一致しない行は `502 CollectionCorruptState` として扱います。Web はこの応答で保持していた idempotency key を破棄し、次の作成操作は新しい key で送ります。作成・更新の transaction は marker が無いことを条件に含め、削除は既存 marker を上書きしません。live row と marker が両方ある矛盾した状態は `502 CollectionCorruptState` です。単一 Collection の読み取り（Item 一覧・更新・Item の追加と削除・削除）も marker を live row より先に strongly consistent read で読み、両方あれば削除済み Collection を返さず `502 CollectionCorruptState` にします。marker には削除した revision も残し、削除の応答が失われて同じ `expectedRevision` で再送した場合だけ削除済みとして `204` を返します。別の revision を指定した古い削除は `404 CollectionNotFound` です。作成時の counter 条件が失敗した場合は counter 行を読み直し、行が無ければ上記のとおり作り直して再試行し、正しい counter が上限に達している時だけ `409 CollectionLimitReached`、上限未満なら（同時削除で空きができたため）`409 CollectionConflict`、不正な counter 行は `502 CollectionCorruptState` を返します。
- 名前変更と削除は `expectedRevision` による optimistic concurrency で行い、古い revision は `409 CollectionConflict` で拒否します。
- Work Item の追加と削除も revision 条件付きで書き込み、同じ Work Item の再追加・未登録 Work Item の削除は変更なしとして扱います。
- すべての書き込みは、呼び出した member の現在の Workspace membership を同じ DynamoDB transaction の条件として確認します。membership の条件が失敗した場合は revision の競合ではなく `403 CollectionAuthorizationChanged` を返します。

## 削除と cleanup

- Collection を削除しても、参照していた Work Item は変更されません。
- URL の `collectionId` が一覧に無い Collection（削除済みや存在しない ID）を指す場合、Web は Item を読み込まず、存在しない旨を表示します。
- Work Item が削除された場合や閲覧できなくなった場合、Collection に残った参照は一覧で省かれます。参照の掃除は一覧の read 時に行わず、Item 上限の計算には含まれます。削除済み Work Item の参照を掃除する処理は、今後の段階で Work Item 削除時の cleanup として追加します。
- Tenant closure は Planning table の Workspace partition 全体を削除するため、Collection row と削除 marker も一緒に削除されます。

## API

| Method | Path | 内容 |
| --- | --- | --- |
| `GET` | `/api/collections` | Collection 一覧（名前順） |
| `POST` | `/api/collections` | Collection 作成 |
| `PATCH` | `/api/collections/:collectionId` | 名前・説明の変更 |
| `DELETE` | `/api/collections/:collectionId?expectedRevision=` | Collection 削除 |
| `GET` | `/api/collections/:collectionId/items` | 読める Work Item の一覧（追加が新しい順） |
| `PUT` | `/api/collections/:collectionId/items/:teamId/:issueId` | Work Item の追加（Collection と、読める形の追加 Work Item `item` を返す） |
| `DELETE` | `/api/collections/:collectionId/items/:teamId/:issueId` | Work Item の参照削除 |

## 今後の段階

Issue #238 の残りは別の PR で扱います。

- primary Project の変更（「移動」）と Collection への追加（「別の場所にも追加」）を Work Item detail から分けて提供する
- location 追加・削除時の visibility preview と、cross-Team 配置の許可条件
- Project 限定 custom field と multi-location の適用ルール
- Search / saved view / Report での location filter / group
- 通知・activity・audit での重複防止と、Work Item 削除時の参照 cleanup

名前・説明の更新は、要求した内容がすでに保存されている場合は書き込まずに現在の Collection を返します。応答が失われた更新の再送が `409` にならないためです。作成の再送は live row と削除 marker が両方ある場合 `502 CollectionCorruptState` を返します。Web は追加・削除が成功すると、続く Item 一覧の再取得を待たずに応答から選択中 Collection の Item cache を更新するため、再取得に失敗しても削除した Work Item が残ったり、追加した Work Item が欠けて候補に出続けたりしません。Web の候補検索が上限の 100 page を読んでも候補を 1 件も見つけられなかった場合は「該当なし」ではなく失敗として表示します。
