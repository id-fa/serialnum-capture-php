# 検品用Webアプリ（OCR付き）

スマートフォン（iPhone / Android）のブラウザで動く、OCR・バーコード・QR読み取り付きの検品・証跡保存用ツールです。

- フロント: HTML + JavaScript
- バックエンド: PHPの動くサーバ

![Screenshot](docs/screenshot.png)

---

## 1. ディレクトリ構成

```
serialnum-capture-php/
├── config/                 ★ 設定
│   ├── default.php           共通設定（Git 管理。設置先では触らない）
│   ├── local.php             設置先ごとの差分（Git 管理外。雛形は local.php.sample）
│   ├── PRJ-0001.php          プロジェクト別の差分
│   ├── PRJ-0002.php          プロジェクト別の差分
│   └── loader.php            読み込みの仕組み（編集不要）
├── index.php               メイン画面
├── start-server.bat        開発用サーバー起動（Windows）
├── assets/
│   ├── css/style.css
│   ├── js/scanner.js       カメラ / OCR / バーコード・QR
│   ├── js/stack.js         スタックの保持・並び替え
│   ├── js/app.js           画面制御・送信
│   └── vendor/             （任意）ライブラリをローカルに置く場所
├── api/
│   ├── config.js.php       設定を画面側へ配信（編集不要）
│   └── upload.php          アップロード受け口
└── storage/                保存先（プロジェクトIDごとのフォルダが自動生成）
```

---

## 2. テスト起動

```powershell
# プロジェクトルートで
php -S 0.0.0.0:8080 -t .
```

または `start-server.bat` をダブルクリック。

- PC から: <http://localhost:8080/>
- スマホから: Cloudflare Tunnel 経由（次章参照）

---

## 3. 実機での動作確認 — Cloudflare Tunnel

`getUserMedia`（カメラ）は HTTPS または localhost でしか動きません。
`http://192.168.x.x:8080` に直接アクセスしてもカメラは起動しないため、
Cloudflare Tunnel で HTTPS 化して実機からアクセスします。

### 手順

```powershell
# 1) ローカルサーバーを起動（ターミナル1）
php -S 0.0.0.0:8080 -t .

# 2) トンネルを起動（ターミナル2）
cloudflared tunnel --url http://localhost:8080
```

起動すると次のような URL が表示されるので、これをスマホで開きます。

```
https://xxxx-xxxx-xxxx.trycloudflare.com
```

### cloudflared のインストール

```powershell
winget install --id Cloudflare.cloudflared
# または
scoop install cloudflared
```

### 注意点

- URL は起動のたびに変わります。固定URLが必要なら named tunnel を作成してください
  （`cloudflared tunnel login` → `cloudflared tunnel create <名前>` → DNS レコード紐付け）
- クイックトンネル（`--url`）は インターネットに公開されます。URL を知っていれば誰でもアクセスできるため、
  検証中だけ起動し、終わったら停止してください。
  常用する場合は named tunnel + Cloudflare Access で認証をかけることを推奨します
- `storage/` もトンネル越しに見えます
- 撮影画像が数百KB〜1MB程度あるため、回線が細いと送信に数秒かかります

### 本番運用

Apache / nginx / IIS 配下に置いて通常の HTTPS で公開するか、named tunnel を常時起動してください。
PHP built-in server は HTTPS 非対応・同時接続が弱いため、あくまで開発用です。

---

## 4. 使い方

1. **カメラ開始** を押してカメラを起動
2. 青いガイド枠に文字・バーコードを合わせる（枠の中だけを読み取ります）
3. 読み取れた文字列が「読み取り結果」に並ぶ
4. 使いたい文字列をタップして「スタック」に追加
5. スタックは `≡` をドラッグして並び替え可能
6. **シャッター**を押して静止画を確定（このとき静止画に対して OCR が1回走ります）
   - 静止画の状態でもう一度シャッターを押すとリアルタイムに戻り、撮り直せます
7. 必要なら備考(担当者名等)を入力
8. **送信** → `storage/<プロジェクトID>/<スタック文字列をハイフン連結>.jpg` として保存
9. **クリア** で備考以外を初期状態に戻す

