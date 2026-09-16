# CLAUDE.md

このリポジトリで作業する際のガイド。

## プロジェクト概要

スマートフォン（iPhone / Android）のブラウザで動く、OCR・バーコード・QR読み取り付きの検品用ページ。

- **フロント**: 素の HTML + JavaScript。**ビルド工程なし**（npm も webpack も使わない）。ファイルを置き換えれば即反映される構成を維持すること
- **バックエンド**: PHP built-in server（`php -S`）。フレームワークなし
- **利用者**: 現場の検品担当者。片手持ち・手袋・屋内照明を想定

## 起動

```powershell
# 1) ローカルサーバー
php -S 0.0.0.0:8080 -t .        # または start-server.bat

# 2) HTTPS 公開（実機で使うには必須）
cloudflared tunnel --url http://localhost:8080
```

`getUserMedia`（カメラ）は **HTTPS か localhost でしか動かない**。
実機確認は Cloudflare Tunnel が発行する `https://xxx.trycloudflare.com` を使う運用で確定している。
URL は起動のたびに変わるので、固定URLが必要になったら named tunnel（`cloudflared tunnel create`）へ移行する。

## ディレクトリと責務

| ファイル | 責務 |
|---|---|
| `config/default.php` | **設定の置き場**（画面側・保存側で共通）。すべてのプロジェクトの土台。Git 管理 |
| `config/local.php` | 設置先ごとの差分（Git 管理外）。default.php を触らずに土台を上書きする。雛形は `local.php.sample` |
| `config/<ID>.php` | プロジェクト別の差分。書いた項目だけ土台を上書きする |
| `config/loader.php` | 設定の読み込みとマージ（仕組み。通常は編集しない） |
| `api/config.js.php` | 設定を JavaScript として画面側へ配信。`window.CONFIG` / `window.OCR_CHARSETS` を出力 |
| `index.php` | DOM構造のみ。冒頭の PHP は「URLの ?p= を設定配信へ引き継ぐ」ためだけにある |
| `assets/js/scanner.js` | カメラ制御・ROI計算・OCR(Tesseract)・コード読取(ZXing)。DOM操作は映像系のみ |
| `assets/js/stack.js` | スタックの保持・描画・並び替え。`StackList` クラス |
| `assets/js/app.js` | 画面全体の制御・候補リスト・送信・クリア。他モジュールの接着役 |
| `assets/css/style.css` | 全スタイル。CSS変数は `:root` に集約 |
| `api/upload.php` | アップロード受け口。`config.php` の `SERVER` / `FILENAME` を読む |
| `storage/` | 保存先。`<project_id>/<文字列をハイフン連結>.jpg`（写真保存なしモードでは `<タイムスタンプ>.json` / `.txt`） |

## 変更時に必ず守ること

### 1. 設定は config/ に集約する

**設定は `config/` 配下だけ**。以前あった `assets/js/config.js` と `api/config.php` の
二重管理は解消済み。**元に戻さないこと。**

```
config/default.php ─┐
config/local.php ───┼→ loader.php ─┬→ api/config.js.php → window.CONFIG   （画面側）
config/<ID>.php ────┘              └→ api/upload.php    → $CONFIG/$FILENAME（保存側）
```

- 共通の値は `config/default.php`、プロジェクト固有の値は `config/<ID>.php` に**差分だけ**書く
- 設置先で土台を変えたいとき（既定 `PROJECT_ID`、`SERVER` の上限値など）は
  `config/local.php` に書く。**default.php は Git 管理なので設置先で編集させない**
  （更新時に競合するため）。`local.php` は `.gitignore` 済み。
  マージ順は `default.php` → `local.php` → `<ID>.php`（`inspection_base_config()` が前2つを重ねる）
- 画面側にだけ必要な値も、保存側にだけ必要な値も、すべてここに書く
- **`SERVER` セクションは画面側に送られない**（`api/config.js.php` が `unset()` する）。
  サーバー内のパスや上限値はここに置くこと
- `FILENAME.ALLOWED_CHARS` / `SEPARATOR` は**両側が同じ値を使う**。
  `app.js` の `sanitizeForFilename()` と `api/upload.php` の `sanitize_token()` は
  どちらもこの設定から正規表現を組み立てるので、ルールがズレることはない
