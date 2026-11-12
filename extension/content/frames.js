/* frames.js — find copyable frames (artboards / top-level sections) on the page. */
(() => {
  const C2F = window.C2F;
  if (C2F.findFrames) return;

  // Explicit artboard markers first; the structural heuristic below covers everything else.
  const MARKERS = [
    '[data-c2f-frame]',
    '[data-frame]',
    '[data-frame-id]',
    '[data-artboard]',
    '[data-artboard-id]',
    '[data-board]',
    '.artboard',
    '.frame'
  ].join(',');

  const registry = new Map();
  const ids = new WeakMap();
  let seq = 0;

  function register(el) {
    let id = ids.get(el);
    if (!id) {
      id = 'f' + ++seq;
      ids.set(el, id);
      registry.set(id, new WeakRef(el));
    }
    return id;
  }

  C2F.frameById = (id) => {
    const ref = registry.get(id);
    const el = ref && ref.deref();
    return el && el.isConnected ? el : null;
  };

  function visible(el, minW = 2, minH = 2) {
    if (el.id === C2F.HOST_ID) return false;
    const r = el.getBoundingClientRect();
    if (r.width < minW || r.height < minH) return false;
    const cs = getComputedStyle(el);
    return cs.display !== 'none' && cs.visibility !== 'hidden' && +cs.opacity > 0;
  }

  const SKIP = /^(SCRIPT|STYLE|NOSCRIPT|TEMPLATE|LINK|META)$/;
  const significant = (el) =>
    [...el.children].filter((c) => !SKIP.test(c.tagName) && visible(c, 40, 24));

  /** Has its own painted box (fill, image, border or shadow) — i.e. looks like an artboard/card. */
  function painted(el) {
    if (el.tagName === 'IMG' || el instanceof SVGElement) return false;
    const cs = getComputedStyle(el);
    const bg = cs.backgroundColor;
    return (
      (bg && bg !== 'transparent' && !/rgba\(.*,\s*0\)$/.test(bg)) ||
      cs.backgroundImage !== 'none' ||
      cs.boxShadow !== 'none' ||
      ['Top', 'Right', 'Bottom', 'Left'].some(
        (s) => parseFloat(cs[`border${s}Width`]) > 0 && cs[`border${s}Style`] !== 'none'
      )
    );
  }

  // Outermost painted boxes, looking through unstyled wrappers (canvas → artboards).
  function collectBoxes(el, depth, out) {
    for (const c of significant(el)) {
      if ((painted(c) || /^I?FRAME$/.test(c.tagName)) && visible(c, 60, 60)) out.push(c);
      else if (depth < 4) collectBoxes(c, depth + 1, out);
    }
    return out;
  }

  function heuristic() {
    const body = document.body;
    if (!body) return [];
    let page = body;
    let kids = significant(page);
    while (kids.length === 1) {
      page = kids[0];
      kids = significant(page);
    }
    const boxes = collectBoxes(page, 0, []);
    const rest = boxes.length ? boxes : kids.filter((k) => visible(k, 80, 40));
    return [page, ...rest.filter((e) => e !== page)];
  }

  C2F.findFrameElements = () => {
    let els = [...document.querySelectorAll(MARKERS)].filter((e) => visible(e, 40, 40));
    els = els.filter((e) => !els.some((o) => o !== e && o.contains(e)));
    if (!els.length) els = heuristic();
    return els.slice(0, 40);
  };

  C2F.findFrames = () =>
    C2F.findFrameElements().map((el) => {
      const r = el.getBoundingClientRect();
      return {
        id: register(el),
        name: el === document.body ? 'Page' : C2F.nameOf(el),
        w: Math.round(el.offsetWidth || r.width),
        h: Math.round(el.offsetHeight || r.height),
        top: window === window.top
      };
    });

  /** Best frame for a right-click target: smallest detected frame containing it. */
  C2F.frameForTarget = (target) => {
    let el = target && target.nodeType === 3 ? target.parentElement : target;
    if (!el || !(el instanceof Element)) return document.body;
    if (el instanceof SVGElement) {
      while (el.parentElement instanceof SVGElement) el = el.parentElement;
    }
    let best = null;
    let bestArea = Infinity;
    for (const f of C2F.findFrameElements()) {
      if (f !== el && !f.contains(el)) continue;
      const r = f.getBoundingClientRect();
      const a = r.width * r.height;
      if (a < bestArea) {
        best = f;
        bestArea = a;
      }
    }
    if (best) return best;
    let e = el;
    while (e && e !== document.body) {
      const r = e.getBoundingClientRect();
      if (r.width >= 120 && r.height >= 120) return e;
      e = e.parentElement;
    }
    return document.body;
  };
})();
