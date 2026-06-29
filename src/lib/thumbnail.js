// Re-encode an image blob to WebP (alpha preserved). Returns the blob unchanged if it's already
// WebP, or if the browser can't encode WebP via canvas (graceful fallback — the caller derives the
// extension + Content-Type from the returned blob.type, so PNG stays self-consistent). Lets a single
// upload path normalize thumbnails to WebP regardless of how the source was produced (a direct canvas
// capture, a remove.bg PNG, etc.) — so no PNG masters accumulate on R2.
export function encodeWebp(blob, quality = 0.9) {
  if (!blob || blob.type === 'image/webp') return Promise.resolve(blob);
  return new Promise(resolve => {
    const img = new Image();
    img.onload = () => {
      const c = document.createElement('canvas');
      c.width = img.naturalWidth; c.height = img.naturalHeight;
      c.getContext('2d').drawImage(img, 0, 0);
      c.toBlob(out => { URL.revokeObjectURL(img.src); resolve(out ?? blob); }, 'image/webp', quality);
    };
    img.onerror = () => { URL.revokeObjectURL(img.src); resolve(blob); };
    img.src = URL.createObjectURL(blob);
  });
}

// Crop a captured thumbnail to its non-transparent bounds and scale to fill ~80% of a 512² frame,
// so element thumbnails frame consistently regardless of how the 3D capture was composed. Output is
// WebP (alpha preserved) — the master thumbnail is now WebP end-to-end, no PNG accumulates on R2.
// Shared by AddElement, the Piping Calibrator (pattern creation) and Manage Elements (regenerate).
export function normalizeThumbnail(blob) {
  return new Promise(resolve => {
    const img = new Image();
    img.onload = () => {
      const src = document.createElement('canvas');
      src.width = img.width; src.height = img.height;
      const sCtx = src.getContext('2d');
      sCtx.drawImage(img, 0, 0);
      const { data } = sCtx.getImageData(0, 0, src.width, src.height);
      let minX = src.width, minY = src.height, maxX = 0, maxY = 0;
      for (let y = 0; y < src.height; y++) {
        for (let x = 0; x < src.width; x++) {
          if (data[(y * src.width + x) * 4 + 3] > 10) {
            if (x < minX) minX = x; if (x > maxX) maxX = x;
            if (y < minY) minY = y; if (y > maxY) maxY = y;
          }
        }
      }
      const OUT = 512, FILL = 0.8;
      const out = document.createElement('canvas');
      out.width = OUT; out.height = OUT;
      const oCtx = out.getContext('2d');
      if (maxX >= minX && maxY >= minY) {
        const cw = maxX - minX + 1, ch = maxY - minY + 1;
        const scale = (OUT * FILL) / Math.max(cw, ch);
        const dw = cw * scale, dh = ch * scale;
        oCtx.drawImage(src, minX, minY, cw, ch, (OUT - dw) / 2, (OUT - dh) / 2, dw, dh);
      } else {
        // Fully transparent capture — just scale the source to fit the frame.
        const scale = (OUT * FILL) / Math.max(src.width, src.height);
        const dw = src.width * scale, dh = src.height * scale;
        oCtx.drawImage(src, (OUT - dw) / 2, (OUT - dh) / 2, dw, dh);
      }
      out.toBlob(resolve, 'image/webp', 0.9);
      URL.revokeObjectURL(img.src);
    };
    img.src = URL.createObjectURL(blob);
  });
}
