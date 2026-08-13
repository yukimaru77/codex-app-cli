# Architecture

## 目的と境界

1つの公式ChatGPT/Codex App process内で、純正in-app BrowserのWebContentsとBrowser Use routingを維持しながら、Chromium `session` のpersistent partitionだけをthread別にします。

```text
official signed ChatGPT.app
  ├─ Codex thread A
  │    └─ IAB WebContents -> persist:codex-browser-<route A>
  └─ Codex thread B
       └─ IAB WebContents -> persist:codex-browser-<route B>
```

App bundle、`app.asar`、署名には書き込みません。

## 起動時の差し替え

`codex-app profile restart` は次の環境変数を付けて、インストール済みAppをLaunch Servicesから起動します。

```text
NODE_OPTIONS=--require=<repo>/runtime/preload.cjs
CODEX_IAB_RUNTIME_LOG=~/.codex/log/iab-thread-profiles.jsonl
```

`runtime/preload.cjs` はNodeのmodule compile hookを登録します。対象main bundleを読み込む瞬間だけ `runtime/transform.cjs` が9個の完全一致するpatch pointを差し替えます。元ファイルは読み取り専用です。

## partitionの割り当て

元のAppはIAB WebContentsへ常に次を割り当てます。

```js
session.fromPartition("persist:codex-browser-app")
```

差し替え後は、IAB routeの安定キーを `configureBrowserSession` へ最後まで中継し、次を使います。

```js
session.fromPartition(`persist:codex-browser-${encodeURIComponent(routeKey)}`)
```

重要な修正点は、WebContents側のpartition名だけでなく、実際のElectron sessionを生成するcallbackにもroute keyを渡すことです。callbackが引数を捨てると見かけ上のrouteだけが変わり、ストレージは固定partitionを共有します。この回帰はlive A/B testで検出します。

## 既存profileからの初期化

既定ではCodex Appの標準import先 `codex-browser-app` をseedとして選びます。新しいthreadのbrowser sessionを初めて生成する直前に、seedを `codex-browser-<thread-id>` へ同期的にコピーします。現在のApp processはseed partition自体を開かずthread partitionだけを使うため、import済みseedと新しいthreadの保存先は共有されません。

`restart --from <profile>` は別の既存partitionをseedに選択します。既に空profileが生成されたthreadには、Appを正常終了してから `--thread <id> --replace` で事前コピーできます。この経路ではChromiumのSQLite・LevelDBを稼働中に置換しません。

`restart --from chrome:<directory-or-display-name>` はApp bundle内の独自実装を再現せず、署名済みAppがElectron sessionへ公開している `browserProfileImporter` を呼びます。現行Appの標準importerは呼び出し元sessionにかかわらず固定の `persist:codex-browser-app` を更新するため、import専用App processの終了を待ってから、そのdirectoryを一意な `codex-browser-chrome-import-<uuid>` seedへsnapshotします。通常runtimeはこのsnapshotだけを参照し、新規threadのpartitionを作ります。

Chrome profileの選択にはChromeの `Local State` にあるdirectory名と表示名だけを使い、CookieやPassword DBをCLI自身では読み取り・復号しません。import指定は標準UIと同じCookie/Password有効、History無効です。`--thread <id>` がある場合はsnapshotから指定sessionのprofileも事前作成し、既存profileは `--replace` なしでは上書きしません。

既存のthread partitionは既定で再利用します。`--replace` を明示した場合も旧ディレクトリを削除せず、`.backup-<timestamp>` へrenameしてから新しいコピーを作成します。profile名はPartitionsディレクトリ直下の `codex-browser-*` のみに制限し、任意pathやsymlinkは受け付けません。

## 純正Browser Use routingの維持

Appはwebview attach時に、route partitionへ埋め込まれたconversation ID、browser tab ID、renderer instance ID、host generationを検証します。persistent partition名を変更するとこのmetadataが失われるため、renderer hookが一時的に `src` とdata attributeへmetadataを載せ、main processがattach前に元のregistered routeを復元します。

この処理は純正preload、Browser Use native pipe、Annotation、navigation policyを置き換えません。実機ログで `browser sidebar will attach`、`did attach`、`runtime attached`、`attached browser sidebar guest` まで通過することを確認しています。

## fail closed

`inspect` と `restart` は以下を検査します。

- macOSのdeep codesign verificationが成功すること。
- bundle IDが `com.openai.codex` であること。
- signing teamが `2DC432GLL2` であること。
- authorityがOpenAIであること。
- main bundle内の9個のpatch pointがそれぞれちょうど1回だけ存在すること。

App更新で一致しなくなった場合は起動前に停止し、共有partitionへ黙ってfallbackしません。

## 通常状態への復元

ランタイム差し替えはprocess lifetimeだけ有効です。`codex-app profile restore` はAppを終了し、環境変数なしで同じ署名済みAppを再起動します。ファイルを戻す処理は不要です。
