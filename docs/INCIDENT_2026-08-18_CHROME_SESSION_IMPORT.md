# 2026-08-18 Codex App更新後のIAB起動・Chrome認証移行障害

## 2026-08-21: main・renderer bundle更新への追従

Codex App更新後、main bundleが `.vite/build/main-Cwjv9Ibf.js`、renderer bundleが
`webview/assets/app-initial-DOX-K1rC.js` へ変わり、main patch pointのうち6個と
renderer patch pointのうち3個が0件になった。前回と同じく意味上の差し替え範囲は
増やさず、現行bundleのminify済み識別子に対する完全一致文字列だけを更新した。

```text
$ npm test
tests 77
pass 77
fail 0

$ npm run verify
compatible: true
main patch point occurrences: 1 x 9
renderer patch point occurrences: 1 x 4

$ codex-app profile restart --from default
status: running
IPC ready: true
runtimeActive: true
signed App modified: false
```

今回も、App bundleの更新検知時はエラーに列挙された0件の文字列だけを見るのではなく、
旧文字列の周辺にあった安定した意味上の目印（`configureBrowserSession`、
`registeredWebviewHostsByRoutePartition`、`updateThreadSettingsForNextTurn` など）から
現行処理を探す。現行処理を一意に特定した後、その完全一致文字列を更新し、main 9点・
renderer 4点が各1件になることを実App inspectionで確認する。

## 2026-08-19: App 26.814での再発と対応

Codex App `26.814.41407`（build `6720`）への更新後、`profile inspect` が9個の
patch pointのうち7個を0件として検出し、runtime起動を停止した。main bundleは
`.vite/build/main-BIHCWhv-.js` から `.vite/build/main-DkjTIhil.js` へ変わり、IAB周辺の
minify済み識別子と処理構造も変化していた。

既存の意味上の差し替え範囲は増やさず、現行bundleに対する完全一致文字列だけを更新した。
更新後の再発検知結果は次のとおり。

```text
$ npm test
tests 67
pass 67
fail 0

$ npm run verify
compatible: true
mainBundle: .vite/build/main-DkjTIhil.js
patch point occurrences: 1 x 9

$ codex-app profile restart --from 'chrome:Profile 11'
status: running
chrome profile: AI用 (Profile 11)
IPC ready: true
signed App modified: false
```

**事実:** fail-closedにより不明なbundleへ旧patchが部分適用されることはなく、更新後も
9箇所すべてが1件だけ一致することを自動テストと実App inspectionで確認した。Chrome
importはCookie 111件を検出し、標準import 111件・補完import 106件とも失敗0件で完了した。

**未検証:** この時点では、importした認証状態を使う実サイト到達と複数session間のstorage
分離はまだ再実行していない。runtime互換性とimport成功だけをE2E合格とは扱わない。

## 概要

Codex App `26.810.52044` への更新後、`codex-app` で起動したin-app Browser（IAB）が正常に使えず、Chrome profileをimportしてもGoogleや社内Webアプリで再ログインを要求される状態になった。

調査の結果、障害は次の2つの独立した問題から構成されていた。

1. **App更新でmain bundleが変化し、旧runtime patchの完全一致条件が成立しなくなった。**
2. **署名済みAppが公開する標準Chrome importerは成功を返していたが、認証に必要なCookieを一部保存していなかった。**

1はApp更新が直接のきっかけである。2が同じ更新で新しく発生したかは確認できていない。更新後の再検証で初めて明確になったため、App更新との同時発生だけを根拠に因果関係を断定しない。

最終的に、App `26.810.52044` 用runtime patchへの更新、import先profileの隔離、Chrome Cookie DBからの安全な補完importを実装した。Googleと対象Webアプリのログイン状態、3つの同時IAB sessionの分離、App再起動後の永続性、既存conversationへのfollow-up継続を実機で確認した。

## 影響

- runtime patchが互換でない状態では、IAB profile runtimeを安全に起動できない。
- 標準importerだけに依存した状態では、Cookie件数上は成功でもGoogleや対象Webアプリが未ログインになる。
- staleな固定App profileをimport先として再利用すると、`skippedExisting` が増え、今回のimport結果と以前の状態を区別できない。
- IABを必要とするE2Eがログイン画面で停止し、対象機能の検証へ到達できない。

