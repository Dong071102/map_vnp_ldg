import http from 'node:http';
import fs from 'node:fs/promises';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { config } from './config.mjs';
import {
  verifyCredentials,
  createSession,
  getSessionFromRequest,
  destroySession,
  buildSessionCookieHeader,
} from './auth.mjs';
import {
  initDb,
  getDbStatus,
  listRegions,
  getRegionById,
  getRegionByKey,
  listNeighborRegions,
  listOldDistrictRegions,
  upsertRegion,
  upsertRegionsBatch,
  deleteRegion,
  deleteAllRegions,
  listLamDongUnits,
  getLamDongUnitById,
  getLamDongUnitByRegionId,
  seedLamDongUnits,
  updateLamDongUnitLink,
  updateLamDongUnitFields,
  markLamDongUnitSyncResult,
  backfillLamDongOldDistricts,
  replaceAllWithOpenData,
  listBcvhOffices,
  getBcvhOfficeById,
  findWardUnitByCoords,
  createBcvhOffice,
  updateBcvhOffice,
  deleteBcvhOffice,
  listWardStreetSummaries,
  getWardStreetsBundle,
  mergeWardStreetsByIds,
  closeDb,
} from './db.mjs';
import { extractRegion, normalizeToFeatureCollection, hasUsableGeometry } from './wikiExtractor.mjs';
import {
  LAMDONG_WIKI_PAGE_URL,
  loadLamDongUnitsFromLocalFile,
  fetchLamDongUnitsFromWikipedia,
} from './lamdongParser.mjs';
import { loadOpenDataBundle, normalizeAdminName } from './openDataImporter.mjs';
import { buildBcvhWorkbookBuffer, validateBcvhForExcelExport } from './bcvhExcel.mjs';
import { computeGeoStats } from '../../frontend/js/geometry.js';

const PALETTE = [
  '#2563eb', '#10b981', '#f59e0b', '#8b5cf6',
  '#06b6d4', '#ec4899', '#84cc16', '#f97316',
  '#6366f1', '#14b8a6', '#eab308', '#d946ef',
];

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);
const FRONTEND_DIR = path.resolve(__dirname, '..', '..', 'frontend');
const NEIGHBOR_PROVINCES_FILE = path.resolve(__dirname, '..', 'data', 'lamdong_neighbor_provinces.geojson');
let cachedNeighborProvincesJson = null;
const MAX_BODY_BYTES = 15 * 1024 * 1024; // 15 MB limit for large multi-region GeoJSON batches

const MIME_TYPES = {
  '.html': 'text/html; charset=utf-8',
  '.css': 'text/css; charset=utf-8',
  '.js': 'application/javascript; charset=utf-8',
  '.mjs': 'application/javascript; charset=utf-8',
  '.json': 'application/json; charset=utf-8',
  '.svg': 'image/svg+xml',
  '.png': 'image/png',
  '.ico': 'image/x-icon',
};

function sendXlsxDownload(res, buffer, unicodeFilename, asciiFilename) {
  res.writeHead(200, {
    'Content-Type': 'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet',
    'Content-Disposition': `attachment; filename="${asciiFilename}"; filename*=UTF-8''${encodeURIComponent(unicodeFilename)}`,
    'Content-Length': String(buffer.length),
    'Cache-Control': 'no-store',
  });
  res.end(buffer);
}

function toSafeSlug(str, fallback = 'bcvh') {
  const cleaned = String(str || '')
    .normalize('NFD')
    .replace(/[\u0300-\u036f]/g, '')
    .replace(/đ/g, 'd')
    .replace(/Đ/g, 'D')
    .replace(/[^a-zA-Z0-9]+/g, '_')
    .replace(/^_+|_+$/g, '');
  return cleaned || fallback;
}

function sendJson(res, statusCode, payload, extraHeaders = {}) {
  res.writeHead(statusCode, {
    'Content-Type': 'application/json; charset=utf-8',
    'Cache-Control': 'no-store',
    ...extraHeaders,
  });
  res.end(JSON.stringify(payload));
}

function requireAdmin(req, res) {
  const session = getSessionFromRequest(req);
  if (!session) {
    sendJson(res, 401, { error: 'Vui lòng đăng nhập tài khoản quản trị (/admin) để thực hiện thao tác này.' });
    return null;
  }
  return session;
}

