import sql from 'mssql';
import { config } from './config.mjs';
import { computeGeoStats } from '../../frontend/js/geometry.js';

let pool = null;
let dbState = {
  connected: false,
  engine: 'SQL Server',
  host: config.db.host,
  port: config.db.port,
  database: config.db.database,
  hasSpatial: true,
  error: null,
};

export function getDbStatus() {
  return { ...dbState };
}

export function extractMultiPolygonGeometry(geojson) {
  if (!geojson || typeof geojson !== 'object') return null;
  const polys = [];

  const collect = (geom) => {
    if (!geom) return;
    if (geom.type === 'Polygon' && Array.isArray(geom.coordinates) && geom.coordinates.length > 0) {
      polys.push(geom.coordinates);
    } else if (geom.type === 'MultiPolygon' && Array.isArray(geom.coordinates)) {
      for (const poly of geom.coordinates) {
        if (Array.isArray(poly) && poly.length > 0) polys.push(poly);
      }
    } else if (geom.type === 'GeometryCollection' && Array.isArray(geom.geometries)) {
      geom.geometries.forEach(collect);
    }
  };

  if (geojson.type === 'FeatureCollection') {
    for (const f of geojson.features || []) collect(f?.geometry);
  } else if (geojson.type === 'Feature') {
    collect(geojson.geometry);
  } else {
    collect(geojson);
  }

  return polys.length > 0 ? { type: 'MultiPolygon', coordinates: polys } : null;
}

/**
 * Convert a GeoJSON FeatureCollection/Feature/Geometry into WKT MULTIPOLYGON for SQL Server GEOMETRY.
 */
export function geojsonToMultiPolygonWkt(geojson) {
  const mp = extractMultiPolygonGeometry(geojson);
  if (!mp) return null;

  const formatRing = (ring) => {
    if (!Array.isArray(ring) || ring.length < 3) return null;
    const pts = ring.map((c) => [Number(c[0]), Number(c[1])]).filter(([x, y]) => Number.isFinite(x) && Number.isFinite(y));
    if (pts.length < 3) return null;
    const first = pts[0];
    const last = pts[pts.length - 1];
    if (first[0] !== last[0] || first[1] !== last[1]) pts.push(first);
    if (pts.length < 4) return null;
    return `(${pts.map(([x, y]) => `${x} ${y}`).join(', ')})`;
  };

  const polyStrs = [];
  for (const poly of mp.coordinates) {
    const ringStrs = poly.map(formatRing).filter(Boolean);
    if (ringStrs.length > 0) polyStrs.push(`(${ringStrs.join(', ')})`);
  }
  return polyStrs.length > 0 ? `MULTIPOLYGON(${polyStrs.join(', ')})` : null;
}

function parseWktRing(ringText) {
  const pts = [];
  for (const pair of ringText.split(',')) {
    const parts = pair.trim().split(/\s+/);
    if (parts.length < 2) continue;
    const x = Math.round(Number(parts[0]) * 1e6) / 1e6;
    const y = Math.round(Number(parts[1]) * 1e6) / 1e6;
    if (Number.isFinite(x) && Number.isFinite(y)) pts.push([x, y]);
  }
  if (pts.length < 3) return null;
  const first = pts[0];
  const last = pts[pts.length - 1];
  if (first[0] !== last[0] || first[1] !== last[1]) pts.push([first[0], first[1]]);
  return pts.length >= 4 ? pts : null;
}

function splitTopLevelGroups(str) {
  const groups = [];
  let depth = 0;
  let start = -1;
  for (let i = 0; i < str.length; i++) {
    const ch = str[i];
    if (ch === '(') {
      if (depth === 0) start = i + 1;
      depth++;
    } else if (ch === ')') {
      depth--;
      if (depth === 0 && start >= 0) {
        groups.push(str.slice(start, i));
        start = -1;
      }
    }
  }
  return groups;
}

/**
 * Parse SQL Server WKT (POLYGON / MULTIPOLYGON / GEOMETRYCOLLECTION) into GeoJSON Polygon or MultiPolygon.
 */
export function wktToGeoJsonGeometry(wkt) {
  if (typeof wkt !== 'string' || !wkt.trim()) return null;
  const polygons = [];

  const parsePolygonBody = (body) => {
    const rings = splitTopLevelGroups(body).map(parseWktRing).filter(Boolean);
    if (rings.length > 0) polygons.push(rings);
  };

  const extractAll = (text) => {
    const trimmed = text.trim();
    const upper = trimmed.toUpperCase();
    if (upper.startsWith('MULTIPOLYGON')) {
      const open = trimmed.indexOf('(');
      const close = trimmed.lastIndexOf(')');
      if (open >= 0 && close > open) {
        const inner = trimmed.slice(open + 1, close);
        for (const polyGroup of splitTopLevelGroups(inner)) parsePolygonBody(polyGroup);
      }
    } else if (upper.startsWith('POLYGON')) {
      const open = trimmed.indexOf('(');
      const close = trimmed.lastIndexOf(')');
      if (open >= 0 && close > open) {
        parsePolygonBody(trimmed.slice(open + 1, close));
      }
    } else if (upper.startsWith('GEOMETRYCOLLECTION')) {
      const open = trimmed.indexOf('(');
      const close = trimmed.lastIndexOf(')');
      if (open >= 0 && close > open) {
        const inner = trimmed.slice(open + 1, close);
        // Split top-level comma-separated WKT items inside GEOMETRYCOLLECTION
        let depth = 0;
        let segStart = 0;
        for (let i = 0; i <= inner.length; i++) {
          const ch = inner[i];
          if (ch === '(') depth++;
          else if (ch === ')') depth--;
          else if ((ch === ',' && depth === 0) || i === inner.length) {
            const part = inner.slice(segStart, i).trim();
            if (part) extractAll(part);
            segStart = i + 1;
          }
        }
      }
    }
  };

  extractAll(wkt);
  if (polygons.length === 0) return null;
  if (polygons.length === 1) return { type: 'Polygon', coordinates: polygons[0] };
  return { type: 'MultiPolygon', coordinates: polygons };
}

function makeSqlConfig(database) {
  return {
    server: config.db.host,
    port: config.db.port,
    user: config.db.user,
    password: config.db.password,
    database,
    connectionTimeout: 8000,
    requestTimeout: 30000,
    pool: { max: 10, min: 0, idleTimeoutMillis: 30000 },
    options: {
      encrypt: config.db.encrypt,
      trustServerCertificate: true,
    },
  };
}

async function ensureDatabaseExists() {
  const safeDbName = config.db.database.replace(/[^a-zA-Z0-9_]/g, '');
  if (!safeDbName || safeDbName !== config.db.database) {
    throw new Error(`Tên database không hợp lệ: "${config.db.database}"`);
  }

  const masterPool = await new sql.ConnectionPool(makeSqlConfig('master')).connect();
  try {
    await masterPool
      .request()
      .input('dbName', sql.NVarChar(128), safeDbName)
      .query(`IF DB_ID(@dbName) IS NULL CREATE DATABASE [${safeDbName}]`);
  } finally {
    await masterPool.close();
  }
}