- `FILENAME.APPEND_NOTE`（既定 true）で**備考がファイル名の末尾に付く**
  （`<スタック連結>` または `<タイムスタンプ>` + `NOTE_SEPARATOR` + `<備考>`）。
  **画像モード・写真保存なしモードの両方で効く**（2026-09-16 に text モードにも拡張）。備考は日本語を残すため
  `ALLOWED_CHARS` では絞らず、「Windows で使えない文字 `\ / : * ? " < > |` と制御文字を除去 /
  前後の空白・改行をトリム / 途中の改行は空白1つに置換 / 末尾のドット・空白を除去 /
  `NOTE_MAX_LENGTH` 文字で切り詰め」という別規則で整える。
  `app.js` の `sanitizeNoteForFilename()` と `api/upload.php` の `sanitize_note_for_filename()`
  は**手順を1対1で揃えてある**ので、片方だけ変えないこと。
  `/` `\` が消えるので備考でフォルダの外には出られない。
  `api/upload.php` では備考付与と `MAX_LENGTH` の切り詰めをモード分岐の**外**に置いてある。
  モード別の分岐の中へ戻さないこと
- `FILENAME.MAX_LENGTH` の切り詰めは `mb_strcut()` で行う（備考の多バイト文字の途中で
  切ると不正な UTF-8 のファイル名になるため）。`substr()` に戻さないこと

`OCR.PATTERN` は JSON に正規表現リテラルを置けないため **設定では文字列**
（スラッシュで囲まない中身だけ）で書く。**文字列1本でも、文字列の配列でもよい。**
`api/config.js.php` が `new RegExp()` に変換し、**常に配列 `CONFIG.OCR.PATTERNS`
（RegExp の配列）へ正規化して**配信する（元の `PATTERN` は `delete` する）。
`scanner.js` は `patterns.some((re) => re.test(text))` で「どれか1本に一致」を見る。
空配列は絞り込みなし。解釈できない式はその1本だけを捨て、残りは生かす。

**品番の形が複数あるときは配列で並べること。1本の式に `|` で詰め込まない。**
`|` は優先順位がいちばん低いので、`^A|B$` は `(^A)` または `(B$)` と解釈され、
**各分岐の片側にしかアンカーが掛からない**。実際に
`^QA\d{16}|[A-C]{3}-\d{5}$` で `TYPEAAA-12345` が通る不具合を踏んでいる。

`api/config.js.php` は `Cache-Control: no-store` を付けている。
設定変更がリロードで必ず反映されるようにするためなので、外さないこと。

### 1-2. プロジェクト切り替えの約束ごと

`?p=<ID>` でプロジェクトを切り替える。**設定はサーバー側で組み立てるため、
切り替えは画面の再読み込みを伴う**（JSだけで差し替えることはできない）。

- **プロジェクトIDはファイル名と保存フォルダ名になる。**
  `inspection_valid_project_id()` が英数字と `. _ -` だけを通し、
  `..` / 先頭ドット / `default` / `loader` を弾く。**この検証を緩めないこと**
- 不正なIDや未定義のIDは**既定プロジェクトに落ちる**（エラーにしない）。
  存在しない設定ファイルを指定されても既定で動き続けるほうが現場では安全
- マージは `inspection_merge_config()`。連想配列は再帰マージ、
  **リスト（`BARCODE.FORMATS` など）は丸ごと置き換え**。
  ただし**連想配列の土台に空配列 `[]` を重ねても土台は消えない**（PHP は空配列を
  リスト扱いするため、`local.php` の `'SERVER' => []` で `MAX_STRINGS` ごと消えて
  送信が全滅した実例がある）。この例外を外さないこと
- `index.php` の冒頭 PHP は、確定した ID を `api/config.js.php?p=` に渡すためにある。
  ここを消すと、URLで切り替えても設定が既定のままになる
- 画面のセレクトは**プロジェクトが2つ以上定義されているときだけ**表示される。
  1つなら従来どおりのラベル表示（現場の操作数を増やさないため）
- **`SHOW_IN_SELECT` は継承されない特別な項目**。`inspection_list_projects()` が
  各ファイルの生の配列から直接読み、`inspection_load_config()` は結果から `unset()` する。
  `default.php`（`local.php`）に書けば既定プロジェクト（`PROJECT_ID`）の表示だけ、
  `<ID>.php` に書けばそのプロジェクトの表示だけを決める。マージ経由で伝播させないこと
- 隠したプロジェクトを開いているときは、`app.js` の `setupProjectSwitcher()` が
  現在のプロジェクトを選択肢の先頭に足す（セレクトが現在地と食い違わないようにするため）
- `SERVER.ALLOWED_PROJECT_IDS` を指定すると、一覧もそのIDだけに絞られる
  （送信できないプロジェクトを選ばせない）
- `?p=local` は `inspection_valid_project_id()` が弾く（`default` / `loader` と同じ扱い）
- 切り替え時は `leavingIntentionally` を立ててから遷移する。
  `beforeunload` は `addEventListener` で登録しているため
  `window.onbeforeunload = null` では解除できない

### 1-3. 写真保存なしモード（`SAVE.MODE`）

`config` の `SAVE.MODE` で保存するものを切り替える。**画面側と保存側の両方がこの値を見る。**

| 値 | 保存されるもの | ファイル名 |
|---|---|---|
| `'image'`（既定） | 撮影画像 | スタック文字列を `FILENAME.SEPARATOR` で連結 |
| `'text'` | スタック文字列だけ（写真は保存しない） | `SAVE.TIMESTAMP_FORMAT` によるタイムスタンプ + `.json` / `.txt` |

- **どちらのモードで動くかはサーバー側の設定が正**。`api/upload.php` は自分の設定を見て
  判断し、`'text'` のときは画像を受け取らない（送られてきても保存しない）。
  画面側は送信に撮影が必要かどうかを切り替えるためだけに `CONFIG.SAVE` を見る
- `'text'` では **`state.captured` を送信の条件にしない**（`app.js` の `updateSubmitState`）。
  シャッターは静止画OCRのために残してあるので、押せること自体は変えないこと
- `'text'` では `scanner.capture()` が送信用 JPEG を作らない（`capturedBlob` は null）。
  静止画は表示と静止画OCRのためだけに使う
- ファイル名は `date(SAVE.TIMESTAMP_FORMAT)` の結果を **`sanitize_token()` に通してから**使う。
  書式に `/` などが入っても保存先の外に出られないようにするため。**この処理を外さないこと**
- 同名時の扱いは `resolve_save_path()` に集約した（画像モードと共通）。
  ただし `'text'` では `ON_CONFLICT = 'timestamp'` を連番に読み替える
  （名前が既にタイムスタンプなので、同じ日時を二重に付けても区別できない）
- `TEXT_FORMAT = 'txt'` の**中身には備考が入らない**（1行1文字列だけ）。備考も残すなら `'json'` にする
  （`APPEND_NOTE` が有効ならファイル名の末尾には付くので、名前で区別はできる）
- ファイル名は `<タイムスタンプ>` + `NOTE_SEPARATOR` + `<備考>` になる（`APPEND_NOTE` 時）。
  画面のプレビューは `<送信時刻>_<備考>.json` のように出す（`app.js` の `appendNoteToBaseName()`）

### 2. ROI の座標変換を壊さない

`scanner.js` の `computeRoi()` は、**`object-fit: cover` で表示されている video の
表示座標 → 映像ピクセル座標** を変換している。ガイド枠のDOM位置と実際の切り出し範囲を
一致させるための計算で、ここが狂うと「枠に合わせたのに読めない」という分かりにくい不具合になる。

`.camera-stage` の `aspect-ratio` や `object-fit` を変えたら、この関数も併せて見直すこと。

### 3. スタックの D&D は Pointer Events 自前実装

**モバイルでは HTML5 Drag & Drop が動かない**ため、`stack.js` で Pointer Events による
並び替えを自前実装している。ライブラリ（SortableJS 等）に置き換える提案をする前に、
ビルド工程なしという制約を満たせるか確認すること。

- `stack.js` の `ITEM_GAP = 6` は CSS `.stack-item { margin-bottom: 6px }` と一致させる必要がある
- ハンドルには `touch-action: none` が必須（外すとページスクロールに奪われる）
- ドラッグ中のスクロール量は `_scrollOffset()`（`window.scrollY` + 祖先要素の `scrollTop` の合計）の
  差分で補正している。本文は `.app-main` の内側でスクロールするため `window.scrollY` だけでは足りない

### 4. OCR とコード読取は別ループ

- OCR は Tesseract の Worker で動く（メインスレッドを止めない）。`_scheduleOcr()` / `OCR.INTERVAL_MS`
- バーコード/QR は ZXing でメインスレッド実行。`_scheduleCode()` / `CODE_SCAN_INTERVAL_MS`
- 静止画モード（`mode === 'still'`）ではループを止め、`capture()` 内で各1回だけ実行する

`currentSource()` が返す解析対象は、ライブ時は `video`、静止画時は `fullCanvas`。
新しい認識処理を足すときは必ずこれを経由すること。

### 5. 重複通知の抑制

`scanner.emitted`（Set）で同一文字列の再通知を防ぎ、`stableMap` で
「同じ文字列が N 回連続で読めたら採用」という手ブレ対策をしている。
クリア操作では `resetDetections()` を呼んで両方を空にする。

### 6. `hidden` 属性と `display` の競合（実際に踏んだ）

`.blocker { display: flex }` のように作者スタイルで `display` を指定すると、
UA スタイルシートの `[hidden] { display: none }` を上書きしてしまい、
**HTML の `hidden` 属性が無視されて要素が出っぱなしになる**。

初期状態で送信中オーバーレイが表示され続け、操作不能になる不具合を起こした。
現在は `style.css` の先頭に以下を置いて一括で防いでいる。**この行を消さないこと。**

```css
[hidden] { display: none !important; }
```

`hidden` 属性で出し入れする要素（`#blocker` `#cameraMessage` `#stillCanvas` `#toast`
`#torchBtn` `#filenamePreview`）を増やすときも、この仕組みに乗せる。

