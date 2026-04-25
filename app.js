(function () {
  'use strict';

  const $ = (id) => document.getElementById(id);

  const drop = $('drop');
  const file = $('file');
  const controls = $('controls');

  const dimMode = $('dim-mode');
  const percent = $('percent');
  const percentVal = $('percent-val');
  const maxdim = $('maxdim');
  const exactW = $('exact-w');
  const exactH = $('exact-h');
  const physW = $('phys-w');
  const physH = $('phys-h');
  const physUnit = $('phys-unit');
  const physDpi = $('phys-dpi');
  const physPxReadout = $('phys-px-readout');

  const strategy = $('strategy');
  const format = $('format');
  const quality = $('quality');
  const qualityVal = $('quality-val');
  const targetKb = $('target-kb');
  const targetGo = $('target-go');

  const preview = $('preview');
  const meta = $('meta');
  const errBox = $('error');
  const downloadBtn = $('download');
  const resetBtn = $('reset');

  let original = null;
  let originalW = 0;
  let originalH = 0;
  let originalType = '';
  let originalSize = 0;
  let originalName = '';
  let outputBlob = null;
  let outputUrl = null;
  let debounceTimer = null;
  let suppressMirror = false;

  function fmtBytes(n) {
    if (n < 1024) return n + ' B';
    if (n < 1024 * 1024) return (n / 1024).toFixed(1) + ' KB';
    return (n / (1024 * 1024)).toFixed(2) + ' MB';
  }

  function showError(msg) {
    errBox.textContent = msg;
    errBox.hidden = false;
  }
  function clearError() {
    errBox.hidden = true;
    errBox.textContent = '';
  }

  // --- Aspect ratio helpers (always locked to source) ---------------------
  function ratio() {
    return originalW && originalH ? originalW / originalH : 1;
  }
  function setIfChanged(input, val) {
    const next = String(val);
    if (input.value !== next) input.value = next;
  }

  function mirrorExactFromW() {
    if (!originalW) return;
    const w = +exactW.value || 0;
    setIfChanged(exactH, Math.max(1, Math.round(w / ratio())));
  }
  function mirrorExactFromH() {
    if (!originalH) return;
    const h = +exactH.value || 0;
    setIfChanged(exactW, Math.max(1, Math.round(h * ratio())));
  }

  function pxPerUnit() {
    const dpi = Math.max(1, +physDpi.value || 1);
    return physUnit.value === 'cm' ? dpi / 2.54 : dpi;
  }
  function mirrorPhysFromW() {
    if (!originalW) return;
    const w = +physW.value || 0;
    setIfChanged(physH, +(w / ratio()).toFixed(2));
  }
  function mirrorPhysFromH() {
    if (!originalH) return;
    const h = +physH.value || 0;
    setIfChanged(physW, +(h * ratio()).toFixed(2));
  }

  function updatePhysReadout() {
    const { w, h } = targetDims();
    physPxReadout.textContent = `→ ${w} × ${h} px`;
  }

  // --- File loading -------------------------------------------------------
  function loadFile(f) {
    clearError();
    if (!f) return;
    if (!f.type.startsWith('image/')) {
      showError(`Not an image file (${f.type || 'unknown type'}).`);
      return;
    }
    originalName = f.name;
    originalType = f.type;
    originalSize = f.size;

    const reader = new FileReader();
    reader.onerror = () => showError('Could not read file.');
    reader.onload = (e) => {
      const img = new Image();
      img.onerror = () => {
        showError(
          `Could not decode "${f.name}". This browser may not support ${f.type || 'this format'} ` +
          `(HEIC images, for example, only decode in Safari).`
        );
      };
      img.onload = () => {
        original = img;
        originalW = img.naturalWidth;
        originalH = img.naturalHeight;

        // Seed exact mode at source dims
        suppressMirror = true;
        exactW.value = originalW;
        exactH.value = originalH;

        // Seed physical mode preserving source aspect at current DPI/unit
        const k = pxPerUnit();
        const physW0 = +(originalW / k).toFixed(2);
        const physH0 = +(originalH / k).toFixed(2);
        physW.value = physW0;
        physH.value = physH0;
        suppressMirror = false;

        controls.hidden = false;
        drop.hidden = true;
        updatePhysReadout();
        render();
      };
      img.src = e.target.result;
    };
    reader.readAsDataURL(f);
  }

  // --- Sizing -------------------------------------------------------------
  function targetDims() {
    const m = dimMode.value;
    if (m === 'none') return { w: originalW, h: originalH };

    if (m === 'percent') {
      const p = +percent.value / 100;
      return {
        w: Math.max(1, Math.round(originalW * p)),
        h: Math.max(1, Math.round(originalH * p)),
      };
    }

    if (m === 'maxdim') {
      const max = +maxdim.value;
      if (!max || Math.max(originalW, originalH) <= max) {
        return { w: originalW, h: originalH };
      }
      const r = max / Math.max(originalW, originalH);
      return {
        w: Math.max(1, Math.round(originalW * r)),
        h: Math.max(1, Math.round(originalH * r)),
      };
    }

    if (m === 'exact') {
      return {
        w: Math.max(1, +exactW.value || 1),
        h: Math.max(1, +exactH.value || 1),
      };
    }

    if (m === 'physical') {
      const k = pxPerUnit();
      return {
        w: Math.max(1, Math.round((+physW.value || 0) * k)),
        h: Math.max(1, Math.round((+physH.value || 0) * k)),
      };
    }

    return { w: originalW, h: originalH };
  }

  function drawCanvas() {
    const { w, h } = targetDims();
    const canvas = document.createElement('canvas');
    canvas.width = w;
    canvas.height = h;
    const ctx = canvas.getContext('2d');
    // JPEG has no alpha — fill white so transparent PNGs don't go black.
    if (format.value === 'image/jpeg') {
      ctx.fillStyle = '#ffffff';
      ctx.fillRect(0, 0, w, h);
    }
    ctx.imageSmoothingEnabled = true;
    ctx.imageSmoothingQuality = 'high';
    ctx.drawImage(original, 0, 0, w, h);
    return { canvas, w, h };
  }

  function encode(canvas, type, q) {
    return new Promise((resolve) => {
      const usesQ = type === 'image/jpeg' || type === 'image/webp';
      canvas.toBlob((b) => resolve(b), type, usesQ ? q : undefined);
    });
  }

  function deltaPill(blob) {
    const delta = blob.size - originalSize;
    const pct = originalSize ? (delta / originalSize * 100) : 0;
    const sign = delta > 0 ? '+' : '';
    const cls = delta < 0 ? 'pill-success' : delta > 0 ? 'pill-error' : 'pill-violet';
    return `<span class="pill ${cls}">${sign}${pct.toFixed(0)}%</span>`;
  }

  function physicalLine(w, h) {
    if (dimMode.value === 'physical') {
      const u = physUnit.value;
      const dpi = +physDpi.value || 300;
      const wp = (+physW.value || 0).toFixed(2);
      const hp = (+physH.value || 0).toFixed(2);
      return `<br>Print size: <strong>${wp} × ${hp} ${u}</strong> @ <strong>${dpi} DPI</strong>`;
    }
    // For other modes, show what the file would print at if interpreted at 96 DPI
    const inW = (w / 96).toFixed(2);
    const inH = (h / 96).toFixed(2);
    return `<br>If printed at 96 DPI: ${inW} × ${inH} in`;
  }

  function updateMeta(blob, w, h, qUsed) {
    const dimsLine = (w !== originalW || h !== originalH)
      ? `<br>Dimensions: ${originalW}×${originalH} → <strong>${w}×${h}</strong> px`
      : `<br>Dimensions: ${originalW}×${originalH} px (unchanged)`;
    const qLine = qUsed !== undefined ? ` at quality <strong>${qUsed}</strong>` : '';
    meta.innerHTML =
      `<span class="savings-line"><strong>${fmtBytes(originalSize)}</strong> → ` +
      `<strong>${fmtBytes(blob.size)}</strong> ${deltaPill(blob)}</span>` +
      `${qLine}${dimsLine}${physicalLine(w, h)}`;
  }

  // --- Render -------------------------------------------------------------
  async function render() {
    if (!original) return;
    clearError();
    const { canvas, w, h } = drawCanvas();
    const type = format.value;
    const q = +quality.value / 100;
    const blob = await encode(canvas, type, q);
    if (!blob) {
      showError('Encoding failed. The image may be too large for this browser.');
      downloadBtn.disabled = true;
      return;
    }
    if (outputUrl) URL.revokeObjectURL(outputUrl);
    outputBlob = blob;
    outputUrl = URL.createObjectURL(blob);
    preview.innerHTML = `<img src="${outputUrl}" alt="preview">`;
    updateMeta(blob, w, h);
    if (dimMode.value === 'physical') updatePhysReadout();
    downloadBtn.disabled = false;
  }

  function debouncedRender() {
    clearTimeout(debounceTimer);
    debounceTimer = setTimeout(render, 80);
  }

  // --- Target file size search -------------------------------------------
  async function findTargetQuality() {
    clearError();
    const targetBytes = +targetKb.value * 1024;
    const type = format.value;
    if (type === 'image/png') {
      showError('PNG is lossless — switch to WebP or JPEG to hit a size target. (You can still shrink dimensions.)');
      return;
    }

    const { canvas, w, h } = drawCanvas();
    targetGo.disabled = true;
    targetGo.textContent = 'Searching...';

    let lo = 1, hi = 100, best = null, bestQ = 50;
    for (let i = 0; i < 10; i++) {
      const mid = Math.round((lo + hi) / 2);
      const blob = await encode(canvas, type, mid / 100);
      if (!blob) break;
      if (blob.size <= targetBytes) {
        best = blob;
        bestQ = mid;
        lo = mid + 1;
      } else {
        hi = mid - 1;
      }
      if (lo > hi) break;
    }

    targetGo.disabled = false;
    targetGo.textContent = 'Find quality';

    if (!best) {
      const blob = await encode(canvas, type, 0.01);
      showError(
        `Can't reach ${targetKb.value} KB even at quality 1 ` +
        `(got ${fmtBytes(blob ? blob.size : 0)} at ${w}×${h}). Try shrinking the dimensions further.`
      );
      return;
    }

    quality.value = bestQ;
    qualityVal.textContent = bestQ + '%';
    if (outputUrl) URL.revokeObjectURL(outputUrl);
    outputBlob = best;
    outputUrl = URL.createObjectURL(best);
    preview.innerHTML = `<img src="${outputUrl}" alt="preview">`;
    updateMeta(best, w, h, bestQ);
    downloadBtn.disabled = false;
  }

  // --- Drop / file input --------------------------------------------------
  drop.addEventListener('click', () => file.click());
  drop.addEventListener('keydown', (e) => {
    if (e.key === 'Enter' || e.key === ' ') {
      e.preventDefault();
      file.click();
    }
  });
  drop.addEventListener('dragover', (e) => {
    e.preventDefault();
    drop.classList.add('over');
  });
  drop.addEventListener('dragleave', () => drop.classList.remove('over'));
  drop.addEventListener('drop', (e) => {
    e.preventDefault();
    drop.classList.remove('over');
    if (e.dataTransfer.files[0]) loadFile(e.dataTransfer.files[0]);
  });
  file.addEventListener('change', (e) => {
    if (e.target.files[0]) loadFile(e.target.files[0]);
  });

  // Prevent the browser from navigating away if a file is dropped outside the zone
  window.addEventListener('dragover', (e) => e.preventDefault());
  window.addEventListener('drop', (e) => e.preventDefault());

  // --- Dimension mode switching ------------------------------------------
  function syncDimRows() {
    $('row-percent').hidden = dimMode.value !== 'percent';
    $('row-maxdim').hidden = dimMode.value !== 'maxdim';
    $('row-exact').hidden = dimMode.value !== 'exact';
    $('row-physical').hidden = dimMode.value !== 'physical';
    $('row-physical-dpi').hidden = dimMode.value !== 'physical';
  }
  dimMode.addEventListener('change', () => {
    syncDimRows();
    debouncedRender();
  });

  percent.addEventListener('input', () => {
    percentVal.textContent = percent.value + '%';
    debouncedRender();
  });
  maxdim.addEventListener('input', debouncedRender);

  exactW.addEventListener('input', () => {
    if (suppressMirror) return;
    mirrorExactFromW();
    debouncedRender();
  });
  exactH.addEventListener('input', () => {
    if (suppressMirror) return;
    mirrorExactFromH();
    debouncedRender();
  });

  physW.addEventListener('input', () => {
    if (suppressMirror) return;
    mirrorPhysFromW();
    updatePhysReadout();
    debouncedRender();
  });
  physH.addEventListener('input', () => {
    if (suppressMirror) return;
    mirrorPhysFromH();
    updatePhysReadout();
    debouncedRender();
  });
  physDpi.addEventListener('input', () => {
    updatePhysReadout();
    debouncedRender();
  });
  // Track the previous unit so we can convert numbers when the user toggles in/cm,
  // keeping the resulting pixel dimensions unchanged.
  let lastUnit = physUnit.value;
  physUnit.addEventListener('change', () => {
    const newUnit = physUnit.value;
    if (newUnit !== lastUnit && +physW.value && +physH.value) {
      const factor = (lastUnit === 'in' && newUnit === 'cm') ? 2.54
                   : (lastUnit === 'cm' && newUnit === 'in') ? 1 / 2.54
                   : 1;
      suppressMirror = true;
      physW.value = +(+physW.value * factor).toFixed(2);
      physH.value = +(+physH.value * factor).toFixed(2);
      suppressMirror = false;
    }
    lastUnit = newUnit;
    updatePhysReadout();
    debouncedRender();
  });

  // --- Compression --------------------------------------------------------
  strategy.addEventListener('change', () => {
    $('row-quality').hidden = strategy.value !== 'quality';
    $('row-target').hidden = strategy.value !== 'target';
  });
  quality.addEventListener('input', () => {
    qualityVal.textContent = quality.value + '%';
    debouncedRender();
  });
  format.addEventListener('change', () => {
    const isPng = format.value === 'image/png';
    quality.disabled = isPng;
    debouncedRender();
  });
  targetGo.addEventListener('click', findTargetQuality);

  // --- Download / reset ---------------------------------------------------
  downloadBtn.addEventListener('click', () => {
    if (!outputBlob) return;
    const ext = outputBlob.type.split('/')[1].replace('jpeg', 'jpg');
    const base = originalName.replace(/\.[^.]+$/, '');
    const { w, h } = targetDims();
    let suffix;
    if (dimMode.value === 'physical') {
      const u = physUnit.value;
      const dpi = +physDpi.value || 300;
      const wp = (+physW.value || 0).toFixed(2).replace(/\.?0+$/, '');
      const hp = (+physH.value || 0).toFixed(2).replace(/\.?0+$/, '');
      suffix = `${wp}x${hp}${u}_${dpi}dpi`;
    } else {
      suffix = `${w}x${h}`;
    }
    const a = document.createElement('a');
    a.href = outputUrl;
    a.download = `${base}_${suffix}.${ext}`;
    document.body.appendChild(a);
    a.click();
    a.remove();
  });

  resetBtn.addEventListener('click', () => {
    if (outputUrl) URL.revokeObjectURL(outputUrl);
    original = null;
    outputBlob = null;
    outputUrl = null;
    file.value = '';
    controls.hidden = true;
    drop.hidden = false;
    downloadBtn.disabled = true;
    preview.innerHTML = '';
    meta.innerHTML = '';
    clearError();
  });

  // Initial UI sync (in case browser remembers select values)
  syncDimRows();
  $('row-quality').hidden = strategy.value !== 'quality';
  $('row-target').hidden = strategy.value !== 'target';
})();
