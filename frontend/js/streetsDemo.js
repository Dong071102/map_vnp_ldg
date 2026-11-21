import { createPolygonEditor } from './polygonEditor.js';
import { serializeGeometryOneLine } from './geometry.js';
import { notify, confirmNoti } from './notify.js';

const $ = (id) => document.getElementById(id);

const statusBanner = $('statusBanner');
const adminBadge = $('adminBadge');
const adminLoginLink = $('adminLoginLink');
const downloadWardStreetsLink = $('downloadWardStreetsLink');
const fitWardBtn = $('fitWardBtn');
const toggleLabelsBtn = $('toggleLabelsBtn');
const toggleSavedRoutes = $('toggleSavedRoutes');
const toggleZones = $('toggleZones');
const toggleLines = $('toggleLines');
const wardStatsPill = $('wardStatsPill');
const totalWardsCount = $('totalWardsCount');
const totalStreetsPill = $('totalStreetsPill');
const wardFilterInput = $('wardFilterInput');
const wardSelect = $('wardSelect');

const streetsTabListBtn = $('streetsTabListBtn');
const streetsTabSavedBtn = $('streetsTabSavedBtn');
const streetsPanelList = $('streetsPanelList');
const streetsPanelSaved = $('streetsPanelSaved');
const selectionTray = $('selectionTray');

const savedRoutesCount = $('savedRoutesCount');
const savedRoutesEmpty = $('savedRoutesEmpty');
const savedRoutesListEl = $('savedRoutesList');

const selectedCount = $('selectedCount');
const clearSelectedBtn = $('clearSelectedBtn');
const selectedHint = $('selectedHint');
const selectedChips = $('selectedChips');
const mergeRoutesBtn = $('mergeRoutesBtn');
const unmergeBtn = $('unmergeBtn');
const addToExistingBox = $('addToExistingBox');
const targetExistingRouteSelect = $('targetExistingRouteSelect');
const appendToRouteBtn = $('appendToRouteBtn');
const mergedBox = $('mergedBox');
const statArea = $('statArea');
const statLength = $('statLength');
const statParts = $('statParts');
const statChars = $('statChars');
const saveRouteRow = $('saveRouteRow');
const adminOnlySaveHint = $('adminOnlySaveHint');
const mailRouteNameInput = $('mailRouteNameInput');
const mailRouteColorInput = $('mailRouteColorInput');
const saveMailRouteBtn = $('saveMailRouteBtn');
const copyMergedBtn = $('copyMergedBtn');
const downloadMergedBtn = $('downloadMergedBtn');

const streetCount = $('streetCount');
const streetSearch = $('streetSearch');
const streetListEl = $('streetList');

// Visual Polygon Editor Modal refs
const routeEditorModal = $('routeEditorModal');
const editorRouteNameInput = $('editorRouteNameInput');
const editorRouteColorInput = $('editorRouteColorInput');
const routeEditorSubtitle = $('routeEditorSubtitle');
const editorSaveBtn = $('editorSaveBtn');
const editorRevertBtn = $('editorRevertBtn');
const editorCopyBtn = $('editorCopyBtn');
const editorDownloadBtn = $('editorDownloadBtn');
const editorCloseBtn = $('editorCloseBtn');
const editorToggleEditBtn = $('editorToggleEditBtn');
const editorToggleTopoBtn = $('editorToggleTopoBtn');
const editorDrawPolyBtn = $('editorDrawPolyBtn');
const editorUndoBtn = $('editorUndoBtn');
const editorRedoBtn = $('editorRedoBtn');
const editorToggleNeighborsBtn = $('editorToggleNeighborsBtn');
const editorToggleRoadsBtn = $('editorToggleRoadsBtn');
const editorVertexBadge = $('editorVertexBadge');
const editorStatusToast = $('editorStatusToast');
const editorHint = $('editorHint');

const PALETTE = [
  '#2563eb', '#16a34a', '#e11d48', '#9333ea', '#ea580c', '#0891b2',
  '#ca8a04', '#4f46e5', '#059669', '#dc2626', '#0284c7', '#db2777',
];