また、メッセージ中の `\n` を改行として見せる要素には `white-space: pre-line` が必要。
指定しないと1行に繋がり、横スクロールを発生させる（`.camera-message` で対処済み）。

### 7. OCR の準備でカメラ操作をブロックしない

OCR の学習データは約17MB あり、初回読み込みに時間がかかる。
これを待ってからでないと操作できない作りにすると「起動したが何もできない」状態になる。

現在の分担:

- `scanner.initEngines()` — バーコード/QR のみ。軽いので `await` してよい
- `scanner.initOcr()` — OCR。**`await` せず投げっぱなしにする**。
  準備完了時にカメラが動いていれば `_scheduleOcr()` で認識ループへ自動合流する

OCR の読み込みに失敗してもバーコード/QR と撮影・送信は使えるべき。
片方の失敗で全体を止めないこと。

### 8. `.bat` は Shift_JIS で保存する（実際に踏んだ）

`start-server.bat` を UTF-8 で保存すると、cmd が CP932 として読んで日本語が壊れ、
**化けたバイト列がコマンドとして実行される**（`'calhost:' is not recognized` などが多発する）。

- ファイルは **Shift_JIS + CRLF** で保存する
- 説明は `echo` ではなく `REM` コメントに書く（化けても実行されないため被害が小さい）

