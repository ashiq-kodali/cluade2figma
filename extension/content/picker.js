/* picker.js — hover/click frame picker, floating toolbar, toast, and message handling. */
(() => {
  const C2F = window.C2F;
  if (C2F.pickerLoaded) return;
  C2F.pickerLoaded = true;

  const IS_MAC = /Mac|iPhone|iPad/.test(navigator.platform);
  const PASTE = IS_MAC ? '⌘V' : 'Ctrl+V';
  const IS_TOP = window === window.top;

  let host = null;
  let ui = {};
  let active = false;
  let locked = false;
  let current = null;
  let highlightEl = null;
  let token = null;
  let lastPoint = null;
  let lastContextTarget = null;
  let toastTimer = null;
  let busy = false;

  const CSS = `
    :host { all: initial; }
    .box { position: fixed; pointer-events: none; border: 2px solid #D97757; background: rgba(217,119,87,.08);
      border-radius: 2px; box-sizing: border-box; display: none; transition: all 60ms ease-out; }
    .box.locked { border-style: solid; background: rgba(217,119,87,.12); box-shadow: 0 0 0 1px rgba(255,255,255,.6); }
    .label { position: fixed; pointer-events: none; display: none; background: #D97757; color: #fff;
      font: 600 11px/1 ui-sans-serif, system-ui, -apple-system, sans-serif; padding: 4px 6px; border-radius: 4px;
      white-space: nowrap; max-width: 60vw; overflow: hidden; text-overflow: ellipsis; }
    .label .dim { opacity: .8; font-weight: 500; }
    .bar { position: fixed; display: none; pointer-events: auto; align-items: center; gap: 4px; padding: 4px;
      background: #1f1e1d; border-radius: 10px; box-shadow: 0 8px 24px rgba(0,0,0,.25), 0 0 0 1px rgba(255,255,255,.08);
      font: 500 12px/1 ui-sans-serif, system-ui, -apple-system, sans-serif; color: #f5f4ef; }
    .bar button { all: unset; cursor: pointer; padding: 7px 10px; border-radius: 7px; color: #f5f4ef; white-space: nowrap; }
    .bar button:hover { background: rgba(255,255,255,.1); }
    .bar button.primary { background: #D97757; color: #fff; }
    .bar button.primary:hover { background: #c4643f; }
    .bar button.icon { padding: 7px 8px; font-size: 13px; }
    .bar button[disabled] { opacity: .5; pointer-events: none; }
    .bar .sep { width: 1px; height: 18px; background: rgba(255,255,255,.15); margin: 0 2px; }
    .toast { position: fixed; left: 50%; top: 16px; transform: translateX(-50%) translateY(-8px); opacity: 0;
      pointer-events: none; background: #1f1e1d; color: #f5f4ef; padding: 10px 14px; border-radius: 10px;
      font: 500 13px/1.3 ui-sans-serif, system-ui, -apple-system, sans-serif; box-shadow: 0 8px 24px rgba(0,0,0,.25);
      transition: opacity 150ms, transform 150ms; max-width: 80vw; }
    .toast.show { opacity: 1; transform: translateX(-50%) translateY(0); }
    .toast.err { background: #8f2d1f; }
    .toast kbd { font: inherit; background: rgba(255,255,255,.15); padding: 1px 5px; border-radius: 4px; }
  `;

  function ensureUI() {
    if (host && host.isConnected) return;
    host = document.createElement('div');
    host.id = C2F.HOST_ID;
    host.style.cssText = 'all:initial;position:fixed;inset:0;pointer-events:none;z-index:2147483647;';
    const root = host.attachShadow({ mode: 'open' });
    root.innerHTML = `<style>${CSS}</style>
      <div class="box"></div>
      <div class="label"></div>
      <div class="bar" role="toolbar" aria-label="Copy frame to Figma">
        <button class="icon" data-a="up" title="Select parent (↑)">↑</button>
        <button class="icon" data-a="down" title="Select child (↓)">↓</button>
        <button data-a="whole" title="Select the whole frame (Shift+↑)">Whole frame</button>
        <span class="sep"></span>
        <button class="primary" data-a="copy" title="Copy, then ${PASTE} in Figma (Enter)">Copy to Figma</button>
        <button class="icon" data-a="cancel" title="Cancel (Esc)">✕</button>
      </div>
      <div class="toast" role="status"></div>`;
    ui = {
      box: root.querySelector('.box'),
      label: root.querySelector('.label'),
      bar: root.querySelector('.bar'),
      toast: root.querySelector('.toast')
    };
    ui.bar.addEventListener('click', (e) => {
      const b = e.target.closest('button');
      if (!b) return;
      e.stopPropagation();
      const a = b.dataset.a;
      if (a === 'up') move(-1);
      else if (a === 'down') move(1);
      else if (a === 'whole') selectWhole();
      else if (a === 'cancel') cancelAll();
      else if (a === 'copy') copyFromBar();
    });
    (document.documentElement || document.body).appendChild(host);
  }

  /* ---------- positioning ---------- */
  function place() {
    const el = current || highlightEl;
    if (!el || !el.isConnected || !ui.box) {
      hideBox();
      return;
    }
    const r = el.getBoundingClientRect();
    Object.assign(ui.box.style, {
      display: 'block',
      left: r.left + 'px',
      top: r.top + 'px',
      width: r.width + 'px',
      height: r.height + 'px'
    });
    ui.box.classList.toggle('locked', locked);
    const w = Math.round(el.offsetWidth || r.width);
    const h = Math.round(el.offsetHeight || r.height);
    const name = el === document.body ? 'Page' : C2F.nameOf(el);
    ui.label.innerHTML = '';
    ui.label.append(document.createTextNode(name + ' '));
    const dim = document.createElement('span');
    dim.className = 'dim';
    dim.textContent = `${w} × ${h}`;
    ui.label.append(dim);
    ui.label.style.display = 'block';
    const lh = 20;
    ui.label.style.left = Math.max(4, r.left) + 'px';
    ui.label.style.top = (r.top - lh - 4 > 4 ? r.top - lh - 4 : Math.max(4, r.top + 4)) + 'px';

    if (locked) {
      ui.bar.style.display = 'flex';
      const bw = ui.bar.offsetWidth;
      const bh = ui.bar.offsetHeight;
      const vw = window.innerWidth;
      const vh = window.innerHeight;
      let top = r.bottom + 8;
      if (top + bh > vh - 8) top = r.top - bh - 30;
      if (top < 8) top = Math.min(vh - bh - 8, Math.max(8, r.top + 8));
      const left = Math.min(vw - bw - 8, Math.max(8, r.left));
      ui.bar.style.left = left + 'px';
      ui.bar.style.top = top + 'px';
    } else {
      ui.bar.style.display = 'none';
    }
  }

  function hideBox() {
    if (!ui.box) return;
    ui.box.style.display = 'none';
    ui.label.style.display = 'none';
    ui.bar.style.display = 'none';
  }

  let raf = 0;
  const schedulePlace = () => {
    if (raf) return;
    raf = requestAnimationFrame(() => {
      raf = 0;
      place();
    });
  };

  /* ---------- picking ---------- */
  function isOurs(e) {
    return host && e.composedPath().includes(host);
  }

  function pickable(el) {
    if (!el || el === host || el.id === C2F.HOST_ID) return null;
    if (el.tagName === 'IFRAME' || el.tagName === 'FRAME') return null; // the frame's own picker handles it
    if (el instanceof SVGElement) {
      while (el.parentElement instanceof SVGElement) el = el.parentElement;
    }
    if (el === document.documentElement) return document.body;
    return el;
  }

  function onMove(e) {
    if (!active) return;
    if (!document.hasFocus()) {
      try {
        window.focus();
      } catch (err) {
        /* ignore */
      }
    }
    if (locked || isOurs(e)) return;
    lastPoint = { x: e.clientX, y: e.clientY };
    const el = pickable(document.elementFromPoint(e.clientX, e.clientY));
    if (el !== current) {
      current = el;
      schedulePlace();
    }
  }

  function swallow(e) {
    if (!active || isOurs(e)) return;
    e.preventDefault();
    e.stopImmediatePropagation();
  }

  function onClick(e) {
    if (!active || isOurs(e)) return;
    e.preventDefault();
    e.stopImmediatePropagation();
    lastPoint = { x: e.clientX, y: e.clientY };
    const el = pickable(document.elementFromPoint(e.clientX, e.clientY));
    if (!el) return;
    current = el;
    locked = true;
    // Only one frame keeps its picker once something is selected.
    chrome.runtime.sendMessage({ type: 'c2f-picker-stop-all', except: token }).catch(() => {});
    place();
  }

  function onKey(e) {
    if (!active) return;
    const k = e.key;
    if (k === 'Escape') cancelAll();
    else if (k === 'ArrowUp' && e.shiftKey) selectWhole();
    else if (k === 'ArrowUp') move(-1);
    else if (k === 'ArrowDown') move(1);
    else if (k === 'Enter' && current) copyFromBar();
    else return;
    e.preventDefault();
    e.stopImmediatePropagation();
  }

  function move(dir) {
    if (!current) return;
    if (dir < 0) {
      const p = current.parentElement;
      if (p && p !== document.documentElement) current = p;
      else if (!IS_TOP) return handOffToParent();
    } else {
      const kids = [...current.children].filter((c) => {
        if (c.id === C2F.HOST_ID || /^(SCRIPT|STYLE|TEMPLATE)$/.test(c.tagName)) return false;
        const r = c.getBoundingClientRect();
        return r.width > 0 && r.height > 0;
      });
      let next = null;
      if (lastPoint) {
        next = kids.find((c) => {
          const r = c.getBoundingClientRect();
          return lastPoint.x >= r.left && lastPoint.x <= r.right && lastPoint.y >= r.top && lastPoint.y <= r.bottom;
        });
      }
      next = next || kids[0];
      if (next) current = pickable(next) || current;
    }
    if (!locked) {
      locked = true;
      chrome.runtime.sendMessage({ type: 'c2f-picker-stop-all', except: token }).catch(() => {});
    }
    place();
  }

  /** Jump from any element to the frame (artboard / design page) that contains it. */
  function wholeFrameOf(el) {
    let best = null;
    let bestArea = Infinity;
    for (const f of C2F.findFrameElements()) {
      if (f === el || !f.contains(el)) continue;
      const r = f.getBoundingClientRect();
      const a = r.width * r.height;
      if (a < bestArea) {
        best = f;
        bestArea = a;
      }
    }
    return best || document.body;
  }

  function selectWhole() {
    if (!current) return;
    const next = wholeFrameOf(current);
    // Already at the top of an embedded design frame: continue in the page around it.
    if (next === current && !IS_TOP) return handOffToParent();
    current = next;
    if (!locked) {
      locked = true;
      chrome.runtime.sendMessage({ type: 'c2f-picker-stop-all', except: token }).catch(() => {});
    }
    place();
  }

  /** Pass the selection up to the page that embeds this frame (it selects the <iframe>). */
  function handOffToParent() {
    try {
      window.parent.postMessage({ c2fSelectParentFrame: true }, '*');
    } catch (e) {
      return;
    }
    stop();
  }

  // A child frame handed its selection up: select the <iframe> holding it.
  window.addEventListener('message', (e) => {
    if (!e.data || e.data.c2fSelectParentFrame !== true) return;
    const iframe = [...document.querySelectorAll('iframe, frame')].find((f) => {
      try {
        return f.contentWindow === e.source;
      } catch (err) {
        return false;
      }
    });
    if (!iframe) return;
    if (!active) start();
    current = iframe;
    lastPoint = null;
    if (!locked) {
      locked = true;
      chrome.runtime.sendMessage({ type: 'c2f-picker-stop-all', except: token }).catch(() => {});
    }
    try {
      window.focus();
    } catch (err) {
      /* ignore */
    }
    place();
  });

  const MOUSE_BLOCK = ['mousedown', 'mouseup', 'pointerdown', 'pointerup', 'dblclick', 'auxclick'];
  let cursorStyle = null;

  function start() {
    if (active) return;
    ensureUI();
    active = true;
    locked = false;
    current = null;
    highlightEl = null;
    token = Math.random().toString(36).slice(2);
    window.addEventListener('mousemove', onMove, true);
    window.addEventListener('click', onClick, true);
    MOUSE_BLOCK.forEach((t) => window.addEventListener(t, swallow, true));
    window.addEventListener('keydown', onKey, true);
    window.addEventListener('scroll', schedulePlace, true);
    window.addEventListener('resize', schedulePlace, true);
    cursorStyle = document.createElement('style');
    cursorStyle.textContent = '*{cursor:crosshair!important}';
    (document.head || document.documentElement).appendChild(cursorStyle);
    if (IS_TOP) {
      toast(
        `Click inside a frame · <kbd>Shift</kbd><kbd>↑</kbd> whole frame · <kbd>↑</kbd><kbd>↓</kbd> parent / child · <kbd>Esc</kbd> cancel`,
        false,
        4000
      );
    }
  }

  function stop() {
    if (!active) return;
    active = false;
    locked = false;
    current = null;
    window.removeEventListener('mousemove', onMove, true);
    window.removeEventListener('click', onClick, true);
    MOUSE_BLOCK.forEach((t) => window.removeEventListener(t, swallow, true));
    window.removeEventListener('keydown', onKey, true);
    window.removeEventListener('scroll', schedulePlace, true);
    window.removeEventListener('resize', schedulePlace, true);
    if (cursorStyle) cursorStyle.remove();
    cursorStyle = null;
    hideBox();
  }

  function cancelAll() {
    stop();
    chrome.runtime.sendMessage({ type: 'c2f-picker-stop-all', except: null }).catch(() => {});
  }

  /* ---------- copy ---------- */
  async function copyEl(el) {
    if (!el) return { ok: false, error: 'Frame not found — refresh the list' };
    try {
      const text = await C2F.buildClipboard(el);
      const res = await chrome.runtime.sendMessage({ type: 'c2f-copy-text', text });
      if (!res || !res.ok) throw new Error((res && res.error) || 'Clipboard write failed');
      return { ok: true, bytes: text.length };
    } catch (e) {
      return { ok: false, error: (e && e.message) || String(e) };
    }
  }

  const COPIED = `Copied ✓ — press <kbd>${PASTE}</kbd> in Figma`;

  async function copyFromBar() {
    if (busy || !current) return;
    busy = true;
    const el = current;
    ui.bar.querySelectorAll('button').forEach((b) => (b.disabled = true));
    toast('Copying…', false, 0);
    const r = await copyEl(el);
    ui.bar.querySelectorAll('button').forEach((b) => (b.disabled = false));
    busy = false;
    if (r.ok) {
      stop();
      flash(el);
      toast(COPIED);
    } else toast('Copy failed: ' + escapeHtml(r.error), true);
  }

  function flash(el) {
    highlightEl = el;
    place();
    setTimeout(() => {
      if (highlightEl === el && !active) {
        highlightEl = null;
        hideBox();
      }
    }, 700);
  }

  const escapeHtml = (s) => String(s).replace(/[&<>"]/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;' })[c]);

  function toast(html, err = false, ms = 2800) {
    ensureUI();
    ui.toast.innerHTML = html;
    ui.toast.classList.toggle('err', !!err);
    ui.toast.classList.add('show');
    clearTimeout(toastTimer);
    if (ms) toastTimer = setTimeout(() => ui.toast.classList.remove('show'), ms);
  }

  /* ---------- messages ---------- */
  document.addEventListener(
    'contextmenu',
    (e) => {
      lastContextTarget = e.composedPath()[0];
    },
    true
  );

  chrome.runtime.onMessage.addListener((msg, _sender, sendResponse) => {
    if (!msg || typeof msg.type !== 'string') return;
    switch (msg.type) {
      case 'c2f-start-picker':
        start();
        return;
      case 'c2f-picker-stop':
        if (!active || msg.except !== token) stop();
        return;
      case 'c2f-highlight': {
        if (active) return;
        const el = C2F.frameById(msg.id);
        if (!el) return;
        ensureUI();
        const r = el.getBoundingClientRect();
        if (r.bottom < 0 || r.top > window.innerHeight) el.scrollIntoView({ block: 'nearest', behavior: 'smooth' });
        highlightEl = el;
        place();
        setTimeout(schedulePlace, 350);
        return;
      }
      case 'c2f-unhighlight':
        if (!active) {
          highlightEl = null;
          hideBox();
        }
        return;
      case 'c2f-copy-frame': {
        const el = C2F.frameById(msg.id);
        copyEl(el).then((r) => {
          if (r.ok) flash(el);
          sendResponse(r);
        });
        return true;
      }
      case 'c2f-context-copy': {
        const el = C2F.frameForTarget(lastContextTarget);
        toast('Copying…', false, 0);
        copyEl(el).then((r) => {
          if (r.ok) {
            flash(el);
            toast(COPIED);
          } else toast('Copy failed: ' + escapeHtml(r.error), true);
        });
        return;
      }
    }
  });

  C2F.ready = true;
})();