const ROUTE_COLORS = [
  '#ea580c', '#2563eb', '#16a34a', '#9333ea', '#e11d48', '#0891b2',
  '#ca8a04', '#4f46e5', '#059669', '#dc2626', '#7c3aed', '#0284c7',
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
const savedRoutesGroup = L.layerGroup().addTo(map);
const mergedGroup = L.layerGroup().addTo(map);
const labelsGroup = L.layerGroup().addTo(map);

let allWardSummaries = [];
let bundle = null;
let savedRoutes = [];
let activeSavedRouteId = null;
let wardBounds = null;
const selectedIds = new Set();
const zoneLayerById = new Map();
const lineLayerById = new Map();
const savedRouteLayerById = new Map();
let latestMerged = null;
let showStreetLabels = true;
let loadSeq = 0;
let isAdmin = false;
let adminUsername = null;

// Editor state
let editorMap = null;
let polygonEditor = null;
let editorWardBorderGroup = null;
let editorRoadsGroup = null;
let showEditorRoads = true;
let editingRoute = null;
let editingSavedGeojson = null;
let editingSavedNeighbors = [];

function setStatus(msg, type = 'success') {
  if (statusBanner) statusBanner.hidden = true;
  if (!msg) return;
  notify(msg, { type });
}

function setEditorToast(msg, type = 'success') {
  if (!msg) { editorStatusToast.hidden = true; return; }
  editorStatusToast.textContent = msg;
  editorStatusToast.className = `modal-editor-status map-editor-toast ${type}`;
  editorStatusToast.hidden = false;
}

async function copyText(text) {
  if (navigator.clipboard && window.isSecureContext) {
    await navigator.clipboard.writeText(text);
    return;
  }
  const ta = document.createElement('textarea');
  ta.value = text;
  ta.style.position = 'fixed';
  ta.style.opacity = '0';
  document.body.appendChild(ta);
  ta.select();
  document.execCommand('copy');
  ta.remove();
}

function downloadGeojson(fc, filename) {
  const blob = new Blob([JSON.stringify(fc, null, 2)], { type: 'application/geo+json;charset=utf-8' });
  const a = document.createElement('a');
  a.href = URL.createObjectURL(blob);
  a.download = filename;
  document.body.appendChild(a);
  a.click();
  a.remove();
  URL.revokeObjectURL(a.href);
}

function streetColor(id) {
  return PALETTE[id % PALETTE.length];
}

function pickNextRouteColor() {
  const used = new Set(savedRoutes.map((r) => String(r.color || '').toLowerCase()));
  return ROUTE_COLORS.find((c) => !used.has(c)) || ROUTE_COLORS[savedRoutes.length % ROUTE_COLORS.length];
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

// --- Saved Mail Routes Layer & List ---
function renderSavedRoutesOnMap() {
  savedRoutesGroup.clearLayers();
  savedRouteLayerById.clear();
  if (!toggleSavedRoutes.checked) return;

  for (const r of savedRoutes) {
    if (!r.geojson) continue;
    const isActive = activeSavedRouteId === r.id;
    const col = r.color || '#ea580c';
    const layer = L.geoJSON(r.geojson, {
      style: {
        color: col,
        weight: isActive ? 4 : 2.6,
        opacity: isActive ? 1 : 0.9,
        fillColor: col,
        fillOpacity: isActive ? 0.36 : 0.18,
      },
      onEachFeature: (_f, lyr) => {
        const streetsLine = r.streetNames?.length ? `<br/>Đường: ${r.streetNames.slice(0, 6).join(', ')}${r.streetNames.length > 6 ? '...' : ''}` : '';
        const editHint = isAdmin ? '<br/><em>Bấm để chọn · Double-click để sửa đỉnh</em>' : '<br/><em>Bấm để xem</em>';
        lyr.bindTooltip(
          `<strong>📮 ${r.name}</strong><br/>Diện tích: ${r.areaKm2.toLocaleString('vi-VN', { maximumFractionDigits: 3 })} km² · ${r.points} đỉnh${streetsLine}${editHint}`,
          { sticky: true, direction: 'top', opacity: 0.96 },
        );
        lyr.on('click', () => focusSavedRoute(r.id));
        lyr.on('dblclick', (e) => {
          L.DomEvent.stop(e);
          if (isAdmin) openRouteEditorModal(r);
        });
      },
    }).addTo(savedRoutesGroup);
    savedRouteLayerById.set(r.id, layer);
  }
}

function focusSavedRoute(routeId) {
  activeSavedRouteId = activeSavedRouteId === routeId ? null : routeId;
  renderSavedRoutesList();
  renderSavedRoutesOnMap();
  if (activeSavedRouteId !== null) {
    const lyr = savedRouteLayerById.get(activeSavedRouteId);
    if (lyr?.getBounds()?.isValid()) {
      map.fitBounds(lyr.getBounds(), { padding: [48, 48], maxZoom: 16 });
    }
  }
}

function renderSavedRoutesList() {
  savedRoutesCount.textContent = String(savedRoutes.length);
  savedRoutesEmpty.hidden = savedRoutes.length > 0;
  savedRoutesListEl.innerHTML = '';

  const frag = document.createDocumentFragment();
  for (const r of savedRoutes) {
    const item = document.createElement('div');
    item.className = `saved-route-item${activeSavedRouteId === r.id ? ' active' : ''}`;
    const modTag = r.modified ? ' · Đã chỉnh tay' : '';
    const streetSummary = r.streetNames?.length ? `${r.streetNames.length} tuyến đường` : 'Vùng tùy chỉnh';
    item.innerHTML = `
      <div class="saved-route-main">
        <div class="saved-route-title">
          <span class="color-dot" style="background:${r.color || '#ea580c'}"></span>
          <span class="saved-route-name"></span>
        </div>
        <div class="saved-route-sub">${streetSummary} · ${r.areaKm2.toLocaleString('vi-VN', { maximumFractionDigits: 3 })} km²${modTag}</div>
      </div>
      <div class="saved-route-btns">
        ${isAdmin ? '<button type="button" class="btn small primary edit-route-btn" title="Chỉnh sửa đỉnh GeoJSON khu vực phát này">Sửa</button>' : ''}
        <button type="button" class="btn small copy-route-btn" title="Copy GeoJSON 1 dòng để dán Excel">Copy</button>
        ${isAdmin ? '<button type="button" class="btn small danger-ghost del-route-btn" title="Xóa khu vực phát này">Xóa</button>' : ''}
      </div>
    `;
    item.querySelector('.saved-route-name').textContent = r.name;

    item.addEventListener('click', () => focusSavedRoute(r.id));
    const editBtn = item.querySelector('.edit-route-btn');
    if (editBtn) {
      editBtn.addEventListener('click', (e) => {
        e.stopPropagation();
        openRouteEditorModal(r);
      });
    }
    const copyBtn = item.querySelector('.copy-route-btn');
    copyBtn.addEventListener('click', async (e) => {
      e.stopPropagation();
      const text = serializeGeometryOneLine(r.geojson);
      if (!text) return;
      await copyText(text);
      copyBtn.textContent = '✓';
      setStatus(`Đã copy GeoJSON 1 dòng "${r.name}" (${text.length.toLocaleString('vi-VN')} ký tự).`, 'success');
      setTimeout(() => (copyBtn.textContent = 'Copy'), 1400);
    });
    const delBtn = item.querySelector('.del-route-btn');
    if (delBtn) {
      delBtn.addEventListener('click', async (e) => {
        e.stopPropagation();
        const ok = await confirmNoti({
          title: `Xóa khu vực phát "${r.name}"`,
          message: 'Khu vực phát này sẽ bị xóa khỏi SQL Server (không xóa dữ liệu tuyến đường gốc).',
          tone: 'danger',
          confirmText: 'Đồng ý xóa',
          cancelText: 'Không',
        });
        if (!ok) return;
        try {
          const res = await fetch(`/api/mail-routes/${r.id}`, { method: 'DELETE' });
          if (!res.ok) throw new Error((await res.json()).error || 'Lỗi xóa');
          savedRoutes = savedRoutes.filter((x) => x.id !== r.id);
          if (activeSavedRouteId === r.id) activeSavedRouteId = null;
          renderSavedRoutesList();
          renderSavedRoutesOnMap();
          setStatus(`Đã xóa tuyến đường thư "${r.name}".`, 'success');
        } catch (err) {
          setStatus(`Lỗi xóa: ${err.message}`, 'error');
        }
      });
    }
    frag.appendChild(item);
  }
  savedRoutesListEl.appendChild(frag);
  updateAddToExistingBox();
}

async function fetchSavedRoutesForWard(wardUnitId) {
  const res = await fetch(`/api/mail-routes?wardUnitId=${encodeURIComponent(wardUnitId)}`);
  const data = await res.json();
  if (!res.ok) throw new Error(data.error || 'Không tải được tuyến đường thư đã lưu');
  savedRoutes = data.routes || [];
  activeSavedRouteId = null;
  renderSavedRoutesList();
  renderSavedRoutesOnMap();
  mailRouteColorInput.value = pickNextRouteColor();
}

// --- Street Selection & Merge ---
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
          opacity: hasSelection ? 0.22 : 0.42,
          fillColor: col,
          fillOpacity: hasSelection ? 0.03 : 0.12,
        });
      }
    }
    const ll = lineLayerById.get(st.id);
    if (ll) {
      ll.setStyle({
        color: isSel ? col : '#334155',
        weight: isSel ? 4 : 1.5,
        opacity: isSel ? 1 : hasSelection ? 0.22 : 0.52,
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

function updateAddToExistingBox() {
  if (!addToExistingBox || !targetExistingRouteSelect) return;
  const hasRoutes = isAdmin && savedRoutes.length > 0;
  addToExistingBox.hidden = !hasRoutes;
  if (!hasRoutes) return;

  const prevVal = Number(targetExistingRouteSelect.value) || activeSavedRouteId || savedRoutes[0]?.id;
  targetExistingRouteSelect.innerHTML = '';
  for (const r of savedRoutes) {
    const opt = document.createElement('option');
    opt.value = String(r.id);
    opt.textContent = `${r.name} (${r.streetNames?.length || 0} tuyến đường · ${r.areaKm2.toFixed(2)} km²)`;
    if (r.id === prevVal) opt.selected = true;
    targetExistingRouteSelect.appendChild(opt);
  }
  if (appendToRouteBtn) appendToRouteBtn.disabled = selectedIds.size === 0;
}

function getStreetOwnerRoutes(streetId) {
  return savedRoutes.filter((r) => (r.streetIds || []).includes(streetId));
}

async function runMergeSelectedStreets() {
  if (selectedIds.size === 0) return;
  mergeRoutesBtn.disabled = true;
  mergeRoutesBtn.textContent = 'Đang gộp...';

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
    const isContiguous = data.isContiguous !== false;
    statParts.textContent = isContiguous
      ? data.polygonParts === 1
        ? '1 Polygon liền khối ✓'
        : `Liền kề ✓ (${data.polygonParts} phần)`
      : `⚠ ${data.connectedComponents} cụm rời nhau`;
    statChars.textContent = `${data.oneLineGeojson.length.toLocaleString('vi-VN')} ký tự`;
    mailRouteColorInput.value = pickNextRouteColor();
    if (!mailRouteNameInput.value.trim()) {
      const nextNum = String(savedRoutes.length + 1).padStart(2, '0');
      const shortNames = data.streetNames.slice(0, 2).join(' - ');
      mailRouteNameInput.value = `Khu vực ${nextNum} (${shortNames}${data.streetNames.length > 2 ? '...' : ''})`;
    }
    mergedBox.hidden = false;
    unmergeBtn.hidden = false;
    updateStreetStyles();

    const b = layer.getBounds();
    if (b.isValid()) map.fitBounds(b, { padding: [50, 50], maxZoom: 16 });
    const warnParts = !isContiguous ? ` ⚠ Lưu ý: tách thành ${data.connectedComponents} cụm không liền kề.` : '';
    setStatus(
      `Đã gộp ${data.streetNames.length} tuyến đường (${data.areaKm2.toFixed(3)} km²).${warnParts}`,
      !isContiguous ? 'error' : 'success',
    );
  } catch (err) {
    setStatus(`Lỗi gộp khu vực phát: ${err.message}`, 'error');
  } finally {
    mergeRoutesBtn.disabled = selectedIds.size === 0;
    mergeRoutesBtn.textContent = 'Gộp khu vực phát';
  }
}

appendToRouteBtn.addEventListener('click', async () => {
  if (!isAdmin || selectedIds.size === 0) return;
  const routeId = Number(targetExistingRouteSelect.value);
  if (!routeId) return;

  appendToRouteBtn.disabled = true;
  appendToRouteBtn.textContent = 'Đang kiểm tra...';
  try {
    const callAppend = async (force) => {
      const res = await fetch(`/api/mail-routes/${routeId}/add-streets`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ streetIds: [...selectedIds], force }),
      });
      const data = await res.json();
      if (!res.ok) throw new Error(data.error || 'Lỗi thêm đường vào khu vực phát');
      return data;
    };

    let result = await callAppend(false);
    if (result.needsConfirm && Array.isArray(result.warnings) && result.warnings.length > 0) {
      const ok = await confirmNoti({
        title: `Cảnh báo khi thêm vào "${result.targetRouteName}"`,
        message: 'Phát hiện lưu ý sau — bạn vẫn muốn thêm vào khu vực phát này?',
        items: result.warnings,
        tone: 'warn',
        confirmText: 'Đồng ý thêm',
        cancelText: 'Không',
      });
      if (!ok) {
        setStatus('Đã hủy thêm tuyến đường.', 'warn');
        return;
      }
      appendToRouteBtn.textContent = 'Đang gộp...';
      result = await callAppend(true);
    }

    const idx = savedRoutes.findIndex((x) => x.id === result.route.id);
    if (idx >= 0) savedRoutes[idx] = result.route;
    activeSavedRouteId = result.route.id;
    selectedIds.clear();
    syncSelectionUI();
    renderSavedRoutesList();
    renderSavedRoutesOnMap();
    const lyr = savedRouteLayerById.get(result.route.id);
    if (lyr?.getBounds()?.isValid()) map.fitBounds(lyr.getBounds(), { padding: [48, 48], maxZoom: 16 });
    setStatus(
      `Đã thêm ${result.addedNames.length} tuyến đường (${result.addedNames.join(', ')}) vào khu vực phát "${result.route.name}" (${result.route.areaKm2.toFixed(3)} km²).`,
      'success',
    );
  } catch (err) {
    setStatus(`Lỗi thêm vào khu vực phát: ${err.message}`, 'error');
  } finally {
    appendToRouteBtn.disabled = selectedIds.size === 0;
    appendToRouteBtn.textContent = 'Thêm';
  }
});

