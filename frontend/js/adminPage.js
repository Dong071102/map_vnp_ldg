import {
  fetchHealth,
  fetchAuthMe,
  loginAdmin,
  logoutAdmin,
  extractWikiRegion,
  saveRegionToDb,
  saveLamDongUnitGeojson,
  saveRegionGeojson,
  fetchOldDistricts,
  fetchNeighborRegions,
  fetchNeighborProvinces,
  fetchAdminBcvhOffices,
  createBcvhOffice,
  updateBcvhOffice,
  deleteBcvhOffice,
  locateWardByCoords,
} from './api.js';
import { computeGeoStats, serializeGeometryOneLine } from './geometry.js';
import { initAdminTab } from './admin.js';
import { createPolygonEditor } from './polygonEditor.js';
import { addVietnamIslandsOverlay } from './vnIslandsOverlay.js';

const $ = (id) => document.getElementById(id);

const statusBanner = $('statusBanner');
const dbStatusPill = $('dbStatusPill');
const adminUserBadge = $('adminUserBadge');
const logoutBtn = $('logoutBtn');

const loginScreen = $('loginScreen');
const loginForm = $('loginForm');
const loginUsername = $('loginUsername');
const loginPassword = $('loginPassword');
const togglePasswordBtn = $('togglePasswordBtn');
const loginError = $('loginError');
const loginSubmitBtn = $('loginSubmitBtn');

const adminView = $('adminView');
const openAddRegionModalBtn = $('openAddRegionModalBtn');
const addRegionModal = $('addRegionModal');
const addRegionModalCloseBtn = $('addRegionModalCloseBtn');
const extractForm = $('extractForm');
const wikiUrlInput = $('wikiUrlInput');
const clearBtn = $('clearBtn');
const sourceSelect = $('sourceSelect');
const fetchBtn = $('fetchBtn');
const btnLabel = fetchBtn.querySelector('.btn-label');
const spinner = fetchBtn.querySelector('.spinner');
const toggleBatchBtn = $('toggleBatchBtn');
const batchDrawer = $('batchDrawer');
const batchInput = $('batchInput');
const batchLoadBtn = $('batchLoadBtn');
const batchCloseBtn = $('batchCloseBtn');
const batchProgress = $('batchProgress');

// Map Preview Modal refs
const unitMapModal = $('unitMapModal');
const unitMapTitle = $('unitMapTitle');
const unitMapSubtitle = $('unitMapSubtitle');
const unitMapCloseBtn = $('unitMapCloseBtn');
const modalCopyGeojsonBtn = $('modalCopyGeojsonBtn');
const modalDownloadBtn = $('modalDownloadBtn');
const modalOpenFullMapLink = $('modalOpenFullMapLink');
const modalEditorStatus = $('modalEditorStatus');
const modalRevertBtn = $('modalRevertBtn');
const modalSaveGeojsonBtn = $('modalSaveGeojsonBtn');
const modalToggleEditBtn = $('modalToggleEditBtn');
const modalToggleTopoBtn = $('modalToggleTopoBtn');
const modalDrawPolyBtn = $('modalDrawPolyBtn');
const modalUndoBtn = $('modalUndoBtn');
const modalRedoBtn = $('modalRedoBtn');
const modalToggleNeighborsBtn = $('modalToggleNeighborsBtn');
const modalToggleOldDistrictsBtn = $('modalToggleOldDistrictsBtn');
const modalToggleProvincesBtn = $('modalToggleProvincesBtn');
const modalVertexBadge = $('modalVertexBadge');
const mapEditHint = $('mapEditHint');

let previewMap = null;
let polygonEditor = null;
let neighborDistrictsGroup = null;
let neighborProvincesGroup = null;
let neighborProvincesLoaded = false;
let showNeighborWards = true;
let showNeighborDistricts = false;
let showNeighborProvinces = true;
let previewLoadSeq = 0;
let currentPreviewMode = 'ward'; // 'ward' | 'district'
let currentPreviewUnit = null;
let currentPreviewGeojson = null;
let savedDbGeojson = null;
let savedNeighborWards = [];

// Sub-tabs & 30 Old Districts + BCVH Management refs
const adminTabWardsBtn = $('adminTabWardsBtn');
const adminTabDistrictsBtn = $('adminTabDistrictsBtn');
const adminTabBcvhBtn = $('adminTabBcvhBtn');
const wardsAdminPanel = $('wardsAdminPanel');
const oldDistrictsAdminPanel = $('oldDistrictsAdminPanel');
const bcvhAdminPanel = $('bcvhAdminPanel');
const oldDistrictSearchInput = $('oldDistrictSearchInput');
const oldDistrictProvinceFilter = $('oldDistrictProvinceFilter');
const oldDistrictStatTotal = $('oldDistrictStatTotal');
const oldDistrictStatModified = $('oldDistrictStatModified');
const oldDistrictTableBody = $('oldDistrictTableBody');

const bcvhStatTotal = $('bcvhStatTotal');
const bcvhSearchInput = $('bcvhSearchInput');
const openNewBcvhBtn = $('openNewBcvhBtn');
const bcvhTableBody = $('bcvhTableBody');
const bcvhModal = $('bcvhModal');
const bcvhModalTitle = $('bcvhModalTitle');
const bcvhModalCloseBtn = $('bcvhModalCloseBtn');
const bcvhForm = $('bcvhForm');
const bcvhNameInput = $('bcvhNameInput');
const bcvhCodeInput = $('bcvhCodeInput');
const bcvhColorInput = $('bcvhColorInput');
const bcvhHostWardSelect = $('bcvhHostWardSelect');
const bcvhLatInput = $('bcvhLatInput');
const bcvhLngInput = $('bcvhLngInput');
const bcvhAddressInput = $('bcvhAddressInput');
const bcvhSelectedCountBadge = $('bcvhSelectedCountBadge');
const bcvhWardSearchInput = $('bcvhWardSearchInput');
const bcvhWardDistrictFilter = $('bcvhWardDistrictFilter');
const bcvhSelectFilteredBtn = $('bcvhSelectFilteredBtn');
const bcvhClearWardsBtn = $('bcvhClearWardsBtn');
const bcvhWardChecklist = $('bcvhWardChecklist');
const bcvhFormError = $('bcvhFormError');
const bcvhCancelBtn = $('bcvhCancelBtn');
const bcvhSaveBtn = $('bcvhSaveBtn');

let oldDistrictsList = [];
let oldDistrictsLoaded = false;
let bcvhList = [];
let bcvhLoaded = false;
let editingBcvhId = null;
let modalSelectedWardIds = new Set();

function setModalEditorStatus(message, type = 'success') {
  if (!message) {
    modalEditorStatus.hidden = true;
    return;
  }
  modalEditorStatus.textContent = message;
  modalEditorStatus.className = `modal-editor-status map-editor-toast ${type}`;
  modalEditorStatus.hidden = false;
}

