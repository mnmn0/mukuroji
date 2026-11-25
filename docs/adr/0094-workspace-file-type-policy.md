# 0094. 添付できるファイル形式を contracts の catalog で持ち、Workspace は既定との差分だけを tenant profile に保存する

- 状態: 提案
- 日付: 2026-11-24
- 関連: Issue #424、Issue #333、ADR 0047

## 背景

File の upload は server の固定の MIME allowlist（画像・PDF・動画・`text/plain`・CSV・JSON・zip・OOXML）だけを
受け付け、それ以外は `415 FileTypeNotAllowed` だった。WBS の成果物として多い `.xls`・`.xlsm`・Markdown・log・
`.drawio` などは拒否され、Workspace ごとに変えることもできなかった。また Web はブラウザが判定した MIME をそのまま
送るため、`.md`・`.log`・`.drawio` のようにブラウザが種別を返さない file は `application/octet-stream` になって拒否された。
拒否時の画面は「この形式はアップロードできません」だけで、何なら添付できるかが分からなかった。

## 決定

- 添付できる形式を `contracts/src/file-types.ts` の catalog（`FILE_TYPE_CATALOG`）として持つ。1 形式は
  id・拡張子・正規の MIME・ブラウザが返す別名の MIME・既定で許可するか（`allowedByDefault`）を持つ。
  既定で許可する形式を Office の旧形式（`.doc`/`.xls`/`.ppt`）・`.xlsm`・OpenDocument・Markdown・TSV・XML・YAML・
  `.drawio`・`.vsdx`・音声（mp3/wav/m4a）・7z/tar/gz まで広げる。`.docm`・`.pptm`・TIFF・HEIC・RAR・`.eml`・`.msg`
  は catalog にあるが既定では許可しない（管理者が許可できる）。
- 実行形式・installer・script・shortcut・disk image と、browser が page として実行する HTML・SVG は
  `BLOCKED_FILE_EXTENSIONS` / `BLOCKED_FILE_CONTENT_TYPES` として catalog の外に置く。catalog にない形式は Workspace の
  設定でも許可できない（設定の検証が catalog の id しか受け付けない）。
- 形式は file 名の最後の拡張子で決め、拡張子がないときだけ MIME で決める。最後の拡張子か MIME が危険な形式なら、
  もう一方に関わらず拒否する（`invoice.pdf.exe`・`.md` で `text/html` など）。保存する `contentType` は送られた MIME ではなく
  catalog の正規の MIME にし、S3 の署名付き PUT もその MIME で署名する。inline 表示の可否はこれまでどおり正規の MIME
  （画像・動画・PDF だけ）で決める。
- Workspace の設定は tenant profile の `fileTypes: { allowed: FileTypeId[], blocked: FileTypeId[] }` に、既定との差分
  として保存する（`allowed` は既定で許可しない形式のうち許可するもの、`blocked` は既定で許可する形式のうち止めるもの）。
  差分で持つので、catalog に既定の形式を足すと設定を変えていない Workspace にも届く。変更は既存の
  `PATCH /api/tenant/profile`（Workspace 管理の権限、`expectedRevision`、同じ transaction の監査 event
  `tenant.profile.updated` の `fileTypes.allowed` / `fileTypes.blocked` の差分）で行う。不正な設定は
  `400 InvalidFileTypeSettings`、保存済みの壊れた設定は読み込みで失敗させる（既定に戻さない）。
- File の upload（新規・新 version）は tenant profile を読む port（`FileTypeSettingsSource`）で Workspace の設定を得る。
  読めないときは upload を失敗させる。保存済み version の整合性検査は Workspace の設定ではなく catalog 全体
  （正規の MIME）で行う。あとから形式を止めても、添付済みの file は読める。
- `415 FileTypeNotAllowed` の body に `reason`（`dangerous` / `unrecognized` / `not-allowed`）と
  `allowedFileTypes`（Workspace が受け付ける id）を入れる。Web は理由と受け付ける拡張子を表示する。Markdown の書く欄は
  形式の事前チェックをやめ、server の判定を表示する。
- malware scan が読めない形式（パスワード付きの圧縮ファイルなど。GuardDuty の `UNSUPPORTED`）は、これまでどおり
  `failed` として扱い、preview と download を止める。画面では「スキャンできません」と、パスワードを外すか別の形式で
  添付し直す案内を出す。

## 検討した選択肢

- 管理者が任意の拡張子・MIME を追加できるようにする: 自由度は高いが、危険な形式の deny list に漏れがあると許可できて
  しまい、inline 表示や preview の判断にも未知の MIME が入る。catalog に足す変更をレビューする方が安全。
- 許可する形式の完全な一覧を保存する: 分かりやすいが、catalog に既定の形式を足しても既存の Workspace には届かない。
- `UNSUPPORTED` を新しい scan 状態として保存する: 表示は正確になるが、`FileScanStatus` の契約、保存済み row の検査、
  整合性検査の遷移をすべて変える必要がある。止める動作は `failed` と同じなので、表示の案内で足りるとした。
- ブラウザの MIME を優先し、拡張子は MIME が空のときだけ使う: Windows の `.csv` が `application/vnd.ms-excel` になるなど
  ブラウザ間で揺れるため、拡張子を優先した。どちらもクライアントが決める値なので、信頼の度合いは変わらない。

## 結果

- 新しい table・index・queue はない。upload session の作成で tenant profile の GetItem が 1 回増える。
- 公開の request 受付 form（`request-intake`）の添付は別の allowlist のままで、この判断の対象外。
- 更新した文書: `docs/file-proofing.md`、`docs/guide/admin.md`、`docs/guide/member.md`。