saveMailRouteBtn.addEventListener('click', async () => {
  if (!latestMerged || !bundle) return;
  const name = mailRouteNameInput.value.trim();
  if (!name) {
    setStatus('Vui lòng nhập tên khu vực phát trước khi lưu.', 'error');
    mailRouteNameInput.focus();
    return;
  }

  // Check warnings before creating a new Khu vực phát: duplicate streets in other areas OR truly disconnected street groups
  const warnings = [];
  for (const sid of latestMerged.streetIds || []) {
    const st = bundle.streets.find((s) => s.id === sid);
    const owners = getStreetOwnerRoutes(sid);
    for (const ow of owners) {
      warnings.push(`Tuyến đường "${st?.name || sid}" đã thuộc khu vực phát "${ow.name}".`);
    }
  }
  if (latestMerged.isContiguous === false && (latestMerged.connectedComponents || 1) > 1) {
    const groupsText = (latestMerged.disconnectedGroups || [])
      .map((g) => `(${g.slice(0, 3).join(', ')}${g.length > 3 ? '...' : ''})`)
      .join(' ↔ ');
    warnings.push(
      `Các tuyến đường đã chọn tách thành ${latestMerged.connectedComponents} cụm không nằm liền cạnh nhau: ${groupsText}.`,
    );
  }
  if (warnings.length > 0) {
    const ok = await confirmNoti({
      title: `Cảnh báo khi tạo "${name}"`,
      message: 'Phát hiện lưu ý sau — bạn vẫn muốn lưu khu vực phát này?',
      items: warnings,
      tone: 'warn',
      confirmText: 'Đồng ý lưu',
      cancelText: 'Không',
    });
    if (!ok) return;
  }

  saveMailRouteBtn.disabled = true;
  saveMailRouteBtn.textContent = 'Đang lưu...';
  try {
    const fc = {
      type: 'FeatureCollection',
      features: [
        {
          type: 'Feature',
          properties: { name, ward: bundle.ward.name, streets: latestMerged.streetNames },
          geometry: latestMerged.geometry,
        },
      ],
    };
    const res = await fetch('/api/mail-routes', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        wardUnitId: bundle.ward.id,
        name,
        color: mailRouteColorInput.value || '#ea580c',
        streetIds: latestMerged.streetIds,
        streetNames: latestMerged.streetNames,
        lengthM: latestMerged.totalLengthM,
        geojson: fc,
      }),
    });
    const data = await res.json();
    if (!res.ok) throw new Error(data.error || 'Lỗi lưu khu vực phát');

    savedRoutes.unshift(data.route);
    activeSavedRouteId = data.route.id;
    mailRouteNameInput.value = '';
    selectedIds.clear();
    syncSelectionUI();
    renderSavedRoutesList();
    renderSavedRoutesOnMap();
    switchStreetsTab('saved');
    setStatus(`Đã lưu khu vực phát "${data.route.name}".`, 'success');
  } catch (err) {
    setStatus(`Lỗi lưu khu vực phát: ${err.message}`, 'error');
  } finally {
    saveMailRouteBtn.disabled = false;
    saveMailRouteBtn.textContent = 'Lưu';
  }
});

