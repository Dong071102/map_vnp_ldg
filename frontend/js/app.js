import {
  fetchHealth,
  fetchSavedRegions,
  fetchBcvhOffices,
} from './api.js';
import {
  isPolygonFeature,
  formatArea,
  computeGeoStats,
} from './geometry.js';
import { addVietnamIslandsOverlay } from './vnIslandsOverlay.js';

const MAX_PREVIEW_CHARS = 70000;
const PALETTE = [
  '#2563eb', '#10b981', '#f59e0b', '#8b5cf6',
  '#06b6d4', '#ec4899', '#84cc16', '#f97316',
  '#6366f1', '#14b8a6', '#eab308', '#d946ef',
];

// 30 unique, high-contrast cartographic colors for old districts when viewed solo
const DISTRICT_DISTINCT_PALETTE = [
  '#2563eb', '#16a34a', '#ea580c', '#9333ea', '#0891b2', '#e11d48',
  '#ca8a04', '#4f46e5', '#059669', '#dc2626', '#0284c7', '#65a30d',
  '#c026d3', '#d97706', '#0d9488', '#7c3aed', '#db2777', '#15803d',
  '#1d4ed8', '#b45309', '#0369a1', '#4d7c0f', '#a21caf', '#be123c',
  '#0f766e', '#6d28d9', '#c2410c', '#047857', '#3730a3', '#9f1239',
];

function assignDistinctOldDistrictColors(regionList) {
  const oldDistricts = regionList.filter((r) => r.layerGroup === 'district_old');
  oldDistricts.forEach((r, idx) => {
    r.distinctColor = DISTRICT_DISTINCT_PALETTE[idx % DISTRICT_DISTINCT_PALETTE.length];
  });
}

// --- Map Setup ---
const map = L.map('map', { zoomControl: true }).setView([11.55, 107.65], 8);
map.createPane('districtPane');
map.getPane('districtPane').style.zIndex = 430;
map.createPane('bcvhZonePane');
map.getPane('bcvhZonePane').style.zIndex = 435;
map.createPane('bcvhPane');
map.getPane('bcvhPane').style.zIndex = 650;

const googleViMap = L.tileLayer('https://mt{s}.google.com/vt/lyrs=m&hl=vi&x={x}&y={y}&z={z}', {
  subdomains: ['0', '1', '2', '3'],
  maxZoom: 20,
  attribution: '&copy; Google Maps',
});
const esriSatLayer = L.tileLayer(
  'https://server.arcgisonline.com/ArcGIS/rest/services/World_Imagery/MapServer/tile/{z}/{y}/{x}',
  { maxZoom: 19, attribution: 'Tiles &copy; Esri' },
);
const googleHybridVi = L.tileLayer('https://mt{s}.google.com/vt/lyrs=y&hl=vi&x={x}&y={y}&z={z}', {
  subdomains: ['0', '1', '2', '3'],
  maxZoom: 20,
  attribution: '&copy; Google Maps',
});
const esriStreetLayer = L.tileLayer(
  'https://server.arcgisonline.com/ArcGIS/rest/services/World_Street_Map/MapServer/tile/{z}/{y}/{x}',
  { maxZoom: 19, attribution: 'Tiles &copy; Esri' },
);
googleViMap.addTo(map);
addVietnamIslandsOverlay(map);
L.control
  .layers(
    {
      'Bản đồ tiếng Việt': googleViMap,
      'Ảnh vệ tinh (Esri)': esriSatLayer,
      'Vệ tinh + Tên đường': googleHybridVi,
      'Bản đồ đường phố (Esri)': esriStreetLayer,
    },
    {},
    { position: 'topright' },
  )
  .addTo(map);

// --- DOM Refs ---
const $ = (id) => document.getElementById(id);
const dbStatusPill = $('dbStatusPill');
const statusBanner = $('statusBanner');

const fitBoundsBtn = $('fitBoundsBtn');
const showWardsLayerToggle = $('showWardsLayerToggle');
const showOldDistrictsLayerToggle = $('showOldDistrictsLayerToggle');
const showBcvhLayerToggle = $('showBcvhLayerToggle');
const showLabelsToggle = $('showLabelsToggle');
const opacityRange = $('opacityRange');
const statRegions = $('statRegions');

const bcvhCount = $('bcvhCount');
const clearBcvhFocusBtn = $('clearBcvhFocusBtn');
const bcvhListEmpty = $('bcvhListEmpty');
const bcvhListEl = $('bcvhList');

const regionCount = $('regionCount');
const polygonsOnlyToggle = $('polygonsOnlyToggle');
const reloadDbBtn = $('reloadDbBtn');
const regionSearchInput = $('regionSearchInput');
const regionLayerFilter = $('regionLayerFilter');
const regionListEmpty = $('regionListEmpty');
const regionList = $('regionList');

const metaCard = $('metaCard');
const sourceBadge = $('sourceBadge');
const metaName = $('metaName');
const metaDescRow = $('metaDescRow');
const metaDesc = $('metaDesc');
const metaIds = $('metaIds');
const metaMetrics = $('metaMetrics');
const metaLinks = $('metaLinks');
const traceBox = $('traceBox');
const traceList = $('traceList');

const exportTabBtns = document.querySelectorAll('.tab-btn[data-export-mode]');
const prettyToggle = $('prettyToggle');
const copyBtn = $('copyBtn');
const downloadGeojsonBtn = $('downloadGeojsonBtn');
const downloadJsonBtn = $('downloadJsonBtn');
const jsonNote = $('jsonNote');
const jsonPreview = $('jsonPreview');

// --- State ---
let regions = [];
let bcvhOffices = [];
let activeBcvhId = null;
const bcvhZoneLayerGroup = L.layerGroup().addTo(map);
const bcvhLayerGroup = L.layerGroup().addTo(map);
let selectedRegionId = null;
let exportMode = 'merged';
let colorCursor = 0;

// --- Helpers ---
function escapeHtml(str) {
  return String(str ?? '')
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;');
}

