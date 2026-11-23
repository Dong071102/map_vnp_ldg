async function requestJson(url, options = {}) {
  const resp = await fetch(url, {
    credentials: 'same-origin',
    headers: { 'Content-Type': 'application/json', ...(options.headers || {}) },
    ...options,
  });
  const data = await resp.json().catch(() => ({}));
  if (!resp.ok) {
    const err = new Error(data.error || `HTTP ${resp.status}`);
    err.status = resp.status;
    err.data = data;
    throw err;
  }
  return data;
}

export function fetchHealth() {
  return requestJson('/api/health');
}

export function fetchAuthMe() {
  return requestJson('/api/auth/me');
}

export function loginAdmin(username, password) {
  return requestJson('/api/auth/login', {
    method: 'POST',
    body: JSON.stringify({ username, password }),
  });
}

export function logoutAdmin() {
  return requestJson('/api/auth/logout', { method: 'POST' });
}

export function extractWikiRegion(url, source = 'auto') {
  const params = new URLSearchParams({ url, source });
  return requestJson(`/api/extract?${params.toString()}`);
}

export function fetchSavedRegions() {
  return requestJson('/api/regions');
}

export function saveRegionToDb(regionPayload) {
  return requestJson('/api/regions', {
    method: 'POST',
    body: JSON.stringify(regionPayload),
  });
}

export function saveRegionsBatchToDb(regionPayloads) {
  return requestJson('/api/regions/batch', {
    method: 'POST',
    body: JSON.stringify({ regions: regionPayloads }),
  });
}

export function deleteRegionFromDb(dbId) {
  return requestJson(`/api/regions/${encodeURIComponent(dbId)}`, {
    method: 'DELETE',
  });
}

export function deleteAllRegionsFromDb() {
  return requestJson('/api/regions', { method: 'DELETE' });
}

export function fetchLamDongUnits() {
  return requestJson('/api/admin/lamdong');
}

export function syncLamDongList({ source = 'wikipedia', overwriteLinks = false } = {}) {
  return requestJson('/api/admin/lamdong/sync-list', {
    method: 'POST',
    body: JSON.stringify({ source, overwriteLinks }),
  });
}

export function updateLamDongUnitLink(id, wikiUrl) {
  return requestJson(`/api/admin/lamdong/${encodeURIComponent(id)}`, {
    method: 'PATCH',
    body: JSON.stringify({ wikiUrl }),
  });
}

export function updateLamDongUnitFields(id, fields) {
  return requestJson(`/api/admin/lamdong/${encodeURIComponent(id)}`, {
    method: 'PATCH',
    body: JSON.stringify(fields),
  });
}

export function fetchOldDistricts() {
  return requestJson('/api/admin/old-districts');
}

export function saveRegionGeojson(regionId, geojson, neighborUpdates = []) {
  return requestJson(`/api/admin/regions/${encodeURIComponent(regionId)}/geojson`, {
    method: 'PUT',
    body: JSON.stringify({ geojson, neighborUpdates }),
  });
}

export function fetchAndSaveLamDongGeojson(id, { wikiUrl, source = 'auto' } = {}) {
  return requestJson(`/api/admin/lamdong/${encodeURIComponent(id)}/fetch-geojson`, {
    method: 'POST',
    body: JSON.stringify({ wikiUrl, source }),
  });
}

export function importLamDongOpenData() {
  return requestJson('/api/admin/lamdong/import-open-data', { method: 'POST' });
}

export function saveLamDongUnitGeojson(unitId, geojson, neighborUpdates = []) {
  return requestJson(`/api/admin/lamdong/${encodeURIComponent(unitId)}/geojson`, {
    method: 'PUT',
    body: JSON.stringify({ geojson, neighborUpdates }),
  });
}

export function fetchNeighborRegions(regionId, pad = 0.03) {
  return requestJson(`/api/regions/${encodeURIComponent(regionId)}/neighbors?pad=${encodeURIComponent(pad)}`);
}

export function fetchNeighborProvinces() {
  return requestJson('/api/map/lamdong/neighbor-provinces');
}

export function locateWardByCoords(lat, lng) {
  return requestJson(`/api/map/lamdong/locate-ward?lat=${encodeURIComponent(lat)}&lng=${encodeURIComponent(lng)}`);
}

export function fetchBcvhOffices() {
  return requestJson('/api/bcvh');
}

export function fetchAdminBcvhOffices() {
  return requestJson('/api/admin/bcvh');
}

export function createBcvhOffice(payload) {
  return requestJson('/api/admin/bcvh', {
    method: 'POST',
    body: JSON.stringify(payload),
  });
}

export function updateBcvhOffice(id, payload) {
  return requestJson(`/api/admin/bcvh/${encodeURIComponent(id)}`, {
    method: 'PUT',
    body: JSON.stringify(payload),
  });
}

export function deleteBcvhOffice(id) {
  return requestJson(`/api/admin/bcvh/${encodeURIComponent(id)}`, {
    method: 'DELETE',
  });
}

export function fetchAdminUsers() {
  return requestJson('/api/admin/users');
}

export function createAdminUser(payload) {
  return requestJson('/api/admin/users', {
    method: 'POST',
    body: JSON.stringify(payload),
  });
}

export function updateAdminUser(id, payload) {
  return requestJson(`/api/admin/users/${encodeURIComponent(id)}`, {
    method: 'PUT',
    body: JSON.stringify(payload),
  });
}

export function deleteAdminUser(id) {
  return requestJson(`/api/admin/users/${encodeURIComponent(id)}`, {
    method: 'DELETE',
  });
}

// --- Boundary Inward Negative Buffer (STBuffer(-d)) Helpers ---
const SHRINK_STORAGE_KEY = 'export_shrink_m';

export function getExportShrinkMeters() {
  try {
    const raw = localStorage.getItem(SHRINK_STORAGE_KEY);
    if (raw === null) return 2; // Default 2m inward per polygon (~4m clean gap between neighbors)
    const n = Number(raw);
    return Number.isFinite(n) && n >= 0 ? Math.min(100, n) : 2;
  } catch {
    return 2;
  }
}

export function setExportShrinkMeters(meters) {
  const clean = Number.isFinite(Number(meters)) && Number(meters) >= 0 ? Math.min(100, Number(meters)) : 0;
  try {
    localStorage.setItem(SHRINK_STORAGE_KEY, String(clean));
  } catch {
    // ignore storage errors
  }
  return clean;
}

export function appendShrinkParam(url, shrinkMeters = getExportShrinkMeters()) {
  const m = Number(shrinkMeters) || 0;
  if (!(m > 0)) return url;
  const sep = url.includes('?') ? '&' : '?';
  return `${url}${sep}shrinkM=${encodeURIComponent(m)}`;
}

export function shrinkGeojson(geojson, shrinkMeters = getExportShrinkMeters()) {
  const m = Number(shrinkMeters) || 0;
  if (!(m > 0)) {
    return Promise.resolve({ geojson, shrinkMeters: 0 });
  }
  return requestJson('/api/geometry/shrink', {
    method: 'POST',
    body: JSON.stringify({ geojson, shrinkMeters: m }),
  });
}