// --- Visual Polygon Vertex Editor Modal (same as /admin Wards Editor) ---
function ensureEditorMap() {
  if (editorMap) return;
  editorMap = L.map('routeEditorMap', { zoomControl: true }).setView([11.935, 108.442], 14);
  const gVi = L.tileLayer('https://mt{s}.google.com/vt/lyrs=m&hl=vi&x={x}&y={y}&z={z}', {
    subdomains: ['0', '1', '2', '3'], maxZoom: 20, attribution: '&copy; Google Maps',
  });
  const sat = L.tileLayer(
    'https://server.arcgisonline.com/ArcGIS/rest/services/World_Imagery/MapServer/tile/{z}/{y}/{x}',
    { maxZoom: 19, attribution: 'Tiles &copy; Esri' },
  );
  gVi.addTo(editorMap);
  L.control.layers({ 'Bản đồ tiếng Việt': gVi, 'Ảnh vệ tinh': sat }, {}, { position: 'topright' }).addTo(editorMap);

  editorWardBorderGroup = L.layerGroup().addTo(editorMap);
  editorRoadsGroup = L.layerGroup().addTo(editorMap);

  polygonEditor = createPolygonEditor(editorMap, {
    onChange: () => {},
    onStatus: (msg, type) => setEditorToast(msg, type),
    onHistoryChange: ({
      canUndo,
      canRedo,
      editEnabled,
      topoEnabled,
      showNeighbors,
      drawing,
      vertexCount,
      neighborCount,
      dirtyNeighborCount,
    }) => {
      editorUndoBtn.disabled = !canUndo;
      editorRedoBtn.disabled = !canRedo;
      editorToggleEditBtn.classList.toggle('primary', editEnabled && !drawing);
      editorToggleEditBtn.textContent = editEnabled ? 'Đang sửa đỉnh' : 'Sửa đỉnh';
      editorToggleTopoBtn.classList.toggle('active-topo', topoEnabled);
      editorToggleTopoBtn.textContent = dirtyNeighborCount > 0 ? `Biên chung (${dirtyNeighborCount})` : 'Biên chung';
      editorToggleNeighborsBtn.classList.toggle('active-ref', showNeighbors);
      editorToggleNeighborsBtn.textContent = neighborCount > 0 ? `KV phát khác (${neighborCount})` : 'KV phát khác';
      editorDrawPolyBtn.classList.toggle('primary', drawing);
      editorDrawPolyBtn.textContent = drawing ? 'Kết thúc vẽ (Enter)' : '+ Vẽ vùng';
      editorVertexBadge.textContent = `${vertexCount.toLocaleString('vi-VN')} đỉnh`;
      editorHint.innerHTML = drawing
        ? '<strong>Đang vẽ vùng mới:</strong> Bấm chuột trái để đặt từng đỉnh · Bấm vào <strong>chấm xanh đầu tiên</strong>, double-click hoặc <code>Enter</code> để khép · <code>Esc</code> để hủy'
        : topoEnabled && neighborCount > 0
          ? '<strong>🔗 Biên chung đang BẬT:</strong> <strong>Chuột trái cạnh</strong>: thêm nút · <strong>Kéo nút</strong>: dời đồng bộ · <strong>Alt + chuột trái quét</strong>: xóa hàng loạt nút'
          : '<strong>Chuột trái lên cạnh</strong>: thêm nút · <strong>Kéo nút</strong>: dời · <strong>Giữ Alt + chuột trái quét</strong>: xóa hàng loạt nút · <code>Ctrl+Z</code>: hoàn tác';
    },
  });
}