function slugify(str) {
  return (
    String(str || 'region')
      .normalize('NFD')
      .replace(/[\u0300-\u036f]/g, '')
      .replace(/đ/g, 'd')
      .replace(/Đ/g, 'D')
      .toLowerCase()
      .replace(/[^a-z0-9]+/g, '-')
      .replace(/^-+|-+$/g, '') || 'region'
  );
}

function nextColor() {
  const c = PALETTE[colorCursor % PALETTE.length];
  colorCursor++;
  return c;
}

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
  if (!db || !dbStatusPill) return;
  if (db.connected) {
    dbStatusPill.textContent = `SQL Server: ${db.database}`;
    dbStatusPill.className = 'db-pill ok';
    dbStatusPill.title = `Đã kết nối ${db.host}:${db.port}/${db.database}`;
  } else {
    dbStatusPill.textContent = 'SQL Server: Mất kết nối';
    dbStatusPill.className = 'db-pill danger';
    dbStatusPill.title = db.error || 'Chưa kết nối SQL Server';
  }
}

function getFilteredRegionGeojson(region) {
  const onlyPoly = polygonsOnlyToggle.checked;
  const rawFeatures = region.rawGeojson.features || [];
  const hasPoly = rawFeatures.some(isPolygonFeature);
  const features = rawFeatures
    .filter((f) => (!onlyPoly || !hasPoly ? true : isPolygonFeature(f)))
    .map((f) => ({
      ...f,
      properties: {
        ...(f.properties || {}),
        name: f.properties?.name || region.meta.name,
        wikidata: region.meta.qid || f.properties?.wikidata,
        stroke: region.color,
        fill: region.color,
      },
    }));
  return { type: 'FeatureCollection', features };
}

function serializeRegionForDb(region) {
  return {
    key: region.key,
    layerGroup: region.layerGroup || 'custom',
    color: region.color,
    areaKm2: region.areaKm2,
    points: region.points,
    modified: region.modified,
    meta: region.meta,
    geojson: region.rawGeojson,
    originalGeojson: region.originalGeojson,
  };
}

function isRegionLayerEnabled(region) {
  if (!region.visible) return false;
  if (region.layerGroup === 'ward_2025' && !showWardsLayerToggle.checked) return false;
  if (region.layerGroup === 'district_old' && !showOldDistrictsLayerToggle.checked) return false;
  return true;
}

// --- Map Rendering ---
function removeRegionLayers(region) {
  if (region.layer) {
    map.removeLayer(region.layer);
    region.layer = null;
  }
  if (region.labelMarker) {
    map.removeLayer(region.labelMarker);
    region.labelMarker = null;
  }
}

function buildRegionCardHtml(region, featureProps = {}) {
  const name = featureProps.name || region.meta.name;
  const isOldDistrict = region.layerGroup === 'district_old';

  if (isOldDistrict) {
    const areaVal =
      region.areaKm2 > 0 ? `${region.areaKm2.toLocaleString('vi-VN', { maximumFractionDigits: 2 })} km²` : '—';
    const oldProv = featureProps.oldProvince
      ? `<div>- Tỉnh trước sáp nhập: ${escapeHtml(featureProps.oldProvince)}</div>`
      : '';
    const code = featureProps.shapeID ? `<div>- Mã địa giới: ${escapeHtml(featureProps.shapeID)}</div>` : '';
    return `<div class="ward-info-card">
      <div class="ward-info-title">${escapeHtml(name)}</div>
      ${oldProv}
      <div>- Diện tích: ${escapeHtml(areaVal)}</div>
      ${code}
    </div>`;
  }

  const areaNum = Number(featureProps.area_official_km2) || region.areaKm2 || 0;
  const areaText = areaNum > 0 ? `${areaNum.toLocaleString('vi-VN', { maximumFractionDigits: 2 })} km²` : '—';
  const popNum = Number(featureProps.population_2025) || 0;
  const popRow = popNum > 0 ? `<div>- Dân số: ${popNum.toLocaleString('vi-VN')}</div>` : '';
  const codeVal = featureProps.ward_code || (region.meta.qid ? String(region.meta.qid).replace(/^VN-/, '') : '');
  const codeRow = codeVal ? `<div>- Mã hành chính: ${escapeHtml(codeVal)}</div>` : '';
  const oldDistVal = region.oldDistrict || featureProps.old_district || '';
  const oldDistRow = oldDistVal ? `<div>- Thuộc huyện cũ: ${escapeHtml(oldDistVal)}</div>` : '';
  const servingBcvh = bcvhOffices.filter((o) => (o.wardRegionIds || []).includes(region.dbId));
  const bcvhRow = servingBcvh.length
    ? `<div>- BCVH phục vụ: <strong>${escapeHtml(servingBcvh.map((o) => o.name).join(', '))}</strong></div>`
    : '';

  return `<div class="ward-info-card">
    <div class="ward-info-title">${escapeHtml(name)}</div>
    <div>- Diện tích: ${escapeHtml(areaText)}</div>
    ${popRow}
    ${codeRow}
    ${oldDistRow}
    ${bcvhRow}
  </div>`;
}

async function copyTextToClipboard(text) {
  if (navigator.clipboard && window.isSecureContext) {
    await navigator.clipboard.writeText(text);
    return;
  }
  // Fallback for non-HTTPS LAN access where navigator.clipboard is unavailable
  const ta = document.createElement('textarea');
  ta.value = text;
  ta.style.position = 'fixed';
  ta.style.opacity = '0';
  document.body.appendChild(ta);
  ta.select();
  const ok = document.execCommand('copy');
  ta.remove();
  if (!ok) throw new Error('Trình duyệt từ chối quyền copy.');
}

let singleClickPopupTimer = null;
let copyToastEl = null;
let copyToastTimer = null;

