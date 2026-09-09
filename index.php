<?php
// URL の ?p=<プロジェクトID> でプロジェクトを切り替える。
// 不正・未定義のIDは loader 側で既定プロジェクトに落とされるので、
// ここで確定したIDだけを設定の配信先に渡す。
require __DIR__ . '/config/loader.php';
$config    = inspection_load_config(isset($_GET['p']) ? (string)$_GET['p'] : null);
$projectId = (string)$config['PROJECT_ID'];
?>
<!DOCTYPE html>
<html lang="ja">
<head>
<meta charset="UTF-8">
<meta name="viewport" content="width=device-width, initial-scale=1.0, viewport-fit=cover, maximum-scale=1.0, user-scalable=no">
<meta name="format-detection" content="telephone=no">
<meta name="theme-color" content="#12161c">
<meta name="mobile-web-app-capable" content="yes">
<meta name="apple-mobile-web-app-capable" content="yes">
<meta name="apple-mobile-web-app-status-bar-style" content="black-translucent">
<title>検品ツール - <?= htmlspecialchars($config['PROJECT_LABEL'], ENT_QUOTES, 'UTF-8') ?></title>
<link rel="stylesheet" href="assets/css/style.css">
</head>
<body>

<header class="app-header">
  <div class="app-title">
    <span class="app-title__main">検品ツール</span>
    <span class="app-title__sub" id="projectLabel">-</span>
    <!-- プロジェクトが2つ以上定義されているときだけ表示される -->
    <select class="project-select" id="projectSelect" hidden aria-label="プロジェクトを切り替え"></select>
  </div>
  <div class="header-status">
    <span class="badge" id="engineBadge">準備中</span>
  </div>
</header>

<main class="app-main">

  <!-- ===== カメラ読み取り部 ===== -->
  <section class="panel panel--camera">
    <div class="camera-stage" id="cameraStage">
      <video id="video" playsinline muted autoplay></video>
      <canvas id="stillCanvas" class="still-canvas" hidden></canvas>

      <!-- 読み取りガイド枠 -->
      <div class="roi-guide is-hidden" id="roiGuide" aria-hidden="true">
        <span class="roi-corner roi-corner--tl"></span>
        <span class="roi-corner roi-corner--tr"></span>
        <span class="roi-corner roi-corner--bl"></span>
        <span class="roi-corner roi-corner--br"></span>
        <span class="roi-scanline" id="roiScanline"></span>
      </div>

      <div class="camera-overlay-top">
        <span class="chip chip--live" id="modeChip">リアルタイム</span>
        <span class="chip" id="ocrChip">OCR</span>
      </div>

      <div class="camera-message" id="cameraMessage" hidden></div>
    </div>

    <div class="camera-actions">
      <button type="button" class="btn btn--ghost" id="torchBtn" hidden>
        <span class="btn__icon">🔦</span><span class="btn__label">ライト</span>
      </button>
      <button type="button" class="shutter" id="shutterBtn" aria-label="シャッター">
        <span class="shutter__ring"></span>
        <span class="shutter__core" id="shutterCore"></span>
      </button>
      <button type="button" class="btn btn--ghost" id="startBtn">
        <span class="btn__icon">▶</span><span class="btn__label">カメラ開始</span>
      </button>
    </div>
  </section>

  <!-- ===== 読み取り文字列表示部 ===== -->
  <section class="panel">
    <div class="panel__head">
      <h2 class="panel__title">読み取り結果</h2>
      <span class="panel__count" id="candidateCount">0</span>
      <button type="button" class="linkbtn" id="clearCandidatesBtn">候補を消す</button>
    </div>
    <p class="panel__hint">タップでスタックに追加します</p>
    <div class="candidate-list" id="candidateList">
      <p class="empty-note" id="candidateEmpty">まだ何も読み取れていません</p>
    </div>
  </section>

  <!-- ===== スタック部 ===== -->
  <section class="panel">
    <div class="panel__head">
      <h2 class="panel__title">スタック</h2>
      <span class="panel__count" id="stackCount">0</span>
      <button type="button" class="linkbtn" id="addManualBtn">手入力で追加</button>
    </div>
    <p class="panel__hint">≡ を長押しドラッグで並び替え（連番は自動で振り直し）</p>
    <ul class="stack-list" id="stackList"></ul>
    <p class="empty-note" id="stackEmpty">スタックは空です</p>
    <div class="filename-preview" id="filenamePreview" hidden>
      <span class="filename-preview__label">保存ファイル名</span>
      <code class="filename-preview__value" id="filenameValue"></code>
    </div>
  </section>


<!-- OCR診断パネル（?debug=1 または CONFIG.DEBUG のときだけ表示） -->
<section class="panel debug-panel" id="debugPanel" hidden>
  <div class="panel__head">
    <h2 class="panel__title">OCR診断</h2>
    <button type="button" class="linkbtn" id="debugCloseBtn">閉じる</button>
  </div>
  <p class="panel__hint">OCRに実際に渡している画像と、その認識結果です</p>
  <div class="debug-shot">
    <canvas id="debugCanvas"></canvas>
  </div>
  <pre class="debug-log" id="debugLog">まだ実行されていません</pre>
</section>

  <!-- ===== 備考欄 ===== -->
  <section class="panel">
    <div class="panel__head">
      <h2 class="panel__title">備考</h2>
    </div>
    <textarea id="noteInput" class="note-input" rows="2"></textarea>
  </section>

</main>

<!-- ===== 送信 / クリア ===== -->
<footer class="app-footer">
  <button type="button" class="btn btn--secondary" id="clearBtn">クリア</button>
  <button type="button" class="btn btn--primary" id="submitBtn" disabled>送信</button>
</footer>

<!-- トースト -->
<div class="toast" id="toast" hidden></div>

<!-- 送信中オーバーレイ -->
<div class="blocker" id="blocker" hidden>
  <div class="blocker__box">
    <div class="spinner"></div>
    <p id="blockerText">送信中...</p>
  </div>
</div>

<script src="https://cdn.jsdelivr.net/npm/tesseract.js@5.1.1/dist/tesseract.min.js"></script>
<script src="https://cdn.jsdelivr.net/npm/@zxing/library@0.21.3/umd/index.min.js"></script>
<!-- 設定はプロジェクトルートの config.php を JavaScript として配信している -->
<script src="api/config.js.php?p=<?= rawurlencode($projectId) ?>"></script>
<script src="assets/js/scanner.js"></script>
<script src="assets/js/stack.js"></script>
<script src="assets/js/app.js"></script>
</body>
</html>