function updateEditorToolbarUI({
  canUndo,
  canRedo,
  editEnabled,
  topoEnabled,
  showNeighbors,
  drawing,
  vertexCount,
  neighborCount,
  dirtyNeighborCount,
}) {
  modalUndoBtn.disabled = !canUndo;
  modalRedoBtn.disabled = !canRedo;
  modalVertexBadge.textContent = `${vertexCount.toLocaleString('vi-VN')} đỉnh`;
  modalToggleEditBtn.textContent = editEnabled ? '✏ Sửa đỉnh' : '✏ Sửa: Tắt';
  modalToggleEditBtn.classList.toggle('primary', editEnabled);
  modalToggleTopoBtn.textContent = topoEnabled ? '🔗 Biên chung' : '🔗 Biên: Tắt';
  modalToggleTopoBtn.classList.toggle('active-topo', topoEnabled);
  modalDrawPolyBtn.textContent = drawing ? '✕ Hủy vẽ' : '+ Vẽ vùng';
  modalDrawPolyBtn.classList.toggle('danger-ghost', drawing);
  modalToggleNeighborsBtn.classList.toggle('active-ref', showNeighbors);
  const peerLabel = currentPreviewMode === 'district' ? 'Huyện lân cận' : 'Xã lân cận';
  modalToggleNeighborsBtn.textContent =
    dirtyNeighborCount > 0 ? `${peerLabel} (${neighborCount} · ${dirtyNeighborCount} sửa)` : `${peerLabel} (${neighborCount})`;
  mapEditHint.hidden = !editEnabled && !drawing;
}

function syncFromMapEditor(updatedGeojson, { reason, dirtyNeighborNames = [] } = {}) {
  currentPreviewGeojson = updatedGeojson;
  const stats = computeGeoStats(updatedGeojson, null);
  if (reason === 'move-vertex' || reason === 'insert-vertex' || reason === 'delete-vertex' || reason === 'draw-polygon') {
    const neighborNote = dirtyNeighborNames.length
      ? ` · đồng bộ cùng ${dirtyNeighborNames.length} xã giáp ranh (${dirtyNeighborNames.join(', ')})`
      : '';
    setModalEditorStatus(
      `Đã chỉnh trên bản đồ · DT tạm tính: ~${stats.areaKm2.toLocaleString('vi-VN', { maximumFractionDigits: 2 })} km² · ${stats.points.toLocaleString('vi-VN')} đỉnh${neighborNote} (chưa lưu DB).`,
      'warn',
    );
  }
}

function ensurePreviewMap() {
  if (previewMap) return previewMap;
  previewMap = L.map('unitPreviewMap', { zoomControl: true }).setView([11.55, 107.65], 10);
  const googleVi = L.tileLayer('https://mt{s}.google.com/vt/lyrs=m&hl=vi&x={x}&y={y}&z={z}', {
    subdomains: ['0', '1', '2', '3'],
    maxZoom: 20,
    attribution: '&copy; Google Maps',
  });
  const sat = L.tileLayer(
    'https://server.arcgisonline.com/ArcGIS/rest/services/World_Imagery/MapServer/tile/{z}/{y}/{x}',
    { maxZoom: 19, attribution: 'Tiles &copy; Esri' },
  );
  const googleHybrid = L.tileLayer('https://mt{s}.google.com/vt/lyrs=y&hl=vi&x={x}&y={y}&z={z}', {
    subdomains: ['0', '1', '2', '3'],
    maxZoom: 20,
    attribution: '&copy; Google Maps',
  });
  const esriStreet = L.tileLayer(
    'https://server.arcgisonline.com/ArcGIS/rest/services/World_Street_Map/MapServer/tile/{z}/{y}/{x}',
    { maxZoom: 19, attribution: 'Tiles &copy; Esri' },
  );
  googleVi.addTo(previewMap);
  addVietnamIslandsOverlay(previewMap);
  L.control
    .layers(
      {
        'Bản đồ tiếng Việt': googleVi,
        'Ảnh vệ tinh (Esri)': sat,
        'Vệ tinh + Tên đường': googleHybrid,
        'Bản đồ đường phố (Esri)': esriStreet,
      },
      {},
      { position: 'topright' },
    )
    .addTo(previewMap);

  const provPane = previewMap.createPane('neighborProvincePane');
  provPane.style.zIndex = '320';
  neighborProvincesGroup = L.layerGroup();
  if (showNeighborProvinces) neighborProvincesGroup.addTo(previewMap);

  const refPane = previewMap.createPane('neighborRefPane');
  refPane.style.zIndex = '350';
  neighborDistrictsGroup = L.layerGroup();
  if (showNeighborDistricts) neighborDistrictsGroup.addTo(previewMap);

  polygonEditor = createPolygonEditor(previewMap, {
    onChange: syncFromMapEditor,
    onStatus: (msg, type) => setModalEditorStatus(msg, type),
    onHistoryChange: updateEditorToolbarUI,
  });
  return previewMap;
}

function getMainPolygonCenter(feature) {
  const g = feature?.geometry;
  if (!g) return null;
  let bestRing = null;
  let bestLen = -1;
  if (g.type === 'Polygon' && g.coordinates?.[0]) {
    bestRing = g.coordinates[0];
  } else if (g.type === 'MultiPolygon') {
    for (const poly of g.coordinates || []) {
      const ring = poly?.[0];
      if (ring && ring.length > bestLen) {
        bestLen = ring.length;
        bestRing = ring;
      }
    }
  }
  if (!bestRing || bestRing.length === 0) return null;
  let minLat = Infinity;
  let maxLat = -Infinity;
  let minLng = Infinity;
  let maxLng = -Infinity;
  for (const [lng, lat] of bestRing) {
    if (lat < minLat) minLat = lat;
    if (lat > maxLat) maxLat = lat;
    if (lng < minLng) minLng = lng;
    if (lng > maxLng) maxLng = lng;
  }
  return Number.isFinite(minLat) ? [(minLat + maxLat) / 2, (minLng + maxLng) / 2] : null;
}

async function ensureNeighborProvincesLoaded() {
  if (neighborProvincesLoaded || !neighborProvincesGroup) return;
  neighborProvincesLoaded = true;
  try {
    const fc = await fetchNeighborProvinces();
    const features = fc?.features || [];
    neighborProvincesGroup.clearLayers();

    for (const f of features) {
      L.geoJSON(f, {
        pane: 'neighborProvincePane',
        interactive: false,
        style: () => ({
          color: '#1e293b',
          weight: 2.2,
          opacity: 0.85,
          fillColor: '#0f172a',
          fillOpacity: 0.36,
        }),
      }).addTo(neighborProvincesGroup);

      const props = f.properties || {};
      const labelText = props.ten_tinh
        ? props.loai === 'Thành phố' || String(props.ten_tinh).startsWith('TP.')
          ? props.ten_tinh
          : `Tỉnh ${props.ten_tinh}`
        : '';
      const center = getMainPolygonCenter(f);
      if (labelText && center) {
        L.tooltip({
          permanent: true,
          direction: 'center',
          interactive: false,
          className: 'neighbor-label province-label',
        })
          .setLatLng(center)
          .setContent(labelText)
          .addTo(neighborProvincesGroup);
      }
    }

    modalToggleProvincesBtn.textContent = `Tỉnh lân cận (${features.length})`;
  } catch {
    neighborProvincesLoaded = false;
  }
}