function showMapCopyToast(message, isError = false) {
  if (!copyToastEl) {
    copyToastEl = document.createElement('div');
    copyToastEl.className = 'map-copy-toast';
    document.querySelector('.map-panel')?.appendChild(copyToastEl);
  }
  copyToastEl.textContent = message;
  copyToastEl.className = `map-copy-toast visible${isError ? ' error' : ''}`;
  clearTimeout(copyToastTimer);
  copyToastTimer = setTimeout(() => {
    copyToastEl.classList.remove('visible');
  }, 2200);
}

function areWardsVisible() {
  return showWardsLayerToggle.checked && regions.some((r) => r.layerGroup === 'ward_2025' && r.visible);
}

function getEffectiveRegionColor(region) {
  if (region.layerGroup === 'district_old' && !areWardsVisible() && !region.customColor) {
    return region.distinctColor || region.color;
  }
  return region.color;
}

function getRegionStyle(region) {
  const fillOpacity = Number(opacityRange.value);
  const isSelected = region.id === selectedRegionId;
  const isOldDistrict = region.layerGroup === 'district_old';
  const wardsAlsoShown = areWardsVisible();
  const activeColor = getEffectiveRegionColor(region);

  // When focusing a specific BCVH, highlight its served wards and dim others
  if (!isOldDistrict && activeBcvhId !== null) {
    const activeOffice = bcvhOffices.find((o) => o.id === activeBcvhId);
    if (activeOffice) {
      const isServed = (activeOffice.wardRegionIds || []).includes(region.dbId);
      const isHost = activeOffice.hostRegionId && region.dbId === activeOffice.hostRegionId;
      if (isServed) {
        return {
          color: isHost ? '#0f172a' : activeOffice.color,
          weight: isHost ? 3.4 : isSelected ? 3 : 2,
          opacity: 0.98,
          fillColor: activeOffice.color,
          fillOpacity: Math.max(isHost ? 0.5 : 0.34, fillOpacity),
        };
      }
      return {
        color: '#94a3b8',
        weight: 0.8,
        opacity: 0.3,
        fillColor: '#cbd5e1',
        fillOpacity: 0.06,
      };
    }
  }

  return isOldDistrict
    ? {
        color: activeColor,
        weight: isSelected ? 4 : wardsAlsoShown ? 2.6 : 2.2,
        dashArray: wardsAlsoShown ? '7, 5' : undefined,
        opacity: 0.95,
        fillColor: activeColor,
        fillOpacity: wardsAlsoShown ? 0.04 : fillOpacity,
      }
    : {
        color: activeColor,
        weight: isSelected ? 3.2 : 1.5,
        opacity: 0.9,
        fillColor: activeColor,
        fillOpacity,
      };
}

function updateRegionStyle(region) {
  if (region?.layer && typeof region.layer.setStyle === 'function') {
    region.layer.setStyle(getRegionStyle(region));
  }
}

async function copyRegionGeojson(region) {
  const data = getFilteredRegionGeojson(region);
  const text = prettyToggle.checked ? JSON.stringify(data, null, 2) : JSON.stringify(data);
  const sizeKb = (new Blob([text]).size / 1024).toFixed(1);
  try {
    await copyTextToClipboard(text);
    const msg = `Đã copy GeoJSON "${region.meta.name}" (${sizeKb} KB) ✓`;
    setStatus(msg, 'success');
    showMapCopyToast(msg, false);
    // Brief visual flash on the copied polygon
    if (region.layer && typeof region.layer.setStyle === 'function') {
      region.layer.setStyle({ weight: 4.5, color: '#ffffff', fillOpacity: 0.65 });
      setTimeout(() => updateRegionStyle(region), 320);
    }
  } catch {
    const errMsg = 'Không thể copy tự động, hãy dùng nút Copy hoặc tải file bên phải.';
    setStatus(errMsg, 'error');
    showMapCopyToast(errMsg, true);
  }
}

function renderRegionOnMap(region) {
  removeRegionLayers(region);
  if (!isRegionLayerEnabled(region)) return;

  const fc = getFilteredRegionGeojson(region);
  if (fc.features.length === 0) return;

  const isOldDistrict = region.layerGroup === 'district_old';
  const wardsAlsoShown = showWardsLayerToggle.checked && regions.some((r) => r.layerGroup === 'ward_2025' && r.visible);

  region.layer = L.geoJSON(fc, {
    ...(isOldDistrict ? { pane: 'districtPane' } : {}),
    interactive: !(isOldDistrict && wardsAlsoShown),
    style: () => getRegionStyle(region),
    pointToLayer: (_f, latlng) =>
      L.circleMarker(latlng, { radius: 6, color: region.color, weight: 2, fillColor: '#ffffff', fillOpacity: 1 }),
    onEachFeature: (feature, layer) => {
      const cardHtml = buildRegionCardHtml(region, feature.properties || {});
      layer.bindTooltip(cardHtml, {
        sticky: true,
        direction: 'top',
        offset: [0, -10],
        opacity: 1,
        className: 'ward-hover-tooltip',
      });

      layer.on('mouseover', () => {
        if (typeof layer.setStyle === 'function') {
          const fillOpacity = Number(opacityRange.value);
          layer.setStyle({
            weight: isOldDistrict ? 4 : 2.8,
            fillOpacity: Math.min(0.85, fillOpacity + 0.22),
          });
        }
      });
      layer.on('mouseout', () => {
        if (typeof layer.setStyle === 'function') layer.setStyle(getRegionStyle(region));
      });
      layer.on('click', (e) => {
        L.DomEvent.stopPropagation(e);
        selectRegion(region.id);
        clearTimeout(singleClickPopupTimer);
        const latlng = e.latlng;
        singleClickPopupTimer = setTimeout(() => {
          L.popup({ className: 'ward-click-popup' }).setLatLng(latlng).setContent(cardHtml).openOn(map);
        }, 230);
      });
      layer.on('dblclick', (e) => {
        L.DomEvent.stop(e);
        clearTimeout(singleClickPopupTimer);
        map.closePopup();
        selectRegion(region.id);
        copyRegionGeojson(region);
      });
    },
  }).addTo(map);

  if (showLabelsToggle.checked) {
    const bounds = region.layer.getBounds();
    if (bounds.isValid()) {
      region.labelMarker = L.tooltip({
        permanent: true,
        direction: 'center',
        className: 'region-label-tooltip',
        interactive: false,
      })
        .setLatLng(bounds.getCenter())
        .setContent(
          `<span style="display:inline-flex;align-items:center;gap:5px"><span style="width:8px;height:8px;border-radius:50%;background:${escapeHtml(
            region.color,
          )};display:inline-block"></span>${escapeHtml(region.meta.name)}</span>`,
        )
        .addTo(map);
    }
  }
}

