import test from 'node:test';
import assert from 'node:assert/strict';
import { parseInput, normalizeToFeatureCollection } from '../src/wikiExtractor.mjs';
import { extractMultiPolygonGeometry, geojsonToMultiPolygonWkt } from '../src/db.mjs';
import { loadLamDongUnitsFromLocalFile, normalizeWikiMapUrl } from '../src/lamdongParser.mjs';
import { loadOpenDataBundle } from '../src/openDataImporter.mjs';
import {
  verifyCredentials,
  hashPassword,
  verifyPassword,
  hasPermission,
  normalizePermissions,
  createSession,
  getSessionFromRequest,
  destroySession,
} from '../src/auth.mjs';
import {
  parseBcvhCode,
  formatAdminPath,
  buildExcelSafePolygonOneLine,
  getMissingExcelFields,
  validateBcvhForExcelExport,
  bcvhOfficeToNodeRow,
  buildBcvhWorkbookBuffer,
} from '../src/bcvhExcel.mjs';
import { ringAreaSqMeters, computeGeoStats, bboxesOverlap } from '../../frontend/js/geometry.js';

test('parseInput handles Vietnamese Wikipedia URL with map hash, mobile URL, and direct QID', () => {
  const r1 = parseInput('https://vi.wikipedia.org/wiki/%C4%90%E1%BA%A1_Huoai_(huy%E1%BB%87n)#/map/0');
  assert.equal(r1.kind, 'wikipedia');
  assert.equal(r1.lang, 'vi');
  assert.equal(r1.title, 'Đạ_Huoai_(huyện)');
  assert.equal(r1.mapIndex, 0);

  const r2 = parseInput('https://en.m.wikipedia.org/wiki/Vietnam#/map/2');
  assert.equal(r2.lang, 'en');
  assert.equal(r2.title, 'Vietnam');
  assert.equal(r2.mapIndex, 2);

  const r3 = parseInput('q5207252');
  assert.equal(r3.kind, 'qid');
  assert.equal(r3.qid, 'Q5207252');

  const r4 = parseInput('http://localhost:3000/api/map/lamdong/ward/24823');
  assert.equal(r4.kind, 'geojson_url');

  assert.throws(() => parseInput('https://evil.example.com/wiki/Test'));
});

test('normalizeToFeatureCollection wraps Polygon and GeometryCollection cleanly', () => {
  const poly = {
    type: 'Polygon',
    coordinates: [[[107.0, 11.0], [107.1, 11.0], [107.1, 11.1], [107.0, 11.1], [107.0, 11.0]]],
  };
  const fc = normalizeToFeatureCollection(poly, { name: 'Test' });
  assert.equal(fc.type, 'FeatureCollection');
  assert.equal(fc.features.length, 1);
  assert.equal(fc.features[0].properties.name, 'Test');

  const mp = extractMultiPolygonGeometry(fc);
  assert.equal(mp.type, 'MultiPolygon');
  assert.equal(mp.coordinates.length, 1);

  const wkt = geojsonToMultiPolygonWkt(fc);
  assert.equal(wkt, 'MULTIPOLYGON(((107 11, 107.1 11, 107.1 11.1, 107 11.1, 107 11)))');
});

test('ringAreaSqMeters does not double-count closing vertex on closed GeoJSON ring', () => {
  const openRing = [[0, 0], [1, 0], [1, 1], [0, 1]];
  const closedRing = [[0, 0], [1, 0], [1, 1], [0, 1], [0, 0]];
  const areaOpen = ringAreaSqMeters(openRing);
  const areaClosed = ringAreaSqMeters(closedRing);
  assert.ok(areaClosed > 1e10, '1x1 deg square near equator is ~12,300 km²');
  assert.equal(Math.round(areaOpen), Math.round(areaClosed));
});

test('computeGeoStats and bboxesOverlap compute accurate bounds', () => {
  const fc = {
    type: 'FeatureCollection',
    features: [
      {
        type: 'Feature',
        properties: {},
        geometry: {
          type: 'Polygon',
          coordinates: [[[107.0, 11.0], [107.5, 11.0], [107.5, 11.5], [107.0, 11.5], [107.0, 11.0]]],
        },
      },
    ],
  };
  const stats = computeGeoStats(fc, null);
  assert.deepEqual(stats.bbox, [107.0, 11.0, 107.5, 11.5]);
  assert.equal(stats.points, 5);
  assert.equal(bboxesOverlap(stats.bbox, [107.4, 11.4, 108.0, 12.0]), true);
  assert.equal(bboxesOverlap(stats.bbox, [108.0, 12.0, 109.0, 13.0]), false);
});