送信ボタンは「スタックが1件以上」かつ「撮影済み」のときだけ有効になります。

### 写真を保存しない運用（写真保存なしモード）

`SAVE.MODE` を `'text'` にすると、写真を保存せず、スタックした文字列だけを保存します。

```php
// config/default.php または config/<プロジェクトID>.php
'SAVE' => [
    'MODE'        => 'text',   // 写真を保存しない
    'TEXT_FORMAT' => 'json',   // 'json' または 'txt'
],
```

- 保存先は `storage/<プロジェクトID>/<タイムスタンプ>.json`（または `.txt`）
- スタックが1件以上あれば送信できます
- カメラ・OCR・バーコード読み取りはそのまま使えるので、読み取りの手順は変わりません
  （シャッターは静止画に対して OCR をかけ直すために残してあります）
- このモードのときは、画面右上に「写真なし」バッジが出ます

---

## 5. 設定

設定はすべて `config/` にまとまっています。

```
config/default.php ─┐
config/local.php ───┼→ ┬→ 画面側（api/config.js.php が JavaScript として配信）
config/<ID>.php ────┘  └→ 保存側（api/upload.php が直接読み込み）
```

- **共通の設定** … `config/default.php`（Git 管理。設置先では書き換えない）
- **設置先ごとの設定** … `config/local.php`（Git 管理外。`default.php` を触らずに土台を上書きする。詳しくは 6 章）
- **プロジェクトごとに変えたい設定** … `config/<プロジェクトID>.php`（詳しくは次章）

重なる順は `default.php` → `local.php` → `<プロジェクトID>.php` で、後のファイルに書いた項目だけが上書きされます。

### 主な設定項目

| 項目 | 説明 |
|---|---|
| `PROJECT_ID` | 送信時のプロジェクトID。保存フォルダ名になる |
| `PROJECT_LABEL` | 画面上部の表示名 |
| `SHOW_IN_SELECT` | `false` にすると、そのファイルが表すプロジェクトを切り替えプルダウンに載せない。`default.php`（`local.php`）に書けば既定プロジェクトだけに効き、**他の `config/<ID>.php` には継承されない**。詳しくは 6 章 |
| `API.UPLOAD_URL` | 送信先。既定は `./api/upload.php` |
| `CAMERA.FACING_MODE` | `environment`（背面）/ `user`（前面） |
| `ROI.*` | 読み取りガイド枠の位置・大きさ。枠を絞るほど高速・高精度。カメラ表示の縦横比（CSS の `.camera-stage`）を変えたら合わせて調整する |
| `OCR.ENABLED` | OCR の有効/無効 |
| `OCR.MODE` | `alnum`（数字+英大文字）/ `numeric`（数字のみ）/ `alnum_mixed` |
| `OCR.EXTRA_CHARS` | MODE に追加で許可する記号。既定 `'-'`（ハイフン）。例: `'-./'` |
| `OCR.INTERVAL_MS` | 認識間隔。端末が重いときは長くする |
| `OCR.MIN_CONFIDENCE` | 信頼度のしきい値。誤検出が多いなら上げる |
| `OCR.MIN_LENGTH` / `MAX_LENGTH` | 採用する文字数の範囲 |
| `OCR.STABLE_COUNT` | 同じ文字列が何回続けて読めたら採用するか。誤検出対策 |
| `OCR.PATTERN` | 追加の絞り込み正規表現。スラッシュで囲まない文字列で書きます。例: `'^\d{4}-\d{4}$'`。`null` で無効。**品番の形が複数あるときは配列で並べます**（例: `['^QA\d{16}$', '^[A-C]{3}-\d{5}$']`）。どれか1本に一致すれば採用 |
| `BARCODE.ENABLED` | 1次元バーコード読み取りの有効/無効 |
| `BARCODE.FORMATS` | CODE_128 / CODE_39 / EAN_13 など |
| `QR.ENABLED` | QRコード読み取りの有効/無効 |
| `SAVE.MODE` | `image`（既定・撮影画像を保存）/ `text`（写真を保存せず文字列だけ保存） |
| `SAVE.TEXT_FORMAT` | `MODE = 'text'` のときの形式。`json`（備考も残る）/ `txt`（1行1文字列） |
| `SAVE.TIMESTAMP_FORMAT` | `MODE = 'text'` のときのファイル名。PHP の `date()` 書式。既定 `Ymd-His` |
| `SAVE.TIMEZONE` | 保存側で日時を作るタイムゾーン（`TIMESTAMP_FORMAT` のファイル名・同名時の日時サフィックス・`created_at`）。既定 `Asia/Tokyo`。php.ini の `date.timezone` に関係なくこの値で作る。無効な値なら `Asia/Tokyo` |
| `CAPTURE.CROP_TO_VIEW` | `true`（既定）でカメラ読み取り部に写っている範囲だけを保存。`false` で映像全体 |
| `CAPTURE.MAX_EDGE` / `JPEG_QUALITY` | 送信する画像のサイズ・画質 |
| `UI.VIBRATE_MS` / `UI.BEEP` | 検出時のバイブ・ビープ |
| `UI.AUTO_CLEAR_AFTER_SAVE` | `true`（既定）で、送信完了トーストをタップして閉じたときに確認なしでスタックと読み取り結果をクリア（備考は残る）。`false` で手動クリアのみ |
| `UI.KEEP_NOTE` | `true`（既定）で、備考欄の内容をタブ内に保持し、ページの再読み込み後に復元する（タブを閉じれば消える）。`false` で再読み込みのたびに空に戻る |
| `DEBUG` | コンソールに詳細ログを出す |

