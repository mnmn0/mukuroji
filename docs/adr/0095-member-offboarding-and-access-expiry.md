# 0095. メンバーの利用期限を読み取り時に効かせ、毎時の job で無効化する。無効化で本人の API キーを失効する

- 状態: 提案
- 日付: 2026-11-24
- 関連: Issue #433, ADR 0074, ADR 0010

## 背景

退職者や契約の終わった guest を利用停止すると、次の問題がありました。

- 利用停止を止める項目（Project のマネージャー、Planning の責任者、非公開 Document の唯一の管理者）は、
  利用停止を試して 409 を受けるまで分かりませんでした。
- API キーと OAuth アプリは作成者を subject にして動きますが、作成者が利用停止になっても使えました。
  Public API は Workspace の lifecycle だけを確かめ、作成者が active かを見ていませんでした。
- guest に期限を付けられず、管理者が覚えておいて手で利用停止する必要がありました。

## 決定

- **引き継ぎの一覧**: `GET /api/workspace/members/:memberKey/offboarding` が次を 1 回で返します。
  - マネージャーを務める Project と、責任者を務める Planning entity。
  - 非公開 Document の唯一の管理者かどうか。
  - 本人が作った有効な API キー・OAuth アプリ・Webhook。
  - 利用停止できるかどうか。

  権限は `members.manage` です。引き継ぎ自体は、既存の Project member API と Planning entity API で行います。
  それぞれの権限確認と revision 確認がそのまま効きます。
- **資格情報の失効**: 手動の利用停止に成功したら、本人が作った API キーと OAuth アプリを失効します。
  - 失効は冪等です。利用停止のあとで失効に失敗した場合は、`POST /api/workspace/members/:memberKey/credentials/revoke` で
    やり直せます。
  - Public API は、Workspace の lifecycle を確かめた直後に、資格情報の作成者が active なメンバーかを
    `getActiveMember` で確かめます。active でなければ 403 にします。
  - これで、失効が漏れた資格情報や、期限切れで自動停止を待つメンバーの資格情報も使えません。
- **利用期限**: Workspace の member row に任意の `accessExpiresAt` を持ちます。
  - 設定は `PUT /api/workspace/members/:memberKey/access-expiry` で行い、version 条件と audit event を付けます。
  - 期限は未来の 5 年以内に限ります。owner、利用停止中のメンバー、自分自身には設定できません。
  - 再有効化や owner への変更で期限を外します。
- **読み取り時に効かせる**: `getActiveMember`、`listActiveMembers`、`reconcileAuthenticatedMember` は、
  期限を過ぎたメンバーを active として扱いません。
  - 期限を過ぎた時点で、サインイン、API、Public API、Webhook の配信がすべて止まります。job の実行を待ちません。
  - 読めない値は期限切れとして扱います（fail closed）。
  - member row を直接読む箇所（通知の宛先判定、外部配信の認可、メール宛先、realtime）も、
    同じ判定 `isWorkspaceMemberRowActive` を使います。
  - 期限を過ぎたメンバーの Project role は、下げることだけできます。上げることと新しく付けることはできません。
    これで、止める項目が残るメンバーからもマネージャーを引き継げます。
- **毎時の job で無効化する**: scheduled-jobs Lambda の `member-access-expiry` job が 60 分ごとに実行し、
  期限を過ぎた active なメンバーを利用停止します。
  - 対象は WorkspaceAccess table の Scan で探します。
  - 利用停止を止める確認（Project のマネージャー、Planning の責任者、非公開 Document の管理者）は、
    手動の利用停止と同じ順で行います。止める項目が残るメンバーは active のまま残し、Workspace と理由だけをログに出します。
    この間も、読み取り時の判定でアクセスはできません。
  - 書き込みは member row の条件付き更新です。Planning revision fence と Document 認可 generation fence を
    同じ transaction に含めます。
  - 409 と終了中の tenant は次の実行に回します。
- **事前の通知**: 通知 schedule が、7 日以内に期限が来るメンバーの所属 Project のマネージャーへ
  `workspace-member.access-expiring` を 1 回ずつ送ります。期限を変えると、もう一度送ります。
  entity ID と冪等キーに member key（メールアドレス）は入れず、digest にします。

## 検討した選択肢

- 期限切れを job の無効化だけで止める: 実装は小さくなります。しかし job の間隔（最大 1 時間）と、
  引き継ぎが残って無効化できない間に、アクセスが続きます。採用しませんでした。
- 期限切れの job で止める確認を飛ばして必ず無効化する: Project のマネージャーがいなくなるなど、
  手動の利用停止が守っている不変条件を壊します。採用しませんでした。
- 期限で引くための GSI を追加する: Scan をなくせます。しかし table の変更と migration が要ります。
  member row の数は Workspace あたり数百で、毎時の Scan で足ります。数が増えたら見直します。
- API キーを失効するだけで、Public API では作成者を確かめない: 失効の漏れや期限切れの間の利用を止められません。
  1 request ごとに member row を 1 回読む費用を受け入れました。

## 結果

- 利用停止の前に、引き継ぐものを 1 画面で確かめ、その場で引き継げます。
- 利用停止したメンバーと期限を過ぎたメンバーの API キー・OAuth トークンは、API を呼べません。
- 期限付きの guest は、期限を過ぎるとサインインできません。
- 受け入れる欠点:
  - Public API の request ごとに member row を 1 回、強整合で読みます。
  - 自動停止の job は Cognito の global sign-out を呼びません。`signInsRevokedAt` を記録し、読み取り時の判定で止めます。
  - 自動の job は資格情報を失効しません。作成者の確認で止まります。管理者は一覧から失効できます。
    利用停止中のメンバーを再有効化するときは、更新の前に本人の資格情報を失効します。
    これで、job が利用停止したメンバーを戻しても、以前の API キーは使えないままです。
  - 資格情報の失効は、ロールの変更と同じく、操作する人が管理できるメンバーにだけ行えます
    （owner は全員、admin は member と guest）。
- 今回は扱わないもの:
  - Project member 単位の期限。
  - Automation rule・保存済み view・承認待ち・実行中タイマーの引き継ぎ一覧。所有者の field がないか、
    Team をまたぐ走査が要るためです。
  - Webhook の所有者の付け替え。
- 更新した文書: `docs/guide/admin.md`、`docs/enterprise-identity.md`。