test('lamdongParser extracts all 124 units from table.html with #/map/0 links', async () => {
  const units = await loadLamDongUnitsFromLocalFile();
  assert.equal(units.length, 124);
  assert.equal(units[0].stt, 1);
  assert.equal(units[0].unitType, 'Phường');
  assert.equal(units[0].name, 'Phường 1 Bảo Lộc');
  assert.equal(units[0].areaOfficialKm2, 51.46);
  assert.equal(units[0].population2025, 55845);

  const hamThuan = units.find((u) => u.stt === 63);
  assert.equal(hamThuan.name, 'Xã Hàm Thuận');
  assert.equal(hamThuan.wikiUrl, 'https://vi.wikipedia.org/wiki/H%C3%A0m_Thu%E1%BA%ADn_(x%C3%A3)#/map/0');

  const phuQuy = units.find((u) => u.stt === 124);
  assert.equal(phuQuy.unitType, 'Đặc khu');
  assert.equal(phuQuy.name, 'Đặc khu Phú Quý');
  assert.equal(normalizeWikiMapUrl('/wiki/Hàm_Thuận_(xã)'), 'https://vi.wikipedia.org/wiki/H%C3%A0m_Thu%E1%BA%ADn_(x%C3%A3)#/map/0');
});

test('openDataImporter loads 124 Lam Dong 2025 wards and 30 old districts', async () => {
  const { wards, oldDistricts } = await loadOpenDataBundle();
  assert.equal(wards.length, 124);
  assert.equal(oldDistricts.length, 30);
  assert.equal(wards[0].layerGroup, 'ward_2025');
  assert.equal(oldDistricts[0].layerGroup, 'district_old');
  assert.ok(wards.every((w) => w.geojson.features.length === 1 && w.points >= 4));
  assert.ok(oldDistricts.every((d) => d.geojson.features.length === 1 && d.points >= 4));
});

test('auth verifies default lamdong/Lamdong@2026 credentials and session lifecycle', () => {
  assert.equal(verifyCredentials('lamdong', 'Lamdong@2026'), true);
  assert.equal(verifyCredentials('lamdong', 'wrong'), false);
  assert.equal(verifyCredentials('other', 'Lamdong@2026'), false);

  const s = createSession('lamdong');
  const fakeReq = { headers: { cookie: `admin_session=${s.token}` } };
  assert.equal(getSessionFromRequest(fakeReq)?.username, 'lamdong');
  assert.equal(hasPermission(s, 'manage_users'), true);
  destroySession(s.token);
  assert.equal(getSessionFromRequest(fakeReq), null);

  // Salted scrypt password hashing & granular RBAC permissions
  const hash = hashPassword('Secret@123');
  assert.ok(hash.startsWith('scrypt$'));
  assert.equal(verifyPassword('Secret@123', hash), true);
  assert.equal(verifyPassword('wrong', hash), false);

  const bcvhPerms = normalizePermissions(['edit_bcvh'], 'custom');
  assert.ok(bcvhPerms.includes('view_bcvh'), 'edit_bcvh implies view_bcvh');
  assert.ok(bcvhPerms.includes('view_map'), 'always includes view_map');
  const bcvhSess = createSession({ username: 'nv_bcvh', role: 'custom', permissions: bcvhPerms });
  assert.equal(hasPermission(bcvhSess, 'edit_bcvh'), true);
  assert.equal(hasPermission(bcvhSess, 'edit_routes'), false);
  assert.equal(hasPermission(bcvhSess, 'manage_users'), false);
  destroySession(bcvhSess.token);
});

