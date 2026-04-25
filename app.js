(function () {
  'use strict';

  const $ = (id) => document.getElementById(id);

  const drop = $('drop');
  const file = $('file');
  const controls = $('controls');

  const dimMode = $('dim-mode');
  const percent = $('percent');
  const percentVal = $('percent-val');
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
  let originalSize = 0;
  let originalName = '';
  let outputBlob = null;
  let outputUrl = null;
  let debounceTimer = null;

  // Bumped on every load and reset. Async work captures it on entry and
  // bails on resolve if it no longer matches, so a slow encode can't
  // overwrite a freshly-reset UI.
  let currentGen = 0;

  // Canonical target. Every dimension control is a different view of these two numbers.
  let targetW = 0;
  let targetH = 0;

  // Re-entrancy guard so that programmatic input updates don't fire input events
  // we'd then react to. (We still set values, but the listener bails early.)
  let syncing = false;

  function fmtBytes(n) {
    if (n < 1024) return n + ' B';
    if (n < 1024 * 1024) return (n / 1024).toFixed(1) + ' KB';
    return (n / (1024 * 1024)).toFixed(2) + ' MB';
  }

  function showError(msg) {
    // Cancel any queued render so it doesn't immediately clear what we're about to show.
    clearTimeout(debounceTimer);
    errBox.textContent = msg;
    errBox.hidden = false;
  }
  function clearError() {
    errBox.hidden = true;
    errBox.textContent = '';
  }

  function ratio() {
    return originalW && originalH ? originalW / originalH : 1;
  }

  function pxPerUnit() {
    const dpi = Math.max(1, +physDpi.value || 1);
    return physUnit.value === 'cm' ? dpi / 2.54 : dpi;
  }

  function clamp(n, lo, hi) {
    return Math.min(hi, Math.max(lo, n));
  }

  function setIfChanged(input, val) {
    const next = String(val);
    if (input.value !== next) input.value = next;
  }

  // --- Canonical setters --------------------------------------------------
  // Each one re-derives (targetW, targetH) from the input being edited.
  // Aspect ratio is always locked to the source image.

  // Each setter returns true on a valid edit (canonical updated) or false on
  // an invalid one (empty/zero) so callers know to skip syncing the other
  // fields. This prevents mid-typing inputs from collapsing every other
  // dimension to 1.

  function setFromPercent() {
    const p = (+percent.value || 0) / 100;
    if (!p) return false;
    targetW = Math.max(1, Math.round(originalW * p));
    targetH = Math.max(1, Math.round(originalH * p));
    return true;
  }

  function setFromExactW() {
    const v = +exactW.value;
    if (!v || v < 1) return false;
    targetW = Math.max(1, Math.round(v));
    targetH = Math.max(1, Math.round(targetW / ratio()));
    return true;
  }
  function setFromExactH() {
    const v = +exactH.value;
    if (!v || v < 1) return false;
    targetH = Math.max(1, Math.round(v));
    targetW = Math.max(1, Math.round(targetH * ratio()));
    return true;
  }

  function setFromPhysW() {
    const v = +physW.value;
    if (!v || v <= 0) return false;
    const k = pxPerUnit();
    targetW = Math.max(1, Math.round(v * k));
    targetH = Math.max(1, Math.round(targetW / ratio()));
    return true;
  }
  function setFromPhysH() {
    const v = +physH.value;
    if (!v || v <= 0) return false;
    const k = pxPerUnit();
    targetH = Math.max(1, Math.round(v * k));
    targetW = Math.max(1, Math.round(targetH * ratio()));
    return true;
  }

  function setFromKeepOriginal() {
    targetW = originalW;
    targetH = originalH;
  }

  // Recompute canonical pixels from the currently visible mode (e.g. when DPI
  // changes in physical mode, the physical numbers stay the same but the pixel
  // target moves).
  function recomputeFromActiveMode() {
    const m = dimMode.value;
    if (m === 'percent') setFromPercent();
    else if (m === 'exact') setFromExactW();
    else if (m === 'physical') setFromPhysW();
    else setFromKeepOriginal();
  }

  // --- Sync display fields from canonical ---------------------------------
  // `skip` is the input the user is actively editing; we leave it alone so
  // their caret/typed value isn't clobbered.
  function syncDisplays(skip) {
    if (!originalW || !originalH) return;
    syncing = true;
    try {
      if (skip !== percent) {
        const realPct = targetW / originalW * 100;
        const sliderPct = clamp(realPct, +percent.min, +percent.max);
        setIfChanged(percent, Math.round(sliderPct));
      }
      // The percent readout always shows the *real* percentage (even if the slider is pinned).
      percentVal.textContent = Math.round(targetW / originalW * 100) + '%';

      if (skip !== exactW) setIfChanged(exactW, targetW);
      if (skip !== exactH) setIfChanged(exactH, targetH);

      const k = pxPerUnit();
      if (skip !== physW) setIfChanged(physW, +(targetW / k).toFixed(2));
      if (skip !== physH) setIfChanged(physH, +(targetH / k).toFixed(2));

      physPxReadout.textContent = `→ ${targetW} × ${targetH} px`;
    } finally {
      // try/finally so a thrown setter never leaves the UI deadlocked.
      syncing = false;
    }
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
        currentGen++;
        original = img;
        originalW = img.naturalWidth;
        originalH = img.naturalHeight;

        setFromKeepOriginal();
        syncDisplays();

        controls.hidden = false;
        drop.hidden = true;
        render();
      };
      img.src = e.target.result;
    };
    reader.readAsDataURL(f);
  }

  // --- Sizing / encoding --------------------------------------------------
  function drawCanvas() {
    const w = targetW, h = targetH;
    const canvas = document.createElement('canvas');
    canvas.width = w;
    canvas.height = h;
    const ctx = canvas.getContext('2d');
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
    const gen = currentGen;
    const { canvas, w, h } = drawCanvas();
    const type = format.value;
    const q = +quality.value / 100;
    const blob = await encode(canvas, type, q);
    if (gen !== currentGen) return; // reset/reload happened mid-encode
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

    const gen = currentGen;
    const { canvas, w, h } = drawCanvas();
    targetGo.disabled = true;
    targetGo.textContent = 'Searching...';

    let lo = 1, hi = 100, best = null, bestQ = 50;
    for (let i = 0; i < 10; i++) {
      const mid = Math.round((lo + hi) / 2);
      const blob = await encode(canvas, type, mid / 100);
      if (gen !== currentGen) {
        targetGo.disabled = false;
        targetGo.textContent = 'Find quality';
        return;
      }
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

    if (gen !== currentGen) return;

    if (!best) {
      const blob = await encode(canvas, type, 0.01);
      if (gen !== currentGen) return;
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
  window.addEventListener('dragover', (e) => e.preventDefault());
  window.addEventListener('drop', (e) => e.preventDefault());

  // --- Dimension mode switching ------------------------------------------
  function syncDimRows() {
    $('row-percent').hidden = dimMode.value !== 'percent';
    $('row-exact').hidden = dimMode.value !== 'exact';
    $('row-physical').hidden = dimMode.value !== 'physical';
    $('row-physical-dpi').hidden = dimMode.value !== 'physical';
  }

  dimMode.addEventListener('change', () => {
    syncDimRows();
    if (dimMode.value === 'none') {
      setFromKeepOriginal();
      syncDisplays();
    }
    debouncedRender();
  });

  // Generic input handler factory: take input from `editor`, apply `setter`,
  // sync everything else, render.
  function bindEdit(editor, setter) {
    editor.addEventListener('input', () => {
      if (syncing || !original) return;
      if (setter() === false) return;
      syncDisplays(editor);
      debouncedRender();
    });
  }

  bindEdit(percent, setFromPercent);
  bindEdit(exactW, setFromExactW);
  bindEdit(exactH, setFromExactH);
  bindEdit(physW, setFromPhysW);
  bindEdit(physH, setFromPhysH);

  // DPI change in physical mode: physical-W/H stay the same, but the pixel
  // target scales. Recompute canonical from physical-W (which uses the new DPI)
  // and propagate to all other displays.
  physDpi.addEventListener('input', () => {
    if (syncing || !original) return;
    if (!(+physDpi.value > 0)) return;
    if (setFromPhysW() === false) return;
    syncDisplays(physDpi);
    debouncedRender();
  });

  // Unit change: pixel target stays the same; only the displayed physical
  // numbers change (re-derived from canonical / new pxPerUnit).
  let lastUnit = physUnit.value;
  physUnit.addEventListener('change', () => {
    if (!original) { lastUnit = physUnit.value; return; }
    // Canonical (targetW/H) is unchanged on unit toggle by design.
    syncDisplays();
    lastUnit = physUnit.value;
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
    let suffix;
    if (dimMode.value === 'physical') {
      const u = physUnit.value;
      const dpi = +physDpi.value || 300;
      const wp = (+physW.value || 0).toFixed(2).replace(/\.?0+$/, '');
      const hp = (+physH.value || 0).toFixed(2).replace(/\.?0+$/, '');
      suffix = `${wp}x${hp}${u}_${dpi}dpi`;
    } else {
      suffix = `${targetW}x${targetH}`;
    }
    const a = document.createElement('a');
    a.href = outputUrl;
    a.download = `${base}_${suffix}.${ext}`;
    document.body.appendChild(a);
    a.click();
    a.remove();
  });

  resetBtn.addEventListener('click', () => {
    currentGen++;
    if (outputUrl) URL.revokeObjectURL(outputUrl);
    original = null;
    originalW = originalH = 0;
    targetW = targetH = 0;
    outputBlob = null;
    outputUrl = null;
    file.value = '';
    controls.hidden = true;
    drop.hidden = false;
    downloadBtn.disabled = true;
    preview.innerHTML = '';
    meta.innerHTML = '';
    clearError();

    // Restore every form control back to its initial default so the next
    // image doesn't inherit the previous session's settings.
    dimMode.value = 'none';
    percent.value = 50;
    percentVal.textContent = '50%';
    exactW.value = '';
    exactH.value = '';
    physW.value = '';
    physH.value = '';
    physUnit.value = 'in';
    physDpi.value = '300';
    physPxReadout.textContent = '';
    strategy.value = 'quality';
    quality.value = 80;
    qualityVal.textContent = '80%';
    quality.disabled = false;
    targetKb.value = '500';
    format.value = 'image/webp';
    syncDimRows();
    $('row-quality').hidden = strategy.value !== 'quality';
    $('row-target').hidden = strategy.value !== 'target';
  });

  // Initial UI state
  syncDimRows();
  $('row-quality').hidden = strategy.value !== 'quality';
  $('row-target').hidden = strategy.value !== 'target';
})();