function openRouteEditorModal(route) {
  if (!isAdmin) {
    setStatus('Chỉ tài khoản Admin mới được chỉnh sửa tuyến đường thư.', 'error');
    return;
  }
  editingRoute = route;
  editingSavedGeojson = JSON.parse(JSON.stringify(route.geojson));
  editingSavedNeighbors = savedRoutes
    .filter((r) => r.id !== route.id && r.geojson)
    .map((r) => ({ id: r.id, name: r.name, color: r.color || '#64748b', geojson: r.geojson }));

  editorRouteNameInput.value = route.name || '';
  editorRouteColorInput.value = route.color || '#ea580c';
  routeEditorSubtitle.textContent = `${bundle?.ward?.name || route.wardName || ''} · ${route.areaKm2.toLocaleString('vi-VN', { maximumFractionDigits: 3 })} km² · ${route.points} điểm`;
  setEditorToast('');

  routeEditorModal.hidden = false;
  ensureEditorMap();

  editorWardBorderGroup.clearLayers();
  if (bundle?.ward?.geojson) {
    L.geoJSON(bundle.ward.geojson, {
      interactive: false,
      style: { color: '#0f172a', weight: 2.5, dashArray: '6,4', fillOpacity: 0 },
    }).addTo(editorWardBorderGroup);
  }

  editorRoadsGroup.clearLayers();
  for (const st of bundle?.streets || []) {
    L.geoJSON(st.lineGeojson, {
      interactive: false,
      style: { color: '#475569', weight: 1.5, opacity: 0.45 },
    }).addTo(editorRoadsGroup);
  }
  if (showEditorRoads) editorRoadsGroup.addTo(editorMap);
  else editorMap.removeLayer(editorRoadsGroup);

  polygonEditor.setEditEnabled(true);
  polygonEditor.load(editingSavedGeojson, {
    color: route.color || '#ea580c',
    neighbors: editingSavedNeighbors,
    fitBounds: true,
    resetHistory: true,
  });

  setTimeout(() => editorMap.invalidateSize(), 60);
}