export async function initDb() {
  if (pool && pool.connected && dbState.connected) return dbState;

  try {
    await ensureDatabaseExists();
    pool = await new sql.ConnectionPool(makeSqlConfig(config.db.database)).connect();

    await pool.request().query(`
      IF OBJECT_ID(N'dbo.admin_regions', N'U') IS NULL
      BEGIN
        CREATE TABLE dbo.admin_regions (
          id               INT IDENTITY(1,1) PRIMARY KEY,
          region_key       NVARCHAR(255) NOT NULL UNIQUE,
          qid              NVARCHAR(32) NULL,
          name             NVARCHAR(255) NOT NULL,
          description      NVARCHAR(MAX) NOT NULL DEFAULT N'',
          osm_relation_id  NVARCHAR(64) NULL,
          source           NVARCHAR(255) NOT NULL DEFAULT N'',
          wikipedia_url    NVARCHAR(1000) NULL,
          wikidata_url     NVARCHAR(500) NULL,
          geoshape_url     NVARCHAR(1000) NULL,
          color            NVARCHAR(16) NOT NULL DEFAULT N'#2563eb',
          area_km2         FLOAT NOT NULL DEFAULT 0,
          points_count     INT NOT NULL DEFAULT 0,
          modified         BIT NOT NULL DEFAULT 0,
          layer_group      NVARCHAR(32) NOT NULL DEFAULT N'ward_2025',
          geojson          NVARCHAR(MAX) NOT NULL,
          original_geojson NVARCHAR(MAX) NOT NULL,
          geom             GEOMETRY NULL,
          created_at       DATETIME2 NOT NULL DEFAULT SYSUTCDATETIME(),
          updated_at       DATETIME2 NOT NULL DEFAULT SYSUTCDATETIME()
        );
      END

      IF COL_LENGTH(N'dbo.admin_regions', N'layer_group') IS NULL
      BEGIN
        ALTER TABLE dbo.admin_regions ADD layer_group NVARCHAR(32) NOT NULL CONSTRAINT DF_admin_regions_layer_group DEFAULT N'ward_2025';
      END

      IF OBJECT_ID(N'dbo.lamdong_admin_units', N'U') IS NULL
      BEGIN
        CREATE TABLE dbo.lamdong_admin_units (
          id                INT IDENTITY(1,1) PRIMARY KEY,
          stt               INT NOT NULL UNIQUE,
          unit_type         NVARCHAR(32) NOT NULL,
          name              NVARCHAR(255) NOT NULL,
          old_district      NVARCHAR(255) NOT NULL DEFAULT N'',
          old_province      NVARCHAR(100) NOT NULL DEFAULT N'',
          wiki_url          NVARCHAR(1000) NOT NULL DEFAULT N'',
          area_official_km2 FLOAT NOT NULL DEFAULT 0,
          population_2025   INT NOT NULL DEFAULT 0,
          sub_units         NVARCHAR(MAX) NOT NULL DEFAULT N'',
          region_id         INT NULL REFERENCES dbo.admin_regions(id) ON DELETE SET NULL,
          sync_status       NVARCHAR(32) NOT NULL DEFAULT N'pending',
          sync_error        NVARCHAR(MAX) NULL,
          synced_at         DATETIME2 NULL,
          updated_at        DATETIME2 NOT NULL DEFAULT SYSUTCDATETIME()
        );
      END

      IF COL_LENGTH(N'dbo.lamdong_admin_units', N'old_district') IS NULL
      BEGIN
        ALTER TABLE dbo.lamdong_admin_units ADD old_district NVARCHAR(255) NOT NULL CONSTRAINT DF_ld_old_district DEFAULT N'';
      END

      IF COL_LENGTH(N'dbo.lamdong_admin_units', N'old_province') IS NULL
      BEGIN
        ALTER TABLE dbo.lamdong_admin_units ADD old_province NVARCHAR(100) NOT NULL CONSTRAINT DF_ld_old_province DEFAULT N'';
      END

      IF OBJECT_ID(N'dbo.bcvh_offices', N'U') IS NULL
      BEGIN
        CREATE TABLE dbo.bcvh_offices (
          id                INT IDENTITY(1,1) PRIMARY KEY,
          code              NVARCHAR(64) NOT NULL DEFAULT N'',
          name              NVARCHAR(255) NOT NULL,
          color             NVARCHAR(16) NOT NULL DEFAULT N'#ea580c',
          ward_unit_ids     NVARCHAR(MAX) NOT NULL DEFAULT N'[]',
          host_unit_id      INT NULL REFERENCES dbo.lamdong_admin_units(id) ON DELETE SET NULL,
          lat               FLOAT NULL,
          lng               FLOAT NULL,
          address           NVARCHAR(500) NOT NULL DEFAULT N'',
          office_area_m2    FLOAT NULL,
          contact_name      NVARCHAR(255) NOT NULL DEFAULT N'',
          contact_phone     NVARCHAR(64) NOT NULL DEFAULT N'',
          service_geojson   NVARCHAR(MAX) NULL,
          service_geom      GEOMETRY NULL,
          computed_area_km2 FLOAT NOT NULL DEFAULT 0,
          created_at        DATETIME2 NOT NULL DEFAULT SYSUTCDATETIME(),
          updated_at        DATETIME2 NOT NULL DEFAULT SYSUTCDATETIME()
        );
      END

      IF COL_LENGTH(N'dbo.bcvh_offices', N'service_geojson') IS NULL
      BEGIN
        ALTER TABLE dbo.bcvh_offices ADD service_geojson NVARCHAR(MAX) NULL;
      END
      IF COL_LENGTH(N'dbo.bcvh_offices', N'service_geom') IS NULL
      BEGIN
        ALTER TABLE dbo.bcvh_offices ADD service_geom GEOMETRY NULL;
      END
      IF COL_LENGTH(N'dbo.bcvh_offices', N'computed_area_km2') IS NULL
      BEGIN
        ALTER TABLE dbo.bcvh_offices ADD computed_area_km2 FLOAT NOT NULL CONSTRAINT DF_bcvh_computed_area DEFAULT 0;
      END
      IF COL_LENGTH(N'dbo.bcvh_offices', N'office_area_m2') IS NULL
      BEGIN
        ALTER TABLE dbo.bcvh_offices ADD office_area_m2 FLOAT NULL;
      END
      IF COL_LENGTH(N'dbo.bcvh_offices', N'contact_name') IS NULL
      BEGIN
        ALTER TABLE dbo.bcvh_offices ADD contact_name NVARCHAR(255) NOT NULL CONSTRAINT DF_bcvh_contact_name DEFAULT N'';
      END
      IF COL_LENGTH(N'dbo.bcvh_offices', N'contact_phone') IS NULL
      BEGIN
        ALTER TABLE dbo.bcvh_offices ADD contact_phone NVARCHAR(64) NOT NULL CONSTRAINT DF_bcvh_contact_phone DEFAULT N'';
      END

      IF OBJECT_ID(N'dbo.ward_streets', N'U') IS NULL
      BEGIN
        CREATE TABLE dbo.ward_streets (
          id           INT IDENTITY(1,1) PRIMARY KEY,
          ward_unit_id INT NOT NULL REFERENCES dbo.lamdong_admin_units(id) ON DELETE CASCADE,
          ward_code    NVARCHAR(32) NOT NULL DEFAULT N'',
          ward_name    NVARCHAR(255) NOT NULL,
          street_key   NVARCHAR(255) NOT NULL,
          street_name  NVARCHAR(255) NOT NULL,
          highway      NVARCHAR(32) NOT NULL DEFAULT N'',
          length_m     INT NOT NULL DEFAULT 0,
          area_km2     FLOAT NOT NULL DEFAULT 0,
          line_geojson NVARCHAR(MAX) NOT NULL,
          zone_geojson NVARCHAR(MAX) NOT NULL,
          zone_geom    GEOMETRY NULL,
          updated_at   DATETIME2 NOT NULL DEFAULT SYSUTCDATETIME()
        );
        CREATE INDEX IX_ward_streets_ward ON dbo.ward_streets(ward_unit_id);
      END

      IF OBJECT_ID(N'dbo.mail_routes', N'U') IS NULL
      BEGIN
        CREATE TABLE dbo.mail_routes (
          id           INT IDENTITY(1,1) PRIMARY KEY,
          ward_unit_id INT NOT NULL REFERENCES dbo.lamdong_admin_units(id) ON DELETE CASCADE,
          name         NVARCHAR(255) NOT NULL,
          code         NVARCHAR(64) NOT NULL DEFAULT N'',
          color        NVARCHAR(16) NOT NULL DEFAULT N'#ea580c',
          street_ids   NVARCHAR(MAX) NOT NULL DEFAULT N'[]',
          street_names NVARCHAR(MAX) NOT NULL DEFAULT N'[]',
          area_km2     FLOAT NOT NULL DEFAULT 0,
          length_m     INT NOT NULL DEFAULT 0,
          points_count INT NOT NULL DEFAULT 0,
          modified     BIT NOT NULL DEFAULT 0,
          geojson      NVARCHAR(MAX) NOT NULL,
          geom         GEOMETRY NULL,
          created_at   DATETIME2 NOT NULL DEFAULT SYSUTCDATETIME(),
          updated_at   DATETIME2 NOT NULL DEFAULT SYSUTCDATETIME()
        );
        CREATE INDEX IX_mail_routes_ward ON dbo.mail_routes(ward_unit_id);
      END
    `);

    dbState = {
      connected: true,
      engine: 'SQL Server',
      host: config.db.host,
      port: config.db.port,
      database: config.db.database,
      hasSpatial: true,
      error: null,
    };
  } catch (err) {
    if (pool) {
      await pool.close().catch(() => {});
      pool = null;
    }
    dbState = {
      connected: false,
      engine: 'SQL Server',
      host: config.db.host,
      port: config.db.port,
      database: config.db.database,
      hasSpatial: false,
      error: err.message,
    };
  }

  return dbState;
}

async function getReadyPool() {
  if (!pool || !pool.connected || !dbState.connected) {
    const state = await initDb();
    if (!state.connected) {
      throw new Error(`Không kết nối được SQL Server (${state.host}:${state.port}/${state.database}): ${state.error}`);
    }
  }
  return pool;
}

function rowToRegionDto(row) {
  const geojson = typeof row.geojson === 'string' ? JSON.parse(row.geojson) : row.geojson;
  const originalGeojson =
    typeof row.original_geojson === 'string' ? JSON.parse(row.original_geojson) : row.original_geojson;

  return {
    id: row.id,
    key: row.region_key,
    layerGroup: row.layer_group || 'ward_2025',
    oldDistrict: row.old_district || '',
    oldProvince: row.old_province || '',
    color: row.color,
    areaKm2: Number(row.area_km2) || 0,
    points: Number(row.points_count) || 0,
    modified: Boolean(row.modified),
    meta: {
      name: row.name,
      description: row.description || '',
      qid: row.qid || null,
      osmRelationIds: row.osm_relation_id ? row.osm_relation_id.split(',').filter(Boolean) : [],
      source: row.source || 'SQL Server',
      wikipediaUrl: row.wikipedia_url || null,
      wikidataUrl: row.wikidata_url || null,
      directGeoshapeUrl: row.geoshape_url || null,
      trace: ['Đã tải từ SQL Server'],
    },
    geojson,
    originalGeojson,
    createdAt: row.created_at,
    updatedAt: row.updated_at,
  };
}

function validateRegionInput(payload) {
  if (!payload || typeof payload !== 'object') {
    throw new Error('Dữ liệu khu vực không hợp lệ.');
  }
  const name = String(payload.meta?.name || payload.name || '').trim();
  if (!name) throw new Error('Thiếu tên khu vực (name).');

  const geojson = payload.geojson;
  if (!geojson || geojson.type !== 'FeatureCollection' || !Array.isArray(geojson.features)) {
    throw new Error(`GeoJSON không hợp lệ cho "${name}".`);
  }

  const qid = payload.meta?.qid ? String(payload.meta.qid).trim() : null;
  const source = String(payload.meta?.source || 'GeoJSON').trim();
  const key = String(payload.key || `${qid || name}::${source}`).trim().slice(0, 255);
  const osmIds = Array.isArray(payload.meta?.osmRelationIds)
    ? payload.meta.osmRelationIds.map(String).join(',').slice(0, 64)
    : null;

  return {
    key,
    qid: qid ? qid.slice(0, 32) : null,
    name: name.slice(0, 255),
    description: String(payload.meta?.description || ''),
    osmRelationId: osmIds || null,
    source: source.slice(0, 255),
    wikipediaUrl: payload.meta?.wikipediaUrl ? String(payload.meta.wikipediaUrl).slice(0, 1000) : null,
    wikidataUrl: payload.meta?.wikidataUrl ? String(payload.meta.wikidataUrl).slice(0, 500) : null,
    geoshapeUrl: payload.meta?.directGeoshapeUrl ? String(payload.meta.directGeoshapeUrl).slice(0, 1000) : null,
    color: /^#[0-9a-fA-F]{6}$/.test(String(payload.color || '')) ? payload.color : '#2563eb',
    areaKm2: Number.isFinite(Number(payload.areaKm2)) ? Number(payload.areaKm2) : 0,
    pointsCount: Number.isFinite(Number(payload.points)) ? Math.round(Number(payload.points)) : 0,
    modified: Boolean(payload.modified),
    layerGroup: ['ward_2025', 'district_old', 'custom'].includes(payload.layerGroup)
      ? payload.layerGroup
      : 'custom',
    geojson,
    originalGeojson: payload.originalGeojson || geojson,
  };
}

const SELECT_COLUMNS = `
  id, region_key, layer_group, qid, name, description, osm_relation_id, source,
  wikipedia_url, wikidata_url, geoshape_url, color, area_km2,
  points_count, modified, geojson, original_geojson, created_at, updated_at
`;

