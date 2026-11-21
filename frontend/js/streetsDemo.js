const $ = (id) => document.getElementById(id);

const statusBanner = $('statusBanner');
const downloadWardStreetsLink = $('downloadWardStreetsLink');
const fitWardBtn = $('fitWardBtn');
const toggleLabelsBtn = $('toggleLabelsBtn');
const toggleZones = $('toggleZones');
const toggleLines = $('toggleLines');
const wardStatsPill = $('wardStatsPill');
const totalWardsCount = $('totalWardsCount');
const totalStreetsPill = $('totalStreetsPill');
const wardFilterInput = $('wardFilterInput');
const wardSelect = $('wardSelect');
const selectedCount = $('selectedCount');
const clearSelectedBtn = $('clearSelectedBtn');
const selectedHint = $('selectedHint');
const selectedChips = $('selectedChips');
const mergeRoutesBtn = $('mergeRoutesBtn');
const unmergeBtn = $('unmergeBtn');
const mergedBox = $('mergedBox');
const statArea = $('statArea');
const statLength = $('statLength');
const statParts = $('statParts');
const statChars = $('statChars');
const copyMergedBtn = $('copyMergedBtn');
const downloadMergedBtn = $('downloadMergedBtn');
const streetCount = $('streetCount');
const streetSearch = $('streetSearch');
const streetListEl = $('streetList');

const PALETTE = [
  '#2563eb', '#16a34a', '#e11d48', '#9333ea', '#ea580c', '#0891b2',
  '#ca8a04', '#4f46e5', '#059669', '#dc2626', '#0284c7', '#db2777',
];

const map = L.map('map', { zoomControl: true }).setView([11.935, 108.442], 12);
const googleVi = L.tileLayer('https://mt{s}.google.com/vt/lyrs=m&hl=vi&x={x}&y={y}&z={z}', {
  subdomains: ['0', '1', '2', '3'], maxZoom: 20, attribution: '&copy; Google Maps',
});
const esriSat = L.tileLayer(
  'https://server.arcgisonline.com/ArcGIS/rest/services/World_Imagery/MapServer/tile/{z}/{y}/{x}',
  { maxZoom: 19, attribution: 'Tiles &copy; Esri' },
);
googleVi.addTo(map);
L.control.layers({ 'Bản đồ tiếng Việt': googleVi, 'Ảnh vệ tinh': esriSat }, {}, { position: 'topright' }).addTo(map);

const wardBorderGroup = L.layerGroup().addTo(map);
const zonesGroup = L.layerGroup().addTo(map);
const linesGroup = L.layerGroup().addTo(map);
const mergedGroup = L.layerGroup().addTo(map);
const labelsGroup = L.layerGroup().addTo(map);

let allWardSummaries = [];
let bundle = null;
let wardBounds = null;
const selectedIds = new Set();
const zoneLayerById = new Map();
const lineLayerById = new Map();
let latestMerged = null;
let showStreetLabels = true;
let loadSeq = 0;

function setStatus(msg, type = 'success') {
  if (!msg) { statusBanner.hidden = true; return; }
  statusBanner.textContent = msg;
  statusBanner.className = `status-banner ${type}`;
  statusBanner.hidden = false;
}

function streetColor(id) {
  return PALETTE[id % PALETTE.length];
}

function getStreetLabelPoint(st) {
  const segs = st.lineGeojson?.coordinates || [];
  let bestSeg = null;
  let bestLen = -1;
  for (const seg of segs) {
    if (seg.length > bestLen) {
      bestLen = seg.length;
      bestSeg = seg;
    }
  }
  if (bestSeg && bestSeg.length > 0) {
    const mid = bestSeg[Math.floor(bestSeg.length / 2)];
    return L.latLng(mid[1], mid[0]);
  }
  const zl = zoneLayerById.get(st.id);
  return zl?.getBounds()?.isValid() ? zl.getBounds().getCenter() : null;
}