function fitAllVisibleBounds() {
  const group = L.featureGroup(regions.filter((r) => isRegionLayerEnabled(r) && r.layer).map((r) => r.layer));
  const bounds = group.getBounds();
  if (bounds.isValid()) map.fitBounds(bounds, { padding: [36, 36], maxZoom: 15 });
}

function zoomToRegion(regionId) {
  const r = regions.find((x) => x.id === regionId);
  if (!r || !r.layer) return;
  const bounds = r.layer.getBounds();
  if (bounds.isValid()) map.fitBounds(bounds, { padding: [36, 36], maxZoom: 15 });
}

function renderAllMapLayers() {
  for (const r of regions) renderRegionOnMap(r);
  renderBcvhMarkers();
  updateToolbarStats();
}

// --- BCVH (Bưu cục Vận hành) Truck Markers & Cluster Focus ---
const TRUCK_SVG = `<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true">
  <path d="M1 3h13v11H1z"></path>
  <path d="M14 8h4l3 3v3h-7V8z"></path>
  <circle cx="5.5" cy="17.5" r="2.2"></circle>
  <circle cx="17.5" cy="17.5" r="2.2"></circle>
</svg>`;

function resolveBcvhPosition(office) {
  if (Number.isFinite(office.lat) && Number.isFinite(office.lng)) {
    return { latlng: L.latLng(office.lat, office.lng), source: 'coords' };
  }
  if (office.hostRegionId) {
    const hostReg = regions.find((r) => r.dbId === office.hostRegionId);
    if (hostReg?.bbox) {
      const [minLng, minLat, maxLng, maxLat] = hostReg.bbox;
      return { latlng: L.latLng((minLat + maxLat) / 2, (minLng + maxLng) / 2), source: 'host_ward' };
    }
  }
  const servedRegs = regions.filter((r) => (office.wardRegionIds || []).includes(r.dbId) && r.bbox);
  if (servedRegs.length > 0) {
    let minLng = Infinity;
    let minLat = Infinity;
    let maxLng = -Infinity;
    let maxLat = -Infinity;
    for (const r of servedRegs) {
      if (r.bbox[0] < minLng) minLng = r.bbox[0];
      if (r.bbox[1] < minLat) minLat = r.bbox[1];
      if (r.bbox[2] > maxLng) maxLng = r.bbox[2];
      if (r.bbox[3] > maxLat) maxLat = r.bbox[3];
    }
    if (Number.isFinite(minLng)) {
      return { latlng: L.latLng((minLat + maxLat) / 2, (minLng + maxLng) / 2), source: 'cluster' };
    }
  }
  return null;
}

function buildBcvhCardHtml(office, pos) {
  const codeTag = office.code ? ` (${escapeHtml(office.code)})` : '';
  const hostLine = office.hostWardName
    ? `<div>- Đặt tại xã: <strong>${escapeHtml(office.hostWardName)}</strong></div>`
    : '';
  const coordLine =
    pos?.latlng
      ? `<div>- Tọa độ: ${pos.latlng.lat.toFixed(5)}, ${pos.latlng.lng.toFixed(5)}${
          pos.source === 'coords' ? '' : ' (tâm xã)'
        }</div>`
      : '';
  const addrLine = office.address ? `<div>- Địa chỉ: ${escapeHtml(office.address)}</div>` : '';
  const areaText = office.totalAreaKm2
    ? ` · ~${office.totalAreaKm2.toLocaleString('vi-VN', { maximumFractionDigits: 1 })} km²`
    : '';
  const popText = office.totalPop2025 ? ` · ${office.totalPop2025.toLocaleString('vi-VN')} dân` : '';
  const wardsPreview =
    office.wardNames?.length > 0
      ? `<div style="margin-top:4px;font-size:11.5px;color:#475569;max-width:260px;white-space:normal;line-height:1.4"><strong>Các xã phục vụ:</strong> ${escapeHtml(
          office.wardNames.join(', '),
        )}</div>`
      : '';

  return `<div class="ward-info-card">
    <div class="ward-info-title">🚚 ${escapeHtml(office.name)}${codeTag}</div>
    ${hostLine}
    ${coordLine}
    ${addrLine}
    <div>- Phục vụ: <strong>${(office.wardUnitIds || []).length} xã/phường</strong>${areaText}${popText}</div>
    ${wardsPreview}
  </div>`;
}

function focusBcvhOffice(officeId) {
  activeBcvhId = activeBcvhId === officeId ? null : officeId;
  if (clearBcvhFocusBtn) clearBcvhFocusBtn.hidden = activeBcvhId === null;

  for (const r of regions) updateRegionStyle(r);
  renderBcvhMarkers();
  renderBcvhList();

  if (activeBcvhId !== null) {
    const office = bcvhOffices.find((o) => o.id === activeBcvhId);
    if (office) {
      if (showBcvhLayerToggle && !showBcvhLayerToggle.checked) {
        showBcvhLayerToggle.checked = true;
        renderBcvhMarkers();
      }
      const bounds = L.latLngBounds([]);
      if (office._zoneLayer) {
        const zb = office._zoneLayer.getBounds();
        if (zb.isValid()) bounds.extend(zb);
      }
      for (const r of regions) {
        if ((office.wardRegionIds || []).includes(r.dbId) && r.layer) {
          const b = r.layer.getBounds();
          if (b.isValid()) bounds.extend(b);
        }
      }
      const pos = resolveBcvhPosition(office);
      if (pos?.latlng) bounds.extend(pos.latlng);
      if (bounds.isValid()) map.fitBounds(bounds, { padding: [44, 44], maxZoom: 13 });
      setStatus(`Đang xem vùng phục vụ của "${office.name}" (${office.wardUnitIds.length} xã).`, 'success');
    }
  } else {
    setStatus('');
  }
}

