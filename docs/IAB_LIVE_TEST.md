# Live isolation test

## 最小合格条件

この実装のsession境界に対する合格条件は次の3点です。

1. 新規Codex session Aで対象サイトのサーバーセッションを作成する。
2. 同じAの次turnで、タブを開き直しても同じサーバーセッションを保持する。
3. 新規Codex session Bで同じURLを開くと、Aのサーバーセッションを持っていない。

A/Bが通った場合に、新規C/D/Eでも3と同じ結果になることを追加確認します。各sessionは異なるthread IDでなければならず、同じ長寿命threadへの追記だけではこの条件を検証したことになりません。

## 手順

fixtureを起動します。

```bash
npm run fixture
```

別terminalでAppをランタイムパッチ付きで起動します。

```bash
codex-app profile inspect
codex-app profile restart
codex-app profile status
```

2つのCodex thread A/Bに、純正in-app Browserだけを使って `http://localhost:43127/` を操作させます。

1. Aでmarker `THREAD-A` を全storeへ保存し、レポートを取得する。
2. Bでは何も保存せずレポートを取得する。全値が空であることを確認する。
3. Bでmarker `THREAD-B` を全storeへ保存する。
4. Aへ戻り、保存操作なしでレポートを更新する。`THREAD-B` で上書きされず `THREAD-A` が残っていることを確認する。
5. Aで新規in-app Browser tabを作り、persistent storeがA内で共有されることを確認する。
6. `codex-app profile restart` 後にA/Bの両方を再確認し、それぞれのpersistent storeが独立して復元されることを確認する。
7. `codex-app profile restart --from default` を再実行しても、既存A profileが変更されず保存済み状態が維持されることを確認する。
8. `codex-app new --profile default` で新しいthread Cを作成し、共有profileのログイン状態を初期値として引き継いだ後、C側の変更が共有profileやA/Bへ反映されないことを確認する。
9. A/Bのturnを同時に開始し、両方がin-app Browserで値を読み戻してもrouteとstoreが交差しないことを確認する。

対象storeはCookie、serverが観測したCookie、Local Storage、Session Storage、IndexedDB、Cache Storage、Service Workerです。

## 2026-08-12の新規5session実測

公式ChatGPT/Codex `26.803.61601` で、5つの新規Codex session A〜Eを作成しました。公開版ではローカルthread IDを削除しています。

session Aの1turn目でmarker `FRESH-SERVER-SESSION-A-20260812` を保存した結果:

```text
THREAD_A_CREATED: cookie=FRESH-SERVER-SESSION-A-20260812, cookieSeenByServer=FRESH-SERVER-SESSION-A-20260812
```

同じAの2turn目では、以前のtabが閉じられていたため同じin-app Browser内の新しいtabでURLを開き直しました。保存操作をせず、同じ値を取得しました。

```text
THREAD_A_SECOND_TURN: cookie=FRESH-SERVER-SESSION-A-20260812, cookieSeenByServer=FRESH-SERVER-SESSION-A-20260812
```

異なる新規session B/C/D/Eでは、全てAのCookieを持っていませんでした。

```text
THREAD_B_INITIAL: cookie=null, cookieSeenByServer=null
THREAD_C_INITIAL: cookie=null, cookieSeenByServer=null
THREAD_D_INITIAL: cookie=null, cookieSeenByServer=null
THREAD_E_INITIAL: cookie=null, cookieSeenByServer=null
```

B〜Eの実行後にAを再度開いても、Aのサーバーセッションは保持されていました。

```text
THREAD_A_AFTER_FIVE_SESSIONS: cookie=FRESH-SERVER-SESSION-A-20260812, cookieSeenByServer=FRESH-SERVER-SESSION-A-20260812
```

ChromiumのCookie DBを読み取り専用で確認すると、Aのpartitionだけに `localhost/iab_marker` が存在し、B〜Eには存在しませんでした。

```bash
for id in "$THREAD_A_ID" "$THREAD_B_ID" "$THREAD_C_ID" "$THREAD_D_ID" "$THREAD_E_ID"; do
  db="$HOME/Library/Application Support/Codex/Default/Partitions/codex-browser-$id/Cookies"
  printf '%s\t' "$id"
  sqlite3 -readonly "$db" \
    "SELECT host_key, name, length(encrypted_value)
       FROM cookies
      WHERE host_key = 'localhost' AND name = 'iab_marker';"
done
```

判定: 同じCodex session内の後続turnで保持し、別の4sessionから隔離されることに合格。

## 2026-08-12の全store実測

公式ChatGPT/Codex `26.803.41515`の2つの独立したthread A/Bで確認しました。公開版ではローカルthread IDを削除しています。

| Store | Aで保存直後 | Bの初期値 | Bで保存後 | Aの新規tab | App再起動後のA | App再起動後のB |
|---|---|---|---|---|---|---|
| Cookie | `FIXED-F-20260812` | `null` | `FIXED-B-20260812` | `FIXED-F-20260812` | `FIXED-F-20260812` | `FIXED-B-20260812` |
| server Cookie | `FIXED-F-20260812` | `null` | `FIXED-B-20260812` | `FIXED-F-20260812` | `FIXED-F-20260812` | `FIXED-B-20260812` |
| Local Storage | `FIXED-F-20260812` | `null` | `FIXED-B-20260812` | `FIXED-F-20260812` | `FIXED-F-20260812` | `FIXED-B-20260812` |
| Session Storage | `FIXED-F-20260812` | `null` | `FIXED-B-20260812` | `null` | `null` | `null` |
| IndexedDB | `FIXED-F-20260812` | `null` | `FIXED-B-20260812` | `FIXED-F-20260812` | `FIXED-F-20260812` | `FIXED-B-20260812` |
| Cache Storage | `FIXED-F-20260812` | `null` | `FIXED-B-20260812` | `FIXED-F-20260812` | `FIXED-F-20260812` | `FIXED-B-20260812` |
| Service Worker | `true` | `false` | `true` | `true` | `true` | `true` |

BのIAB操作とAへの復帰はいずれもBrowser Use native pipeを通して完了しており、Chromeへは切り替えていません。

A/Bのturnを同時にIPCへ送信した追加試験では、Aが `FIXED-F-20260812`、Bが `FIXED-B-20260812` の全persistent storeをそれぞれ返しました。Appログでも同じ時間帯にA/Bが別のBrowser IDと別のturn IDで完了しました。

## 判定

- A/Bに別の値を保存しても交差せず、App再起動後に両方が独立して復元されること: 合格。
- Aの新規tabがAのpersistent storeを共有し、tab固有のSession Storageは共有しないこと: 合格。
- Session StorageがApp再起動後に消えること: 合格。
- A/BのBrowser Use turnを同時実行しても値とrouteが交差しないこと: 合格。
- in-app Browser / Browser Useがパッチ後も利用できること: 合格。