function renderStreetLabels() {
  labelsGroup.clearLayers();
  if (!showStreetLabels || !bundle) return;

  const zoom = map.getZoom();
  const targets =
    selectedIds.size > 0
      ? bundle.streets.filter((s) => selectedIds.has(s.id))
      : zoom >= 15
        ? bundle.streets
        : bundle.streets.filter((s) => ['motorway', 'trunk', 'primary', 'secondary'].includes(s.highway));

  for (const st of targets) {
    const pt = getStreetLabelPoint(st);
    if (!pt) continue;
    const isSel = selectedIds.has(st.id);
    const dot = `<span style="display:inline-block;width:7px;height:7px;border-radius:50%;background:${streetColor(st.id)};margin-right:5px;"></span>`;
    L.tooltip({
      permanent: true,
      direction: 'center',
      interactive: false,
      className: 'street-label-pill',
      opacity: isSel ? 1 : 0.88,
    })
      .setLatLng(pt)
      .setContent(`${dot}${st.name}`)
      .addTo(labelsGroup);
  }
}

function clearMergedResult() {
  latestMerged = null;
  mergedGroup.clearLayers();
  mergedBox.hidden = true;
  unmergeBtn.hidden = true;
}

function updateStreetStyles() {
  const hasSelection = selectedIds.size > 0;
  const isMerged = Boolean(latestMerged);

  for (const st of bundle?.streets || []) {
    const isSel = selectedIds.has(st.id);
    const col = streetColor(st.id);
    const zl = zoneLayerById.get(st.id);
    if (zl) {
      if (isSel && !isMerged) {
        zl.setStyle({ color: col, weight: 2.5, opacity: 0.95, fillColor: col, fillOpacity: 0.32 });
      } else if (isSel && isMerged) {
        zl.setStyle({ color: '#fb923c', weight: 0.8, opacity: 0.35, fillColor: '#fb923c', fillOpacity: 0.08 });
      } else {
        zl.setStyle({
          color: '#94a3b8',
          weight: 0.7,
          opacity: hasSelection ? 0.25 : 0.45,
          fillColor: col,
          fillOpacity: hasSelection ? 0.04 : 0.14,
        });
      }
    }
    const ll = lineLayerById.get(st.id);
    if (ll) {
      ll.setStyle({
        color: isSel ? col : '#334155',
        weight: isSel ? 4 : 1.5,
        opacity: isSel ? 1 : hasSelection ? 0.25 : 0.55,
      });
    }
  }
}

function fitSelectedStreets() {
  if (selectedIds.size === 0) return;
  const bounds = L.latLngBounds([]);
  for (const id of selectedIds) {
    const zl = zoneLayerById.get(id);
    if (zl?.getBounds()?.isValid()) bounds.extend(zl.getBounds());
  }
  if (bounds.isValid()) map.fitBounds(bounds, { padding: [44, 44], maxZoom: 16 });
}

async function runMergeSelectedStreets() {
  if (selectedIds.size === 0) return;
  mergeRoutesBtn.disabled = true;
  mergeRoutesBtn.textContent = 'Đang gộp...';
  setStatus(`Đang gộp ${selectedIds.size} tuyến đường bằng SQL Server...`, 'success');

  try {
    const res = await fetch('/api/streets/merge', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ streetIds: [...selectedIds] }),
    });
    const data = await res.json();
    if (!res.ok) throw new Error(data.error || 'Lỗi gộp vùng');

    latestMerged = data;
    mergedGroup.clearLayers();
    const layer = L.geoJSON(data.geometry, {
      interactive: false,
      style: { color: '#dc2626', weight: 3.5, opacity: 1, fillColor: '#f97316', fillOpacity: 0.32 },
    }).addTo(mergedGroup);

    statArea.textContent = `${data.areaKm2.toLocaleString('vi-VN', { maximumFractionDigits: 3 })} km²`;
    statLength.textContent = `${(data.totalLengthM / 1000).toLocaleString('vi-VN', { maximumFractionDigits: 2 })} km`;
    statParts.textContent =
      data.polygonParts === 1 ? '1 Polygon liền khối ✓' : `${data.polygonParts} mảnh rời (MultiPolygon)`;
    statChars.textContent = `${data.oneLineGeojson.length.toLocaleString('vi-VN')} ký tự`;
    mergedBox.hidden = false;
    unmergeBtn.hidden = false;
    updateStreetStyles();

    const b = layer.getBounds();
    if (b.isValid()) map.fitBounds(b, { padding: [50, 50], maxZoom: 16 });
    setStatus(
      `Đã gộp ${data.streetNames.length} tuyến đường → ${data.polygonParts === 1 ? '1 Polygon liền khối' : `${data.polygonParts} mảnh`} (${data.areaKm2.toFixed(3)} km²).`,
      'success',
    );
  } catch (err) {
    setStatus(`Lỗi gộp tuyến đường: ${err.message}`, 'error');
  } finally {
    mergeRoutesBtn.disabled = selectedIds.size === 0;
    mergeRoutesBtn.textContent = '🔀 Gộp tuyến phát';
  }
}

