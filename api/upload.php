<?php
/**
 * 検品ツール アップロード受け口
 *
 * 受け取るもの (multipart/form-data)
 *   project_id : 保存フォルダ名になるプロジェクトID
 *   strings    : スタック文字列の JSON 配列 (例: ["ABC123","DEF456"])
 *   note       : 備考（任意）
 *   image      : 撮影画像（JPEG）※写真保存なしモードでは受け取らない
 *
 * 保存先（設定の SAVE.MODE で決まる）
 *   'image' : storage/<project_id>/<strings をハイフン連結>.jpg
 *             FILENAME.APPEND_NOTE が有効なら末尾に「_<備考>」が付く
 *   'text'  : storage/<project_id>/<タイムスタンプ>.json （または .txt）
 */

declare(strict_types=1);

// 想定外の警告が HTML として混ざると JSON パースに失敗するため画面出力は止める
ini_set('display_errors', '0');
error_reporting(E_ALL);

header('Content-Type: application/json; charset=UTF-8');
header('Cache-Control: no-store');
header('X-Content-Type-Options: nosniff');

// 設定は config/ に集約されている（画面側と共通）。
// 送られてきた project_id に対応する設定を読み込むので、
// 保存先や上限値もプロジェクトごとに変えられる。
require __DIR__ . '/../config/loader.php';
$ALL      = inspection_load_config(isset($_POST['project_id']) ? (string)$_POST['project_id'] : null);
$CONFIG   = $ALL['SERVER'];
$FILENAME = $ALL['FILENAME'];

// 保存のしかた（画面側と共通の設定）。
//   'image' : 撮影画像を保存する（従来）
//   'text'  : 写真を保存せず、スタック文字列だけをテキストで保存する
$SAVE        = is_array($ALL['SAVE'] ?? null) ? $ALL['SAVE'] : [];
$saveMode    = (($SAVE['MODE'] ?? 'image') === 'text') ? 'text' : 'image';
$textFormat  = (($SAVE['TEXT_FORMAT'] ?? 'json') === 'txt') ? 'txt' : 'json';
$stampFormat = (string)($SAVE['TIMESTAMP_FORMAT'] ?? 'Ymd-His');

/* ------------------------------------------------------------
   ヘルパ
   ------------------------------------------------------------ */

function respond(int $status, array $payload): void
{
    http_response_code($status);
    echo json_encode($payload, JSON_UNESCAPED_UNICODE | JSON_UNESCAPED_SLASHES);
    exit;
}

function fail(int $status, string $message): void
{
    respond($status, ['ok' => false, 'error' => $message]);
}

/**
 * 受け取った文字列を UTF-8 として正規化する。
 * 不正なバイト列が混ざると mb_* が文字を落とすため、先に変換しておく。
 */
function to_utf8(string $s): string
{
    if (mb_check_encoding($s, 'UTF-8')) {
        return $s;
    }
    return mb_convert_encoding($s, 'UTF-8', 'UTF-8,SJIS-win,eucJP-win,ASCII');
}

/**
 * ファイル名/フォルダ名に使える文字だけを残す。
 *
 * 許可文字は config.php の FILENAME.ALLOWED_CHARS から来るので、
 * 画面側のプレビュー（app.js の sanitizeForFilename）と必ず同じ結果になる。
 */
function sanitize_token(string $s, string $allowedChars): string
{
    $s = trim($s);
    $s = preg_replace('/[^' . $allowedChars . ']/u', '', $s) ?? '';
    // 先頭のドットやハイフンは隠しファイル・オプション誤認の元なので落とす
    $s = ltrim($s, '.-');
    return $s;
}

/**
 * 備考をファイル名に付けられる形へ整える（画像モードで FILENAME.APPEND_NOTE のとき）。
 *
 * 備考は日本語を残したいので ALLOWED_CHARS では絞らず、
 * 「Windows でファイル名に使えない文字を除く」規則で整える。
 * 画面側のプレビュー（app.js の sanitizeNoteForFilename）と同じ規則。
 *
 *   1. 前後の空白・改行を取り除く
 *   2. 途中に残った改行（CRLF / CR / LF）を空白1つに置き換える
 *   3. \ / : * ? " < > | と制御文字を除去する
 *      （/ と \ が消えるので、備考でフォルダの外に出ることはできない）
 *   4. 最大文字数で切り詰める
 *   5. 末尾のドットと空白を除去する（Windows が黙って削るため、衝突判定がズレる）
 */
function sanitize_note_for_filename(string $s, int $maxLen): string
{
    $s = preg_replace('/^[\s\p{Z}]+|[\s\p{Z}]+$/u', '', $s) ?? '';
    $s = preg_replace('/\r\n|\r|\n/', ' ', $s) ?? '';
    $s = preg_replace('~[\\\\/:*?"<>|\x00-\x1F\x7F]~u', '', $s) ?? '';
    if ($maxLen > 0) {
        $s = mb_substr($s, 0, $maxLen, 'UTF-8');
    }
    $s = preg_replace('/^[\s\p{Z}]+|[\s\p{Z}.]+$/u', '', $s) ?? '';
    return $s;
}

