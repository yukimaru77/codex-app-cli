# Verification evidence

2026-08-12、macOS上のChatGPT/Codex `26.803.41515` と `26.803.61601` で取得した再現可能な証跡です。

公開版では、ローカル環境を識別できるthread、turn、route、Browser IDとprocess IDをプレースホルダーに置換しています。storeの値と検証結果は変更していません。

## 公式Appは未変更

実行コマンド:

```bash
codesign --verify --deep --strict --verbose=2 /Applications/ChatGPT.app
codesign -dv --verbose=4 /Applications/ChatGPT.app 2>&1 |
  rg '^(Identifier|Authority|TeamIdentifier)='
```

確認出力:

```text
/Applications/ChatGPT.app: valid on disk
/Applications/ChatGPT.app: satisfies its Designated Requirement
Identifier=com.openai.codex
Authority=Developer ID Application: OpenAI OpCo, LLC (2DC432GLL2)
TeamIdentifier=2DC432GLL2
```

`codex-app profile status` は実行中processについて次を返しました。

```json
{
  "runtimeActive": true,
  "signedAppModified": false
}
```

## static test

実行コマンド:

```bash
npm test
npm run verify
```

確認出力:

```text
tests 51
pass 51
fail 0
```

`verify` は9個すべてのpatch pointについて `occurrences: 1` を返しました。

## Chrome profileの標準importとsession seed

`chrome-profiles` が列挙した表示名 `test`（directory `Profile 9`）を、未使用session IDへ実機importしました。

```bash
codex-app profile restart \
  --from 'chrome:test' \
  --thread '<unused-session-id>'
```

App標準importerはChrome Cookie 77件を検出し、4件を新規import、73件を既存としてskip、失敗0件で完了しました。その後に作成した一意なsnapshotとsession専用profileの `Cookies` DBは、SHA-256と行数（1394）が一致しました。import前後でChrome側 `Cookies` と `Login Data` のmtime・size・inodeは一致し、Chrome Cookie行数も77のままでした。

```text
chrome import: discovered=77 imported=4 skippedExisting=73 failed=0
snapshot Cookies: rows=1394 sha256=6bedda25...8871040
session Cookies:  rows=1394 sha256=6bedda25...8871040
Chrome Cookies before/after: mtime=1786607187 size=53248 inode=121529191 rows=77
Chrome Login Data before/after: mtime=1786593157 size=40960 inode=121529111
```

## 新規5sessionのサーバーセッション境界

`26.803.61601` で5つの新規Codex session A〜Eを作り、純正in-app Browserから同じfixture URLを開きました。

```text
A turn 1: cookie=FRESH-SERVER-SESSION-A-20260812, server=FRESH-SERVER-SESSION-A-20260812
A turn 2: cookie=FRESH-SERVER-SESSION-A-20260812, server=FRESH-SERVER-SESSION-A-20260812
B initial: cookie=null, server=null
C initial: cookie=null, server=null
D initial: cookie=null, server=null
E initial: cookie=null, server=null
A after B-E: cookie=FRESH-SERVER-SESSION-A-20260812, server=FRESH-SERVER-SESSION-A-20260812
```

Aの2turn目では新しいin-app Browser tabでURLを開き直したため、WebContentsではなくpersistent sessionが保持していることも確認できました。C/D/Eは同時に開始し、全て完了しました。

filesystem上にはA〜Eそれぞれ別のpartitionが作成されました。

```text
Default/Partitions/codex-browser-<thread-a-id>
Default/Partitions/codex-browser-<thread-b-id>
Default/Partitions/codex-browser-<thread-c-id>
Default/Partitions/codex-browser-<thread-d-id>
Default/Partitions/codex-browser-<thread-e-id>
```

各partitionのChromium `Cookies` DBを `sqlite3 -readonly` で調べると、Aだけに `host_key=localhost, name=iab_marker` の行があり、B〜Eにはありませんでした。

## 失敗を再現した事実

callbackのroute引数を中継する修正前、thread Bの初期レポートはthread Aの値を返しました。

```text
ISOLATED_G_INITIAL_REPORT: {
  "cookie":"ISOLATED-F-20260812",
  "localStorage":"ISOLATED-F-20260812",
  "indexedDB":"ISOLATED-F-20260812",
  "cacheStorage":"ISOLATED-F-20260812"
}
```

同時点でfilesystem上に新しいthread partitionはなく、固定 `codex-browser-app` が更新されていました。main bundleの呼び出し元は次の形でroute引数を捨てていました。

```js
configureBrowserSession: () => this.browserSessionService.configure()
```

修正はこの引数を中継する1箇所です。

```js
configureBrowserSession: route => this.browserSessionService.configure(route)
```

## 修正後のA/B/A/Bレポート

Appが生成したassistant responseを次で読みました。

```bash
THREAD_A_ID='<thread-a-id>'
THREAD_B_ID='<thread-b-id>'
codex-app read --conversation "$THREAD_A_ID" --json
codex-app read --conversation "$THREAD_B_ID" --json
```

Aで保存直後:

```json
{"cookie":"FIXED-F-20260812","cookieSeenByServer":"FIXED-F-20260812","localStorage":"FIXED-F-20260812","sessionStorage":"FIXED-F-20260812","indexedDB":"FIXED-F-20260812","cacheStorage":"FIXED-F-20260812","serviceWorker":true}
```

Bの初期値:

