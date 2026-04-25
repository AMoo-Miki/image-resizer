// Browser-side test runner. Loaded via Playwright `evaluate`.
// Returns { total, passed, failedCount, failed: [...], details: [...] }.
//
// Helpers run inside the page; they assume the live app's IIFE has booted.
// All reads use document.getElementById(...).
window.__runTests = async function () {
  const $ = (id) => document.getElementById(id);
  const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
  const results = [];
  const pass = (name) => results.push({ name, ok: true });
  const fail = (name, info) => results.push({ name, ok: false, ...info });

  function eq(name, got, want) {
    if (Object.is(got, want) || JSON.stringify(got) === JSON.stringify(want)) pass(name);
    else fail(name, { msg: 'mismatch', got, want });
  }
  function close(name, got, want, eps) {
    if (typeof got === 'number' && typeof want === 'number' && Math.abs(got - want) <= eps) pass(name);
    else fail(name, { msg: `not within ${eps}`, got, want });
  }
  function truthy(name, got) { got ? pass(name) : fail(name, { msg: 'expected truthy', got }); }
  function falsy(name, got)  { !got ? pass(name) : fail(name, { msg: 'expected falsy', got }); }

  // Read a snapshot of every dimension control's display state.
  function readState() {
    return {
      mode: $('dim-mode').value,
      percentSlider: +$('percent').value,
      percentReadout: $('percent-val').textContent,
      exactW: +$('exact-w').value,
      exactH: +$('exact-h').value,
      physW: +$('phys-w').value,
      physH: +$('phys-h').value,
      physUnit: $('phys-unit').value,
      physDpi: +$('phys-dpi').value,
      physReadout: $('phys-px-readout').textContent,
      meta: $('meta').textContent.trim(),
      previewSrc: ($('preview').querySelector('img') || {}).src || '',
      downloadDisabled: $('download').disabled,
      controlsHidden: $('controls').hidden,
      dropHidden: $('drop').hidden,
      errorHidden: $('error').hidden,
      errorText: $('error').textContent,
    };
  }

  // Convert a state into the canonical pixel target inferred from each view.
  // All four should produce the same (w, h).
  function inferredFromControls(s) {
    const k = s.physUnit === 'cm' ? s.physDpi / 2.54 : s.physDpi;
    return {
      fromExact: { w: s.exactW, h: s.exactH },
      fromPhys:  { w: Math.round(s.physW * k), h: Math.round(s.physH * k) },
      fromPercentReadout: (() => {
        const pct = parseFloat(s.percentReadout) / 100;
        return null; // we don't know originalW from state alone
      })(),
    };
  }

  // Set an input value and dispatch the right event the app listens to.
  function setRange(el, v) { el.value = String(v); el.dispatchEvent(new Event('input', { bubbles: true })); }
  function setNum(el, v)   { el.value = String(v); el.dispatchEvent(new Event('input', { bubbles: true })); }
  function setSelect(el, v){ el.value = v; el.dispatchEvent(new Event('change', { bubbles: true })); }

  // Build a synthetic PNG of given dims and a given color pattern, return Blob.
  async function makePng(w, h, drawer) {
    const c = document.createElement('canvas'); c.width = w; c.height = h;
    const g = c.getContext('2d');
    drawer ? drawer(g, w, h) : (g.fillStyle = '#888', g.fillRect(0, 0, w, h));
    return new Promise((r) => c.toBlob(r, 'image/png'));
  }

  async function loadBlob(blob, name = 'test.png', type = blob.type) {
    const dt = new DataTransfer();
    dt.items.add(new File([blob], name, { type }));
    const input = $('file');
    input.files = dt.files;
    input.dispatchEvent(new Event('change', { bubbles: true }));
  }

  // Wait for the app to settle: poll until preview src changes (or timeout).
  async function waitForRender(prevSrc = '', timeout = 1500) {
    const start = Date.now();
    while (Date.now() - start < timeout) {
      const cur = ($('preview').querySelector('img') || {}).src || '';
      if (cur && cur !== prevSrc) return cur;
      await sleep(40);
    }
    return ($('preview').querySelector('img') || {}).src || '';
  }

  // Test-only "factory reset": real users don't get this. We need it because
  // the app's Reset button now intentionally preserves preferences across
  // images, so prior-suite settings would leak into the next suite without
  // an explicit clean slate.
  async function reset() {
    if (!$('reset')) return;
    if (!$('controls').hidden) $('reset').click();
    // Wipe persisted prefs first — otherwise the assignments below would
    // immediately re-save the *post-assignment* values back to storage, but
    // we want the storage to be EMPTY so the next applyPrefs sees nothing.
    try { localStorage.removeItem('image-resizer-prefs-v1'); } catch {}
    const setVal = (id, v) => {
      const el = $(id);
      if (el && el.value !== String(v)) el.value = v;
    };
    setVal('dim-mode', 'none');
    setVal('percent', 50);
    setVal('exact-w', '');
    setVal('exact-h', '');
    setVal('phys-w', '');
    setVal('phys-h', '');
    setVal('phys-unit', 'in');
    setVal('phys-dpi', 300);
    setVal('strategy', 'quality');
    setVal('quality', 80);
    setVal('target-kb', 500);
    setVal('format', 'image/webp');
    if ($('phys-px-readout')) $('phys-px-readout').textContent = '';
    if ($('percent-val'))     $('percent-val').textContent = '50%';
    if ($('quality-val'))     $('quality-val').textContent = '80%';
    if ($('quality'))         $('quality').disabled = false;
    // Refresh row visibility via the app's own listeners.
    if (window.__imageResizerInternals) window.__imageResizerInternals.applyPrefs();
    // Final wipe: applyPrefs read empty storage but our setVal calls did not
    // touch storage either (programmatic .value assignments don't fire events).
    try { localStorage.removeItem('image-resizer-prefs-v1'); } catch {}
    await sleep(40);
  }

  async function loadDefault(w = 1696, h = 1131) {
    await reset();
    const blob = await makePng(w, h, (g, W, H) => {
      const grad = g.createLinearGradient(0, 0, W, H);
      grad.addColorStop(0, '#7c3aed'); grad.addColorStop(1, '#34d399');
      g.fillStyle = grad; g.fillRect(0, 0, W, H);
    });
    const prev = ($('preview').querySelector('img') || {}).src || '';
    await loadBlob(blob, `test_${w}x${h}.png`);
    await waitForRender(prev);
  }

  // ---------------------- A. Bootstrap / no image ------------------------
  await reset();
  {
    const s = readState();
    truthy('A1 drop visible', !s.dropHidden);
    truthy('A1 controls hidden', s.controlsHidden);
    truthy('A1 error hidden', s.errorHidden);
    truthy('A1 download disabled', s.downloadDisabled);
    eq('A1 preview empty', s.previewSrc, '');
    const drop = $('drop');
    eq('A2 drop tabindex', drop.getAttribute('tabindex'), '0');
    eq('A2 drop role', drop.getAttribute('role'), 'button');
  }

  // ---------------------- B. Image load & re-load ------------------------
  await loadDefault(1696, 1131);
  {
    const s = readState();
    truthy('B1 controls visible', !s.controlsHidden);
    truthy('B1 drop hidden', s.dropHidden);
    eq('B1 mode default', s.mode, 'none');
    eq('B1 percent slider', s.percentSlider, 100);
    eq('B1 percent readout', s.percentReadout, '100%');
    eq('B1 exactW', s.exactW, 1696);
    eq('B1 exactH', s.exactH, 1131);
    close('B1 physW (in @ 300)', s.physW, 1696 / 300, 0.005);
    close('B1 physH (in @ 300)', s.physH, 1131 / 300, 0.005);
    eq('B1 physReadout', s.physReadout, '→ 1696 × 1131 px');
    truthy('B1 preview present', !!s.previewSrc);
    falsy('B1 download enabled', s.downloadDisabled);
  }

  // B2 non-image
  await reset();
  {
    const txt = new Blob(['not an image'], { type: 'text/plain' });
    await loadBlob(txt, 'note.txt', 'text/plain');
    await sleep(150);
    const s = readState();
    falsy('B2 controls stay hidden', !s.controlsHidden);
    falsy('B2 error visible', s.errorHidden);
    truthy('B2 error mentions image', /image/i.test(s.errorText));
  }

  // B3 corrupted PNG
  await reset();
  {
    const garbage = new Blob([new Uint8Array([1,2,3,4,5,6,7,8])], { type: 'image/png' });
    await loadBlob(garbage, 'broken.png', 'image/png');
    await sleep(300);
    const s = readState();
    falsy('B3 error visible', s.errorHidden);
    truthy('B3 error mentions decode', /decode/i.test(s.errorText));
  }

  // B4 reload different file resets state
  await loadDefault(1696, 1131);
  await loadDefault(800, 600);
  {
    const s = readState();
    eq('B4 reload exactW', s.exactW, 800);
    eq('B4 reload exactH', s.exactH, 600);
    eq('B4 reload percent', s.percentSlider, 100);
  }

  // B5 portrait
  await loadDefault(800, 1200);
  {
    const s = readState();
    eq('B5 portrait exactW', s.exactW, 800);
    eq('B5 portrait exactH', s.exactH, 1200);
  }

  // B6 square
  await loadDefault(500, 500);
  {
    const s = readState();
    eq('B6 square exactW', s.exactW, 500);
    eq('B6 square exactH', s.exactH, 500);
  }

  // ---------------------- C. Row visibility per mode ---------------------
  await loadDefault(1696, 1131);
  function visible(id) {
    const el = $(id);
    return !el.hidden && getComputedStyle(el).display !== 'none';
  }
  function rowVis() {
    return {
      percent: visible('row-percent'),
      exact: visible('row-exact'),
      physical: visible('row-physical'),
      physicalDpi: visible('row-physical-dpi'),
    };
  }
  setSelect($('dim-mode'), 'none');     await sleep(100); eq('C1 none', rowVis(), {percent:false,exact:false,physical:false,physicalDpi:false});
  setSelect($('dim-mode'), 'percent');  await sleep(100); eq('C2 percent', rowVis(), {percent:true,exact:false,physical:false,physicalDpi:false});
  setSelect($('dim-mode'), 'exact');    await sleep(100); eq('C3 exact', rowVis(), {percent:false,exact:true,physical:false,physicalDpi:false});
  setSelect($('dim-mode'), 'physical'); await sleep(100); eq('C4 physical', rowVis(), {percent:false,exact:false,physical:true,physicalDpi:true});

  // ---------------------- D. Canonical sync ------------------------------
  // D1 percent → 50
  await loadDefault(1696, 1131);
  setSelect($('dim-mode'), 'percent');
  setRange($('percent'), 50);
  await sleep(400);
  {
    const s = readState();
    eq('D1 percent slider', s.percentSlider, 50);
    eq('D1 percent readout', s.percentReadout, '50%');
    eq('D1 exactW', s.exactW, 848);
    eq('D1 exactH', s.exactH, 566);
    close('D1 physW', s.physW, 848 / 300, 0.01);
    close('D1 physH', s.physH, 566 / 300, 0.01);
    eq('D1 physReadout', s.physReadout, '→ 848 × 566 px');
  }

  // D2 type exact-w = 848 (after reset to 100%)
  await loadDefault(1696, 1131);
  setSelect($('dim-mode'), 'exact');
  setNum($('exact-w'), 848);
  await sleep(400);
  {
    const s = readState();
    eq('D2 exactW', s.exactW, 848);
    eq('D2 exactH', s.exactH, 566);
    eq('D2 percent slider', s.percentSlider, 50);
    eq('D2 percent readout', s.percentReadout, '50%');
    close('D2 physW', s.physW, 848 / 300, 0.01);
  }

  // D3 type exact-h = 566
  await loadDefault(1696, 1131);
  setSelect($('dim-mode'), 'exact');
  setNum($('exact-h'), 566);
  await sleep(400);
  {
    const s = readState();
    eq('D3 exactH', s.exactH, 566);
    eq('D3 exactW', s.exactW, 849); // 566 * 1696/1131 = 849.0...
    eq('D3 percent', s.percentSlider, 50);
  }

  // D4 type phys-w = 4 in
  await loadDefault(1696, 1131);
  setSelect($('dim-mode'), 'physical');
  setNum($('phys-w'), 4);
  await sleep(400);
  {
    const s = readState();
    eq('D4 physW', s.physW, 4);
    close('D4 physH', s.physH, 4 / 1.5, 0.01); // 2.67
    eq('D4 exactW', s.exactW, 1200);
    eq('D4 exactH', s.exactH, 800);
    eq('D4 physReadout', s.physReadout, '→ 1200 × 800 px');
    eq('D4 percent', s.percentSlider, Math.round(1200 / 1696 * 100));
  }

  // D5 type phys-h = 4 in
  await loadDefault(1696, 1131);
  setSelect($('dim-mode'), 'physical');
  setNum($('phys-h'), 4);
  await sleep(400);
  {
    const s = readState();
    eq('D5 physH', s.physH, 4);
    close('D5 physW', s.physW, 4 * 1.5, 0.01);
    eq('D5 exactH', s.exactH, 1200);
    // 4in × 300 = 1200; round(1200 * 1696/1131) = round(1799.49) = 1799.
    eq('D5 exactW', s.exactW, 1799);
  }

  // D6 DPI 300 → 600 (phys numbers unchanged, pixels double)
  await loadDefault(1696, 1131);
  setSelect($('dim-mode'), 'physical');
  setNum($('phys-w'), 4);
  await sleep(400);
  setNum($('phys-dpi'), 600);
  await sleep(400);
  {
    const s = readState();
    eq('D6 phys-w unchanged', s.physW, 4);
    close('D6 phys-h unchanged', s.physH, 4 / 1.5, 0.01);
    eq('D6 exactW doubled', s.exactW, 2400);
    eq('D6 exactH doubled', s.exactH, 1600);
    eq('D6 readout', s.physReadout, '→ 2400 × 1600 px');
  }

  // D7 unit in → cm (pixels unchanged)
  await loadDefault(1696, 1131);
  setSelect($('dim-mode'), 'physical');
  setNum($('phys-w'), 4);
  await sleep(400);
  setSelect($('phys-unit'), 'cm');
  await sleep(400);
  {
    const s = readState();
    close('D7 physW (cm)', s.physW, 4 * 2.54, 0.02);
    close('D7 physH (cm)', s.physH, (4 / 1.5) * 2.54, 0.02);
    eq('D7 pixels unchanged exactW', s.exactW, 1200);
    eq('D7 pixels unchanged exactH', s.exactH, 800);
  }

  // D8 unit cm → in round-trip
  setSelect($('phys-unit'), 'in');
  await sleep(400);
  {
    const s = readState();
    close('D8 round-trip physW', s.physW, 4, 0.05);
    eq('D8 round-trip exactW', s.exactW, 1200);
  }

  // D9 toggle in→cm 5 times, measure drift
  await loadDefault(1696, 1131);
  setSelect($('dim-mode'), 'physical');
  setNum($('phys-w'), 4);
  await sleep(400);
  for (let i = 0; i < 5; i++) {
    setSelect($('phys-unit'), 'cm'); await sleep(80);
    setSelect($('phys-unit'), 'in'); await sleep(80);
  }
  await sleep(200);
  {
    const s = readState();
    close('D9 drift after 5 cycles', s.physW, 4, 0.05);
  }

  // D10 percent above 200% pinned, readout shows real
  await loadDefault(1696, 1131);
  setSelect($('dim-mode'), 'exact');
  setNum($('exact-w'), 5000);
  await sleep(400);
  {
    const s = readState();
    eq('D10 slider pinned at 200', s.percentSlider, 200);
    truthy('D10 readout shows real %', /^29[0-9]%$/.test(s.percentReadout));
  }

  // D11 exact-w = 0 / empty graceful (no NaN, doesn't reset all to 1)
  await loadDefault(1696, 1131);
  setSelect($('dim-mode'), 'exact');
  setNum($('exact-w'), 0);
  await sleep(300);
  {
    const s = readState();
    truthy('D11 zero: exactH not absurd', s.exactH > 0);
    falsy ('D11 zero: exactH did not collapse to 1', s.exactH === 1);
  }
  setNum($('exact-w'), '');
  await sleep(300);
  {
    const s = readState();
    truthy('D11 empty: exactH not 1', s.exactH > 1);
  }

  // ---------------------- E. Mode switching preserves canonical ---------
  await loadDefault(1696, 1131);
  setSelect($('dim-mode'), 'percent');
  setRange($('percent'), 50);
  await sleep(400);
  setSelect($('dim-mode'), 'exact');
  await sleep(150);
  {
    const s = readState();
    eq('E1 exact reflects canonical', { w: s.exactW, h: s.exactH }, { w: 848, h: 566 });
  }

  // E2 set exact 1000×667, switch to percent
  await loadDefault(1696, 1131);
  setSelect($('dim-mode'), 'exact');
  setNum($('exact-w'), 1000);
  await sleep(400);
  setSelect($('dim-mode'), 'percent');
  await sleep(150);
  {
    const s = readState();
    eq('E2 percent slider 59', s.percentSlider, 59);
    eq('E2 percent readout 59%', s.percentReadout, '59%');
  }

  // E3 set physical 4×2.67 in @ 300, switch to exact
  await loadDefault(1696, 1131);
  setSelect($('dim-mode'), 'physical');
  setNum($('phys-w'), 4);
  await sleep(400);
  setSelect($('dim-mode'), 'exact');
  await sleep(150);
  {
    const s = readState();
    eq('E3 exact reflects physical', { w: s.exactW, h: s.exactH }, { w: 1200, h: 800 });
  }

  // E4 switch to none → resets to original
  await loadDefault(1696, 1131);
  setSelect($('dim-mode'), 'exact');
  setNum($('exact-w'), 500);
  await sleep(400);
  setSelect($('dim-mode'), 'none');
  await sleep(150);
  {
    const s = readState();
    eq('E4 none resets exactW', s.exactW, 1696);
    eq('E4 none resets exactH', s.exactH, 1131);
    eq('E4 none resets percent', s.percentSlider, 100);
  }

  // ---------------------- F. Aspect ratio always locked ------------------
  await loadDefault(1696, 1131);
  const r0 = 1696 / 1131;
  setSelect($('dim-mode'), 'exact');
  setNum($('exact-w'), 700);
  await sleep(300);
  {
    const s = readState();
    close('F2 exact w→h ratio', s.exactW / s.exactH, r0, 0.01);
  }
  setNum($('exact-h'), 400);
  await sleep(300);
  {
    const s = readState();
    close('F3 exact h→w ratio', s.exactW / s.exactH, r0, 0.01);
  }
  setSelect($('dim-mode'), 'physical');
  setNum($('phys-w'), 5);
  await sleep(300);
  {
    const s = readState();
    close('F4 phys w→h ratio', s.physW / s.physH, r0, 0.02);
  }
  setNum($('phys-h'), 3);
  await sleep(300);
  {
    const s = readState();
    close('F5 phys h→w ratio', s.physW / s.physH, r0, 0.02);
  }

  // F6 reload with different aspect → ratio updates
  await loadDefault(800, 1200); // portrait, ratio 0.667
  setSelect($('dim-mode'), 'exact');
  setNum($('exact-w'), 400);
  await sleep(300);
  {
    const s = readState();
    close('F6 portrait ratio', s.exactW / s.exactH, 800 / 1200, 0.01);
  }

  // ---------------------- G. Compression ---------------------------------
  await loadDefault(1696, 1131);
  // G1 quality slider affects file size
  setSelect($('format'), 'image/webp');
  setRange($('quality'), 30); await sleep(400);
  const sLow = readState();
  setRange($('quality'), 95); await sleep(400);
  const sHigh = readState();
  // We can't read blob size directly; meta has it. Parse "→ <num> KB".
  function metaSize(meta) {
    const m = meta.match(/→\s*([\d.]+)\s*(B|KB|MB)/);
    if (!m) return null;
    const v = parseFloat(m[1]);
    const u = m[2];
    return u === 'B' ? v : u === 'KB' ? v * 1024 : v * 1024 * 1024;
  }
  const lowBytes = metaSize(sLow.meta);
  const highBytes = metaSize(sHigh.meta);
  truthy('G1 quality 30 < quality 95', lowBytes && highBytes && lowBytes < highBytes);

  // G2 PNG disables quality slider
  setSelect($('format'), 'image/png'); await sleep(200);
  truthy('G2 PNG disables quality', $('quality').disabled);
  setSelect($('format'), 'image/webp'); await sleep(200);
  falsy('G2 WebP re-enables quality', $('quality').disabled);

  // G3 transparent PNG → JPEG fills white
  await reset();
  const transBlob = await new Promise((r) => {
    const c = document.createElement('canvas'); c.width = 100; c.height = 100;
    const g = c.getContext('2d');
    // leave transparent
    c.toBlob(r, 'image/png');
  });
  await loadBlob(transBlob, 'trans.png');
  await sleep(400);
  setSelect($('format'), 'image/jpeg');
  await sleep(500);
  // Read the preview image's center pixel
  const g3CenterColor = await new Promise((r) => {
    const img = $('preview').querySelector('img');
    if (!img) return r(null);
    const probe = new Image();
    probe.crossOrigin = 'anonymous';
    probe.onload = () => {
      const c = document.createElement('canvas'); c.width = probe.naturalWidth; c.height = probe.naturalHeight;
      const g = c.getContext('2d'); g.drawImage(probe, 0, 0);
      const d = g.getImageData(probe.naturalWidth/2|0, probe.naturalHeight/2|0, 1, 1).data;
      r([d[0], d[1], d[2]]);
    };
    probe.onerror = () => r(null);
    probe.src = img.src;
  });
  truthy('G3 JPEG center pixel ~white', g3CenterColor && g3CenterColor[0] > 240 && g3CenterColor[1] > 240 && g3CenterColor[2] > 240);

  // G4 switching format actually changes blob mime
  await loadDefault(400, 300);
  setSelect($('format'), 'image/webp'); await sleep(400);
  // download href is what we'd save; check filename ext in click handler indirectly.
  // We can fetch the blob via the preview img src
  async function previewMime() {
    const src = $('preview').querySelector('img').src;
    const r = await fetch(src);
    const b = await r.blob();
    return b.type;
  }
  eq('G4 webp mime', await previewMime(), 'image/webp');
  setSelect($('format'), 'image/jpeg'); await sleep(400);
  eq('G4 jpeg mime', await previewMime(), 'image/jpeg');
  setSelect($('format'), 'image/png'); await sleep(400);
  eq('G4 png mime', await previewMime(), 'image/png');

  // ---------------------- H. Target file size search ---------------------
  await loadDefault(1696, 1131);
  setSelect($('format'), 'image/webp');
  setSelect($('strategy'), 'target');
  await sleep(100);
  setNum($('target-kb'), 100);
  $('target-go').click();
  // wait for "Searching..." -> "Find quality"
  let searched = false;
  for (let i = 0; i < 50; i++) {
    if ($('target-go').textContent === 'Find quality' && !$('target-go').disabled) { searched = true; break; }
    await sleep(100);
  }
  truthy('H1 search completes', searched);
  {
    const sz = metaSize(readState().meta);
    truthy('H1 size under target', sz && sz <= 100 * 1024);
  }
  // H2 tiny target → error
  setNum($('target-kb'), 1);
  $('target-go').click();
  await sleep(2500);
  {
    const s = readState();
    falsy('H2 tiny target error visible', s.errorHidden);
  }
  // H3 PNG + target → error
  setSelect($('format'), 'image/png');
  setNum($('target-kb'), 100);
  $('target-go').click();
  await sleep(200);
  {
    const s = readState();
    falsy('H3 PNG target error visible', s.errorHidden);
    truthy('H3 PNG error mentions PNG', /PNG/i.test(s.errorText));
  }

  // ---------------------- I. Download filenames --------------------------
  // We hijack <a>.click() to capture the download attribute without actually saving.
  await loadDefault(1696, 1131);
  setSelect($('format'), 'image/webp');
  setSelect($('strategy'), 'quality');
  let captured = null;
  const origCreate = document.createElement.bind(document);
  document.createElement = function (tag) {
    const el = origCreate(tag);
    if (tag.toLowerCase() === 'a') {
      const origClick = el.click.bind(el);
      el.click = function () { captured = el.download; };
    }
    return el;
  };
  // I2 exact mode filename
  setSelect($('dim-mode'), 'exact');
  setNum($('exact-w'), 848);
  await sleep(400);
  $('download').click();
  eq('I2 exact filename', captured, 'test_1696x1131_848x566.webp');

  // I3 physical mode filename
  setSelect($('dim-mode'), 'physical');
  setNum($('phys-w'), 4);
  await sleep(400);
  setSelect($('format'), 'image/jpeg'); await sleep(400);
  $('download').click();
  eq('I3 physical filename', captured, 'test_1696x1131_4x2.67in_300dpi.jpg');

  // I4 dotted filename
  await reset();
  await loadBlob(await makePng(400, 300), 'v1.0.png');
  await sleep(400);
  setSelect($('format'), 'image/webp');
  $('download').click();
  eq('I4 dotted base preserved', captured, 'v1.0_400x300.webp');

  // I5 no extension
  await reset();
  await loadBlob(await makePng(400, 300), 'screenshot');
  await sleep(400);
  $('download').click();
  eq('I5 no-ext base preserved', captured, 'screenshot_400x300.webp');

  document.createElement = origCreate;

  // ---------------------- J. Reset preserves preferences -----------------
  // The Reset button is labeled "Choose another"; it clears the IMAGE
  // (preview, meta, image-specific dimension fields, file input) but keeps
  // user preferences so the next image inherits dim-mode, format, quality, etc.
  await reset();
  await loadDefault(800, 600);
  setSelect($('dim-mode'), 'physical');
  setNum($('phys-dpi'), 600);
  setSelect($('phys-unit'), 'cm');
  setSelect($('format'), 'image/jpeg');
  setRange($('quality'), 60);
  setSelect($('strategy'), 'target');
  setNum($('target-kb'), 250);
  await sleep(300);
  $('reset').click();
  await sleep(200);
  {
    const s = readState();
    truthy('J1 drop visible', !s.dropHidden);
    truthy('J1 controls hidden', s.controlsHidden);
    truthy('J1 download disabled', s.downloadDisabled);
    eq    ('J1 preview cleared', s.previewSrc, '');
    eq    ('J1 meta cleared', s.meta, '');
    truthy('J1 error hidden', s.errorHidden);
    eq    ('J2 file input cleared', $('file').value, '');
    // Image-specific dimension fields cleared.
    eq('J3 exact-w cleared',  $('exact-w').value, '');
    eq('J3 exact-h cleared',  $('exact-h').value, '');
    eq('J3 phys-w cleared',   $('phys-w').value,  '');
    eq('J3 phys-h cleared',   $('phys-h').value,  '');
    // Preferences PRESERVED across reset.
    eq('J4 dim-mode preserved',  $('dim-mode').value,  'physical');
    eq('J4 phys-dpi preserved',  $('phys-dpi').value,  '600');
    eq('J4 phys-unit preserved', $('phys-unit').value, 'cm');
    eq('J4 format preserved',    $('format').value,    'image/jpeg');
    eq('J4 quality preserved',   +$('quality').value,  60);
    eq('J4 strategy preserved',  $('strategy').value,  'target');
    eq('J4 target-kb preserved', $('target-kb').value, '250');
  }

  // ---------------------- Z. Persistence (localStorage) ------------------
  const STORAGE_KEY = 'image-resizer-prefs-v1';

  // Z1 — touching a remembered control writes to localStorage.
  await reset();
  setSelect($('dim-mode'), 'percent');
  setSelect($('format'),   'image/jpeg');
  setNum   ($('phys-dpi'), 240);
  setRange ($('quality'),  65);
  await sleep(80);
  {
    const stored = JSON.parse(localStorage.getItem(STORAGE_KEY) || '{}');
    eq('Z1 dim-mode persisted', stored['dim-mode'], 'percent');
    eq('Z1 format persisted',   stored['format'],   'image/jpeg');
    eq('Z1 phys-dpi persisted', stored['phys-dpi'], '240');
    eq('Z1 quality persisted',  stored['quality'],  '65');
  }

  // Z2 — image-specific fields are NEVER persisted (no exact-w, no phys-w).
  await reset();
  await loadDefault(1696, 1131);
  setSelect($('dim-mode'), 'exact');
  setNum($('exact-w'), 800);
  await sleep(150);
  setSelect($('dim-mode'), 'physical');
  setNum($('phys-w'), 4);
  await sleep(150);
  {
    const stored = JSON.parse(localStorage.getItem(STORAGE_KEY) || '{}');
    falsy('Z2 exact-w not persisted', 'exact-w' in stored);
    falsy('Z2 exact-h not persisted', 'exact-h' in stored);
    falsy('Z2 phys-w not persisted',  'phys-w'  in stored);
    falsy('Z2 phys-h not persisted',  'phys-h'  in stored);
  }

  // Z3 — applyPrefs restores from localStorage (simulates a page reload).
  await reset();
  localStorage.setItem(STORAGE_KEY, JSON.stringify({
    'dim-mode': 'physical',
    'phys-dpi': '450',
    'phys-unit': 'cm',
    'format':    'image/png',
    'quality':   '50',
    'strategy':  'target',
    'target-kb': '300',
    'percent':   '75',
  }));
  window.__imageResizerInternals.applyPrefs();
  {
    eq('Z3 dim-mode restored',  $('dim-mode').value,  'physical');
    eq('Z3 phys-dpi restored',  $('phys-dpi').value,  '450');
    eq('Z3 phys-unit restored', $('phys-unit').value, 'cm');
    eq('Z3 format restored',    $('format').value,    'image/png');
    eq('Z3 quality restored',   +$('quality').value,  50);
    eq('Z3 strategy restored',  $('strategy').value,  'target');
    eq('Z3 target-kb restored', $('target-kb').value, '300');
    eq('Z3 percent restored',   +$('percent').value,  75);
    // Derived UI also updates.
    truthy('Z3 quality slider disabled (PNG)',     $('quality').disabled);
    eq    ('Z3 quality readout matches',           $('quality-val').textContent, '50%');
    eq    ('Z3 percent readout matches',           $('percent-val').textContent, '75%');
    // Row visibility reflects restored mode/strategy.
    eq('Z3 physical row visible',  $('row-physical').hidden,     false);
    eq('Z3 target row visible',    $('row-target').hidden,       false);
    eq('Z3 quality row hidden',    $('row-quality').hidden,      true);
  }

  // Z4 — corrupted localStorage doesn't crash; falls back to factory defaults.
  await reset();
  localStorage.setItem(STORAGE_KEY, '{not-valid-json');
  let crashed = false;
  try { window.__imageResizerInternals.applyPrefs(); } catch { crashed = true; }
  truthy('Z4 corrupt storage: applyPrefs does not throw', !crashed);
  eq('Z4 corrupt storage: dim-mode = factory default', $('dim-mode').value, 'none');

  // loadAfterPrefs: like loadDefault, but does NOT call reset() (which would
  // wipe the localStorage we just seeded). Use this for Z5+ where the whole
  // point is to verify that prefs survive into a freshly-loaded image.
  async function loadAfterPrefs(w, h) {
    if (!$('controls').hidden) {
      $('reset').click();
      await sleep(60);
    }
    const blob = await makePng(w, h);
    const prevSrc = ($('preview').querySelector('img') || {}).src || '';
    await loadBlob(blob, 'pref-test.png');
    await waitForRender(prevSrc);
  }

  // Z5 — newly-loaded image inherits remembered dim-mode + percent.
  await reset();
  localStorage.setItem(STORAGE_KEY, JSON.stringify({
    'dim-mode': 'percent', 'percent': '50',
  }));
  window.__imageResizerInternals.applyPrefs();
  await loadAfterPrefs(1696, 1131);
  {
    const s = readState();
    eq('Z5 percent applied to new image: exactW', s.exactW, 848);
    eq('Z5 percent applied to new image: exactH', s.exactH, 566);
    eq('Z5 percent slider stays at 50',           s.percentSlider, 50);
  }

  // Z6 — newly-loaded image inherits remembered DPI/unit (physical mode
  // with no remembered phys-w/h still derives sensible numbers).
  await reset();
  localStorage.setItem(STORAGE_KEY, JSON.stringify({
    'dim-mode': 'physical', 'phys-dpi': '600', 'phys-unit': 'in',
  }));
  window.__imageResizerInternals.applyPrefs();
  await loadAfterPrefs(1200, 600); // 2:1 image at 600 DPI = 2 × 1 in
  {
    const s = readState();
    eq('Z6 dpi applied: exactW unchanged (no phys-w override)', s.exactW, 1200);
    close('Z6 dpi computes phys-w', s.physW, 2.0, 0.01);
    close('Z6 dpi computes phys-h', s.physH, 1.0, 0.01);
  }

  // ---------------------- K. Memory hygiene ------------------------------
  // Track URL.createObjectURL/revokeObjectURL: if we render N times, only one
  // URL should be live. The explicit reset() is REQUIRED — without it, prior
  // suite cleanup runs against the patched URL functions and skews counts.
  await reset();
  const created = [], revoked = [];
  const oCreate = URL.createObjectURL, oRevoke = URL.revokeObjectURL;
  URL.createObjectURL = function (b) { const u = oCreate.call(URL, b); created.push(u); return u; };
  URL.revokeObjectURL = function (u) { revoked.push(u); return oRevoke.call(URL, u); };
  await loadDefault(800, 600);
  for (let i = 0; i < 5; i++) {
    setRange($('quality'), 50 + i * 5);
    await sleep(150);
  }
  await sleep(400);
  const aliveCount = created.length - revoked.length;
  truthy(`K1 only one URL alive at a time (created=${created.length} revoked=${revoked.length})`, aliveCount === 1);
  $('reset').click();
  await sleep(200);
  truthy(`K2 reset revokes live URL (created=${created.length} revoked=${revoked.length})`, created.length === revoked.length);
  URL.createObjectURL = oCreate; URL.revokeObjectURL = oRevoke;

  // ---------------------- L. Drag and drop -------------------------------
  await reset();
  const drop = $('drop');
  drop.dispatchEvent(new DragEvent('dragover', { bubbles: true, cancelable: true }));
  truthy('L1 dragover adds .over', drop.classList.contains('over'));
  drop.dispatchEvent(new DragEvent('dragleave', { bubbles: true }));
  falsy('L2 dragleave removes .over', drop.classList.contains('over'));

  // L3 drop event triggers loadFile
  const dt = new DataTransfer();
  const blob = await makePng(200, 200);
  dt.items.add(new File([blob], 'dropped.png', { type: 'image/png' }));
  const dropEvt = new DragEvent('drop', { bubbles: true, cancelable: true, dataTransfer: dt });
  drop.dispatchEvent(dropEvt);
  await sleep(500);
  {
    const s = readState();
    truthy('L3 drop loaded file', !s.controlsHidden && s.exactW === 200);
  }

  // L4 window-level dragover/drop is preventDefault'd
  const winDrop = new DragEvent('drop', { bubbles: true, cancelable: true });
  const wasPrevented = !window.dispatchEvent(winDrop) || winDrop.defaultPrevented;
  truthy('L4 window drop preventDefault', wasPrevented);

  // ---------------------- M. Real JPEG fixture ---------------------------
  // Pull the on-disk Canon photo through the file-load path so we exercise
  // the same FileReader+decodeImage pipeline a real user would hit.
  async function loadFixture(path = '/test/fixtures/sample.jpg', name) {
    await reset();
    const r = await fetch(path);
    const blob = await r.blob();
    const prev = ($('preview').querySelector('img') || {}).src || '';
    await loadBlob(blob, name || path.split('/').pop(), blob.type);
    await waitForRender(prev, 3000);
    return blob;
  }
  async function decodeImage(url) {
    return new Promise((resolve, reject) => {
      const img = new Image();
      img.onload = () => resolve({ w: img.naturalWidth, h: img.naturalHeight, img });
      img.onerror = () => reject(new Error('decode failed'));
      img.src = url;
    });
  }
  function centerColor(decoded) {
    const c = document.createElement('canvas');
    c.width = decoded.w; c.height = decoded.h;
    const g = c.getContext('2d'); g.drawImage(decoded.img, 0, 0);
    const d = g.getImageData(decoded.w/2|0, decoded.h/2|0, 1, 1).data;
    return [d[0], d[1], d[2]];
  }

  const sampleBlob = await loadFixture();
  {
    const s = readState();
    eq('M1 sample dims', { w: s.exactW, h: s.exactH }, { w: 1696, h: 1131 });
    falsy('M1 download enabled', s.downloadDisabled);
    truthy('M1 preview present', !!s.previewSrc);
    truthy('M1 originalSize visible in meta', /KB|MB/.test(s.meta));
  }

  // ---------------------- N. Output formats from real JPEG ---------------
  setSelect($('dim-mode'), 'none');
  setSelect($('strategy'), 'quality');
  setRange($('quality'), 80);
  await sleep(400);

  async function previewBlob() {
    const src = $('preview').querySelector('img').src;
    const r = await fetch(src);
    return r.blob();
  }

  for (const fmt of ['image/webp', 'image/jpeg', 'image/png']) {
    setSelect($('format'), fmt);
    // PNG of a 1696x1131 photo can take ~1-2s to encode
    await sleep(fmt === 'image/png' ? 2000 : 800);
    const b = await previewBlob();
    eq(`N ${fmt} mime`, b.type, fmt);
    truthy(`N ${fmt} size > 10KB`, b.size > 10 * 1024);
    try {
      const d = await decodeImage(URL.createObjectURL(b));
      eq(`N ${fmt} decoded dims preserved`, { w: d.w, h: d.h }, { w: 1696, h: 1131 });
    } catch {
      fail(`N ${fmt} decoded dims preserved`, { msg: 'decode failed' });
    }
  }

  // Compression sanity: WebP and JPEG should be smaller than original for a photo;
  // PNG (lossless) of a photo is typically larger.
  setSelect($('format'), 'image/webp'); await sleep(800);
  const wbBlob = await previewBlob();
  truthy('N WebP smaller than original (570KB)', wbBlob.size < 583739);
  setSelect($('format'), 'image/jpeg'); setRange($('quality'), 80); await sleep(800);
  const jpBlob = await previewBlob();
  truthy('N JPEG q80 smaller than original', jpBlob.size < 583739);
  setSelect($('format'), 'image/png'); await sleep(2000);
  const pnBlob = await previewBlob();
  truthy('N PNG of photo larger than original JPEG', pnBlob.size > 583739);

  // Pixel-fidelity: encode to JPEG q95, decoded center pixel within tolerance.
  setSelect($('format'), 'image/jpeg'); setRange($('quality'), 95); await sleep(800);
  const reBlob = await previewBlob();
  const reUrl = URL.createObjectURL(reBlob);
  const origUrl = URL.createObjectURL(sampleBlob);
  try {
    const decReencoded = await decodeImage(reUrl);
    const decOriginal = await decodeImage(origUrl);
    const oC = centerColor(decOriginal), eC = centerColor(decReencoded);
    const diff = Math.max(Math.abs(oC[0]-eC[0]), Math.abs(oC[1]-eC[1]), Math.abs(oC[2]-eC[2]));
    truthy(`N JPEG q95 center pixel within 12 of original (orig=${oC} re=${eC} diff=${diff})`, diff <= 12);
  } finally {
    URL.revokeObjectURL(reUrl); URL.revokeObjectURL(origUrl);
  }

  // ---------------------- P. Very large image (encode failure) -----------
  // Try a 16384x16384 canvas (~1GB raw). Most browsers refuse; the app should
  // either succeed with a tiny JPEG or surface our "Encoding failed" error
  // without crashing.
  await reset();
  let huge = null;
  try {
    huge = await new Promise((r) => {
      const c = document.createElement('canvas'); c.width = 16384; c.height = 16384;
      const g = c.getContext('2d'); g.fillStyle = '#888'; g.fillRect(0, 0, 16384, 16384);
      c.toBlob(r, 'image/png');
    });
  } catch { huge = null; }
  if (huge) {
    await loadBlob(huge, 'huge.png');
    setSelect($('dim-mode'), 'none');
    setSelect($('format'), 'image/jpeg');
    await sleep(3000);
    const s = readState();
    if (!s.errorHidden) {
      truthy('P encode failure surfaced as error', /encoding failed/i.test(s.errorText));
    } else {
      pass('P large image encoded successfully (no error)');
    }
  } else {
    pass('P canvas creation refused by browser (size limit)');
  }

  // ---------------------- Q. Reset during async target search ------------
  await reset();
  await loadFixture();
  setSelect($('format'), 'image/webp');
  setSelect($('strategy'), 'target');
  setNum($('target-kb'), 200);
  $('target-go').click();
  await sleep(20); // let the search start (~1 encode in)
  $('reset').click();
  // Wait long enough for any in-flight encode iterations to finish.
  await sleep(2500);
  {
    const s = readState();
    truthy('Q reset wins: drop visible',     !s.dropHidden);
    truthy('Q reset wins: controls hidden',  s.controlsHidden);
    eq    ('Q reset wins: preview empty',    s.previewSrc, '');
    eq    ('Q reset wins: meta empty',       s.meta, '');
    truthy('Q reset wins: download disabled', s.downloadDisabled);
  }

  // Reset during a normal render() (changing format mid-load).
  await reset();
  await loadFixture();
  setSelect($('format'), 'image/png'); // slow encode
  await sleep(20);
  $('reset').click();
  await sleep(2500);
  {
    const s = readState();
    truthy('Q reset during render: drop visible', !s.dropHidden);
    eq    ('Q reset during render: preview empty', s.previewSrc, '');
  }

  // ---------------------- R. Multi-file drop / non-file drag --------------
  await reset();
  const dtMulti = new DataTransfer();
  const f1 = await makePng(100, 100);
  const f2 = await makePng(222, 222);
  dtMulti.items.add(new File([f1], 'a.png', { type: 'image/png' }));
  dtMulti.items.add(new File([f2], 'b.png', { type: 'image/png' }));
  $('drop').dispatchEvent(new DragEvent('drop', { bubbles: true, cancelable: true, dataTransfer: dtMulti }));
  await sleep(500);
  {
    const s = readState();
    truthy('R1 multi-drop loaded first file', !s.controlsHidden);
    eq('R1 multi-drop dims = first file', { w: s.exactW, h: s.exactH }, { w: 100, h: 100 });
  }
  await reset();
  $('drop').dispatchEvent(new DragEvent('drop', { bubbles: true, cancelable: true, dataTransfer: new DataTransfer() }));
  await sleep(200);
  {
    const s = readState();
    truthy('R2 empty-payload drop: stays in initial state', s.controlsHidden);
    truthy('R2 empty-payload drop: no error shown', s.errorHidden);
  }

  // ---------------------- S. syncing guard recovery ----------------------
  // Force one syncDisplays() to throw (by making percent.value setter blow up
  // once); after the throw, subsequent edits must still work, proving the
  // try/finally restored the syncing flag.
  await reset();
  await loadDefault(1696, 1131);
  setSelect($('dim-mode'), 'exact');
  const valDesc = Object.getOwnPropertyDescriptor(HTMLInputElement.prototype, 'value');
  let armed = true;
  Object.defineProperty($('percent'), 'value', {
    configurable: true,
    set(v) { if (armed) { armed = false; throw new Error('boom'); } valDesc.set.call(this, v); },
    get() { return valDesc.get.call(this); },
  });
  try { setNum($('exact-w'), 848); } catch {}
  await sleep(200);
  delete $('percent').value; // restore prototype getter/setter
  setNum($('exact-w'), 1000);
  await sleep(300);
  {
    const s = readState();
    eq('S subsequent edit succeeds (no deadlock)', s.exactW, 1000);
    // exact-h should also have been recomputed → 1000 / (1696/1131) ≈ 667
    close('S subsequent edit syncs partner', s.exactH, 667, 1);
  }

  // ---------------------- T. Long-cycle hygiene --------------------------
  // 30 load + reset cycles; nothing should accumulate in the DOM and no
  // object URLs should leak. Reset to a known-clean baseline before
  // patching counters so prior-suite state doesn't bias the totals.
  await reset();
  const created2 = [], revoked2 = [];
  const oc2 = URL.createObjectURL, or2 = URL.revokeObjectURL;
  URL.createObjectURL = function (b) { const u = oc2.call(URL, b); created2.push(u); return u; };
  URL.revokeObjectURL = function (u) { revoked2.push(u); return or2.call(URL, u); };
  for (let i = 0; i < 30; i++) {
    await loadDefault(400, 300);
    $('reset').click();
    await sleep(40);
  }
  URL.createObjectURL = oc2; URL.revokeObjectURL = or2;
  {
    eq('T preview cleared after cycles', $('preview').children.length, 0);
    eq('T file input cleared after cycles', $('file').value, '');
    // We may have a few outstanding URLs from test plumbing (decodeImage), but
    // the *app's* URLs should all be revoked by reset.
    truthy(`T no leaked app URLs (${created2.length} created, ${revoked2.length} revoked)`,
      created2.length === revoked2.length);
  }

  // ---------------------- U. Quality readout sync ------------------------
  await reset();
  await loadDefault(400, 300);
  setSelect($('format'), 'image/jpeg');
  for (const v of [1, 50, 73, 100]) {
    setRange($('quality'), v);
    eq(`U readout @${v}`, $('quality-val').textContent, v + '%');
  }

  // ---------------------- V. Mid-range percent precision ------------------
  await reset();
  await loadDefault(1696, 1131);
  setSelect($('dim-mode'), 'exact');
  setNum($('exact-w'), 1800);
  await sleep(300);
  eq('V 1800/1696 → 106%', readState().percentReadout, '106%');
  setNum($('exact-w'), 700);
  await sleep(300);
  eq('V 700/1696 → 41%', readState().percentReadout, '41%');

  // ---------------------- W. Keyboard tab order --------------------------
  // None of the interactive controls should opt out of the tab sequence
  // (tabindex="-1"). Drop zone uses tabindex="0" (verified in A2).
  {
    const ids = ['drop','dim-mode','percent','exact-w','exact-h','phys-w','phys-h',
                 'phys-unit','phys-dpi','strategy','quality','target-kb','target-go',
                 'format','download','reset'];
    const offenders = [];
    for (const id of ids) {
      const el = $(id);
      if (!el) { offenders.push(`${id} missing`); continue; }
      const ti = el.getAttribute('tabindex');
      if (ti && +ti < 0) offenders.push(`${id}=${ti}`);
    }
    truthy(`W all interactive controls tabbable (${offenders.join(', ') || 'ok'})`,
      offenders.length === 0);
  }

  // ---------------------- X. ARIA basics ---------------------------------
  {
    const errEl = $('error');
    eq('X error has role=status', errEl.getAttribute('role'), 'status');
    eq('X error has aria-live=polite', errEl.getAttribute('aria-live'), 'polite');
    const inputs = ['dim-mode','percent','exact-w','exact-h','phys-w','phys-h',
                    'phys-unit','phys-dpi','strategy','quality','target-kb','format'];
    const unlabeled = inputs.filter(id => {
      const el = document.getElementById(id);
      const hasFor = !!document.querySelector(`label[for="${id}"]`);
      const hasAria = el && (el.getAttribute('aria-label') || el.getAttribute('aria-labelledby'));
      return !hasFor && !hasAria;
    });
    truthy(`X all form inputs have a label or aria-label: missing=[${unlabeled.join(',')}]`,
      unlabeled.length === 0);
  }

  // ---------------------- Y. DPI metadata absence ------------------------
  // Canvas.toBlob doesn't write a pHYs chunk (PNG) or a JFIF density (JPEG).
  // Verify by parsing the output bytes; if a future browser starts writing
  // these, we want to know.
  await reset();
  await loadDefault(50, 50);
  setSelect($('format'), 'image/png'); await sleep(300);
  {
    const buf = new Uint8Array(await (await previewBlob()).arrayBuffer());
    let hasPhys = false;
    for (let i = 8; i < buf.length - 4; i++) {
      if (buf[i]===0x70 && buf[i+1]===0x48 && buf[i+2]===0x59 && buf[i+3]===0x73) { hasPhys = true; break; }
    }
    truthy('Y PNG has no pHYs (DPI) chunk — encoding strips DPI as documented', !hasPhys);
  }
  setSelect($('format'), 'image/jpeg'); await sleep(300);
  {
    const buf = new Uint8Array(await (await previewBlob()).arrayBuffer());
    // JFIF marker FF E0 then 'JFIF\0'; bytes 11-12 are units, 13-14 Xdens, 15-16 Ydens.
    let xd = -1, yd = -1, units = -1;
    for (let i = 0; i < buf.length - 16; i++) {
      if (buf[i]===0xFF && buf[i+1]===0xE0 &&
          buf[i+4]===0x4A && buf[i+5]===0x46 && buf[i+6]===0x49 && buf[i+7]===0x46 && buf[i+8]===0x00) {
        units = buf[i+11];
        xd = (buf[i+12] << 8) | buf[i+13];
        yd = (buf[i+14] << 8) | buf[i+15];
        break;
      }
    }
    // units=0 means "no units; aspect only" → effectively no DPI metadata.
    truthy(`Y JPEG JFIF units=${units} (0 = no DPI metadata) X=${xd} Y=${yd}`, units === 0);
  }

  // ---------------------- Summary ----------------------------------------
  const failed = results.filter(r => !r.ok);
  return {
    total: results.length,
    passed: results.length - failed.length,
    failedCount: failed.length,
    failed,
  };
};