function syncSelectionUI({ shouldFit = false } = {}) {
  clearMergedResult();
  selectedCount.textContent = String(selectedIds.size);
  selectedHint.hidden = selectedIds.size > 0;
  mergeRoutesBtn.disabled = selectedIds.size === 0;

  selectedChips.innerHTML = '';
  for (const id of selectedIds) {
    const st = bundle?.streets?.find((s) => s.id === id);
    if (!st) continue;
    const chip = document.createElement('span');
    chip.className = 'demo-chip';
    chip.style.borderColor = streetColor(st.id);
    const dot = document.createElement('span');
    dot.className = 'color-dot';
    dot.style.background = streetColor(st.id);
    const label = document.createElement('span');
    label.textContent = st.name;
    const btn = document.createElement('button');
    btn.type = 'button';
    btn.textContent = '×';
    btn.title = 'Bỏ tuyến đường này';
    btn.addEventListener('click', () => toggleStreet(id));
    chip.append(dot, label, btn);
    selectedChips.appendChild(chip);
  }

  renderStreetList();
  updateStreetStyles();
  renderStreetLabels();

  if (selectedIds.size > 0) {
    const names = [...selectedIds]
      .map((id) => bundle.streets.find((s) => s.id === id)?.name)
      .filter(Boolean)
      .join(', ');
    setStatus(`Đang xem riêng ${selectedIds.size} tuyến đường: ${names}. Bấm "🔀 Gộp tuyến phát" để hòa thành 1 vùng.`, 'success');
    if (shouldFit) fitSelectedStreets();
  } else {
    setStatus('');
  }
}

function toggleStreet(id) {
  if (selectedIds.has(id)) selectedIds.delete(id);
  else selectedIds.add(id);
  syncSelectionUI({ shouldFit: true });
}

function renderStreetList() {
  if (!bundle) return;
  const q = (streetSearch.value || '').trim().toLowerCase();
  const filtered = bundle.streets.filter((s) => !q || s.name.toLowerCase().includes(q));
  streetCount.textContent = `${filtered.length}/${bundle.streets.length}`;

  streetListEl.innerHTML = '';
  if (filtered.length === 0) {
    streetListEl.innerHTML = `<div class="empty-hint">${
      bundle.streets.length === 0
        ? 'Xã/phường này chưa có đường đặt tên trên OpenStreetMap.'
        : 'Không tìm thấy tuyến đường phù hợp.'
    }</div>`;
    return;
  }

  const frag = document.createDocumentFragment();
  for (const st of filtered) {
    const isSel = selectedIds.has(st.id);
    const row = document.createElement('div');
    row.className = `street-row${isSel ? ' selected' : ''}`;
    row.innerHTML = `
      <div class="street-row-left">
        <input type="checkbox" ${isSel ? 'checked' : ''} />
        <span class="color-dot" style="background:${streetColor(st.id)}"></span>
        <span class="street-row-name"></span>
      </div>
      <span class="street-row-meta">${(st.lengthM / 1000).toFixed(2)} km · ${st.areaKm2.toFixed(2)} km²</span>
    `;
    row.querySelector('.street-row-name').textContent = st.name;
    row.addEventListener('click', (e) => {
      if (e.target.tagName === 'INPUT') e.stopPropagation();
      toggleStreet(st.id);
    });
    frag.appendChild(row);
  }
  streetListEl.appendChild(frag);
}