/**
 * 保存先のパスを決める。同名ファイルがあるときの動作は SERVER.ON_CONFLICT に従う。
 *
 * @return array{0: string, 1: string} [ファイル名, フルパス]
 */
function resolve_save_path(string $dir, string $base, string $ext, string $onConflict): array
{
    $filename = $base . '.' . $ext;
    $path = $dir . DIRECTORY_SEPARATOR . $filename;

    if (!file_exists($path)) {
        return [$filename, $path];
    }

    switch ($onConflict) {
        case 'overwrite':
            return [$filename, $path];

        case 'timestamp':
            $filename = $base . '_' . date('Ymd-His') . '.' . $ext;
            return [$filename, $dir . DIRECTORY_SEPARATOR . $filename];

        case 'suffix':
        default:
            for ($i = 2; $i <= 999; $i++) {
                $candidate = $base . '_' . $i . '.' . $ext;
                $p = $dir . DIRECTORY_SEPARATOR . $candidate;
                if (!file_exists($p)) {
                    return [$candidate, $p];
                }
            }
            fail(409, '同名ファイルが多すぎます: ' . $base);   // ここで終了する
    }
}

/** 予期せぬエラーも JSON で返す */
set_exception_handler(static function (Throwable $e): void {
    fail(500, 'サーバー内部エラー: ' . $e->getMessage());
});
set_error_handler(static function (int $no, string $str, string $file, int $line): bool {
    throw new ErrorException($str, 0, $no, $file, $line);
});

/* ------------------------------------------------------------
   リクエスト検証
   ------------------------------------------------------------ */

if (($_SERVER['REQUEST_METHOD'] ?? '') !== 'POST') {
    fail(405, 'POST でアクセスしてください');
}

// --- プロジェクトID ---
$allowedChars = (string)$FILENAME['ALLOWED_CHARS'];
$projectId = sanitize_token((string)($_POST['project_id'] ?? ''), $allowedChars);
if ($projectId === '') {
    fail(400, 'project_id が不正です');
}
if (!empty($CONFIG['ALLOWED_PROJECT_IDS'])
    && !in_array($projectId, $CONFIG['ALLOWED_PROJECT_IDS'], true)) {
    fail(403, '許可されていない project_id です: ' . $projectId);
}

// --- スタック文字列 ---
$rawStrings = (string)($_POST['strings'] ?? '');
$decoded = json_decode($rawStrings, true);
if (!is_array($decoded)) {
    fail(400, 'strings は JSON 配列で送ってください');
}
if (count($decoded) > (int)$CONFIG['MAX_STRINGS']) {
    fail(400, 'strings が多すぎます（最大 ' . $CONFIG['MAX_STRINGS'] . ' 件）');
}

$strings = [];
foreach ($decoded as $v) {
    if (!is_scalar($v)) {
        continue;
    }
    $t = mb_substr(trim(to_utf8((string)$v)), 0, (int)$CONFIG['MAX_STRING_LENGTH'], 'UTF-8');
    if ($t !== '') {
        $strings[] = $t;
    }
}
if (!$strings) {
    fail(400, 'strings が空です');
}

// --- 画像 ---
// 写真保存なしモードでは画像を受け取らない。画面側も送ってこないが、
// 送られてきた場合も保存しない（どちらのモードで動くかはサーバー側の設定が正）。
$ext  = null;
$file = null;
if ($saveMode === 'image') {
    if (!isset($_FILES['image'])) {
        fail(400, '画像が送信されていません');
    }
    $file = $_FILES['image'];
    if (!is_array($file) || ($file['error'] ?? UPLOAD_ERR_NO_FILE) !== UPLOAD_ERR_OK) {
        fail(400, '画像のアップロードに失敗しました (code: ' . ($file['error'] ?? '?') . ')');
    }
    if (!is_uploaded_file($file['tmp_name'])) {
        fail(400, '不正なアップロードです');
    }
    if ((int)$file['size'] <= 0) {
        fail(400, '画像が空です');
    }
    if ((int)$file['size'] > (int)$CONFIG['MAX_IMAGE_BYTES']) {
        fail(413, '画像サイズが大きすぎます');
    }

    // 拡張子は申告ではなく実データから判定する
    $info = @getimagesize($file['tmp_name']);
    if ($info === false) {
        fail(400, '画像として読み取れません');
    }
    $mime = $info['mime'] ?? '';
    if (!isset($CONFIG['ALLOWED_MIMES'][$mime])) {
        fail(415, '対応していない画像形式です: ' . $mime);
    }
    $ext = $CONFIG['ALLOWED_MIMES'][$mime];
}   // ここまで画像モードだけの検証

// --- 備考 ---
$note = to_utf8((string)($_POST['note'] ?? ''));
$note = mb_substr($note, 0, 1000, 'UTF-8');

/* ------------------------------------------------------------
   保存先の決定
   ------------------------------------------------------------ */

$baseDir = rtrim((string)$CONFIG['STORAGE_DIR'], '/\\');
$dir = $baseDir . DIRECTORY_SEPARATOR . $projectId;

