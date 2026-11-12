/* serialize.js — DOM subtree → layer tree, turned into SVG by to-svg.js.
 *
 * Node shapes (coordinates are relative to the parent node after relativize()):
 *   FRAME  {type,name,x,y,w,h,fills,strokes,radius[4],shadows,opacity,clip,abs,children}
 *   TEXT   {type,name,x,y,w,h,characters,styles,ranges,align,multiLine,lines,opacity,abs}
 *   VECTOR {type,name,x,y,w,h,svg,opacity,abs}
 */
(() => {
  const C2F = window.C2F;
  if (C2F.serialize) return;

  const SKIP_TAGS = new Set([
    'SCRIPT', 'STYLE', 'NOSCRIPT', 'TEMPLATE', 'META', 'LINK', 'HEAD', 'TITLE', 'BASE',
    'PARAM', 'SOURCE', 'TRACK', 'DATALIST', 'OPTION', 'OPTGROUP', 'AREA', 'MAP'
  ]);
  const REPLACED = new Set([
    'IMG', 'SVG', 'CANVAS', 'VIDEO', 'IFRAME', 'INPUT', 'TEXTAREA', 'SELECT', 'OBJECT',
    'EMBED', 'AUDIO', 'METER', 'PROGRESS', 'BUTTON'
  ]);

  const px = (v) => parseFloat(v) || 0;
  const r2 = (v) => Math.round(v * 100) / 100;

  /* ---------------- colors ---------------- */
  let cctx = null;
  const colorCache = new Map();

  /** Any CSS color → {r,g,b,a} in 0..1. Returns null for fully transparent unless keep=true. */
  function parseColor(str, keep) {
    if (!str || str === 'none') return null;
    let res;
    if (colorCache.has(str)) res = colorCache.get(str);
    else {
      res = null;
      if (str === 'transparent') res = { r: 0, g: 0, b: 0, a: 0 };
      else {
        const m = str.match(
          /^rgba?\(\s*([\d.]+)[,\s]+([\d.]+)[,\s]+([\d.]+)(?:\s*[,/]\s*([\d.]+%?))?\s*\)$/
        );
        if (m) {
          const a = m[4] === undefined ? 1 : m[4].endsWith('%') ? parseFloat(m[4]) / 100 : parseFloat(m[4]);
          res = { r: m[1] / 255, g: m[2] / 255, b: m[3] / 255, a };
        } else {
          // oklch(), color(), lab(), hsl()… — let the browser rasterize it.
          if (!cctx) {
            const c = document.createElement('canvas');
            c.width = c.height = 1;
            cctx = c.getContext('2d', { willReadFrequently: true });
          }
          cctx.clearRect(0, 0, 1, 1);
          cctx.fillStyle = '#000';
          cctx.fillStyle = str;
          cctx.fillRect(0, 0, 1, 1);
          const d = cctx.getImageData(0, 0, 1, 1).data;
          res = { r: d[0] / 255, g: d[1] / 255, b: d[2] / 255, a: d[3] / 255 };
        }
      }
      colorCache.set(str, res);
    }
    if (!res) return null;
    if (!keep && res.a <= 0.003) return null;
    return { r: res.r, g: res.g, b: res.b, a: r2(res.a) };
  }

  /** Split on a separator at parenthesis depth 0. */
  function splitTop(str, sep = ',') {
    const out = [];
    let depth = 0;
    let cur = '';
    for (const ch of str) {
      if (ch === '(') depth++;
      else if (ch === ')') depth--;
      if (ch === sep && depth === 0) {
        out.push(cur);
        cur = '';
      } else cur += ch;
    }
    if (cur.trim()) out.push(cur);
    return out.map((s) => s.trim()).filter(Boolean);
  }

  /* ---------------- gradients ---------------- */
  const DIRS = {
    'to top': 0, 'to right': 90, 'to bottom': 180, 'to left': 270,
    'to top right': 45, 'to right top': 45, 'to bottom right': 135, 'to right bottom': 135,
    'to bottom left': 225, 'to left bottom': 225, 'to top left': 315, 'to left top': 315
  };

  function parseAngle(tok) {
    const m = tok.match(/^(-?[\d.]+)(deg|turn|rad|grad)$/);
    if (!m) return null;
    const v = parseFloat(m[1]);
    switch (m[2]) {
      case 'turn': return v * 360;
      case 'rad': return (v * 180) / Math.PI;
      case 'grad': return v * 0.9;
      default: return v;
    }
  }

  function parseStops(args) {
    const stops = [];
    for (const a of args) {
      if (/^-?[\d.]+(%|px)?$/.test(a)) continue; // color hint
      let color;
      let rest;
      const i = a.lastIndexOf(')');
      if (i >= 0) {
        color = a.slice(0, i + 1);
        rest = a.slice(i + 1).trim();
      } else {
        const parts = a.split(/\s+/);
        color = parts[0];
        rest = parts.slice(1).join(' ');
      }
      const c = parseColor(color, true);
      if (!c) continue;
      const poss = rest ? rest.split(/\s+/).map((p) => (p.endsWith('%') ? parseFloat(p) / 100 : null)) : [null];
      for (const p of poss) stops.push({ pos: p, color: { ...c } });
    }
    if (!stops.length) return stops;
    if (stops[0].pos == null) stops[0].pos = 0;
    if (stops[stops.length - 1].pos == null) stops[stops.length - 1].pos = 1;
    for (let i = 1; i < stops.length - 1; i++) {
      if (stops[i].pos != null) continue;
      let j = i + 1;
      while (stops[j].pos == null) j++;
      const a = stops[i - 1].pos;
      const b = stops[j].pos;
      for (let k = i; k < j; k++) stops[k].pos = a + ((b - a) * (k - i + 1)) / (j - i + 1);
    }
    let prev = 0;
    for (const s of stops) {
      s.pos = r2(Math.min(1, Math.max(prev, s.pos)));
      prev = s.pos;
    }
    // Transparent stops take their neighbour's hue (CSS interpolates premultiplied).
    stops.forEach((s, i) => {
      if (s.color.a > 0) return;
      const n = stops.slice(i + 1).find((x) => x.color.a > 0) || stops.slice(0, i).reverse().find((x) => x.color.a > 0);
      if (n) Object.assign(s.color, { r: n.color.r, g: n.color.g, b: n.color.b });
    });
    return stops;
  }

  function parseGradient(layer) {
    const m = layer.match(/^(repeating-)?(linear|radial|conic)-gradient\(([\s\S]*)\)$/);
    if (!m) return null;
    const args = splitTop(m[3]);
    if (!args.length) return null;
    if (m[2] === 'linear') {
      let angle = 180;
      const a = parseAngle(args[0]);
      if (a != null) {
        angle = a;
        args.shift();
      } else if (args[0].startsWith('to ')) {
        angle = DIRS[args[0].replace(/\s+/g, ' ')] ?? 180;
        args.shift();
      }
      const stops = parseStops(args);
      return stops.length ? { type: 'GRADIENT_LINEAR', angle, stops } : null;
    }
    if (/circle|ellipse|closest|farthest|\bat\b|\bfrom\b/.test(args[0])) args.shift();
    const stops = parseStops(args);
    return stops.length ? { type: 'GRADIENT_RADIAL', stops } : null;
  }

  /* ---------------- shadows / radius ---------------- */
  function parseShadows(str) {
    if (!str || str === 'none') return [];
    const out = [];
    for (let s of splitTop(str)) {
      const inset = /\binset\b/.test(s);
      s = s.replace(/\binset\b/, '');
      let colorStr = 'rgb(0, 0, 0)';
      const cm = s.match(/[a-z-]+\([^)]*\)|#[0-9a-f]{3,8}\b/i);
      if (cm) {
        colorStr = cm[0];
        s = s.replace(cm[0], '');
      }
      const nums = (s.match(/-?[\d.]+(px)?/g) || []).map(parseFloat);
      const color = parseColor(colorStr);
      if (!color) continue;
      const [x = 0, y = 0, blur = 0, spread = 0] = nums;
      out.push({ type: inset ? 'INNER_SHADOW' : 'DROP_SHADOW', color, x, y, blur, spread });
    }
    return out.reverse();
  }

  function parseRadius(v, w, h) {
    const first = String(v || '0').trim().split(/\s+/)[0];
    let r = first.endsWith('%') ? (Math.min(w, h) * parseFloat(first)) / 100 : px(first);
    return r2(Math.max(0, Math.min(r, Math.min(w, h) / 2)));
  }

  /* ---------------- naming ---------------- */
  const TAG_NAMES = {
    H1: 'Heading 1', H2: 'Heading 2', H3: 'Heading 3', H4: 'Heading 4', H5: 'Heading 5', H6: 'Heading 6',
    P: 'Paragraph', BUTTON: 'Button', A: 'Link', NAV: 'Nav', HEADER: 'Header', FOOTER: 'Footer',
    SECTION: 'Section', MAIN: 'Main', ASIDE: 'Aside', ARTICLE: 'Article', UL: 'List', OL: 'List',
    LI: 'List item', IMG: 'Image', SVG: 'Icon', INPUT: 'Input', TEXTAREA: 'Text area', SELECT: 'Select',
    FORM: 'Form', LABEL: 'Label', TABLE: 'Table', TR: 'Row', TD: 'Cell', TH: 'Header cell',
    BODY: 'Page', FIGURE: 'Figure', CANVAS: 'Canvas', VIDEO: 'Video', IFRAME: 'Frame', HR: 'Divider'
  };

  function explicitName(el) {
    if (!el.getAttribute) return '';
    const v =
      el.getAttribute('data-name') ||
      el.getAttribute('data-c2f-name') ||
      el.getAttribute('aria-label') ||
      el.getAttribute('alt') ||
      el.getAttribute('title') ||
      (el.id && !/^[:\d]|^radix-|^headlessui-/.test(el.id) ? el.id : '');
    return (v || '').trim().slice(0, 60);
  }

  function nameOf(el) {
    return explicitName(el) || TAG_NAMES[el.tagName.toUpperCase()] || 'Frame';
  }
  C2F.nameOf = nameOf;

  /* ---------------- text ---------------- */
  function textStyle(cs) {
    const deco = cs.textDecorationLine || '';
    return {
      family: cs.fontFamily,
      weight: parseInt(cs.fontWeight, 10) || 400,
      italic: cs.fontStyle !== 'normal',
      size: px(cs.fontSize),
      lineHeight: cs.lineHeight === 'normal' ? null : r2(px(cs.lineHeight)),
      letterSpacing: cs.letterSpacing === 'normal' ? 0 : r2(px(cs.letterSpacing)),
      color: parseColor(cs.webkitTextFillColor) || parseColor(cs.color) || { r: 0, g: 0, b: 0, a: 1 },
      decoration: deco.includes('underline') ? 'UNDERLINE' : deco.includes('line-through') ? 'STRIKETHROUGH' : null
    };
  }

  let mctx = null;
  const metricsCache = new Map();
  function fontMetrics(st) {
    const font = `${st.italic ? 'italic ' : ''}${st.weight} ${st.size}px ${st.family}`;
    if (metricsCache.has(font)) return metricsCache.get(font);
    if (!mctx) mctx = document.createElement('canvas').getContext('2d');
    mctx.font = font;
    const m = mctx.measureText('Hxgjpé');
    const res = {
      asc: m.fontBoundingBoxAscent || st.size * 0.8,
      desc: m.fontBoundingBoxDescent || st.size * 0.2,
      font
    };
    metricsCache.set(font, res);
    return res;
  }
  function measure(st, text) {
    const m = fontMetrics(st);
    mctx.font = m.font;
    return mctx.measureText(text).width + (st.letterSpacing || 0) * text.length;
  }

  function applyTransform(text, tt) {
    if (tt === 'uppercase') return text.toUpperCase();
    if (tt === 'lowercase') return text.toLowerCase();
    if (tt === 'capitalize') return text.charAt(0).toUpperCase() + text.slice(1);
    return text;
  }

  function alignOf(cs) {
    const a = cs.textAlign;
    if (/center/.test(a)) return 'CENTER';
    if (a === 'right' || a === 'end' || a === '-webkit-right') return 'RIGHT';
    if (a === 'justify') return 'JUSTIFIED';
    return 'LEFT';
  }

  /** Build one TEXT node from a run of inline content (text nodes + inline elements). */
  function buildText(group, ownerEl, ctx) {
    const words = [];
    const styles = [];
    const styleIdx = new Map();
    const range = document.createRange();
    let pendingSpace = false;
    let pendingHard = false;

    const visit = (node) => {
      if (node.nodeType === 3) {
        const parent = node.parentElement;
        if (!parent) return;
        const cs = getComputedStyle(parent);
        if (cs.visibility === 'hidden' || +cs.opacity === 0) return;
        const st = textStyle(cs);
        const key = JSON.stringify(st);
        let si = styleIdx.get(key);
        if (si === undefined) {
          si = styles.length;
          styles.push(st);
          styleIdx.set(key, si);
        }
        const pre = /^(pre|pre-wrap|pre-line|break-spaces)$/.test(cs.whiteSpace);
        const data = node.data;
        const re = /\S+/g;
        let m;
        let last = 0;
        while ((m = re.exec(data))) {
          const gap = data.slice(last, m.index);
          if (gap.length) {
            pendingSpace = true;
            if (pre && gap.includes('\n')) pendingHard = true;
          }
          range.setStart(node, m.index);
          range.setEnd(node, m.index + m[0].length);
          const rects = range.getClientRects();
          const r = rects.length ? rects[0] : null;
          if (r && (r.width > 0 || r.height > 0)) {
            words.push({
              text: applyTransform(m[0], cs.textTransform),
              x: (r.left - ctx.ox) / ctx.scale,
              right: (r.left + (rects.length > 1 ? range.getBoundingClientRect().width : r.width) - ctx.ox) / ctx.scale,
              top: (r.top - ctx.oy) / ctx.scale,
              h: r.height / ctx.scale,
              s: si,
              space: pendingSpace,
              hard: pendingHard
            });
            pendingSpace = false;
            pendingHard = false;
          }
          last = m.index + m[0].length;
        }
        if (last < data.length) {
          pendingSpace = true;
          if (pre && data.slice(last).includes('\n')) pendingHard = true;
        }
      } else if (node.nodeType === 1) {
        if (node.tagName === 'BR') {
          pendingHard = true;
          return;
        }
        const cs = getComputedStyle(node);
        if (cs.display === 'none') return;
        for (const c of node.childNodes) visit(c);
      }
    };
    group.forEach(visit);
    if (!words.length) return null;

    // Lines
    const lines = [];
    let cur = null;
    for (const w of words) {
      const mid = w.top + w.h / 2;
      const newLine =
        !cur || w.hard || Math.abs(mid - (cur.top + cur.h / 2)) > Math.max(cur.h, w.h) * 0.5;
      if (newLine) {
        cur = { top: w.top, h: w.h, bottom: w.top + w.h, words: [] };
        lines.push(cur);
      } else {
        cur.top = Math.min(cur.top, w.top);
        cur.bottom = Math.max(cur.bottom, w.top + w.h);
        cur.h = cur.bottom - cur.top;
      }
      cur.words.push(w);
    }

    // Characters + style ranges
    let chars = '';
    const ranges = [];
    const push = (str, s) => {
      if (!str) return;
      const start = chars.length;
      chars += str;
      const last = ranges[ranges.length - 1];
      if (last && last.s === s && last.end === start) last.end = chars.length;
      else ranges.push({ start, end: chars.length, s });
    };
    words.forEach((w, i) => {
      if (i > 0) {
        const lineBreak = w.hard;
        push(lineBreak ? '\n' : w.space ? ' ' : '', words[i - 1].s);
      }
      push(w.text, w.s);
    });

    // Per-line segments (for SVG), baselines from real font metrics
    const segLines = lines.map((L) => {
      const segs = [];
      let seg = null;
      for (const w of L.words) {
        if (seg && seg.s === w.s) seg.text += (w.space ? ' ' : '') + w.text;
        else {
          seg = { s: w.s, text: w.text, x: w.x, top: w.top, h: w.h };
          segs.push(seg);
        }
      }
      return {
        segs: segs.map((sg) => {
          const fm = fontMetrics(styles[sg.s]);
          return { s: sg.s, text: sg.text, x: sg.x, baseline: sg.top + (sg.h - (fm.asc + fm.desc)) / 2 + fm.asc };
        })
      };
    });

    const left = Math.min(...words.map((w) => w.x));
    const right = Math.max(...words.map((w) => w.right));
    const usedLH = styles.map((s) => s.lineHeight).filter((v) => v != null);
    const L = usedLH.length ? Math.max(...usedLH) : null;
    let y0 = lines[0].top;
    let y1 = lines[lines.length - 1].bottom;
    if (L) {
      y0 -= (L - lines[0].h) / 2;
      y1 += (L - lines[lines.length - 1].h) / 2;
    }
    const ownerCs = getComputedStyle(ownerEl);
    return {
      type: 'TEXT',
      name: chars.replace(/\s+/g, ' ').slice(0, 40),
      x: left,
      y: y0,
      w: right - left,
      h: y1 - y0,
      characters: chars,
      styles,
      ranges,
      align: alignOf(ownerCs),
      multiLine: lines.length > 1,
      lines: segLines,
      opacity: 1,
      abs: false
    };
  }

  /* ---------------- structure ---------------- */
  function childNodesOf(el) {
    if (el.shadowRoot) return [...el.shadowRoot.childNodes];
    if (el.tagName === 'SLOT') {
      const a = el.assignedNodes({ flatten: true });
      return a.length ? a : [...el.childNodes];
    }
    return [...el.childNodes];
  }

  function hasBorder(cs) {
    return ['Top', 'Right', 'Bottom', 'Left'].some(
      (s) => px(cs[`border${s}Width`]) > 0 && !/none|hidden/.test(cs[`border${s}Style`]) && parseColor(cs[`border${s}Color`])
    );
  }

  function isInlineText(el, ctx) {
    if (!(el instanceof HTMLElement)) return false;
    if (ctx.inlineCache.has(el)) return ctx.inlineCache.get(el);
    let res = true;
    if (el.shadowRoot || REPLACED.has(el.tagName) || el.id === C2F.HOST_ID) res = false;
    else {
      const cs = getComputedStyle(el);
      if (cs.display === 'none') res = true;
      else if (cs.display !== 'inline') res = false;
      else if (
        parseColor(cs.backgroundColor) ||
        cs.backgroundImage !== 'none' ||
        hasBorder(cs) ||
        cs.boxShadow !== 'none' ||
        cs.position === 'absolute' ||
        cs.position === 'fixed'
      )
        res = false;
      else {
        for (const c of el.childNodes) {
          if (c.nodeType === 1 && c.tagName !== 'BR' && !isInlineText(c, ctx)) {
            res = false;
            break;
          }
        }
      }
    }
    ctx.inlineCache.set(el, res);
    return res;
  }

  function walkChildren(el, ctx) {
    const out = [];
    let group = [];
    const flush = () => {
      if (group.length) {
        const t = buildText(group, el, ctx);
        if (t) out.push(t);
        group = [];
      }
    };
    for (const child of childNodesOf(el)) {
      if (child.nodeType === 3) {
        if (child.data.trim() || group.length) group.push(child);
        continue;
      }
      if (child.nodeType !== 1) continue;
      if (child.tagName === 'BR' || isInlineText(child, ctx)) {
        group.push(child);
        continue;
      }
      flush();
      out.push(...walkElement(child, ctx, false));
    }
    flush();
    return out;
  }

  function fitMode(objectFit) {
    if (objectFit === 'contain' || objectFit === 'scale-down') return 'FIT';
    if (objectFit === 'fill') return 'STRETCH';
    return 'FILL';
  }

  function boxStyle(el, cs, w, h, ctx) {
    const fills = [];
    const bg = parseColor(cs.backgroundColor);
    if (bg) fills.push({ type: 'SOLID', color: bg });
    if (cs.backgroundImage && cs.backgroundImage !== 'none') {
      for (const layer of splitTop(cs.backgroundImage).reverse()) {
        if (layer.startsWith('url(')) {
          const m = layer.match(/^url\(\s*["']?([\s\S]*?)["']?\s*\)$/);
          if (!m) continue;
          const size = cs.backgroundSize;
          const mode = /contain/.test(size) ? 'FIT' : /100% 100%/.test(size) ? 'STRETCH' : 'FILL';
          fills.push({ type: 'IMAGE', imageId: ctx.addImage(m[1], null), scaleMode: mode });
        } else {
          const g = parseGradient(layer);
          if (g) fills.push(g);
        }
      }
    }
    const sides = ['Top', 'Right', 'Bottom', 'Left'];
    const weights = sides.map((s) =>
      /none|hidden/.test(cs[`border${s}Style`]) || !parseColor(cs[`border${s}Color`]) ? 0 : r2(px(cs[`border${s}Width`]))
    );
    let strokes = null;
    const idx = weights.findIndex((v) => v > 0);
    if (idx >= 0) {
      strokes = {
        color: parseColor(cs[`border${sides[idx]}Color`]),
        weights,
        style: cs[`border${sides[idx]}Style`]
      };
    }
    const radius = ['TopLeft', 'TopRight', 'BottomRight', 'BottomLeft'].map((c) =>
      parseRadius(cs[`border${c}Radius`], w, h)
    );
    return { fills, strokes, radius, shadows: parseShadows(cs.boxShadow) };
  }

  function borderPad(cs) {
    return {
      t: px(cs.paddingTop) + px(cs.borderTopWidth),
      r: px(cs.paddingRight) + px(cs.borderRightWidth),
      b: px(cs.paddingBottom) + px(cs.borderBottomWidth),
      l: px(cs.paddingLeft) + px(cs.borderLeftWidth)
    };
  }

  /* ---------------- special elements ---------------- */
  const SHAPES = new Set(['path', 'rect', 'circle', 'ellipse', 'line', 'polyline', 'polygon', 'text', 'tspan', 'use']);

  function svgPaint(el, cs, prop) {
    const v = cs.getPropertyValue(prop);
    const opProp = `${prop}-opacity`;
    const base = parseFloat(cs.getPropertyValue(opProp));
    if (!v || v === 'none') {
      el.setAttribute(prop, 'none');
      return;
    }
    if (v.startsWith('url')) {
      el.setAttribute(prop, v.replace(/^url\(["']?[^#]*(#[^"')]+)["']?\)/, 'url($1)'));
      return;
    }
    const c = parseColor(v);
    if (!c) {
      el.setAttribute(prop, 'none');
      return;
    }
    el.setAttribute(prop, `rgb(${Math.round(c.r * 255)},${Math.round(c.g * 255)},${Math.round(c.b * 255)})`);
    const a = c.a * (isNaN(base) ? 1 : base);
    if (a < 1) el.setAttribute(opProp, String(r2(a)));
    else el.removeAttribute(opProp);
  }

  function vectorNode(svgEl, box, abs) {
    const clone = svgEl.cloneNode(true);
    const o = [svgEl, ...svgEl.querySelectorAll('*')];
    const c = [clone, ...clone.querySelectorAll('*')];
    for (let i = 0; i < o.length; i++) {
      const el = c[i];
      const cs = getComputedStyle(o[i]);
      const tag = o[i].tagName.toLowerCase();
      if (i > 0 && cs.display === 'none' && SHAPES.has(tag)) {
        el.setAttribute('display', 'none');
        continue;
      }
      if (SHAPES.has(tag)) {
        svgPaint(el, cs, 'fill');
        svgPaint(el, cs, 'stroke');
        if (cs.stroke !== 'none') {
          el.setAttribute('stroke-width', cs.strokeWidth);
          if (cs.strokeLinecap !== 'butt') el.setAttribute('stroke-linecap', cs.strokeLinecap);
          if (cs.strokeLinejoin !== 'miter') el.setAttribute('stroke-linejoin', cs.strokeLinejoin);
          if (cs.strokeDasharray && cs.strokeDasharray !== 'none') el.setAttribute('stroke-dasharray', cs.strokeDasharray);
        }
        if (cs.fillRule === 'evenodd') el.setAttribute('fill-rule', 'evenodd');
        if (tag === 'text' || tag === 'tspan') {
          el.setAttribute('font-family', cs.fontFamily);
          el.setAttribute('font-size', cs.fontSize);
          el.setAttribute('font-weight', cs.fontWeight);
        }
      } else if (tag === 'stop') {
        const sc = parseColor(cs.stopColor, true);
        if (sc) {
          el.setAttribute('stop-color', `rgb(${Math.round(sc.r * 255)},${Math.round(sc.g * 255)},${Math.round(sc.b * 255)})`);
          el.setAttribute('stop-opacity', String(r2(sc.a * (parseFloat(cs.stopOpacity) || 1))));
        }
      }
      if (i > 0 && +cs.opacity < 1) el.setAttribute('opacity', cs.opacity);
      el.removeAttribute('class');
      const style = el.getAttribute('style');
      if (style && /var\(|currentcolor/i.test(style)) el.removeAttribute('style');
    }
    // Inline sprite references (<use href="#id">) whose target lives elsewhere in the page.
    for (const use of clone.querySelectorAll('use')) {
      const href = use.getAttribute('href') || use.getAttribute('xlink:href') || '';
      if (!href.startsWith('#')) continue;
      const id = href.slice(1);
      if (clone.querySelector(`[id="${CSS.escape(id)}"]`)) continue;
      const target = document.getElementById(id);
      if (!target) continue;
      let defs = clone.querySelector('defs');
      if (!defs) {
        defs = document.createElementNS('http://www.w3.org/2000/svg', 'defs');
        clone.insertBefore(defs, clone.firstChild);
      }
      defs.appendChild(target.cloneNode(true));
    }
    clone.setAttribute('xmlns', 'http://www.w3.org/2000/svg');
    if (!clone.getAttribute('viewBox')) clone.setAttribute('viewBox', `0 0 ${r2(box.w)} ${r2(box.h)}`);
    clone.setAttribute('width', String(r2(box.w)));
    clone.setAttribute('height', String(r2(box.h)));
    clone.removeAttribute('x');
    clone.removeAttribute('y');
    clone.removeAttribute('style');
    const op = +getComputedStyle(svgEl).opacity;
    return {
      type: 'VECTOR',
      name: explicitName(svgEl) || 'Icon',
      ...box,
      svg: new XMLSerializer().serializeToString(clone),
      opacity: op < 1 ? op : 1,
      abs
    };
  }

  function formControl(el, cs, base, ctx) {
    const tag = el.tagName;
    const type = (el.type || '').toLowerCase();
    if (tag === 'INPUT' && (type === 'checkbox' || type === 'radio')) {
      if (!base.fills.length && !base.strokes) {
        const accent = parseColor(cs.accentColor) || { r: 0.2, g: 0.45, b: 0.95, a: 1 };
        if (el.checked) base.fills.push({ type: 'SOLID', color: accent });
        else {
          base.fills.push({ type: 'SOLID', color: { r: 1, g: 1, b: 1, a: 1 } });
          base.strokes = { color: { r: 0.46, g: 0.46, b: 0.46, a: 1 }, weights: [1, 1, 1, 1], style: 'solid' };
        }
        const rr = type === 'radio' ? base.w / 2 : 3;
        base.radius = [rr, rr, rr, rr];
      }
      return;
    }
    let text = '';
    let placeholder = false;
    if (tag === 'SELECT') text = (el.options[el.selectedIndex] && el.options[el.selectedIndex].text) || '';
    else if (type === 'password') text = '•'.repeat((el.value || '').length);
    else if (['button', 'submit', 'reset'].includes(type)) text = el.value || (type === 'submit' ? 'Submit' : '');
    else text = el.value || '';
    if (!text && el.placeholder) {
      text = el.placeholder;
      placeholder = true;
    }
    if (!text) return;
    if (tag !== 'TEXTAREA') text = text.replace(/\s*\n\s*/g, ' ');
    const st = textStyle(cs);
    if (placeholder) st.color = parseColor(getComputedStyle(el, '::placeholder').color) || st.color;
    const fm = fontMetrics(st);
    const P = borderPad(cs);
    const contentH = fm.asc + fm.desc;
    const L = st.lineHeight || contentH;
    const centered = ['button', 'submit', 'reset'].includes(type);
    const align = centered ? 'CENTER' : alignOf(cs);
    const x = base.x + P.l;
    const w = Math.max(1, base.w - P.l - P.r);
    const multi = tag === 'TEXTAREA';
    const top = multi ? base.y + P.t : base.y + (base.h - L) / 2;
    const rows = multi ? text.split('\n') : [text];
    const lines = rows.map((row, i) => {
      const width = measure(st, row);
      const sx = align === 'CENTER' ? x + (w - width) / 2 : align === 'RIGHT' ? x + w - width : x;
      return { segs: [{ s: 0, text: row, x: sx, baseline: top + i * L + (L - contentH) / 2 + fm.asc }] };
    });
    base.clip = true;
    base.children = [
      {
        type: 'TEXT',
        name: placeholder ? 'Placeholder' : text.slice(0, 40),
        x,
        y: top,
        w,
        h: multi ? Math.max(L, base.h - P.t - P.b) : L,
        characters: text,
        styles: [st],
        ranges: [{ start: 0, end: text.length, s: 0 }],
        align,
        multiLine: multi,
        lines,
        opacity: 1,
        abs: false
      }
    ];
  }

  /* ---------------- main walk ---------------- */
  function walkElement(el, ctx, isRoot) {
    if (el.id === C2F.HOST_ID) return [];
    const tag = el.tagName.toUpperCase();
    if (SKIP_TAGS.has(tag)) return [];
    if (el instanceof SVGElement && tag !== 'SVG') return [];
    const cs = getComputedStyle(el);
    if (cs.display === 'none') return [];
    if (!isRoot && +cs.opacity === 0) return [];
    if (cs.display === 'contents') return walkChildren(el, ctx);
    if (!isRoot && (cs.visibility === 'hidden' || cs.visibility === 'collapse')) return walkChildren(el, ctx);

    const r = el.getBoundingClientRect();
    const box = {
      x: (r.left - ctx.ox) / ctx.scale,
      y: (r.top - ctx.oy) / ctx.scale,
      w: r.width / ctx.scale,
      h: r.height / ctx.scale
    };
    if (isRoot && (tag === 'BODY' || tag === 'HTML')) {
      box.w = Math.max(box.w, document.documentElement.scrollWidth);
      box.h = Math.max(box.h, document.documentElement.scrollHeight);
    }
    const abs = !isRoot && (cs.position === 'absolute' || cs.position === 'fixed');

    if (tag === 'SVG') return box.w > 0 && box.h > 0 ? [vectorNode(el, box, abs)] : [];

    const base = {
      type: 'FRAME',
      name: nameOf(el),
      ...box,
      abs,
      opacity: +cs.opacity < 1 ? +cs.opacity : 1,
      ...boxStyle(el, cs, box.w, box.h, ctx),
      clip: false,
      children: []
    };

    if (tag === 'IMG') {
      const src = el.currentSrc || el.src;
      if (src) base.fills.push({ type: 'IMAGE', imageId: ctx.addImage(src, el), scaleMode: fitMode(cs.objectFit) });
      return box.w > 0 && box.h > 0 ? [base] : [];
    }
    if (tag === 'CANVAS' || tag === 'VIDEO') {
      try {
        let data;
        if (tag === 'CANVAS') data = el.toDataURL('image/png');
        else {
          const c = document.createElement('canvas');
          c.width = el.videoWidth;
          c.height = el.videoHeight;
          c.getContext('2d').drawImage(el, 0, 0);
          data = c.toDataURL('image/png');
        }
        base.fills.push({ type: 'IMAGE', imageId: ctx.addImage(data, null), scaleMode: fitMode(cs.objectFit) });
      } catch (e) {
        base.fills.push({ type: 'SOLID', color: { r: 0.85, g: 0.85, b: 0.85, a: 1 } });
      }
      return [base];
    }
    if (tag === 'IFRAME' || tag === 'FRAME') {
      // The frame's content is filled in after the walk (see embedFrames).
      base.name = explicitName(el) || 'Frame content';
      base.clip = true;
      const P = borderPad(cs);
      ctx.embeds.push({ node: base, el, dx: P.l, dy: P.t });
      return [base];
    }
    if (tag === 'OBJECT' || tag === 'EMBED') {
      base.name = explicitName(el) || 'Embed';
      if (!base.fills.length) base.fills.push({ type: 'SOLID', color: { r: 0.93, g: 0.93, b: 0.93, a: 1 } });
      return [base];
    }
    if (tag === 'INPUT' || tag === 'TEXTAREA' || tag === 'SELECT') {
      if ((el.type || '').toLowerCase() === 'hidden') return [];
      formControl(el, cs, base, ctx);
      return [base];
    }

    const children = walkChildren(el, ctx);
    const visual = base.fills.length || base.strokes || base.shadows.length;
    if (!isRoot && (box.w < 0.5 || box.h < 0.5) && !visual) return children; // zero-size wrapper
    base.children = children;
    base.clip = isRoot || cs.overflowX !== 'visible' || cs.overflowY !== 'visible';

    if (isRoot && !base.fills.length) {
      let p = el.parentElement;
      let color = null;
      while (p && !color) {
        color = parseColor(getComputedStyle(p).backgroundColor);
        p = p.parentElement;
      }
      base.fills.push({ type: 'SOLID', color: color ? { ...color, a: 1 } : { r: 1, g: 1, b: 1, a: 1 } });
    }

    // A plain box that only wraps one text run becomes that text layer.
    if (!isRoot && children.length === 1 && children[0].type === 'TEXT' && !visual && base.opacity === 1) {
      const t = children[0];
      const P = borderPad(cs);
      if (
        P.t + P.r + P.b + P.l < 0.5 &&
        Math.abs(box.h - t.h) <= 3 &&
        box.w >= t.w - 1 &&
        !/flex|grid/.test(cs.display)
      ) {
        Object.assign(t, { x: box.x, y: box.y, w: box.w, h: box.h, abs });
        const ex = explicitName(el);
        if (ex) t.name = ex;
        return [t];
      }
    }

    return [base];
  }

  function relativize(n, px0, py0) {
    const ax = n.x;
    const ay = n.y;
    n.x = r2(ax - px0);
    n.y = r2(ay - py0);
    n.w = r2(n.w);
    n.h = r2(n.h);
    if (n.type === 'TEXT') {
      for (const l of n.lines) {
        for (const s of l.segs) {
          s.x = r2(s.x - ax);
          s.baseline = r2(s.baseline - ay);
        }
      }
    }
    if (n.children) n.children.forEach((c) => relativize(c, ax, ay));
  }

  /* ---------------- images ---------------- */
  async function resolveOne(url, el) {
    let blob = null;
    try {
      const sameOrigin = /^(data|blob):/.test(url) || new URL(url).origin === location.origin;
      const res = await fetch(url, sameOrigin ? {} : { mode: 'cors', credentials: 'omit' });
      if (res.ok) blob = await res.blob();
    } catch (e) {
      /* fall through */
    }
    if (blob) {
      try {
        return await window.C2FImage.processBlob(blob);
      } catch (e) {
        /* fall through */
      }
    }
    try {
      const r = await chrome.runtime.sendMessage({ type: 'c2f-fetch-image', url });
      if (r && r.src) return r;
    } catch (e) {
      /* fall through */
    }
    if (el && el.tagName === 'IMG' && el.complete && el.naturalWidth) {
      try {
        const c = document.createElement('canvas');
        c.width = el.naturalWidth;
        c.height = el.naturalHeight;
        c.getContext('2d').drawImage(el, 0, 0);
        return { src: c.toDataURL('image/png'), w: c.width, h: c.height };
      } catch (e) {
        /* tainted */
      }
    }
    return null;
  }

  async function resolveImages(ctx) {
    const out = {};
    await Promise.all(
      [...ctx.images.entries()].map(async ([url, id]) => {
        out[id] = await resolveOne(url, ctx.imageEls.get(id)).catch(() => null);
      })
    );
    return out;
  }

  /* ---------------- whole-frame capture ---------------- */
  const SCROLLS = /(auto|scroll|overlay)/;

  /**
   * Temporarily lay out every scrolling area inside `rootEl` at full size, so content
   * scrolled out of view is part of the copy. Returns a function that restores the page.
   */
  function unrollScroll(rootEl) {
    const saved = new Map();
    const scrolls = [];
    const touch = (el, props) => {
      if (!saved.has(el)) saved.set(el, el.getAttribute('style'));
      for (const k in props) el.style.setProperty(k, props[k], 'important');
    };
    const isRootPage = rootEl === document.body || rootEl === document.documentElement;
    const stopAt = isRootPage ? document.documentElement : rootEl;
    const els = [rootEl, ...rootEl.querySelectorAll('*')];
    if (isRootPage) els.push(document.documentElement, document.body);

    for (const el of els) {
      if (!(el instanceof HTMLElement) || el.id === C2F.HOST_ID) continue;
      const cs = getComputedStyle(el);
      const vy = SCROLLS.test(cs.overflowY) && el.scrollHeight > el.clientHeight + 1;
      const vx = SCROLLS.test(cs.overflowX) && el.scrollWidth > el.clientWidth + 1;
      if (!vy && !vx) continue;
      scrolls.push([el, el.scrollTop, el.scrollLeft]);
      if (vx) touch(el, { 'overflow-x': 'visible' });
      if (!vy) continue;
      // Let the scroller and every box up to the root grow to fit the content.
      let a = el;
      while (a) {
        const props = { 'overflow-y': 'visible', height: 'auto', 'max-height': 'none' };
        // Only stop vertical flex shrinking; a row parent's flex settings control width, leave them.
        const pcs = a.parentElement && getComputedStyle(a.parentElement);
        if (pcs && /flex/.test(pcs.display) && pcs.flexDirection.startsWith('column')) {
          props['flex-basis'] = 'auto';
          props['flex-shrink'] = '0';
        }
        touch(a, props);
        if (a === stopAt) break;
        a = a.parentElement;
      }
    }
    if (saved.size) void document.documentElement.offsetHeight; // force layout
    return () => {
      for (const [el, style] of saved) {
        if (style == null) el.removeAttribute('style');
        else el.setAttribute('style', style);
      }
      for (const [el, top, left] of scrolls) {
        el.scrollTop = top;
        el.scrollLeft = left;
      }
    };
  }

  /** Furthest right/bottom any layer reaches, in root coordinates. */
  function extent(n, ox, oy, acc) {
    for (const c of n.children || []) {
      const ax = ox + c.x;
      const ay = oy + c.y;
      acc.r = Math.max(acc.r, ax + c.w);
      acc.b = Math.max(acc.b, ay + c.h);
      if (c.children && !c.clip) extent(c, ax, ay, acc);
    }
    return acc;
  }

  function makeCtx(ox, oy, scale) {
    const ctx = {
      ox,
      oy,
      scale,
      images: new Map(),
      imageEls: new Map(),
      inlineCache: new WeakMap(),
      embeds: []
    };
    ctx.addImage = (url, el) => {
      let abs = url;
      try {
        abs = new URL(url, document.baseURI).href;
      } catch (e) {
        /* keep */
      }
      if (!ctx.images.has(abs)) {
        const id = 'img' + (ctx.images.size + 1);
        ctx.images.set(abs, id);
        if (el) ctx.imageEls.set(id, el);
      }
      return ctx.images.get(abs);
    };
    return ctx;
  }

  /* ---------------- embedded frames (iframes) ---------------- */
  const CLAUDE_ORIGIN = /^https:\/\/([a-z0-9-]+\.)*(claude\.ai|claudeusercontent\.com|claude\.site)$/i;
  C2F.allowOrigin = (o) => CLAUDE_ORIGIN.test(o) || (C2F.dev === true && o === location.origin);

  /** Ask the content script inside `iframe` for its serialized content. */
  function requestFrame(iframe, timeout = 6000) {
    return new Promise((resolve) => {
      let win = null;
      try {
        win = iframe.contentWindow;
      } catch (e) {
        /* detached */
      }
      if (!win) return resolve(null);
      const id = 'c2f' + Math.random().toString(36).slice(2);
      const done = (v) => {
        window.removeEventListener('message', onMsg);
        clearTimeout(timer);
        resolve(v);
      };
      const onMsg = (e) => {
        if (e.source === win && e.data && e.data.c2fReply === id) done(e.data.payload || null);
      };
      const timer = setTimeout(() => done(null), timeout);
      window.addEventListener('message', onMsg);
      win.postMessage({ c2fRequest: id }, '*');
    });
  }

  function renameImages(n, map) {
    for (const f of n.fills || []) if (f.type === 'IMAGE' && map[f.imageId]) f.imageId = map[f.imageId];
    for (const c of n.children || []) renameImages(c, map);
  }

  /** Put each iframe's own content inside its node, so a parent frame copies with its children. */
  async function embedFrames(ctx, images) {
    let k = 0;
    await Promise.all(
      ctx.embeds.map(async ({ node, el, dx, dy }) => {
        const sub = await requestFrame(el);
        const n = ++k;
        if (!sub || !sub.root) {
          if (!node.fills.length) node.fills.push({ type: 'SOLID', color: { r: 0.93, g: 0.93, b: 0.93, a: 1 } });
          return;
        }
        const map = {};
        for (const id of Object.keys(sub.images || {})) {
          map[id] = `f${n}_${id}`;
          images[map[id]] = sub.images[id];
        }
        renameImages(sub.root, map);
        sub.root.x = dx;
        sub.root.y = dy;
        node.children = [sub.root];
      })
    );
  }

  /** What this document shows in its viewport — used when a parent page embeds this frame. */
  C2F.serializeViewport = async function serializeViewport() {
    const de = document.documentElement;
    const body = document.body;
    const ctx = makeCtx(0, 0, 1);
    const w = de.clientWidth || window.innerWidth;
    const h = de.clientHeight || window.innerHeight;
    const bg =
      parseColor(getComputedStyle(de).backgroundColor) || (body && parseColor(getComputedStyle(body).backgroundColor));
    const root = {
      type: 'FRAME',
      name: (document.title || '').trim().slice(0, 60) || 'Frame content',
      x: 0,
      y: 0,
      w,
      h,
      fills: [{ type: 'SOLID', color: bg ? { r: bg.r, g: bg.g, b: bg.b, a: 1 } : { r: 1, g: 1, b: 1, a: 1 } }],
      strokes: null,
      radius: [0, 0, 0, 0],
      shadows: [],
      opacity: 1,
      clip: true,
      abs: false,
      children: body ? walkElement(body, ctx, false) : []
    };
    relativize(root, 0, 0);
    const images = await resolveImages(ctx);
    await embedFrames(ctx, images);
    return { c2f: 1, v: 1, name: root.name, w: root.w, h: root.h, root, images };
  };

  // Answer a parent Claude page asking for this frame's content.
  window.addEventListener('message', (e) => {
    const d = e.data;
    if (!d || typeof d.c2fRequest !== 'string') return;
    if (window.parent === window || e.source !== window.parent || !C2F.allowOrigin(e.origin)) return;
    C2F.serializeViewport()
      .catch(() => null)
      .then((payload) => {
        try {
          e.source.postMessage({ c2fReply: d.c2fRequest, payload }, '*');
        } catch (err) {
          /* parent gone */
        }
      });
  });

  /** Serialize an element into {c2f, root, images}. */
  C2F.serialize = async function serialize(rootEl) {
    const restore = unrollScroll(rootEl);
    let root;
    let ctx;
    try {
      const rr = rootEl.getBoundingClientRect();
      let scale = 1;
      const lw = rootEl.offsetWidth;
      if (lw && rr.width) {
        scale = rr.width / lw;
        if (!isFinite(scale) || scale <= 0 || Math.abs(scale - 1) < 0.005) scale = 1;
      }
      ctx = makeCtx(rr.left, rr.top, scale);

      const nodes = walkElement(rootEl, ctx, true);
      if (nodes.length === 1 && nodes[0].type === 'FRAME') root = nodes[0];
      else {
        root = {
          type: 'FRAME',
          name: nameOf(rootEl),
          x: 0,
          y: 0,
          w: rr.width / scale,
          h: rr.height / scale,
          fills: [{ type: 'SOLID', color: { r: 1, g: 1, b: 1, a: 1 } }],
          strokes: null,
          radius: [0, 0, 0, 0],
          shadows: [],
          opacity: 1,
          clip: true,
          abs: false,
          children: nodes
        };
      }
      root.abs = false;
      relativize(root, root.x, root.y);

      // Content that spills past an unclipped frame is still part of the frame.
      const cs = getComputedStyle(rootEl);
      const isPage = rootEl === document.body || rootEl === document.documentElement;
      if (isPage || (cs.overflowX === 'visible' && cs.overflowY === 'visible')) {
        const e = extent(root, 0, 0, { r: root.w, b: root.h });
        root.w = Math.round(Math.max(root.w, e.r) * 100) / 100;
        root.h = Math.round(Math.max(root.h, e.b) * 100) / 100;
      }
    } finally {
      restore();
    }
    const images = await resolveImages(ctx);
    await embedFrames(ctx, images);
    return { c2f: 1, v: 1, name: root.name, w: root.w, h: root.h, root, images };
  };

  C2F.parseColor = parseColor;
})();