async function runUpsert(requestFactory, input) {
  const wkt = geojsonToMultiPolygonWkt(input.geojson);
  const req = requestFactory();
  req.input('key', sql.NVarChar(255), input.key);
  req.input('layerGroup', sql.NVarChar(32), input.layerGroup);
  req.input('qid', sql.NVarChar(32), input.qid);
  req.input('name', sql.NVarChar(255), input.name);
  req.input('description', sql.NVarChar(sql.MAX), input.description);
  req.input('osmRelationId', sql.NVarChar(64), input.osmRelationId);
  req.input('source', sql.NVarChar(255), input.source);
  req.input('wikipediaUrl', sql.NVarChar(1000), input.wikipediaUrl);
  req.input('wikidataUrl', sql.NVarChar(500), input.wikidataUrl);
  req.input('geoshapeUrl', sql.NVarChar(1000), input.geoshapeUrl);
  req.input('color', sql.NVarChar(16), input.color);
  req.input('areaKm2', sql.Float, input.areaKm2);
  req.input('pointsCount', sql.Int, input.pointsCount);
  req.input('modified', sql.Bit, input.modified ? 1 : 0);
  req.input('geojson', sql.NVarChar(sql.MAX), JSON.stringify(input.geojson));
  req.input('originalGeojson', sql.NVarChar(sql.MAX), JSON.stringify(input.originalGeojson));
  req.input('wkt', sql.NVarChar(sql.MAX), wkt);

  const result = await req.query(`
    DECLARE @geom GEOMETRY = CASE
      WHEN @wkt IS NOT NULL THEN geometry::STGeomFromText(@wkt, 4326).MakeValid()
      ELSE NULL
    END;

    UPDATE dbo.admin_regions WITH (UPDLOCK, SERIALIZABLE)
    SET
      layer_group = @layerGroup,
      qid = @qid,
      name = @name,
      description = @description,
      osm_relation_id = @osmRelationId,
      source = @source,
      wikipedia_url = @wikipediaUrl,
      wikidata_url = @wikidataUrl,
      geoshape_url = @geoshapeUrl,
      color = @color,
      area_km2 = @areaKm2,
      points_count = @pointsCount,
      modified = @modified,
      geojson = @geojson,
      original_geojson = @originalGeojson,
      geom = @geom,
      updated_at = SYSUTCDATETIME()
    WHERE region_key = @key;

    IF @@ROWCOUNT = 0
    BEGIN
      INSERT INTO dbo.admin_regions (
        region_key, layer_group, qid, name, description, osm_relation_id, source,
        wikipedia_url, wikidata_url, geoshape_url, color, area_km2,
        points_count, modified, geojson, original_geojson, geom
      ) VALUES (
        @key, @layerGroup, @qid, @name, @description, @osmRelationId, @source,
        @wikipediaUrl, @wikidataUrl, @geoshapeUrl, @color, @areaKm2,
        @pointsCount, @modified, @geojson, @originalGeojson, @geom
      );
    END

    SELECT ${SELECT_COLUMNS} FROM dbo.admin_regions WHERE region_key = @key;
  `);

  return rowToRegionDto(result.recordset[0]);
}

export async function listRegions() {
  const p = await getReadyPool();
  const result = await p.request().query(`
    SELECT r.id, r.region_key, r.layer_group, r.qid, r.name, r.description, r.osm_relation_id, r.source,
           r.wikipedia_url, r.wikidata_url, r.geoshape_url, r.color, r.area_km2,
           r.points_count, r.modified, r.geojson, r.original_geojson, r.created_at, r.updated_at,
           u.old_district, u.old_province
    FROM dbo.admin_regions r
    OUTER APPLY (
      SELECT TOP 1 old_district, old_province
      FROM dbo.lamdong_admin_units
      WHERE region_id = r.id OR (r.layer_group = N'ward_2025' AND name = r.name)
      ORDER BY CASE WHEN region_id = r.id THEN 0 ELSE 1 END, id ASC
    ) u
    ORDER BY r.id ASC
  `);
  return result.recordset.map(rowToRegionDto);
}

export async function getRegionById(id) {
  const numericId = Number(id);
  if (!Number.isInteger(numericId) || numericId <= 0) return null;
  const p = await getReadyPool();
  const res = await p
    .request()
    .input('id', sql.Int, numericId)
    .query(`SELECT ${SELECT_COLUMNS} FROM dbo.admin_regions WHERE id = @id`);
  return res.recordset[0] ? rowToRegionDto(res.recordset[0]) : null;
}

export async function getRegionByKey(regionKey) {
  const p = await getReadyPool();
  const res = await p
    .request()
    .input('key', sql.NVarChar(255), String(regionKey || '').trim())
    .query(`SELECT ${SELECT_COLUMNS} FROM dbo.admin_regions WHERE region_key = @key`);
  return res.recordset[0] ? rowToRegionDto(res.recordset[0]) : null;
}

export async function listNeighborRegions(regionId, padDeg = 0.03) {
  const numericId = Number(regionId);
  if (!Number.isInteger(numericId) || numericId <= 0) return [];
  const p = await getReadyPool();
  const pad = Math.max(0.005, Math.min(0.25, Number(padDeg) || 0.03));
  const res = await p
    .request()
    .input('id', sql.Int, numericId)
    .input('pad', sql.Float, pad)
    .query(`
      SELECT r.id, r.name, r.layer_group, r.color, r.geojson
      FROM dbo.admin_regions r
      INNER JOIN dbo.admin_regions t ON t.id = @id
      WHERE r.id <> @id
        AND r.layer_group IN (N'ward_2025', N'district_old')
        AND NOT (r.layer_group = t.layer_group AND r.name = t.name)
        AND r.geom IS NOT NULL
        AND t.geom IS NOT NULL
        AND t.geom.STEnvelope().STBuffer(@pad).STIntersects(r.geom) = 1
      ORDER BY r.layer_group ASC, r.name ASC
    `);
  return res.recordset.map((row) => ({
    id: row.id,
    name: row.name,
    layerGroup: row.layer_group || 'ward_2025',
    color: row.color || '#64748b',
    geojson: typeof row.geojson === 'string' ? JSON.parse(row.geojson) : row.geojson,
  }));
}

export async function listOldDistrictRegions() {
  const p = await getReadyPool();
  const res = await p.request().query(`
    SELECT id, region_key, layer_group, qid, name, description, source, geoshape_url,
           color, area_km2, points_count, modified, updated_at
    FROM dbo.admin_regions
    WHERE layer_group = N'district_old'
    ORDER BY name ASC
  `);
  return res.recordset.map((row) => {
    const desc = String(row.description || '');
    let oldProvince = '';
    if (desc.includes('Lâm Đồng cũ')) oldProvince = 'Lâm Đồng cũ';
    else if (desc.includes('Bình Thuận cũ')) oldProvince = 'Bình Thuận cũ';
    else if (desc.includes('Đắk Nông cũ')) oldProvince = 'Đắk Nông cũ';
    return {
      id: row.id,
      key: row.region_key,
      layerGroup: row.layer_group,
      qid: row.qid || null,
      name: row.name,
      description: desc,
      oldProvince,
      source: row.source || '',
      mapUrl: row.geoshape_url || '',
      color: row.color || '#7c2d12',
      areaKm2: Number(row.area_km2) || 0,
      points: Number(row.points_count) || 0,
      modified: Boolean(row.modified),
      updatedAt: row.updated_at,
    };
  });
}

export async function upsertRegion(payload) {
  const input = validateRegionInput(payload);
  const p = await getReadyPool();
  const saved = await runUpsert(() => p.request(), input);
  if (saved.layerGroup === 'ward_2025') {
    await recomputeBcvhZonesForRegionIds([saved.id]).catch(() => {});
  }
  return saved;
}

export async function upsertRegionsBatch(payloads) {
  if (!Array.isArray(payloads) || payloads.length === 0) {
    throw new Error('Danh sách khu vực cần lưu đang rỗng.');
  }
  const validated = payloads.map(validateRegionInput);
  const p = await getReadyPool();
  const tx = new sql.Transaction(p);
  await tx.begin();
  try {
    const saved = [];
    for (const item of validated) {
      saved.push(await runUpsert(() => new sql.Request(tx), item));
    }
    await tx.commit();
    const wardIds = saved.filter((r) => r.layerGroup === 'ward_2025').map((r) => r.id);
    if (wardIds.length > 0) {
      await recomputeBcvhZonesForRegionIds(wardIds).catch(() => {});
    }
    return saved;
  } catch (err) {
    await tx.rollback().catch(() => {});
    throw err;
  }
}

export async function deleteRegion(id) {
  const numericId = Number(id);
  if (!Number.isInteger(numericId) || numericId <= 0) {
    throw new Error('ID khu vực không hợp lệ.');
  }
  const p = await getReadyPool();
  const res = await p.request().input('id', sql.Int, numericId).query('DELETE FROM dbo.admin_regions WHERE id = @id');
  return (res.rowsAffected?.[0] || 0) > 0;
}

export async function deleteAllRegions() {
  const p = await getReadyPool();
  const res = await p.request().query('DELETE FROM dbo.admin_regions');
  return res.rowsAffected?.[0] || 0;
}

// --- Lam Dong 2025 Admin Units (124 commune-level units) ---
function rowToLamDongUnitDto(row) {
  return {
    id: row.id,
    stt: row.stt,
    unitType: row.unit_type,
    name: row.name,
    oldDistrict: row.old_district || '',
    oldProvince: row.old_province || '',
    wikiUrl: row.wiki_url || '',
    areaOfficialKm2: Number(row.area_official_km2) || 0,
    population2025: Number(row.population_2025) || 0,
    subUnits: row.sub_units || '',
    regionId: row.region_id || null,
    hasGeojson: Boolean(row.region_id),
    syncStatus: row.region_id ? 'synced' : row.sync_status || 'pending',
    syncError: row.sync_error || null,
    syncedAt: row.synced_at || null,
    updatedAt: row.updated_at,
    region: row.region_id
      ? {
          id: row.region_id,
          qid: row.region_qid || null,
          source: row.region_source || '',
          color: row.region_color || '#2563eb',
          areaKm2: Number(row.region_area_km2) || 0,
          points: Number(row.region_points) || 0,
          modified: Boolean(row.region_modified),
        }
      : null,
  };
}

const SELECT_LAMDONG_JOIN = `
  SELECT
    u.id, u.stt, u.unit_type, u.name, u.old_district, u.old_province, u.wiki_url,
    u.area_official_km2, u.population_2025, u.sub_units,
    u.region_id, u.sync_status, u.sync_error, u.synced_at, u.updated_at,
    r.qid AS region_qid, r.source AS region_source, r.color AS region_color,
    r.area_km2 AS region_area_km2, r.points_count AS region_points, r.modified AS region_modified
  FROM dbo.lamdong_admin_units u
  LEFT JOIN dbo.admin_regions r ON u.region_id = r.id
`;

export async function listLamDongUnits() {
  const p = await getReadyPool();
  const res = await p.request().query(`${SELECT_LAMDONG_JOIN} ORDER BY u.stt ASC`);
  return res.recordset.map(rowToLamDongUnitDto);
}

export async function getLamDongUnitById(id) {
  const numericId = Number(id);
  if (!Number.isInteger(numericId) || numericId <= 0) {
    throw new Error('ID đơn vị hành chính không hợp lệ.');
  }
  const p = await getReadyPool();
  const res = await p
    .request()
    .input('id', sql.Int, numericId)
    .query(`${SELECT_LAMDONG_JOIN} WHERE u.id = @id`);
  return res.recordset[0] ? rowToLamDongUnitDto(res.recordset[0]) : null;
}

export async function getLamDongUnitByRegionId(regionId) {
  const numericId = Number(regionId);
  if (!Number.isInteger(numericId) || numericId <= 0) return null;
  const p = await getReadyPool();
  const res = await p
    .request()
    .input('regionId', sql.Int, numericId)
    .query(`${SELECT_LAMDONG_JOIN} WHERE u.region_id = @regionId`);
  return res.recordset[0] ? rowToLamDongUnitDto(res.recordset[0]) : null;
}

