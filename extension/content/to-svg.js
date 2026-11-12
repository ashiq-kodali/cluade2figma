/* to-svg.js — layer tree → SVG string that Figma imports as editable layers on ⌘V. */
(() => {
  const C2F = window.C2F;
  if (C2F.toSVG) return;

  const esc = (s) =>
    String(s).replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;').replace(/"/g, '&quot;');
  const num = (v) => Math.round(v * 100) / 100;
  const num6 = (v) => +(+v).toFixed(6);
  const rgb = (c) => `rgb(${Math.round(c.r * 255)},${Math.round(c.g * 255)},${Math.round(c.b * 255)})`;

  function shape(w, h, rad, inset, attrs) {
    const x0 = inset;
    const y0 = inset;
    const W = Math.max(0, w - 2 * inset);
    const H = Math.max(0, h - 2 * inset);
    const r = (rad || [0, 0, 0, 0]).map((v) => Math.max(0, Math.min(v - inset, W / 2, H / 2)));
    if (r.every((v) => v === r[0])) {
      return `<rect x="${num(x0)}" y="${num(y0)}" width="${num(W)}" height="${num(H)}"${r[0] ? ` rx="${num(r[0])}"` : ''}${attrs}/>`;
    }
    const [tl, tr, br, bl] = r;
    const x1 = x0 + W;
    const y1 = y0 + H;
    const arc = (rr, x, y) => (rr ? `A${num(rr)} ${num(rr)} 0 0 1 ${num(x)} ${num(y)}` : '');
    const d =
      `M${num(x0 + tl)} ${num(y0)}H${num(x1 - tr)}${arc(tr, x1, y0 + tr)}` +
      `V${num(y1 - br)}${arc(br, x1 - br, y1)}H${num(x0 + bl)}${arc(bl, x0, y1 - bl)}` +
      `V${num(y0 + tl)}${arc(tl, x0 + tl, y0)}Z`;
    return `<path d="${d}"${attrs}/>`;
  }

  C2F.toSVG = function toSVG(payload) {
    const images = payload.images || {};
    const defs = [];
    const imgDefs = new Map();
    let uid = 0;
    const id = (p) => `${p}${++uid}`;
    const paint = (c, prop = 'fill') =>
      ` ${prop}="${rgb(c)}"${c.a < 1 ? ` ${prop}-opacity="${num(c.a)}"` : ''}`;
    const op = (n) => (n.opacity != null && n.opacity < 1 ? ` opacity="${num(n.opacity)}"` : '');

    function fillAttrs(n, f) {
      if (f.type === 'SOLID') return paint(f.color);
      if (f.type === 'GRADIENT_LINEAR' || f.type === 'GRADIENT_RADIAL') {
        const gid = id('grad');
        const stops = f.stops
          .map(
            (s) =>
              `<stop offset="${num(s.pos)}" stop-color="${rgb(s.color)}"${s.color.a < 1 ? ` stop-opacity="${num(s.color.a)}"` : ''}/>`
          )
          .join('');
        if (f.type === 'GRADIENT_LINEAR') {
          const a = (f.angle * Math.PI) / 180;
          const sx = Math.sin(a);
          const cy = Math.cos(a);
          defs.push(
            `<linearGradient id="${gid}" x1="${num6(0.5 - 0.5 * sx)}" y1="${num6(0.5 + 0.5 * cy)}" x2="${num6(0.5 + 0.5 * sx)}" y2="${num6(0.5 - 0.5 * cy)}">${stops}</linearGradient>`
          );
        } else {
          defs.push(`<radialGradient id="${gid}" cx="0.5" cy="0.5" r="0.5">${stops}</radialGradient>`);
        }
        return ` fill="url(#${gid})"`;
      }
      if (f.type === 'IMAGE') {
        const img = images[f.imageId];
        if (!img) return paint({ r: 0.85, g: 0.85, b: 0.85, a: 1 });
        const pid = id('pattern');
        if (img.w && img.h) {
          let imgId = imgDefs.get(f.imageId);
          if (!imgId) {
            imgId = id('image');
            imgDefs.set(f.imageId, imgId);
            defs.push(
              `<image id="${imgId}" width="${img.w}" height="${img.h}" preserveAspectRatio="none" xlink:href="${img.src}"/>`
            );
          }
          const W = n.w || 1;
          const H = n.h || 1;
          let sx;
          let sy;
          let tx = 0;
          let ty = 0;
          if (f.scaleMode === 'STRETCH') {
            sx = 1 / img.w;
            sy = 1 / img.h;
          } else {
            const k = f.scaleMode === 'FIT' ? Math.min(W / img.w, H / img.h) : Math.max(W / img.w, H / img.h);
            sx = k / W;
            sy = k / H;
            tx = (1 - (img.w * k) / W) / 2;
            ty = (1 - (img.h * k) / H) / 2;
          }
          defs.push(
            `<pattern id="${pid}" patternContentUnits="objectBoundingBox" width="1" height="1"><use xlink:href="#${imgId}" transform="matrix(${num6(sx)} 0 0 ${num6(sy)} ${num6(tx)} ${num6(ty)})"/></pattern>`
          );
        } else {
          const par =
            f.scaleMode === 'FIT' ? 'xMidYMid meet' : f.scaleMode === 'STRETCH' ? 'none' : 'xMidYMid slice';
          defs.push(
            `<pattern id="${pid}" patternContentUnits="objectBoundingBox" width="1" height="1"><image width="1" height="1" preserveAspectRatio="${par}" xlink:href="${img.src}"/></pattern>`
          );
        }
        return ` fill="url(#${pid})"`;
      }
      return null;
    }

    const HARD_ALPHA =
      '<feColorMatrix in="SourceAlpha" type="matrix" values="0 0 0 0 0 0 0 0 0 0 0 0 0 0 0 0 0 0 127 0" result="hardAlpha"/>';
    const colorMatrix = (c) =>
      `<feColorMatrix type="matrix" values="0 0 0 0 ${num6(c.r)} 0 0 0 0 ${num6(c.g)} 0 0 0 0 ${num6(c.b)} 0 0 0 ${num6(c.a)} 0"/>`;

    // Same primitive chain Figma exports, so Figma maps it back to shadow effects.
    function shadowFilter(n) {
      const fid = id('filter');
      const parts = ['<feFlood flood-opacity="0" result="BackgroundImageFix"/>'];
      let prev = 'BackgroundImageFix';
      let k = 0;
      let pad = 0;
      for (const s of n.shadows.filter((x) => x.type === 'DROP_SHADOW')) {
        k++;
        pad = Math.max(pad, Math.abs(s.x) + Math.abs(s.y) + s.blur * 1.5 + Math.max(0, s.spread));
        parts.push(HARD_ALPHA);
        if (s.spread) {
          parts.push(
            `<feMorphology radius="${num(Math.abs(s.spread))}" operator="${s.spread > 0 ? 'dilate' : 'erode'}" in="SourceAlpha" result="effect${k}_spread"/>`
          );
        }
        parts.push(`<feOffset dx="${num(s.x)}" dy="${num(s.y)}"/>`);
        if (s.blur) parts.push(`<feGaussianBlur stdDeviation="${num(s.blur / 2)}"/>`);
        parts.push('<feComposite in2="hardAlpha" operator="out"/>');
        parts.push(colorMatrix(s.color));
        parts.push(`<feBlend mode="normal" in2="${prev}" result="effect${k}_dropShadow"/>`);
        prev = `effect${k}_dropShadow`;
      }
      parts.push(`<feBlend mode="normal" in="SourceGraphic" in2="${prev}" result="shape"/>`);
      prev = 'shape';
      for (const s of n.shadows.filter((x) => x.type === 'INNER_SHADOW')) {
        k++;
        parts.push(HARD_ALPHA);
        parts.push(`<feOffset dx="${num(s.x)}" dy="${num(s.y)}"/>`);
        if (s.blur) parts.push(`<feGaussianBlur stdDeviation="${num(s.blur / 2)}"/>`);
        parts.push('<feComposite in2="hardAlpha" operator="arithmetic" k2="-1" k3="1"/>');
        parts.push(colorMatrix(s.color));
        parts.push(`<feBlend mode="normal" in2="${prev}" result="effect${k}_innerShadow"/>`);
        prev = `effect${k}_innerShadow`;
      }
      defs.push(
        `<filter id="${fid}" x="${num(-pad)}" y="${num(-pad)}" width="${num(n.w + 2 * pad)}" height="${num(n.h + 2 * pad)}" filterUnits="userSpaceOnUse" color-interpolation-filters="sRGB">${parts.join('')}</filter>`
      );
      return fid;
    }

    function stroke(n) {
      const s = n.strokes;
      const w = s.weights;
      const c = s.color;
      const w0 = Math.max(...w);
      if (w.every((v) => v === w[0])) {
        const dash =
          s.style === 'dashed'
            ? ` stroke-dasharray="${num(w0 * 3)} ${num(w0 * 2)}"`
            : s.style === 'dotted'
              ? ` stroke-dasharray="${num(w0)} ${num(w0)}"`
              : '';
        return shape(n.w, n.h, n.radius, w0 / 2, ` fill="none"${paint(c, 'stroke')} stroke-width="${num(w0)}"${dash}`);
      }
      const f = paint(c);
      const out = [];
      if (w[0]) out.push(`<rect x="0" y="0" width="${num(n.w)}" height="${num(w[0])}"${f}/>`);
      if (w[1]) out.push(`<rect x="${num(n.w - w[1])}" y="0" width="${num(w[1])}" height="${num(n.h)}"${f}/>`);
      if (w[2]) out.push(`<rect x="0" y="${num(n.h - w[2])}" width="${num(n.w)}" height="${num(w[2])}"${f}/>`);
      if (w[3]) out.push(`<rect x="0" y="0" width="${num(w[3])}" height="${num(n.h)}"${f}/>`);
      return out.join('');
    }

    function textEl(n) {
      const groups = [];
      for (const line of n.lines) {
        for (const seg of line.segs) {
          const g = groups[groups.length - 1];
          if (g && g.s === seg.s) g.segs.push(seg);
          else groups.push({ s: seg.s, segs: [seg] });
        }
      }
      const tr = `transform="translate(${num(n.x)} ${num(n.y)})"`;
      const els = groups.map((g, i) => {
        const st = n.styles[g.s];
        const attrs = [
          groups.length === 1 && `id="${esc(n.name)}"`,
          groups.length === 1 && tr,
          `fill="${rgb(st.color)}"`,
          st.color.a < 1 && `fill-opacity="${num(st.color.a)}"`,
          `font-family="${esc(st.family)}"`,
          `font-size="${num(st.size)}"`,
          st.weight !== 400 && `font-weight="${st.weight}"`,
          st.italic && 'font-style="italic"',
          st.letterSpacing && `letter-spacing="${num(st.letterSpacing)}"`,
          st.decoration && `text-decoration="${st.decoration === 'UNDERLINE' ? 'underline' : 'line-through'}"`,
          groups.length === 1 && n.opacity < 1 && `opacity="${num(n.opacity)}"`,
          'xml:space="preserve"'
        ]
          .filter(Boolean)
          .join(' ');
        const spans = g.segs
          .map((s) => `<tspan x="${num(s.x)}" y="${num(s.baseline)}">${esc(s.text)}</tspan>`)
          .join('');
        return `<text ${attrs}>${spans}</text>`;
      });
      if (groups.length === 1) return els[0];
      return `<g id="${esc(n.name)}" ${tr}${op(n)}>${els.join('')}</g>`;
    }

    function node(n) {
      if (n.type === 'TEXT') return textEl(n);
      const tr = `transform="translate(${num(n.x)} ${num(n.y)})"`;
      if (n.type === 'VECTOR') {
        return `<g id="${esc(n.name)}" ${tr}${op(n)}>${n.svg.replace(/^<\?xml[^>]*>/, '')}</g>`;
      }
      const shapes = [];
      for (const f of n.fills || []) {
        const a = fillAttrs(n, f);
        if (a) shapes.push(shape(n.w, n.h, n.radius, 0, a));
      }
      if (n.strokes) shapes.push(stroke(n));
      let bg = shapes.join('');
      if (bg && n.shadows && n.shadows.length) bg = `<g filter="url(#${shadowFilter(n)})">${bg}</g>`;
      let inner = '';
      if (n.children && n.children.length) {
        inner = n.children.map(node).join('');
        if (n.clip) {
          const cid = id('clip');
          defs.push(`<clipPath id="${cid}">${shape(n.w, n.h, n.radius, 0, '')}</clipPath>`);
          inner = `<g clip-path="url(#${cid})">${inner}</g>`;
        }
      }
      return `<g id="${esc(n.name)}" ${tr}${op(n)}>${bg}${inner}</g>`;
    }

    const root = payload.root;
    const body = node(Object.assign({}, root, { x: 0, y: 0 }));
    const W = num(root.w);
    const H = num(root.h);
    return (
      `<svg width="${W}" height="${H}" viewBox="0 0 ${W} ${H}" fill="none" xmlns="http://www.w3.org/2000/svg" xmlns:xlink="http://www.w3.org/1999/xlink">` +
      body +
      (defs.length ? `<defs>${defs.join('')}</defs>` : '') +
      '</svg>'
    );
  };

  /** Serialize `el` and return the SVG text to put on the clipboard. */
  C2F.buildClipboard = async (el) => C2F.toSVG(await C2F.serialize(el));
})();
