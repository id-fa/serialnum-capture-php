/* ============================================================
   app.js
   画面全体の制御（候補リスト / 送信 / クリア / 各種UI）
   ============================================================ */

(function () {
  'use strict';

  /* ---------- DOM ---------- */
  const $ = (id) => document.getElementById(id);

  const el = {
    projectLabel: $('projectLabel'),
    projectSelect: $('projectSelect'),
    engineBadge: $('engineBadge'),
    saveModeBadge: $('saveModeBadge'),

    stage: $('cameraStage'),
    video: $('video'),
    stillCanvas: $('stillCanvas'),
    roiGuide: $('roiGuide'),
    modeChip: $('modeChip'),
    ocrChip: $('ocrChip'),
    cameraMessage: $('cameraMessage'),

    startBtn: $('startBtn'),
    shutterBtn: $('shutterBtn'),
    torchBtn: $('torchBtn'),
    zoomBtn: $('zoomBtn'),
    switchCamBtn: $('switchCamBtn'),

    candidateList: $('candidateList'),
    candidateEmpty: $('candidateEmpty'),
    candidateCount: $('candidateCount'),
    clearCandidatesBtn: $('clearCandidatesBtn'),
    stackAllBtn: $('stackAllBtn'),

    stackList: $('stackList'),
    stackEmpty: $('stackEmpty'),
    stackCount: $('stackCount'),
    addManualBtn: $('addManualBtn'),
    filenamePreview: $('filenamePreview'),
    filenameLabel: $('filenameLabel'),
    filenameValue: $('filenameValue'),

    noteInput: $('noteInput'),
    clearBtn: $('clearBtn'),
    submitBtn: $('submitBtn'),

    debugPanel: $('debugPanel'),
    debugCanvas: $('debugCanvas'),
    debugLog: $('debugLog'),
    debugCloseBtn: $('debugCloseBtn'),

    toast: $('toast'),
    blocker: $('blocker'),
    blockerText: $('blockerText'),
  };

  /* ---------- 状態 ---------- */
  const state = {
    candidates: new Map(), // text -> { text, source }
    cameraOn: false,
    captured: false,
    sending: false,
  };

  /* ---------- 保存のしかた（config の SAVE） ----------
     'image' … 従来どおり撮影画像を保存する
     'text'  … 写真保存なしモード。撮影せずに送信でき、
               スタック文字列だけが <タイムスタンプ>.json / .txt に保存される。
               カメラ・OCR はそのまま使えるので、読み取りの手順は変わらない。 */
  const SAVE = CONFIG.SAVE || {};
  const TEXT_ONLY = SAVE.MODE === 'text';
  const TEXT_EXT = SAVE.TEXT_FORMAT === 'txt' ? 'txt' : 'json';

  let scanner = null;
  let stack = null;
  let toastTimer = null;
  let audioCtx = null;
  // プロジェクト切り替えなど、こちらの意図で画面を離れるときに立てる
  let leavingIntentionally = false;

  /* ============================================================
     ユーティリティ
     ============================================================ */

  /** sticky トーストをタップで閉じたときに呼ぶ処理（次のトーストが出たら破棄） */
  let toastOnClose = null;

  /**
   * トースト表示。
   * @param {string} message
   * @param {'ok'|'error'|undefined} kind
   * @param {{sticky?: boolean, hint?: string, onClose?: Function}} [opts]
   *   sticky: true なら自動で消えず、タップで閉じる（送信完了の通知に使う。次のトーストが出れば置き換わる）
   *   hint: sticky のとき本文の下に出す案内（既定「タップで閉じる」）
   *   onClose: sticky をタップで閉じたときに呼ぶ。別のトーストに置き換わった場合は呼ばれない
   */
  function toast(message, kind, opts) {
    clearTimeout(toastTimer);
    toastOnClose = null;
    const sticky = !!(opts && opts.sticky);
    el.toast.textContent = message;
    el.toast.className = 'toast' + (kind ? ' is-' + kind : '') + (sticky ? ' is-sticky' : '');
    el.toast.dataset.hint = (opts && opts.hint) || 'タップで閉じる';
    el.toast.hidden = false;
    if (sticky) {
      toastOnClose = (opts && opts.onClose) || null;
      return;
    }
    toastTimer = setTimeout(() => {
      el.toast.hidden = true;
    }, kind === 'error' ? 4000 : 2200);
  }

  // タップで閉じる（sticky 以外も閉じられる）
  el.toast.addEventListener('click', () => {
    clearTimeout(toastTimer);
    el.toast.hidden = true;
    const fn = toastOnClose;
    toastOnClose = null;
    if (fn) fn();
  });

  function setBadge(text, kind) {
    el.engineBadge.textContent = text;
    el.engineBadge.className = 'badge' + (kind ? ' is-' + kind : '');
  }

  function showCameraMessage(text) {
    if (!text) {
      el.cameraMessage.hidden = true;
      el.cameraMessage.textContent = '';
      return;
    }
    el.cameraMessage.textContent = text;
    el.cameraMessage.hidden = false;
  }

  function block(text) {
    el.blockerText.textContent = text || '処理中...';
    el.blocker.hidden = false;
  }
  function unblock() {
    el.blocker.hidden = true;
  }

  function feedback() {
    if (CONFIG.UI.VIBRATE_MS && navigator.vibrate) {
      try { navigator.vibrate(CONFIG.UI.VIBRATE_MS); } catch (e) { /* noop */ }
    }
    if (CONFIG.UI.BEEP) beep();
  }

  /** 短いビープ音（検出フィードバック用） */
  function beep() {
    try {
      const Ctx = window.AudioContext || window.webkitAudioContext;
      if (!Ctx) return;
      if (!audioCtx) audioCtx = new Ctx();
      if (audioCtx.state === 'suspended') audioCtx.resume();
      const osc = audioCtx.createOscillator();
      const gain = audioCtx.createGain();
      osc.type = 'sine';
      osc.frequency.value = 1180;
      gain.gain.setValueAtTime(0.0001, audioCtx.currentTime);
      gain.gain.exponentialRampToValueAtTime(0.12, audioCtx.currentTime + 0.01);
      gain.gain.exponentialRampToValueAtTime(0.0001, audioCtx.currentTime + 0.09);
      osc.connect(gain).connect(audioCtx.destination);
      osc.start();
      osc.stop(audioCtx.currentTime + 0.1);
    } catch (e) {
      /* 音が出せない環境は無視 */
    }
  }

  /**
   * ファイル名に使える形へ整える。
   *
   * 許可文字は config.php の FILENAME.ALLOWED_CHARS から来るため、
   * 保存側（api/upload.php の sanitize_token）と必ず同じ結果になる。
   */
  const FILENAME_NG = new RegExp('[^' + CONFIG.FILENAME.ALLOWED_CHARS + ']', 'g');

  function sanitizeForFilename(s) {
    return String(s)
      .trim()
      .replace(FILENAME_NG, '')
      .replace(/^[.-]+/, '');
  }

  /**
   * 備考をファイル名に付けられる形へ整える（FILENAME.APPEND_NOTE のとき。両モード共通）。
   *
   * 備考は日本語を残したいので ALLOWED_CHARS では絞らず、
   * 「Windows でファイル名に使えない文字を除く」規則で整える。
   * 保存側（api/upload.php の sanitize_note_for_filename）と同じ手順:
   *   1. 前後の空白・改行を取り除く
   *   2. 途中に残った改行（CRLF / CR / LF）を空白1つに置き換える
   *   3. \ / : * ? " < > | と制御文字を除去する
   *   4. NOTE_MAX_LENGTH 文字で切り詰める
   *   5. 末尾のドットと空白を除去する（Windows が黙って削る文字のため）
   */
  const NOTE_NG = /[\\/:*?"<>|\x00-\x1F\x7F]/g;
  const NOTE_EDGE_SPACE = /^[\s\p{Z}]+|[\s\p{Z}]+$/gu;
  const NOTE_TAIL = /^[\s\p{Z}]+|[\s\p{Z}.]+$/gu;

  function sanitizeNoteForFilename(s) {
    const max = Number(CONFIG.FILENAME.NOTE_MAX_LENGTH) || 0;
    let t = String(s)
      .replace(NOTE_EDGE_SPACE, '')
      .replace(/\r\n|\r|\n/g, ' ')
      .replace(NOTE_NG, '');
    if (max > 0) t = Array.from(t).slice(0, max).join('');
    return t.replace(NOTE_TAIL, '');
  }

  /** 備考をファイル名の末尾に付ける（APPEND_NOTE が有効で備考が空でないとき）。両モード共通 */
  function appendNoteToBaseName(name) {
    if (!CONFIG.FILENAME.APPEND_NOTE) return name;
    const note = sanitizeNoteForFilename(el.noteInput.value || '');
    if (!note) return name;
    return name + (CONFIG.FILENAME.NOTE_SEPARATOR ?? '_') + note;
  }

  /** 画像モードで保存されるファイル名（拡張子なし）。保存側と同じ組み立て */
  function buildImageBaseName(texts) {
    const name = texts
      .map(sanitizeForFilename)
      .filter(Boolean)
      .join(CONFIG.FILENAME.SEPARATOR) || 'noname';
    return appendNoteToBaseName(name);
  }

  /* ============================================================
     候補リスト（読み取り文字列表示部）
     ============================================================ */

  const SRC_LABEL = { ocr: 'OCR', barcode: 'BAR', qr: 'QR' };
  const SRC_CLASS = { ocr: 'ocr', barcode: 'bar', qr: 'qr' };

  function addCandidate(text, source) {
    if (state.candidates.has(text)) return false;
    state.candidates.set(text, { text, source });

    // 上限を超えたら古いものから削除
    while (state.candidates.size > CONFIG.UI.MAX_CANDIDATES) {
      const oldest = state.candidates.keys().next().value;
      state.candidates.delete(oldest);
    }
    renderCandidates();
    feedback();
    return true;
  }

  function renderCandidates() {
    el.candidateCount.textContent = String(state.candidates.size);
    el.candidateList.innerHTML = '';

    if (state.candidates.size === 0) {
      el.candidateList.appendChild(el.candidateEmpty);
      el.candidateEmpty.hidden = false;
      return;
    }
    el.candidateEmpty.hidden = true;

    const frag = document.createDocumentFragment();
    // 新しく読み取れたものを上（先頭）に出す
    const list = Array.from(state.candidates.values()).reverse();

    for (const c of list) {
      // チップ本体（タップでスタックへ）と ✕（候補から消す）の 2 ボタン構成。
      // button の入れ子は不正なので、外側は div にしている
      const chip = document.createElement('div');
      chip.className = 'candidate' + (stack.has(c.text) ? ' is-stacked' : '');
      chip.dataset.text = c.text;

      const addBtn = document.createElement('button');
      addBtn.type = 'button';
      addBtn.className = 'candidate__add';
      addBtn.dataset.action = 'add';
      addBtn.setAttribute('aria-label', c.text + ' をスタックに追加');

      const src = document.createElement('span');
      src.className = 'candidate__src candidate__src--' + (SRC_CLASS[c.source] || 'ocr');
      src.textContent = SRC_LABEL[c.source] || 'OCR';

      const label = document.createElement('span');
      label.className = 'candidate__text';
      label.textContent = c.text;

      addBtn.append(src, label);

      const del = document.createElement('button');
      del.type = 'button';
      del.className = 'candidate__del';
      del.dataset.action = 'remove';
      del.textContent = '✕';
      del.setAttribute('aria-label', c.text + ' を候補から消す');

      chip.append(addBtn, del);
      frag.appendChild(chip);
    }
    el.candidateList.appendChild(frag);
  }

  /**
   * 候補を 1 件だけ消す。
   * scanner.emitted は残す（誤読を消した直後に同じ文字列が再検出されて
   * 戻ってくるのを防ぐため）。読み直したいときは「リセット」で全部消す。
   */
  function removeCandidate(text) {
    if (!state.candidates.delete(text)) return;
    renderCandidates();
  }

  el.candidateList.addEventListener('click', (e) => {
    const btn = e.target.closest('[data-action]');
    if (!btn) return;
    const chip = btn.closest('.candidate');
    if (!chip) return;
    const text = chip.dataset.text;

    if (btn.dataset.action === 'remove') {
      removeCandidate(text);
      return;
    }
    const res = stack.add(text);
    if (res === 'duplicated') {
      toast('すでにスタックにあります');
    } else {
      renderCandidates();
    }
  });

  // 候補を認識順（古いものから）でまとめてスタックへ。
  // 画面の並びは新しいものが上だが、state.candidates の挿入順が認識順なのでそのまま使う。
  // スタック済みのものは飛ばす（stack.addMany が重複を捨てる）
  el.stackAllBtn.addEventListener('click', () => {
    const texts = Array.from(state.candidates.keys());
    if (!texts.length) {
      toast('候補がありません');
      return;
    }
    const added = stack.addMany(texts);
    if (added === 0) {
      toast('すべてスタック済みです');
    } else {
      toast(added + '件をスタックに移しました');
      renderCandidates();
    }
  });

  el.clearCandidatesBtn.addEventListener('click', () => {
    state.candidates.clear();
    if (scanner) scanner.resetDetections();
    renderCandidates();
  });

  /* ============================================================
     スタック部
     ============================================================ */

  /** 保存ファイル名のプレビューを描き直す（スタック・備考が変わるたびに呼ぶ） */
  function updateFilenamePreview() {
    const texts = stack ? stack.getTexts() : [];
    if (!texts.length) {
      el.filenamePreview.hidden = true;
      return;
    }
    if (TEXT_ONLY) {
      // 写真保存なしモードのファイル名は送信時のタイムスタンプ（サーバー側で決まる）。
      // 備考は画像モードと同じ規則で末尾に付く
      el.filenameValue.textContent = appendNoteToBaseName('<送信時刻>') + '.' + TEXT_EXT;
    } else {
      el.filenameValue.textContent = buildImageBaseName(texts) + '.jpg';
    }
    el.filenamePreview.hidden = false;
  }

  function onStackChange(texts) {
    el.stackCount.textContent = String(texts.length);
    el.stackEmpty.hidden = texts.length > 0;
    updateFilenamePreview();
    renderCandidates();
    updateSubmitState();
  }

  // 画像モードでは備考もファイル名に入るので、入力のたびにプレビューへ反映する
  el.noteInput.addEventListener('input', updateFilenamePreview);

  /* ---------- 備考の保持（UI.KEEP_NOTE） ----------
     iPhone ではスリープ中にタブが破棄され、復帰時にページが読み直されることがある。
     そのとき備考が空に戻るのを防ぐため、sessionStorage に持っておく。
     sessionStorage はタブを閉じれば消えるので、別の担当者には持ち越さない。
     Safari のプライベートモードなどでは例外を投げるので、すべて try で包む。 */
  const NOTE_STORAGE_KEY = 'inspection.note';
  const keepNote = !!(CONFIG.UI && CONFIG.UI.KEEP_NOTE);

  function restoreNote() {
    if (!keepNote) return;
    try {
      const v = window.sessionStorage.getItem(NOTE_STORAGE_KEY);
      if (v) el.noteInput.value = v;
    } catch (e) { /* 使えない環境では何もしない */ }
  }

  function persistNote() {
    if (!keepNote) return;
    try {
      const v = el.noteInput.value;
      if (v) window.sessionStorage.setItem(NOTE_STORAGE_KEY, v);
      else window.sessionStorage.removeItem(NOTE_STORAGE_KEY);
    } catch (e) { /* 使えない環境では何もしない */ }
  }

  el.noteInput.addEventListener('input', persistNote);

  el.addManualBtn.addEventListener('click', () => {
    const v = window.prompt('スタックに追加する文字列を入力');
    if (v === null) return;
    const t = String(v).trim();
    if (!t) return;
    if (stack.add(t) === 'duplicated') toast('すでにスタックにあります');
  });

  /* ============================================================
     カメラ操作
     ============================================================ */

  function updateModeChip() {
    // ズーム / カメラ切替は静止画のあいだは使えない（切り替えると撮影内容が消える）
    const stageBtnOff = !state.cameraOn || state.captured;
    el.zoomBtn.disabled = stageBtnOff;
    el.switchCamBtn.disabled = stageBtnOff;

    if (!state.cameraOn) {
      el.modeChip.className = 'chip';
      el.modeChip.textContent = '停止中';
      return;
    }
    if (state.captured) {
      el.modeChip.className = 'chip chip--still';
      el.modeChip.textContent = '静止画';
    } else {
      el.modeChip.className = 'chip chip--live';
      el.modeChip.textContent = 'リアルタイム';
    }
  }

  function updateOcrChip() {
    const parts = [];
    if (CONFIG.OCR.ENABLED) parts.push(CONFIG.OCR.MODE === 'numeric' ? '数字' : '英数');
    if (CONFIG.BARCODE.ENABLED) parts.push('BAR');
    if (CONFIG.QR.ENABLED) parts.push('QR');
    el.ocrChip.textContent = parts.length ? parts.join(' / ') : '読取OFF';
    el.ocrChip.classList.toggle('is-on', parts.length > 0);
    el.ocrChip.classList.toggle('is-off', parts.length === 0);
  }

  /* ---------- カメラの選択・ズーム（CAMERA.SWITCH_BUTTON / ZOOM_LEVELS） ----------
     Android の一部 Galaxy はブラウザからマクロへ自動で切り替わらず、近づくと
     ピントが合わない。近づかずにズームで枠を埋める／近接に強い背面カメラへ
     切り替える、の2つを対応端末でだけ出す。選んだカメラと倍率は「その端末の癖」
     なので localStorage に記憶し、次回の起動から使う。 */
  const CAMERA_DEVICE_KEY = 'inspection.cameraDeviceId';
  const CAMERA_ZOOM_KEY = 'inspection.cameraZoom';
  const CAM = CONFIG.CAMERA || {};

  function readPref(key) {
    try { return window.localStorage.getItem(key); } catch (e) { return null; }
  }
  function writePref(key, value) {
    try {
      if (value === null || value === undefined || value === '') window.localStorage.removeItem(key);
      else window.localStorage.setItem(key, String(value));
    } catch (e) { /* 使えない環境では記憶しない */ }
  }

  /** 起動時に使うズーム倍率: 端末で選んだ値 > 設定の ZOOM */
  function preferredZoom() {
    const saved = parseFloat(readPref(CAMERA_ZOOM_KEY));
    if (saved > 0) return saved;
    const conf = Number(CAM.ZOOM);
    return conf > 0 ? conf : 1;
  }

  function zoomLevels() {
    const list = Array.isArray(CAM.ZOOM_LEVELS) ? CAM.ZOOM_LEVELS : [];
    return list.map(Number).filter((v) => v > 0);
  }

  function updateZoomButton(zoomInfo) {
    const levels = zoomLevels();
    if (!zoomInfo || !levels.length) {
      el.zoomBtn.hidden = true;
      return;
    }
    const usable = levels.filter((v) => v >= zoomInfo.min && v <= zoomInfo.max);
    if (usable.length < 2) {
      el.zoomBtn.hidden = true;   // 切り替える先が無い
      return;
    }
    const v = zoomInfo.value;
    el.zoomBtn.textContent = (Number.isInteger(v) ? v : v.toFixed(1)) + 'x';
    el.zoomBtn.classList.toggle('is-active', v !== 1);
    el.zoomBtn.hidden = false;
  }

  el.zoomBtn.addEventListener('click', async () => {
    if (!state.cameraOn || state.captured) return;
    const cap = scanner.zoomCapability();
    if (!cap) return;
    const usable = zoomLevels().filter((v) => v >= cap.min && v <= cap.max);
    if (!usable.length) return;
    // いまの倍率より大きい次の段へ。無ければ先頭に戻る
    const cur = scanner.zoom;
    const next = usable.find((v) => v > cur + 1e-6) ?? usable[0];
    const applied = await scanner.setZoom(next);
    writePref(CAMERA_ZOOM_KEY, applied);
    updateZoomButton({ min: cap.min, max: cap.max, value: applied });
  });

  async function updateSwitchButton() {
    if (!CAM.SWITCH_BUTTON) {
      el.switchCamBtn.hidden = true;
      return;
    }
    const cams = await scanner.listCameras();
    el.switchCamBtn.hidden = cams.length < 2;
  }

  el.switchCamBtn.addEventListener('click', async () => {
    if (!state.cameraOn || state.captured) return;
    const cams = await scanner.listCameras();
    if (cams.length < 2) return;
    const cur = scanner.currentDeviceId();
    const idx = cams.findIndex((c) => c.deviceId === cur);
    const next = cams[(idx + 1) % cams.length];
    writePref(CAMERA_DEVICE_KEY, next.deviceId);

    stopCamera();
    await startCamera();
    if (state.cameraOn) {
      const pos = (cams.indexOf(next) + 1) + '/' + cams.length;
      toast('カメラ ' + pos + (next.label ? '：' + next.label : ''));
    }
  });

  async function startCamera() {
    try {
      el.startBtn.disabled = true;
      showCameraMessage('カメラを起動しています...');
      const info = await scanner.startCamera({
        deviceId: readPref(CAMERA_DEVICE_KEY),
        zoom: preferredZoom(),
      });
      state.cameraOn = true;
      state.captured = false;
      showCameraMessage(null);

      // 記憶していたカメラが使えなかったときは記憶を捨てて既定に戻す
      if (info.deviceFallback) {
        writePref(CAMERA_DEVICE_KEY, null);
        toast('記憶したカメラが使えないため、既定のカメラで起動しました', 'error');
      }

      scanner.layoutRoiGuide();
      scanner.startLoops();

      el.torchBtn.hidden = !info.hasTorch;
      updateZoomButton(info.zoom);
      updateSwitchButton();   // enumerateDevices は非同期。表示だけなので待たない
      if (DEBUG_MODE) showCameraInfoInDebug();
      el.startBtn.querySelector('.btn__label').textContent = 'カメラ停止';
      el.startBtn.querySelector('.btn__icon').textContent = '■';
      el.shutterBtn.disabled = false;
      setBadge('読み取り中', 'ready');
      updateModeChip();
    } catch (e) {
      console.error(e);
      const msg = describeCameraError(e);
      showCameraMessage(msg);
      setBadge('カメラエラー', 'error');
      toast('カメラを開始できません', 'error');
    } finally {
      el.startBtn.disabled = false;
    }
  }

  function describeCameraError(e) {
    const name = e && e.name;
    if (name === 'NotAllowedError') {
      return 'カメラの使用が許可されていません。\nブラウザの設定でカメラを許可してください。';
    }
    if (name === 'NotFoundError' || name === 'OverconstrainedError') {
      return '利用できるカメラが見つかりませんでした。';
    }
    if (name === 'NotReadableError') {
      return 'カメラを他のアプリが使用中の可能性があります。';
    }
    return (e && e.message) || 'カメラを開始できませんでした。';
  }

  function stopCamera() {
    scanner.stopCamera();
    state.cameraOn = false;
    state.captured = false;
    el.stillCanvas.hidden = true;
    el.torchBtn.hidden = true;
    el.zoomBtn.hidden = true;
    el.switchCamBtn.hidden = true;
    el.startBtn.querySelector('.btn__label').textContent = 'カメラ開始';
    el.startBtn.querySelector('.btn__icon').textContent = '▶';
    el.shutterBtn.disabled = true;
    el.shutterBtn.classList.remove('is-still');
    showCameraMessage('カメラは停止しています');
    setBadge('停止中');
    updateModeChip();
    updateSubmitState();
  }

  el.startBtn.addEventListener('click', () => {
    if (state.cameraOn) stopCamera();
    else startCamera();
  });

  /**
   * 静止画を捨ててリアルタイム読み取りに戻す。
   * iPhone Safari では送信後のクリアで映像が静止したままになることがあるため、
   * scanner 側で映像の更新を確認し、復旧できなければカメラを再起動する
   * （「カメラ停止 → カメラ開始」で直る、という手動対処を自動化したもの）。
   */
  async function backToLive() {
    if (!state.cameraOn) return;
    state.captured = false;
    el.shutterBtn.classList.remove('is-still');
    setBadge('読み取り中', 'ready');
    updateModeChip();
    updateSubmitState();

    const ok = await scanner.resumeLive();
    if (!ok) await restartCamera();
  }

  /** 映像が止まったままのときの最終手段: カメラを止めて開始し直す */
  async function restartCamera() {
    console.warn('camera video frozen; restarting camera');
    stopCamera();
    await startCamera();
    if (state.cameraOn) toast('カメラを再起動しました');
  }

  el.torchBtn.addEventListener('click', async () => {
    const on = await scanner.toggleTorch();
    el.torchBtn.classList.toggle('is-active', on);
  });

  /* ---------- シャッター ---------- */

  el.shutterBtn.addEventListener('click', async () => {
    if (!state.cameraOn) return;

    // 静止状態でもう一度押したらリアルタイムに戻る（撮り直し）
    if (state.captured) {
      await backToLive();
      return;
    }

    el.shutterBtn.disabled = true;
    el.stage.classList.add('is-flashing');
    setTimeout(() => el.stage.classList.remove('is-flashing'), 300);

    try {
      setBadge('解析中', 'busy');
      const { results } = await scanner.capture();
      state.captured = true;
      el.shutterBtn.classList.add('is-still');
      updateModeChip();

      if (results.length) {
        toast(results.length + '件 読み取りました', 'ok');
      } else {
        toast('静止画からは読み取れませんでした');
      }
      setBadge('静止画', 'busy');
    } catch (e) {
      console.error(e);
      toast('撮影に失敗しました', 'error');
      setBadge('エラー', 'error');
    } finally {
      el.shutterBtn.disabled = false;
      updateSubmitState();
    }
  });

  /* ============================================================
     送信 / クリア
     ============================================================ */

  function updateSubmitState() {
    // 写真保存なしモードでは撮影を待たない（スタックが1件以上あれば送信できる）
    const ok = !state.sending && stack.length > 0 && (TEXT_ONLY || state.captured);
    el.submitBtn.disabled = !ok;
  }

  el.submitBtn.addEventListener('click', async () => {
    if (state.sending) return;
    const texts = stack.getTexts();

    if (!texts.length) return toast('スタックが空です', 'error');

    const form = new FormData();
    form.append('project_id', CONFIG.PROJECT_ID);
    form.append('strings', JSON.stringify(texts));
    form.append('note', el.noteInput.value || '');

    // 写真保存なしモードでは画像を送らない（サーバー側も受け取らない）
    if (!TEXT_ONLY) {
      if (!state.captured) return toast('シャッターで撮影してください', 'error');
      const blob = scanner.getCapturedBlob();
      if (!blob) return toast('撮影画像がありません', 'error');
      form.append('image', blob, 'capture.jpg');
    }

    state.sending = true;
    updateSubmitState();
    block('送信中...');

    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort(), CONFIG.API.TIMEOUT_MS);

    try {
      const res = await fetch(CONFIG.API.UPLOAD_URL, {
        method: 'POST',
        body: form,
        signal: controller.signal,
      });
      const raw = await res.text();

      let data;
      try {
        data = JSON.parse(raw);
      } catch (e) {
        throw new Error('サーバー応答が不正です: ' + raw.slice(0, 120));
      }
      if (!res.ok || !data.ok) {
        throw new Error(data.error || 'HTTP ' + res.status);
      }

      // 送信完了は見落とさないよう、タップするまで消さない。
      // UI.AUTO_CLEAR_AFTER_SAVE が有効なら、閉じたときに確認なしでクリアする
      const autoClear = !!(CONFIG.UI && CONFIG.UI.AUTO_CLEAR_AFTER_SAVE);
      toast('保存しました: ' + data.filename, 'ok', {
        sticky: true,
        hint: autoClear ? 'タップで閉じてクリア' : 'タップで閉じる',
        onClose: autoClear ? clearAll : null,
      });
    } catch (e) {
      console.error(e);
      const msg = e.name === 'AbortError' ? '送信がタイムアウトしました' : e.message;
      toast('送信失敗: ' + msg, 'error');
    } finally {
      clearTimeout(timer);
      unblock();
      state.sending = false;
      updateSubmitState();
    }
  });

  /** クリア（備考は残す）。確認は呼び出し側で行う */
  async function clearAll() {
    stack.clear();
    state.candidates.clear();
    renderCandidates();

    if (scanner) {
      scanner.resetDetections();
      if (state.cameraOn && state.captured) {
        await backToLive();
      }
    }
    updateModeChip();
    updateSubmitState();
    toast('クリアしました');
  }

  el.clearBtn.addEventListener('click', () => {
    if (stack.length && !window.confirm('スタックと読み取り結果をクリアします。よろしいですか？')) {
      return;
    }
    clearAll();
  });


  /* ============================================================
     OCR診断パネル
     ?debug=1 を付けるか、config.js の DEBUG を true にすると表示。
     「OCRに実際に渡している画像」と認識結果が見えるので、
     読めない原因（枠がずれている/文字が小さい/フィルタで落ちた）を切り分けられる。
     ============================================================ */

  const DEBUG_MODE =
    CONFIG.DEBUG || /[?&]debug=1(&|$)/.test(location.search);

  /** いまのカメラと端末の対応状況（ズーム / フォーカス / ライト）を1行にする */
  function cameraInfoLines() {
    if (!scanner || !state.cameraOn) return [];
    const c = scanner.cameraInfo();
    return [
      'カメラ ' + c.size + ' / ズーム ' + c.zoom + ' / フォーカス ' + c.focusMode +
      ' / 焦点距離 ' + c.focusDistance + ' / ライト ' + c.torch,
    ];
  }

  /** カメラ起動直後（OCR がまだ走っていない）でも端末の対応状況が読めるようにする */
  function showCameraInfoInDebug() {
    el.debugLog.textContent = cameraInfoLines().concat(['（OCR はまだ実行されていません）']).join('\n');
  }

  function renderDebug(info) {
    // OCRに渡した画像をそのまま表示する
    const cv = el.debugCanvas;
    const src = info.ocrCanvas;
    if (src && src.width) {
      cv.width = src.width;
      cv.height = src.height;
      cv.getContext('2d').drawImage(src, 0, 0);
    }

    const lines = cameraInfoLines();
    lines.push(
      '映像 ' + info.source.w + 'x' + info.source.h +
      ' / 切出し x' + info.roi.x + ' y' + info.roi.y +
      ' w' + info.roi.w + ' h' + info.roi.h +
      ' → OCR ' + (src ? src.width + 'x' + src.height : '-')
    );
    lines.push('生テキスト: ' + JSON.stringify(String(info.text || '').trim()));

    if (!info.words.length) {
      lines.push('▲ 文字が1つも認識されていません');
      lines.push('  → 枠内に文字が入っているか、文字が小さすぎないか確認');
    } else {
      const confOf = (c) => (c === null || c === undefined ? '信頼度?' : '信頼度' + c.toFixed(0));
      info.accepted.forEach((t) => lines.push('OK  ' + t));
      info.rejected.forEach((r) =>
        lines.push('NG  ' + r.text + '  ' + confOf(r.conf) + '  <- ' + r.why.join(','))
      );
    }
    el.debugLog.textContent = lines.join('\n');
  }

  if (el.debugCloseBtn) {
    el.debugCloseBtn.addEventListener('click', () => {
      el.debugPanel.hidden = true;
    });
  }

  /* ============================================================
     プロジェクト切り替え
     config/<プロジェクトID>.php が2つ以上あるときだけ、
     ヘッダーのプロジェクト名がセレクトになる。
     設定はサーバー側で読み込むため、切り替えは ?p=<ID> での再読み込み。
     ============================================================ */

  function setupProjectSwitcher() {
    const projects = (Array.isArray(CONFIG.PROJECTS) ? CONFIG.PROJECTS : []).slice();

    // いま開いているプロジェクトが一覧に無い（SHOW_IN_SELECT = false で隠されている等）
    // 場合も、現在地が分かるように選択肢の先頭に足す。隠したプロジェクトは
    // 他のプロジェクトを開いているときには出てこない、という意味になる
    if (!projects.some((p) => p.id === CONFIG.PROJECT_ID)) {
      projects.unshift({ id: CONFIG.PROJECT_ID, label: CONFIG.PROJECT_LABEL });
    }

    // 1つしか定義されていないなら、これまでどおりラベル表示のまま
    if (projects.length < 2 || !el.projectSelect) {
      el.projectLabel.textContent =
        CONFIG.PROJECT_LABEL + '（' + CONFIG.PROJECT_ID + '）';
      return;
    }

    for (const p of projects) {
      const opt = document.createElement('option');
      opt.value = p.id;
      opt.textContent = p.label + '（' + p.id + '）';
      if (p.id === CONFIG.PROJECT_ID) opt.selected = true;
      el.projectSelect.appendChild(opt);
    }
    el.projectLabel.hidden = true;
    el.projectSelect.hidden = false;

    el.projectSelect.addEventListener('change', () => {
      const id = el.projectSelect.value;
      if (id === CONFIG.PROJECT_ID) return;

      // 作業中の内容は引き継げないので確認する
      if (stack.length > 0 || state.captured) {
        const ok = window.confirm(
          'プロジェクトを切り替えると、スタックと撮影内容は破棄されます。\n切り替えますか？'
        );
        if (!ok) {
          el.projectSelect.value = CONFIG.PROJECT_ID;
          return;
        }
      }
      // 設定はサーバー側で組み立てるため、URLを変えて読み込み直す
      const params = new URLSearchParams(location.search);
      params.set('p', id);
      leavingIntentionally = true;   // 確認済みなので離脱警告は出さない
      location.search = params.toString();
    });
  }

  /* ============================================================
     初期化
     ============================================================ */

  /** Tesseract の進捗ステータスを日本語にする */
  const PROGRESS_LABEL = {
    'loading tesseract core': 'OCRエンジンを読み込み中',
    'initializing tesseract': 'OCRエンジンを初期化中',
    'loading language traineddata': '学習データを読み込み中',
    'loading language traineddata (from cache)': '学習データを読み込み中',
    'initializing api': '準備中',
    'initialized api': '準備中',
  };

  async function init() {
    setupProjectSwitcher();
    el.noteInput.placeholder = CONFIG.UI.NOTE_PLACEHOLDER;
    restoreNote();   // プレビューへの反映は後段の onStackChange([]) が行う

    // 写真保存なしモードは見た目で分かるようにする
    // （シャッターは静止画OCR用に残るので、押せること自体は変えない）
    if (TEXT_ONLY) {
      el.saveModeBadge.hidden = false;
      el.filenameLabel.textContent = '保存ファイル名（写真は保存しません）';
    }
    updateOcrChip();
    updateModeChip();
    el.shutterBtn.disabled = true;
    el.startBtn.disabled = true;
    showCameraMessage('準備しています...');

    stack = new StackList(el.stackList, { onChange: onStackChange });
    onStackChange([]);

    let enginesReady = false;

    scanner = new Scanner(
      {
        video: el.video,
        stage: el.stage,
        stillCanvas: el.stillCanvas,
        roiGuide: el.roiGuide,
      },
      {
        onDetect: (text, source) => addCandidate(text, source),
        onStatus: () => updateModeChip(),
        onProgress: (status, progress) => {
          // 準備完了後は認識のたびに呼ばれるので無視する
          if (enginesReady) return;
          const label = PROGRESS_LABEL[status];
          if (!label) return;
          const pct = Math.round((progress || 0) * 100);
          setBadge('OCR ' + pct + '%', 'busy');
          // カメラ起動後は映像を隠さないよう、メッセージは出さない
          if (!state.cameraOn) {
            showCameraMessage(
              label + '... ' + pct + '%\n初回は少し時間がかかります\n' +
                '（待たずに「カメラ開始」を押せます）'
            );
          }
        },
        // OCRループの例外は握りつぶさず必ず表面化させる。
        // 黙って失敗すると「何も読み取れない」としか見えず原因を追えない。
        onError: (e, kind, count) => {
          console.error('[app]', kind, e);
          if (kind !== 'ocr') return;
          if (count === 1 || count === 5 || count % 20 === 0) {
            setBadge('OCRエラー', 'error');
            toast('OCR実行エラー: ' + (e && e.message ? e.message : e), 'error');
          }
        },
        // 診断モードのときだけ渡す（通常時は計測処理そのものが動かない）
        onDebug: DEBUG_MODE ? renderDebug : null,
      }
    );

    if (DEBUG_MODE) {
      el.debugPanel.hidden = false;
      console.log('[app] 診断モードで起動しました');
    }

    // バーコード/QR は軽いので先に準備し、カメラを使えるようにする
    const warnings = await scanner.initEngines();
    warnings.forEach((w) => console.warn(w));
    if (warnings.length) toast(warnings[0], 'error');

    el.startBtn.disabled = false;
    showCameraMessage('「カメラ開始」を押してください');

    // OCR は約17MB の読み込みが必要なため、カメラ操作をブロックせず裏で準備する
    if (CONFIG.OCR.ENABLED) {
      setBadge('OCR準備中', 'busy');
      scanner
        .initOcr()
        .then(() => {
          enginesReady = true;
          setBadge(state.cameraOn ? '読み取り中' : '準備完了', 'ready');
          if (!state.cameraOn) showCameraMessage('「カメラ開始」を押してください');
        })
        .catch((e) => {
          enginesReady = true;
          console.error(e);
          setBadge('OCRエラー', 'error');
          toast('OCRエンジンを読み込めませんでした（バーコード/QRは使えます）', 'error');
          if (!state.cameraOn) showCameraMessage('「カメラ開始」を押してください');
        });
    } else {
      enginesReady = true;
      setBadge('準備完了', 'ready');
    }

    // 画面サイズ変更時はガイド枠を追従させる
    const relayout = () => scanner.layoutRoiGuide();
    window.addEventListener('resize', relayout);
    window.addEventListener('orientationchange', () => setTimeout(relayout, 300));

    // バックグラウンドに回ったら認識ループを止める。
    // 復帰時は映像が止まっていないか確認し、止まっていればカメラを再起動する
    document.addEventListener('visibilitychange', async () => {
      if (!state.cameraOn) return;
      if (document.hidden) {
        scanner.stopLoops();
      } else if (!state.captured) {
        const ok = await scanner.ensureLive();
        if (!ok) return restartCamera();
        scanner.startLoops();
      }
    });

    // 送信前の離脱を警告
    window.addEventListener('beforeunload', (e) => {
      if (leavingIntentionally) return;
      if (stack.length > 0) {
        e.preventDefault();
        e.returnValue = '';
      }
    });
  }

  document.addEventListener('DOMContentLoaded', init);
})();