function readJsonBody(req) {
  return new Promise((resolve, reject) => {
    let total = 0;
    const chunks = [];
    req.on('data', (chunk) => {
      total += chunk.length;
      if (total > MAX_BODY_BYTES) {
        req.destroy();
        const err = new Error('Dữ liệu gửi lên vượt quá giới hạn 15MB.');
        err.statusCode = 413;
        reject(err);
        return;
      }
      chunks.push(chunk);
    });
    req.on('end', () => {
      const raw = Buffer.concat(chunks).toString('utf8').trim();
      if (!raw) {
        resolve({});
        return;
      }
      try {
        resolve(JSON.parse(raw));
      } catch {
        const err = new Error('Request body không phải JSON hợp lệ.');
        err.statusCode = 400;
        reject(err);
      }
    });
    req.on('error', reject);
  });
}

async function serveStatic(res, pathname) {
  let relPath = pathname.replace(/^\/+/, '');
  if (pathname === '/') relPath = 'index.html';
  else if (pathname === '/admin' || pathname === '/admin/') relPath = 'admin.html';
  else if (pathname === '/streets' || pathname === '/streets/' || pathname === '/streets-demo' || pathname === '/streets-demo/') {
    relPath = 'streets-demo.html';
  }
  const fullPath = path.resolve(FRONTEND_DIR, relPath);

  if (fullPath !== FRONTEND_DIR && !fullPath.startsWith(FRONTEND_DIR + path.sep)) {
    res.writeHead(403, { 'Content-Type': 'text/plain; charset=utf-8' });
    res.end('Forbidden');
    return;
  }

  try {
    const content = await fs.readFile(fullPath);
    const ext = path.extname(fullPath).toLowerCase();
    res.writeHead(200, { 'Content-Type': MIME_TYPES[ext] || 'application/octet-stream' });
    res.end(content);
  } catch {
    res.writeHead(404, { 'Content-Type': 'text/plain; charset=utf-8' });
    res.end('Not Found');
  }
}