#### `OCR.PATTERN` を複数登録する

品番の形が複数あるときは、配列形式にします。

```php
'OCR' => [
    'PATTERN' => [
        '^QA\d{16}$',        // QA + 数字16桁
        '^[A-C]{3}-\d{5}$',  // A〜C の3文字 + ハイフン + 数字5桁
    ],
],
```

誤った設定例：

```
^QA\d{16}|[A-C]{3}-\d{5}$
```

は `^QA\d{16}` または `[A-C]{3}-\d{5}$` と解釈され、それぞれ片側にしかアンカーが掛かりません。
結果として `TYPEAAA-12345` のように前後にゴミが付いた文字列まで通ってしまいます。

1本の式でやるならこうなります。

```
^(?:QA\d{16}|[A-C]{3}-\d{5})$
```


### ファイル名の作り方: `FILENAME`

| 項目 | 説明 |
|---|---|
| `ALLOWED_CHARS` | ファイル名に使える文字。既定 `0-9A-Za-z._-`。これ以外は除去されます |
| `SEPARATOR` | スタック文字列をつなぐ区切り文字。既定 `-` |
| `MAX_LENGTH` | ファイル名の最大長（バイト数）。超過時は切り詰め + ハッシュ付与 |
| `APPEND_NOTE` | `true`（既定）で、画像モードのファイル名の末尾に備考欄の内容を付ける。備考が空なら何も付かない |
| `NOTE_SEPARATOR` | スタック文字列と備考の間の区切り。既定 `_`（備考にハイフンが入ることがあるため `SEPARATOR` とは別） |
| `NOTE_MAX_LENGTH` | ファイル名に含める備考の最大文字数。既定 50。0 で無制限 |

#### 備考をファイル名に付ける（画像モード）

`SAVE.MODE = 'image'` のとき、備考欄に入力した内容がファイル名の末尾に付きます。

```
スタック: AB123, CD456  /  備考: 山田 太郎   →  AB123-CD456_山田 太郎.jpg
```

備考は日本語を残すため `ALLOWED_CHARS` では絞らず、次の規則で整えます
（画面のファイル名プレビューにも同じ規則で反映されます）。

- Windows でファイル名に使えない文字 `\ / : * ? " < > |` と制御文字を除去
- 前後の空白・改行を取り除き、途中に残った改行は空白1つに置き換え
- 末尾のドット・空白を除去
- `NOTE_MAX_LENGTH` 文字を超えた分は切り捨て

写真保存なしモード（`SAVE.MODE = 'text'`）では従来どおりファイル名はタイムスタンプで、備考は JSON の中に入ります。