function renderWardSelect(preserveId = null) {
  const q = (wardFilterInput.value || '').trim().toLowerCase();
  const filtered = allWardSummaries.filter(
    (w) => !q || `${w.wardName} ${w.oldDistrict}`.toLowerCase().includes(q),
  );
  const currentVal = preserveId ?? Number(wardSelect.value);
  wardSelect.innerHTML = '';
  for (const w of filtered) {
    const opt = document.createElement('option');
    opt.value = String(w.wardUnitId);
    opt.textContent = `${w.wardName} (${w.streetCount} đường)${w.oldDistrict ? ` — ${w.oldDistrict}` : ''}`;
    if (w.wardUnitId === currentVal) opt.selected = true;
    wardSelect.appendChild(opt);
  }
}

async function loadWard(wardUnitId) {
  const seq = ++loadSeq;
  wardStatsPill.textContent = 'Đang tải tuyến đường...';
  selectedIds.clear();
  clearMergedResult();
  wardBorderGroup.clearLayers();
  zonesGroup.clearLayers();
  linesGroup.clearLayers();
  labelsGroup.clearLayers();
  zoneLayerById.clear();
  lineLayerById.clear();
  streetSearch.value = '';

  try {
    const res = await fetch(`/api/streets?wardUnitId=${encodeURIComponent(wardUnitId)}`);
    const data = await res.json();
    if (seq !== loadSeq) return;
    if (!res.ok) throw new Error(data.error || 'Không tải được tuyến đường');

    bundle = data;
    wardStatsPill.textContent = `${bundle.ward.name} · ${bundle.streetCount} tuyến đường · ${bundle.ward.areaKm2} km²`;
    downloadWardStreetsLink.href = `/api/streets/geojson?wardUnitId=${encodeURIComponent(wardUnitId)}`;
    downloadWardStreetsLink.hidden = bundle.streetCount === 0;

    if (bundle.ward.geojson) {
      const wardLayer = L.geoJSON(bundle.ward.geojson, {
        interactive: false,
        style: { color: '#0f172a', weight: 3, dashArray: '6,4', fillOpacity: 0 },
      }).addTo(wardBorderGroup);
      wardBounds = wardLayer.getBounds();
    } else {
      wardBounds = null;
    }

    for (const st of bundle.streets) {
      const zl = L.geoJSON(st.zoneGeojson, {
        style: { color: '#94a3b8', weight: 0.7, opacity: 0.45, fillColor: streetColor(st.id), fillOpacity: 0.14 },
        onEachFeature: (_f, lyr) => {
          lyr.bindTooltip(
            `<strong>🛣 ${st.name}</strong><br/>Dài: ${(st.lengthM / 1000).toFixed(2)} km · Vùng: ${st.areaKm2.toFixed(3)} km²<br/><em>Bấm để chọn / bỏ chọn</em>`,
            { sticky: true, direction: 'top', opacity: 0.96 },
          );
          lyr.on('click', () => toggleStreet(st.id));
        },
      }).addTo(zonesGroup);
      zoneLayerById.set(st.id, zl);

      const ll = L.geoJSON(st.lineGeojson, {
        style: { color: '#334155', weight: 1.5, opacity: 0.55 },
        onEachFeature: (_f, lyr) => {
          lyr.on('click', () => toggleStreet(st.id));
        },
      }).addTo(linesGroup);
      lineLayerById.set(st.id, ll);
    }

    syncSelectionUI();
    if (wardBounds?.isValid()) map.fitBounds(wardBounds, { padding: [24, 24] });
  } catch (err) {
    setStatus(`Lỗi tải tuyến đường: ${err.message}`, 'error');
  }
}

toggleLabelsBtn.addEventListener('click', () => {
  showStreetLabels = !showStreetLabels;
  toggleLabelsBtn.classList.toggle('active', showStreetLabels);
  toggleLabelsBtn.textContent = showStreetLabels ? '🏷 Đang hiện tên đường' : '🏷 Hiện tên đường';
  renderStreetLabels();
});

