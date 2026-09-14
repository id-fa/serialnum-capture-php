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
| `config/default.php` | **設定の置き場**（画面側・保存側で共通）。すべてのプロジェクトの土台 |
| `config/<ID>.php` | プロジェクト別の差分。書いた項目だけ default を上書きする |
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
config/<ID>.php ────┴→ loader.php ─┬→ api/config.js.php → window.CONFIG   （画面側）
                                   └→ api/upload.php    → $CONFIG/$FILENAME（保存側）
```

- 共通の値は `config/default.php`、プロジェクト固有の値は `config/<ID>.php` に**差分だけ**書く
- 画面側にだけ必要な値も、保存側にだけ必要な値も、すべてここに書く
- **`SERVER` セクションは画面側に送られない**（`api/config.js.php` が `unset()` する）。
  サーバー内のパスや上限値はここに置くこと
- `FILENAME.ALLOWED_CHARS` / `SEPARATOR` は**両側が同じ値を使う**。
  `app.js` の `sanitizeForFilename()` と `api/upload.php` の `sanitize_token()` は
  どちらもこの設定から正規表現を組み立てるので、ルールがズレることはない

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
  **リスト（`BARCODE.FORMATS` など）は丸ごと置き換え**
- `index.php` の冒頭 PHP は、確定した ID を `api/config.js.php?p=` に渡すためにある。
  ここを消すと、URLで切り替えても設定が既定のままになる
- 画面のセレクトは**プロジェクトが2つ以上定義されているときだけ**表示される。
  1つなら従来どおりのラベル表示（現場の操作数を増やさないため）
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
- `TEXT_FORMAT = 'txt'` には**備考が入らない**（1行1文字列だけ）。備考も残すなら `'json'` にする

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
- ドラッグ中のスクロール量は `window.scrollY` の差分で補正している

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
