<?php
/**
 * 検品ツール アップロード受け口
 *
 * 受け取るもの (multipart/form-data)
 *   project_id : 保存フォルダ名になるプロジェクトID
 *   strings    : スタック文字列の JSON 配列 (例: ["ABC123","DEF456"])
 *   note       : 備考（任意）
 *   image      : 撮影画像（JPEG）
 *
 * 保存先
 *   storage/<project_id>/<strings をハイフン連結>.jpg
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

// スタック文字列を連結してファイル名にする（区切り文字も config.php で決まる）
$parts = array_values(array_filter(
    array_map(static fn($v) => sanitize_token((string)$v, $allowedChars), $strings),
    static fn($s) => $s !== ''
));
$base = implode((string)$FILENAME['SEPARATOR'], $parts);
if ($base === '') {
    $base = 'noname-' . date('Ymd-His');
}

// 長すぎる場合は切り詰めて衝突しないようハッシュを付ける
$maxLen = (int)$FILENAME['MAX_LENGTH'];
if (strlen($base) > $maxLen) {
    $hash = substr(md5($base), 0, 8);
    $base = substr($base, 0, $maxLen - 9) . '_' . $hash;
}

// 同名ファイルの扱い
$filename = $base . '.' . $ext;
$path = $dir . DIRECTORY_SEPARATOR . $filename;

if (file_exists($path)) {
    switch ($CONFIG['ON_CONFLICT']) {
        case 'overwrite':
            break;

        case 'timestamp':
            $filename = $base . '_' . date('Ymd-His') . '.' . $ext;
            $path = $dir . DIRECTORY_SEPARATOR . $filename;
            break;

        case 'suffix':
        default:
            for ($i = 2; $i <= 999; $i++) {
                $candidate = $base . '_' . $i . '.' . $ext;
                $p = $dir . DIRECTORY_SEPARATOR . $candidate;
                if (!file_exists($p)) {
                    $filename = $candidate;
                    $path = $p;
                    break;
                }
            }
            if (file_exists($path)) {
                fail(409, '同名ファイルが多すぎます: ' . $base);
            }
            break;
    }
}

/* ------------------------------------------------------------
   保存
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
    $metaPath = $dir . DIRECTORY_SEPARATOR . pathinfo($filename, PATHINFO_FILENAME) . '.json';
    @file_put_contents(
        $metaPath,
        json_encode($meta, JSON_UNESCAPED_UNICODE | JSON_PRETTY_PRINT)
    );
}

respond(200, [
    'ok'         => true,
    'project_id' => $projectId,
    'filename'   => $filename,
    'path'       => 'storage/' . $projectId . '/' . $filename,
    'strings'    => $strings,
    'bytes'      => filesize($path),
    'saved_meta' => $meta !== null,
]);