function assignDistinctBcvhColors(offices) {
  const used = new Set();
  let cursor = 0;
  for (const o of offices) {
    const base = String(o.color || '').toLowerCase();
    if (base && !used.has(base)) {
      o.distinctColor = o.color;
      used.add(base);
    } else {
      let picked = DISTRICT_DISTINCT_PALETTE[cursor % DISTRICT_DISTINCT_PALETTE.length];
      while (used.has(picked.toLowerCase()) && cursor < DISTRICT_DISTINCT_PALETTE.length * 2) {
        cursor++;
        picked = DISTRICT_DISTINCT_PALETTE[cursor % DISTRICT_DISTINCT_PALETTE.length];
      }
      cursor++;
      o.distinctColor = picked;
      used.add(picked.toLowerCase());
    }
  }
}

function getEffectiveBcvhColor(office) {
  if (!areWardsVisible()) return office.distinctColor || office.color || '#ea580c';
  return office.color || office.distinctColor || '#ea580c';
}

function getBcvhZoneStyle(office) {
  const fillOpacity = Number(opacityRange.value);
  const wardsAlsoShown = areWardsVisible();
  const isActive = activeBcvhId === office.id;
  const activeColor = getEffectiveBcvhColor(office);

  if (wardsAlsoShown) {
    return {
      color: activeColor,
      weight: isActive ? 4 : 2.8,
      dashArray: '8, 5',
      opacity: 0.95,
      fillColor: activeColor,
      fillOpacity: isActive ? 0.14 : 0.05,
    };
  }

  // Viewed solo (same behavior as Huyện/TP cũ): solid distinct non-clashing fill
  const dimmed = activeBcvhId !== null && !isActive;
  return {
    color: dimmed ? '#94a3b8' : activeColor,
    weight: isActive ? 4 : dimmed ? 1 : 2.3,
    dashArray: undefined,
    opacity: dimmed ? 0.35 : 0.95,
    fillColor: dimmed ? '#cbd5e1' : activeColor,
    fillOpacity: dimmed ? 0.08 : isActive ? Math.max(0.42, fillOpacity) : fillOpacity,
  };
}

async function copyBcvhServiceGeojson(office) {
  if (!office?.serviceGeojson) {
    showMapCopyToast(`"${office?.name || 'BCVH'}" chưa có GeoJSON vùng phục vụ.`, true);
    return;
  }
  const text = prettyToggle.checked ? JSON.stringify(office.serviceGeojson, null, 2) : JSON.stringify(office.serviceGeojson);
  const sizeKb = (new Blob([text]).size / 1024).toFixed(1);
  try {
    await copyTextToClipboard(text);
    const msg = `Đã copy GeoJSON vùng phục vụ "${office.name}" (${sizeKb} KB) ✓`;
    setStatus(msg, 'success');
    showMapCopyToast(msg, false);
  } catch {
    showMapCopyToast('Không thể copy tự động.', true);
  }
}

function renderBcvhMarkers() {
  bcvhZoneLayerGroup.clearLayers();
  bcvhLayerGroup.clearLayers();
  if (showBcvhLayerToggle && !showBcvhLayerToggle.checked) return;

  const wardsAlsoShown = areWardsVisible();

  for (const office of bcvhOffices) {
    const pos = resolveBcvhPosition(office);
    const cardHtml = buildBcvhCardHtml(office, pos);
    const activeColor = getEffectiveBcvhColor(office);

    // 1. Render dissolved BCVH service-area polygon (colored just like Huyện cũ!)
    if (office.serviceGeojson) {
      const zoneLayer = L.geoJSON(office.serviceGeojson, {
        pane: 'bcvhZonePane',
        interactive: !wardsAlsoShown,
        style: () => getBcvhZoneStyle(office),
        onEachFeature: (_f, lyr) => {
          if (wardsAlsoShown) return;
          lyr.bindTooltip(cardHtml, {
            sticky: true,
            direction: 'top',
            offset: [0, -10],
            opacity: 1,
            className: 'ward-hover-tooltip',
          });
          lyr.on('click', () => {
            clearTimeout(singleClickPopupTimer);
            singleClickPopupTimer = setTimeout(() => focusBcvhOffice(office.id), 210);
          });
          lyr.on('dblclick', (e) => {
            clearTimeout(singleClickPopupTimer);
            L.DomEvent.stop(e);
            copyBcvhServiceGeojson(office);
          });
        },
      }).addTo(bcvhZoneLayerGroup);
      office._zoneLayer = zoneLayer;
    } else {
      office._zoneLayer = null;
    }

    // 2. Render Truck Pin Marker at BCVH host location / exact lat-lng
    if (!pos?.latlng) continue;

    const isActive = activeBcvhId === office.id;
    const icon = L.divIcon({
      className: 'bcvh-truck-marker',
      html: `<div class="bcvh-truck-wrap${isActive ? ' active' : ''}">
        <div class="bcvh-truck-pin" style="background:${escapeHtml(activeColor)}">${TRUCK_SVG}</div>
        <div class="bcvh-truck-label">${escapeHtml(office.name)}</div>
      </div>`,
      iconSize: [0, 0],
      iconAnchor: [0, 0],
    });

    const marker = L.marker(pos.latlng, {
      pane: 'bcvhPane',
      icon,
      zIndexOffset: isActive ? 500 : 100,
    }).addTo(bcvhLayerGroup);

    marker.bindTooltip(cardHtml, {
      direction: 'top',
      offset: [0, -34],
      opacity: 1,
      className: 'ward-hover-tooltip',
    });
    marker.on('click', () => focusBcvhOffice(office.id));
  }
}