function closeRouteEditorModal() {
  if (polygonEditor?.isDrawing()) polygonEditor.cancelDrawing();
  routeEditorModal.hidden = true;
  editingRoute = null;
}

editorCloseBtn.addEventListener('click', closeRouteEditorModal);
routeEditorModal.addEventListener('click', (e) => {
  if (e.target === routeEditorModal) closeRouteEditorModal();
});
editorToggleEditBtn.addEventListener('click', () => {
  if (!polygonEditor) return;
  if (polygonEditor.isDrawing()) polygonEditor.cancelDrawing();
  polygonEditor.setEditEnabled(!polygonEditor.isEditEnabled());
});
editorToggleTopoBtn.addEventListener('click', () => {
  if (!polygonEditor) return;
  polygonEditor.setTopoEnabled(!polygonEditor.isTopoEnabled());
});
editorToggleNeighborsBtn.addEventListener('click', () => {
  if (!polygonEditor) return;
  polygonEditor.setShowNeighbors(!polygonEditor.isShowNeighbors());
});
editorToggleRoadsBtn.addEventListener('click', () => {
  showEditorRoads = !showEditorRoads;
  editorToggleRoadsBtn.classList.toggle('active-ref', showEditorRoads);
  if (!editorMap || !editorRoadsGroup) return;
  if (showEditorRoads) editorRoadsGroup.addTo(editorMap);
  else editorMap.removeLayer(editorRoadsGroup);
});
editorDrawPolyBtn.addEventListener('click', () => {
  if (!polygonEditor) return;
  if (polygonEditor.isDrawing()) polygonEditor.finishDrawing();
  else polygonEditor.startDrawing();
});
editorUndoBtn.addEventListener('click', () => polygonEditor?.undo());
editorRedoBtn.addEventListener('click', () => polygonEditor?.redo());

editorRevertBtn.addEventListener('click', async () => {
  if (!editingSavedGeojson || !polygonEditor) return;
  const ok = await confirmNoti({
    title: 'Khôi phục ranh giới theo DB',
    message: 'Mọi thay đổi đỉnh chưa lưu của khu vực phát này sẽ bị hủy bỏ.',
    tone: 'danger',
    confirmText: 'Đồng ý Reset',
    cancelText: 'Không',
  });
  if (!ok) return;
  polygonEditor.load(editingSavedGeojson, {
    color: editorRouteColorInput.value || editingRoute?.color || '#ea580c',
    neighbors: editingSavedNeighbors,
    fitBounds: true,
    resetHistory: true,
  });
  setEditorToast('Đã khôi phục theo bản đang lưu trong SQL Server.', 'success');
});

