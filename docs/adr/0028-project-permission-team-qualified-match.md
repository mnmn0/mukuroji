# 0028. Project 単位の権限確認を Team と Project の組で照合し、Team を決められない旧形式の権限は効かせない

- 状態: 提案
- 日付: 2026-11-20
- 関連: Issue #594, #642, #627, PR #597, PR #645

## 背景

Project ID は Project 名の slug から作るため、別々の Team が同じ Project ID を持てます
（例: `core-team/refero` と `other-team/refero`）。

Project 単位の権限には 2 つの形があります。

- Enterprise の Directory group mapping で付く権限は、Team と Project の組（`teamId` + `projectId`）を持つ。
- 旧形式の Project メンバー登録（`PROJECT_MEMBER#<projectId>#<memberKey>`）は Team を持たず、
  Project ID だけで登録されている。

#594（PR #597）で、Work Item の集約読み取りは Team と Project の組で照合するように直しました。
旧形式の権限は、その Project ID を持つ有効な Team がちょうど 1 つのときだけその Team の権限として扱い、
複数の Team が同じ Project ID を使っているときはどの Team でも効かせない（fail-closed）と決めました
（2026-11-19）。

ところが、Project charter・Planning・Project メンバー管理などの単一 Project の操作で使う
`requireProjectPermission` は Project ID だけで照合していました。そのため、別 Team の同じ ID の
Project に付いた権限で、route が指す Team の Project を読み書きできました（#642）。

## 決定

Project 単位の権限確認（`requireProjectPermission` と、一覧・集約読み取りの
`selectTeamProjectScopeAccesses`）は、次の規則で照合します。System admin はこれまでどおり対象外です。

1. **Team と Project の組で照合する。** route の path が Team を含む場合（`/teams/:teamId/projects/:projectId/...`）は、
   その `teamId` を `requireProjectPermission` に渡す。Team 付きの権限は、`teamId` と `projectId` の両方が
   一致するときだけ効く。
2. **Team を決められない旧形式の権限は効かせない。** 旧形式の Project メンバー登録は、
   `readLegacyProjectScopeAccesses` で現在の directory と照らし、その Project ID を持つ有効な Team が
   ちょうど 1 つのときだけ、その Team の権限として扱う。0 個または 2 個以上なら捨てる。
   この判定は route が Team を含むかどうかに関係なく同じにする。
3. **Team を含まない route** は、`teamId` を渡さずに `requireProjectPermission` を呼ぶ。
   - 旧形式の権限は 2 の規則で既に Team が 1 つに決まったものしか残らないため、共有された
     Project ID の権限で通ることはない。
   - Team 付きの Enterprise 権限は Project ID が一致すれば Team を問わず効く。これらの route は
     Enterprise の route 単位の認可（`resolveEnterpriseAuthorizationResource`）で先に評価され、
     Team を決められない ID には親 Team を付けない。Team を含まない route 全体を Team 付きにするのは
     route と contract の変更になるため、この ADR の範囲外とし、必要になった route から Team を path に足す。

## 検討した選択肢

- 選択肢 A: Project ID だけで照合する（変更前）。実装は単純 / 同じ ID の別 Team の Project に権限が漏れる。
- 選択肢 B: Team と Project の組で照合し、Team を決められない旧形式の権限は fail-closed にする（採用）。
  漏れを止められる / 共有 Project ID を持つ Workspace では旧形式の権限を持つ人が一時的に使えなくなる。
- 選択肢 C: 旧形式の権限を、同じ Project ID を持つ全 Team に効かせる。既存の利用者は困らない /
  権限を付けた側が意図していない Team の Project まで開くため、A と同じ漏れが残る。
- 選択肢 D: 旧形式の row を Team 付きの形へ data migration する。根本的に解決する / 共有 ID の row は
  どの Team のものか機械的に決められず、人の判断が要る。移行は別の作業として扱う。

## 結果

- 別 Team の同じ ID の Project に付いた権限が、route の指す Project に効かなくなる。
- 共有 Project ID の旧形式の権限は、どの Team でも効かない。復旧するには、Project manager が
  権限を付け直す、Enterprise の Team・Project 単位の mapping に移す、または Project ID が重複しないようにする。
- 旧形式の権限は一覧として読み、directory と照らすため、旧形式の権限を持つ人では単一 Project の確認でも
  directory の読み取りが 1 回増える。
- Team を含まない route の Enterprise 権限は、route 単位の認可に頼る。そうした route に Team を足すか、
  旧形式の row を Team 付きへ移行したときに見直す。
- 利用者向けの説明は `docs/guide/admin.md` の Project 権限の節にある。
