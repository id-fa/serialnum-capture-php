/* ============================================================
   scanner.js
   カメラ制御 / OCR(Tesseract.js) / バーコード・QR(ZXing) を担当
   ============================================================ */

(function (global) {
  'use strict';

  const log = (...a) => { if (CONFIG.DEBUG) console.log('[scanner]', ...a); };

  /** 撮影画像を保存するモードか（'text' は写真保存なしモード） */
  const saveImageEnabled = () => !CONFIG.SAVE || CONFIG.SAVE.MODE !== 'text';

  /* ---------- 小物 ---------- */

  /** OCRモードに応じたホワイトリスト文字列（EXTRA_CHARS を含む） */
  function charsetFor(mode) {
    const base = OCR_CHARSETS[mode] || OCR_CHARSETS.alnum;
    return base + (CONFIG.OCR.EXTRA_CHARS || '');
  }

  /** 文字クラス内で安全に使えるようエスケープする（- ] ^ \ を無害化） */
  function escapeForCharClass(s) {
    return String(s || '').replace(/[\\\]^-]/g, '\\$&');
  }

  /** OCRモードに応じた許可文字の正規表現（EXTRA_CHARS を含む） */
  function allowRegexFor(mode) {
    const extra = escapeForCharClass(CONFIG.OCR.EXTRA_CHARS);
    if (mode === 'numeric') return new RegExp('^[0-9' + extra + ']+$');
    if (mode === 'alnum_mixed') return new RegExp('^[0-9A-Za-z' + extra + ']+$');
    return new RegExp('^[0-9A-Z' + extra + ']+$');
  }

  /**
   * Tesseract の結果から単語配列を取り出す。
   * v4 は data.words、v5 は data.blocks を辿る必要があるため両対応。
   *
   * 信頼度は端末によって返ってこないことがある（iOS Safari で実際に発生）。
   * その場合に 0 を入れてしまうと信頼度フィルタで全滅するため、
   * 「不明」は null として扱い、フィルタ側で除外しないようにする。
   */
  function extractWords(data) {
    let words = [];

    if (Array.isArray(data.words) && data.words.length) {
      words = data.words;
    } else {
      const out = [];
      for (const block of data.blocks || []) {
        for (const para of block.paragraphs || []) {
          for (const line of para.lines || []) {
            for (const word of line.words || []) out.push(word);
          }
        }
      }
      words = out;
    }

    // 単語が取れなければテキスト全体を空白で分割（信頼度は不明）
    if (!words.length) {
      words = String(data.text || '')
        .split(/\s+/)
        .filter(Boolean)
        .map((t) => ({ text: t, confidence: null }));
    }

    // ページ全体の信頼度。単語ごとの値が無いときの代用にする。
    const pageConf =
      typeof data.confidence === 'number' && data.confidence > 0 ? data.confidence : null;

    return words.map((w) => {
      let c = typeof w.confidence === 'number' ? w.confidence : null;
      // 0 は「未算出」であることが多いのでページ信頼度で代用する
      if (c === null || c === 0) c = pageConf;
      return { text: w.text, confidence: c };
    });
  }

  /* ============================================================
     Scanner 本体
     ============================================================ */
  class Scanner {
    /**
     * @param {object} refs { video, stage, stillCanvas, roiGuide }
     * @param {object} handlers { onDetect, onStatus, onError }
     */
    constructor(refs, handlers) {
      this.video = refs.video;
      this.stage = refs.stage;
      this.stillCanvas = refs.stillCanvas;
      this.roiGuide = refs.roiGuide;

      this.onDetect = handlers.onDetect || function () {};
      this.onStatus = handlers.onStatus || function () {};
      this.onProgress = handlers.onProgress || function () {};
      this.onError = handlers.onError || function () {};
      // 診断パネル用（未設定なら診断処理そのものを行わない）
      this.onDebug = handlers.onDebug || null;
      this._lastRejected = [];

      this.stream = null;
      this.track = null;
      this.torchOn = false;
      this.zoom = 1;            // 現在のズーム倍率（対応端末のみ意味を持つ）

      this.mode = 'idle';        // idle | live | still
      this.ocrWorker = null;
      this.ocrBusy = false;
      this.ocrTimer = null;
      this.codeReader = null;
      this.codeTimer = null;

      // 安定化カウンタ（同じ文字列が何フレーム続いたか）
      this.stableMap = new Map();
      // すでに通知済みの文字列（同一セッション内の重複通知を抑制）
      this.emitted = new Set();

      // 作業用キャンバス
      this.workCanvas = document.createElement('canvas');
      this.workCtx = this.workCanvas.getContext('2d', { willReadFrequently: true });
      this.codeCanvas = document.createElement('canvas');
      this.codeCtx = this.codeCanvas.getContext('2d', { willReadFrequently: true });
      this.fullCanvas = document.createElement('canvas');
      this.fullCtx = this.fullCanvas.getContext('2d');

      this._bindVideoEvents(this.video);

      // 撮影済み静止画（送信用）
      this.capturedBlob = null;
      this.capturedDataUrl = null;
    }

    /**
     * video 要素にイベントを登録する（要素を作り直すたびに呼ぶ）。
     *
     * iOS Safari は confirm() や全画面オーバーレイのあとで MediaStream の
     * <video> を勝手に一時停止することがある（映像が静止したままになる）。
     * 意図した停止（stopCamera）以外で止まったら再生し直す。
     */
    _bindVideoEvents(video) {
      video.addEventListener('pause', () => {
        if (this.video !== video) return;
        if (this.mode === 'idle' || !this.stream || document.hidden) return;
        log('video paused unexpectedly; play() again');
        video.play().catch((e) => log('re-play failed', e && e.name));
      });
    }

    /**
     * <video> 要素を作り直す。
     *
     * iOS Safari はスリープ／ロック解除のあと、MediaStream を描画するネイティブ
     * レイヤーの向き・サイズ情報を古いまま持ち越すことがあり、ライブ表示だけが
     * 縦長に歪む（映像フレーム自体は正常で、撮影画像や読み取りには影響しない）。
     * 同じ要素に新しいストリームを差してもレイヤーは使い回されるため
     * カメラ再起動では直らず、要素ごと作り直すと直る（リロードと同じ効果）。
     * 属性（id / playsinline / muted / autoplay）と DOM 上の位置はそのまま引き継ぐ。
     */
    _recreateVideo() {
      const old = this.video;
      if (!old || !old.parentNode) return;
      old.srcObject = null;
      const fresh = old.cloneNode(false);
      // cloneNode は muted 属性を写すが、プロパティ側は既定値に戻ることがある
      fresh.muted = true;
      old.parentNode.replaceChild(fresh, old);
      this.video = fresh;
      this._bindVideoEvents(fresh);
    }

    /* ---------- 初期化 ---------- */

    /**
     * バーコード/QR リーダーを準備する（軽量・ほぼ即座に完了）。
     * OCR は重いので initOcr() で別途・非同期に準備する。
     * @returns {Promise<string[]>} 警告メッセージ（致命的でない失敗）
     */
    async initEngines() {
      const warnings = [];
      if (CONFIG.BARCODE.ENABLED || CONFIG.QR.ENABLED) {
        try {
          await this._initCodeReader();
        } catch (e) {
          warnings.push('バーコード/QR を初期化できません: ' + e.message);
        }
      }
      return warnings;
    }

    /**
     * OCR エンジンを準備する。CDN から約17MB 取得するため時間がかかる。
     * カメラ開始をブロックしないよう、これだけ切り離してある。
     */
    async initOcr() {
      if (!CONFIG.OCR.ENABLED) return;
      await this._initOcr();
      // 準備できた時点でカメラが動いていれば、認識ループに合流させる
      if (this.mode === 'live' && this.ocrTimer === null) this._scheduleOcr(0);
    }

    async _initOcr() {
      if (typeof Tesseract === 'undefined') {
        throw new Error('Tesseract.js を読み込めませんでした');
      }
      this.onStatus('OCR準備中');
      const opts = {
        workerPath: CONFIG.OCR.WORKER_PATH,
        corePath: CONFIG.OCR.CORE_PATH,
        langPath: CONFIG.OCR.LANG_PATH,
        logger: (m) => {
          if (CONFIG.DEBUG) log('tesseract', m.status, m.progress);
          this.onProgress(m.status, m.progress);
        },
      };

      // 第2引数 1 = LSTM_ONLY
      this.ocrWorker = await Tesseract.createWorker(CONFIG.OCR.LANG, 1, opts);
      await this.ocrWorker.setParameters({
        tessedit_char_whitelist: charsetFor(CONFIG.OCR.MODE),
        tessedit_pageseg_mode: String(CONFIG.OCR.PSM),
        preserve_interword_spaces: '0',
      });
      log('ocr ready');
    }

    async _initCodeReader() {
      if (typeof ZXing === 'undefined') {
        throw new Error('ZXing を読み込めませんでした');
      }
      const formats = [];
      const BF = ZXing.BarcodeFormat;
      const push = (names) => {
        names.forEach((n) => {
          if (BF[n] !== undefined) formats.push(BF[n]);
          else console.warn('[scanner] 未知のフォーマット:', n);
        });
      };
      if (CONFIG.BARCODE.ENABLED) push(CONFIG.BARCODE.FORMATS);
      if (CONFIG.QR.ENABLED) push(CONFIG.QR.FORMATS);
      if (!formats.length) return;

      const hints = new Map();
      hints.set(ZXing.DecodeHintType.POSSIBLE_FORMATS, formats);
      hints.set(ZXing.DecodeHintType.TRY_HARDER, true);
      this.codeReader = new ZXing.MultiFormatReader();
      this.codeReader.setHints(hints);
      log('code reader ready', formats.length, 'formats');
    }

    /* ---------- カメラ ---------- */

    /**
     * @param {{deviceId?: string|null, zoom?: number}} [opts]
     *   deviceId: 使うカメラ（省略時は FACING_MODE で端末に選ばせる）。
     *             使えなければ FACING_MODE に落とし、戻り値の deviceFallback を true にする
     *   zoom:     起動直後に適用するズーム倍率（対応端末のみ）
     * @returns {Promise<{hasTorch: boolean, deviceFallback: boolean, zoom: object|null}>}
     */
    async startCamera(opts) {
      opts = opts || {};
      if (!navigator.mediaDevices || !navigator.mediaDevices.getUserMedia) {
        throw new Error(
          'このブラウザではカメラを利用できません。\nHTTPS(またはlocalhost)でアクセスしているか確認してください。'
        );
      }
      this.stopCamera();
      // 前回の描画状態を引きずらないよう、開始のたびに要素を作り直す
      this._recreateVideo();

      const size = {
        width: { ideal: CONFIG.CAMERA.IDEAL_WIDTH },
        height: { ideal: CONFIG.CAMERA.IDEAL_HEIGHT },
      };
      const byFacing = Object.assign({ facingMode: { ideal: CONFIG.CAMERA.FACING_MODE } }, size);

      let stream = null;
      let deviceFallback = false;

      // 指定カメラ（切替ボタンで選んだもの）。OS 更新などで無くなることがあるので、
      // 失敗したら既定の選び方に落とす
      if (opts.deviceId) {
        try {
          stream = await navigator.mediaDevices.getUserMedia({
            audio: false,
            video: Object.assign({ deviceId: { exact: opts.deviceId } }, size),
          });
        } catch (e) {
          log('deviceId failed; fallback to facingMode', e && e.name);
          deviceFallback = true;
        }
      }
      if (!stream) {
        try {
          stream = await navigator.mediaDevices.getUserMedia({ audio: false, video: byFacing });
        } catch (e) {
          // 解像度指定で失敗する端末があるためフォールバック
          log('fallback constraints', e && e.name);
          stream = await navigator.mediaDevices.getUserMedia({
            audio: false,
            video: { facingMode: CONFIG.CAMERA.FACING_MODE },
          });
        }
      }

      this.stream = stream;
      this.track = stream.getVideoTracks()[0] || null;
      this.video.srcObject = stream;
      this.video.setAttribute('playsinline', '');
      await this.video.play();
      await this._waitForVideoSize();

      log('camera started', this.video.videoWidth + 'x' + this.video.videoHeight);
      this.setMode('live');

      // ズームは起動後に applyConstraints で掛ける（getUserMedia の制約には入れない。
      // 非対応端末で OverconstrainedError になるため）
      this.zoom = 1;
      const zoomCap = this.zoomCapability();
      if (zoomCap && typeof opts.zoom === 'number' && opts.zoom !== 1) {
        await this.setZoom(opts.zoom);
      }

      return {
        hasTorch: this.hasTorch(),
        deviceFallback,
        zoom: zoomCap ? { min: zoomCap.min, max: zoomCap.max, value: this.zoom } : null,
      };
    }

    /* ---------- カメラの選択・ズーム ---------- */

    /** track.getCapabilities() を安全に読む（未対応ブラウザは {}） */
    _capabilities() {
      if (!this.track || typeof this.track.getCapabilities !== 'function') return {};
      try { return this.track.getCapabilities() || {}; } catch (e) { return {}; }
    }

    /** track.getSettings() を安全に読む */
    _settings() {
      if (!this.track || typeof this.track.getSettings !== 'function') return {};
      try { return this.track.getSettings() || {}; } catch (e) { return {}; }
    }

    /**
     * 切り替え候補のカメラ一覧（前面カメラはラベルで除く）。
     * ラベルはカメラ許可後にしか入らないので、カメラ起動後に呼ぶこと。
     * Galaxy は "camera2 0, facing back" のような名前で背面カメラを複数返す。
     * @returns {Promise<Array<{deviceId: string, label: string}>>}
     */
    async listCameras() {
      if (!navigator.mediaDevices || !navigator.mediaDevices.enumerateDevices) return [];
      let devices;
      try { devices = await navigator.mediaDevices.enumerateDevices(); } catch (e) { return []; }
      const isFront = (label) => /front|user|前面|フロント|selfie/i.test(label);
      return devices
        .filter((d) => d.kind === 'videoinput' && d.deviceId)
        .filter((d) => !isFront(d.label || ''))
        .map((d) => ({ deviceId: d.deviceId, label: d.label || '' }));
    }

    /** いま使っているカメラの deviceId（取れなければ null） */
    currentDeviceId() {
      return this._settings().deviceId || null;
    }

    /** ズーム対応なら {min, max, step}、非対応なら null */
    zoomCapability() {
      const z = this._capabilities().zoom;
      if (!z || typeof z.min !== 'number' || typeof z.max !== 'number' || z.max <= z.min) return null;
      return { min: z.min, max: z.max, step: z.step || 0 };
    }

    /**
     * ズーム倍率を設定する（端末の範囲に丸める）。
     * @returns {Promise<number>} 実際に適用した倍率（非対応なら 1）
     */
    async setZoom(value) {
      const cap = this.zoomCapability();
      if (!cap) return 1;
      const v = Math.max(cap.min, Math.min(cap.max, Number(value) || 1));
      try {
        await this.track.applyConstraints({ advanced: [{ zoom: v }] });
        this.zoom = v;
      } catch (e) {
        log('zoom failed', e && e.name);
      }
      return this.zoom;
    }

    /** 診断パネル用: いまのカメラと端末の対応状況 */
    cameraInfo() {
      const s = this._settings();
      const c = this._capabilities();
      const range = (r) => (r && typeof r.min === 'number' ? r.min + '〜' + r.max : '-');
      return {
        deviceId: s.deviceId || null,
        size: (s.width || this.video.videoWidth) + 'x' + (s.height || this.video.videoHeight),
        zoom: c.zoom ? range(c.zoom) + ' (現在 ' + this.zoom + ')' : '非対応',
        focusMode: Array.isArray(c.focusMode) && c.focusMode.length ? c.focusMode.join('/') : '非対応',
        focusDistance: c.focusDistance ? range(c.focusDistance) : '非対応',
        torch: c.torch ? '対応' : '非対応',
      };
    }

    _waitForVideoSize() {
      return new Promise((resolve) => {
        if (this.video.videoWidth > 0) return resolve();
        const onReady = () => {
          this.video.removeEventListener('loadedmetadata', onReady);
          resolve();
        };
        this.video.addEventListener('loadedmetadata', onReady);
      });
    }

    stopCamera() {
      this.stopLoops();
      if (this.stream) {
        this.stream.getTracks().forEach((t) => t.stop());
        this.stream = null;
        this.track = null;
      }
      this.video.srcObject = null;
      this.torchOn = false;
      this.zoom = 1;
      this.setMode('idle');
    }

    hasTorch() {
      if (!this.track || !this.track.getCapabilities) return false;
      try {
        return !!this.track.getCapabilities().torch;
      } catch (e) {
        return false;
      }
    }

    async toggleTorch() {
      if (!this.hasTorch()) return false;
      this.torchOn = !this.torchOn;
      try {
        await this.track.applyConstraints({ advanced: [{ torch: this.torchOn }] });
      } catch (e) {
        this.torchOn = false;
      }
      return this.torchOn;
    }

    /* ---------- ROI ---------- */

    /**
     * 画面に実際に写っている範囲を映像内のピクセル座標で返す。
     *
     * video は object-fit: cover で表示しているため、映像の一部は
     * 画面外にはみ出して見えていない。撮影画像を「見えている範囲」に
     * 揃えるために使う。
     */
    computeVisibleRect(srcW, srcH) {
      const rect = this.stage.getBoundingClientRect();
      const stageW = rect.width || 1;
      const stageH = rect.height || 1;
      const scale = Math.max(stageW / srcW, stageH / srcH);

      const w = Math.min(srcW, stageW / scale);
      const h = Math.min(srcH, stageH / scale);
      return {
        x: Math.round((srcW - w) / 2),
        y: Math.round((srcH - h) / 2),
        w: Math.round(w),
        h: Math.round(h),
      };
    }

    /**
     * 表示中のガイド枠に対応する「映像内のピクセル座標」を計算する。
     * video は object-fit:cover で表示しているため、はみ出し分を考慮する。
     */
    computeRoi(srcW, srcH) {
      const rect = this.stage.getBoundingClientRect();
      const stageW = rect.width || 1;
      const stageH = rect.height || 1;

      if (!CONFIG.ROI.ENABLED || !srcW || !srcH) {
        return {
          x: 0, y: 0, w: srcW, h: srcH,
          css: { left: 0, top: 0, width: stageW, height: stageH },
        };
      }

      const scale = Math.max(stageW / srcW, stageH / srcH);
      const offX = (srcW * scale - stageW) / 2;
      const offY = (srcH * scale - stageH) / 2;

      const cssW = stageW * CONFIG.ROI.WIDTH;
      const cssH = stageH * CONFIG.ROI.HEIGHT;
      const cssX = (stageW - cssW) / 2;
      const cssY = stageH * CONFIG.ROI.CENTER_Y - cssH / 2;

      const clamp = (v, min, max) => Math.max(min, Math.min(max, v));
      const x = clamp((cssX + offX) / scale, 0, srcW - 1);
      const y = clamp((cssY + offY) / scale, 0, srcH - 1);
      const w = clamp(cssW / scale, 1, srcW - x);
      const h = clamp(cssH / scale, 1, srcH - y);

      return {
        x: Math.round(x), y: Math.round(y), w: Math.round(w), h: Math.round(h),
        css: { left: cssX, top: cssY, width: cssW, height: cssH },
      };
    }

    /** ガイド枠のDOMを実際の位置に合わせる */
    layoutRoiGuide() {
      if (!this.roiGuide) return;
      const src = this.currentSource();
      if (!src.w || !src.h) return;
      const roi = this.computeRoi(src.w, src.h);
      const c = roi.css;
      this.roiGuide.style.left = c.left + 'px';
      this.roiGuide.style.top = c.top + 'px';
      this.roiGuide.style.width = c.width + 'px';
      this.roiGuide.style.height = c.height + 'px';
    }

    /** 現在の解析対象（ライブ映像 or 静止画キャンバス） */
    currentSource() {
      if (this.mode === 'still') {
        return { el: this.fullCanvas, w: this.fullCanvas.width, h: this.fullCanvas.height };
      }
      return { el: this.video, w: this.video.videoWidth, h: this.video.videoHeight };
    }

    /* ---------- モード ---------- */

    setMode(mode) {
      this.mode = mode;
      if (this.roiGuide) {
        this.roiGuide.classList.toggle('is-paused', mode !== 'live');
        this.roiGuide.classList.toggle('is-hidden', mode === 'idle');
      }
      this.onStatus(mode);
    }

    /* ---------- ループ ---------- */

    startLoops() {
      this.stopLoops();
      if (CONFIG.OCR.ENABLED && this.ocrWorker) this._scheduleOcr(300);
      if (this.codeReader) this._scheduleCode(120);
    }

    stopLoops() {
      clearTimeout(this.ocrTimer);
      clearTimeout(this.codeTimer);
      this.ocrTimer = null;
      this.codeTimer = null;
    }

    _scheduleOcr(delay) {
      this.ocrTimer = setTimeout(async () => {
        if (this.mode === 'live') {
          try {
            await this.runOcrOnce();
            this.ocrErrorCount = 0;
          } catch (e) {
            // 握りつぶすと「何も読めない」としか見えなくなるので必ず通知する
            this.ocrErrorCount = (this.ocrErrorCount || 0) + 1;
            console.error('[scanner] OCR error', e);
            this.onError(e, 'ocr', this.ocrErrorCount);
          }
        }
        if (this.ocrTimer !== null) this._scheduleOcr(CONFIG.OCR.INTERVAL_MS);
      }, delay);
    }

    _scheduleCode(delay) {
      this.codeTimer = setTimeout(() => {
        if (this.mode === 'live') {
          try {
            this.runCodeScanOnce();
          } catch (e) {
            console.error('[scanner] code error', e);
            this.onError(e, 'code', 0);
          }
        }
        if (this.codeTimer !== null) this._scheduleCode(CONFIG.CODE_SCAN_INTERVAL_MS);
      }, delay);
    }

    /* ---------- OCR ---------- */

    /**
     * ROI を切り出して前処理し、OCR を1回実行する。
     * @returns {Promise<string[]>} 採用された文字列
     */
    async runOcrOnce() {
      if (!this.ocrWorker || this.ocrBusy) return [];
      const src = this.currentSource();
      if (!src.w || !src.h) return [];

      this.ocrBusy = true;
      try {
        const roi = this.computeRoi(src.w, src.h);
        this._prepareOcrCanvas(src.el, roi);

        const res = await this._recognize(this.workCanvas);
        const words = extractWords(res.data);
        const accepted = this._acceptOcrWords(words);

        if (this.onDebug) {
          this.onDebug({
            source: { w: src.w, h: src.h },
            roi,
            ocrCanvas: this.workCanvas,
            text: res.data.text,
            words,
            accepted,
            rejected: this._lastRejected,
          });
        }
        return accepted;
      } finally {
        this.ocrBusy = false;
      }
    }

    /**
     * Tesseract に画像を渡して認識する。
     * canvas をそのまま渡せない環境（一部の iOS Safari など）があるため、
     * 失敗したら data URL に変換してやり直す。
     */
    async _recognize(canvas) {
      const opts = [{}, { blocks: true, text: true }];
      if (!this._useDataUrl) {
        try {
          return await this.ocrWorker.recognize(canvas, opts[0], opts[1]);
        } catch (e) {
          console.warn('[scanner] canvas 直渡しに失敗。data URL に切り替えます', e);
          this._useDataUrl = true;
        }
      }
      const url = canvas.toDataURL('image/png');
      return this.ocrWorker.recognize(url, opts[0], opts[1]);
    }

    /**
     * ROI を切り出し、OCR に適したサイズ・コントラストへ整える。
     * 小さすぎる文字は認識できないため、短辺が一定以上になるよう拡大する。
     */
    _prepareOcrCanvas(srcEl, roi) {
      // ROI を目標高さまで拡大する。文字が小さいと Tesseract は読めないため、
      // 小さい ROI ほど大きく引き伸ばす。
      const TARGET_H = CONFIG.OCR.TARGET_HEIGHT || 220;
      let scale = TARGET_H / roi.h;
      scale = Math.max(1, Math.min(scale, CONFIG.OCR.MAX_SCALE || 4));
      // 幅が大きくなりすぎないよう上限を設ける
      const MAX_W = CONFIG.OCR.MAX_WIDTH || 1400;
      if (roi.w * scale > MAX_W) scale = MAX_W / roi.w;

      const w = Math.max(1, Math.round(roi.w * scale));
      const h = Math.max(1, Math.round(roi.h * scale));
      this.workCanvas.width = w;
      this.workCanvas.height = h;

      const ctx = this.workCtx;
      ctx.imageSmoothingEnabled = true;
      ctx.imageSmoothingQuality = 'high';
      ctx.drawImage(srcEl, roi.x, roi.y, roi.w, roi.h, 0, 0, w, h);

      // グレースケール化 + コントラスト伸長
      try {
        const img = ctx.getImageData(0, 0, w, h);
        const d = img.data;
        let min = 255;
        let max = 0;
        for (let i = 0; i < d.length; i += 4) {
          const g = (d[i] * 0.299 + d[i + 1] * 0.587 + d[i + 2] * 0.114) | 0;
          d[i] = d[i + 1] = d[i + 2] = g;
          if (g < min) min = g;
          if (g > max) max = g;
        }
        const range = max - min;
        if (range > 20) {
          const k = 255 / range;
          for (let i = 0; i < d.length; i += 4) {
            const v = (d[i] - min) * k;
            const c = v < 0 ? 0 : v > 255 ? 255 : v;
            d[i] = d[i + 1] = d[i + 2] = c;
          }
        }
        ctx.putImageData(img, 0, 0);
      } catch (e) {
        // getImageData が失敗する環境では前処理をスキップ
        log('preprocess skipped', e);
      }
    }

    /** OCR単語をフィルタ・安定化して通知する */
    _acceptOcrWords(words) {
      const allow = allowRegexFor(CONFIG.OCR.MODE);
      const accepted = [];
      const rejected = [];

      for (const w of words) {
        // null は「端末が信頼度を返さなかった」= 不明。0（低品質）とは区別する。
        const conf = typeof w.confidence === 'number' ? w.confidence : null;
        const text = String(w.text || '').trim().replace(/\s+/g, '');
        if (!text) continue;

        // 落ちた理由を記録しておく（診断パネル用）
        const why = [];
        // 信頼度が不明な端末では、この条件で全滅しないよう判定をスキップする
        if (conf !== null && conf < CONFIG.OCR.MIN_CONFIDENCE) {
          why.push('信頼度' + conf.toFixed(0));
        }
        if (text.length < CONFIG.OCR.MIN_LENGTH) why.push('短い');
        if (text.length > CONFIG.OCR.MAX_LENGTH) why.push('長い');
        if (!allow.test(text)) why.push('許可外文字');
        // PATTERNS は複数登録できる。どれか1本に一致すれば通す（空配列 = 絞り込みなし）
        const patterns = CONFIG.OCR.PATTERNS;
        if (patterns && patterns.length && !patterns.some((re) => re.test(text))) {
          why.push('パターン不一致');
        }

        if (why.length) {
          rejected.push({ text, conf, why });
          continue;
        }
        if (!this._passStability(text)) {
          rejected.push({ text, conf, why: ['安定待ち'] });
          continue;
        }
        accepted.push(text);
        this._emit(text, 'ocr');
      }

      this._lastRejected = rejected;
      return accepted;
    }

    /**
     * 同じ文字列が規定回数連続で読めたときだけ true。
     * 手ブレによる一瞬の誤読を弾く。
     */
    _passStability(text) {
      const need = Math.max(1, CONFIG.OCR.STABLE_COUNT | 0);
      if (need === 1) return true;
      if (this.emitted.has(text)) return true;
      const n = (this.stableMap.get(text) || 0) + 1;
      this.stableMap.set(text, n);
      if (this.stableMap.size > 200) this.stableMap.clear();
      return n >= need;
    }

    _emit(text, source) {
      if (this.emitted.has(text)) return;
      this.emitted.add(text);
      this.onDetect(text, source);
    }

    /* ---------- バーコード / QR ---------- */

    /** 現在のフレームからコードを1回走査する */
    runCodeScanOnce() {
      if (!this.codeReader) return null;
      const src = this.currentSource();
      if (!src.w || !src.h) return null;

      // 走査用に縮小（大きすぎると重い）
      const MAX_EDGE = 900;
      const scale = Math.min(1, MAX_EDGE / Math.max(src.w, src.h));
      const w = Math.max(1, Math.round(src.w * scale));
      const h = Math.max(1, Math.round(src.h * scale));
      if (this.codeCanvas.width !== w || this.codeCanvas.height !== h) {
        this.codeCanvas.width = w;
        this.codeCanvas.height = h;
      }
      this.codeCtx.drawImage(src.el, 0, 0, w, h);

      const result = this._decodeCanvas(this.codeCanvas);
      if (!result) return null;

      const text = String(result.getText() || '').trim();
      if (!text) return null;
      const fmtName = ZXing.BarcodeFormat[result.getBarcodeFormat()] || '';
      const source = fmtName === 'QR_CODE' ? 'qr' : 'barcode';
      this._emit(text, source);
      return { text, source };
    }

    _decodeCanvas(canvas) {
      try {
        const luminance = new ZXing.HTMLCanvasElementLuminanceSource(canvas);
        const binary = new ZXing.BinaryBitmap(new ZXing.HybridBinarizer(luminance));
        return this.codeReader.decode(binary);
      } catch (e) {
        // NotFoundException は「見つからなかった」だけなので無視
        return null;
      } finally {
        if (this.codeReader.reset) this.codeReader.reset();
      }
    }

    /* ---------- 撮影 ---------- */

    /**
     * 現在のフレームを静止画として確定し、静止画に対して1回だけ認識を行う。
     * @returns {Promise<{results: string[]}>}
     */
    async capture() {
      const vw = this.video.videoWidth;
      const vh = this.video.videoHeight;
      if (!vw || !vh) throw new Error('カメラ映像がありません');

      // 既定では「画面に写っている範囲」だけを取り込む。
      // 映像は object-fit: cover で表示されており、はみ出した部分は
      // ユーザーには見えていないため、保存画像にも含めない。
      const vis = CONFIG.CAPTURE.CROP_TO_VIEW
        ? this.computeVisibleRect(vw, vh)
        : { x: 0, y: 0, w: vw, h: vh };

      this.fullCanvas.width = vis.w;
      this.fullCanvas.height = vis.h;
      this.fullCtx.drawImage(
        this.video,
        vis.x, vis.y, vis.w, vis.h,
        0, 0, vis.w, vis.h
      );

      // 画面表示用キャンバス
      this.stillCanvas.width = vis.w;
      this.stillCanvas.height = vis.h;
      this.stillCanvas.getContext('2d').drawImage(this.fullCanvas, 0, 0);
      this.stillCanvas.hidden = false;

      this.stopLoops();
      this.setMode('still');

      // 送信用 JPEG を作成。
      // 写真保存なしモード（CONFIG.SAVE.MODE = 'text'）では画像を送らないので作らない。
      // このとき静止画は表示と静止画OCRのためだけに使う。
      this.capturedBlob = saveImageEnabled()
        ? await this._makeJpegBlob(this.fullCanvas)
        : null;

      // 静止画に対して1回だけ認識
      const results = [];
      try {
        const code = this.runCodeScanOnce();
        if (code) results.push(code.text);
      } catch (e) {
        log('still code error', e);
      }
      try {
        const ocr = await this.runOcrOnce();
        results.push(...ocr);
      } catch (e) {
        log('still ocr error', e);
      }
      return { results };
    }

    /**
     * 静止画を破棄してリアルタイム読み取りに戻る。
     * 映像が止まっていれば復旧を試み、それでも動かなければ false を返す
     * （呼び出し側でカメラを再起動する）。
     * @returns {Promise<boolean>}
     */
    async resumeLive() {
      this.stillCanvas.hidden = true;
      this.capturedBlob = null;
      this.setMode('live');
      const ok = await this.ensureLive();
      this.startLoops();
      return ok;
    }

    /**
     * ライブ映像が実際に更新されているか確認し、止まっていれば復旧を試みる。
     *
     * iPhone Safari で「送信 → クリア」のあと映像が静止したままになる不具合への対処。
     * 送信中オーバーレイ（backdrop-filter 付きの全画面要素）や confirm() のあと、
     * <video> が一時停止したり描画が更新されなくなることがある。
     *
     *   1. video.paused なら play() し直す
     *   2. それでもフレームが来なければ srcObject を付け直す（権限確認なしの軽い再起動）
     *   3. それでもだめ（トラックが ended / muted のまま）なら false
     *
     * @returns {Promise<boolean>} 映像が更新されていれば true
     */
    async ensureLive() {
      if (!this.stream || !this.track) return false;
      if (this.track.readyState !== 'live') {
        log('track not live:', this.track.readyState);
        return false;
      }

      if (this.video.paused) {
        try { await this.video.play(); } catch (e) { log('play failed', e && e.name); }
      }
      if (await this._waitForFrame(600)) return true;

      // フレームが来ない: ストリームを付け直して映像パイプラインを作り直す
      log('video frozen; reattach stream');
      const stream = this.stream;
      this.video.srcObject = null;
      this.video.srcObject = stream;
      try { await this.video.play(); } catch (e) { log('play failed', e && e.name); }
      const ok = await this._waitForFrame(1000);
      if (!ok) log('video still frozen (track muted=' + this.track.muted + ')');
      return ok;
    }

    /**
     * 新しい映像フレームが来るまで待つ。
     * requestVideoFrameCallback（iOS 15.4+）があればそれを使い、
     * 無ければ currentTime の進みで代用する。
     * @param {number} timeoutMs
     * @returns {Promise<boolean>} タイムアウトまでにフレームが来たら true
     */
    _waitForFrame(timeoutMs) {
      const video = this.video;
      return new Promise((resolve) => {
        let done = false;
        const finish = (ok) => {
          if (done) return;
          done = true;
          clearTimeout(timer);
          if (handle !== null && video.cancelVideoFrameCallback) {
            video.cancelVideoFrameCallback(handle);
          }
          resolve(ok);
        };
        const timer = setTimeout(() => finish(false), timeoutMs);
        let handle = null;

        if (typeof video.requestVideoFrameCallback === 'function') {
          handle = video.requestVideoFrameCallback(() => finish(true));
          return;
        }

        // フォールバック: currentTime が進んでいれば再生中とみなす
        const start = video.currentTime;
        const poll = () => {
          if (done) return;
          if (video.currentTime > start) return finish(true);
          setTimeout(poll, 100);
        };
        setTimeout(poll, 100);
      });
    }

    /** 撮影済み画像(JPEG Blob)。未撮影なら null */
    getCapturedBlob() {
      return this.capturedBlob;
    }

    _makeJpegBlob(canvas) {
      const maxEdge = CONFIG.CAPTURE.MAX_EDGE;
      const scale = Math.min(1, maxEdge / Math.max(canvas.width, canvas.height));
      let target = canvas;
      if (scale < 1) {
        target = document.createElement('canvas');
        target.width = Math.round(canvas.width * scale);
        target.height = Math.round(canvas.height * scale);
        const c = target.getContext('2d');
        c.imageSmoothingQuality = 'high';
        c.drawImage(canvas, 0, 0, target.width, target.height);
      }
      return new Promise((resolve) => {
        target.toBlob((b) => resolve(b), 'image/jpeg', CONFIG.CAPTURE.JPEG_QUALITY);
      });
    }

    /* ---------- リセット ---------- */

    /** 検出履歴をリセット（クリア操作用） */
    resetDetections() {
      this.stableMap.clear();
      this.emitted.clear();
    }

    /** 完全に片付ける */
    async destroy() {
      this.stopCamera();
      if (this.ocrWorker) {
        try { await this.ocrWorker.terminate(); } catch (e) { /* noop */ }
        this.ocrWorker = null;
      }
    }
  }

  global.Scanner = Scanner;
})(window);