```json
{"cookie":null,"cookieSeenByServer":null,"localStorage":null,"sessionStorage":null,"indexedDB":null,"cacheStorage":null,"serviceWorker":false}
```

Aへ復帰:

```json
{"cookie":"FIXED-F-20260812","cookieSeenByServer":"FIXED-F-20260812","localStorage":"FIXED-F-20260812","sessionStorage":"FIXED-F-20260812","indexedDB":"FIXED-F-20260812","cacheStorage":"FIXED-F-20260812","serviceWorker":true}
```

Bに別値を保存:

```json
{"cookie":"FIXED-B-20260812","cookieSeenByServer":"FIXED-B-20260812","localStorage":"FIXED-B-20260812","sessionStorage":"FIXED-B-20260812","indexedDB":"FIXED-B-20260812","cacheStorage":"FIXED-B-20260812","serviceWorker":true}
```

Bへ保存後、Aの新規tabで保存せずに取得:

```json
{"cookie":"FIXED-F-20260812","cookieSeenByServer":"FIXED-F-20260812","localStorage":"FIXED-F-20260812","sessionStorage":null,"indexedDB":"FIXED-F-20260812","cacheStorage":"FIXED-F-20260812","serviceWorker":true}
```

App再起動後のA:

```json
{"cookie":"FIXED-F-20260812","cookieSeenByServer":"FIXED-F-20260812","localStorage":"FIXED-F-20260812","sessionStorage":null,"indexedDB":"FIXED-F-20260812","cacheStorage":"FIXED-F-20260812","serviceWorker":true}
```

App再起動後のB:

```json
{"cookie":"FIXED-B-20260812","cookieSeenByServer":"FIXED-B-20260812","localStorage":"FIXED-B-20260812","sessionStorage":null,"indexedDB":"FIXED-B-20260812","cacheStorage":"FIXED-B-20260812","serviceWorker":true}
```

## partitionのfilesystem証跡

実行コマンド:

```bash
find "$HOME/Library/Application Support/Codex/Default/Partitions" \
  -maxdepth 1 -type d -name 'codex-browser-*' -print

find "$HOME/Library/Application Support/Codex/Default/Partitions" \
  -maxdepth 4 -type f \
  \( -name Cookies -o -name MANIFEST-000001 \) \
  -path '*codex-browser-client-new-thread*' -print
```

修正後、固定 `codex-browser-app` とは別に、A/Bそれぞれのstable routeを含むpartitionが作成されました。

```text
codex-browser-client-new-thread%253a<route-a-id>
codex-browser-client-new-thread%253a<route-b-id>
```

両partitionに `Cookies`、`Local Storage/leveldb`、`IndexedDB/http_127.0.0.1_43127.indexeddb.leveldb`、`Service Worker`が別々に作成されたことも、2つ目の `find` 出力で確認しました。

## Codex threadとIAB routeの対応

App再起動後のログを次で検索しました。

```bash
THREAD_A_ID='<thread-a-id>'
THREAD_B_ID='<thread-b-id>'
APP_PID="$(codex-app profile status | jq -r '.pids[0]')"
rg -n --no-heading \
  "iab createTab mapped page to tab.*conversationId=($THREAD_A_ID|$THREAD_B_ID)" \
  "$HOME/Library/Logs/com.openai.codex/2026/08/12"/*-"$APP_PID"-*.log
```

出力で、実際のCodex threadと異なるstable IAB routeが対応しています。

```text
conversationId=<thread-a-id> routeKey=1:client-new-thread:<route-a-id> webContentsId=4
conversationId=<thread-b-id> routeKey=1:client-new-thread:<route-b-id> webContentsId=7
```

Browser Use PiPログでもA/Bは別のBrowser IDです。

```text
browserID=<browser-a-id> tabID=1 threadID=<thread-a-id>
browserID=<browser-b-id> tabID=1 threadID=<thread-b-id>
```

## 並行Browser Useの証跡

A/Bの `codex-app send` を同時に実行したところ、両方がIPCに受理され、別turn IDを返しました。

```text
send_A_exit=0 turn=<turn-a-id>
send_B_exit=0 turn=<turn-b-id>
```

各transcriptの完了後レポートで、A/Bはそれぞれの保存値を返しました。

```text
CONCURRENT_A_REPORT: {"cookie":"FIXED-F-20260812","localStorage":"FIXED-F-20260812","indexedDB":"FIXED-F-20260812","cacheStorage":"FIXED-F-20260812","serviceWorker":true}
CONCURRENT_B_REPORT: {"cookie":"FIXED-B-20260812","localStorage":"FIXED-B-20260812","indexedDB":"FIXED-B-20260812","cacheStorage":"FIXED-B-20260812","serviceWorker":true}
```

同時間帯のAppログには、A/Bの異なるBrowser IDが残っています。

```text
browserID=<browser-b-id> tabID=2 threadID=<thread-b-id>
browserID=<browser-a-id> tabID=2 threadID=<thread-a-id>
```

## 事実と未検証事項

事実: A/Bでpersistent browser storeが分離され、異なる値を同時に保持し、App再起動後も両方が復元されました。Aの複数tabはAのpersistent storeを共有しました。A/BのBrowser Use turnを同時に実行しても、別のBrowser IDでそれぞれの値を返しました。純正IABのattach lifecycleとBrowser Use操作は完了しました。App bundleのcodesign verificationは成功しました。

未検証: Password Manager、WebAuthn、extension state、OS Keychain共有の有無、別のApp buildでの互換性です。