### サーバー専用: `SERVER`

| 項目 | 説明 |
|---|---|
| `STORAGE_DIR` | 保存ルート |
| `ALLOWED_PROJECT_IDS` | 許可するプロジェクトID。空配列なら制限なし。指定すると送信の受け付けと切り替えプルダウンの両方がこのIDに絞られる |
| `ON_CONFLICT` | 同名時の動作 `suffix`（`_2`,`_3`…） / `timestamp` / `overwrite` |
| `SAVE_META` | 備考などを `<画像名>.json` に保存するか |
| `MAX_IMAGE_BYTES` | 画像サイズ上限 |
| `MAX_STRINGS` / `MAX_STRING_LENGTH` | スタック文字列の件数・長さ上限 |

---

## 6. 複数プロジェクトを使い分ける

現場やラインごとに設定を変えたい場合は、`config/<プロジェクトID>.php` を作るだけです。

### 追加のしかた

`config/PRJ-0003.php` を作り、変えたい項目だけ書きます。

```php
<?php
return [
    'PROJECT_LABEL' => '第3ライン',

    'OCR' => [
        'MODE'    => 'numeric',      // このラインは数字だけ
        'PATTERN' => '^\d{8}$',      // 8桁固定
    ],
];
```

書かなかった項目は `config/default.php` の値がそのまま使われます。
これだけで `storage/PRJ-0003/` に保存されるようになります。

### 切り替え方

**URL で指定する**

```
https://xxxx.trycloudflare.com/?p=PRJ-0003
```

端末ごとに違うプロジェクトを使うなら、この URL をホーム画面に追加しておくのが確実です。

**画面で選ぶ**

プロジェクトが2つ以上あると、ヘッダーのプロジェクト名が自動的にセレクトに変わります。
選ぶとそのプロジェクトに切り替わります（設定を読み直すため画面が再読み込みされます。
スタックや撮影内容がある場合は確認が出ます）。

プロジェクトが1つだけのときはセレクトは出ず、これまでどおりのラベル表示です。

**プルダウンに載せない**

`config/<ID>.php` に `'SHOW_IN_SELECT' => false` を書くと、そのプロジェクトはプルダウンに出なくなります
（URL の `?p=<ID>` では引き続き開けます）。

既定プロジェクト（`default.php` の `PROJECT_ID`）を載せたくないときは、`default.php` か `local.php` に
`'SHOW_IN_SELECT' => false` を書きます。**この項目は書いたファイルの分にしか効かず、他の
`config/<ID>.php` には継承されません**（土台で `false` にしても各プロジェクトは消えません）。

隠したプロジェクトを開いているときだけは、現在地が分かるようにプルダウンの先頭に表示されます。

### 上書きのルール

| 書き方 | 動作 |
|---|---|
| `'OCR' => ['MODE' => 'numeric']` | `MODE` だけ上書き。`MIN_CONFIDENCE` などは default のまま |
| `'BARCODE' => ['FORMATS' => [...]]` | **配列は丸ごと置き換え**。一部だけ追加はできません |
| 項目を書かない | default の値をそのまま使う |

### 注意点

- プロジェクトIDは設定ファイル名と保存フォルダ名になります。使える文字は英数字と `. _ -` です
- `default` `local` `loader` はプロジェクトIDに使えません（仕組みのファイル名のため）
- 存在しないIDを指定しても既定プロジェクトで動きます（エラーにはなりません）。
- 特定のプロジェクトだけを許可したい場合は、`config/local.php` の
  `SERVER.ALLOWED_PROJECT_IDS` にIDを並べてください（プルダウンもそのIDだけになります）

### default.php を触らずに設定する（`config/local.php`）

設置先で「既定プロジェクトを変えたい」「上限値を変えたい」といった土台の変更が必要なときは、
`default.php` を編集せずに `config/local.php` を作ります。`local.php` は Git 管理外（`.gitignore` 済み）なので、
`git pull` で `default.php` が更新されても競合しません。雛形は `config/local.php.sample` です。