function renderSecondaryRefLayers(items = [], { labelPrefix = 'Huyện cũ', isWardRef = false } = {}) {
  if (!neighborDistrictsGroup) return;
  neighborDistrictsGroup.clearLayers();
  let count = 0;

  for (const n of items) {
    if (!n?.geojson) continue;
    const layer = L.geoJSON(n.geojson, {
      pane: 'neighborRefPane',
      interactive: false,
      style: () =>
        isWardRef
          ? {
              color: '#2563eb',
              weight: 1.4,
              opacity: 0.72,
              dashArray: '4 4',
              fillColor: n.color || '#60a5fa',
              fillOpacity: 0.1,
            }
          : {
              color: '#c2410c',
              weight: 2,
              opacity: 0.78,
              dashArray: '8 5',
              fillColor: '#fdba74',
              fillOpacity: 0.07,
            },
    });

    if (n.name) {
      const bounds = layer.getBounds();
      if (bounds.isValid()) {
        L.tooltip({
          permanent: true,
          direction: 'center',
          interactive: false,
          className: isWardRef ? 'neighbor-label' : 'neighbor-label district-label',
        })
          .setLatLng(bounds.getCenter())
          .setContent(n.name)
          .addTo(neighborDistrictsGroup);
      }
    }

    layer.addTo(neighborDistrictsGroup);
    count++;
  }

  modalToggleOldDistrictsBtn.textContent = `${labelPrefix} (${count})`;
}

function drawPreviewGeojson(geojson, color = '#2563eb', { neighbors = null, fitBounds = true, resetHistory = false } = {}) {
  ensurePreviewMap();
  polygonEditor.load(geojson, { color, neighbors, fitBounds, resetHistory });
}

async function openUnitMapPreview(unit) {
  if (!unit) return;
  const loadSeq = ++previewLoadSeq;
  currentPreviewMode = 'ward';
  currentPreviewUnit = unit;
  currentPreviewGeojson = null;
  savedDbGeojson = null;
  savedNeighborWards = [];
  setModalEditorStatus('');

  unitMapTitle.textContent = `#${unit.stt} · ${unit.name}`;
  const parts = [];
  if (unit.oldDistrict) parts.push(`Thuộc huyện cũ: ${unit.oldDistrict}${unit.oldProvince ? ` (${unit.oldProvince})` : ''}`);
  if (unit.areaOfficialKm2) parts.push(`DT chính thức: ${unit.areaOfficialKm2.toLocaleString('vi-VN', { maximumFractionDigits: 2 })} km²`);
  if (unit.population2025) parts.push(`Dân số: ${unit.population2025.toLocaleString('vi-VN')}`);
  unitMapSubtitle.textContent = parts.join(' · ') || 'Đang tải bản đồ...';

  modalOpenFullMapLink.href = unit.regionId ? `/?region=${encodeURIComponent(unit.regionId)}` : '/';
  unitMapModal.hidden = false;

  const map = ensurePreviewMap();
  ensureNeighborProvincesLoaded();
  polygonEditor.clear();
  polygonEditor.setEditEnabled(true);
  polygonEditor.setShowNeighbors(showNeighborWards);
  renderSecondaryRefLayers([], { labelPrefix: 'Huyện cũ', isWardRef: false });

  if (!unit.regionId) {
    const emptyTemplate = { type: 'FeatureCollection', features: [] };
    savedDbGeojson = emptyTemplate;
    currentPreviewGeojson = emptyTemplate;
    polygonEditor.load(emptyTemplate, { color: '#2563eb', neighbors: [], fitBounds: false, resetHistory: true });
    setModalEditorStatus('Đơn vị này chưa có vùng bản đồ — bấm "+ Vẽ vùng mới" để vẽ trực tiếp rồi bấm Lưu vào DB.', 'warn');
    setTimeout(() => map.invalidateSize(), 60);
    return;
  }

  try {
    const [geoResp, neighborsRes] = await Promise.all([
      fetch(`/api/regions/${encodeURIComponent(unit.regionId)}/geojson`, { credentials: 'same-origin' }),
      fetchNeighborRegions(unit.regionId).catch(() => ({ neighbors: [] })),
    ]);
    if (loadSeq !== previewLoadSeq) return;
    if (!geoResp.ok) throw new Error(`HTTP ${geoResp.status}`);
    const geojson = await geoResp.json();
    if (loadSeq !== previewLoadSeq) return;

    const allNeighbors = neighborsRes.neighbors || [];
    const wardNeighbors = allNeighbors.filter((n) => n.layerGroup !== 'district_old');
    const oldDistrictNeighbors = allNeighbors.filter((n) => n.layerGroup === 'district_old');

    savedDbGeojson = geojson;
    savedNeighborWards = wardNeighbors;
    currentPreviewGeojson = geojson;
    renderSecondaryRefLayers(oldDistrictNeighbors, { labelPrefix: 'Huyện cũ', isWardRef: false });
    drawPreviewGeojson(geojson, unit.region?.color || '#2563eb', {
      neighbors: wardNeighbors,
      fitBounds: true,
      resetHistory: true,
    });
  } catch (err) {
    if (loadSeq !== previewLoadSeq) return;
    setModalEditorStatus(`Lỗi tải bản đồ: ${err.message}`, 'error');
  }
}

async function openOldDistrictMapPreview(district) {
  if (!district) return;
  const loadSeq = ++previewLoadSeq;
  currentPreviewMode = 'district';
  currentPreviewUnit = district;
  currentPreviewGeojson = null;
  savedDbGeojson = null;
  savedNeighborWards = [];
  setModalEditorStatus('');

  unitMapTitle.textContent = `🏛 ${district.name}`;
  const parts = [];
  if (district.oldProvince) parts.push(`Thuộc: ${district.oldProvince}`);
  if (district.areaKm2) parts.push(`DT tính toán: ~${district.areaKm2.toLocaleString('vi-VN', { maximumFractionDigits: 2 })} km²`);
  if (district.points) parts.push(`${district.points.toLocaleString('vi-VN')} điểm`);
  unitMapSubtitle.textContent = parts.join(' · ') || 'Đang tải bản đồ huyện cũ...';

  modalOpenFullMapLink.href = `/?region=${encodeURIComponent(district.id)}`;
  unitMapModal.hidden = false;

  ensurePreviewMap();
  ensureNeighborProvincesLoaded();
  polygonEditor.clear();
  polygonEditor.setEditEnabled(true);
  polygonEditor.setShowNeighbors(showNeighborWards);
  renderSecondaryRefLayers([], { labelPrefix: 'Xã 2025', isWardRef: true });

  try {
    const [geoResp, neighborsRes] = await Promise.all([
      fetch(`/api/regions/${encodeURIComponent(district.id)}/geojson`, { credentials: 'same-origin' }),
      fetchNeighborRegions(district.id, 0.05).catch(() => ({ neighbors: [] })),
    ]);
    if (loadSeq !== previewLoadSeq) return;
    if (!geoResp.ok) throw new Error(`HTTP ${geoResp.status}`);
    const geojson = await geoResp.json();
    if (loadSeq !== previewLoadSeq) return;

    const allNeighbors = neighborsRes.neighbors || [];
    const peerDistricts = allNeighbors.filter((n) => n.layerGroup === 'district_old');
    const innerWards = allNeighbors.filter((n) => n.layerGroup === 'ward_2025');

    savedDbGeojson = geojson;
    savedNeighborWards = peerDistricts;
    currentPreviewGeojson = geojson;
    renderSecondaryRefLayers(innerWards, { labelPrefix: 'Xã 2025', isWardRef: true });
    drawPreviewGeojson(geojson, district.color || '#7c2d12', {
      neighbors: peerDistricts,
      fitBounds: true,
      resetHistory: true,
    });
  } catch (err) {
    if (loadSeq !== previewLoadSeq) return;
    setModalEditorStatus(`Lỗi tải bản đồ huyện cũ: ${err.message}`, 'error');
  }
}

