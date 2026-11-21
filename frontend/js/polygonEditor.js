// Interactive CVAT / Label Studio / Roboflow-style Polygon Vertex Editor for Leaflet
// With Topological Shared-Border Editing (Đồng bộ biên chung):
//  - Drag vertex handles to adjust shape (with live neighbor segment distances)
//  - Shared vertices with neighboring wards deform in lockstep (zero gap, zero overlap)
//  - Right-click any edge to insert a new vertex (also inserted on matching shared edge of neighbors)
//  - Right-click any vertex to delete it (also removed from matching shared vertex of neighbors)
//  - Draw mode: left-click to place points, click first point or double-click / Enter to finish
//  - Atomic Undo / Redo stack (Ctrl+Z / Ctrl+Y) covering both main unit and synced neighbors

const COORD_EPS = 1e-5; // ~1.1m tolerance for matching shared boundary vertices

function roundCoord(n) {
  return Math.round(n * 1e6) / 1e6;
}

function deepClone(obj) {
  return JSON.parse(JSON.stringify(obj));
}

function coordKey(coord) {
  return `${Math.round(coord[0] * 1e5)},${Math.round(coord[1] * 1e5)}`;
}

function coordsMatch(a, b) {
  return Math.abs(a[0] - b[0]) <= COORD_EPS && Math.abs(a[1] - b[1]) <= COORD_EPS;
}

function formatDistanceMeters(meters) {
  if (!Number.isFinite(meters)) return '0 m';
  if (meters >= 1000) return `${(meters / 1000).toFixed(2)} km`;
  return `${Math.round(meters)} m`;
}

function stopEvent(e) {
  if (e?.originalEvent) L.DomEvent.stop(e.originalEvent);
  if (e) L.DomEvent.stopPropagation(e);
}

function ensureFeatureCollection(geojson) {
  if (!geojson || typeof geojson !== 'object') {
    return { type: 'FeatureCollection', features: [] };
  }
  const cloned = deepClone(geojson);
  if (cloned.type === 'FeatureCollection' && Array.isArray(cloned.features)) {
    return cloned;
  }
  if (cloned.type === 'Feature' && cloned.geometry) {
    return { type: 'FeatureCollection', features: [cloned] };
  }
  if (cloned.type && cloned.coordinates) {
    return {
      type: 'FeatureCollection',
      features: [{ type: 'Feature', properties: {}, geometry: cloned }],
    };
  }
  return { type: 'FeatureCollection', features: [] };
}

function getUniqueRingCoords(ring) {
  if (!Array.isArray(ring) || ring.length < 3) return [];
  const first = ring[0];
  const last = ring[ring.length - 1];
  const isClosed =
    ring.length > 3 &&
    Array.isArray(first) &&
    Array.isArray(last) &&
    first[0] === last[0] &&
    first[1] === last[1];
  return isClosed ? ring.slice(0, -1) : ring.slice();
}

function closeRing(uniqueCoords) {
  if (uniqueCoords.length === 0) return [];
  const closed = uniqueCoords.map(([lng, lat]) => [roundCoord(lng), roundCoord(lat)]);
  closed.push([closed[0][0], closed[0][1]]);
  return closed;
}

function getRingFromFc(fc, featureIdx, polyIdx, ringIdx) {
  const geom = fc?.features?.[featureIdx]?.geometry;
  if (!geom) return null;
  if (geom.type === 'Polygon') return geom.coordinates[ringIdx];
  if (geom.type === 'MultiPolygon') return geom.coordinates[polyIdx]?.[ringIdx];
  return null;
}

function setRingOnFc(fc, featureIdx, polyIdx, ringIdx, uniqueCoords) {
  const geom = fc?.features?.[featureIdx]?.geometry;
  if (!geom) return;
  const closed = closeRing(uniqueCoords);
  if (geom.type === 'Polygon') {
    geom.coordinates[ringIdx] = closed;
  } else if (geom.type === 'MultiPolygon') {
    geom.coordinates[polyIdx][ringIdx] = closed;
  }
}

function forEachPolygonRing(fc, fn) {
  for (let fIdx = 0; fIdx < (fc?.features?.length || 0); fIdx++) {
    const geom = fc.features[fIdx]?.geometry;
    if (!geom) continue;
    if (geom.type === 'Polygon') {
      for (let rIdx = 0; rIdx < (geom.coordinates?.length || 0); rIdx++) {
        fn(fIdx, 0, rIdx, geom.coordinates[rIdx]);
      }
    } else if (geom.type === 'MultiPolygon') {
      for (let pIdx = 0; pIdx < (geom.coordinates?.length || 0); pIdx++) {
        const poly = geom.coordinates[pIdx];
        for (let rIdx = 0; rIdx < (poly?.length || 0); rIdx++) {
          fn(fIdx, pIdx, rIdx, poly[rIdx]);
        }
      }
    }
  }
}