```php
<?php
// config/local.php
return [
    'PROJECT_ID'     => 'ZOE_TAB_1',   // 何も指定せずに開いたときのプロジェクト
    'SHOW_IN_SELECT' => false,         // 既定プロジェクトをプルダウンに載せない
    'SERVER' => [
        'ALLOWED_PROJECT_IDS' => ['ZOE_TAB_1', 'ZOE_TAB_2'],
    ],
];
```

`local.php` は `default.php` と同じ「土台」の扱いなので、ここに書いた項目はすべての
`config/<ID>.php` の土台になります（`SHOW_IN_SELECT` だけは例外で、既定プロジェクトの表示可否にしか効きません）。

---

## 7. OCR の精度を上げるコツ

- ガイド枠を対象の大きさに合わせる（`ROI.WIDTH` / `HEIGHT`）
- 対象を画面いっぱいに近づける。文字が小さいと読めません
- `OCR.MODE` を `numeric` にできる現場なら、そのほうが圧倒的に安定します
- 桁数が決まっているなら `OCR.MIN_LENGTH` / `MAX_LENGTH` / `PATTERN` を固定する
- 品番の形が2種類以上あるときは、`PATTERN` を**配列で並べる**（1本の式に `|` で詰め込まない。理由は下記）
- 誤検出が多い → `MIN_CONFIDENCE` と `STABLE_COUNT` を上げる
- 反応が遅い → `INTERVAL_MS` を上げる、`ROI` を小さくする

なお、バーコード/QR が使える現場なら OCR より圧倒的に速く確実です。
`BARCODE.ENABLED` / `QR.ENABLED` を活かしたうえで、OCR は補助として使う運用を推奨します。

---

## 8. OCRが読み取れないときの調べ方

URL の末尾に **`?debug=1`** を付けてアクセスすると、画面下部に「OCR診断」パネルが出ます。

```
https://xxxx.trycloudflare.com/?debug=1
```

パネルには OCRに実際に渡している画像そのものと、その認識結果が表示されます。

| パネルの状態 | 原因 | 対処 |
|---|---|---|
| 画像が真っ黒／目的の文字が写っていない | ガイド枠と実際の切り出し位置がずれている | `ROI` の値を調整。`ROI.ENABLED: false` にすると画面全体を読むので切り分けになる |
| 画像に文字は写っているが小さい | 文字の解像度不足 | 対象に近づく。`ROI` を小さくする。`OCR.TARGET_HEIGHT` を上げる |
| 「文字が1つも認識されていません」 | 文字が小さい／ぼけ／低コントラスト | 近づく、ライトを使う、`ROI` を絞る |
| `NG ... 信頼度42 <- 信頼度42` と出る | 信頼度のしきい値で落ちている | `OCR.MIN_CONFIDENCE` を下げる |
| `信頼度?` と表示される | 端末が信頼度を返していない（iPhoneで発生）。この場合は信頼度で落とさない仕様 | 対処不要 |
| `NG ... (短い)` | 文字数フィルタで落ちている | `OCR.MIN_LENGTH` を下げる |
| `NG ... (許可外文字)` | 英小文字などが混じっている | `OCR.MODE` を `alnum_mixed` にする |
| `NG ... (安定待ち)` | 連続一致の要求で落ちている | `OCR.STABLE_COUNT` を `1` にする |
| ヘッダーに「OCRエラー」と出る | OCR実行時に例外が発生 | トーストのメッセージとブラウザのコンソールを確認 |

### よくある原因

1. **文字が小さすぎる** — 最も多い原因です。OCR は文字の高さが 30px 程度ないと読めません。
   バーコードよりかなり近づく必要があります
2. **フィルタが厳しい** — `MIN_CONFIDENCE` / `STABLE_COUNT` を緩めると改善します
3. **ガイド枠から外れている** — 枠内に文字全体が入っている必要があります

### 切り分けのコツ

バーコード/QR は画面全体を走査しますが、OCR はガイド枠の中だけを見ます。
「バーコードは読めるのに文字だけ読めない」場合、まず `ROI.ENABLED: false` にして
画面全体をOCR対象にしてみてください。これで読めるなら枠の設定が原因です。

---

## 9. オフライン（CDNが使えない環境）で動かす