### 9. OCRの例外を握りつぶさない（実際に踏んだ）

`_scheduleOcr` の catch が `log()`（`CONFIG.DEBUG` が false だと無出力）だけだったため、
OCR が毎回例外を投げていても画面上は「何も読み取れない」としか見えず、原因を追えなかった。

現在は `onError(e, kind, count)` で必ず表面化させ、バッジとトーストに出している。
**定期実行されるループの catch を無言にしないこと。**

### 10. OCR が読めないときの調べ方

`?debug=1` を付けると診断パネルが出る（`CONFIG.DEBUG` でも可）。
**OCRに実際に渡している画像**と、フィルタで落ちた理由が見える。

切り分けの要点: **バーコード/QR は画面全体を走査、OCR は ROI の中だけ**。
「バーコードは読めるが文字は読めない」なら、まず ROI と文字サイズを疑う。
`ROI.ENABLED: false` で全画面OCRにして切り分けられる。

OCR の各フィルタは実カメラでは厳しく効きすぎる。既定値を変える際は以下に注意:

- `STABLE_COUNT` を 2 以上にすると「同じ文字列が連続で完全一致」を要求するため、
  手持ち撮影ではほぼ採用されなくなる。**1 が既定**
- `MIN_CONFIDENCE` は実カメラだと 50〜70 に落ちる。**45 が既定**
- Tesseract は文字高 30px 程度ないと読めない。ROI を広くしすぎると文字が相対的に小さくなる

### 11. Tesseract.js の検証は Node で行う

ヘッドレス Chrome の `--virtual-time-budget` は Web Worker + wasm と噛み合わず、
Tesseract の処理が完了しないまま終了する（`running...` のまま固まる）。

エンジン挙動の検証は Node で行うのが確実。

