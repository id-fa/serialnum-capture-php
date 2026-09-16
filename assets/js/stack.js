/* ============================================================
   stack.js
   スタック（選択済み文字列）の保持・描画・並び替え
   モバイルでは HTML5 Drag&Drop が効かないため、
   Pointer Events で並び替えを実装している。
   ============================================================ */

(function (global) {
  'use strict';

  const ITEM_GAP = 6; // CSS の .stack-item margin-bottom と合わせる

  class StackList {
    /**
     * @param {HTMLElement} listEl  <ul>
     * @param {object} handlers { onChange }
     */
    constructor(listEl, handlers) {
      this.el = listEl;
      this.onChange = (handlers && handlers.onChange) || function () {};
      this.items = [];
      this.seq = 0;

      this.drag = null;
      this._bindDelegates();
    }

    /* ---------- データ操作 ---------- */

    /**
     * 文字列を追加する。既に同じ文字列があれば追加しない。
     * @returns {'added'|'duplicated'}
     */
    add(text) {
      const t = String(text || '').trim();
      if (!t) return 'duplicated';
      if (this.items.some((it) => it.text === t)) return 'duplicated';
      this.items.push({ id: 'sk' + ++this.seq, text: t, isNew: true });
      this.render();
      this.onChange(this.getTexts());
      return 'added';
    }

    /**
     * 複数の文字列を順番どおりに追加する。空文字と既にあるものは飛ばす。
     * 描画と onChange は 1 回だけ。
     * @param {string[]} texts
     * @returns {number} 追加できた件数
     */
    addMany(texts) {
      let added = 0;
      for (const raw of texts || []) {
        const t = String(raw || '').trim();
        if (!t) continue;
        if (this.items.some((it) => it.text === t)) continue;
        this.items.push({ id: 'sk' + ++this.seq, text: t, isNew: true });
        added++;
      }
      if (added > 0) {
        this.render();
        this.onChange(this.getTexts());
      }
      return added;
    }

    remove(id) {
      const i = this.items.findIndex((it) => it.id === id);
      if (i < 0) return;
      this.items.splice(i, 1);
      this.render();
      this.onChange(this.getTexts());
    }

    clear() {
      this.items = [];
      this.render();
      this.onChange(this.getTexts());
    }

    move(from, to) {
      if (from === to) return;
      const [it] = this.items.splice(from, 1);
      this.items.splice(to, 0, it);
      this.render();
      this.onChange(this.getTexts());
    }

    getTexts() {
      return this.items.map((it) => it.text);
    }

    has(text) {
      return this.items.some((it) => it.text === text);
    }

    get length() {
      return this.items.length;
    }

    /* ---------- 描画 ---------- */

    render() {
      this.el.innerHTML = '';
      const frag = document.createDocumentFragment();

      this.items.forEach((item, index) => {
        const li = document.createElement('li');
        li.className = 'stack-item' + (item.isNew ? ' is-new' : '');
        li.dataset.id = item.id;
        li.dataset.index = String(index);
        item.isNew = false;

        const handle = document.createElement('span');
        handle.className = 'stack-item__handle';
        handle.textContent = '≡';
        handle.setAttribute('aria-label', 'ドラッグして並び替え');

        const no = document.createElement('span');
        no.className = 'stack-item__no';
        no.textContent = String(index + 1);

        const text = document.createElement('span');
        text.className = 'stack-item__text';
        text.textContent = item.text;

        const del = document.createElement('button');
        del.type = 'button';
        del.className = 'stack-item__del';
        del.dataset.action = 'delete';
        del.textContent = '✕';
        del.setAttribute('aria-label', item.text + ' を削除');

        li.append(handle, no, text, del);
        frag.appendChild(li);
      });

      this.el.appendChild(frag);
    }

    /* ---------- イベント ---------- */

    _bindDelegates() {
      // 削除
      this.el.addEventListener('click', (e) => {
        const btn = e.target.closest('[data-action="delete"]');
        if (!btn) return;
        const li = btn.closest('.stack-item');
        if (li) this.remove(li.dataset.id);
      });

      // 並び替え開始
      this.el.addEventListener('pointerdown', (e) => {
        const handle = e.target.closest('.stack-item__handle');
        if (!handle) return;
        const li = handle.closest('.stack-item');
        if (!li || this.items.length < 2) return;
        e.preventDefault();
        this._startDrag(e, li, handle);
      });
    }

    _startDrag(e, li, handle) {
      const lis = Array.from(this.el.children);
      const rects = lis.map((el) => el.getBoundingClientRect());
      const fromIndex = lis.indexOf(li);
      const step =
        rects.length > 1
          ? rects[1].top - rects[0].top
          : rects[0].height + ITEM_GAP;

      this.drag = {
        li,
        lis,
        rects,
        step,
        fromIndex,
        toIndex: fromIndex,
        startY: e.clientY,
        startScrollY: this._scrollOffset(),
        pointerId: e.pointerId,
        handle,
      };

      li.classList.add('is-dragging');
      try {
        handle.setPointerCapture(e.pointerId);
      } catch (err) {
        /* 一部ブラウザでは失敗しうるので無視 */
      }

      this._onMove = this._onMove.bind(this);
      this._onEnd = this._onEnd.bind(this);
      handle.addEventListener('pointermove', this._onMove);
      handle.addEventListener('pointerup', this._onEnd);
      handle.addEventListener('pointercancel', this._onEnd);
    }

    /**
     * リストを含むスクロール量の合計（縦）。
     * 本文は .app-main の内側でスクロールするため window.scrollY だけでは足りない。
     * 祖先要素の scrollTop を全部足すので、どちらのレイアウトでも正しく補正できる。
     */
    _scrollOffset() {
      let y = window.scrollY;
      for (let el = this.el.parentElement; el; el = el.parentElement) {
        y += el.scrollTop || 0;
      }
      return y;
    }

    _onMove(e) {
      const d = this.drag;
      if (!d || e.pointerId !== d.pointerId) return;
      e.preventDefault();

      // ドラッグ中にページがスクロールしてもズレないよう補正する
      const dy = e.clientY - d.startY + (this._scrollOffset() - d.startScrollY);
      d.li.style.transform = 'translateY(' + dy + 'px)';

      const raw = d.fromIndex + dy / d.step;
      const to = Math.max(0, Math.min(d.lis.length - 1, Math.round(raw)));
      if (to === d.toIndex) return;
      d.toIndex = to;

      // ドラッグ中の要素が入る隙間を作るため、他の要素をずらす
      d.lis.forEach((el, i) => {
        if (i === d.fromIndex) return;
        let shift = 0;
        if (d.fromIndex < to && i > d.fromIndex && i <= to) shift = -d.step;
        else if (d.fromIndex > to && i >= to && i < d.fromIndex) shift = d.step;
        el.style.transform = shift ? 'translateY(' + shift + 'px)' : '';
      });
    }

    _onEnd(e) {
      const d = this.drag;
      if (!d) return;
      const handle = d.handle;
      handle.removeEventListener('pointermove', this._onMove);
      handle.removeEventListener('pointerup', this._onEnd);
      handle.removeEventListener('pointercancel', this._onEnd);
      try {
        handle.releasePointerCapture(d.pointerId);
      } catch (err) {
        /* noop */
      }

      d.lis.forEach((el) => {
        el.style.transform = '';
        el.classList.remove('is-dragging');
      });
      this.drag = null;

      if (d.toIndex !== d.fromIndex) {
        this.move(d.fromIndex, d.toIndex);
      }
    }
  }

  global.StackList = StackList;
})(window);