export async function seedLamDongUnits(units, { overwriteLinks = false } = {}) {
  if (!Array.isArray(units) || units.length === 0) {
    throw new Error('Danh sách đơn vị hành chính trống.');
  }
  const p = await getReadyPool();
  const tx = new sql.Transaction(p);
  await tx.begin();
  try {
    for (const u of units) {
      const req = new sql.Request(tx);
      req.input('stt', sql.Int, u.stt);
      req.input('unitType', sql.NVarChar(32), String(u.unitType || 'Xã').slice(0, 32));
      req.input('name', sql.NVarChar(255), String(u.name || '').slice(0, 255));
      req.input('wikiUrl', sql.NVarChar(1000), String(u.wikiUrl || '').slice(0, 1000));
      req.input('area', sql.Float, Number(u.areaOfficialKm2) || 0);
      req.input('pop', sql.Int, Math.round(Number(u.population2025) || 0));
      req.input('subUnits', sql.NVarChar(sql.MAX), String(u.subUnits || ''));
      req.input('overwrite', sql.Bit, overwriteLinks ? 1 : 0);

      await req.query(`
        UPDATE dbo.lamdong_admin_units
        SET
          unit_type = @unitType,
          name = @name,
          wiki_url = CASE WHEN @overwrite = 1 OR wiki_url = N'' THEN @wikiUrl ELSE wiki_url END,
          area_official_km2 = @area,
          population_2025 = @pop,
          sub_units = @subUnits,
          updated_at = SYSUTCDATETIME()
        WHERE stt = @stt;

        IF @@ROWCOUNT = 0
        BEGIN
          INSERT INTO dbo.lamdong_admin_units (
            stt, unit_type, name, wiki_url, area_official_km2, population_2025, sub_units
          ) VALUES (
            @stt, @unitType, @name, @wikiUrl, @area, @pop, @subUnits
          );
        END
      `);
    }
    await tx.commit();
  } catch (err) {
    await tx.rollback().catch(() => {});
    throw err;
  }
  return listLamDongUnits();
}

export async function updateLamDongUnitFields(id, { wikiUrl, oldDistrict, oldProvince } = {}) {
  const numericId = Number(id);
  if (!Number.isInteger(numericId) || numericId <= 0) {
    throw new Error('ID đơn vị hành chính không hợp lệ.');
  }
  const sets = [];
  const p = await getReadyPool();
  const req = p.request().input('id', sql.Int, numericId);

  if (typeof wikiUrl === 'string') {
    req.input('wikiUrl', sql.NVarChar(1000), wikiUrl.trim().slice(0, 1000));
    sets.push('wiki_url = @wikiUrl', 'sync_error = NULL');
  }
  if (typeof oldDistrict === 'string') {
    req.input('oldDistrict', sql.NVarChar(255), oldDistrict.trim().slice(0, 255));
    sets.push('old_district = @oldDistrict');
  }
  if (typeof oldProvince === 'string') {
    req.input('oldProvince', sql.NVarChar(100), oldProvince.trim().slice(0, 100));
    sets.push('old_province = @oldProvince');
  }
  if (sets.length === 0) {
    return getLamDongUnitById(numericId);
  }
  sets.push('updated_at = SYSUTCDATETIME()');

  const res = await req.query(`UPDATE dbo.lamdong_admin_units SET ${sets.join(', ')} WHERE id = @id`);
  if ((res.rowsAffected?.[0] || 0) === 0) {
    throw new Error('Không tìm thấy đơn vị hành chính.');
  }
  return getLamDongUnitById(numericId);
}

export async function updateLamDongUnitLink(id, wikiUrl) {
  return updateLamDongUnitFields(id, { wikiUrl });
}

export async function markLamDongUnitSyncResult(id, { regionId = null, status = 'synced', error = null }) {
  const numericId = Number(id);
  const p = await getReadyPool();
  await p
    .request()
    .input('id', sql.Int, numericId)
    .input('regionId', sql.Int, regionId)
    .input('status', sql.NVarChar(32), status)
    .input('error', sql.NVarChar(sql.MAX), error ? String(error) : null)
    .query(`
      UPDATE dbo.lamdong_admin_units
      SET
        region_id = COALESCE(@regionId, region_id),
        sync_status = @status,
        sync_error = @error,
        synced_at = CASE WHEN @status = N'synced' THEN SYSUTCDATETIME() ELSE synced_at END,
        updated_at = SYSUTCDATETIME()
      WHERE id = @id
    `);
  return getLamDongUnitById(numericId);
}

/**
 * Spatially match each of the 124 new 2025 communes/wards to its parent old district(s)
 * using SQL Server native GEOMETRY intersection area.
 */
async function populateOldDistrictsWithRunner(requestFactory) {
  const { recordset } = await requestFactory().query(`
    SELECT
      u.id AS unit_id,
      REPLACE(d.name, N' (cũ)', N'') AS district_name,
      d.description AS district_desc,
      w.geom.STIntersection(d.geom).STArea() AS inter_area,
      w.geom.STArea() AS ward_area
    FROM dbo.lamdong_admin_units u
    JOIN dbo.admin_regions w ON u.region_id = w.id AND w.geom IS NOT NULL
    JOIN dbo.admin_regions d ON d.layer_group = N'district_old' AND d.geom IS NOT NULL
    WHERE w.geom.STIntersects(d.geom) = 1
  `);

  const byUnit = new Map();
  for (const row of recordset) {
    if (!byUnit.has(row.unit_id)) byUnit.set(row.unit_id, []);
    byUnit.get(row.unit_id).push(row);
  }

  let updated = 0;
  for (const [unitId, rows] of byUnit.entries()) {
    rows.sort((a, b) => Number(b.inter_area) - Number(a.inter_area));
    const wardArea = Number(rows[0].ward_area) || 0;
    // Keep top district + any secondary old district covering >= 12% of the new ward
    const picked = rows.filter((r, idx) => idx === 0 || (wardArea > 0 && Number(r.inter_area) / wardArea >= 0.12));
    const districtLabel = [...new Set(picked.map((r) => r.district_name))].join(', ');
    const provMatch = String(rows[0].district_desc || '').match(/\(([^)]+)\)/);
    const oldProvince = provMatch ? provMatch[1] : '';

    await requestFactory()
      .input('id', sql.Int, unitId)
      .input('oldDistrict', sql.NVarChar(255), districtLabel.slice(0, 255))
      .input('oldProvince', sql.NVarChar(100), oldProvince.slice(0, 100))
      .query(`
        UPDATE dbo.lamdong_admin_units
        SET old_district = @oldDistrict, old_province = @oldProvince
        WHERE id = @id
      `);
    updated++;
  }
  return updated;
}

export async function backfillLamDongOldDistricts() {
  const p = await getReadyPool();
  return populateOldDistrictsWithRunner(() => p.request());
}

export async function replaceAllWithOpenData({ wards, oldDistricts }, normalizeNameFn) {
  const p = await getReadyPool();
  const tx = new sql.Transaction(p);
  await tx.begin();
  try {
    // 1. Wipe all legacy Wikipedia/custom GeoJSON from admin_regions
    await new sql.Request(tx).query(`
      UPDATE dbo.lamdong_admin_units
      SET region_id = NULL, sync_status = N'pending', sync_error = NULL, synced_at = NULL;
      DELETE FROM dbo.admin_regions;
    `);

    // 2. Load existing 124 Lam Dong table rows to match & link region_id
    const unitRows = (
      await new sql.Request(tx).query('SELECT id, stt, name FROM dbo.lamdong_admin_units')
    ).recordset;
    const unitByNorm = new Map(unitRows.map((row) => [normalizeNameFn(row.name), row]));

    let linkedUnits = 0;
    for (const w of wards) {
      const saved = await runUpsert(() => new sql.Request(tx), validateRegionInput(w));
      const matched = unitByNorm.get(w.matchKey);
      if (matched) {
        await new sql.Request(tx)
          .input('id', sql.Int, matched.id)
          .input('regionId', sql.Int, saved.id)
          .input('mapUrl', sql.NVarChar(1000), w.mapUrl || '')
          .query(`
            UPDATE dbo.lamdong_admin_units
            SET region_id = @regionId, wiki_url = @mapUrl,
                sync_status = N'synced', sync_error = NULL,
                synced_at = SYSUTCDATETIME(), updated_at = SYSUTCDATETIME()
            WHERE id = @id
          `);
        linkedUnits++;
      }
    }

    for (const d of oldDistricts) {
      await runUpsert(() => new sql.Request(tx), validateRegionInput(d));
    }

    // 3. Spatially populate old_district & old_province for all 124 units using SQL Server GEOMETRY
    const matchedOldDistricts = await populateOldDistrictsWithRunner(() => new sql.Request(tx));

    await tx.commit();
    await recomputeAllBcvhZones().catch(() => {});
    return {
      wardsCount: wards.length,
      oldDistrictsCount: oldDistricts.length,
      linkedUnits,
      matchedOldDistricts,
      totalRegions: wards.length + oldDistricts.length,
    };
  } catch (err) {
    await tx.rollback().catch(() => {});
    throw err;
  }
}

// --- BCVH (Bưu cục Vận hành) Operations ---
function validateBcvhInput(payload) {
  if (!payload || typeof payload !== 'object') {
    throw new Error('Dữ liệu Bưu cục Vận hành không hợp lệ.');
  }
  const name = String(payload.name || '').trim();
  if (!name) throw new Error('Vui lòng nhập tên Bưu cục Vận hành.');

  const code = String(payload.code || '').trim().slice(0, 64);
  const color = /^#[0-9a-fA-F]{6}$/.test(String(payload.color || '')) ? payload.color : '#ea580c';
  const address = String(payload.address || '').trim().slice(0, 500);
  const contactName = String(payload.contactName || '').trim().slice(0, 255);
  const contactPhone = String(payload.contactPhone || '').trim().slice(0, 64);

  if (payload.officeAreaM2 === '' || payload.officeAreaM2 == null) {
    throw new Error('Vui lòng nhập Diện tích (m²).');
  }
  const parsedArea = Number(String(payload.officeAreaM2).replace(',', '.'));
  if (!Number.isFinite(parsedArea) || parsedArea <= 0) {
    throw new Error('Diện tích (m²) không hợp lệ (phải là số lớn hơn 0).');
  }
  const officeAreaM2 = Math.round(parsedArea * 100) / 100;

  if (!contactName) {
    throw new Error('Vui lòng nhập Người liên hệ.');
  }
  if (!contactPhone) {
    throw new Error('Vui lòng nhập Số điện thoại.');
  }

  const rawIds = Array.isArray(payload.wardUnitIds) ? payload.wardUnitIds : [];
  const wardUnitIds = [...new Set(rawIds.map(Number).filter((n) => Number.isInteger(n) && n > 0))];

  const rawHost = payload.hostUnitId === '' || payload.hostUnitId == null ? null : Number(payload.hostUnitId);
  const hostUnitId = Number.isInteger(rawHost) && rawHost > 0 ? rawHost : null;

  const parseCoord = (v, min, max, label) => {
    if (v === '' || v == null) return null;
    const n = Number(v);
    if (!Number.isFinite(n) || n < min || n > max) {
      throw new Error(`${label} không hợp lệ (phải nằm trong khoảng ${min} đến ${max}).`);
    }
    return Math.round(n * 1e6) / 1e6;
  };

  const lat = parseCoord(payload.lat, -90, 90, 'Vĩ độ (Lat)');
  const lng = parseCoord(payload.lng, -180, 180, 'Kinh độ (Lng)');
  if ((lat !== null && lng === null) || (lat === null && lng !== null)) {
    throw new Error('Vui lòng nhập đầy đủ cả Vĩ độ (Lat) và Kinh độ (Lng), hoặc để trống cả hai.');
  }
  if (!hostUnitId && lat === null && wardUnitIds.length === 0) {
    throw new Error('Vui lòng chọn ít nhất 1 xã phục vụ hoặc nhập tọa độ vị trí BCVH.');
  }

  return {
    code,
    name: name.slice(0, 255),
    color,
    wardUnitIds,
    hostUnitId,
    lat,
    lng,
    address,
    officeAreaM2,
    contactName,
    contactPhone,
  };
}