```bash
npm install tesseract.js@5.1.1
node -e "..."   # createWorker → setParameters → recognize
```

検証済みの事実（2026-09-09時点）:

- `tessedit_char_whitelist` は OEM 1 (LSTM) でも正しく効く
- `recognize(img, {}, { blocks: true, text: true })` で `data.blocks` から単語を取得できる
- 良好な画像なら conf 86〜92 で読める（フィルタは全て通過する）

つまり**エンジン側は正常**。読めない場合は画像品質・ROI・フィルタのいずれかを疑うこと。

### 12. 信頼度は「不明(null)」と「0」を区別する（実際に踏んだ）

iPhone (iOS Safari) では Tesseract が**単語ごとの信頼度を返さない**ことがある。
`extractWords()` が `confidence: 0` を入れていたため、正しく読めた文字列まで
`MIN_CONFIDENCE` で全滅した（実機で発生）。

現在の扱い:

- 単語の信頼度が無い / 0 → ページ全体の信頼度で代用
- それも無ければ **`null`（不明）** とし、`_acceptOcrWords()` は
  `conf !== null` のときだけ信頼度判定を行う
- 診断パネルには `信頼度?` と表示される

**信頼度を 0 にフォールバックしないこと。** 数値でない値を安易に 0 で埋めると、
しきい値フィルタが「全部落とす」方向に倒れる。

### 13. 読み取り許可文字は EXTRA_CHARS で足す

品番のハイフンなどを読むため `CONFIG.OCR.EXTRA_CHARS`（既定 `'-'`）がある。
これは2箇所に効くので、**新しい記号を足すときは両方を通す実装を壊さないこと**。

