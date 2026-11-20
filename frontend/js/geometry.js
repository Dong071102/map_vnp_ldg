export const OVERLAP_MIN_SQM = 1000;

const EARTH_RADIUS = 6378137;
const toRad = (deg) => (deg * Math.PI) / 180;

export function isPolygonFeature(feature) {
  const t = feature?.geometry?.type;
  return t === 'Polygon' || t === 'MultiPolygon';
}

export function formatArea(areaSqM) {
  if (!Number.isFinite(areaSqM) || areaSqM <= 0) return '0 km²';
  const km2 = areaSqM / 1e6;
  if (km2 >= 0.1) return `${km2.toLocaleString('vi-VN', { maximumFractionDigits: 2 })} km²`;
  if (km2 >= 0.01) return `${km2.toLocaleString('vi-VN', { maximumFractionDigits: 3 })} km²`;
  return `${Math.round(areaSqM).toLocaleString('vi-VN')} m²`;
}

export function ringAreaSqMeters(coords) {
  if (!Array.isArray(coords) || coords.length < 3) return 0;
  // Exclude duplicate closing vertex on closed GeoJSON rings to avoid double-counting the first edge
  const last = coords[coords.length - 1];
  const n =
    coords.length > 3 && coords[0][0] === last[0] && coords[0][1] === last[1]
      ? coords.length - 1
      : coords.length;
  if (n < 3) return 0;

  let total = 0;
  for (let i = 0; i < n; i++) {
    const p1 = coords[i];
    const p2 = coords[(i + 1) % n];
    const p3 = coords[(i + 2) % n];
    total += (toRad(p3[0]) - toRad(p1[0])) * Math.sin(toRad(p2[1]));
  }
  return Math.abs((total * EARTH_RADIUS * EARTH_RADIUS) / 2);
}

function polygonAreaSqMeters(rings) {
  if (!Array.isArray(rings) || rings.length === 0) return 0;
  let area = ringAreaSqMeters(rings[0]);
  for (let i = 1; i < rings.length; i++) area -= ringAreaSqMeters(rings[i]);
  return Math.max(0, area);
}

export function geometryAreaSqMeters(geom, turfLib = globalThis.turf) {
  if (!geom) return 0;
  if (turfLib && typeof turfLib.area === 'function') {
    try {
      return turfLib.area(geom);
    } catch {
      // fall through to native spherical formula
    }
  }
  if (geom.type === 'Polygon') return polygonAreaSqMeters(geom.coordinates);
  if (geom.type === 'MultiPolygon') {
    return geom.coordinates.reduce((sum, poly) => sum + polygonAreaSqMeters(poly), 0);
  }
  return 0;
}

export function computeGeoStats(fc, turfLib = globalThis.turf) {
  let points = 0;
  let areaSqM = 0;
  let minLng = Infinity;
  let minLat = Infinity;
  let maxLng = -Infinity;
  let maxLat = -Infinity;

  const walk = (arr) => {
    if (!Array.isArray(arr) || arr.length === 0) return;
    if (typeof arr[0] === 'number' && typeof arr[1] === 'number') {
      const [lng, lat] = arr;
      points++;
      if (lng < minLng) minLng = lng;
      if (lng > maxLng) maxLng = lng;
      if (lat < minLat) minLat = lat;
      if (lat > maxLat) maxLat = lat;
    } else {
      for (const item of arr) walk(item);
    }
  };

  for (const f of fc?.features || []) {
    if (!f?.geometry) continue;
    areaSqM += geometryAreaSqMeters(f.geometry, turfLib);
    if (f.geometry.coordinates) walk(f.geometry.coordinates);
  }

  return {
    points,
    areaSqM,
    areaKm2: areaSqM / 1e6,
    bbox: Number.isFinite(minLng) ? [minLng, minLat, maxLng, maxLat] : null,
  };
}

export function buildCombinedPolygonFeature(fc) {
  const polys = [];
  for (const f of fc?.features || []) {
    const g = f?.geometry;
    if (!g) continue;
    if (g.type === 'Polygon' && Array.isArray(g.coordinates) && g.coordinates.length > 0) {
      polys.push(g.coordinates);
    } else if (g.type === 'MultiPolygon' && Array.isArray(g.coordinates)) {
      for (const poly of g.coordinates) {
        if (Array.isArray(poly) && poly.length > 0) polys.push(poly);
      }
    }
  }
  if (polys.length === 0) return null;
  if (polys.length === 1) {
    return { type: 'Feature', properties: {}, geometry: { type: 'Polygon', coordinates: polys[0] } };
  }
  return { type: 'Feature', properties: {}, geometry: { type: 'MultiPolygon', coordinates: polys } };
}