function hydrateBcvhRow(row, unitById) {
  let wardUnitIds = [];
  try {
    const parsed = JSON.parse(row.ward_unit_ids || '[]');
    if (Array.isArray(parsed)) wardUnitIds = parsed.map(Number).filter((n) => Number.isInteger(n) && n > 0);
  } catch {
    wardUnitIds = [];
  }

  const wardRegionIds = [];
  const wardNames = [];
  let totalAreaKm2 = 0;
  let totalPop2025 = 0;
  for (const uid of wardUnitIds) {
    const u = unitById.get(uid);
    if (!u) continue;
    if (u.region_id) wardRegionIds.push(u.region_id);
    wardNames.push(u.name);
    totalAreaKm2 += Number(u.area_official_km2) || 0;
    totalPop2025 += Number(u.population_2025) || 0;
  }

  const hostUnit = row.host_unit_id ? unitById.get(row.host_unit_id) : null;

  let serviceGeojson = null;
  if (row.service_geojson) {
    try {
      serviceGeojson = typeof row.service_geojson === 'string' ? JSON.parse(row.service_geojson) : row.service_geojson;
    } catch {
      serviceGeojson = null;
    }
  }

  return {
    id: row.id,
    code: row.code || '',
    name: row.name,
    color: row.color || '#ea580c',
    wardUnitIds,
    wardRegionIds,
    wardNames,
    hostUnitId: row.host_unit_id || null,
    hostRegionId: hostUnit?.region_id || null,
    hostWardName: hostUnit?.name || '',
    lat: row.lat !== null && row.lat !== undefined ? Number(row.lat) : null,
    lng: row.lng !== null && row.lng !== undefined ? Number(row.lng) : null,
    address: row.address || '',
    officeAreaM2: row.office_area_m2 !== null && row.office_area_m2 !== undefined ? Number(row.office_area_m2) : null,
    contactName: row.contact_name || '',
    contactPhone: row.contact_phone || '',
    totalAreaKm2: Math.round(totalAreaKm2 * 100) / 100,
    computedAreaKm2: Number(row.computed_area_km2) || 0,
    totalPop2025,
    serviceGeojson,
    createdAt: row.created_at,
    updatedAt: row.updated_at,
  };
}

async function computeAndPersistBcvhZone(p, row, unitMap) {
  let wardUnitIds = [];
  try {
    const parsed = JSON.parse(row.ward_unit_ids || '[]');
    if (Array.isArray(parsed)) wardUnitIds = parsed.map(Number).filter((n) => Number.isInteger(n) && n > 0);
  } catch {
    wardUnitIds = [];
  }

  const regionIds = [];
  for (const uid of wardUnitIds) {
    const u = unitMap.get(uid);
    if (u?.region_id) regionIds.push(u.region_id);
  }

  if (regionIds.length === 0) {
    await p
      .request()
      .input('id', sql.Int, row.id)
      .query(`
        UPDATE dbo.bcvh_offices
        SET service_geojson = NULL, service_geom = NULL, computed_area_km2 = 0
        WHERE id = @id
      `);
    return { ...row, service_geojson: null, computed_area_km2: 0 };
  }

  const req = p.request();
  const params = regionIds.map((rid, idx) => {
    const pname = `r${idx}`;
    req.input(pname, sql.Int, rid);
    return `@${pname}`;
  });

  // Dissolve shared ward borders into 1 clean service-area boundary using SQL Server GEOMETRY::UnionAggregate
  let mergedGeom = null;
  let unionWkt = null;
  try {
    const uRes = await req.query(`
      SELECT geometry::UnionAggregate(
        CASE WHEN geom.STIsValid() = 1 THEN geom ELSE geom.MakeValid() END
      ).MakeValid().STAsText() AS union_wkt
      FROM dbo.admin_regions
      WHERE id IN (${params.join(', ')}) AND geom IS NOT NULL
    `);
    unionWkt = uRes.recordset[0]?.union_wkt || null;
    if (unionWkt) mergedGeom = wktToGeoJsonGeometry(unionWkt);
  } catch {
    mergedGeom = null;
  }

  // Graceful fallback: combine raw GeoJSON polygons if UnionAggregate had no valid geom
  if (!mergedGeom) {
    const fallbackReq = p.request();
    const fParams = regionIds.map((rid, idx) => {
      const pname = `f${idx}`;
      fallbackReq.input(pname, sql.Int, rid);
      return `@${pname}`;
    });
    const rawRes = await fallbackReq.query(`SELECT geojson FROM dbo.admin_regions WHERE id IN (${fParams.join(', ')})`);
    const polys = [];
    for (const r of rawRes.recordset) {
      try {
        const gj = typeof r.geojson === 'string' ? JSON.parse(r.geojson) : r.geojson;
        const mp = extractMultiPolygonGeometry(gj);
        if (mp) polys.push(...mp.coordinates);
      } catch {
        // ignore invalid row
      }
    }
    if (polys.length === 1) mergedGeom = { type: 'Polygon', coordinates: polys[0] };
    else if (polys.length > 1) mergedGeom = { type: 'MultiPolygon', coordinates: polys };
  }

  if (!mergedGeom) {
    return { ...row, service_geojson: null, computed_area_km2: 0 };
  }

  const hostUnit = row.host_unit_id ? unitMap.get(row.host_unit_id) : null;
  const serviceFc = {
    type: 'FeatureCollection',
    features: [
      {
        type: 'Feature',
        properties: {
          bcvh_id: row.id,
          code: row.code || '',
          name: row.name,
          host_ward: hostUnit?.name || '',
          ward_count: wardUnitIds.length,
          layer_group: 'bcvh',
          stroke: row.color || '#ea580c',
          fill: row.color || '#ea580c',
        },
        geometry: mergedGeom,
      },
    ],
  };

  const stats = computeGeoStats(serviceFc, null);
  const serialized = JSON.stringify(serviceFc);
  const persistWkt = unionWkt || geojsonToMultiPolygonWkt(serviceFc);

  await p
    .request()
    .input('id', sql.Int, row.id)
    .input('serviceGeojson', sql.NVarChar(sql.MAX), serialized)
    .input('wkt', sql.NVarChar(sql.MAX), persistWkt)
    .input('areaKm2', sql.Float, stats.areaKm2)
    .query(`
      DECLARE @g GEOMETRY = NULL;
      IF @wkt IS NOT NULL
      BEGIN
        BEGIN TRY
          SET @g = geometry::STGeomFromText(@wkt, 4326);
          IF @g.STIsValid() = 0 SET @g = @g.MakeValid();
        END TRY
        BEGIN CATCH
          SET @g = NULL;
        END CATCH
      END

      UPDATE dbo.bcvh_offices
      SET service_geojson = @serviceGeojson,
          service_geom = @g,
          computed_area_km2 = @areaKm2
      WHERE id = @id
    `);

  return {
    ...row,
    service_geojson: serialized,
    computed_area_km2: stats.areaKm2,
  };
}

export async function recomputeBcvhZonesForRegionIds(regionIds = []) {
  const cleanRegionIds = new Set(regionIds.map(Number).filter((n) => Number.isInteger(n) && n > 0));
  if (cleanRegionIds.size === 0) return 0;

  const p = await getReadyPool();
  const unitMap = await loadUnitLookupMap(p);
  const affectedUnitIds = new Set();
  for (const [uid, u] of unitMap.entries()) {
    if (u.region_id && cleanRegionIds.has(u.region_id)) affectedUnitIds.add(uid);
  }
  if (affectedUnitIds.size === 0) return 0;

  const officesRes = await p.request().query(`
    SELECT id, code, name, color, ward_unit_ids, host_unit_id, lat, lng, address,
           service_geojson, computed_area_km2, created_at, updated_at
    FROM dbo.bcvh_offices
  `);

  let updated = 0;
  for (const row of officesRes.recordset) {
    let ids = [];
    try {
      ids = JSON.parse(row.ward_unit_ids || '[]');
    } catch {
      ids = [];
    }
    if (Array.isArray(ids) && ids.some((uid) => affectedUnitIds.has(Number(uid)))) {
      await computeAndPersistBcvhZone(p, row, unitMap);
      updated++;
    }
  }
  return updated;
}

export async function recomputeAllBcvhZones() {
  const p = await getReadyPool();
  const unitMap = await loadUnitLookupMap(p);
  const officesRes = await p.request().query(`
    SELECT id, code, name, color, ward_unit_ids, host_unit_id, lat, lng, address,
           service_geojson, computed_area_km2, created_at, updated_at
    FROM dbo.bcvh_offices
  `);
  for (const row of officesRes.recordset) {
    await computeAndPersistBcvhZone(p, row, unitMap);
  }
  return officesRes.recordset.length;
}

async function loadUnitLookupMap(p) {
  const res = await p.request().query(`
    SELECT id, name, region_id, area_official_km2, population_2025
    FROM dbo.lamdong_admin_units
  `);
  return new Map(res.recordset.map((u) => [u.id, u]));
}