function fcToMultiPolygonLatLngs(fc) {
  const polys = [];
  for (const f of fc?.features || []) {
    const g = f?.geometry;
    if (!g) continue;
    if (g.type === 'Polygon') {
      polys.push(g.coordinates.map((r) => getUniqueRingCoords(r).map(([x, y]) => [y, x])));
    } else if (g.type === 'MultiPolygon') {
      for (const poly of g.coordinates) {
        polys.push(poly.map((r) => getUniqueRingCoords(r).map(([x, y]) => [y, x])));
      }
    }
  }
  return polys;
}

// Project point P onto segment AB in pixel space; returns { distSq, t, x, y }
function projectPointToSegment(p, a, b) {
  const dx = b.x - a.x;
  const dy = b.y - a.y;
  const lenSq = dx * dx + dy * dy;
  let t = 0;
  if (lenSq > 0) {
    t = Math.max(0, Math.min(1, ((p.x - a.x) * dx + (p.y - a.y) * dy) / lenSq));
  }
  const x = a.x + t * dx;
  const y = a.y + t * dy;
  const ex = p.x - x;
  const ey = p.y - y;
  return { distSq: ex * ex + ey * ey, t, x, y };
}

export function createPolygonEditor(map, { onChange, onStatus, onHistoryChange } = {}) {
  if (!map.getPane('neighborRefPane')) {
    const pane = map.createPane('neighborRefPane');
    pane.style.zIndex = '350';
  }
  if (!map.getPane('polyEditorEdgePane')) {
    const pane = map.createPane('polyEditorEdgePane');
    pane.style.zIndex = '460';
  }
  if (!map.getPane('polyEditorGhostPane')) {
    const pane = map.createPane('polyEditorGhostPane');
    pane.style.zIndex = '520';
  }

  const neighborGroup = L.layerGroup().addTo(map);
  const rootGroup = L.layerGroup().addTo(map);
  const handleGroup = L.layerGroup().addTo(map);
  const drawGroup = L.layerGroup().addTo(map);

  const distanceMarker = L.marker([0, 0], {
    interactive: false,
    pane: 'tooltipPane',
    icon: L.divIcon({
      className: 'poly-distance-pill-wrap',
      html: '<div class="poly-distance-pill"></div>',
      iconSize: [0, 0],
    }),
  });

  const edgeSnapDot = L.marker([0, 0], {
    interactive: false,
    pane: 'polyEditorGhostPane',
    icon: L.divIcon({
      className: 'poly-edge-snap-dot',
      html: '<span>+</span>',
      iconSize: [14, 14],
      iconAnchor: [7, 7],
    }),
  });

  const eraserBrushMarker = L.marker([0, 0], {
    interactive: false,
    pane: 'polyEditorGhostPane',
    icon: L.divIcon({
      className: 'poly-eraser-brush',
      html: '<span></span>',
      iconSize: [36, 36],
      iconAnchor: [18, 18],
    }),
  });

  let geojson = { type: 'FeatureCollection', features: [] };
  let color = '#2563eb';
  let editEnabled = true;
  let topoEnabled = true;
  let showNeighbors = true;
  let drawing = false;
  let drawPoints = [];
  let drawCursorLatLng = null;

  // Alt + Left-Mouse-Button batch vertex eraser state
  const ALT_ERASE_RADIUS_PX = 18;
  let altErasing = false;
  let altErasePushedUndo = false;
  let altErasedCount = 0;
  let altErasedSyncedNames = new Set();

  // Editable neighboring ward states for topological shared-border sync
  // Each item: { id, name, color, geojson, dirty, polyLayer, labelLayer }
  let neighborStates = [];

  const undoStack = [];
  const redoStack = [];
  const MAX_HISTORY = 40;

  function getDirtyNeighbors() {
    return neighborStates.filter((n) => n.dirty);
  }

  function notifyHistory() {
    onHistoryChange?.({
      canUndo: undoStack.length > 0,
      canRedo: redoStack.length > 0,
      editEnabled,
      topoEnabled,
      showNeighbors,
      drawing,
      vertexCount: countVertices(),
      neighborCount: neighborStates.length,
      dirtyNeighborCount: getDirtyNeighbors().length,
    });
  }

  function captureSnapshot() {
    return {
      geojson: deepClone(geojson),
      neighbors: neighborStates.map((n) => ({
        id: n.id,
        geojson: deepClone(n.geojson),
        dirty: n.dirty,
      })),
    };
  }

  function restoreSnapshot(snap) {
    geojson = deepClone(snap.geojson);
    const byId = new Map(snap.neighbors.map((n) => [n.id, n]));
    for (const ns of neighborStates) {
      const saved = byId.get(ns.id);
      if (saved) {
        ns.geojson = deepClone(saved.geojson);
        ns.dirty = saved.dirty;
      }
    }
  }

  function pushUndo() {
    undoStack.push(captureSnapshot());
    if (undoStack.length > MAX_HISTORY) undoStack.shift();
    redoStack.length = 0;
    notifyHistory();
  }

  function countVertices() {
    let total = 0;
    forEachPolygonRing(geojson, (_f, _p, _r, ring) => {
      total += getUniqueRingCoords(ring).length;
    });
    return total;
  }

  function hideEdgeSnapDot() {
    if (map.hasLayer(edgeSnapDot)) map.removeLayer(edgeSnapDot);
  }

  function hideDistancePill() {
    if (map.hasLayer(distanceMarker)) map.removeLayer(distanceMarker);
  }

  function showDistancePill(latlng, text) {
    if (!map.hasLayer(distanceMarker)) distanceMarker.addTo(map);
    distanceMarker.setLatLng(latlng);
    const el = distanceMarker.getElement()?.querySelector('.poly-distance-pill');
    if (el) el.textContent = text;
  }

  function emitChange(reason, extra = {}) {
    notifyHistory();
    onChange?.(deepClone(geojson), {
      reason,
      vertexCount: countVertices(),
      dirtyNeighborNames: getDirtyNeighbors().map((n) => n.name),
      ...extra,
    });
  }

  // Build map of rounded coordinate key -> array of neighbor names for fast shared-vertex badge lookup
  function buildNeighborVertexIndex() {
    const index = new Map();
    if (!topoEnabled) return index;
    for (const ns of neighborStates) {
      forEachPolygonRing(ns.geojson, (_f, _p, _r, ring) => {
        const unique = getUniqueRingCoords(ring);
        for (const c of unique) {
          const k = coordKey(c);
          let names = index.get(k);
          if (!names) {
            names = new Set();
            index.set(k, names);
          }
          names.add(ns.name);
        }
      });
    }
    return index;
  }

  function findNeighborVerticesMatching(coord) {
    const refs = [];
    if (!topoEnabled) return refs;
    for (const ns of neighborStates) {
      forEachPolygonRing(ns.geojson, (fIdx, pIdx, rIdx, ring) => {
        const unique = getUniqueRingCoords(ring);
        for (let vIdx = 0; vIdx < unique.length; vIdx++) {
          if (coordsMatch(unique[vIdx], coord)) {
            refs.push({ ns, fIdx, pIdx, rIdx, vIdx });
          }
        }
      });
    }
    return refs;
  }

  function insertVertexOnMatchingNeighborEdges(coordA, coordB, newCoord) {
    const touchedNames = new Set();
    if (!topoEnabled) return [];
    for (const ns of neighborStates) {
      let modified = false;
      forEachPolygonRing(ns.geojson, (fIdx, pIdx, rIdx, ring) => {
        const unique = getUniqueRingCoords(ring);
        const m = unique.length;
        if (m < 3) return;
        for (let j = 0; j < m; j++) {
          const p1 = unique[j];
          const p2 = unique[(j + 1) % m];
          const sameDir = coordsMatch(p1, coordA) && coordsMatch(p2, coordB);
          const revDir = coordsMatch(p1, coordB) && coordsMatch(p2, coordA);
          if (sameDir || revDir) {
            unique.splice(j + 1, 0, [newCoord[0], newCoord[1]]);
            setRingOnFc(ns.geojson, fIdx, pIdx, rIdx, unique);
            modified = true;
            break;
          }
        }
      });
      if (modified) {
        ns.dirty = true;
        touchedNames.add(ns.name);
      }
    }
    return Array.from(touchedNames);
  }

  function deleteMatchingNeighborVertices(coord) {
    const touchedNames = new Set();
    if (!topoEnabled) return [];
    for (const ns of neighborStates) {
      let modified = false;
      forEachPolygonRing(ns.geojson, (fIdx, pIdx, rIdx, ring) => {
        const unique = getUniqueRingCoords(ring);
        if (unique.length <= 3) return;
        let removed = false;
        for (let j = unique.length - 1; j >= 0; j--) {
          if (unique.length <= 3) break;
          if (coordsMatch(unique[j], coord)) {
            unique.splice(j, 1);
            removed = true;
          }
        }
        if (removed) {
          setRingOnFc(ns.geojson, fIdx, pIdx, rIdx, unique);
          modified = true;
        }
      });
      if (modified) {
        ns.dirty = true;
        touchedNames.add(ns.name);
      }
    }
    return Array.from(touchedNames);
  }

  function renderNeighbors() {
    neighborGroup.clearLayers();
    if (!showNeighbors) {
      for (const ns of neighborStates) {
        ns.polyLayer = null;
        ns.labelLayer = null;
      }
      return;
    }

    for (const ns of neighborStates) {
      const latlngs = fcToMultiPolygonLatLngs(ns.geojson);
      if (latlngs.length === 0) {
        ns.polyLayer = null;
        ns.labelLayer = null;
        continue;
      }

      const polyLayer = L.polygon(latlngs, {
        pane: 'neighborRefPane',
        interactive: false,
        color: ns.dirty ? '#0d9488' : '#475569',
        weight: ns.dirty ? 2.1 : 1.6,
        opacity: 0.88,
        dashArray: ns.dirty ? '4 3' : '5 4',
        fillColor: ns.color || '#94a3b8',
        fillOpacity: ns.dirty ? 0.2 : 0.14,
      }).addTo(neighborGroup);

      ns.polyLayer = polyLayer;
      ns.labelLayer = null;

      if (ns.name) {
        const bounds = polyLayer.getBounds();
        if (bounds.isValid()) {
          ns.labelLayer = L.tooltip({
            permanent: true,
            direction: 'center',
            interactive: false,
            className: 'neighbor-label',
          })
            .setLatLng(bounds.getCenter())
            .setContent(ns.dirty ? `${ns.name} *` : ns.name)
            .addTo(neighborGroup);
        }
      }
    }
  }

  function updateNeighborLayerLive(ns) {
    if (!ns.polyLayer) return;
    const latlngs = fcToMultiPolygonLatLngs(ns.geojson);
    ns.polyLayer.setLatLngs(latlngs);
    ns.polyLayer.setStyle({
      color: '#0d9488',
      weight: 2.1,
      dashArray: '4 3',
      fillOpacity: 0.2,
    });
  }

  function findClosestEdgeLocation(uniqueCoords, clickLatLng) {
    const clickPt = map.latLngToLayerPoint(clickLatLng);
    let best = null;
    const n = uniqueCoords.length;
    for (let i = 0; i < n; i++) {
      const aCoord = uniqueCoords[i];
      const bCoord = uniqueCoords[(i + 1) % n];
      const aPt = map.latLngToLayerPoint([aCoord[1], aCoord[0]]);
      const bPt = map.latLngToLayerPoint([bCoord[1], bCoord[0]]);
      const proj = projectPointToSegment(clickPt, aPt, bPt);
      if (!best || proj.distSq < best.distSq) {
        best = { segIndex: i, ...proj };
      }
    }
    if (!best) return null;
    const snappedLatLng = map.layerPointToLatLng(L.point(best.x, best.y));
    return {
      segIndex: best.segIndex,
      insertIndex: best.segIndex + 1,
      latlng: snappedLatLng,
      distPx: Math.sqrt(best.distSq),
    };
  }

  function renderAll(flashVertexKey = null) {
    renderNeighbors();
    rootGroup.clearLayers();
    handleGroup.clearLayers();
    hideEdgeSnapDot();
    hideDistancePill();

    const sharedIndex = buildNeighborVertexIndex();
    const features = geojson.features || [];

    features.forEach((feature, featureIdx) => {
      const geom = feature?.geometry;
      if (!geom) return;

      if (geom.type !== 'Polygon' && geom.type !== 'MultiPolygon') {
        L.geoJSON(feature, {
          style: () => ({ color, weight: 2.5, opacity: 0.9, fillColor: color, fillOpacity: 0.25 }),
        }).addTo(rootGroup);
        return;
      }

      const polygons = geom.type === 'Polygon' ? [geom.coordinates] : geom.coordinates;

      polygons.forEach((polyCoords, polyIdx) => {
        const ringLatLngs = polyCoords.map((ring) =>
          getUniqueRingCoords(ring).map(([lng, lat]) => [lat, lng]),
        );

        const polyLayer = L.polygon(ringLatLngs, {
          color,
          weight: editEnabled ? 2.6 : 2.8,
          opacity: 0.95,
          fillColor: color,
          fillOpacity: editEnabled ? 0.22 : 0.32,
          interactive: !editEnabled,
        }).addTo(rootGroup);

        if (!editEnabled) return;

        polyCoords.forEach((rawRing, ringIdx) => {
          const unique = getUniqueRingCoords(rawRing);
          if (unique.length < 3) return;

          const closedLatLngs = [...unique.map(([lng, lat]) => [lat, lng]), [unique[0][1], unique[0][0]]];

          const edgeHitLayer = L.polyline(closedLatLngs, {
            pane: 'polyEditorEdgePane',
            color: '#0f172a',
            weight: 16,
            opacity: 0,
            interactive: true,
            className: 'poly-edge-hitarea',
          }).addTo(rootGroup);

          edgeHitLayer.on('mousemove', (e) => {
            if (drawing || altErasing || e.originalEvent?.altKey) {
              hideEdgeSnapDot();
              return;
            }
            const liveUnique = getUniqueRingCoords(getRingFromFc(geojson, featureIdx, polyIdx, ringIdx));
            const snap = findClosestEdgeLocation(liveUnique, e.latlng);
            if (snap && snap.distPx <= 18) {
              if (!map.hasLayer(edgeSnapDot)) edgeSnapDot.addTo(map);
              edgeSnapDot.setLatLng(snap.latlng);
            } else {
              hideEdgeSnapDot();
            }
          });

          edgeHitLayer.on('mouseout', () => hideEdgeSnapDot());

          const handleInsertVertexOnEdge = (e) => {
            stopEvent(e);
            if (drawing || altErasing || e.originalEvent?.altKey) return;

            const liveUnique = getUniqueRingCoords(getRingFromFc(geojson, featureIdx, polyIdx, ringIdx));
            const snap = findClosestEdgeLocation(liveUnique, e.latlng);
            if (!snap) return;

            const n = liveUnique.length;
            const coordA = liveUnique[snap.segIndex];
            const coordB = liveUnique[(snap.segIndex + 1) % n];

            pushUndo();
            const newCoord = [roundCoord(snap.latlng.lng), roundCoord(snap.latlng.lat)];
            liveUnique.splice(snap.insertIndex, 0, newCoord);
            setRingOnFc(geojson, featureIdx, polyIdx, ringIdx, liveUnique);

            const syncedNames = insertVertexOnMatchingNeighborEdges(coordA, coordB, newCoord);

            const key = `${featureIdx}:${polyIdx}:${ringIdx}:${snap.insertIndex}`;
            renderAll(key);
            emitChange('insert-vertex', { syncedNames });
            const syncNote = syncedNames.length ? ` (đã đồng bộ biên chung với ${syncedNames.join(', ')})` : '';
            onStatus?.(`Đã thêm nút mới (#${snap.insertIndex + 1})${syncNote}.`, 'success');
          };

          // Left-click (primary) or right-click (fallback) on edge -> insert vertex
          edgeHitLayer.on('click', handleInsertVertexOnEdge);
          edgeHitLayer.on('contextmenu', handleInsertVertexOnEdge);

          // Vertex handles
          unique.forEach(([lng, lat], vertexIdx) => {
            const vKey = `${featureIdx}:${polyIdx}:${ringIdx}:${vertexIdx}`;
            const isFlashed = flashVertexKey === vKey;
            const sharedWith = sharedIndex.get(coordKey([lng, lat]));
            const isShared = Boolean(sharedWith && sharedWith.size > 0);

            const marker = L.marker([lat, lng], {
              draggable: true,
              keyboard: false,
              zIndexOffset: 200,
              icon: L.divIcon({
                className: `poly-vertex-handle${isFlashed ? ' vertex-flash' : ''}${ringIdx > 0 ? ' vertex-hole' : ''}${isShared ? ' vertex-shared' : ''}`,
                html: '<span class="poly-vertex-dot"></span>',
                iconSize: [14, 14],
                iconAnchor: [7, 7],
              }),
            }).addTo(handleGroup);

            const el = marker.getElement();
            if (el) {
              el.title = isShared
                ? `Đỉnh biên chung với: ${Array.from(sharedWith).join(', ')} · Kéo chuột trái để chỉnh · Alt+chuột trái quét để xóa`
                : `Đỉnh #${vertexIdx + 1} · Kéo chuột trái để chỉnh · Alt+chuột trái quét để xóa`;
            }

            let dragPushedUndo = false;
            let linkedRefs = [];

            marker.on('mouseover', () => hideEdgeSnapDot());

            marker.on('dragstart', () => {
              hideEdgeSnapDot();
              const liveUnique = getUniqueRingCoords(getRingFromFc(geojson, featureIdx, polyIdx, ringIdx));
              const origCoord = liveUnique[vertexIdx];
              linkedRefs = origCoord ? findNeighborVerticesMatching(origCoord) : [];
              if (!dragPushedUndo) {
                pushUndo();
                dragPushedUndo = true;
              }
              marker.getElement()?.classList.add('is-dragging');
            });

            marker.on('drag', (e) => {
              const ll = e.target.getLatLng();
              const newCoord = [roundCoord(ll.lng), roundCoord(ll.lat)];
              const liveUnique = getUniqueRingCoords(getRingFromFc(geojson, featureIdx, polyIdx, ringIdx));
              liveUnique[vertexIdx] = newCoord;
              setRingOnFc(geojson, featureIdx, polyIdx, ringIdx, liveUnique);

              const updatedPolyLatLngs = polygons[polyIdx].map((r) =>
                getUniqueRingCoords(r).map(([x, y]) => [y, x]),
              );
              polyLayer.setLatLngs(updatedPolyLatLngs);
              edgeHitLayer.setLatLngs([
                ...liveUnique.map(([x, y]) => [y, x]),
                [liveUnique[0][1], liveUnique[0][0]],
              ]);

              // Synchronously deform matching neighbor polygons in real time
              if (linkedRefs.length > 0) {
                const updatedNs = new Set();
                for (const ref of linkedRefs) {
                  const nUnique = getUniqueRingCoords(getRingFromFc(ref.ns.geojson, ref.fIdx, ref.pIdx, ref.rIdx));
                  if (ref.vIdx < nUnique.length) {
                    nUnique[ref.vIdx] = [newCoord[0], newCoord[1]];
                    setRingOnFc(ref.ns.geojson, ref.fIdx, ref.pIdx, ref.rIdx, nUnique);
                    ref.ns.dirty = true;
                    updatedNs.add(ref.ns);
                  }
                }
                for (const ns of updatedNs) updateNeighborLayerLive(ns);
              }

              const n = liveUnique.length;
              const prev = liveUnique[(vertexIdx - 1 + n) % n];
              const next = liveUnique[(vertexIdx + 1) % n];
              const dPrev = map.distance(ll, L.latLng(prev[1], prev[0]));
              const dNext = map.distance(ll, L.latLng(next[1], next[0]));
              const linkedCount = new Set(linkedRefs.map((r) => r.ns.id)).size;
              const prefix = linkedCount > 0 ? `🔗 +${linkedCount} xã · ` : '';
              showDistancePill(ll, `${prefix}← ${formatDistanceMeters(dPrev)} · ${formatDistanceMeters(dNext)} →`);
            });

            marker.on('dragend', () => {
              const syncedNames = Array.from(new Set(linkedRefs.map((r) => r.ns.name)));
              dragPushedUndo = false;
              linkedRefs = [];
              marker.getElement()?.classList.remove('is-dragging');
              hideDistancePill();
              if (syncedNames.length > 0) renderNeighbors();
              emitChange('move-vertex', { syncedNames });
            });

            // Right-click on vertex -> delete from ward A AND matching neighbor vertices
            marker.on('contextmenu', (e) => {
              stopEvent(e);
              if (drawing) return;

              const liveUnique = getUniqueRingCoords(getRingFromFc(geojson, featureIdx, polyIdx, ringIdx));
              if (liveUnique.length <= 3) {
                onStatus?.('Đa giác cần tối thiểu 3 đỉnh — không thể xóa thêm.', 'warn');
                return;
              }

              const targetCoord = liveUnique[vertexIdx];
              pushUndo();
              liveUnique.splice(vertexIdx, 1);
              setRingOnFc(geojson, featureIdx, polyIdx, ringIdx, liveUnique);
              const syncedNames = deleteMatchingNeighborVertices(targetCoord);

              renderAll();
              emitChange('delete-vertex', { syncedNames });
              const syncNote = syncedNames.length ? ` · đã đồng bộ xóa trên ${syncedNames.join(', ')}` : '';
              onStatus?.(`Đã xóa đỉnh #${vertexIdx + 1}${syncNote}.`, 'success');
            });
          });
        });
      });
    });

    notifyHistory();
  }

  // --- Draw New Polygon Mode ---
  function renderDrawPreview() {
    drawGroup.clearLayers();
    if (!drawing || drawPoints.length === 0) return;

    const latlngs = drawPoints.map((p) => [p.lat, p.lng]);
    if (drawCursorLatLng) latlngs.push([drawCursorLatLng.lat, drawCursorLatLng.lng]);

    if (drawPoints.length >= 3) {
      L.polygon(
        drawPoints.map((p) => [p.lat, p.lng]),
        {
          color,
          weight: 2,
          dashArray: '5 5',
          fillColor: color,
          fillOpacity: 0.18,
          interactive: false,
        },
      ).addTo(drawGroup);
    }

    L.polyline(latlngs, {
      color,
      weight: 2.5,
      dashArray: '6 4',
      interactive: false,
    }).addTo(drawGroup);

    drawPoints.forEach((pt, idx) => {
      const m = L.marker([pt.lat, pt.lng], {
        interactive: idx === 0 && drawPoints.length >= 3,
        icon: L.divIcon({
          className: `poly-vertex-handle${idx === 0 ? ' vertex-first-close' : ''}`,
          html: '<span class="poly-vertex-dot"></span>',
          iconSize: [14, 14],
          iconAnchor: [7, 7],
        }),
      }).addTo(drawGroup);

      if (idx === 0 && drawPoints.length >= 3) {
        m.getElement()?.setAttribute('title', 'Click đỉnh đầu để khép kín đa giác');
        m.on('click', (ev) => {
          stopEvent(ev);
          finishDrawing();
        });
      }
    });

    if (drawCursorLatLng && drawPoints.length >= 1) {
      const last = drawPoints[drawPoints.length - 1];
      const d = map.distance(last, drawCursorLatLng);
      showDistancePill(drawCursorLatLng, `${formatDistanceMeters(d)} (${drawPoints.length} đỉnh)`);
    }
  }

  function handleMapClickForDraw(e) {
    if (!drawing) return;
    drawPoints.push(e.latlng);
    renderDrawPreview();
  }

  function handleMapMoveForDraw(e) {
    if (!drawing) return;
    drawCursorLatLng = e.latlng;
    renderDrawPreview();
  }

  function handleMapDblClickForDraw(e) {
    if (!drawing) return;
    stopEvent(e);
    if (drawPoints.length >= 2) {
      const a = map.latLngToLayerPoint(drawPoints[drawPoints.length - 1]);
      const b = map.latLngToLayerPoint(drawPoints[drawPoints.length - 2]);
      if (a.distanceTo(b) < 6) drawPoints.pop();
    }
    finishDrawing();
  }

  function handleMapRightClickForDraw(e) {
    if (!drawing) return;
    stopEvent(e);
    if (drawPoints.length > 0) {
      drawPoints.pop();
      renderDrawPreview();
      onStatus?.(`Đã bỏ điểm vẽ gần nhất (còn ${drawPoints.length} điểm).`, 'warn');
    } else {
      cancelDrawing();
    }
  }

  function startDrawing() {
    if (drawing) return;
    drawing = true;
    drawPoints = [];
    drawCursorLatLng = null;
    hideEdgeSnapDot();
    map.doubleClickZoom.disable();
    map.getContainer().classList.add('is-drawing-poly');
    map.on('click', handleMapClickForDraw);
    map.on('mousemove', handleMapMoveForDraw);
    map.on('dblclick', handleMapDblClickForDraw);
    map.on('contextmenu', handleMapRightClickForDraw);
    notifyHistory();
    onStatus?.(
      'Chế độ vẽ vùng mới: Click trái đặt đỉnh · Click đỉnh đầu hoặc Double-click / Enter để khép · Chuột phải lùi 1 điểm · Esc hủy.',
      'warn',
    );
  }

  function stopDrawingListeners() {
    drawing = false;
    drawPoints = [];
    drawCursorLatLng = null;
    drawGroup.clearLayers();
    hideDistancePill();
    map.doubleClickZoom.enable();
    map.getContainer().classList.remove('is-drawing-poly');
    map.off('click', handleMapClickForDraw);
    map.off('mousemove', handleMapMoveForDraw);
    map.off('dblclick', handleMapDblClickForDraw);
    map.off('contextmenu', handleMapRightClickForDraw);
  }

  function finishDrawing() {
    if (!drawing) return;
    if (drawPoints.length < 3) {
      onStatus?.('Cần tối thiểu 3 điểm để tạo đa giác.', 'warn');
      return;
    }
    const ringCoords = closeRing(drawPoints.map((p) => [p.lng, p.lat]));
    stopDrawingListeners();
    pushUndo();
    geojson.features.push({
      type: 'Feature',
      properties: {},
      geometry: {
        type: 'Polygon',
        coordinates: [ringCoords],
      },
    });
    editEnabled = true;
    renderAll();
    emitChange('draw-polygon');
    onStatus?.('Đã thêm đa giác mới — bạn có thể kéo đỉnh hoặc bấm Lưu vào DB.', 'success');
  }

  function cancelDrawing() {
    if (!drawing) return;
    stopDrawingListeners();
    notifyHistory();
    onStatus?.('Đã hủy vẽ vùng mới.', 'warn');
  }

  // --- Alt + Left-Mouse-Button Brush Eraser (hover sweep to batch-delete vertices) ---
  function hideEraserBrush() {
    if (map.hasLayer(eraserBrushMarker)) map.removeLayer(eraserBrushMarker);
  }

  function updateEraserBrushAtEvent(e) {
    const ll = map.mouseEventToLatLng(e);
    if (!map.hasLayer(eraserBrushMarker)) eraserBrushMarker.addTo(map);
    eraserBrushMarker.setLatLng(ll);
  }

  function eraseVerticesNearEvent(e) {
    const pt = map.mouseEventToContainerPoint(e);
    const rSq = ALT_ERASE_RADIUS_PX * ALT_ERASE_RADIUS_PX;
    let erasedNow = 0;

    // Inspect every polygon ring and delete vertices within brush radius (keeping >= 3 vertices per ring)
    forEachPolygonRing(geojson, (fIdx, pIdx, rIdx, rawRing) => {
      const liveUnique = getUniqueRingCoords(rawRing);
      if (liveUnique.length <= 3) return;

      const toDeleteIndices = [];
      for (let vIdx = 0; vIdx < liveUnique.length; vIdx++) {
        const [lng, lat] = liveUnique[vIdx];
        const vPt = map.latLngToContainerPoint([lat, lng]);
        const dx = vPt.x - pt.x;
        const dy = vPt.y - pt.y;
        if (dx * dx + dy * dy <= rSq) {
          toDeleteIndices.push(vIdx);
        }
      }
      if (toDeleteIndices.length === 0) return;

      // Never collapse ring below 3 vertices
      const maxRemovable = liveUnique.length - 3;
      const cut = toDeleteIndices.slice(0, maxRemovable);
      if (cut.length === 0) return;

      if (!altErasePushedUndo) {
        pushUndo();
        altErasePushedUndo = true;
      }

      // Delete from highest index downward so indices stay valid
      for (let i = cut.length - 1; i >= 0; i--) {
        const idx = cut[i];
        const targetCoord = liveUnique[idx];
        liveUnique.splice(idx, 1);
        erasedNow++;
        altErasedCount++;
        const synced = deleteMatchingNeighborVertices(targetCoord);
        for (const name of synced) altErasedSyncedNames.add(name);
      }
      setRingOnFc(geojson, fIdx, pIdx, rIdx, liveUnique);
    });

    if (erasedNow > 0) {
      renderAll();
      updateEraserBrushAtEvent(e);
    }
  }

  function onAltEraseMove(e) {
    if (!altErasing) return;
    if (!(e.buttons & 1) || !e.altKey) {
      stopAltErase();
      return;
    }
    e.preventDefault();
    updateEraserBrushAtEvent(e);
    eraseVerticesNearEvent(e);
  }

  function stopAltErase() {
    if (!altErasing) return;
    altErasing = false;
    hideEraserBrush();
    map.getContainer().classList.remove('is-alt-erasing');
    map.dragging.enable();
    window.removeEventListener('mousemove', onAltEraseMove, true);
    window.removeEventListener('mouseup', stopAltErase, true);
    window.removeEventListener('blur', stopAltErase);
    window.removeEventListener('keyup', onAltKeyUp);

    if (altErasedCount > 0) {
      const syncedNames = Array.from(altErasedSyncedNames);
      emitChange('delete-vertex-batch', { count: altErasedCount, syncedNames });
      const syncNote = syncedNames.length ? ` · đồng bộ trên ${syncedNames.join(', ')}` : '';
      onStatus?.(`Đã xóa ${altErasedCount} nút bằng Alt+chuột trái${syncNote} (Ctrl+Z để hoàn tác).`, 'success');
    }
    altErasePushedUndo = false;
    altErasedCount = 0;
    altErasedSyncedNames.clear();
  }

  function onAltKeyUp(e) {
    if (e.key === 'Alt') stopAltErase();
  }

  // Capture-phase listener intercepts Alt+Left-Click BEFORE Leaflet marker drag or map pan
  map.getContainer().addEventListener(
    'mousedown',
    (e) => {
      if (!editEnabled || drawing) return;
      if (!e.altKey || e.button !== 0) return;
      e.preventDefault();
      e.stopPropagation();
      hideEdgeSnapDot();
      altErasing = true;
      altErasePushedUndo = false;
      altErasedCount = 0;
      altErasedSyncedNames.clear();
      map.dragging.disable();
      map.getContainer().classList.add('is-alt-erasing');
      updateEraserBrushAtEvent(e);
      eraseVerticesNearEvent(e);
      window.addEventListener('mousemove', onAltEraseMove, true);
      window.addEventListener('mouseup', stopAltErase, true);
      window.addEventListener('blur', stopAltErase);
      window.addEventListener('keyup', onAltKeyUp);
    },
    true,
  );

  map.getContainer().addEventListener('contextmenu', (e) => {
    if (editEnabled || drawing) e.preventDefault();
  });

  function load(
    nextGeojson,
    { color: nextColor = '#2563eb', neighbors = null, fitBounds = true, resetHistory = true } = {},
  ) {
    if (drawing) stopDrawingListeners();
    color = nextColor || '#2563eb';
    geojson = ensureFeatureCollection(nextGeojson);
    if (Array.isArray(neighbors)) {
      neighborStates = neighbors.map((n) => ({
        id: n.id,
        name: n.name || '',
        color: n.color || '#94a3b8',
        geojson: ensureFeatureCollection(n.geojson),
        dirty: false,
        polyLayer: null,
        labelLayer: null,
      }));
    }
    if (resetHistory) {
      undoStack.length = 0;
      redoStack.length = 0;
    }
    renderAll();

    if (fitBounds) {
      setTimeout(() => {
        map.invalidateSize();
        const bounds = getBounds();
        if (bounds && bounds.isValid()) {
          map.fitBounds(bounds, { padding: [32, 32], maxZoom: 15 });
        }
      }, 60);
    }
  }

  function getBounds() {
    const fg = L.featureGroup();
    rootGroup.eachLayer((l) => {
      if (typeof l.getBounds === 'function') fg.addLayer(l);
    });
    const b = fg.getBounds();
    return b.isValid() ? b : null;
  }

  function setEditEnabled(enabled) {
    if (altErasing && !enabled) stopAltErase();
    if (drawing && !enabled) cancelDrawing();
    editEnabled = Boolean(enabled);
    renderAll();
  }

  function setTopoEnabled(enabled) {
    topoEnabled = Boolean(enabled);
    renderAll();
  }

  function setShowNeighbors(visible) {
    showNeighbors = Boolean(visible);
    renderNeighbors();
    notifyHistory();
  }

  function undo() {
    if (undoStack.length === 0) return false;
    redoStack.push(captureSnapshot());
    restoreSnapshot(undoStack.pop());
    renderAll();
    emitChange('undo');
    onStatus?.('Đã hoàn tác bước chỉnh sửa gần nhất (gồm cả xã giáp ranh nếu có).', 'success');
    return true;
  }

  function redo() {
    if (redoStack.length === 0) return false;
    undoStack.push(captureSnapshot());
    restoreSnapshot(redoStack.pop());
    renderAll();
    emitChange('redo');
    onStatus?.('Đã làm lại bước chỉnh sửa.', 'success');
    return true;
  }

  function clear() {
    if (altErasing) stopAltErase();
    if (drawing) stopDrawingListeners();
    geojson = { type: 'FeatureCollection', features: [] };
    neighborStates = [];
    undoStack.length = 0;
    redoStack.length = 0;
    neighborGroup.clearLayers();
    rootGroup.clearLayers();
    handleGroup.clearLayers();
    hideEdgeSnapDot();
    hideDistancePill();
    notifyHistory();
  }

  return {
    load,
    clear,
    getGeojson: () => deepClone(geojson),
    getModifiedNeighbors: () =>
      getDirtyNeighbors().map((n) => ({
        regionId: n.id,
        name: n.name,
        geojson: deepClone(n.geojson),
      })),
    isEditEnabled: () => editEnabled,
    setEditEnabled,
    isTopoEnabled: () => topoEnabled,
    setTopoEnabled,
    isShowNeighbors: () => showNeighbors,
    setShowNeighbors,
    isDrawing: () => drawing,
    startDrawing,
    finishDrawing,
    cancelDrawing,
    undo,
    redo,
    getBounds,
  };
}