editorSaveBtn.addEventListener('click', async () => {
  if (!editingRoute || !polygonEditor) return;
  if (polygonEditor.isDrawing()) polygonEditor.cancelDrawing();
  const nextGeo = polygonEditor.getGeojson();
  if (!nextGeo?.features?.length) {
    setEditorToast('Chưa có đa giác nào để lưu.', 'error');
    return;
  }
  const nextName = editorRouteNameInput.value.trim();
  if (!nextName) {
    setEditorToast('Tên tuyến đường thư không được để trống.', 'error');
    editorRouteNameInput.focus();
    return;
  }
  const neighborUpdates = polygonEditor.getModifiedNeighbors();
  editorSaveBtn.disabled = true;
  editorSaveBtn.textContent = 'Đang lưu...';
  try {
    const res = await fetch(`/api/mail-routes/${editingRoute.id}`, {
      method: 'PUT',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        name: nextName,
        color: editorRouteColorInput.value || editingRoute.color,
        geojson: nextGeo,
        modified: true,
        neighborUpdates,
      }),
    });
    const data = await res.json();
    if (!res.ok) throw new Error(data.error || 'Lỗi lưu tuyến đường thư');

    // Update local savedRoutes list for main route & any synced neighbors
    for (const updated of [data.route, ...(data.updatedNeighbors || [])]) {
      const idx = savedRoutes.findIndex((x) => x.id === updated.id);
      if (idx >= 0) savedRoutes[idx] = updated;
    }
    editingRoute = data.route;
    editingSavedGeojson = JSON.parse(JSON.stringify(data.route.geojson));
    editingSavedNeighbors = savedRoutes
      .filter((r) => r.id !== data.route.id && r.geojson)
      .map((r) => ({ id: r.id, name: r.name, color: r.color || '#64748b', geojson: r.geojson }));

    polygonEditor.load(editingSavedGeojson, {
      color: data.route.color,
      neighbors: editingSavedNeighbors,
      fitBounds: false,
      resetHistory: true,
    });
    routeEditorSubtitle.textContent = `${bundle?.ward?.name || ''} · ${data.route.areaKm2.toLocaleString('vi-VN', { maximumFractionDigits: 3 })} km² · ${data.route.points} điểm`;

    renderSavedRoutesList();
    renderSavedRoutesOnMap();
    const syncNote = data.updatedNeighbors?.length ? ` + ${data.updatedNeighbors.length} tuyến giáp ranh` : '';
    setEditorToast(`✓ Đã lưu "${data.route.name}"${syncNote} vào SQL Server (${data.route.areaKm2.toFixed(3)} km²).`, 'success');
    setStatus(`Đã cập nhật tuyến đường thư "${data.route.name}"${syncNote}.`, 'success');
  } catch (err) {
    setEditorToast(`Lỗi lưu DB: ${err.message}`, 'error');
  } finally {
    editorSaveBtn.disabled = false;
    editorSaveBtn.textContent = '💾 Lưu vào DB';
  }
});

editorCopyBtn.addEventListener('click', async () => {
  const geo = polygonEditor?.getGeojson() || editingSavedGeojson;
  const text = serializeGeometryOneLine(geo);
  if (!text) return;
  await copyText(text);
  const old = editorCopyBtn.textContent;
  editorCopyBtn.textContent = 'Đã copy ✓';
  setTimeout(() => (editorCopyBtn.textContent = old), 1400);
});

editorDownloadBtn.addEventListener('click', () => {
  const geo = polygonEditor?.getGeojson() || editingSavedGeojson;
  if (!geo || !editingRoute) return;
  downloadGeojson(geo, `tuyen_duong_thu_${editingRoute.id}.geojson`);
});

window.addEventListener('keydown', (e) => {
  if (routeEditorModal.hidden) return;
  if (e.key === 'Escape') {
    if (polygonEditor?.isDrawing()) polygonEditor.cancelDrawing();
    else closeRouteEditorModal();
    return;
  }
  if (e.key === 'Enter' && polygonEditor?.isDrawing()) {
    e.preventDefault();
    polygonEditor.finishDrawing();
    return;
  }
  if (e.ctrlKey || e.metaKey) {
    const k = e.key.toLowerCase();
    if (k === 'z' && !e.shiftKey) {
      if (polygonEditor?.undo()) e.preventDefault();
    } else if (k === 'y' || (k === 'z' && e.shiftKey)) {
      if (polygonEditor?.redo()) e.preventDefault();
    }
  }
});

// --- Street List & Selection UI ---
function switchStreetsTab(tab) {
  const isList = tab === 'list';
  streetsTabListBtn?.classList.toggle('active', isList);
  streetsTabListBtn?.setAttribute('aria-selected', String(isList));
  streetsTabSavedBtn?.classList.toggle('active', !isList);
  streetsTabSavedBtn?.setAttribute('aria-selected', String(!isList));
  if (streetsPanelList) streetsPanelList.hidden = !isList;
  if (streetsPanelSaved) streetsPanelSaved.hidden = isList;
}

streetsTabListBtn?.addEventListener('click', () => switchStreetsTab('list'));
streetsTabSavedBtn?.addEventListener('click', () => switchStreetsTab('saved'));