- `charsetFor()` → Tesseract の `tessedit_char_whitelist`
- `allowRegexFor()` → 採用時の正規表現（`escapeForCharClass()` で `- ] ^ \` を無害化）

なお、ファイル名はスタック文字列を「-」で連結するため、
文字列自体にハイフンが含まれると区切りが視覚的に分かりにくくなる。仕様上は問題ない。

### 14. 撮影画像は「画面に写っている範囲」に揃える

video は `object-fit: cover` で表示しているため、映像の一部は画面外にはみ出している。
撮影画像にその部分が入ると「撮ったつもりのない範囲が保存される」ことになる。

`computeVisibleRect()` が可視範囲を映像座標で返し、`capture()` がそこだけを取り込む
（`CONFIG.CAPTURE.CROP_TO_VIEW`、既定 true）。

`computeRoi()` と同じ座標変換に依存しているので、**`.camera-stage` の
`aspect-ratio` や `object-fit` を変えたら両方まとめて見直すこと。**

なお切り出し後の `fullCanvas` は静止画OCRの解析対象でもある。可視範囲に揃えると
`fullCanvas` の比率が stage と一致し、`computeRoi()` のオフセットが 0 になるため、
静止画でもガイド枠と実際の切り出し位置が一致する（この整合性を壊さないこと）。

### 15. iPhone Safari で静止画から戻すと映像が止まる（実際に踏んだ）

送信（送信中オーバーレイ表示）→ クリアの順に操作すると、`resumeLive()` で
静止画キャンバスを隠しても video が静止したままになる（カメラ停止→開始で直る）。
iOS Safari は confirm() や全画面オーバーレイのあとで MediaStream の `<video>` を
勝手に一時停止・描画停止することがあるため、**戻すときは映像が更新されているかを確認する**。

- `scanner.ensureLive()` が `requestVideoFrameCallback` で新しいフレームを待ち、
  来なければ `play()` → `srcObject` 付け直し の順で復旧を試みる。それでも動かなければ false
- `resumeLive()` は async になり、この結果を返す。`app.js` の `backToLive()` が
  false を受けたらカメラを停止→開始し直す（手動対処の自動化）
- video の `pause` イベントでも、意図しない停止なら `play()` し直す
- 静止画への切り替え・復帰を触るときは `resumeLive()` を `await` し、戻り値を捨てないこと

### 16. フッタは position: fixed にしない（実際に踏んだ）

iPhone Safari で、ページ末尾までスクロールすると `position: fixed; bottom: 0` のフッタ
（クリア / 送信）が縮んだツールバーの裏に隠れ、ツールバー部分をタップするか
さらに引っ張らないと出てこない現象が起きた。

現在はアプリシェル型レイアウトで回避している。**この構造を崩さないこと。**

- `body` は `height: 100dvh` + `overflow: hidden` の flex 縦並び。**ドキュメント自体はスクロールしない**
  （スクロールしなければ Safari のツールバーは縮まず、フッタが裏に回ることもない）
- スクロールするのは `.app-main` だけ（`flex: 1; min-height: 0; overflow-y: auto`）。
  `min-height: 0` を外すと flex 子要素が縮まず overflow が効かなくなる
- `.app-header` / `.app-footer` は通常配置の flex 子要素（`flex-shrink: 0`）
- `.toast` / `.blocker` は従来どおり `position: fixed`（ビューポート基準で問題ない）
- 備考欄フォーカス時のキーボード表示で iOS がページ全体をずらす可能性はあるが、実機未確認

### 17. iPhone でスリープ解除後にライブ表示だけが縦長に歪む（実際に踏んだ）

ページを開いたままスリープ／ロック解除を繰り返すと、たまにカメラのライブ表示が
縦長に歪む。**撮影画像・撮影後プレビュー・読み取り結果は正常**（どれも `drawImage(video)`
で映像フレームから作るため）で、おかしいのは `<video>` 要素の描画だけ。
iOS Safari は MediaStream をネイティブレイヤーで描画しており、復帰後にその
向き・サイズ情報を古いまま持ち越すことがある。同じ要素に新しいストリームを差しても
レイヤーは使い回されるため**カメラ停止→開始では直らず、リロードでは直る**。

対処として `scanner.startCamera()` は開始のたびに `_recreateVideo()` で `<video>` を
`cloneNode(false)` した新しい要素に置き換える（id・属性・DOM 上の位置は引き継ぐ）。
`this.video` の参照が差し替わるので、**video 要素を外で握り続けないこと**
（`app.js` は Scanner に渡すだけ）。要素へのイベント登録は `_bindVideoEvents()` に
まとめてあり、作り直すたびに呼ばれる。新しいイベントを足すときはここに書く。
実機でしか再現しないため、この対処の効果は**実機未検証**（ヘッドレス Chrome で
要素の置き換え自体は確認済み）。

### 18. 自前の JS/CSS には更新時刻のクエリを付ける（実際に踏んだ）

`api/config.js.php` は `no-store` で毎回取り直されるが、`assets/` の JS/CSS には
キャッシュ制御が無く、iPhone Safari が古い `app.js` を使い続けて
「設定は最新、画面の処理だけ古い」状態になった（プルダウンの現在地表示が食い違った）。

`index.php` の `asset_url()` が `?v=<filemtime>` を付けて配信する。
自前の JS/CSS を `index.php` に足すときは、必ずこの関数を通すこと。

### 19. 近接でピントが合わない Android 端末（ズーム / カメラ切替）

Galaxy の一部は、ブラウザからは純正カメラアプリの「自動マクロ切り替え」が使えず、
メインカメラの最短撮影距離より近づくとピントが合わない（iPhone は OS 側が
超広角マクロへ切り替えるので問題ない）。対処として映像右下に2つのボタンを出す。

- **ズーム**（`CAMERA.ZOOM_LEVELS`）: 近づかずに枠を埋める。`track.getCapabilities().zoom`
  が取れる端末でだけ表示。**ズームは `getUserMedia` の制約に入れず**、起動後に
  `applyConstraints({ advanced: [{ zoom }] })` で掛ける（非対応端末で
  OverconstrainedError にしないため）
- **カメラ切替**（`CAMERA.SWITCH_BUTTON`）: `enumerateDevices()` の背面カメラを順送りする。
  前面はラベル（front / user / 前面 など）で除く。**ラベルは許可後にしか入らない**ので
  一覧はカメラ起動後に取る。`deviceId: { exact }` で起動し、失敗したら FACING_MODE に
  落として記憶を捨てる（`startCamera()` の戻り値 `deviceFallback`）
- 選んだ倍率とカメラは `localStorage`（`inspection.cameraZoom` / `inspection.cameraDeviceId`）
  に記憶する。端末固有の癖への対処なので、タブや日をまたいで残してよい
- 静止画のあいだは両ボタンを無効にする（`updateModeChip()`）。切替はカメラ再起動になり
  撮影内容が消えるため
- `?debug=1` の診断パネル先頭に、ズーム範囲・focusMode・focusDistance・ライトの対応状況を出す。
  実機でどの手が効くかはまずここを見る

実機で未検証。ヘッドレス Chrome では `getUserMedia` / `enumerateDevices` を偽装して
ボタンの出し入れ・ズーム段送り・切替・記憶・フォールバックの流れだけ確認済み。

## 外部ライブラリ

CDN から読み込んでいる（`index.html` の `<script>` と `config.js` の `OCR.*_PATH`）。

| ライブラリ | バージョン | 用途 |
|---|---|---|
| tesseract.js | 5.1.1 | OCR |
| tesseract.js-core | 5.1.0 | wasm |
| eng.traineddata | 4.0.0_best | 学習データ（約12MB） |
| @zxing/library | 0.21.3 | バーコード / QR |

**API の使い方（バージョン依存の注意点）**

- Tesseract v5: `createWorker(lang, oem, options)` / `worker.recognize(image, {}, { blocks: true, text: true })`
- 認識結果の単語は v4 が `data.words`、v5 は `data.blocks[].paragraphs[].lines[].words[]`。
  `extractWords()` が両対応しているので、バージョンを上げるときはここを確認する
- ZXing は `MultiFormatReader` + `HTMLCanvasElementLuminanceSource` + `HybridBinarizer` の
  低レベルAPIを直接使っている（`decodeFromVideoDevice` は自前のカメラ管理と競合するため使わない）

バージョンを上げる際は、上記のエクスポート名とシグネチャが維持されているか実ファイルで確認すること。

## 検証方法

### バックエンド（カメラ不要・自動で確認できる）

```bash
php -S 127.0.0.1:8099 -t . &