async function findWardUnitByPointWithPool(p, lat, lng) {
  if (!Number.isFinite(lat) || !Number.isFinite(lng)) return null;
  const res = await p
    .request()
    .input('lng', sql.Float, lng)
    .input('lat', sql.Float, lat)
    .query(`
      DECLARE @pt GEOMETRY = geometry::Point(@lng, @lat, 4326);
      SELECT TOP 1 u.id, u.name, u.old_district, u.old_province, u.region_id
      FROM dbo.lamdong_admin_units u
      INNER JOIN dbo.admin_regions r ON r.id = u.region_id
      WHERE r.layer_group = N'ward_2025'
        AND r.geom IS NOT NULL
        AND r.geom.STIntersects(@pt) = 1
      ORDER BY u.id ASC;
    `);
  if (res.recordset[0]) {
    const r = res.recordset[0];
    return { id: r.id, name: r.name, oldDistrict: r.old_district || '', oldProvince: r.old_province || '', regionId: r.region_id };
  }
  // Fallback if point is slightly on the boundary edge (within ~500m)
  const nearRes = await p
    .request()
    .input('lng', sql.Float, lng)
    .input('lat', sql.Float, lat)
    .query(`
      DECLARE @pt GEOMETRY = geometry::Point(@lng, @lat, 4326);
      SELECT TOP 1 u.id, u.name, u.old_district, u.old_province, u.region_id, r.geom.STDistance(@pt) AS dist
      FROM dbo.lamdong_admin_units u
      INNER JOIN dbo.admin_regions r ON r.id = u.region_id
      WHERE r.layer_group = N'ward_2025'
        AND r.geom IS NOT NULL
        AND r.geom.STDistance(@pt) <= 0.005
      ORDER BY r.geom.STDistance(@pt) ASC;
    `);
  if (nearRes.recordset[0]) {
    const r = nearRes.recordset[0];
    return { id: r.id, name: r.name, oldDistrict: r.old_district || '', oldProvince: r.old_province || '', regionId: r.region_id };
  }
  return null;
}

export async function findWardUnitByCoords(lat, lng) {
  const nLat = Number(lat);
  const nLng = Number(lng);
  if (!Number.isFinite(nLat) || !Number.isFinite(nLng)) return null;
  const p = await getReadyPool();
  return findWardUnitByPointWithPool(p, nLat, nLng);
}

export async function listBcvhOffices() {
  const p = await getReadyPool();
  const [officesRes, unitMap] = await Promise.all([
    p.request().query(`
      SELECT id, code, name, color, ward_unit_ids, host_unit_id, lat, lng, address,
             office_area_m2, contact_name, contact_phone,
             service_geojson, computed_area_km2, created_at, updated_at
      FROM dbo.bcvh_offices
      ORDER BY id ASC
    `),
    loadUnitLookupMap(p),
  ]);

  const hydrated = [];
  for (const row of officesRes.recordset) {
    let targetRow = row;
    // Auto-detect exact host ward from coordinates if lat/lng is provided but host_unit_id was empty
    if (!targetRow.host_unit_id && targetRow.lat !== null && targetRow.lng !== null) {
      const located = await findWardUnitByPointWithPool(p, Number(targetRow.lat), Number(targetRow.lng)).catch(() => null);
      if (located) {
        await p
          .request()
          .input('id', sql.Int, targetRow.id)
          .input('hostUnitId', sql.Int, located.id)
          .query('UPDATE dbo.bcvh_offices SET host_unit_id = @hostUnitId WHERE id = @id');
        targetRow = { ...targetRow, host_unit_id: located.id };
      }
    }
    if (!targetRow.service_geojson && targetRow.ward_unit_ids && targetRow.ward_unit_ids !== '[]') {
      targetRow = await computeAndPersistBcvhZone(p, targetRow, unitMap);
    }
    hydrated.push(hydrateBcvhRow(targetRow, unitMap));
  }
  return hydrated;
}

export async function getBcvhOfficeById(id) {
  const numericId = Number(id);
  if (!Number.isInteger(numericId) || numericId <= 0) return null;
  const p = await getReadyPool();
  const [res, unitMap] = await Promise.all([
    p
      .request()
      .input('id', sql.Int, numericId)
      .query(`
        SELECT id, code, name, color, ward_unit_ids, host_unit_id, lat, lng, address,
               office_area_m2, contact_name, contact_phone,
               service_geojson, computed_area_km2, created_at, updated_at
        FROM dbo.bcvh_offices
        WHERE id = @id
      `),
    loadUnitLookupMap(p),
  ]);
  if (!res.recordset[0]) return null;
  let row = res.recordset[0];
  if (!row.service_geojson && row.ward_unit_ids && row.ward_unit_ids !== '[]') {
    row = await computeAndPersistBcvhZone(p, row, unitMap);
  }
  return hydrateBcvhRow(row, unitMap);
}

export async function createBcvhOffice(payload) {
  const input = validateBcvhInput(payload);
  const p = await getReadyPool();
  let resolvedHostUnitId = input.hostUnitId;
  if (input.lat !== null && input.lng !== null) {
    const located = await findWardUnitByPointWithPool(p, input.lat, input.lng).catch(() => null);
    if (located) resolvedHostUnitId = located.id;
  }
  const res = await p
    .request()
    .input('code', sql.NVarChar(64), input.code)
    .input('name', sql.NVarChar(255), input.name)
    .input('color', sql.NVarChar(16), input.color)
    .input('wardUnitIds', sql.NVarChar(sql.MAX), JSON.stringify(input.wardUnitIds))
    .input('hostUnitId', sql.Int, resolvedHostUnitId)
    .input('lat', sql.Float, input.lat)
    .input('lng', sql.Float, input.lng)
    .input('address', sql.NVarChar(500), input.address)
    .input('officeAreaM2', sql.Float, input.officeAreaM2)
    .input('contactName', sql.NVarChar(255), input.contactName)
    .input('contactPhone', sql.NVarChar(64), input.contactPhone)
    .query(`
      INSERT INTO dbo.bcvh_offices (
        code, name, color, ward_unit_ids, host_unit_id, lat, lng, address,
        office_area_m2, contact_name, contact_phone
      )
      OUTPUT INSERTED.*
      VALUES (
        @code, @name, @color, @wardUnitIds, @hostUnitId, @lat, @lng, @address,
        @officeAreaM2, @contactName, @contactPhone
      )
    `);
  const unitMap = await loadUnitLookupMap(p);
  const computedRow = await computeAndPersistBcvhZone(p, res.recordset[0], unitMap);
  return hydrateBcvhRow(computedRow, unitMap);
}

export async function updateBcvhOffice(id, payload) {
  const numericId = Number(id);
  if (!Number.isInteger(numericId) || numericId <= 0) {
    throw new Error('ID Bưu cục Vận hành không hợp lệ.');
  }
  const input = validateBcvhInput(payload);
  const p = await getReadyPool();
  let resolvedHostUnitId = input.hostUnitId;
  if (input.lat !== null && input.lng !== null) {
    const located = await findWardUnitByPointWithPool(p, input.lat, input.lng).catch(() => null);
    if (located) resolvedHostUnitId = located.id;
  }
  const res = await p
    .request()
    .input('id', sql.Int, numericId)
    .input('code', sql.NVarChar(64), input.code)
    .input('name', sql.NVarChar(255), input.name)
    .input('color', sql.NVarChar(16), input.color)
    .input('wardUnitIds', sql.NVarChar(sql.MAX), JSON.stringify(input.wardUnitIds))
    .input('hostUnitId', sql.Int, resolvedHostUnitId)
    .input('lat', sql.Float, input.lat)
    .input('lng', sql.Float, input.lng)
    .input('address', sql.NVarChar(500), input.address)
    .input('officeAreaM2', sql.Float, input.officeAreaM2)
    .input('contactName', sql.NVarChar(255), input.contactName)
    .input('contactPhone', sql.NVarChar(64), input.contactPhone)
    .query(`
      UPDATE dbo.bcvh_offices
      SET code = @code,
          name = @name,
          color = @color,
          ward_unit_ids = @wardUnitIds,
          host_unit_id = @hostUnitId,
          lat = @lat,
          lng = @lng,
          address = @address,
          office_area_m2 = @officeAreaM2,
          contact_name = @contactName,
          contact_phone = @contactPhone,
          updated_at = SYSUTCDATETIME()
      OUTPUT INSERTED.*
      WHERE id = @id
    `);
  if (!res.recordset[0]) throw new Error('Không tìm thấy Bưu cục Vận hành.');
  const unitMap = await loadUnitLookupMap(p);
  const computedRow = await computeAndPersistBcvhZone(p, res.recordset[0], unitMap);
  return hydrateBcvhRow(computedRow, unitMap);
}

export async function deleteBcvhOffice(id) {
  const numericId = Number(id);
  if (!Number.isInteger(numericId) || numericId <= 0) {
    throw new Error('ID Bưu cục Vận hành không hợp lệ.');
  }
  const p = await getReadyPool();
  const res = await p.request().input('id', sql.Int, numericId).query('DELETE FROM dbo.bcvh_offices WHERE id = @id');
  return (res.rowsAffected?.[0] || 0) > 0;
}

export async function listWardStreetSummaries() {
  const p = await getReadyPool();
  const res = await p.request().query(`
    SELECT u.id AS wardUnitId,
           u.stt,
           u.name AS wardName,
           u.unit_type AS unitType,
           u.old_district AS oldDistrict,
           u.area_official_km2 AS areaOfficialKm2,
           COUNT(s.id) AS streetCount,
           ISNULL(SUM(s.length_m), 0) AS totalLengthM
    FROM dbo.lamdong_admin_units u
    LEFT JOIN dbo.ward_streets s ON s.ward_unit_id = u.id
    GROUP BY u.id, u.stt, u.name, u.unit_type, u.old_district, u.area_official_km2
    ORDER BY u.stt ASC
  `);
  return res.recordset.map((r) => ({
    wardUnitId: r.wardUnitId,
    stt: r.stt,
    wardName: r.wardName,
    unitType: r.unitType,
    oldDistrict: r.oldDistrict || '',
    areaOfficialKm2: Number(r.areaOfficialKm2) || 0,
    streetCount: Number(r.streetCount) || 0,
    totalLengthM: Number(r.totalLengthM) || 0,
  }));
}

export async function getWardStreetsBundle(wardUnitId) {
  const numericId = Number(wardUnitId);
  if (!Number.isInteger(numericId) || numericId <= 0) return null;
  const p = await getReadyPool();
  const [wardRes, streetsRes] = await Promise.all([
    p
      .request()
      .input('id', sql.Int, numericId)
      .query(`
        SELECT u.id, u.stt, u.name, u.old_district, u.area_official_km2, r.area_km2, r.geojson
        FROM dbo.lamdong_admin_units u
        LEFT JOIN dbo.admin_regions r ON r.id = u.region_id
        WHERE u.id = @id
      `),
    p
      .request()
      .input('id', sql.Int, numericId)
      .query(`
        SELECT id, street_name, highway, length_m, area_km2, line_geojson, zone_geojson
        FROM dbo.ward_streets
        WHERE ward_unit_id = @id
        ORDER BY street_name ASC
      `),
  ]);

  const w = wardRes.recordset[0];
  if (!w) return null;
  let wardGeojson = null;
  try {
    wardGeojson = w.geojson ? JSON.parse(w.geojson) : null;
  } catch {
    wardGeojson = null;
  }

  const streets = streetsRes.recordset.map((s) => ({
    id: s.id,
    name: s.street_name,
    highway: s.highway || '',
    lengthM: Number(s.length_m) || 0,
    areaKm2: Number(s.area_km2) || 0,
    lineGeojson: JSON.parse(s.line_geojson),
    zoneGeojson: JSON.parse(s.zone_geojson),
  }));

  return {
    ward: {
      id: w.id,
      stt: w.stt,
      name: w.name,
      oldDistrict: w.old_district || '',
      areaKm2: Math.round((Number(w.area_km2) || Number(w.area_official_km2) || 0) * 100) / 100,
      geojson: wardGeojson,
    },
    streetCount: streets.length,
    streets,
  };
}