function closeUnitMapPreview() {
  if (polygonEditor?.isDrawing()) polygonEditor.cancelDrawing();
  unitMapModal.hidden = true;
}

unitMapCloseBtn.addEventListener('click', closeUnitMapPreview);
unitMapModal.addEventListener('click', (e) => {
  if (e.target === unitMapModal) closeUnitMapPreview();
});

modalToggleEditBtn.addEventListener('click', () => {
  if (!polygonEditor) return;
  polygonEditor.setEditEnabled(!polygonEditor.isEditEnabled());
});

modalToggleTopoBtn.addEventListener('click', () => {
  if (!polygonEditor) return;
  const next = !polygonEditor.isTopoEnabled();
  polygonEditor.setTopoEnabled(next);
  setModalEditorStatus(
    next
      ? 'Đã bật Đồng bộ biên chung: kéo/thêm/xóa nút biên chung (chấm xanh ngọc) sẽ tự chỉnh cả xã giáp ranh.'
      : 'Đã tắt Đồng bộ biên chung: chỉ chỉnh riêng đơn vị hiện tại.',
    next ? 'success' : 'warn',
  );
});

modalDrawPolyBtn.addEventListener('click', () => {
  if (!polygonEditor) return;
  if (polygonEditor.isDrawing()) {
    polygonEditor.cancelDrawing();
  } else {
    polygonEditor.startDrawing();
  }
});

modalUndoBtn.addEventListener('click', () => polygonEditor?.undo());
modalRedoBtn.addEventListener('click', () => polygonEditor?.redo());

modalToggleNeighborsBtn.addEventListener('click', () => {
  showNeighborWards = !showNeighborWards;
  polygonEditor?.setShowNeighbors(showNeighborWards);
});

modalToggleOldDistrictsBtn.addEventListener('click', () => {
  showNeighborDistricts = !showNeighborDistricts;
  modalToggleOldDistrictsBtn.classList.toggle('active-ref', showNeighborDistricts);
  if (!previewMap || !neighborDistrictsGroup) return;
  if (showNeighborDistricts) neighborDistrictsGroup.addTo(previewMap);
  else previewMap.removeLayer(neighborDistrictsGroup);
});

modalToggleProvincesBtn.addEventListener('click', () => {
  showNeighborProvinces = !showNeighborProvinces;
  modalToggleProvincesBtn.classList.toggle('active-province', showNeighborProvinces);
  if (!previewMap || !neighborProvincesGroup) return;
  if (showNeighborProvinces) {
    neighborProvincesGroup.addTo(previewMap);
    ensureNeighborProvincesLoaded();
  } else {
    previewMap.removeLayer(neighborProvincesGroup);
  }
});