既定では以下を CDN から読み込んでいます。

- `tesseract.js@5.1.1`（OCR）
- `@zxing/library@0.21.3`（バーコード / QR）
- `tesseract.js-core@5.1.0`（wasm）
- `eng.traineddata`（学習データ・約12MB）

社内ネットワークで CDN が塞がれている場合は、次のようにローカル化してください。

1. 上記ファイルを `assets/vendor/` に配置
2. `index.html` の 2つの `<script src="...">` をローカルパスに変更
3. `config.php` の `OCR.WORKER_PATH` / `CORE_PATH` / `LANG_PATH` をローカルパスに変更
   （`LANG_PATH` は `eng.traineddata.gz` を置いたディレクトリを指定）

初回アクセス時に約 17MB のダウンロードが発生します。以降はブラウザキャッシュに乗りますが、
現場で使う前に一度 Wi-Fi 環境で読み込ませておくと安心です。

---

## 10. 保存されるもの

```
storage/
└── PRJ-0001/
    ├── AB123-CD456-EF789.jpg           撮影画像（スタック文字列をハイフン連結）
    ├── AB123-CD456-EF789_山田.jpg      備考「山田」を入力したとき（FILENAME.APPEND_NOTE = true）
    └── AB123-CD456-EF789.json          備考などのメタ情報（SERVER.SAVE_META = true のとき）
```

`*.json` の中身:

```json
{
  "project_id": "PRJ-0001",
  "strings": ["AB123", "CD456", "EF789"],
  "note": "検品担当：山田",
  "image": "AB123-CD456-EF789.jpg",
  "created_at": "2026-09-09T10:39:00+09:00"
}
```

### 写真保存なしモード（`SAVE.MODE = 'text'`）

写真は保存されず、スタックした文字列だけがタイムスタンプ名のファイルになります。

```
storage/
└── PRJ-0001/
    ├── 20260910-140019.json     TEXT_FORMAT = 'json' のとき
    └── 20260910-140032.txt      TEXT_FORMAT = 'txt' のとき
```

`*.json` の中身:

```json
{
  "project_id": "PRJ-0001",
  "strings": ["AB123", "CD456"],
  "note": "検品担当：山田",
  "created_at": "2026-09-10T14:00:19+09:00"
}
```

`*.txt` の中身（1行1文字列。**備考は保存されません**）:

```
AB123
CD456
```

同じ秒に続けて送信した場合は `20260910-140025_2.json` のように連番が付きます。

---

## 11. 未確定・今後の検討事項

- **備考欄の扱い**: 仕様未確定のため、暫定で `<画像名>.json` に保存しています。
  不要なら `config.php` の `SERVER.SAVE_META` を `false` にすれば JSON は作られません。
- **`storage/` の公開**: PHP built-in server ではブラウザから `storage/` が直接見えます。
  保存済み画像の確認には便利ですが、Cloudflare Tunnel を張っている間は外部からも見えます。
  常用する場合は DocumentRoot の外に出すか、named tunnel + Cloudflare Access で認証をかけてください。

### 補助機能

- **「手入力で追加」ボタン**（スタック部）: OCR がどうしても読めないときの逃げ道。
  削除する場合は `index.html` の `addManualBtn` と `app.js` の該当リスナーを消してください。
- **ライトボタン**: 端末がトーチ対応の場合のみ表示されます。
- **検出時のビープ / バイブ**: `config.php` の `UI.BEEP` / `UI.VIBRATE_MS` でオフにできます。
- **送信完了トーストを閉じたら自動クリア**: 「保存しました」のトーストはタップするまで消えず、
  閉じると確認なしでクリアされます。`UI.AUTO_CLEAR_AFTER_SAVE` を `false` にすると閉じるだけになります。
- **備考欄の再読み込み後の復元**: iPhone ではスリープ中にタブが破棄され、復帰時にページが
  読み直されて備考が消えることがあります。備考を `sessionStorage` に持っておき、再読み込み後に
  戻します（タブを閉じれば消えるので、別の担当者には持ち越しません）。
  `UI.KEEP_NOTE` を `false` にするとオフになります。

---