map.on('zoomend', () => {
  if (showStreetLabels && selectedIds.size === 0) renderStreetLabels();
});

toggleZones.addEventListener('change', () => {
  if (toggleZones.checked) zonesGroup.addTo(map);
  else map.removeLayer(zonesGroup);
});
toggleLines.addEventListener('change', () => {
  if (toggleLines.checked) linesGroup.addTo(map);
  else map.removeLayer(linesGroup);
});
fitWardBtn.addEventListener('click', () => {
  if (wardBounds?.isValid()) map.fitBounds(wardBounds, { padding: [24, 24] });
});
streetSearch.addEventListener('input', renderStreetList);
wardFilterInput.addEventListener('input', () => renderWardSelect());
wardSelect.addEventListener('change', () => {
  const id = Number(wardSelect.value);
  if (id > 0) loadWard(id);
});

mergeRoutesBtn.addEventListener('click', runMergeSelectedStreets);
unmergeBtn.addEventListener('click', () => {
  clearMergedResult();
  updateStreetStyles();
  setStatus(`Đã tách ra xem riêng ${selectedIds.size} tuyến đường.`, 'success');
});

clearSelectedBtn.addEventListener('click', () => {
  selectedIds.clear();
  syncSelectionUI();
  if (wardBounds?.isValid()) map.fitBounds(wardBounds, { padding: [24, 24] });
});

copyMergedBtn.addEventListener('click', async () => {
  if (!latestMerged?.oneLineGeojson) return;
  try {
    await navigator.clipboard.writeText(latestMerged.oneLineGeojson);
  } catch {
    const ta = document.createElement('textarea');
    ta.value = latestMerged.oneLineGeojson;
    ta.style.position = 'fixed';
    ta.style.opacity = '0';
    document.body.appendChild(ta);
    ta.select();
    document.execCommand('copy');
    ta.remove();
  }
  const old = copyMergedBtn.textContent;
  copyMergedBtn.textContent = 'Đã copy ✓';
  setTimeout(() => (copyMergedBtn.textContent = old), 1500);
});

downloadMergedBtn.addEventListener('click', () => {
  if (!latestMerged || !bundle) return;
  const fc = {
    type: 'FeatureCollection',
    features: [
      {
        type: 'Feature',
        properties: {
          ward: bundle.ward.name,
          streets: latestMerged.streetNames,
          area_km2: latestMerged.areaKm2,
          length_m: latestMerged.totalLengthM,
        },
        geometry: latestMerged.geometry,
      },
    ],
  };
  const blob = new Blob([JSON.stringify(fc, null, 2)], { type: 'application/geo+json;charset=utf-8' });
  const a = document.createElement('a');
  a.href = URL.createObjectURL(blob);
  a.download = `tuyen_phat_${bundle.ward.id}.geojson`;
  document.body.appendChild(a);
  a.click();
  a.remove();
  URL.revokeObjectURL(a.href);
});

async function init() {
  const res = await fetch('/api/streets/wards');
  const data = await res.json();
  if (!res.ok) throw new Error(data.error || 'Không tải được danh sách xã/phường');
  allWardSummaries = data.wards || [];
  totalWardsCount.textContent = String(allWardSummaries.length);
  const totalStreets = allWardSummaries.reduce((acc, w) => acc + w.streetCount, 0);
  totalStreetsPill.textContent = `${totalStreets.toLocaleString('vi-VN')} tuyến`;

  // Default to Phường Xuân Hương - Đà Lạt if present, else first ward with streets
  const defaultWard =
    allWardSummaries.find((w) => w.wardName.toLowerCase().includes('xuân hương')) ||
    allWardSummaries.find((w) => w.streetCount > 0) ||
    allWardSummaries[0];

  renderWardSelect(defaultWard?.wardUnitId || null);
  if (defaultWard) await loadWard(defaultWard.wardUnitId);
}

init().catch((err) => setStatus(`Lỗi khởi tạo: ${err.message}`, 'error'));
