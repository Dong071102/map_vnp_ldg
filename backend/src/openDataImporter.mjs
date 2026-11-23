import fs from 'node:fs/promises';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { config } from './config.mjs';
import { computeGeoStats } from '../../frontend/js/geometry.js';

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);
const DATA_DIR = path.resolve(__dirname, '..', 'data');

export function getLocalMapBaseUrl() {
  const pub = String(process.env.PUBLIC_BASE_URL || '').trim().replace(/\/+$/, '');
  return pub || `http://localhost:${config.port}`;
}

const WARD_PALETTE = [
  '#2563eb', '#10b981', '#f59e0b', '#8b5cf6',
  '#06b6d4', '#ec4899', '#84cc16', '#f97316',
  '#6366f1', '#14b8a6', '#eab308', '#d946ef',
  '#0284c7', '#16a34a', '#ea580c', '#9333ea',
];

const DISTRICT_COLORS = {
  'Lâm Đồng cũ': '#1e293b',
  'Bình Thuận cũ': '#b91c1c',
  'Đắk Nông cũ': '#7c2d12',
};

export function normalizeAdminName(str) {
  return String(str || '')
    .normalize('NFD')
    .replace(/[\u0300-\u036f]/g, '')
    .replace(/đ/g, 'd')
    .replace(/Đ/g, 'D')
    .replace(/[’'`]/g, "'")
    .replace(/[–—-]/g, ' ')
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, ' ')
    .trim();
}

function closeRing(ring) {
  if (!Array.isArray(ring) || ring.length < 3) return null;
  const pts = ring.map((c) => [Number(c[0]), Number(c[1])]).filter(([x, y]) => Number.isFinite(x) && Number.isFinite(y));
  if (pts.length < 3) return null;
  const first = pts[0];
  const last = pts[pts.length - 1];
  if (first[0] !== last[0] || first[1] !== last[1]) pts.push([first[0], first[1]]);
  return pts.length >= 4 ? pts : null;
}

function wardToFeatureCollection(ward, color) {
  const rings = (ward.polygons || []).map(closeRing).filter(Boolean);
  const geometry =
    rings.length === 1
      ? { type: 'Polygon', coordinates: [rings[0]] }
      : { type: 'MultiPolygon', coordinates: rings.map((r) => [r]) };

  const fullName = `${ward.type} ${ward.name}`.trim();
  return {
    type: 'FeatureCollection',
    features: [
      {
        type: 'Feature',
        properties: {
          ward_code: String(ward.id),
          name: fullName,
          unit_type: ward.type,
          province: 'Tỉnh Lâm Đồng',
          area_official_km2: Number(ward.area) || 0,
          population_2025: Number(ward.population) || 0,
          layer_group: 'ward_2025',
          stroke: color,
          fill: color,
        },
        geometry,
      },
    ],
  };
}

export async function loadOpenDataBundle() {
  const wardsRaw = JSON.parse(await fs.readFile(path.join(DATA_DIR, 'lamdong_wards_2025.json'), 'utf8'));
  const oldDistrictsRaw = JSON.parse(await fs.readFile(path.join(DATA_DIR, 'lamdong_old_districts.geojson'), 'utf8'));

  const baseUrl = getLocalMapBaseUrl();

  const wards = (wardsRaw.wards || []).map((w, idx) => {
    const color = WARD_PALETTE[idx % WARD_PALETTE.length];
    const fullName = `${w.type} ${w.name}`.trim();
    const fc = wardToFeatureCollection(w, color);
    const stats = computeGeoStats(fc, null);
    const mapUrl = `${baseUrl}/api/map/lamdong/ward/${encodeURIComponent(w.id)}`;

    return {
      key: `open-ward-2025-${w.id}`,
      wardCode: String(w.id),
      mapUrl,
      matchKey: normalizeAdminName(fullName),
      layerGroup: 'ward_2025',
      color,
      areaKm2: stats.areaKm2 || Number(w.area) || 0,
      points: stats.points,
      modified: false,
      meta: {
        name: fullName,
        description: `${w.type} thuộc tỉnh Lâm Đồng (2025) · DT chính thức: ${w.area} km² · DS: ${Number(
          w.population || 0,
        ).toLocaleString('vi-VN')}`,
        qid: `VN-${w.id}`,
        osmRelationIds: [],
        source: 'vn-provinces v5.2.0 (original full-res)',
        wikipediaUrl: null,
        wikidataUrl: null,
        directGeoshapeUrl: mapUrl,
      },
      geojson: fc,
      originalGeojson: fc,
    };
  });

  const oldDistricts = (oldDistrictsRaw.features || []).map((f, idx) => {
    const props = f.properties || {};
    const code = props.shapeID || String(idx + 1);
    const color = DISTRICT_COLORS[props.oldProvince] || WARD_PALETTE[(idx + 3) % WARD_PALETTE.length];
    const mapUrl = `${baseUrl}/api/map/lamdong/district/${encodeURIComponent(code)}`;
    const fc = {
      type: 'FeatureCollection',
      features: [
        {
          type: 'Feature',
          properties: {
            ...props,
            layer_group: 'district_old',
            stroke: color,
            fill: color,
          },
          geometry: f.geometry,
        },
      ],
    };
    const stats = computeGeoStats(fc, null);

    return {
      key: `open-district-old-${code}`,
      districtCode: code,
      mapUrl,
      layerGroup: 'district_old',
      color,
      areaKm2: stats.areaKm2,
      points: stats.points,
      modified: false,
      meta: {
        name: props.name || props.shapeName || `Huyện cũ #${idx + 1}`,
        description: `Đơn vị cấp huyện trước sáp nhập 2025 (${props.oldProvince || 'Lâm Đồng'})`,
        qid: null,
        osmRelationIds: [],
        source: 'geoBoundaries VNM ADM2 (CC BY 3.0)',
        wikipediaUrl: null,
        wikidataUrl: null,
        directGeoshapeUrl: mapUrl,
      },
      geojson: fc,
      originalGeojson: fc,
    };
  });

  return { wards, oldDistricts };
}