export function bboxesOverlap(a, b) {
  if (!a || !b) return false;
  return !(a[2] < b[0] || b[2] < a[0] || a[3] < b[1] || b[3] < a[1]);
}

function unionPolygons(features, turfLib) {
  const valid = (features || []).filter(
    (f) => f && f.geometry && (f.geometry.type === 'Polygon' || f.geometry.type === 'MultiPolygon'),
  );
  if (valid.length === 0) return null;
  if (valid.length === 1) return valid[0];
  try {
    return turfLib.union(turfLib.featureCollection(valid));
  } catch {
    let acc = valid[0];
    for (let i = 1; i < valid.length; i++) {
      try {
        const next = turfLib.union(turfLib.featureCollection([acc, valid[i]]));
        if (next) acc = next;
      } catch {
        // skip degenerate polygon
      }
    }
    return acc;
  }
}

function extractSegmentsInBbox(polyFeature, bbox, padDeg) {
  const minX = bbox[0] - padDeg;
  const minY = bbox[1] - padDeg;
  const maxX = bbox[2] + padDeg;
  const maxY = bbox[3] + padDeg;
  const segments = [];

  const addRing = (ring) => {
    if (!Array.isArray(ring) || ring.length < 2) return;
    for (let i = 0; i < ring.length - 1; i++) {
      const a = ring[i];
      const b = ring[i + 1];
      if (
        Math.max(a[0], b[0]) < minX ||
        Math.min(a[0], b[0]) > maxX ||
        Math.max(a[1], b[1]) < minY ||
        Math.min(a[1], b[1]) > maxY
      ) {
        continue;
      }
      segments.push([a[0], a[1], b[0], b[1]]);
    }
  };

  const g = polyFeature.geometry;
  if (g.type === 'Polygon') g.coordinates.forEach(addRing);
  else if (g.type === 'MultiPolygon') g.coordinates.forEach((poly) => poly.forEach(addRing));
  return segments;
}

function distSqPointToSegment(px, py, x1, y1, x2, y2, cosLat) {
  const dx = (x2 - x1) * cosLat;
  const dy = y2 - y1;
  const lenSq = dx * dx + dy * dy;
  let t = 0;
  if (lenSq > 0) {
    t = ((px - x1) * cosLat * dx + (py - y1) * dy) / lenSq;
    if (t < 0) t = 0;
    else if (t > 1) t = 1;
  }
  const ex = (px - (x1 + t * (x2 - x1))) * cosLat;
  const ey = py - (y1 + t * (y2 - y1));
  return ex * ex + ey * ey;
}

function minDistToSegments(pt, segments, cosLat) {
  let best = Infinity;
  for (let i = 0; i < segments.length; i++) {
    const s = segments[i];
    const d = distSqPointToSegment(pt[0], pt[1], s[0], s[1], s[2], s[3], cosLat);
    if (d < best) {
      best = d;
      if (best === 0) return 0;
    }
  }
  return Math.sqrt(best);
}

function splitByHalfPlane(comp, polyA, polyB, turfLib) {
  const compBbox = turfLib.bbox(comp);
  const center = turfLib.centroid(comp).geometry.coordinates;
  const cA = turfLib.centroid(polyA).geometry.coordinates;
  const cB = turfLib.centroid(polyB).geometry.coordinates;

  let vx = cB[0] - cA[0];
  let vy = cB[1] - cA[1];
  const len = Math.hypot(vx, vy);
  if (len < 1e-8) {
    const dx = compBbox[2] - compBbox[0];
    const dy = compBbox[3] - compBbox[1];
    vx = dx >= dy ? 1 : 0;
    vy = dx >= dy ? 0 : 1;
  } else {
    vx /= len;
    vy /= len;
  }

  const tx = -vy;
  const ty = vx;
  const R = Math.max(compBbox[2] - compBbox[0], compBbox[3] - compBbox[1], 0.01) * 10;

  const p1 = [center[0] + tx * R, center[1] + ty * R];
  const p2 = [center[0] - tx * R, center[1] - ty * R];
  const p3 = [p2[0] - vx * R, p2[1] - vy * R];
  const p4 = [p1[0] - vx * R, p1[1] - vy * R];
  const halfPlaneA = turfLib.polygon([[p1, p2, p3, p4, p1]]);

  const partA = turfLib.intersect(turfLib.featureCollection([comp, halfPlaneA]));
  if (!partA) return { partA: null, partB: comp };
  const partB = turfLib.difference(turfLib.featureCollection([comp, partA]));
  return { partA, partB };
}

