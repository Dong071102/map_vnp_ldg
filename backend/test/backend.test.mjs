import test from 'node:test';
import assert from 'node:assert/strict';
import { parseInput, normalizeToFeatureCollection } from '../src/wikiExtractor.mjs';
import { extractMultiPolygonGeometry, geojsonToMultiPolygonWkt } from '../src/db.mjs';
import { loadLamDongUnitsFromLocalFile, normalizeWikiMapUrl } from '../src/lamdongParser.mjs';
import { loadOpenDataBundle } from '../src/openDataImporter.mjs';
import { verifyCredentials, createSession, getSessionFromRequest, destroySession } from '../src/auth.mjs';
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
  destroySession(s.token);
  assert.equal(getSessionFromRequest(fakeReq), null);
});