function syncSelectionUI({ shouldFit = false } = {}) {
  clearMergedResult();
  selectedCount.textContent = String(selectedIds.size);
  if (selectionTray) selectionTray.hidden = selectedIds.size === 0;
  if (selectedHint) selectedHint.hidden = selectedIds.size > 0;
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
  updateAddToExistingBox();

  if (selectedIds.size > 0 && shouldFit) {
    fitSelectedStreets();
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
    const owners = getStreetOwnerRoutes(st.id);
    const ownerTag = owners.length
      ? `<span class="street-owner-badge" title="Đã thuộc khu vực phát: ${owners.map((o) => o.name).join(', ')}">📮 ${owners[0].name.replace(/</g, '&lt;')}</span>`
      : '';
    const row = document.createElement('div');
    row.className = `street-row${isSel ? ' selected' : ''}`;
    row.innerHTML = `
      <div class="street-row-left">
        <input type="checkbox" ${isSel ? 'checked' : ''} />
        <span class="color-dot" style="background:${streetColor(st.id)}"></span>
        <span class="street-row-name"></span>
        ${ownerTag}
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
    opt.textContent = `${w.wardName} (${w.streetCount} tuyến đường)${w.oldDistrict ? ` — ${w.oldDistrict}` : ''}`;
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
  savedRoutesGroup.clearLayers();
  labelsGroup.clearLayers();
  zoneLayerById.clear();
  lineLayerById.clear();
  streetSearch.value = '';
  mailRouteNameInput.value = '';

  try {
    const [streetsRes] = await Promise.all([
      fetch(`/api/streets?wardUnitId=${encodeURIComponent(wardUnitId)}`),
      fetchSavedRoutesForWard(wardUnitId),
    ]);
    const data = await streetsRes.json();
    if (seq !== loadSeq) return;
    if (!streetsRes.ok) throw new Error(data.error || 'Không tải được tuyến đường');

    bundle = data;
    wardStatsPill.textContent = `${bundle.ward.name} · ${bundle.streetCount} đường · ${bundle.ward.areaKm2} km²`;
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
        style: { color: '#94a3b8', weight: 0.7, opacity: 0.42, fillColor: streetColor(st.id), fillOpacity: 0.12 },
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
        style: { color: '#334155', weight: 1.5, opacity: 0.52 },
        onEachFeature: (_f, lyr) => {
          lyr.on('click', () => toggleStreet(st.id));
        },
      }).addTo(linesGroup);
      lineLayerById.set(st.id, ll);
    }

    syncSelectionUI();
    renderSavedRoutesOnMap();
    if (wardBounds?.isValid()) map.fitBounds(wardBounds, { padding: [24, 24] });
  } catch (err) {
    setStatus(`Lỗi tải tuyến đường: ${err.message}`, 'error');
  }
}

toggleLabelsBtn.addEventListener('click', () => {
  showStreetLabels = !showStreetLabels;
  toggleLabelsBtn.classList.toggle('active', showStreetLabels);
  renderStreetLabels();
});

map.on('zoomend', () => {
  if (showStreetLabels && selectedIds.size === 0) renderStreetLabels();
});

toggleSavedRoutes.addEventListener('change', renderSavedRoutesOnMap);
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
  setStatus('');
  if (wardBounds?.isValid()) map.fitBounds(wardBounds, { padding: [24, 24] });
});

copyMergedBtn.addEventListener('click', async () => {
  if (!latestMerged?.oneLineGeojson) return;
  await copyText(latestMerged.oneLineGeojson);
  const old = copyMergedBtn.textContent;
  copyMergedBtn.textContent = 'Đã copy ✓';
  setTimeout(() => (copyMergedBtn.textContent = old), 1400);
});

downloadMergedBtn.addEventListener('click', () => {
  if (!latestMerged || !bundle) return;
  downloadGeojson(
    {
      type: 'FeatureCollection',
      features: [
        {
          type: 'Feature',
          properties: {
            name: mailRouteNameInput.value.trim() || 'Tuyến đường thư',
            ward: bundle.ward.name,
            streets: latestMerged.streetNames,
            area_km2: latestMerged.areaKm2,
            length_m: latestMerged.totalLengthM,
          },
          geometry: latestMerged.geometry,
        },
      ],
    },
    `tuyen_duong_thu_${bundle.ward.id}.geojson`,
  );
});

function applyAdminPermissionsUI() {
  if (adminBadge) {
    adminBadge.textContent = adminUsername ? `👤 ${adminUsername}` : '';
    adminBadge.hidden = !isAdmin;
  }
  if (adminLoginLink) adminLoginLink.hidden = isAdmin;
  if (saveRouteRow) saveRouteRow.hidden = !isAdmin;
  if (adminOnlySaveHint) adminOnlySaveHint.hidden = isAdmin;
  if (savedRoutesEmpty && !isAdmin) {
    savedRoutesEmpty.textContent = 'Chưa có khu vực phát nào trong xã/phường này.';
  }
  updateAddToExistingBox();
}

async function init() {
  const [authRes, res] = await Promise.all([
    fetch('/api/auth/me').catch(() => null),
    fetch('/api/streets/wards'),
  ]);
  if (authRes?.ok) {
    const auth = await authRes.json().catch(() => ({}));
    isAdmin = Boolean(auth.authenticated);
    adminUsername = auth.username || null;
  }
  applyAdminPermissionsUI();

  const data = await res.json();
  if (!res.ok) throw new Error(data.error || 'Không tải được danh sách xã/phường');
  allWardSummaries = data.wards || [];
  totalWardsCount.textContent = String(allWardSummaries.length);
  const totalStreets = allWardSummaries.reduce((acc, w) => acc + w.streetCount, 0);
  totalStreetsPill.textContent = `${totalStreets.toLocaleString('vi-VN')} tuyến đường`;

  const defaultWard =
    allWardSummaries.find((w) => w.wardName.toLowerCase().includes('xuân hương')) ||
    allWardSummaries.find((w) => w.streetCount > 0) ||
    allWardSummaries[0];

  renderWardSelect(defaultWard?.wardUnitId || null);
  if (defaultWard) await loadWard(defaultWard.wardUnitId);
}

init().catch((err) => setStatus(`Lỗi khởi tạo: ${err.message}`, 'error'));