function splitOverlapComponent(comp, polyA, polyB, segsA, segsB, turfLib) {
  const compBbox = turfLib.bbox(comp);
  const midLat = (compBbox[1] + compBbox[3]) / 2;
  const cosLat = Math.cos((midLat * Math.PI) / 180);
  const outerRing = comp.geometry.coordinates[0];
  if (!Array.isArray(outerRing) || outerRing.length < 4) {
    return splitByHalfPlane(comp, polyA, polyB, turfLib);
  }

  let perim = 0;
  const edgeLens = [];
  for (let i = 0; i < outerRing.length - 1; i++) {
    const a = outerRing[i];
    const b = outerRing[i + 1];
    const l = Math.hypot((b[0] - a[0]) * cosLat, b[1] - a[1]);
    edgeLens.push(l);
    perim += l;
  }
  const targetStep = perim > 0 ? perim / 140 : 0.001;

  const seeds = [];
  const seenKeys = new Set();
  let countA = 0;
  let countB = 0;

  for (let i = 0; i < outerRing.length - 1; i++) {
    const a = outerRing[i];
    const b = outerRing[i + 1];
    const len = edgeLens[i];
    if (len === 0) continue;

    const samplesOnEdge = Math.min(12, Math.max(1, Math.round(len / targetStep)));
    for (let k = 1; k <= samplesOnEdge; k++) {
      const t = k / (samplesOnEdge + 1);
      const pt = [a[0] + (b[0] - a[0]) * t, a[1] + (b[1] - a[1]) * t];
      const key = `${pt[0].toFixed(7)},${pt[1].toFixed(7)}`;
      if (seenKeys.has(key)) continue;

      const dA = minDistToSegments(pt, segsA, cosLat);
      const dB = minDistToSegments(pt, segsB, cosLat);

      let owner = null;
      if (dB < dA * 0.85) owner = 'A';
      else if (dA < dB * 0.85) owner = 'B';
      else if (dB < dA) owner = 'A';
      else if (dA < dB) owner = 'B';

      if (!owner) continue;
      seenKeys.add(key);
      seeds.push(turfLib.point(pt, { owner }));
      if (owner === 'A') countA++;
      else countB++;
    }
  }

  if (countA === 0 || countB === 0 || seeds.length < 2) {
    return splitByHalfPlane(comp, polyA, polyB, turfLib);
  }

  try {
    const pad = Math.max(compBbox[2] - compBbox[0], compBbox[3] - compBbox[1], 0.002) * 0.6 + 0.005;
    const vorBbox = [compBbox[0] - pad, compBbox[1] - pad, compBbox[2] + pad, compBbox[3] + pad];
    const vor = turfLib.voronoi(turfLib.featureCollection(seeds), { bbox: vorBbox });

    const cellsA = [];
    let countCellB = 0;
    for (let i = 0; i < vor.features.length; i++) {
      const cell = vor.features[i];
      if (!cell || !cell.geometry) continue;
      if (seeds[i]?.properties?.owner === 'A') cellsA.push(cell);
      else countCellB++;
    }

    if (cellsA.length === 0 || countCellB === 0) {
      return splitByHalfPlane(comp, polyA, polyB, turfLib);
    }

    const zoneA = unionPolygons(cellsA, turfLib);
    if (!zoneA) return splitByHalfPlane(comp, polyA, polyB, turfLib);

    const partA = turfLib.intersect(turfLib.featureCollection([comp, zoneA]));
    if (!partA || geometryAreaSqMeters(partA.geometry, turfLib) < 1) {
      return splitByHalfPlane(comp, polyA, polyB, turfLib);
    }

    const partB = turfLib.difference(turfLib.featureCollection([comp, partA]));
    return { partA, partB };
  } catch {
    return splitByHalfPlane(comp, polyA, polyB, turfLib);
  }
}