## 原因

### 1. App更新によるruntime patch不整合

runtimeは署名済みAppのmain bundleをディスク上で変更せず、Nodeのmodule compile hookで9か所をメモリ上だけ差し替える。各patch pointは誤ったbundleを変更しないよう、完全一致かつ出現回数1回を必須としている。

App `26.803` 系から `26.810.52044` への更新でminify済みmain bundleの構造が変わり、旧patch pointが一致しなくなった。このfail-closedは意図した挙動であり、共有partitionへ黙ってfallbackしてsessionを混在させることはなかった。

修正後の実機確認:

```text
$ codex-app profile inspect
compatible: true
mainBundle: .vite/build/main-BIHCWhv-.js
patchPoints: 9 entries, occurrences=1 for every entry
```

対応commit: [`bb9927a`](https://github.com/yukimaru77/codex-app-cli/commit/bb9927a)

### 2. 固定import先に残った以前のCookie

標準`browserProfileImporter`は、呼び出し元にかかわらず固定partition `persist:codex-browser-app` を更新する。既存の固定profileを残したまま再importすると、今回の実測では509件が`skippedExisting`となった。

import専用App processの開始前に固定profileを退避し、空の固定profileへimportした後、一意なseedへsnapshotして元の固定profileを復元するよう変更した。これにより同じ条件で`skippedExisting`は1件まで減り、各importを以前の状態から分離できた。

対応commit: [`635d697`](https://github.com/yukimaru77/codex-app-cli/commit/635d697)

### 3. 標準importerによる認証Cookieの取りこぼし

固定profileを空にしても、Chrome元DBにある次のCookie identityがApp側DBに存在しなかった。

- Googleのログイン維持Cookie
- OAuth2 proxyのCookie
- 対象Webアプリ本体のsession Cookie
- 認証サービスのsession Cookie

標準importerは全体として`status: success`を返し、発見件数とimport件数もほぼ一致していた。そのため、件数とstatusだけではログイン状態の移行成功を判定できない。

Chrome元DBの`meta.version`は24だった。macOSの`Chrome Safe Storage`から得た鍵で、PBKDF2-SHA1とAES-128-CBCを使い、v24のSHA-256 host bindingを検証してから対象Cookieを復号できることを確認した。これにより、Chrome側Cookie自体の破損やprofile選択ミスではないことを切り分けた。

**事実:** 標準importer後のApp DBには重要Cookieが欠落し、CLI側で復号・Electron再保存するとログイン状態が復元した。

**仮説:** 標準importer内のv24 host-bound Cookie処理、またはimport可否判定が一部Cookieを除外している可能性がある。標準importerの内部実装を確認できないため、更新によってこの挙動が導入されたとは断定しない。

## 修正

Chrome profile import時に、標準importerを置き換えず次の補完処理を追加した。

1. Chrome profile直下の`Cookies`または`Network/Cookies`をread-onlyで開く。
2. macOS Keychainから`Chrome Safe Storage`の値を取得する。
3. 現在有効な非partitioned Cookieを復号し、host bindingを検証する。
4. mode `0600`の一時ファイルへElectron `cookies.set`用のデータを書き出す。
5. import専用App processが標準importerを実行した後、同じElectron sessionへCookieを再登録する。
6. Electron自身に保存時の再暗号化を任せ、cookie storeとstorage dataをflushする。
7. 一時ファイルを直ちに削除する。runtime側で失敗してもhost側の`finally`で削除する。
8. 復号・再登録が1件でも失敗した場合はimport全体を失敗扱いとし、途中profileをseed化しない。

Cookie値はコマンド引数、環境変数、runtime JSONL logへ出力しない。Electronの公開`cookies.set` APIでpartition keyを指定できないため、partitioned Cookieは標準importerへ委ねる。

主要実装:

- [`iab/lib/chrome-cookies.mjs`](../iab/lib/chrome-cookies.mjs)
- [`iab/lib/runtime-launcher.mjs`](../iab/lib/runtime-launcher.mjs)
- [`iab/runtime/chrome-import.cjs`](../iab/runtime/chrome-import.cjs)

対応commit: [`ac9dba1`](https://github.com/yukimaru77/codex-app-cli/commit/ac9dba1)

## 検証結果

### 自動テストとruntime互換性

```text
$ npm test
tests 67
pass 67
fail 0

$ codex-app profile inspect
compatible: true
patch point occurrences: 1 x 9
```

テストには、v24 Cookie復号、host binding不一致時の拒否、Electron Cookie形式への変換、partitioned/expired Cookieの除外、mode `0600`、一時ファイル削除、Electron再登録失敗時のfail-closedを含む。

### Cookie identity比較

Chrome元DBとimport後App DBを`host_key + name + path`で比較した。

```text
source_current_unpartitioned | 1338
app_cookie_count             | 1536
missing_by_identity          | 0
```

実際のimport結果:

```text
standard importer discovered       | 1537
standard importer imported         | 1536
standard importer skippedExisting  | 1
supplemental imported              | 1338
supplemental skippedPartitioned    | 124
supplemental skippedExpired        | 75
```

補完対象1,338件はElectron再登録時に既存Cookieを同じidentityで上書きできるため、App DB総件数との単純加算にはならない。

### 実サイトのログイン状態

App所有の新規conversationを1つ作り、純正in-app Browserだけを使用した。

- Gmail: ログイン画面へ遷移せず受信トレイを表示。
- 対象Webアプリ: 認証サービスへ遷移せずログイン後画面を表示。

外部Chrome、ego-browser、Playwrightの外部Browser process、`curl`による代替検証は使っていない。

### 3 session同時分離

同じseedから3つの独立したCodex session A/B/Cを作り、同じfixture originへ異なるmarkerを同時保存した。3 turnは約0.2秒以内に開始された。

| Store | A | B | C |
| --- | --- | --- | --- |
| Cookie | `ISO-A` | `ISO-B` | `ISO-C` |
| server observed Cookie | `ISO-A` | `ISO-B` | `ISO-C` |
| Local Storage | `ISO-A` | `ISO-B` | `ISO-C` |
| Session Storage | `ISO-A` | `ISO-B` | `ISO-C` |
| IndexedDB | `ISO-A` | `ISO-B` | `ISO-C` |
| Cache Storage | `ISO-A` | `ISO-B` | `ISO-C` |
| Service Worker | `true` | `true` | `true` |

App再起動後に保存せず同時読み取りした結果、Cookie、Local Storage、IndexedDB、Cache Storage、Service Workerは各session固有の値を維持した。Session Storageだけが全sessionで`null`となり、tab/process lifetimeに従う期待どおりの結果だった。

使用された3つのCookie DBはinodeが異なり、各DBにfixtureの`iab_marker`が1件だけ存在した。Googleと対象Webアプリの認証Cookie identityも各partitionに継承されていた。

### 既存sessionの継続

App再起動後、A/B/Cの既存conversation IDへ同時にfollow-upを送った。

- conversation IDは3件とも不変。
- rollout pathは3件とも不変。
- 新しく生成されたのはturn IDだけ。
- 各sessionは以前の回答を転記せずIABからmarkerを再取得し、A/B/Cそれぞれ元の値を返した。

したがって、follow-upによるsessionの作り直し、入れ替わり、Browser storageの混線は確認されなかった。

## 再発検知

App更新後は少なくとも次を実行する。

```bash
codex-app profile inspect
npm test
```

Chrome import変更時は、importerの`status`と件数だけで合格にしない。次を実サイトまたは非機密fixtureで確認する。

1. 元DBとApp DBのCookie identity差分が0であること。
2. ログイン済みページへ認証画面なしで到達すること。
3. 2つ以上のsessionへ異なるmarkerを書き、同時実行とApp再起動後の双方で交差しないこと。
4. 同じconversationへのfollow-upが同じrolloutとBrowser storageを再利用すること。

runtime patchは今後も完全一致・出現回数1回を維持し、未知のApp versionへ推測で適用しない。
