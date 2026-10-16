# Collections

Issue #238 の最初の段階として、canonical Work Item を複製せずに複数の文脈から参照できる整理用の Collection を追加します。
Collection は workflow、assignee、status を持たず、Work Item の所有 Team（`teamId`）と primary Project（`assignedProjectId`）は変更しません。

## 用語

- **所有 Team**: Work Item の正本を持つ Team。Work Item ID、conversation、decision、activity、dependency はここに残ります。
- **primary Project**: 実行を担う Project。0 または 1 つで、既存の `assignedProjectId` がこれに当たります。
- **Collection**: Workspace 全体で共有する整理用の入れ物。一つの Work Item を複数の Collection に入れられます。

## 権限と可視性

- Collection の一覧・作成・名前変更・削除・Work Item の追加と削除は、Workspace の business read / write 権限で行います。Guest は利用できません。
  Enterprise principal は `work-items.read`（参照）、`work-items.write` または `workspace.write`（変更）が必要です。Collection は Workspace 全体の resource なので、これらの権限は Workspace scope の割り当てで判定し、Team / Project scope だけの grant では Collection を参照・変更できません。Team / Project scope の割り当ては Item の可視性判定にだけ使います。
  一覧 response の `canWrite` は変更できるかどうかを返し、Web は変更できない member に編集操作を表示しません。
- Collection は閲覧権限を広げません。Item の一覧は、Work Item detail と同じ Team / primary Project の viewer 判定を通った Work Item だけを返し、読めない Work Item は存在を示さずに省きます。
- Work Item の追加と参照の削除には、操作する人がその Work Item を読める必要があります。読めない Work Item と存在しない Work Item は同じ `404 CollectionWorkItemNotFound` を返すため、ID を推測して隠れた参照の有無を確かめることはできません。
- Collection から開いた Work Item は、通常の canonical Work Item detail と mutation を使います。Collection ごとの別データは作りません。
- Work Item の追加候補は `GET /api/collections/candidates?keyword=` で探します。Workspace 検索 index を `entityTypes: ["work-item"]` に固定して引くため、`workspace.read` ではなく Collection と同じ `work-items.read` で利用でき、結果は呼び出し元が読める Work Item に限られます。keyword が空の場合は `400 InvalidCollectionCandidateQuery` です。検索は権限で絞り込まれた cursor pagination なので、大きな Workspace でも全 Work Item を一度に読み込みません。すでに Collection に入っている Work Item は候補数に数えずに次の page を読みます。cursor が残る限り次の page を読み（検索 server は 1 page ごとに評価する行数が限られ、他の種類の entity だけで空の page になることがあるため）、異常な走査に備えて最大 100 page で止めます。
- 追加・削除の可視性確認と書き込みは同じ transaction ではありません。確認直後に権限が変わって参照が残っても、一覧は読むたびに可視性を再判定するため、読めない Work Item は表示されません。
- Team ID と Work Item ID は Collection 側で形式を狭めず、Planning と同じ canonical な識別子（前後に空白がなく 256 文字以内、制御文字なし。Unicode や `/` を含む ID も可）を受け付けます。

## 保存

Collection は既存の Planning table に `COLLECTION#<collectionId>` row として保存し、参照する Work Item の `teamId` / `issueId` を最大 200 件まで row 内に持ちます。
Workspace あたりの Collection は 200 件までです。保存済み row の参照が 200 件を超えている場合や同じ Work Item を重複して参照している場合は破損として扱い、読み取りを `502 CollectionCorruptState` で止めます。上限は `COLLECTION_COUNT` counter row を作成・削除と同じ transaction で条件付き更新して強制し、同時作成でも超えません。

- 作成は `Idempotency-Key` header を必須とし、同じ key の再送は最初に作った Collection を返します。作成時の request fingerprint を row に保存するため、その後に名前変更や Work Item の追加があっても再送は成功します。
- 削除すると同じ transaction で `COLLECTION_DELETED#<collectionId>` marker を残します。marker には作成 request の fingerprint も残すため、削除後に元の作成 request を再送しても Collection は復活せず `409 CollectionDeleted` を返し、同じ key を別の内容で再利用した場合は `409 CollectionIdempotencyConflict` を返します。marker の Workspace・record key・entry type・Collection ID・fingerprint が一致しない行は `502 CollectionCorruptState` として扱います。Web はこの応答で保持していた idempotency key を破棄し、次の作成操作は新しい key で送ります。作成・更新の transaction は marker が無いことを条件に含め、削除は既存 marker を上書きしません。live row と marker が両方ある矛盾した状態は `502 CollectionCorruptState` です。marker には削除した revision も残し、削除の応答が失われて同じ `expectedRevision` で再送した場合だけ削除済みとして `204` を返します。別の revision を指定した古い削除は `404 CollectionNotFound` です。作成時の counter 条件が失敗した場合は counter 行を読み直し、正しい counter が上限に達している時だけ `409 CollectionLimitReached`、それ以外は `502 CollectionCorruptState` を返します。
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
| `PUT` | `/api/collections/:collectionId/items/:teamId/:issueId` | Work Item の追加 |
| `DELETE` | `/api/collections/:collectionId/items/:teamId/:issueId` | Work Item の参照削除 |

## 今後の段階

Issue #238 の残りは別の PR で扱います。

- primary Project の変更（「移動」）と Collection への追加（「別の場所にも追加」）を Work Item detail から分けて提供する
- location 追加・削除時の visibility preview と、cross-Team 配置の許可条件
- Project 限定 custom field と multi-location の適用ルール
- Search / saved view / Report での location filter / group
- 通知・activity・audit での重複防止と、Work Item 削除時の参照 cleanup