function renderBcvhList() {
  if (!bcvhListEl || !bcvhCount || !bcvhListEmpty) return;
  bcvhCount.textContent = String(bcvhOffices.length);
  bcvhListEmpty.hidden = bcvhOffices.length > 0;
  if (clearBcvhFocusBtn) clearBcvhFocusBtn.hidden = activeBcvhId === null;

  bcvhListEl.innerHTML = '';
  const frag = document.createDocumentFragment();
  for (const office of bcvhOffices) {
    const item = document.createElement('div');
    item.className = `bcvh-item${activeBcvhId === office.id ? ' active' : ''}`;
    const hostInfo = office.hostWardName
      ? `Đặt tại: ${office.hostWardName}`
      : office.lat !== null && office.lng !== null
        ? `Tọa độ: ${office.lat.toFixed(4)}, ${office.lng.toFixed(4)}`
        : 'Chưa gắn vị trí';
    const areaVal = office.computedAreaKm2 || office.totalAreaKm2 || 0;
    const areaSuffix = areaVal > 0 ? ` · ~${areaVal.toLocaleString('vi-VN', { maximumFractionDigits: 1 })} km²` : '';
    const dotColor = getEffectiveBcvhColor(office);

    item.innerHTML = `
      <div class="bcvh-item-main">
        <div class="bcvh-item-title">
          <span class="color-dot" style="background:${escapeHtml(dotColor)}"></span>
          <span>🚚 ${escapeHtml(office.name)}</span>
          ${office.code ? `<span class="tag-layer-old">${escapeHtml(office.code)}</span>` : ''}
        </div>
        <div class="bcvh-item-meta">
          ${escapeHtml(hostInfo)} · <strong>${(office.wardUnitIds || []).length} xã</strong>${escapeHtml(areaSuffix)}
        </div>
      </div>
      <button type="button" class="btn small copy-bcvh-geo-btn" title="Copy GeoJSON vùng phục vụ đã gộp của BCVH này">Copy</button>
    `;
    const copyGeoBtn = item.querySelector('.copy-bcvh-geo-btn');
    copyGeoBtn.addEventListener('click', async (e) => {
      e.stopPropagation();
      await copyBcvhServiceGeojson(office);
      copyGeoBtn.textContent = 'Đã copy ✓';
      setTimeout(() => (copyGeoBtn.textContent = 'Copy'), 1500);
    });
    item.addEventListener('click', () => focusBcvhOffice(office.id));
    frag.appendChild(item);
  }
  bcvhListEl.appendChild(frag);
}

function updateToolbarStats() {
  const visible = regions.filter((r) => isRegionLayerEnabled(r));
  const wardsCount = regions.filter((r) => r.layerGroup === 'ward_2025').length;
  const oldCount = regions.filter((r) => r.layerGroup === 'district_old').length;
  statRegions.textContent =
    wardsCount && oldCount
      ? `${visible.length}/${regions.length} vùng (${wardsCount} xã · ${oldCount} huyện cũ)`
      : `${visible.length}/${regions.length} khu vực`;
  fitBoundsBtn.disabled = visible.length === 0;
}

const EYE_OPEN_SVG = `<svg viewBox="0 0 24 24" width="15" height="15" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true">
  <path d="M1 12s4-7 11-7 11 7 11 7-4 7-11 7S1 12 1 12z"></path>
  <circle cx="12" cy="12" r="3"></circle>
</svg>`;

const EYE_OFF_SVG = `<svg viewBox="0 0 24 24" width="15" height="15" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true">
  <path d="M17.94 17.94A10.94 10.94 0 0 1 12 19c-7 0-11-7-11-7a21.77 21.77 0 0 1 5.06-5.94"></path>
  <path d="M9.9 4.24A9.12 9.12 0 0 1 12 4c7 0 11 7 11 7a21.78 21.78 0 0 1-2.16 3.19"></path>
  <line x1="1" y1="1" x2="23" y2="23"></line>
</svg>`;

const LOCATE_SVG = `<svg viewBox="0 0 24 24" width="15" height="15" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true">
  <circle cx="12" cy="12" r="7"></circle>
  <circle cx="12" cy="12" r="2"></circle>
  <line x1="12" y1="2" x2="12" y2="5"></line>
  <line x1="12" y1="19" x2="12" y2="22"></line>
  <line x1="2" y1="12" x2="5" y2="12"></line>
  <line x1="19" y1="12" x2="22" y2="12"></line>
</svg>`;