export async function mergeWardStreetsByIds(streetIds = []) {
  const cleanIds = [...new Set(streetIds.map(Number).filter((n) => Number.isInteger(n) && n > 0))];
  if (cleanIds.length === 0) return null;
  const p = await getReadyPool();
  const res = await p
    .request()
    .input('idsJson', sql.NVarChar(sql.MAX), JSON.stringify(cleanIds))
    .query(`
      WITH picked AS (
        SELECT s.id, s.street_name, s.length_m, s.zone_geom
        FROM dbo.ward_streets s
        INNER JOIN OPENJSON(@idsJson) j ON s.id = TRY_CAST(j.value AS INT)
      )
      SELECT
        (SELECT id, street_name AS name, length_m AS lengthM FROM picked ORDER BY street_name ASC FOR JSON PATH) AS metaJson,
        (
          SELECT geometry::UnionAggregate(zone_geom.MakeValid().STBuffer(0.000008))
            .STBuffer(-0.000008)
            .Reduce(0.000005)
            .MakeValid()
            .STAsText()
          FROM picked
          WHERE zone_geom IS NOT NULL
        ) AS wkt;
    `);

  const row = res.recordset[0];
  if (!row?.wkt) return null;
  const geom = wktToGeoJsonGeometry(row.wkt);
  if (!geom) return null;

  const metaList = row.metaJson ? JSON.parse(row.metaJson) : [];
  const fc = { type: 'FeatureCollection', features: [{ type: 'Feature', properties: {}, geometry: geom }] };
  const stats = computeGeoStats(fc, null);
  const polygonParts = geom.type === 'MultiPolygon' ? geom.coordinates.length : 1;

  return {
    streetIds: metaList.map((m) => m.id),
    streetNames: metaList.map((m) => m.name),
    totalLengthM: metaList.reduce((acc, m) => acc + (Number(m.lengthM) || 0), 0),
    geometry: geom,
    areaKm2: Math.round(stats.areaKm2 * 10000) / 10000,
    points: stats.points,
    polygonParts,
    oneLineGeojson: JSON.stringify(geom),
  };
}

export async function unionGeoJsonGeometries(geometries = []) {
  const wkts = geometries
    .map((g) => geojsonToMultiPolygonWkt(g))
    .filter(Boolean);
  if (wkts.length === 0) return null;

  const p = await getReadyPool();
  const res = await p
    .request()
    .input('wktsJson', sql.NVarChar(sql.MAX), JSON.stringify(wkts))
    .query(`
      DECLARE @u GEOMETRY;
      SELECT @u = geometry::UnionAggregate(geometry::STGeomFromText(value, 4326).MakeValid().STBuffer(0.000008))
      FROM OPENJSON(@wktsJson);
      IF @u IS NOT NULL
      BEGIN
        SET @u = @u.STBuffer(-0.000008).Reduce(0.000005).MakeValid();
      END
      SELECT CASE WHEN @u IS NOT NULL AND @u.STIsEmpty() = 0 THEN @u.STAsText() ELSE NULL END AS wkt;
    `);
  const mergedWkt = res.recordset[0]?.wkt;
  if (!mergedWkt) return null;
  const geom = wktToGeoJsonGeometry(mergedWkt);
  if (!geom) return null;

  const fc = { type: 'FeatureCollection', features: [{ type: 'Feature', properties: {}, geometry: geom }] };
  const stats = computeGeoStats(fc, null);
  const polygonParts = geom.type === 'MultiPolygon' ? geom.coordinates.length : 1;
  return {
    geometry: geom,
    areaKm2: Math.round(stats.areaKm2 * 10000) / 10000,
    points: stats.points,
    polygonParts,
  };
}

// --- Mail Routes (Tuyến đường thư) CRUD ---
function hydrateMailRouteRow(row) {
  let streetIds = [];
  let streetNames = [];
  let geojson = null;
  try {
    const parsed = JSON.parse(row.street_ids || '[]');
    if (Array.isArray(parsed)) streetIds = parsed.map(Number).filter((n) => Number.isInteger(n) && n > 0);
  } catch {
    streetIds = [];
  }
  try {
    const parsed = JSON.parse(row.street_names || '[]');
    if (Array.isArray(parsed)) streetNames = parsed.map(String);
  } catch {
    streetNames = [];
  }
  try {
    geojson = typeof row.geojson === 'string' ? JSON.parse(row.geojson) : row.geojson;
  } catch {
    geojson = null;
  }
  return {
    id: row.id,
    wardUnitId: row.ward_unit_id,
    wardName: row.ward_name || '',
    name: row.name,
    code: row.code || '',
    color: row.color || '#ea580c',
    streetIds,
    streetNames,
    areaKm2: Math.round((Number(row.area_km2) || 0) * 10000) / 10000,
    lengthM: Number(row.length_m) || 0,
    points: Number(row.points_count) || 0,
    modified: Boolean(row.modified),
    geojson,
    createdAt: row.created_at,
    updatedAt: row.updated_at,
  };
}

export async function listMailRoutes(wardUnitId = null) {
  const p = await getReadyPool();
  const req = p.request();
  let whereSql = '';
  if (wardUnitId !== null && wardUnitId !== undefined && wardUnitId !== '') {
    const numericId = Number(wardUnitId);
    if (!Number.isInteger(numericId) || numericId <= 0) return [];
    req.input('wardUnitId', sql.Int, numericId);
    whereSql = 'WHERE m.ward_unit_id = @wardUnitId';
  }
  const res = await req.query(`
    SELECT m.id, m.ward_unit_id, u.name AS ward_name, m.name, m.code, m.color,
           m.street_ids, m.street_names, m.area_km2, m.length_m, m.points_count,
           m.modified, m.geojson, m.created_at, m.updated_at
    FROM dbo.mail_routes m
    INNER JOIN dbo.lamdong_admin_units u ON u.id = m.ward_unit_id
    ${whereSql}
    ORDER BY m.id DESC
  `);
  return res.recordset.map(hydrateMailRouteRow);
}

export async function getMailRouteById(id) {
  const numericId = Number(id);
  if (!Number.isInteger(numericId) || numericId <= 0) return null;
  const p = await getReadyPool();
  const res = await p
    .request()
    .input('id', sql.Int, numericId)
    .query(`
      SELECT m.id, m.ward_unit_id, u.name AS ward_name, m.name, m.code, m.color,
             m.street_ids, m.street_names, m.area_km2, m.length_m, m.points_count,
             m.modified, m.geojson, m.created_at, m.updated_at
      FROM dbo.mail_routes m
      INNER JOIN dbo.lamdong_admin_units u ON u.id = m.ward_unit_id
      WHERE m.id = @id
    `);
  return res.recordset[0] ? hydrateMailRouteRow(res.recordset[0]) : null;
}

export async function createMailRoute(payload) {
  const wardUnitId = Number(payload?.wardUnitId);
  if (!Number.isInteger(wardUnitId) || wardUnitId <= 0) {
    throw new Error('Thiếu mã xã/phường (wardUnitId) hợp lệ.');
  }
  const name = String(payload?.name || '').trim().slice(0, 255);
  if (!name) throw new Error('Vui lòng nhập tên tuyến đường thư.');
  const code = String(payload?.code || '').trim().slice(0, 64);
  const color = /^#[0-9a-fA-F]{6}$/.test(String(payload?.color || '')) ? payload.color : '#ea580c';
  const streetIds = Array.isArray(payload?.streetIds)
    ? [...new Set(payload.streetIds.map(Number).filter((n) => Number.isInteger(n) && n > 0))]
    : [];
  const streetNames = Array.isArray(payload?.streetNames)
    ? payload.streetNames.map((s) => String(s || '').trim()).filter(Boolean)
    : [];
  const lengthM = Math.max(0, Math.round(Number(payload?.lengthM) || 0));

  const fc = payload?.geojson;
  if (!fc || fc.type !== 'FeatureCollection' || !Array.isArray(fc.features) || fc.features.length === 0) {
    throw new Error('GeoJSON tuyến đường thư không hợp lệ.');
  }
  const stats = computeGeoStats(fc, null);
  const wkt = geojsonToMultiPolygonWkt(fc);
  const p = await getReadyPool();
  const res = await p
    .request()
    .input('wardUnitId', sql.Int, wardUnitId)
    .input('name', sql.NVarChar(255), name)
    .input('code', sql.NVarChar(64), code)
    .input('color', sql.NVarChar(16), color)
    .input('streetIds', sql.NVarChar(sql.MAX), JSON.stringify(streetIds))
    .input('streetNames', sql.NVarChar(sql.MAX), JSON.stringify(streetNames))
    .input('areaKm2', sql.Float, Math.round(stats.areaKm2 * 10000) / 10000)
    .input('lengthM', sql.Int, lengthM)
    .input('pointsCount', sql.Int, stats.points)
    .input('modified', sql.Bit, payload?.modified ? 1 : 0)
    .input('geojson', sql.NVarChar(sql.MAX), JSON.stringify(fc))
    .input('wkt', sql.NVarChar(sql.MAX), wkt)
    .query(`
      DECLARE @g GEOMETRY = NULL;
      IF @wkt IS NOT NULL
      BEGIN
        BEGIN TRY
          SET @g = geometry::STGeomFromText(@wkt, 4326);
          IF @g.STIsValid() = 0 SET @g = @g.MakeValid();
        END TRY
        BEGIN CATCH
          SET @g = NULL;
        END CATCH
      END

      INSERT INTO dbo.mail_routes (
        ward_unit_id, name, code, color, street_ids, street_names,
        area_km2, length_m, points_count, modified, geojson, geom
      )
      OUTPUT INSERTED.id
      VALUES (
        @wardUnitId, @name, @code, @color, @streetIds, @streetNames,
        @areaKm2, @lengthM, @pointsCount, @modified, @geojson, @g
      );
    `);
  return getMailRouteById(res.recordset[0].id);
}