document.addEventListener('keydown', (e) => {
  if (e.key === 'Escape' && bcvhModal && !bcvhModal.hidden) {
    bcvhModal.hidden = true;
    return;
  }
  if (e.key === 'Escape' && addRegionModal && !addRegionModal.hidden) {
    addRegionModal.hidden = true;
    return;
  }
  if (unitMapModal.hidden) return;

  if (e.key === 'Escape') {
    if (polygonEditor?.isDrawing()) {
      polygonEditor.cancelDrawing();
    } else {
      closeUnitMapPreview();
    }
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

modalRevertBtn.addEventListener('click', () => {
  if (!savedDbGeojson) return;
  if (
    !window.confirm(
      '⚠ Xác nhận Reset về dữ liệu đang lưu trong DB?\nMọi thay đổi đỉnh chưa lưu trên bản đồ hiện tại sẽ bị hủy bỏ.',
    )
  ) {
    return;
  }
  currentPreviewGeojson = savedDbGeojson;
  const polyColor =
    currentPreviewMode === 'district'
      ? currentPreviewUnit?.color || '#7c2d12'
      : currentPreviewUnit?.region?.color || '#2563eb';
  drawPreviewGeojson(savedDbGeojson, polyColor, {
    neighbors: savedNeighborWards,
    fitBounds: Boolean(savedDbGeojson.features?.length),
    resetHistory: true,
  });
  setModalEditorStatus('Đã khôi phục ranh giới (và các vùng giáp ranh) theo bản đang lưu trong SQL Server.', 'success');
});

modalSaveGeojsonBtn.addEventListener('click', async () => {
  if (!currentPreviewUnit || !polygonEditor) return;
  if (polygonEditor.isDrawing()) polygonEditor.cancelDrawing();
  const payload = polygonEditor.getGeojson();
  if (!payload?.features?.length) {
    setModalEditorStatus('Chưa có đa giác nào để lưu — hãy bấm "+ Vẽ vùng mới" trước.', 'error');
    return;
  }
  const neighborUpdates = polygonEditor.getModifiedNeighbors();

  modalSaveGeojsonBtn.disabled = true;
  modalSaveGeojsonBtn.textContent = 'Đang lưu...';
  try {
    if (currentPreviewMode === 'district') {
      const res = await saveRegionGeojson(currentPreviewUnit.id, payload, neighborUpdates);
      if (res.db) updateDbPill(res.db);
      savedDbGeojson = res.region.geojson;
      currentPreviewGeojson = res.region.geojson;

      const savedMap = new Map((res.updatedNeighbors || []).map((n) => [n.id, n]));
      savedNeighborWards = savedNeighborWards.map((n) => (savedMap.has(n.id) ? { ...n, geojson: savedMap.get(n.id).geojson } : n));

      drawPreviewGeojson(res.region.geojson, res.region.color || '#7c2d12', {
        neighbors: savedNeighborWards,
        fitBounds: false,
        resetHistory: true,
      });

      // Update rows in the 30 old districts table
      for (const item of [res.region, ...(res.updatedNeighbors || [])]) {
        const idx = oldDistrictsList.findIndex((d) => d.id === item.id);
        if (idx >= 0) {
          oldDistrictsList[idx] = {
            ...oldDistrictsList[idx],
            areaKm2: item.areaKm2,
            points: item.points,
            modified: true,
          };
        }
      }
      renderOldDistrictsTable();

      const syncedNames = (res.updatedNeighbors || []).map((n) => n.name).filter(Boolean);
      const syncText = syncedNames.length ? ` + ${syncedNames.length} huyện giáp ranh (${syncedNames.join(', ')})` : '';
      setModalEditorStatus(
        `✓ Đã lưu ${currentPreviewUnit.name}${syncText} vào SQL Server (~${res.region.areaKm2.toLocaleString('vi-VN', { maximumFractionDigits: 2 })} km², ${res.region.points} điểm).`,
        'success',
      );
      setStatus(`Đã lưu đồng bộ "${currentPreviewUnit.name}"${syncText} vào SQL Server.`, 'success');
    } else {
      const res = await saveLamDongUnitGeojson(currentPreviewUnit.id, payload, neighborUpdates);
      if (res.db) updateDbPill(res.db);
      currentPreviewUnit = res.unit;
      savedDbGeojson = res.region.geojson;
      currentPreviewGeojson = res.region.geojson;

      const savedMap = new Map((res.updatedNeighbors || []).map((n) => [n.id, n]));
      savedNeighborWards = savedNeighborWards.map((n) => (savedMap.has(n.id) ? { ...n, geojson: savedMap.get(n.id).geojson } : n));

      modalOpenFullMapLink.href = `/?region=${encodeURIComponent(res.region.id)}`;
      drawPreviewGeojson(res.region.geojson, res.region.color || '#2563eb', {
        neighbors: savedNeighborWards,
        fitBounds: false,
        resetHistory: true,
      });
      for (const u of res.updatedUnits || [res.unit]) {
        if (u) adminTableController.updateUnitRow(u);
      }

      const syncedNames = (res.updatedNeighbors || []).map((n) => n.name).filter(Boolean);
      const syncText = syncedNames.length ? ` + ${syncedNames.length} xã giáp ranh (${syncedNames.join(', ')})` : '';
      setModalEditorStatus(
        `✓ Đã lưu ${res.unit.name}${syncText} vào SQL Server (~${res.region.areaKm2.toLocaleString('vi-VN', { maximumFractionDigits: 2 })} km², ${res.region.points} điểm).`,
        'success',
      );
      setStatus(`Đã lưu đồng bộ "${res.unit.name}"${syncText} vào SQL Server.`, 'success');
    }
  } catch (err) {
    if (err.status === 401) {
      closeUnitMapPreview();
      showLoginScreen();
    }
    setModalEditorStatus(`Lỗi lưu DB: ${err.message}`, 'error');
  } finally {
    modalSaveGeojsonBtn.disabled = false;
    modalSaveGeojsonBtn.textContent = '💾 Lưu vào DB';
  }
});

modalCopyGeojsonBtn.addEventListener('click', async () => {
  const geo = polygonEditor?.getGeojson() || currentPreviewGeojson;
  const text = serializeGeometryOneLine(geo);
  if (!text) return;
  try {
    if (navigator.clipboard && window.isSecureContext) {
      await navigator.clipboard.writeText(text);
    } else {
      const ta = document.createElement('textarea');
      ta.value = text;
      ta.style.position = 'fixed';
      ta.style.opacity = '0';
      document.body.appendChild(ta);
      ta.select();
      document.execCommand('copy');
      ta.remove();
    }
    const old = modalCopyGeojsonBtn.textContent;
    modalCopyGeojsonBtn.textContent = 'Đã copy ✓';
    setTimeout(() => (modalCopyGeojsonBtn.textContent = old), 1500);
  } catch {
    setModalEditorStatus('Không thể copy tự động, hãy dùng nút tải file .geojson.', 'error');
  }
});

modalDownloadBtn.addEventListener('click', () => {
  const geo = polygonEditor?.getGeojson() || currentPreviewGeojson;
  if (!geo || !currentPreviewUnit) return;
  const text = JSON.stringify(geo, null, 2);
  const blob = new Blob([text], { type: 'application/geo+json;charset=utf-8' });
  const slug = String(currentPreviewUnit.name || 'unit')
    .normalize('NFD')
    .replace(/[\u0300-\u036f]/g, '')
    .replace(/đ/g, 'd')
    .replace(/Đ/g, 'D')
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, '-')
    .replace(/^-+|-+$/g, '');
  const a = document.createElement('a');
  a.href = URL.createObjectURL(blob);
  const prefix = currentPreviewUnit.stt ? `${currentPreviewUnit.stt}-` : 'huyen-cu-';
  a.download = `${prefix}${slug || 'unit'}.geojson`;
  document.body.appendChild(a);
  a.click();
  a.remove();
  URL.revokeObjectURL(a.href);
});

// --- 30 Old Districts Sub-tab ---
function renderOldDistrictsTable() {
  if (!oldDistrictTableBody) return;
  const q = (oldDistrictSearchInput?.value || '').trim().toLowerCase();
  const prov = oldDistrictProvinceFilter?.value || 'all';

  const filtered = oldDistrictsList.filter((d) => {
    if (prov !== 'all' && d.oldProvince !== prov) return false;
    if (q && !`${d.name} ${d.oldProvince} ${d.description}`.toLowerCase().includes(q)) return false;
    return true;
  });

  if (oldDistrictStatTotal) oldDistrictStatTotal.textContent = String(oldDistrictsList.length);
  if (oldDistrictStatModified) {
    const modCount = oldDistrictsList.filter((d) => d.modified).length;
    oldDistrictStatModified.textContent = `${modCount} huyện đã sửa`;
    oldDistrictStatModified.hidden = modCount === 0;
  }

  if (filtered.length === 0) {
    oldDistrictTableBody.innerHTML = '<tr><td colspan="6" class="admin-empty-cell">Không tìm thấy huyện cũ phù hợp.</td></tr>';
    return;
  }

  const frag = document.createDocumentFragment();
  filtered.forEach((d, idx) => {
    const tr = document.createElement('tr');
    tr.innerHTML = `
      <td class="col-stt">${idx + 1}</td>
      <td class="col-name">
        <div class="unit-name-line">
          <span class="tag-layer-old">Huyện cũ</span>
          <strong></strong>
        </div>
      </td>
      <td class="col-old-district"><div class="old-district-name"></div></td>
      <td class="col-metrics num-col">
        <div>~${d.areaKm2.toLocaleString('vi-VN', { maximumFractionDigits: 2 })} km²</div>
        <div class="sub-metric">${d.points.toLocaleString('vi-VN')} điểm</div>
      </td>
      <td class="col-status">
        <span class="clean-status ${d.modified ? 'pending' : 'ok'}">${d.modified ? 'Đã chỉnh tay' : 'Dữ liệu gốc'}</span>
      </td>
      <td class="col-actions right-col">
        <button type="button" class="btn small primary edit-district-map-btn">🗺 Sửa bản đồ</button>
      </td>
    `;
    tr.querySelector('.unit-name-line strong').textContent = d.name;
    tr.querySelector('.old-district-name').textContent = d.oldProvince || '—';
    tr.querySelector('.edit-district-map-btn').addEventListener('click', () => openOldDistrictMapPreview(d));
    frag.appendChild(tr);
  });

  oldDistrictTableBody.innerHTML = '';
  oldDistrictTableBody.appendChild(frag);
}

async function loadOldDistricts(force = false) {
  if (oldDistrictsLoaded && !force) return;
  try {
    const res = await fetchOldDistricts();
    if (res.db) updateDbPill(res.db);
    oldDistrictsList = res.districts || [];
    oldDistrictsLoaded = true;
    renderOldDistrictsTable();
  } catch (err) {
    if (oldDistrictTableBody) {
      oldDistrictTableBody.innerHTML = `<tr><td colspan="6" class="admin-empty-cell">Lỗi tải danh sách huyện cũ: ${err.message}</td></tr>`;
    }
  }
}

function switchAdminSubtab(tab) {
  const isWards = tab === 'wards';
  const isDistricts = tab === 'districts';
  const isBcvh = tab === 'bcvh';

  adminTabWardsBtn?.classList.toggle('active', isWards);
  adminTabWardsBtn?.setAttribute('aria-selected', String(isWards));
  adminTabDistrictsBtn?.classList.toggle('active', isDistricts);
  adminTabDistrictsBtn?.setAttribute('aria-selected', String(isDistricts));
  adminTabBcvhBtn?.classList.toggle('active', isBcvh);
  adminTabBcvhBtn?.setAttribute('aria-selected', String(isBcvh));

  if (wardsAdminPanel) wardsAdminPanel.hidden = !isWards;
  if (oldDistrictsAdminPanel) oldDistrictsAdminPanel.hidden = !isDistricts;
  if (bcvhAdminPanel) bcvhAdminPanel.hidden = !isBcvh;

  if (isDistricts) loadOldDistricts(true);
  if (isBcvh) loadBcvhOffices(true);
}

adminTabWardsBtn?.addEventListener('click', () => switchAdminSubtab('wards'));
adminTabDistrictsBtn?.addEventListener('click', () => switchAdminSubtab('districts'));
adminTabBcvhBtn?.addEventListener('click', () => switchAdminSubtab('bcvh'));
oldDistrictSearchInput?.addEventListener('input', renderOldDistrictsTable);
oldDistrictProvinceFilter?.addEventListener('change', renderOldDistrictsTable);

// --- BCVH (Bưu cục Vận hành) Management ---
function renderBcvhTable() {
  if (!bcvhTableBody) return;
  const q = (bcvhSearchInput?.value || '').trim().toLowerCase();
  if (bcvhStatTotal) bcvhStatTotal.textContent = String(bcvhList.length);

  const filtered = bcvhList.filter((o) => {
    if (!q) return true;
    return `${o.name} ${o.code} ${o.hostWardName} ${o.address} ${(o.wardNames || []).join(' ')}`
      .toLowerCase()
      .includes(q);
  });

  if (filtered.length === 0) {
    bcvhTableBody.innerHTML =
      '<tr><td colspan="5" class="admin-empty-cell">Chưa có Bưu cục Vận hành phù hợp. Bấm "🚚 + Thêm Bưu cục Vận hành" để tạo mới.</td></tr>';
    return;
  }

  const frag = document.createDocumentFragment();
  filtered.forEach((o, idx) => {
    const tr = document.createElement('tr');
    const coordText =
      o.lat !== null && o.lng !== null ? `${o.lat.toFixed(5)}, ${o.lng.toFixed(5)}` : 'Tự động theo tâm xã đặt';
    const hostText = o.hostWardName || (o.lat !== null ? 'Theo tọa độ thủ công' : '—');
    const chipsHtml = (o.wardNames || [])
      .slice(0, 8)
      .map((name) => `<span class="bcvh-ward-chip${name === o.hostWardName ? ' host' : ''}">${name.replace(/</g, '&lt;')}</span>`)
      .join('');
    const moreHtml =
      (o.wardNames?.length || 0) > 8
        ? `<span class="bcvh-ward-chip">+${o.wardNames.length - 8} xã nữa</span>`
        : '';

    tr.innerHTML = `
      <td class="col-stt">${idx + 1}</td>
      <td class="col-name">
        <div class="unit-name-line">
          <span class="color-dot" style="background:${o.color}"></span>
          <strong></strong>
          ${o.code ? `<span class="tag-layer-old"></span>` : ''}
        </div>
        ${o.address ? `<div class="sub-metric bcvh-addr"></div>` : ''}
      </td>
      <td class="col-old-district">
        <div class="old-district-name bcvh-host"></div>
        <div class="sub-metric">${coordText}</div>
      </td>
      <td>
        <div class="sub-metric" style="margin-top:0;font-weight:600;color:#334155;">
          ${(o.wardUnitIds || []).length} xã · ~${(o.computedAreaKm2 || o.totalAreaKm2 || 0).toLocaleString('vi-VN', { maximumFractionDigits: 1 })} km²
          ${o.serviceGeojson ? ` · <a href="/api/bcvh/${o.id}/geojson" target="_blank" rel="noopener" style="color:#2563eb;text-decoration:none;">GeoJSON vùng ↗</a>` : ''}
        </div>
        <div class="bcvh-wards-chips">${chipsHtml}${moreHtml}</div>
      </td>
      <td class="col-actions right-col">
        <div class="row-action-btns right-actions">
          <button type="button" class="btn small primary edit-bcvh-btn">✏ Sửa</button>
          <button type="button" class="btn small danger-solid del-bcvh-btn" title="Xóa BCVH này">🗑</button>
        </div>
      </td>
    `;

    tr.querySelector('.unit-name-line strong').textContent = o.name;
    const codeTag = tr.querySelector('.tag-layer-old');
    if (codeTag) codeTag.textContent = o.code;
    const addrEl = tr.querySelector('.bcvh-addr');
    if (addrEl) addrEl.textContent = o.address;
    tr.querySelector('.bcvh-host').textContent = `🚚 ${hostText}`;

    tr.querySelector('.edit-bcvh-btn').addEventListener('click', () => openBcvhModal(o));
    tr.querySelector('.del-bcvh-btn').addEventListener('click', async () => {
      if (!window.confirm(`⚠ Xác nhận xóa Bưu cục Vận hành "${o.name}"?\nThao tác này không xóa dữ liệu các xã.`)) {
        return;
      }
      try {
        await deleteBcvhOffice(o.id);
        bcvhList = bcvhList.filter((x) => x.id !== o.id);
        renderBcvhTable();
        setStatus(`Đã xóa Bưu cục Vận hành "${o.name}".`, 'success');
      } catch (err) {
        setStatus(`Lỗi xóa BCVH: ${err.message}`, 'error');
      }
    });

    frag.appendChild(tr);
  });

  bcvhTableBody.innerHTML = '';
  bcvhTableBody.appendChild(frag);
}

async function loadBcvhOffices(force = false) {
  if (bcvhLoaded && !force) return;
  try {
    const res = await fetchAdminBcvhOffices();
    if (res.db) updateDbPill(res.db);
    bcvhList = res.offices || [];
    bcvhLoaded = true;
    renderBcvhTable();
  } catch (err) {
    if (bcvhTableBody) {
      bcvhTableBody.innerHTML = `<tr><td colspan="5" class="admin-empty-cell">Lỗi tải danh sách BCVH: ${err.message}</td></tr>`;
    }
  }
}

function getBcvhFilteredWardUnits() {
  const all = adminTableController.getUnits() || [];
  const q = (bcvhWardSearchInput?.value || '').trim().toLowerCase();
  const od = bcvhWardDistrictFilter?.value || 'all';
  return all.filter((u) => {
    if (od !== 'all' && !String(u.oldDistrict || '').includes(od)) return false;
    if (q && !`${u.stt} ${u.name} ${u.oldDistrict || ''}`.toLowerCase().includes(q)) return false;
    return true;
  });
}

function renderBcvhWardChecklist() {
  if (!bcvhWardChecklist) return;
  const filtered = getBcvhFilteredWardUnits();
  if (bcvhSelectedCountBadge) bcvhSelectedCountBadge.textContent = `${modalSelectedWardIds.size} xã`;

  bcvhWardChecklist.innerHTML = '';
  const frag = document.createDocumentFragment();
  for (const u of filtered) {
    const checked = modalSelectedWardIds.has(u.id);
    const label = document.createElement('label');
    label.className = `bcvh-ward-opt${checked ? ' checked' : ''}`;
    const cb = document.createElement('input');
    cb.type = 'checkbox';
    cb.checked = checked;
    cb.addEventListener('change', () => {
      if (cb.checked) {
        modalSelectedWardIds.add(u.id);
      } else {
        modalSelectedWardIds.delete(u.id);
        if (bcvhHostWardSelect && Number(bcvhHostWardSelect.value) === u.id) {
          bcvhHostWardSelect.value = '';
        }
      }
      label.classList.toggle('checked', cb.checked);
      if (bcvhSelectedCountBadge) bcvhSelectedCountBadge.textContent = `${modalSelectedWardIds.size} xã`;
    });
    const span = document.createElement('span');
    span.textContent = u.name;
    label.append(cb, span);
    frag.appendChild(label);
  }
  bcvhWardChecklist.appendChild(frag);
}

function populateBcvhWardSelectors(selectedHostId = null) {
  const all = adminTableController.getUnits() || [];
  if (bcvhHostWardSelect) {
    bcvhHostWardSelect.innerHTML =
      '<option value="">-- Chọn xã đặt vị trí --</option>' +
      all
        .map(
          (u) =>
            `<option value="${u.id}"${Number(selectedHostId) === u.id ? ' selected' : ''}>${u.name}${
              u.oldDistrict ? ` (${u.oldDistrict})` : ''
            }</option>`,
        )
        .join('');
  }
  if (bcvhWardDistrictFilter) {
    const names = new Set();
    for (const u of all) {
      for (const p of String(u.oldDistrict || '').split(',')) {
        const clean = p.trim();
        if (clean) names.add(clean);
      }
    }
    const sorted = [...names].sort((a, b) => a.localeCompare(b, 'vi'));
    bcvhWardDistrictFilter.innerHTML =
      '<option value="all">Tất cả huyện cũ</option>' + sorted.map((n) => `<option value="${n}">${n}</option>`).join('');
  }
}

const BCVH_SUGGEST_COLORS = [
  '#ea580c', '#2563eb', '#16a34a', '#9333ea', '#0891b2', '#e11d48',
  '#ca8a04', '#4f46e5', '#059669', '#dc2626', '#7c3aed', '#0284c7',
];

function openBcvhModal(existing = null) {
  editingBcvhId = existing?.id || null;
  bcvhModalTitle.textContent = editingBcvhId ? `✏ Sửa BCVH: ${existing.name}` : '🚚 Thêm Bưu cục Vận hành';
  bcvhNameInput.value = existing?.name || '';
  bcvhCodeInput.value = existing?.code || '';
  const usedColors = new Set(bcvhList.map((x) => String(x.color || '').toLowerCase()));
  const nextColor = BCVH_SUGGEST_COLORS.find((c) => !usedColors.has(c)) || BCVH_SUGGEST_COLORS[bcvhList.length % BCVH_SUGGEST_COLORS.length];
  bcvhColorInput.value = existing?.color || nextColor;
  bcvhLatInput.value = existing?.lat !== null && existing?.lat !== undefined ? String(existing.lat) : '';
  bcvhLngInput.value = existing?.lng !== null && existing?.lng !== undefined ? String(existing.lng) : '';
  bcvhAddressInput.value = existing?.address || '';
  bcvhWardSearchInput.value = '';
  bcvhFormError.hidden = true;

  modalSelectedWardIds = new Set(existing?.wardUnitIds || []);
  populateBcvhWardSelectors(existing?.hostUnitId || null);
  renderBcvhWardChecklist();

  bcvhModal.hidden = false;
  bcvhNameInput.focus();
}

function closeBcvhModal() {
  if (bcvhModal) bcvhModal.hidden = true;
}

let locateCoordsTimer = null;

function triggerAutoLocateWardFromCoords() {
  clearTimeout(locateCoordsTimer);
  const rawLat = bcvhLatInput.value.trim().replace(',', '.');
  const rawLng = bcvhLngInput.value.trim().replace(',', '.');
  const lat = Number(rawLat);
  const lng = Number(rawLng);
  if (!rawLat || !rawLng || !Number.isFinite(lat) || !Number.isFinite(lng)) return;

  locateCoordsTimer = setTimeout(async () => {
    try {
      const res = await locateWardByCoords(lat, lng);
      if (res.unit?.id && bcvhHostWardSelect) {
        bcvhHostWardSelect.value = String(res.unit.id);
      }
    } catch {
      // silent fallback; backend also resolves on save
    }
  }, 260);
}

// Auto-split "lat, lng" pasted from Google Maps into the Lat field & auto-detect containing ward
bcvhLatInput?.addEventListener('input', () => {
  const val = bcvhLatInput.value.trim();
  const m = val.match(/^(-?\d+(?:\.\d+)?)\s*[,;\s]\s*(-?\d+(?:\.\d+)?)$/);
  if (m) {
    bcvhLatInput.value = m[1];
    bcvhLngInput.value = m[2];
  }
  triggerAutoLocateWardFromCoords();
});

bcvhLngInput?.addEventListener('input', triggerAutoLocateWardFromCoords);

// Selecting host ward automatically checks it into served wards
bcvhHostWardSelect?.addEventListener('change', () => {
  const id = Number(bcvhHostWardSelect.value);
  if (id > 0) {
    modalSelectedWardIds.add(id);
    renderBcvhWardChecklist();
  }
});

bcvhWardSearchInput?.addEventListener('input', renderBcvhWardChecklist);
bcvhWardDistrictFilter?.addEventListener('change', renderBcvhWardChecklist);
bcvhSelectFilteredBtn?.addEventListener('click', () => {
  for (const u of getBcvhFilteredWardUnits()) modalSelectedWardIds.add(u.id);
  renderBcvhWardChecklist();
});
bcvhClearWardsBtn?.addEventListener('click', () => {
  modalSelectedWardIds.clear();
  if (bcvhHostWardSelect) bcvhHostWardSelect.value = '';
  renderBcvhWardChecklist();
});

openNewBcvhBtn?.addEventListener('click', () => openBcvhModal(null));
bcvhModalCloseBtn?.addEventListener('click', closeBcvhModal);
bcvhCancelBtn?.addEventListener('click', closeBcvhModal);
bcvhModal?.addEventListener('click', (e) => {
  if (e.target === bcvhModal) closeBcvhModal();
});
bcvhSearchInput?.addEventListener('input', renderBcvhTable);

bcvhForm?.addEventListener('submit', async (e) => {
  e.preventDefault();
  bcvhFormError.hidden = true;
  bcvhSaveBtn.disabled = true;
  bcvhSaveBtn.textContent = 'Đang lưu...';
  try {
    const payload = {
      name: bcvhNameInput.value.trim(),
      code: bcvhCodeInput.value.trim(),
      color: bcvhColorInput.value || '#ea580c',
      address: bcvhAddressInput.value.trim(),
      hostUnitId: bcvhHostWardSelect.value ? Number(bcvhHostWardSelect.value) : null,
      lat: bcvhLatInput.value.trim() === '' ? null : Number(bcvhLatInput.value.trim().replace(',', '.')),
      lng: bcvhLngInput.value.trim() === '' ? null : Number(bcvhLngInput.value.trim().replace(',', '.')),
      wardUnitIds: [...modalSelectedWardIds],
    };

    const res = editingBcvhId
      ? await updateBcvhOffice(editingBcvhId, payload)
      : await createBcvhOffice(payload);

    if (editingBcvhId) {
      const idx = bcvhList.findIndex((x) => x.id === editingBcvhId);
      if (idx >= 0) bcvhList[idx] = res.office;
    } else {
      bcvhList.push(res.office);
    }
    renderBcvhTable();
    closeBcvhModal();
    setStatus(`Đã lưu Bưu cục Vận hành "${res.office.name}" (${res.office.wardUnitIds.length} xã).`, 'success');
  } catch (err) {
    if (err.status === 401) {
      closeBcvhModal();
      showLoginScreen();
    }
    bcvhFormError.textContent = err.message;
    bcvhFormError.hidden = false;
  } finally {
    bcvhSaveBtn.disabled = false;
    bcvhSaveBtn.textContent = '💾 Lưu Bưu cục Vận hành';
  }
});

function setStatus(message, type = 'success') {
  if (!message) {
    statusBanner.hidden = true;
    return;
  }
  statusBanner.textContent = message;
  statusBanner.className = `status-banner ${type}`;
  statusBanner.hidden = false;
}

function updateDbPill(db) {
  if (!db) return;
  if (db.connected) {
    dbStatusPill.hidden = true;
  } else {
    dbStatusPill.textContent = 'SQL Server: Mất kết nối';
    dbStatusPill.className = 'db-pill danger';
    dbStatusPill.title = db.error || 'Chưa kết nối SQL Server';
    dbStatusPill.hidden = false;
  }
}

const adminTableController = initAdminTab({
  onDbUpdate: updateDbPill,
  onOpenRegionOnMap: (unit) => openUnitMapPreview(unit),
  onOpenAllSavedOnMap: () => {
    window.location.href = '/';
  },
});

function showAuthenticated(username) {
  loginScreen.hidden = true;
  adminView.hidden = false;
  adminUserBadge.textContent = `👤 ${username}`;
  adminUserBadge.hidden = false;
  logoutBtn.hidden = false;
  adminTableController.onActivate();
  loadBcvhOffices(true);
  if (window.location.hash === '#bcvh') {
    switchAdminSubtab('bcvh');
  }
}

function showLoginScreen() {
  adminView.hidden = true;
  loginScreen.hidden = false;
  adminUserBadge.hidden = true;
  logoutBtn.hidden = true;
  loginError.hidden = true;
  loginUsername.focus();
}

async function addAndSaveUrl(rawUrl) {
  const extracted = await extractWikiRegion(rawUrl, sourceSelect.value);
  const stats = computeGeoStats(extracted.geojson, null);
  const key = `${extracted.meta.qid || extracted.meta.name}::${extracted.meta.source}`;
  const saved = await saveRegionToDb({
    key,
    layerGroup: 'custom',
    color: '#2563eb',
    areaKm2: stats.areaKm2,
    points: stats.points,
    modified: false,
    meta: extracted.meta,
    geojson: extracted.geojson,
    originalGeojson: extracted.geojson,
  });
  if (saved.db) updateDbPill(saved.db);
  return saved.region;
}

// --- Auth Events ---
togglePasswordBtn.addEventListener('click', () => {
  const isPwd = loginPassword.type === 'password';
  loginPassword.type = isPwd ? 'text' : 'password';
  togglePasswordBtn.textContent = isPwd ? '🙈' : '👁';
});

loginForm.addEventListener('submit', async (e) => {
  e.preventDefault();
  loginError.hidden = true;
  loginSubmitBtn.disabled = true;
  loginSubmitBtn.textContent = 'Đang xác thực...';
  try {
    const res = await loginAdmin(loginUsername.value.trim(), loginPassword.value);
    loginPassword.value = '';
    setStatus(`Đăng nhập thành công (${res.username}).`, 'success');
    showAuthenticated(res.username);
  } catch (err) {
    loginError.textContent = err.message || 'Đăng nhập thất bại.';
    loginError.hidden = false;
    loginPassword.select();
  } finally {
    loginSubmitBtn.disabled = false;
    loginSubmitBtn.textContent = 'Đăng nhập';
  }
});

logoutBtn.addEventListener('click', async () => {
  try {
    await logoutAdmin();
  } finally {
    setStatus('Đã đăng xuất khỏi trang quản trị.', 'success');
    showLoginScreen();
  }
});

// --- Add Region Modal & Manual Add Link to DB Events ---
openAddRegionModalBtn?.addEventListener('click', () => {
  if (!addRegionModal) return;
  addRegionModal.hidden = false;
  wikiUrlInput.focus();
});

addRegionModalCloseBtn?.addEventListener('click', () => {
  if (addRegionModal) addRegionModal.hidden = true;
});

addRegionModal?.addEventListener('click', (e) => {
  if (e.target === addRegionModal) addRegionModal.hidden = true;
});

extractForm.addEventListener('submit', async (e) => {
  e.preventDefault();
  const url = wikiUrlInput.value.trim();
  if (!url) return;
  fetchBtn.disabled = true;
  spinner.hidden = false;
  btnLabel.textContent = 'Đang lưu...';
  setStatus('');
  try {
    const saved = await addAndSaveUrl(url);
    setStatus(`Đã thêm & lưu "${saved.meta.name}" vào SQL Server (ID #${saved.id}).`, 'success');
  } catch (err) {
    if (err.status === 401) showLoginScreen();
    setStatus(err.message, 'error');
  } finally {
    fetchBtn.disabled = false;
    spinner.hidden = true;
    btnLabel.textContent = '+ Thêm & Lưu DB';
  }
});

clearBtn.addEventListener('click', () => {
  wikiUrlInput.value = '';
  wikiUrlInput.focus();
});

toggleBatchBtn.addEventListener('click', () => {
  batchDrawer.hidden = !batchDrawer.hidden;
  if (!batchDrawer.hidden) batchInput.focus();
});

batchCloseBtn.addEventListener('click', () => {
  batchDrawer.hidden = true;
});

batchLoadBtn.addEventListener('click', async () => {
  const lines = batchInput.value.split(/[\r\n]+/).map((s) => s.trim()).filter(Boolean);
  if (lines.length === 0) {
    batchProgress.textContent = 'Vui lòng dán ít nhất 1 đường dẫn.';
    return;
  }
  batchLoadBtn.disabled = true;
  let ok = 0;
  let fail = 0;
  for (let i = 0; i < lines.length; i++) {
    batchProgress.textContent = `Đang tải & lưu ${i + 1}/${lines.length}...`;
    try {
      await addAndSaveUrl(lines[i]);
      ok++;
    } catch (err) {
      if (err.status === 401) {
        showLoginScreen();
        break;
      }
      fail++;
    }
  }
  batchLoadBtn.disabled = false;
  const summary = `Hoàn tất: đã lưu ${ok}/${lines.length} vùng vào SQL Server${fail ? ` (${fail} lỗi)` : ''}.`;
  batchProgress.textContent = summary;
  setStatus(summary, fail ? 'warn' : 'success');
});

// --- Startup ---
(async () => {
  try {
    const health = await fetchHealth();
    updateDbPill(health.db);
  } catch {
    updateDbPill({ connected: false, error: 'Backend không phản hồi' });
  }

  try {
    const me = await fetchAuthMe();
    if (me.authenticated) {
      showAuthenticated(me.username);
    } else {
      showLoginScreen();
    }
  } catch {
    showLoginScreen();
  }
})();
