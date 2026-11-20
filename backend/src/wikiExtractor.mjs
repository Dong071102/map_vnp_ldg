const USER_AGENT = 'WikiGeoJSONExtractor/2.0 (https://localhost; local-dev-tool)';

async function fetchJson(url, timeoutMs = 15000) {
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), timeoutMs);
  try {
    const response = await fetch(url, {
      headers: {
        'User-Agent': USER_AGENT,
        Accept: 'application/json, application/geo+json;q=0.9, */*;q=0.8',
      },
      signal: controller.signal,
    });
    const text = await response.text();
    if (!response.ok) {
      throw new Error(`HTTP ${response.status} từ ${new URL(url).hostname}: ${text.slice(0, 160)}`);
    }
    try {
      return JSON.parse(text);
    } catch {
      throw new Error(`Phản hồi không phải JSON hợp lệ từ ${new URL(url).hostname}`);
    }
  } finally {
    clearTimeout(timer);
  }
}

export function parseInput(rawInput) {
  const trimmed = String(rawInput || '').trim();
  if (!trimmed) {
    throw new Error('Vui lòng nhập đường dẫn Wikipedia (hoặc mã Wikidata QID).');
  }

  if (/^Q\d+$/i.test(trimmed)) {
    const qid = trimmed.toUpperCase();
    return {
      kind: 'qid',
      qid,
      lang: 'vi',
      title: null,
      mapIndex: 0,
      originalUrl: `https://www.wikidata.org/wiki/${qid}`,
    };
  }

  let parsed;
  try {
    parsed = new URL(trimmed.startsWith('http') ? trimmed : `https://${trimmed}`);
  } catch {
    throw new Error(
      'Đường dẫn không hợp lệ. Ví dụ: https://vi.wikipedia.org/wiki/%C4%90%E1%BA%A1_Huoai_(huy%E1%BB%87n)#/map/0',
    );
  }

  const host = parsed.hostname.toLowerCase();

  // Direct GeoJSON / local map API URL support (e.g. /api/map/lamdong/ward/24823 or external .geojson URL)
  if (
    parsed.pathname.startsWith('/api/map/') ||
    parsed.pathname.endsWith('/geojson') ||
    /\.(?:geo)?json$/i.test(parsed.pathname)
  ) {
    return {
      kind: 'geojson_url',
      qid: null,
      lang: 'vi',
      title: null,
      mapIndex: 0,
      originalUrl: parsed.toString(),
    };
  }

  if (host === 'wikidata.org' || host.endsWith('.wikidata.org')) {
    const qMatch = parsed.pathname.match(/Q\d+/i);
    if (!qMatch) throw new Error('Không tìm thấy mã Wikidata (QID) trong đường dẫn.');
    return {
      kind: 'qid',
      qid: qMatch[0].toUpperCase(),
      lang: 'vi',
      title: null,
      mapIndex: 0,
      originalUrl: trimmed,
    };
  }

  const wikiHostMatch = host.match(/^([a-z-]+)\.(?:m\.)?wikipedia\.org$/);
  if (!wikiHostMatch) {
    throw new Error('Chỉ hỗ trợ đường dẫn Wikipedia (*.wikipedia.org), Wikidata hoặc mã QID.');
  }

  const lang = wikiHostMatch[1];
  let title = '';
  if (parsed.pathname.startsWith('/wiki/')) {
    title = decodeURIComponent(parsed.pathname.slice('/wiki/'.length));
  } else if (parsed.searchParams.get('title')) {
    title = parsed.searchParams.get('title');
  }

  title = title.replace(/#.*$/, '').trim();
  if (!title) throw new Error('Không tách được tên bài viết từ link Wikipedia.');

  const hashMatch = parsed.hash.match(/#\/map\/(\d+)/i);
  const mapIndex = hashMatch ? Number(hashMatch[1]) || 0 : 0;

  return { kind: 'wikipedia', lang, title, mapIndex, originalUrl: trimmed };
}

export function hasUsableGeometry(geojson) {
  if (!geojson || typeof geojson !== 'object') return false;
  if (geojson.type === 'FeatureCollection') {
    return Array.isArray(geojson.features) && geojson.features.some(hasUsableGeometry);
  }
  if (geojson.type === 'Feature') return hasUsableGeometry(geojson.geometry);
  if (geojson.type === 'GeometryCollection') {
    return Array.isArray(geojson.geometries) && geojson.geometries.some(hasUsableGeometry);
  }
  return Array.isArray(geojson.coordinates) && geojson.coordinates.length > 0;
}

export function hasPolygonGeometry(geojson) {
  if (!geojson || typeof geojson !== 'object') return false;
  if (geojson.type === 'FeatureCollection') {
    return Array.isArray(geojson.features) && geojson.features.some(hasPolygonGeometry);
  }
  if (geojson.type === 'Feature') return hasPolygonGeometry(geojson.geometry);
  if (geojson.type === 'GeometryCollection') {
    return Array.isArray(geojson.geometries) && geojson.geometries.some(hasPolygonGeometry);
  }
  return geojson.type === 'Polygon' || geojson.type === 'MultiPolygon';
}

export function normalizeToFeatureCollection(data, defaultProps = {}) {
  if (!data || typeof data !== 'object') return null;

  const enrichFeature = (feature) => {
    if (!feature || !feature.geometry) return null;
    if (feature.geometry.type === 'GeometryCollection' && Array.isArray(feature.geometry.geometries)) {
      return feature.geometry.geometries
        .filter(hasUsableGeometry)
        .map((g) => ({
          type: 'Feature',
          properties: { ...defaultProps, ...(feature.properties || {}) },
          geometry: g,
        }));
    }
    if (!hasUsableGeometry(feature.geometry)) return null;
    return [
      {
        type: 'Feature',
        properties: { ...defaultProps, ...(feature.properties || {}) },
        geometry: feature.geometry,
      },
    ];
  };

  const features = [];
  if (data.type === 'FeatureCollection' && Array.isArray(data.features)) {
    for (const f of data.features) {
      const normalized = enrichFeature(f);
      if (normalized) features.push(...normalized);
    }
  } else if (data.type === 'Feature') {
    const normalized = enrichFeature(data);
    if (normalized) features.push(...normalized);
  } else if (data.type === 'GeometryCollection' && Array.isArray(data.geometries)) {
    for (const g of data.geometries) {
      if (hasUsableGeometry(g)) {
        features.push({ type: 'Feature', properties: { ...defaultProps }, geometry: g });
      }
    }
  } else if (data.type && Array.isArray(data.coordinates)) {
    features.push({ type: 'Feature', properties: { ...defaultProps }, geometry: data });
  }

  return features.length > 0 ? { type: 'FeatureCollection', features } : null;
}

async function fetchWikiPageMeta(lang, title) {
  const apiUrl = new URL(`https://${lang}.wikipedia.org/w/api.php`);
  apiUrl.searchParams.set('action', 'query');
  apiUrl.searchParams.set('prop', 'pageprops|mapdata|coordinates');
  apiUrl.searchParams.set('titles', title);
  apiUrl.searchParams.set('redirects', '1');
  apiUrl.searchParams.set('format', 'json');
  apiUrl.searchParams.set('formatversion', '2');

  const data = await fetchJson(apiUrl.toString());
  const page = data?.query?.pages?.[0];
  if (!page || page.missing) {
    throw new Error(`Không tìm thấy bài viết "${title}" trên ${lang}.wikipedia.org.`);
  }

  let mapdata = null;
  if (page.mapdata) {
    try {
      mapdata = typeof page.mapdata === 'string' ? JSON.parse(page.mapdata) : page.mapdata;
    } catch {
      mapdata = null;
    }
  }

  return {
    title: page.title,
    qid: page.pageprops?.wikibase_item || null,
    coordinates: page.coordinates?.[0] || null,
    mapdata,
    wikipediaUrl: `https://${lang}.wikipedia.org/wiki/${encodeURIComponent(page.title.replace(/ /g, '_'))}`,
  };
}

async function fetchWikidataMeta(qid) {
  const data = await fetchJson(`https://www.wikidata.org/wiki/Special:EntityData/${encodeURIComponent(qid)}.json`);
  const entity = data?.entities?.[qid];
  if (!entity) return null;

  const claims = entity.claims || {};
  const getStringClaims = (prop) =>
    (claims[prop] || [])
      .map((c) => c?.mainsnak?.datavalue?.value)
      .filter((v) => typeof v === 'string' && v.trim().length > 0);

  return {
    qid,
    label:
      entity.labels?.vi?.value ||
      entity.labels?.en?.value ||
      Object.values(entity.labels || {})[0]?.value ||
      qid,
    description: entity.descriptions?.vi?.value || entity.descriptions?.en?.value || '',
    osmRelationIds: getStringClaims('P402'),
    commonsGeoshapes: getStringClaims('P3896'),
  };
}

async function fetchWikimediaGeoshape(service, idsOrQuery, isQuery = false) {
  const safeService = service === 'geoline' ? 'geoline' : 'geoshape';
  const url = new URL(`https://maps.wikimedia.org/${safeService}`);
  url.searchParams.set('getgeojson', '1');
  if (isQuery) {
    url.searchParams.set('query', idsOrQuery);
  } else {
    url.searchParams.set('ids', Array.isArray(idsOrQuery) ? idsOrQuery.join(',') : String(idsOrQuery));
  }
  const data = await fetchJson(url.toString());
  return { data, url: url.toString() };
}

async function fetchCommonsMapPage(dataTitle) {
  const normalizedTitle = dataTitle.startsWith('Data:') ? dataTitle : `Data:${dataTitle}`;
  const apiUrl = new URL('https://commons.wikimedia.org/w/api.php');
  apiUrl.searchParams.set('action', 'query');
  apiUrl.searchParams.set('prop', 'revisions');
  apiUrl.searchParams.set('rvprop', 'content');
  apiUrl.searchParams.set('rvslots', 'main');
  apiUrl.searchParams.set('titles', normalizedTitle);
  apiUrl.searchParams.set('format', 'json');
  apiUrl.searchParams.set('formatversion', '2');

  const resp = await fetchJson(apiUrl.toString());
  const content = resp?.query?.pages?.[0]?.revisions?.[0]?.slots?.main?.content;
  if (!content) return null;
  const parsed = JSON.parse(content);
  return {
    data: parsed.data || parsed,
    url: `https://commons.wikimedia.org/wiki/${encodeURIComponent(normalizedTitle)}`,
  };
}

async function extractFromMapdata(mapdata, mapIndex, defaultProps, trace) {
  if (!mapdata || typeof mapdata !== 'object') return null;

  const groups = Object.values(mapdata).filter(Array.isArray);
  if (groups.length === 0) return null;

  const orderedGroups = [];
  if (groups[mapIndex]) orderedGroups.push(groups[mapIndex]);
  for (let i = 0; i < groups.length; i++) {
    if (i !== mapIndex) orderedGroups.push(groups[i]);
  }

  for (const items of orderedGroups) {
    const collectedFeatures = [];
    const sourceUrls = [];

    for (const item of items) {
      if (!item || typeof item !== 'object') continue;
      if (item.type === 'ExternalData') {
        const service = item.service;
        try {
          if ((service === 'geoshape' || service === 'geoline') && (item.ids || item.query)) {
            const { data, url } = await fetchWikimediaGeoshape(
              service,
              item.ids || item.query,
              Boolean(!item.ids && item.query),
            );
            const fc = normalizeToFeatureCollection(data, {
              ...defaultProps,
              ...(item.properties || {}),
              layer_service: service,
            });
            if (fc) {
              collectedFeatures.push(...fc.features);
              sourceUrls.push(url);
              trace.push(`Mapdata (${service}) -> ${fc.features.length} feature`);
            }
          } else if (service === 'page' && item.title) {
            const result = await fetchCommonsMapPage(item.title);
            const fc = normalizeToFeatureCollection(result?.data, {
              ...defaultProps,
              ...(item.properties || {}),
              layer_service: 'commons-map',
            });
            if (fc) {
              collectedFeatures.push(...fc.features);
              sourceUrls.push(result.url);
              trace.push(`Mapdata (Commons ${item.title}) -> ${fc.features.length} feature`);
            }
          }
        } catch (err) {
          trace.push(`Mapdata (${service}) lỗi: ${err.message}`);
        }
      } else {
        const fc = normalizeToFeatureCollection(item, defaultProps);
        if (fc) collectedFeatures.push(...fc.features);
      }
    }

    if (collectedFeatures.length > 0) {
      const merged = { type: 'FeatureCollection', features: collectedFeatures };
      if (hasPolygonGeometry(merged) || sourceUrls.length > 0) {
        return {
          geojson: merged,
          source: 'Wikipedia Mapdata',
          sourceUrl: sourceUrls[0] || defaultProps.wikipedia_url,
        };
      }
    }
  }
  return null;
}

export async function extractRegion(rawUrl, preferredSource = 'auto') {
  const input = parseInput(rawUrl);
  const trace = [];

  if (input.kind === 'geojson_url') {
    const raw = await fetchJson(input.originalUrl);
    const fc = normalizeToFeatureCollection(raw);
    if (!fc || !hasUsableGeometry(fc)) {
      throw new Error(`URL không trả về dữ liệu GeoJSON hợp lệ: ${input.originalUrl}`);
    }
    const firstProps = fc.features[0]?.properties || {};
    const name = firstProps.name || firstProps.shapeName || 'GeoJSON Region';
    const wardCode = firstProps.ward_code || null;
    trace.push(`GeoJSON URL -> lấy được ${fc.features.length} feature`);
    return {
      meta: {
        name,
        description: firstProps.province ? `${firstProps.unit_type || ''} thuộc ${firstProps.province}`.trim() : '',
        qid: wardCode ? `VN-${wardCode}` : null,
        osmRelationIds: [],
        wikipediaUrl: null,
        wikidataUrl: null,
        directGeoshapeUrl: input.originalUrl,
        source: 'OpenData GeoJSON Link',
        sourceUrl: input.originalUrl,
        coordinates: null,
        trace,
      },
      geojson: fc,
    };
  }

  let wikiMeta = null;
  let qid = input.qid || null;

  if (input.kind === 'wikipedia') {
    wikiMeta = await fetchWikiPageMeta(input.lang, input.title);
    qid = wikiMeta.qid;
    trace.push(`Wikipedia: "${wikiMeta.title}" -> Wikidata ${qid || '(không có)'}`);
  }

  let wikidataMeta = null;
  if (qid) {
    try {
      wikidataMeta = await fetchWikidataMeta(qid);
      if (wikidataMeta) {
        trace.push(
          `Wikidata ${qid}: "${wikidataMeta.label}"` +
            (wikidataMeta.osmRelationIds.length ? `, OSM R${wikidataMeta.osmRelationIds.join(', R')}` : ''),
        );
      }
    } catch (err) {
      trace.push(`Không đọc được Wikidata ${qid}: ${err.message}`);
    }
  }

  const displayName = wikiMeta?.title || wikidataMeta?.label || qid || input.title;
  const defaultProps = {
    name: displayName,
    ...(qid ? { wikidata: qid } : {}),
    ...(wikiMeta?.wikipediaUrl ? { wikipedia_url: wikiMeta.wikipediaUrl } : {}),
  };

  const tryMapdata = () =>
    wikiMeta?.mapdata ? extractFromMapdata(wikiMeta.mapdata, input.mapIndex, defaultProps, trace) : null;

  const tryWikimediaGeoshape = async () => {
    if (!qid) return null;
    try {
      const { data, url } = await fetchWikimediaGeoshape('geoshape', qid, false);
      const fc = normalizeToFeatureCollection(data, defaultProps);
      if (fc && hasUsableGeometry(fc)) {
        trace.push(`Wikimedia Geoshape (${qid}) -> ${fc.features.length} feature`);
        return { geojson: fc, source: 'Wikimedia Geoshape', sourceUrl: url };
      }
      trace.push(`Wikimedia Geoshape (${qid}) trả về rỗng.`);
    } catch (err) {
      trace.push(`Wikimedia Geoshape lỗi: ${err.message}`);
    }
    return null;
  };

  const tryCommonsP3896 = async () => {
    for (const shapeTitle of wikidataMeta?.commonsGeoshapes || []) {
      try {
        const res = await fetchCommonsMapPage(shapeTitle);
        const fc = normalizeToFeatureCollection(res?.data, defaultProps);
        if (fc && hasUsableGeometry(fc)) {
          trace.push(`Wikimedia Commons (${shapeTitle}) -> ${fc.features.length} feature`);
          return { geojson: fc, source: 'Wikimedia Commons (.map)', sourceUrl: res.url };
        }
      } catch (err) {
        trace.push(`Wikimedia Commons (${shapeTitle}) lỗi: ${err.message}`);
      }
    }
    return null;
  };

  const tryOsm = async () => {
    for (const osmId of wikidataMeta?.osmRelationIds || []) {
      try {
        const nomUrl = `https://nominatim.openstreetmap.org/lookup?osm_ids=R${encodeURIComponent(
          osmId,
        )}&format=geojson&polygon_geojson=1`;
        const fc = normalizeToFeatureCollection(await fetchJson(nomUrl), {
          ...defaultProps,
          osm_relation_id: String(osmId),
        });
        if (fc && hasPolygonGeometry(fc)) {
          trace.push(`OpenStreetMap Nominatim (R${osmId}) -> polygon`);
          return { geojson: fc, source: `OSM Nominatim (R${osmId})`, sourceUrl: nomUrl };
        }
      } catch (err) {
        trace.push(`OSM Nominatim (R${osmId}) lỗi: ${err.message}`);
      }

      try {
        const polyUrl = `https://polygons.openstreetmap.fr/get_geojson.py?id=${encodeURIComponent(osmId)}&params=0`;
        const fc = normalizeToFeatureCollection(await fetchJson(polyUrl), {
          ...defaultProps,
          osm_relation_id: String(osmId),
        });
        if (fc && hasUsableGeometry(fc)) {
          trace.push(`polygons.openstreetmap.fr (R${osmId}) -> polygon`);
          return { geojson: fc, source: `OSM Polygons (R${osmId})`, sourceUrl: polyUrl };
        }
      } catch (err) {
        trace.push(`polygons.openstreetmap.fr (R${osmId}) lỗi: ${err.message}`);
      }
    }
    return null;
  };

  let result = null;
  if (preferredSource === 'wikimedia') {
    result = (await tryWikimediaGeoshape()) || (await tryMapdata()) || (await tryCommonsP3896());
  } else if (preferredSource === 'osm') {
    result = await tryOsm();
  } else {
    result = (await tryMapdata()) || (await tryWikimediaGeoshape()) || (await tryCommonsP3896()) || (await tryOsm());
  }

  if (!result) {
    const error = new Error(
      `Không tìm thấy dữ liệu ranh giới GeoJSON cho "${displayName}" (${qid || 'không có QID'}).`,
    );
    error.trace = trace;
    throw error;
  }

  return {
    meta: {
      name: displayName,
      description: wikidataMeta?.description || '',
      qid,
      osmRelationIds: wikidataMeta?.osmRelationIds || [],
      wikipediaUrl: wikiMeta?.wikipediaUrl || input.originalUrl,
      wikidataUrl: qid ? `https://www.wikidata.org/wiki/${qid}` : null,
      directGeoshapeUrl: qid ? `https://maps.wikimedia.org/geoshape?getgeojson=1&ids=${qid}` : null,
      source: result.source,
      sourceUrl: result.sourceUrl,
      coordinates: wikiMeta?.coordinates || null,
      trace,
    },
    geojson: result.geojson,
  };
}
