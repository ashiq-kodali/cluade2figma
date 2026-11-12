/* Shared by content scripts and the service worker: turn an image Blob into
   a data URL Figma can use (PNG/JPEG/GIF ≤ 4096px), plus its pixel size. */
(function (g) {
  if (g.C2FImage) return;

  function blobToDataUrl(blob) {
    return new Promise((resolve, reject) => {
      const fr = new FileReader();
      fr.onload = () => resolve(fr.result);
      fr.onerror = () => reject(fr.error);
      fr.readAsDataURL(blob);
    });
  }

  async function asSvg(blob) {
    const text = await blob.text();
    return {
      src: await blobToDataUrl(new Blob([text], { type: 'image/svg+xml' })),
      w: 0,
      h: 0,
      svg: text
    };
  }

  async function processBlob(blob) {
    const type = (blob.type || '').toLowerCase();
    if (type.includes('svg')) return asSvg(blob);

    let bmp;
    try {
      bmp = await createImageBitmap(blob);
    } catch (e) {
      const head = await blob.slice(0, 1024).text();
      if (/<svg[\s>]/i.test(head)) return asSvg(blob);
      throw e;
    }

    let w = bmp.width;
    let h = bmp.height;
    let out = blob;
    const native = /image\/(png|jpeg|jpg|gif)/.test(type);
    if (!native || w > 4096 || h > 4096) {
      const k = Math.min(1, 4096 / Math.max(w, h));
      const cw = Math.max(1, Math.round(w * k));
      const ch = Math.max(1, Math.round(h * k));
      const canvas = new OffscreenCanvas(cw, ch);
      canvas.getContext('2d').drawImage(bmp, 0, 0, cw, ch);
      out = await canvas.convertToBlob({ type: 'image/png' });
      w = cw;
      h = ch;
    }
    if (bmp.close) bmp.close();
    return { src: await blobToDataUrl(out), w, h };
  }

  g.C2FImage = { processBlob, blobToDataUrl };
})(typeof self !== 'undefined' ? self : window);