export function detectRegionOverlaps(visibleRegions, turfLib = globalThis.turf) {
  const results = [];
  if (!turfLib || typeof turfLib.intersect !== 'function') return results;

  for (let i = 0; i < visibleRegions.length; i++) {
    for (let j = i + 1; j < visibleRegions.length; j++) {
      const a = visibleRegions[i];
      const b = visibleRegions[j];
      if (!a.unionPoly || !b.unionPoly || !bboxesOverlap(a.bbox, b.bbox)) continue;

      try {
        const inter = turfLib.intersect(turfLib.featureCollection([a.unionPoly, b.unionPoly]));
        if (!inter || !inter.geometry) continue;
        if (inter.geometry.type !== 'Polygon' && inter.geometry.type !== 'MultiPolygon') continue;

        const areaSqM = geometryAreaSqMeters(inter.geometry, turfLib);
        if (areaSqM < OVERLAP_MIN_SQM) continue;

        const areaKm2 = areaSqM / 1e6;
        const pctA = a.areaKm2 > 0 ? Math.min(100, (areaKm2 / a.areaKm2) * 100) : 0;
        const pctB = b.areaKm2 > 0 ? Math.min(100, (areaKm2 / b.areaKm2) * 100) : 0;

        results.push({
          id: `${a.id}__${b.id}`,
          regionA: a,
          regionB: b,
          areaSqM,
          areaKm2,
          pctA,
          pctB,
          feature: {
            type: 'Feature',
            properties: {
              type: 'overlap',
              region_a: a.meta.name,
              region_b: b.meta.name,
              qid_a: a.meta.qid,
              qid_b: b.meta.qid,
              overlap_area_km2: Number(areaKm2.toFixed(4)),
              pct_of_a: Number(pctA.toFixed(2)),
              pct_of_b: Number(pctB.toFixed(2)),
            },
            geometry: inter.geometry,
          },
        });
      } catch (err) {
        console.warn(`Lỗi tính giao nhau giữa ${a.meta.name} và ${b.meta.name}:`, err);
      }
    }
  }
  return results;
}

export function computeSplitPolygons(polyA, polyB, bboxA, bboxB, turfLib = globalThis.turf) {
  if (!turfLib || !polyA || !polyB || !bboxesOverlap(bboxA, bboxB)) return null;

  const inter = turfLib.intersect(turfLib.featureCollection([polyA, polyB]));
  if (!inter || !inter.geometry) return null;
  if (inter.geometry.type !== 'Polygon' && inter.geometry.type !== 'MultiPolygon') return null;
  if (geometryAreaSqMeters(inter.geometry, turfLib) < OVERLAP_MIN_SQM) return null;

  const components =
    inter.geometry.type === 'Polygon'
      ? [inter]
      : inter.geometry.coordinates
          .filter((coords) => Array.isArray(coords) && coords.length > 0)
          .map((coords) => turfLib.polygon(coords));

  const interBbox = turfLib.bbox(inter);
  const padDeg = Math.max(interBbox[2] - interBbox[0], interBbox[3] - interBbox[1], 0.002) * 0.25 + 0.002;
  const segsA = extractSegmentsInBbox(polyA, interBbox, padDeg);
  const segsB = extractSegmentsInBbox(polyB, interBbox, padDeg);

  const partsForA = [];
  const partsForB = [];
  for (const comp of components) {
    if (geometryAreaSqMeters(comp.geometry, turfLib) < 10) continue;
    const { partA, partB } = splitOverlapComponent(comp, polyA, polyB, segsA, segsB, turfLib);
    if (partA && geometryAreaSqMeters(partA.geometry, turfLib) > 0) partsForA.push(partA);
    if (partB && geometryAreaSqMeters(partB.geometry, turfLib) > 0) partsForB.push(partB);
  }

  // A' = A \ partB, B' = B \ partA guarantees zero overlap and zero gap without internal seam lines
  const removeFromA = unionPolygons(partsForB, turfLib);
  const removeFromB = unionPolygons(partsForA, turfLib);

  const newPolyA = removeFromA ? turfLib.difference(turfLib.featureCollection([polyA, removeFromA])) : polyA;
  const newPolyB = removeFromB ? turfLib.difference(turfLib.featureCollection([polyB, removeFromB])) : polyB;
  if (!newPolyA || !newPolyB) return null;

  return { newPolyA, newPolyB };
}