// --- Sidebar Rendering ---
function renderRegionList() {
  const q = (regionSearchInput?.value || '').trim().toLowerCase();
  const layerFilter = regionLayerFilter?.value || 'all';
  const filtered = regions.filter((r) => {
    if (layerFilter !== 'all' && r.layerGroup !== layerFilter) return false;
    if (q && !`${r.meta.name} ${r.meta.description || ''} ${r.meta.qid || ''}`.toLowerCase().includes(q)) return false;
    return true;
  });

  regionCount.textContent = `${filtered.length}/${regions.length}`;
  regionListEmpty.hidden = filtered.length > 0;
  regionList.innerHTML = '';

  filtered.forEach((r) => {
    const item = document.createElement('div');
    item.className = `region-item${r.id === selectedRegionId ? ' selected' : ''}${r.visible ? '' : ' hidden-region'}`;
    item.addEventListener('click', (e) => {
      if (e.target.closest('input, button')) return;
      selectRegion(r.id);
    });

    const colorInput = document.createElement('input');
    colorInput.type = 'color';
    colorInput.className = 'region-color-input';
    colorInput.value = getEffectiveRegionColor(r);
    colorInput.title = 'Đổi màu hiển thị tạm thời';
    colorInput.addEventListener('input', () => {
      r.color = colorInput.value;
      r.customColor = true;
      renderRegionOnMap(r);
      renderRegionList();
      updateJsonOutput();
    });

    const groupTag = r.layerGroup === 'district_old' ? '<span class="tag-layer-old">Huyện cũ</span>' : '';

    const info = document.createElement('div');
    info.className = 'region-info';
    info.innerHTML = `
      <div class="region-title" title="${escapeHtml(r.meta.name)}">${escapeHtml(r.meta.name)}</div>
      <div class="region-sub">
        <span>${r.areaKm2 > 0 ? `~${formatArea(r.areaKm2 * 1e6)}` : '—'}</span>
        ${groupTag}
      </div>
    `;

    const actions = document.createElement('div');
    actions.className = 'region-actions';

    const eyeBtn = document.createElement('button');
    eyeBtn.type = 'button';
    eyeBtn.className = `mini-btn eye-btn${r.visible ? ' is-visible' : ' is-hidden'}`;
    eyeBtn.title = r.visible ? 'Đang hiển thị — bấm để ẩn' : 'Đang ẩn — bấm để hiện';
    eyeBtn.setAttribute('aria-pressed', String(r.visible));
    eyeBtn.innerHTML = r.visible ? EYE_OPEN_SVG : EYE_OFF_SVG;
    eyeBtn.addEventListener('click', () => {
      r.visible = !r.visible;
      renderRegionOnMap(r);
      updateToolbarStats();
      renderRegionList();
      updateJsonOutput();
    });

    const zoomBtn = document.createElement('button');
    zoomBtn.type = 'button';
    zoomBtn.className = 'mini-btn locate-btn';
    zoomBtn.title = 'Định vị & phóng tới khu vực này';
    zoomBtn.innerHTML = LOCATE_SVG;
    zoomBtn.addEventListener('click', () => {
      if (!r.visible) {
        r.visible = true;
        renderRegionOnMap(r);
        updateToolbarStats();
        renderRegionList();
      }
      selectRegion(r.id);
      zoomToRegion(r.id);
    });

    actions.append(eyeBtn, zoomBtn);
    item.append(colorInput, info, actions);
    regionList.appendChild(item);
  });
}

function renderSelectedMeta() {
  const r = regions.find((x) => x.id === selectedRegionId);
  if (!r) {
    metaCard.hidden = true;
    return;
  }
  metaCard.hidden = false;
  const m = r.meta;
  sourceBadge.textContent = m.source || 'GeoJSON';
  metaName.textContent = m.name || '—';

  if (m.description) {
    metaDescRow.hidden = false;
    metaDesc.textContent = m.description;
  } else {
    metaDescRow.hidden = true;
  }

  const ids = [];
  if (m.qid) ids.push(escapeHtml(m.qid));
  if (r.dbId) ids.push(`DB #${r.dbId}`);
  metaIds.innerHTML = ids.length ? ids.join(' · ') : '—';
  metaMetrics.textContent = `${r.areaKm2 > 0 ? `~${formatArea(r.areaKm2 * 1e6)}` : '—'} · ${r.points.toLocaleString('vi-VN')} điểm`;

  const links = [];
  if (m.directGeoshapeUrl) {
    links.push(`<a class="meta-link" href="${escapeHtml(m.directGeoshapeUrl)}" target="_blank" rel="noopener">Link GeoJSON ↗</a>`);
  } else if (r.dbId) {
    links.push(`<a class="meta-link" href="/api/regions/${encodeURIComponent(r.dbId)}/geojson" target="_blank" rel="noopener">Link GeoJSON ↗</a>`);
  }
  metaLinks.innerHTML = links.join('');

  if (m.trace?.length) {
    traceBox.hidden = false;
    traceList.innerHTML = m.trace.map((t) => `<li>${escapeHtml(t)}</li>`).join('');
  } else {
    traceBox.hidden = true;
  }
}

function selectRegion(regionId) {
  const prev = regions.find((r) => r.id === selectedRegionId);
  selectedRegionId = regionId;
  const curr = regions.find((r) => r.id === selectedRegionId);
  // Update styles in place instead of removing/recreating SVG paths so native dblclick fires reliably
  if (prev) updateRegionStyle(prev);
  if (curr) updateRegionStyle(curr);
  renderRegionList();
  renderSelectedMeta();
  updateJsonOutput();
}

// --- Export ---
function getExportGeojson() {
  if (exportMode === 'selected') {
    const r = regions.find((x) => x.id === selectedRegionId);
    return r ? getFilteredRegionGeojson(r) : null;
  }
  const visible = regions.filter((r) => isRegionLayerEnabled(r));
  if (visible.length === 0) return null;
  return {
    type: 'FeatureCollection',
    features: visible.flatMap((r) => getFilteredRegionGeojson(r).features),
  };
}

function updateJsonOutput() {
  const data = getExportGeojson();
  if (!data || !data.features?.length) {
    copyBtn.disabled = true;
    downloadGeojsonBtn.disabled = true;
    downloadJsonBtn.disabled = true;
    jsonNote.hidden = true;
    jsonPreview.textContent = '// Chưa có dữ liệu GeoJSON.';
    return;
  }
  copyBtn.disabled = false;
  downloadGeojsonBtn.disabled = false;
  downloadJsonBtn.disabled = false;

  const serialized = prettyToggle.checked ? JSON.stringify(data, null, 2) : JSON.stringify(data);
  const sizeKb = (new Blob([serialized]).size / 1024).toFixed(1);
  if (serialized.length > MAX_PREVIEW_CHARS) {
    jsonNote.hidden = false;
    jsonNote.textContent = `GeoJSON (${data.features.length} feature, ${sizeKb} KB). Đang hiển thị trước ${MAX_PREVIEW_CHARS.toLocaleString('vi-VN')} ký tự — bấm Copy hoặc Tải file để lấy đầy đủ.`;
    jsonPreview.textContent = `${serialized.slice(0, MAX_PREVIEW_CHARS)}\n... [đã rút gọn hiển thị]`;
  } else {
    jsonNote.hidden = true;
    jsonPreview.textContent = serialized;
  }
}