test('bcvhExcel formats VNPost fields and produces valid 3-sheet xlsx ZIP', () => {
  assert.deepEqual(parseBcvhCode('LDGV004|801060'), { nodeCode: 'LDGV004', deptCode: '801060' });
  assert.deepEqual(parseBcvhCode('LDGV00G/673380'), { nodeCode: 'LDGV00G', deptCode: '673380' });
  assert.equal(formatAdminPath('Xã Đức Trọng'), 'Tỉnh Lâm Đồng/X. Đức Trọng');
  assert.equal(formatAdminPath('Phường Xuân Hương - Đà Lạt'), 'Tỉnh Lâm Đồng/P. Xuân Hương - Đà Lạt');
  assert.equal(formatAdminPath('Đặc khu Phú Quý'), 'Tỉnh Lâm Đồng/Đặc khu Phú Quý');

  const multi = {
    type: 'FeatureCollection',
    features: [
      {
        type: 'Feature',
        properties: {},
        geometry: {
          type: 'MultiPolygon',
          coordinates: [
            [[[108.0, 11.0], [108.01, 11.0], [108.01, 11.01], [108.0, 11.01], [108.0, 11.0]]],
            [
              [[108.2, 11.2], [108.6, 11.2], [108.6, 11.6], [108.2, 11.6], [108.2, 11.2]],
              [[108.3, 11.3], [108.4, 11.3], [108.4, 11.4], [108.3, 11.4], [108.3, 11.3]],
            ],
          ],
        },
      },
    ],
  };
  const oneLine = buildExcelSafePolygonOneLine(multi);
  assert.ok(!oneLine.includes('\n'));
  const parsed = JSON.parse(oneLine);
  assert.equal(parsed.type, 'Polygon');
  assert.equal(parsed.coordinates.length, 1, 'must drop interior holes and pick largest outer ring');

  const row = bcvhOfficeToNodeRow({
    code: 'LDGV00G/673380',
    name: 'BCVH Đức Trọng',
    hostWardName: 'Xã Đức Trọng',
    address: 'QL20 Đức Trọng',
    officeAreaM2: 180,
    contactName: 'Nguyễn Văn A',
    contactPhone: '0888139797',
    lng: 108.374667,
    lat: 11.737758,
    serviceGeojson: multi,
  });
  assert.equal(row.length, 23);
  assert.equal(row[0], 'LDGV00G');
  assert.equal(row[1], 'BCVH Đức Trọng');
  assert.equal(row[2], 'POST_OFFICE');
  assert.equal(row[3], 'OPERATIONS_POST_OFFICE');
  assert.equal(row[4], 'SELF_OPERATED_COLLECTION_AND_DELIVERY');
  assert.equal(row[5], 'VNPOST');
  assert.equal(row[6], 'OWNED');
  assert.equal(row[7], 180);
  assert.equal(row[8], 'Tỉnh Lâm Đồng/X. Đức Trọng');
  assert.equal(row[9], 'QL20 Đức Trọng');
  assert.equal(row[10], '67');
  assert.equal(row[11], 'BĐT Lâm Đồng');
  assert.equal(row[12], 'Nguyễn Văn A');
  assert.equal(row[13], '0888139797');
  assert.equal(row[14], 2000);
  assert.equal(row[16], 'ENABLE');
  assert.equal(row[17], 108.374667);
  assert.equal(row[18], 11.737758);
  assert.equal(row[20], 'POLYGON');
  assert.equal(row[21], '');
  assert.equal(row[22], '673380');

  const buf = buildBcvhWorkbookBuffer([
    {
      code: 'LDGV00G/673380',
      name: 'BCVH Đức Trọng',
      hostWardName: 'Xã Đức Trọng',
      address: 'QL20 Đức Trọng',
      officeAreaM2: 180,
      contactName: 'Nguyễn Văn A',
      contactPhone: '0888139797',
      lng: 108.374667,
      lat: 11.737758,
      serviceGeojson: multi,
    },
  ]);
  assert.ok(Buffer.isBuffer(buf) && buf.length > 500);
  assert.equal(buf.readUInt32LE(0), 0x04034b50, 'valid ZIP local header signature');

  // Required-field gate for Excel export
  assert.deepEqual(getMissingExcelFields({ name: 'BCVH A', officeAreaM2: null, contactName: '', contactPhone: '' }), [
    'Diện tích (m²)',
    'Người liên hệ',
    'Số điện thoại',
  ]);
  assert.deepEqual(getMissingExcelFields({ name: 'BCVH A', officeAreaM2: 0, contactName: 'An', contactPhone: '09123' }), [
    'Diện tích (m²)',
  ]);
  assert.equal(validateBcvhForExcelExport([{ id: 1, name: 'BCVH A', officeAreaM2: 120, contactName: 'An', contactPhone: '' }]).ok, false);
  assert.equal(validateBcvhForExcelExport([{ id: 1, name: 'BCVH A', officeAreaM2: 120, contactName: 'An', contactPhone: '0912345678' }]).ok, true);
});