if (!is_dir($dir) && !@mkdir($dir, 0777, true) && !is_dir($dir)) {
    fail(500, '保存フォルダを作成できません: ' . $projectId);
}
if (!is_writable($dir)) {
    fail(500, '保存フォルダに書き込めません: ' . $projectId);
}

$onConflict = (string)$CONFIG['ON_CONFLICT'];

if ($saveMode === 'text') {
    // 写真保存なしモードのファイル名はタイムスタンプ。
    // 書式は設定から来るので、ファイル名に使えない文字は必ず落としておく。
    $base = sanitize_token(date($stampFormat), $allowedChars);
    if ($base === '') {
        $base = date('Ymd-His');
    }
    $ext = $textFormat;

    // 名前がすでにタイムスタンプなので 'timestamp' は連番と同じ扱いにする
    // （同じ日時を二重に付けても区別できない）。
    if ($onConflict === 'timestamp') {
        $onConflict = 'suffix';
    }
} else {
    // スタック文字列を連結してファイル名にする（区切り文字も設定で決まる）
    $parts = array_values(array_filter(
        array_map(static fn($v) => sanitize_token((string)$v, $allowedChars), $strings),
        static fn($s) => $s !== ''
    ));
    $base = implode((string)$FILENAME['SEPARATOR'], $parts);
    if ($base === '') {
        $base = 'noname-' . date('Ymd-His');
    }

    // 備考をファイル名の末尾に付ける（設定で有効なとき・備考が空でないとき）
    if (!empty($FILENAME['APPEND_NOTE'])) {
        $noteToken = sanitize_note_for_filename($note, (int)($FILENAME['NOTE_MAX_LENGTH'] ?? 0));
        if ($noteToken !== '') {
            $base .= (string)($FILENAME['NOTE_SEPARATOR'] ?? '_') . $noteToken;
        }
    }

    // 長すぎる場合は切り詰めて衝突しないようハッシュを付ける。
    // 備考に日本語が入ると1文字が複数バイトになるので、文字の途中で切らないよう mb_strcut を使う
    $maxLen = (int)$FILENAME['MAX_LENGTH'];
    if (strlen($base) > $maxLen) {
        $hash = substr(md5($base), 0, 8);
        $base = rtrim(mb_strcut($base, 0, $maxLen - 9, 'UTF-8'), ' .') . '_' . $hash;
    }
}

[$filename, $path] = resolve_save_path($dir, $base, (string)$ext, $onConflict);

/* ------------------------------------------------------------
   保存（写真保存なしモード）
   スタック文字列だけを <タイムスタンプ>.json / .txt に書き出す。
   ------------------------------------------------------------ */

if ($saveMode === 'text') {
    if ($textFormat === 'txt') {
        // 1行1文字列。メモ帳でそのまま開けるよう改行は CRLF にする。
        // ※ この形式には備考が入らない（備考も残すなら TEXT_FORMAT を 'json' にする）
        $body = implode("\r\n", $strings) . "\r\n";
    } else {
        $body = json_encode([
            'project_id' => $projectId,
            'strings'    => $strings,
            'note'       => $note,
            'created_at' => date('c'),
        ], JSON_UNESCAPED_UNICODE | JSON_PRETTY_PRINT) . "\n";
    }

    if (@file_put_contents($path, $body) === false) {
        fail(500, '文字列の保存に失敗しました');
    }
    @chmod($path, 0666 & ~umask());

    respond(200, [
        'ok'         => true,
        'mode'       => 'text',
        'project_id' => $projectId,
        'filename'   => $filename,
        'path'       => 'storage/' . $projectId . '/' . $filename,
        'strings'    => $strings,
        'bytes'      => filesize($path),
        'saved_meta' => false,
    ]);
}

/* ------------------------------------------------------------
   保存（画像モード）
   ------------------------------------------------------------ */

if (!@move_uploaded_file($file['tmp_name'], $path)) {
    fail(500, '画像の保存に失敗しました');
}
@chmod($path, 0666 & ~umask());

$meta = null;
if (!empty($CONFIG['SAVE_META'])) {
    $meta = [
        'project_id'  => $projectId,
        'strings'     => $strings,
        'note'        => $note,
        'image'       => $filename,
        'created_at'  => date('c'),
    ];
    // pathinfo() はロケール次第で多バイト文字を落とすことがあるので、拡張子を直接外す
    $metaPath = $dir . DIRECTORY_SEPARATOR . substr($filename, 0, -strlen('.' . $ext)) . '.json';
    @file_put_contents(
        $metaPath,
        json_encode($meta, JSON_UNESCAPED_UNICODE | JSON_PRETTY_PRINT)
    );
}

respond(200, [
    'ok'         => true,
    'mode'       => 'image',
    'project_id' => $projectId,
    'filename'   => $filename,
    'path'       => 'storage/' . $projectId . '/' . $filename,
    'strings'    => $strings,
    'bytes'      => filesize($path),
    'saved_meta' => $meta !== null,
]);