// --- Database Operations ---
function createRegionStateFromDto(dto) {
  const stats = computeGeoStats(dto.geojson);
  return {
    id: `db_${dto.id}`,
    dbId: dto.id,
    key: dto.key,
    layerGroup: dto.layerGroup || 'ward_2025',
    oldDistrict: dto.oldDistrict || '',
    oldProvince: dto.oldProvince || '',
    color: dto.color || nextColor(),
    visible: true,
    meta: dto.meta,
    rawGeojson: dto.geojson,
    originalGeojson: dto.originalGeojson || structuredClone(dto.geojson),
    modified: Boolean(dto.modified),
    unsaved: false,
    layer: null,
    labelMarker: null,
    areaKm2: stats.areaKm2,
    points: stats.points,
    bbox: stats.bbox,
  };
}

async function loadFromDatabase({ fitAfter = true } = {}) {
  try {
    const [res, bcvhRes] = await Promise.all([
      fetchSavedRegions(),
      fetchBcvhOffices().catch(() => ({ offices: [] })),
    ]);
    updateDbPill(res.db);
    regions.forEach(removeRegionLayers);
    regions = (res.regions || []).map(createRegionStateFromDto);
    assignDistinctOldDistrictColors(regions);
    bcvhOffices = bcvhRes.offices || [];
    assignDistinctBcvhColors(bcvhOffices);
    if (activeBcvhId && !bcvhOffices.some((o) => o.id === activeBcvhId)) {
      activeBcvhId = null;
    }
    selectedRegionId = regions[regions.length - 1]?.id || null;
    renderAllMapLayers();
    renderBcvhList();
    renderRegionList();
    renderSelectedMeta();
    updateJsonOutput();
    if (fitAfter && regions.length > 0) fitAllVisibleBounds();
    return regions.length;
  } catch (err) {
    updateDbPill(err.data?.db || { connected: false, error: err.message });
    setStatus(`Không tải được từ SQL Server: ${err.message}`, 'warn');
    return -1;
  }
}

// --- Events ---
reloadDbBtn.addEventListener('click', async () => {
  const count = await loadFromDatabase({ fitAfter: true });
  if (count >= 0) setStatus(`Đã tải ${count} khu vực từ SQL Server.`, 'success');
});

fitBoundsBtn.addEventListener('click', fitAllVisibleBounds);

opacityRange.addEventListener('input', () => {
  for (const r of regions) updateRegionStyle(r);
  for (const o of bcvhOffices) {
    if (o._zoneLayer && typeof o._zoneLayer.setStyle === 'function') {
      o._zoneLayer.setStyle(getBcvhZoneStyle(o));
    }
  }
});

showLabelsToggle.addEventListener('change', () => regions.forEach(renderRegionOnMap));
showWardsLayerToggle.addEventListener('change', () => {
  renderAllMapLayers();
  renderBcvhList();
  renderRegionList();
  updateJsonOutput();
});
showOldDistrictsLayerToggle.addEventListener('change', () => {
  renderAllMapLayers();
  renderBcvhList();
  renderRegionList();
  updateJsonOutput();
});
showBcvhLayerToggle?.addEventListener('change', () => {
  renderBcvhMarkers();
});
clearBcvhFocusBtn?.addEventListener('click', () => {
  if (activeBcvhId !== null) focusBcvhOffice(activeBcvhId);
});
regionSearchInput?.addEventListener('input', renderRegionList);
regionLayerFilter?.addEventListener('change', renderRegionList);
polygonsOnlyToggle.addEventListener('change', () => {
  renderAllMapLayers();
  updateJsonOutput();
});

exportTabBtns.forEach((btn) => {
  btn.addEventListener('click', () => {
    exportTabBtns.forEach((b) => b.classList.remove('active'));
    btn.classList.add('active');
    exportMode = btn.dataset.exportMode;
    updateJsonOutput();
  });
});

prettyToggle.addEventListener('change', updateJsonOutput);

copyBtn.addEventListener('click', async () => {
  const data = getExportGeojson();
  if (!data) return;
  const text = prettyToggle.checked ? JSON.stringify(data, null, 2) : JSON.stringify(data);
  try {
    await copyTextToClipboard(text);
    const old = copyBtn.textContent;
    copyBtn.textContent = 'Đã copy ✓';
    setTimeout(() => (copyBtn.textContent = old), 1500);
  } catch {
    setStatus('Không thể copy tự động, vui lòng dùng nút tải file.', 'error');
  }
});

function downloadFile(ext) {
  const data = getExportGeojson();
  if (!data) return;
  const text = prettyToggle.checked ? JSON.stringify(data, null, 2) : JSON.stringify(data);
  const blob = new Blob([text], { type: 'application/geo+json;charset=utf-8' });
  let filename = `regions-merged-${regions.filter((r) => isRegionLayerEnabled(r)).length}.${ext}`;
  if (exportMode === 'selected') {
    const r = regions.find((x) => x.id === selectedRegionId);
    filename = `${slugify(r?.meta?.name)}${r?.meta?.qid ? `-${r.meta.qid}` : ''}.${ext}`;
  }
  const a = document.createElement('a');
  a.href = URL.createObjectURL(blob);
  a.download = filename;
  document.body.appendChild(a);
  a.click();
  a.remove();
  URL.revokeObjectURL(a.href);
}

downloadGeojsonBtn.addEventListener('click', () => downloadFile('geojson'));
downloadJsonBtn.addEventListener('click', () => downloadFile('json'));

// --- Startup: load from SQL Server, optional ?region=<id> deep-link ---
(async () => {
  try {
    const health = await fetchHealth();
    updateDbPill(health.db);
  } catch {
    updateDbPill({ connected: false, error: 'Backend không phản hồi' });
  }

  const focusDbId = Number(new URLSearchParams(window.location.search).get('region')) || null;
  await loadFromDatabase({ fitAfter: !focusDbId });
  if (focusDbId) {
    const target = regions.find((r) => r.dbId === focusDbId);
    if (target) {
      selectRegion(target.id);
      zoomToRegion(target.id);
      setStatus(`Đang xem "${target.meta.name}" trên bản đồ.`, 'success');
    }
  }
})();