# 正常系
curl -sS -X POST http://127.0.0.1:8099/api/upload.php \
  -F 'project_id=PRJ-0001' -F 'strings=["AB123","CD456"]' -F 'note=test' \
  -F 'image=@tiny.jpg;type=image/jpeg'
```

確認済みのケース: 正常系 / 同名衝突（`_2` 付与）/ パストラバーサル（`../../etc` → `etc` に無害化）/
非画像ファイルの拒否 / 超長ファイル名の切り詰め＋ハッシュ / 日本語備考の UTF-8 保存。

備考のファイル名付与（2026-09-15 に確認済み）: 改行・禁止文字・前後空白の整形 /
備考が空・禁止文字だけなら付かない / 備考込みの同名衝突で `_2` / `APPEND_NOTE = false` で付かない /
`NOTE_MAX_LENGTH` での切り詰め / `MAX_LENGTH` 超過時に多バイト境界で切れてハッシュが付く /
`SAVE_META` の JSON 名が画像名と揃う / `../../etc/passwd` → `....etcpasswd`。
`SHOW_IN_SELECT` と `local.php` は `api/config.js.php` の `PROJECTS` を curl で見れば確認できる
（`local.php` を作ったテストは**必ず消してから終わること**）。

写真保存なしモード（`SAVE.MODE = 'text'`）は、検証用の `config/<ID>.php` を一時的に作って
`-F 'image=@...'` を付けずに POST すれば確認できる（2026-09-10 に確認済み:
json/txt の書き出し / 同秒での連番 / 画像を送っても保存しない / `TIMESTAMP_FORMAT` に
`/` を入れてもファイル名から除去される / 画像モードが従来どおり動く）。

**テストで作った `storage/` 配下のデータと、検証用に作った `config/<ID>.php` は
必ず消してから終わること。**

Windows の Git Bash から `curl -F` を使う場合、`/tmp/...` のパスは Windows 版 curl が
解決できずリクエスト自体が飛ばない。絶対パス（`C:/...`）か相対パスで指定する。

### フロントエンド

`node --check assets/js/*.js` で構文確認。

**画面のレイアウトと初期状態はヘッドレス Chrome で確認できる**（カメラは映らないが、
オーバーレイの出しっぱなしや横スクロールなどはこれで見つかる）。

```powershell
$chrome = "C:\Program Files\Google\Chrome\Application\chrome.exe"
& $chrome --headless=new --disable-gpu --no-sandbox --hide-scrollbars `
  --window-size=600,1000 --screenshot="out.png" --virtual-time-budget=20000 `
  "http://127.0.0.1:8080/"
```

- **`--window-size` の幅は 600 以上にすること。** Windows の Chrome には最小ウィンドウ幅が
  あり、430 などを指定しても実際は約500pxでレンダリングされ、
  「横スクロールが出ている」ように見える偽の不具合を踏む
- `--dump-dom` は仮想時間の都合で当てにならなかった。
  計測結果を画面に描画してスクリーンショットで読むほうが確実
- 診断用に一時ファイル（`_diag.html` など）を作ったら、**必ず消してから終わること**

**カメラ動作は実機でしか検証できない。**
カメラに関わる変更をしたら、検証していないことを明示して報告すること。

## 未確定事項

- **備考欄の扱い**: 暫定で `<画像名>.json` に保存（`SERVER.SAVE_META`、現在 false）。
  将来「担当者名」を扱うなら `note` を `operator` に分けるか、CSV追記へ切り替える
- **`storage/` の公開**: built-in server ではブラウザから直接見える。
  公開サーバーへ移す際は DocumentRoot 外に出すこと

## 将来の展望: 対象フォントを学習させて OCR 精度を上げる（2026-09-16 時点・未着手）

対象文字列は `Q A 0-9` の 12 文字（`QA` + 数字16桁）で、フォントも固定。
ホワイトリストで他の文字は既に排除できているが、**Q と 0、A と 4 の取り違え**は
文字の形を学習させないと減らない。実写データが揃っていないため保留中。

進める順番（上から試す）:

1. **Tesseract の学習データを自作する（まずこれ）**
   - PC 上で `tesstrain`（Tesseract 5 の学習ツール、Linux か WSL）で LSTM を追加学習し、
     `xxx.traineddata` を作る。対象フォントの TTF があれば `text2image` で合成、
     無ければ実写の行画像 + `.gt.txt`（数百行）で学習できる
   - 結果は `config` の `OCR.LANG` / `OCR.LANG_PATH` を自前ファイルに向けるだけで差し替わる。
     **画面側の実装は変えない**（`scanner.js` は `createWorker(CONFIG.OCR.LANG, 1, { langPath })`）
   - 12 文字に絞ったモデルは今の約 12MB より大幅に軽くなり、初回読み込みも速くなる
   - 差し替え時は tesseract.js 5.1.1 / core 5.1.0 が読める形式（Tesseract 4/5 の LSTM）で作ること
2. **専用の小型モデルをブラウザで動かす（1 で足りなければ）**
   - 文字種・桁数が固定なので CRNN などの小型モデルを PyTorch で学習 → ONNX に書き出し →
     `onnxruntime-web` で推論。モデル 1MB 未満、スマホで数十ms、Tesseract より速く正確
   - `onnxruntime-web` は CDN の単一 JS で読めるので**ビルド工程なしの制約を満たす**
   - 画面側は「ROI から行を切り出して前処理 → 推論 → 既存の候補フローへ流す」処理を足す。
     Tesseract と並走させ、設定で切り替えられる形にする（`currentSource()` を経由すること）
3. **サーバー側で認識する（最後の手段）**
   - ROI の切り出し JPEG（数十KB）だけ送れば往復+推論で数百ms に収まり、`INTERVAL_MS`（900ms）の
     周期には入る。ただし Python の推論サービスを PHP と並べる運用とトンネル越しの通信に依存する

着手の条件: **対象ラベルの実写 200〜500 枚と、フォント名（分かれば TTF）**。
それまでに効くのは、ROI 内の文字高が 30px 以上になるよう `MAX_SCALE` と枠を調整する、
`?debug=1` で OCR に渡している実画像を見て画質で落ちていないか確かめる、の 2 つ。

`OCR.PSM` は **既定の 6（単一ブロック）のままでよい**。7（単一行）は行検出を省いて
画像全体を 1 行とみなすため、ROI に余白が多い今の構成では文字高の推定が狂って
かえって読めない（現場でも 6 のほうが読めるという実測あり、2026-09-16）。
7 が効くのは ROI の高さを文字高に近づけたときだけで、片手持ちでは現実的でない。

## 拡張時の指針

- 設定で切り替えられるものは `config.php` に追加し、コード中に直書きしない
- 現場での操作数を増やさない。タップ回数が増える変更は慎重に
- ボタンのタップ領域は最低 44px を維持（`.btn { min-height: 44px }`）
- 入力欄の `font-size` は 16px 以上（iOS でフォーカス時に自動ズームされるのを防ぐため）
- 要件になかった機能を足すときは、README の「要件になかったが入れてある補助機能」に
  削除方法とセットで記載する

## 回答スタイル

- 日本語で回答する
- カメラ・OCR まわりは実機検証できないため、「動作確認済み」と「未検証」を必ず区別して報告する
