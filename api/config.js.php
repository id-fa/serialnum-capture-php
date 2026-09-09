<?php
/**
 * config/ の設定を JavaScript として画面側へ配信する。
 *
 * index.php からは通常のスクリプトとして読み込まれる:
 *   <script src="api/config.js.php?p=<プロジェクトID>"></script>
 *
 * 出力されるもの:
 *   window.CONFIG        … 設定の内容（SERVER セクションを除く）
 *                          + PROJECTS（選べるプロジェクトの一覧）
 *   window.OCR_CHARSETS  … OCRモードごとのホワイトリスト文字
 *
 * scanner.js / app.js は window.CONFIG をそのまま参照する。
 */

declare(strict_types=1);

header('Content-Type: application/javascript; charset=UTF-8');
// 設定を変えたらリロードで必ず反映させたいのでキャッシュさせない
header('Cache-Control: no-store, no-cache, must-revalidate');
header('X-Content-Type-Options: nosniff');

require __DIR__ . '/../config/loader.php';

// ?p=PRJ-0002 でプロジェクトを切り替える。
// 不正なIDや未定義のIDは loader 側で既定プロジェクトに落とされる。
$config = inspection_load_config(isset($_GET['p']) ? (string)$_GET['p'] : null);

// サーバー内のパスや上限値を画面側に渡さない
unset($config['SERVER']);

// OCR_CHARSETS は別のグローバルとして出すので CONFIG からは外す
$charsets = $config['OCR_CHARSETS'] ?? [];
unset($config['OCR_CHARSETS']);

// 画面の切り替えUI用に、選べるプロジェクトの一覧を添える
$config['PROJECTS'] = inspection_list_projects();

$flags = JSON_UNESCAPED_UNICODE | JSON_UNESCAPED_SLASHES | JSON_PRETTY_PRINT;

echo "/* 自動生成: config.php から配信しています。直接編集しないでください。 */\n";
echo 'window.CONFIG = ' . json_encode($config, $flags) . ";\n";
echo 'window.OCR_CHARSETS = ' . json_encode($charsets, $flags) . ";\n";

// PATTERN は config.php では文字列で書く（JSONに正規表現リテラルを置けないため）。
// ここで RegExp に変換しておくと、利用側は .test() がそのまま使える。
//
// 設定側は「1本の文字列」でも「文字列の配列」でも書ける。
// 画面側では常に window.CONFIG.OCR.PATTERNS（RegExp の配列）に正規化し、
// 元の OCR.PATTERN は消す（2つの表現が残ると参照側が迷うため）。
// 空配列 = 絞り込みなし。解釈できない式はその1本だけを捨てる。
echo <<<'JS'
(function () {
  var ocr = window.CONFIG.OCR;
  if (!ocr) return;

  var raw = ocr.PATTERN;
  var list;
  if (Array.isArray(raw)) list = raw;
  else if (typeof raw === 'string' && raw !== '') list = [raw];
  else list = [];

  var patterns = [];
  for (var i = 0; i < list.length; i++) {
    var src = list[i];
    if (typeof src !== 'string' || src === '') {
      console.error('[config] OCR.PATTERN に文字列でない要素があります:', src);
      continue;
    }
    try {
      patterns.push(new RegExp(src));
    } catch (e) {
      console.error('[config] OCR.PATTERN が正規表現として解釈できません:', src, e);
    }
  }

  ocr.PATTERNS = patterns;
  delete ocr.PATTERN;
})();

JS;
