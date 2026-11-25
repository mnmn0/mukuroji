# 0102. Gmail・Outlook・Google Drive・OneDrive・Dropbox を connector の選択肢から外す

- 状態: 提案
- 日付: 2026-11-25
- 関連: Issue #443

## 背景

connector の catalog には、source control・chat・calendar に加えて、mail（Gmail、Outlook）と
cloud storage（Google Drive、OneDrive、Dropbox）の provider があった。
これらは OAuth で接続できるだけで、同期は作っていなかった。接続しても何も起きないので、
選択肢に出すと管理者に誤解を与える。

Issue #443 で GitHub issue の同期を作るにあたり、catalog を「同期がある provider だけ」にそろえた。

## 決定

- 構成できる connector の catalog から、Gmail・Outlook・Google Drive・OneDrive・Dropbox を外す。
  残るのは GitHub、chat、calendar の provider。
- これらの provider ID は、手入力の外部リンクでは引き続き使える。
- 外した provider の設定を環境に書くと、起動時の検証で拒否する。
- 外した provider の接続を切るだけの経路は作らない。初回 deploy 前で、これらの接続を持つ環境がないため。

## 検討した選択肢

- **catalog に残し、「同期なし」と表示する。** 変更は小さい。ただし、接続しても何もしない機能を出し続けることになる。
- **新規接続だけ止め、既存の接続を切る経路を残す。** 既存の環境には安全。ただし、該当する接続がまだどこにもないので、
  使われないコードを持つことになる。

## 結果

- 管理者が選べる connector は、同期のある provider だけになる。
- mail や cloud storage の同期を作るときは、catalog の entry を接続・切断ごと足し直す。
- deploy 後に provider を外すときは、既存の接続を切る経路を先に用意する。