export function createAppServer() {
  return http.createServer(async (req, res) => {
    try {
      if (req.method === 'OPTIONS') {
        res.writeHead(204, {
          'Access-Control-Allow-Origin': '*',
          'Access-Control-Allow-Methods': 'GET, POST, PUT, PATCH, DELETE, OPTIONS',
          'Access-Control-Allow-Headers': 'Content-Type',
        });
        res.end();
        return;
      }

      const reqUrl = new URL(req.url, `http://${req.headers.host || 'localhost'}`);
      const { pathname } = reqUrl;

      if (pathname === '/api/health' && req.method === 'GET') {
        sendJson(res, 200, { ok: true, db: getDbStatus() });
        return;
      }

      // --- Admin Auth Endpoints ---
      if (pathname === '/api/auth/me' && req.method === 'GET') {
        const session = getSessionFromRequest(req);
        sendJson(res, 200, {
          authenticated: Boolean(session),
          username: session?.username || null,
        });
        return;
      }

      if (pathname === '/api/auth/login' && req.method === 'POST') {
        try {
          const body = await readJsonBody(req);
          const username = String(body.username || '').trim();
          const password = String(body.password || '');
          if (!verifyCredentials(username, password)) {
            sendJson(res, 401, { error: 'Sai tên đăng nhập hoặc mật khẩu.' });
            return;
          }
          const session = createSession(username);
          sendJson(
            res,
            200,
            { authenticated: true, username: session.username },
            { 'Set-Cookie': buildSessionCookieHeader(session.token, false) },
          );
        } catch (err) {
          sendJson(res, err.statusCode || 400, { error: err.message });
        }
        return;
      }

      if (pathname === '/api/auth/logout' && req.method === 'POST') {
        const session = getSessionFromRequest(req);
        if (session) destroySession(session.token);
        sendJson(res, 200, { authenticated: false }, { 'Set-Cookie': buildSessionCookieHeader('', true) });
        return;
      }

      if (pathname === '/api/extract' && req.method === 'GET') {
        const targetUrl = reqUrl.searchParams.get('url') || '';
        const source = reqUrl.searchParams.get('source') || 'auto';
        try {
          const data = await extractRegion(targetUrl, source);
          sendJson(res, 200, data);
        } catch (err) {
          sendJson(res, 400, { error: err.message, trace: err.trace || [] });
        }
        return;
      }

      // --- Direct Open-Data GeoJSON Map Endpoints ---
      const regionGeoMatch = pathname.match(/^\/api\/regions\/(\d+)\/geojson$/);
      if (regionGeoMatch && req.method === 'GET') {
        try {
          const region = await getRegionById(regionGeoMatch[1]);
          if (!region) {
            sendJson(res, 404, { error: 'Không tìm thấy khu vực.' });
            return;
          }
          sendJson(res, 200, region.geojson);
        } catch (err) {
          sendJson(res, 503, { error: err.message });
        }
        return;
      }

      const regionNeighborsMatch = pathname.match(/^\/api\/regions\/(\d+)\/neighbors$/);
      if (regionNeighborsMatch && req.method === 'GET') {
        try {
          const pad = Number(reqUrl.searchParams.get('pad') || 0.03);
          const neighbors = await listNeighborRegions(regionNeighborsMatch[1], pad);
          sendJson(res, 200, { neighbors });
        } catch (err) {
          sendJson(res, 503, { error: err.message });
        }
        return;
      }

      if (pathname === '/api/map/lamdong/locate-ward' && req.method === 'GET') {
        try {
          const lat = Number(reqUrl.searchParams.get('lat'));
          const lng = Number(reqUrl.searchParams.get('lng'));
          if (!Number.isFinite(lat) || !Number.isFinite(lng)) {
            sendJson(res, 400, { error: 'Tọa độ lat, lng không hợp lệ.' });
            return;
          }
          const unit = await findWardUnitByCoords(lat, lng);
          sendJson(res, 200, { unit });
        } catch (err) {
          sendJson(res, 503, { error: err.message });
        }
        return;
      }

      if (pathname === '/api/map/lamdong/neighbor-provinces' && req.method === 'GET') {
        try {
          if (!cachedNeighborProvincesJson) {
            cachedNeighborProvincesJson = await fs.readFile(NEIGHBOR_PROVINCES_FILE, 'utf8');
          }
          res.writeHead(200, {
            'Content-Type': 'application/json; charset=utf-8',
            'Cache-Control': 'public, max-age=3600',
          });
          res.end(cachedNeighborProvincesJson);
        } catch (err) {
          sendJson(res, 500, { error: `Không đọc được dữ liệu tỉnh lân cận: ${err.message}` });
        }
        return;
      }

      const wardMapMatch = pathname.match(/^\/api\/map\/lamdong\/ward\/([^/]+)$/);
      if (wardMapMatch && req.method === 'GET') {
        try {
          const code = decodeURIComponent(wardMapMatch[1]);
          const region = await getRegionByKey(`open-ward-2025-${code}`);
          if (region) {
            sendJson(res, 200, region.geojson);
            return;
          }
          const bundle = await loadOpenDataBundle();
          const found = bundle.wards.find((w) => w.wardCode === code);
          if (!found) {
            sendJson(res, 404, { error: `Không tìm thấy xã/phường mã ${code}.` });
            return;
          }
          sendJson(res, 200, found.geojson);
        } catch (err) {
          sendJson(res, 500, { error: err.message });
        }
        return;
      }

      const districtMapMatch = pathname.match(/^\/api\/map\/lamdong\/district\/([^/]+)$/);
      if (districtMapMatch && req.method === 'GET') {
        try {
          const code = decodeURIComponent(districtMapMatch[1]);
          const region = await getRegionByKey(`open-district-old-${code}`);
          if (region) {
            sendJson(res, 200, region.geojson);
            return;
          }
          const bundle = await loadOpenDataBundle();
          const found = bundle.oldDistricts.find((d) => d.districtCode === code);
          if (!found) {
            sendJson(res, 404, { error: `Không tìm thấy huyện cũ mã ${code}.` });
            return;
          }
          sendJson(res, 200, found.geojson);
        } catch (err) {
          sendJson(res, 500, { error: err.message });
        }
        return;
      }

      if (pathname === '/api/regions' && req.method === 'GET') {
        try {
          const regions = await listRegions();
          sendJson(res, 200, { regions, db: getDbStatus() });
        } catch (err) {
          sendJson(res, 503, { error: err.message, db: getDbStatus() });
        }
        return;
      }

      // --- Lam Dong 124-Ward Streets & Delivery Route Merge Endpoints ---
      if (pathname === '/api/streets/wards' && req.method === 'GET') {
        try {
          const wards = await listWardStreetSummaries();
          sendJson(res, 200, { wards });
        } catch (err) {
          sendJson(res, 503, { error: err.message });
        }
        return;
      }

      if (pathname === '/api/streets' && req.method === 'GET') {
        try {
          const wardUnitId = Number(reqUrl.searchParams.get('wardUnitId'));
          if (!Number.isInteger(wardUnitId) || wardUnitId <= 0) {
            sendJson(res, 400, { error: 'Thiếu tham số wardUnitId hợp lệ.' });
            return;
          }
          const bundle = await getWardStreetsBundle(wardUnitId);
          if (!bundle) {
            sendJson(res, 404, { error: 'Không tìm thấy xã/phường này.' });
            return;
          }
          sendJson(res, 200, bundle);
        } catch (err) {
          sendJson(res, 503, { error: err.message });
        }
        return;
      }

      if (pathname === '/api/streets/geojson' && req.method === 'GET') {
        try {
          const wardUnitId = Number(reqUrl.searchParams.get('wardUnitId'));
          const bundle = await getWardStreetsBundle(wardUnitId);
          if (!bundle) {
            sendJson(res, 404, { error: 'Không tìm thấy xã/phường này.' });
            return;
          }
          const fc = {
            type: 'FeatureCollection',
            features: bundle.streets.map((s) => ({
              type: 'Feature',
              properties: {
                id: s.id,
                name: s.name,
                highway: s.highway,
                length_m: s.lengthM,
                area_km2: s.areaKm2,
                ward_name: bundle.ward.name,
              },
              geometry: s.zoneGeojson,
            })),
          };
          const ascii = toSafeSlug(bundle.ward.name, `ward_${wardUnitId}`);
          res.writeHead(200, {
            'Content-Type': 'application/geo+json; charset=utf-8',
            'Content-Disposition': `attachment; filename="duong_${ascii}.geojson"`,
          });
          res.end(JSON.stringify(fc));
        } catch (err) {
          sendJson(res, 503, { error: err.message });
        }
        return;
      }

      if (pathname === '/api/streets/merge' && req.method === 'POST') {
        try {
          const body = await readJsonBody(req);
          const merged = await mergeWardStreetsByIds(Array.isArray(body.streetIds) ? body.streetIds : []);
          if (!merged) {
            sendJson(res, 400, { error: 'Vui lòng chọn ít nhất 1 tuyến đường hợp lệ.' });
            return;
          }
          sendJson(res, 200, merged);
        } catch (err) {
          sendJson(res, err.statusCode || 500, { error: err.message });
        }
        return;
      }

      if (pathname === '/api/bcvh' && req.method === 'GET') {
        try {
          const offices = await listBcvhOffices();
          sendJson(res, 200, { offices, db: getDbStatus() });
        } catch (err) {
          sendJson(res, 503, { error: err.message, db: getDbStatus() });
        }
        return;
      }

      if (pathname === '/api/bcvh/export-excel' && req.method === 'GET') {
        try {
          const offices = await listBcvhOffices();
          const check = validateBcvhForExcelExport(offices);
          if (!check.ok) {
            sendJson(res, 400, { error: check.message, incomplete: check.incomplete });
            return;
          }
          const buf = buildBcvhWorkbookBuffer(offices);
          sendXlsxDownload(
            res,
            buf,
            'Nhập_dữ_liệu_nút-Tat_ca_BCVH.xlsx',
            'Nhap_du_lieu_nut-Tat_ca_BCVH.xlsx',
          );
        } catch (err) {
          sendJson(res, 503, { error: err.message });
        }
        return;
      }

      const bcvhExcelMatch = pathname.match(/^\/api\/bcvh\/(\d+)\/export-excel$/);
      if (bcvhExcelMatch && req.method === 'GET') {
        try {
          const office = await getBcvhOfficeById(bcvhExcelMatch[1]);
          if (!office) {
            sendJson(res, 404, { error: 'Không tìm thấy Bưu cục Vận hành.' });
            return;
          }
          const check = validateBcvhForExcelExport([office]);
          if (!check.ok) {
            sendJson(res, 400, { error: check.message, incomplete: check.incomplete });
            return;
          }
          const buf = buildBcvhWorkbookBuffer([office]);
          const safeUnicodeName = String(office.name || 'BCVH').replace(/[\\/:*?"<>|]/g, '').trim().replace(/\s+/g, '_');
          const safeAsciiName = toSafeSlug(office.name, `BCVH_${office.id}`);
          sendXlsxDownload(
            res,
            buf,
            `Nhập_dữ_liệu_nút-${safeUnicodeName || 'BCVH'}.xlsx`,
            `Nhap_du_lieu_nut-${safeAsciiName}.xlsx`,
          );
        } catch (err) {
          sendJson(res, 503, { error: err.message });
        }
        return;
      }

      const bcvhGeoMatch = pathname.match(/^\/api\/bcvh\/(\d+)\/geojson$/);
      if (bcvhGeoMatch && req.method === 'GET') {
        try {
          const office = await getBcvhOfficeById(bcvhGeoMatch[1]);
          if (!office || !office.serviceGeojson) {
            sendJson(res, 404, { error: 'Không tìm thấy vùng phục vụ GeoJSON của Bưu cục Vận hành này.' });
            return;
          }
          sendJson(res, 200, office.serviceGeojson);
        } catch (err) {
          sendJson(res, 503, { error: err.message });
        }
        return;
      }

      if (pathname === '/api/regions' && req.method === 'POST') {
        if (!requireAdmin(req, res)) return;
        try {
          const body = await readJsonBody(req);
          const saved = await upsertRegion(body);
          sendJson(res, 200, { region: saved, db: getDbStatus() });
        } catch (err) {
          sendJson(res, err.statusCode || 400, { error: err.message, db: getDbStatus() });
        }
        return;
      }

      if (pathname === '/api/regions/batch' && req.method === 'POST') {
        if (!requireAdmin(req, res)) return;
        try {
          const body = await readJsonBody(req);
          const saved = await upsertRegionsBatch(body.regions);
          sendJson(res, 200, { regions: saved, count: saved.length, db: getDbStatus() });
        } catch (err) {
          sendJson(res, err.statusCode || 400, { error: err.message, db: getDbStatus() });
        }
        return;
      }

      const singleRegionMatch = pathname.match(/^\/api\/regions\/(\d+)$/);
      if (singleRegionMatch && req.method === 'DELETE') {
        if (!requireAdmin(req, res)) return;
        try {
          const deleted = await deleteRegion(singleRegionMatch[1]);
          sendJson(res, deleted ? 200 : 404, { deleted });
        } catch (err) {
          sendJson(res, 400, { error: err.message });
        }
        return;
      }

      if (pathname === '/api/regions' && req.method === 'DELETE') {
        if (!requireAdmin(req, res)) return;
        try {
          const deletedCount = await deleteAllRegions();
          sendJson(res, 200, { deletedCount });
        } catch (err) {
          sendJson(res, 503, { error: err.message });
        }
        return;
      }

      // --- Admin: Lam Dong 124 commune-level units (16/06/2025) — Auth Required ---
      if (pathname.startsWith('/api/admin/')) {
        if (!requireAdmin(req, res)) return;
      }
      if (pathname === '/api/admin/lamdong' && req.method === 'GET') {
        try {
          let units = await listLamDongUnits();
          if (units.length === 0) {
            try {
              const localUnits = await loadLamDongUnitsFromLocalFile();
              if (localUnits.length > 0) units = await seedLamDongUnits(localUnits);
            } catch {
              const wikiUnits = await fetchLamDongUnitsFromWikipedia();
              if (wikiUnits.length > 0) units = await seedLamDongUnits(wikiUnits);
            }
          }
          // Auto-backfill old_district if any linked unit is missing it
          if (units.some((u) => u.hasGeojson && !u.oldDistrict)) {
            await backfillLamDongOldDistricts();
            units = await listLamDongUnits();
          }
          sendJson(res, 200, { units, sourcePageUrl: LAMDONG_WIKI_PAGE_URL, db: getDbStatus() });
        } catch (err) {
          sendJson(res, 503, { error: err.message, db: getDbStatus() });
        }
        return;
      }

      if (pathname === '/api/admin/lamdong/import-open-data' && req.method === 'POST') {
        try {
          // Ensure 124 metadata rows exist in dbo.lamdong_admin_units before linking
          const existing = await listLamDongUnits();
          if (existing.length === 0) {
            const localUnits = await loadLamDongUnitsFromLocalFile();
            if (localUnits.length > 0) await seedLamDongUnits(localUnits);
          }
          const bundle = await loadOpenDataBundle();
          const summary = await replaceAllWithOpenData(bundle, normalizeAdminName);
          const units = await listLamDongUnits();
          sendJson(res, 200, { ...summary, units, db: getDbStatus() });
        } catch (err) {
          sendJson(res, 500, { error: err.message, db: getDbStatus() });
        }
        return;
      }

      if (pathname === '/api/admin/lamdong/sync-list' && req.method === 'POST') {
        try {
          const body = await readJsonBody(req);
          const mode = body.source || 'wikipedia';
          const overwriteLinks = Boolean(body.overwriteLinks);
          let parsedUnits = [];
          let usedSource = mode;

          if (mode === 'file') {
            parsedUnits = await loadLamDongUnitsFromLocalFile();
          } else {
            try {
              parsedUnits = await fetchLamDongUnitsFromWikipedia(body.pageUrl || LAMDONG_WIKI_PAGE_URL);
              usedSource = 'wikipedia';
            } catch (wikiErr) {
              parsedUnits = await loadLamDongUnitsFromLocalFile();
              usedSource = `table.html (fallback sau lỗi Wikipedia: ${wikiErr.message})`;
            }
          }

          const units = await seedLamDongUnits(parsedUnits, { overwriteLinks });
          sendJson(res, 200, { units, count: units.length, usedSource, db: getDbStatus() });
        } catch (err) {
          sendJson(res, 400, { error: err.message, db: getDbStatus() });
        }
        return;
      }

      if (pathname === '/api/admin/old-districts' && req.method === 'GET') {
        try {
          const districts = await listOldDistrictRegions();
          sendJson(res, 200, { districts, db: getDbStatus() });
        } catch (err) {
          sendJson(res, 503, { error: err.message, db: getDbStatus() });
        }
        return;
      }

      // --- Admin: BCVH (Bưu cục Vận hành) CRUD ---
      if (pathname === '/api/admin/bcvh' && req.method === 'GET') {
        try {
          const offices = await listBcvhOffices();
          sendJson(res, 200, { offices, db: getDbStatus() });
        } catch (err) {
          sendJson(res, 503, { error: err.message, db: getDbStatus() });
        }
        return;
      }

      if (pathname === '/api/admin/bcvh' && req.method === 'POST') {
        try {
          const body = await readJsonBody(req);
          const office = await createBcvhOffice(body);
          sendJson(res, 201, { office, db: getDbStatus() });
        } catch (err) {
          sendJson(res, err.statusCode || 400, { error: err.message });
        }
        return;
      }

      const adminBcvhIdMatch = pathname.match(/^\/api\/admin\/bcvh\/(\d+)$/);
      if (adminBcvhIdMatch && req.method === 'PUT') {
        try {
          const body = await readJsonBody(req);
          const office = await updateBcvhOffice(adminBcvhIdMatch[1], body);
          sendJson(res, 200, { office, db: getDbStatus() });
        } catch (err) {
          sendJson(res, err.statusCode || 400, { error: err.message });
        }
        return;
      }

      if (adminBcvhIdMatch && req.method === 'DELETE') {
        try {
          const deleted = await deleteBcvhOffice(adminBcvhIdMatch[1]);
          sendJson(res, deleted ? 200 : 404, { deleted });
        } catch (err) {
          sendJson(res, 400, { error: err.message });
        }
        return;
      }

      const adminRegionGeoMatch = pathname.match(/^\/api\/admin\/regions\/(\d+)\/geojson$/);
      if (adminRegionGeoMatch && req.method === 'PUT') {
        const regionId = Number(adminRegionGeoMatch[1]);
        try {
          const body = await readJsonBody(req);
          const existing = await getRegionById(regionId);
          if (!existing) {
            sendJson(res, 404, { error: 'Không tìm thấy khu vực.' });
            return;
          }
          const fc = normalizeToFeatureCollection(body.geojson, {
            name: existing.meta?.name || '',
            layer_group: existing.layerGroup,
          });
          if (!fc || !hasUsableGeometry(fc)) {
            sendJson(res, 400, { error: 'GeoJSON không hợp lệ hoặc không chứa hình học (Polygon / MultiPolygon).' });
            return;
          }
          const stats = computeGeoStats(fc, null);
          const savedRegion = await upsertRegion({
            key: existing.key,
            layerGroup: existing.layerGroup,
            color: existing.color,
            areaKm2: stats.areaKm2,
            points: stats.points,
            modified: true,
            meta: existing.meta,
            geojson: fc,
            originalGeojson: existing.originalGeojson || fc,
          });

          const updatedNeighbors = [];
          if (Array.isArray(body.neighborUpdates) && body.neighborUpdates.length > 0) {
            for (const item of body.neighborUpdates) {
              const nId = Number(item?.regionId);
              if (!Number.isInteger(nId) || nId <= 0 || nId === savedRegion.id) continue;
              const existingNeighbor = await getRegionById(nId);
              if (!existingNeighbor || existingNeighbor.layerGroup !== existing.layerGroup) continue;
              const nFc = normalizeToFeatureCollection(item.geojson, {
                name: existingNeighbor.meta?.name || '',
                layer_group: existingNeighbor.layerGroup,
              });
              if (!nFc || !hasUsableGeometry(nFc)) continue;
              const nStats = computeGeoStats(nFc, null);
              const savedNeighbor = await upsertRegion({
                key: existingNeighbor.key,
                layerGroup: existingNeighbor.layerGroup,
                color: existingNeighbor.color,
                areaKm2: nStats.areaKm2,
                points: nStats.points,
                modified: true,
                meta: existingNeighbor.meta,
                geojson: nFc,
                originalGeojson: existingNeighbor.originalGeojson || nFc,
              });
              updatedNeighbors.push({
                id: savedNeighbor.id,
                name: savedNeighbor.meta?.name || '',
                layerGroup: savedNeighbor.layerGroup,
                color: savedNeighbor.color,
                areaKm2: savedNeighbor.areaKm2,
                points: savedNeighbor.points,
                modified: savedNeighbor.modified,
                geojson: savedNeighbor.geojson,
              });
            }
          }

          sendJson(res, 200, { region: savedRegion, updatedNeighbors, db: getDbStatus() });
        } catch (err) {
          sendJson(res, err.statusCode || 400, { error: err.message });
        }
        return;
      }

      const adminPatchMatch = pathname.match(/^\/api\/admin\/lamdong\/(\d+)$/);
      if (adminPatchMatch && req.method === 'PATCH') {
        try {
          const body = await readJsonBody(req);
          const unit = await updateLamDongUnitFields(adminPatchMatch[1], {
            wikiUrl: body.wikiUrl,
            oldDistrict: body.oldDistrict,
            oldProvince: body.oldProvince,
          });
          sendJson(res, 200, { unit });
        } catch (err) {
          sendJson(res, 400, { error: err.message });
        }
        return;
      }

      const adminSaveGeojsonMatch = pathname.match(/^\/api\/admin\/lamdong\/(\d+)\/geojson$/);
      if (adminSaveGeojsonMatch && req.method === 'PUT') {
        const unitId = Number(adminSaveGeojsonMatch[1]);
        try {
          const body = await readJsonBody(req);
          const unit = await getLamDongUnitById(unitId);
          if (!unit) {
            sendJson(res, 404, { error: 'Không tìm thấy đơn vị hành chính.' });
            return;
          }

          const existingRegion = unit.regionId ? await getRegionById(unit.regionId) : null;
          const fc = normalizeToFeatureCollection(body.geojson, {
            name: unit.name,
            unit_type: unit.unitType,
            province: 'Tỉnh Lâm Đồng',
            area_official_km2: unit.areaOfficialKm2,
            population_2025: unit.population2025,
            layer_group: 'ward_2025',
          });
          if (!fc || !hasUsableGeometry(fc)) {
            sendJson(res, 400, { error: 'GeoJSON không hợp lệ hoặc không chứa hình học (Polygon / MultiPolygon).' });
            return;
          }

          const stats = computeGeoStats(fc, null);
          const savedRegion = await upsertRegion({
            key: existingRegion?.key || `lamdong-unit-${unit.stt}`,
            layerGroup: existingRegion?.layerGroup || 'ward_2025',
            color: existingRegion?.color || PALETTE[(unit.stt - 1) % PALETTE.length],
            areaKm2: stats.areaKm2,
            points: stats.points,
            modified: true,
            meta: {
              ...(existingRegion?.meta || {}),
              name: unit.name,
              source: existingRegion?.meta?.source || 'Edited GeoJSON',
            },
            geojson: fc,
            originalGeojson: existingRegion?.originalGeojson || fc,
          });

          const updatedUnit = await markLamDongUnitSyncResult(unitId, {
            regionId: savedRegion.id,
            status: 'synced',
            error: null,
          });

          // Topological edit: save any neighboring wards whose shared border vertices were modified
          const updatedNeighbors = [];
          const updatedUnits = [updatedUnit];
          if (Array.isArray(body.neighborUpdates) && body.neighborUpdates.length > 0) {
            for (const item of body.neighborUpdates) {
              const nId = Number(item?.regionId);
              if (!Number.isInteger(nId) || nId <= 0 || nId === savedRegion.id) continue;
              const existingNeighbor = await getRegionById(nId);
              if (!existingNeighbor || existingNeighbor.layerGroup !== 'ward_2025') continue;
              const nFc = normalizeToFeatureCollection(item.geojson, {
                name: existingNeighbor.meta?.name || '',
                layer_group: 'ward_2025',
              });
              if (!nFc || !hasUsableGeometry(nFc)) continue;
              const nStats = computeGeoStats(nFc, null);
              const savedNeighbor = await upsertRegion({
                key: existingNeighbor.key,
                layerGroup: existingNeighbor.layerGroup,
                color: existingNeighbor.color,
                areaKm2: nStats.areaKm2,
                points: nStats.points,
                modified: true,
                meta: existingNeighbor.meta,
                geojson: nFc,
                originalGeojson: existingNeighbor.originalGeojson || nFc,
              });
              updatedNeighbors.push({
                id: savedNeighbor.id,
                name: savedNeighbor.meta?.name || '',
                layerGroup: savedNeighbor.layerGroup,
                color: savedNeighbor.color,
                areaKm2: savedNeighbor.areaKm2,
                points: savedNeighbor.points,
                geojson: savedNeighbor.geojson,
              });
              const linkedUnit = await getLamDongUnitByRegionId(savedNeighbor.id);
              if (linkedUnit) {
                const refreshed = await markLamDongUnitSyncResult(linkedUnit.id, {
                  regionId: savedNeighbor.id,
                  status: 'synced',
                  error: null,
                });
                updatedUnits.push(refreshed);
              }
            }
          }

          sendJson(res, 200, {
            unit: updatedUnit,
            region: savedRegion,
            updatedNeighbors,
            updatedUnits,
            db: getDbStatus(),
          });
        } catch (err) {
          sendJson(res, err.statusCode || 400, { error: err.message });
        }
        return;
      }

      const adminFetchMatch = pathname.match(/^\/api\/admin\/lamdong\/(\d+)\/fetch-geojson$/);
      if (adminFetchMatch && req.method === 'POST') {
        const unitId = Number(adminFetchMatch[1]);
        try {
          const body = await readJsonBody(req);
          let unit = await getLamDongUnitById(unitId);
          if (!unit) {
            sendJson(res, 404, { error: 'Không tìm thấy đơn vị hành chính.' });
            return;
          }

          const targetUrl = typeof body.wikiUrl === 'string' ? body.wikiUrl.trim() : unit.wikiUrl;
          if (!targetUrl) {
            throw new Error(`Đơn vị "${unit.name}" chưa có link Wikipedia.`);
          }
          if (targetUrl !== unit.wikiUrl) {
            unit = await updateLamDongUnitLink(unitId, targetUrl);
          }

          const existingRegion = unit.regionId ? await getRegionById(unit.regionId) : null;
          const preferredSource = body.source || 'auto';
          const extracted = await extractRegion(targetUrl, preferredSource);
          const stats = computeGeoStats(extracted.geojson, null);

          const savedRegion = await upsertRegion({
            key: existingRegion?.key || `lamdong-unit-${unit.stt}`,
            layerGroup: existingRegion?.layerGroup || 'ward_2025',
            color: existingRegion?.color || unit.region?.color || PALETTE[(unit.stt - 1) % PALETTE.length],
            areaKm2: stats.areaKm2,
            points: stats.points,
            modified: false,
            meta: {
              ...extracted.meta,
              name: unit.name,
              description:
                extracted.meta.description ||
                `${unit.unitType} thuộc tỉnh Lâm Đồng (DT: ${unit.areaOfficialKm2} km², DS 2025: ${unit.population2025.toLocaleString('vi-VN')})`,
              wikipediaUrl: targetUrl,
            },
            geojson: extracted.geojson,
            originalGeojson: extracted.geojson,
          });

          const updatedUnit = await markLamDongUnitSyncResult(unitId, {
            regionId: savedRegion.id,
            status: 'synced',
            error: null,
          });

          sendJson(res, 200, { unit: updatedUnit, region: savedRegion, db: getDbStatus() });
        } catch (err) {
          const updatedUnit = await markLamDongUnitSyncResult(unitId, {
            regionId: null,
            status: 'error',
            error: err.message,
          }).catch(() => null);
          sendJson(res, 400, { error: err.message, unit: updatedUnit });
        }
        return;
      }

      if (pathname.startsWith('/api/')) {
        sendJson(res, 404, { error: 'API endpoint không tồn tại.' });
        return;
      }

      await serveStatic(res, pathname);
    } catch (err) {
      sendJson(res, err.statusCode || 500, { error: err.message || 'Internal Server Error' });
    }
  });
}

// Start server when executed directly
if (path.resolve(process.argv[1] || '') === __filename) {
  const dbStatus = await initDb();
  const server = createAppServer();

  server.listen(config.port, config.host, () => {
    console.log(`Backend + Frontend đang chạy tại http://localhost:${config.port}`);
    if (dbStatus.connected) {
      console.log(
        `SQL Server đã kết nối: ${dbStatus.host}:${dbStatus.port}/${dbStatus.database} (GEOMETRY + JSON)`,
      );
    } else {
      console.warn(`Cảnh báo SQL Server chưa kết nối: ${dbStatus.error}`);
    }
  });

  const shutdown = async () => {
    server.close();
    await closeDb();
    process.exit(0);
  };
  process.on('SIGINT', shutdown);
  process.on('SIGTERM', shutdown);
}