export async function updateMailRoute(id, payload) {
  const numericId = Number(id);
  if (!Number.isInteger(numericId) || numericId <= 0) {
    throw new Error('ID tuyến đường thư không hợp lệ.');
  }
  const existing = await getMailRouteById(numericId);
  if (!existing) throw new Error('Không tìm thấy tuyến đường thư.');

  const name = payload?.name !== undefined ? String(payload.name || '').trim().slice(0, 255) : existing.name;
  if (!name) throw new Error('Tên tuyến đường thư không được để trống.');
  const code = payload?.code !== undefined ? String(payload.code || '').trim().slice(0, 64) : existing.code;
  const color =
    payload?.color !== undefined && /^#[0-9a-fA-F]{6}$/.test(String(payload.color))
      ? payload.color
      : existing.color;
  const streetIds = Array.isArray(payload?.streetIds)
    ? [...new Set(payload.streetIds.map(Number).filter((n) => Number.isInteger(n) && n > 0))]
    : existing.streetIds;
  const streetNames = Array.isArray(payload?.streetNames)
    ? payload.streetNames.map((s) => String(s || '').trim()).filter(Boolean)
    : existing.streetNames;
  const lengthM = payload?.lengthM !== undefined ? Math.max(0, Math.round(Number(payload.lengthM) || 0)) : existing.lengthM;
  const fc = payload?.geojson || existing.geojson;
  const modified = payload?.modified !== undefined ? Boolean(payload.modified) : true;

  const stats = computeGeoStats(fc, null);
  const wkt = geojsonToMultiPolygonWkt(fc);
  const p = await getReadyPool();
  await p
    .request()
    .input('id', sql.Int, numericId)
    .input('name', sql.NVarChar(255), name)
    .input('code', sql.NVarChar(64), code)
    .input('color', sql.NVarChar(16), color)
    .input('streetIds', sql.NVarChar(sql.MAX), JSON.stringify(streetIds))
    .input('streetNames', sql.NVarChar(sql.MAX), JSON.stringify(streetNames))
    .input('areaKm2', sql.Float, Math.round(stats.areaKm2 * 10000) / 10000)
    .input('lengthM', sql.Int, lengthM)
    .input('pointsCount', sql.Int, stats.points)
    .input('modified', sql.Bit, modified ? 1 : 0)
    .input('geojson', sql.NVarChar(sql.MAX), JSON.stringify(fc))
    .input('wkt', sql.NVarChar(sql.MAX), wkt)
    .query(`
      DECLARE @g GEOMETRY = NULL;
      IF @wkt IS NOT NULL
      BEGIN
        BEGIN TRY
          SET @g = geometry::STGeomFromText(@wkt, 4326);
          IF @g.STIsValid() = 0 SET @g = @g.MakeValid();
        END TRY
        BEGIN CATCH
          SET @g = NULL;
        END CATCH
      END

      UPDATE dbo.mail_routes
      SET name = @name,
          code = @code,
          color = @color,
          street_ids = @streetIds,
          street_names = @streetNames,
          area_km2 = @areaKm2,
          length_m = @lengthM,
          points_count = @pointsCount,
          modified = @modified,
          geojson = @geojson,
          geom = @g,
          updated_at = SYSUTCDATETIME()
      WHERE id = @id;
    `);
  return getMailRouteById(numericId);
}

export async function addStreetsToMailRoute(routeId, streetIds = [], { force = false } = {}) {
  const numericId = Number(routeId);
  if (!Number.isInteger(numericId) || numericId <= 0) {
    throw new Error('ID khu vực phát không hợp lệ.');
  }
  const cleanIds = [...new Set((Array.isArray(streetIds) ? streetIds : []).map(Number).filter((n) => Number.isInteger(n) && n > 0))];
  if (cleanIds.length === 0) {
    throw new Error('Vui lòng chọn ít nhất 1 tuyến đường để thêm.');
  }

  const target = await getMailRouteById(numericId);
  if (!target) throw new Error('Không tìm thấy khu vực phát này.');

  const p = await getReadyPool();
  const streetsRes = await p
    .request()
    .input('wardUnitId', sql.Int, target.wardUnitId)
    .input('idsJson', sql.NVarChar(sql.MAX), JSON.stringify(cleanIds))
    .query(`
      SELECT s.id, s.street_name AS name, s.length_m AS lengthM
      FROM dbo.ward_streets s
      INNER JOIN OPENJSON(@idsJson) j ON s.id = TRY_CAST(j.value AS INT)
      WHERE s.ward_unit_id = @wardUnitId
      ORDER BY s.street_name ASC
    `);

  const targetStreetSet = new Set(target.streetIds || []);
  const newStreets = streetsRes.recordset.filter((s) => !targetStreetSet.has(s.id));
  if (newStreets.length === 0) {
    throw new Error(`Các đường đã chọn đều đã nằm trong khu vực phát "${target.name}".`);
  }

  // 1. Check conflicts: streets already belonging to ANOTHER delivery area in the same ward
  const allRoutesInWard = await listMailRoutes(target.wardUnitId);
  const otherRoutes = allRoutesInWard.filter((r) => r.id !== target.id);
  const conflicts = [];
  for (const st of newStreets) {
    for (const other of otherRoutes) {
      if ((other.streetIds || []).includes(st.id)) {
        conflicts.push({
          streetId: st.id,
          streetName: st.name,
          routeId: other.id,
          routeName: other.name,
        });
      }
    }
  }

  // 2. Check spatial adjacency in SQL Server (BFS from target.geom across newStreets.zone_geom)
  const newIds = newStreets.map((s) => s.id);
  const adjRes = await p
    .request()
    .input('routeId', sql.Int, target.id)
    .input('idsJson', sql.NVarChar(sql.MAX), JSON.stringify(newIds))
    .query(`
      DECLARE @targetGeom GEOMETRY = (SELECT geom FROM dbo.mail_routes WHERE id = @routeId);
      WITH picked AS (
        SELECT s.id, s.street_name AS name, s.zone_geom
        FROM dbo.ward_streets s
        INNER JOIN OPENJSON(@idsJson) j ON s.id = TRY_CAST(j.value AS INT)
        WHERE s.zone_geom IS NOT NULL
      )
      SELECT
        p1.id AS id1,
        p1.name AS name1,
        CASE WHEN @targetGeom IS NOT NULL THEN @targetGeom.STDistance(p1.zone_geom) ELSE 0 END AS distToTarget,
        (
          SELECT p2.id
          FROM picked p2
          WHERE p2.id <> p1.id AND p1.zone_geom.STDistance(p2.zone_geom) <= 0.00015
          FOR JSON PATH
        ) AS neighborsJson
      FROM picked p1;
    `);

  const ADJ_DEG = 0.00015; // ~15m tolerance for touching Voronoi boundaries
  const nodeMap = new Map();
  for (const r of adjRes.recordset) {
    const nbs = r.neighborsJson ? JSON.parse(r.neighborsJson).map((x) => x.id) : [];
    nodeMap.set(r.id1, {
      id: r.id1,
      name: r.name1,
      distToTarget: Number(r.distToTarget) || 0,
      neighbors: nbs,
    });
  }
  const connected = new Set();
  const queue = [];
  for (const node of nodeMap.values()) {
    if (node.distToTarget <= ADJ_DEG) {
      connected.add(node.id);
      queue.push(node.id);
    }
  }
  while (queue.length > 0) {
    const cur = queue.shift();
    for (const nbId of nodeMap.get(cur)?.neighbors || []) {
      if (!connected.has(nbId)) {
        connected.add(nbId);
        queue.push(nbId);
      }
    }
  }

  const nonAdjacent = [];
  for (const st of newStreets) {
    if (!connected.has(st.id)) {
      const distDeg = nodeMap.get(st.id)?.distToTarget ?? 0;
      const distM = Math.round(distDeg * 111000);
      nonAdjacent.push({ streetId: st.id, streetName: st.name, distanceM: distM });
    }
  }

  const warnings = [];
  for (const c of conflicts) {
    warnings.push(`Đường "${c.streetName}" đã thuộc khu vực phát "${c.routeName}".`);
  }
  for (const na of nonAdjacent) {
    warnings.push(
      `Đường "${na.streetName}" không nằm cạnh khu vực phát "${target.name}"${na.distanceM > 0 ? ` (cách ~${na.distanceM.toLocaleString('vi-VN')} m)` : ''}.`,
    );
  }

  if (warnings.length > 0 && !force) {
    return {
      needsConfirm: true,
      targetRouteName: target.name,
      warnings,
      conflicts,
      nonAdjacent,
    };
  }

  // 3. Dissolve target.geom + newStreets.zone_geom into one updated polygon
  const unionRes = await p
    .request()
    .input('routeId', sql.Int, target.id)
    .input('idsJson', sql.NVarChar(sql.MAX), JSON.stringify(newIds))
    .query(`
      WITH geoms AS (
        SELECT geom AS g FROM dbo.mail_routes WHERE id = @routeId AND geom IS NOT NULL
        UNION ALL
        SELECT s.zone_geom AS g
        FROM dbo.ward_streets s
        INNER JOIN OPENJSON(@idsJson) j ON s.id = TRY_CAST(j.value AS INT)
        WHERE s.zone_geom IS NOT NULL
      )
      SELECT geometry::UnionAggregate(g.MakeValid().STBuffer(0.000008))
        .STBuffer(-0.000008)
        .Reduce(0.000005)
        .MakeValid()
        .STAsText() AS wkt
      FROM geoms;
    `);

  const mergedWkt = unionRes.recordset[0]?.wkt;
  const mergedGeom = mergedWkt ? wktToGeoJsonGeometry(mergedWkt) : null;
  if (!mergedGeom) throw new Error('Không thể gộp hình học các đường mới vào khu vực phát.');

  const mergedStreetIds = [...new Set([...(target.streetIds || []), ...newIds])];
  const mergedStreetNames = [...new Set([...(target.streetNames || []), ...newStreets.map((s) => s.name)])].sort((a, b) =>
    a.localeCompare(b, 'vi'),
  );
  const addedLen = newStreets.reduce((acc, s) => acc + (Number(s.lengthM) || 0), 0);
  const nextFc = {
    type: 'FeatureCollection',
    features: [
      {
        type: 'Feature',
        properties: { name: target.name, ward: target.wardName, streets: mergedStreetNames },
        geometry: mergedGeom,
      },
    ],
  };

  const updatedRoute = await updateMailRoute(target.id, {
    streetIds: mergedStreetIds,
    streetNames: mergedStreetNames,
    lengthM: (target.lengthM || 0) + addedLen,
    geojson: nextFc,
    modified: target.modified,
  });

  return {
    needsConfirm: false,
    route: updatedRoute,
    addedNames: newStreets.map((s) => s.name),
    warnings,
    conflicts,
    nonAdjacent,
  };
}

export async function deleteMailRoute(id) {
  const numericId = Number(id);
  if (!Number.isInteger(numericId) || numericId <= 0) {
    throw new Error('ID tuyến đường thư không hợp lệ.');
  }
  const p = await getReadyPool();
  const res = await p.request().input('id', sql.Int, numericId).query('DELETE FROM dbo.mail_routes WHERE id = @id');
  return (res.rowsAffected?.[0] || 0) > 0;
}

export async function closeDb() {
  if (pool) {
    await pool.close().catch(() => {});
    pool = null;
    dbState.connected = false;
  }
}
