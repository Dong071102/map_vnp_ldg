import zlib from 'node:zlib';
import { ringAreaSqMeters } from '../../frontend/js/geometry.js';

const DEFAULT_WORK_HOURS = [
  'Mon: 07:00 - 17:00',
  'Tue: 07:00 - 17:00',
  'Wed: 07:00 - 17:00',
  'Thu: 07:00 - 17:00',
  'Fri: 07:00 - 17:00',
  'Sat: 07:00 - 17:00',
  'Sun: 07:00 - 17:00',
].join('\n');

const NODES_HEADERS = [
  'Mã nút *',
  'Tên nút *',
  'Loại nút *',
  'Loại bưu cục *',
  'Mô hình vận hành',
  'Thương hiệu sở hữu',
  'Hình thức sở hữu',
  'Diện tích (m²)',
  'Địa giới hành chính *',
  'Địa chỉ chi tiết',
  'Mã bưu cục cấp trên',
  'Tên bưu cục cấp trên',
  'Người liên hệ',
  'Số điện thoại',
  'Sản lượng tối đa/ngày *',
  'Giờ hoạt động',
  'Trạng thái *',
  'Kinh độ *',
  'Vĩ độ *',
  'Khu vực nhận/giao (vị trí bản đồ)',
  'Loại hàng rào GIS',
  'Bán kính hàng rào GIS',
  'Mã phòng ban',
];

const NODE_SLA_HEADERS = [
  'Mã nút *',
  'Quản lý SLA - Số thứ tự',
  'Quản lý SLA - Đối tượng áp dụng',
  'Quản lý SLA - Cấp tốc độ',
  'Quản lý SLA - Mã sản phẩm dịch vụ',
  'Quản lý SLA - Mã khách hàng',
  'Quản lý SLA - Công đoạn',
  'Quản lý SLA - SLA kế hoạch (h)',
  'Quản lý SLA - SLA cảnh báo (h)',
  'Quản lý SLA - SLA báo động (h)',
];

const COUNTERS_HEADERS = ['Mã nút *', 'Quản lý quầy - Mã quầy', 'Quản lý quầy - Tên quầy'];

// --- Helpers for VNPost field formatting ---
export function parseBcvhCode(rawCode) {
  const s = String(rawCode || '').trim();
  if (!s) return { nodeCode: '', deptCode: '' };
  const parts = s.split(/[|/]/).map((p) => p.trim());
  return {
    nodeCode: parts[0] || '',
    deptCode: parts[1] || '',
  };
}

export function formatAdminPath(hostWardName) {
  const raw = String(hostWardName || '').trim();
  if (!raw) return 'Tỉnh Lâm Đồng';
  if (/^Xã\s+/i.test(raw)) {
    return `Tỉnh Lâm Đồng/X. ${raw.replace(/^Xã\s+/i, '').trim()}`;
  }
  if (/^Phường\s+/i.test(raw)) {
    return `Tỉnh Lâm Đồng/P. ${raw.replace(/^Phường\s+/i, '').trim()}`;
  }
  return `Tỉnh Lâm Đồng/${raw}`;
}

function sqSegDist(p, a, b) {
  let x = a[0];
  let y = a[1];
  let dx = b[0] - x;
  let dy = b[1] - y;
  if (dx !== 0 || dy !== 0) {
    const t = ((p[0] - x) * dx + (p[1] - y) * dy) / (dx * dx + dy * dy);
    if (t > 1) {
      x = b[0];
      y = b[1];
    } else if (t > 0) {
      x += dx * t;
      y += dy * t;
    }
  }
  dx = p[0] - x;
  dy = p[1] - y;
  return dx * dx + dy * dy;
}

function simplifyDP(pts, sqTol) {
  if (pts.length <= 4) return pts;
  const keep = new Uint8Array(pts.length);
  keep[0] = 1;
  keep[pts.length - 1] = 1;
  const stack = [[0, pts.length - 1]];
  while (stack.length > 0) {
    const [first, last] = stack.pop();
    let maxSq = 0;
    let idx = -1;
    for (let i = first + 1; i < last; i++) {
      const d = sqSegDist(pts[i], pts[first], pts[last]);
      if (d > maxSq) {
        maxSq = d;
        idx = i;
      }
    }
    if (maxSq > sqTol && idx !== -1) {
      keep[idx] = 1;
      if (idx - first > 1) stack.push([first, idx]);
      if (last - idx > 1) stack.push([idx, last]);
    }
  }
  const out = [];
  for (let i = 0; i < pts.length; i++) if (keep[i]) out.push(pts[i]);
  return out;
}

function closeAndRoundRing(ring, decimals = 6) {
  const factor = 10 ** decimals;
  const pts = [];
  for (const c of ring || []) {
    const x = Math.round(Number(c[0]) * factor) / factor;
    const y = Math.round(Number(c[1]) * factor) / factor;
    if (!Number.isFinite(x) || !Number.isFinite(y)) continue;
    const prev = pts[pts.length - 1];
    if (prev && prev[0] === x && prev[1] === y) continue;
    pts.push([x, y]);
  }
  if (pts.length < 3) return null;
  const first = pts[0];
  const last = pts[pts.length - 1];
  if (first[0] !== last[0] || first[1] !== last[1]) pts.push([first[0], first[1]]);
  return pts.length >= 4 ? pts : null;
}

/**
 * Convert BCVH serviceGeojson to a single closed outer-ring Polygon (no holes, no MultiPolygon)
 * keeping 100% original un-simplified vertices (no character cap; long strings are split across
 * multiple Excel rows via #FENCE:k/N# in bcvhOfficeToNodeRows).
 */
export function buildExcelSafePolygonOneLine(serviceGeojson) {
  if (!serviceGeojson || typeof serviceGeojson !== 'object') return '';
  const outerRings = [];

  const collect = (g) => {
    if (!g) return;
    if (g.type === 'Polygon' && Array.isArray(g.coordinates) && g.coordinates[0]) {
      outerRings.push(g.coordinates[0]);
    } else if (g.type === 'MultiPolygon' && Array.isArray(g.coordinates)) {
      for (const poly of g.coordinates) {
        if (Array.isArray(poly) && poly[0]) outerRings.push(poly[0]);
      }
    } else if (g.type === 'GeometryCollection' && Array.isArray(g.geometries)) {
      g.geometries.forEach(collect);
    }
  };

  if (serviceGeojson.type === 'FeatureCollection') {
    for (const f of serviceGeojson.features || []) collect(f?.geometry);
  } else if (serviceGeojson.type === 'Feature') {
    collect(serviceGeojson.geometry);
  } else {
    collect(serviceGeojson);
  }

  if (outerRings.length === 0) return '';

  // Pick largest outer ring (VNPost Rule #20 does not support MultiPolygon or interior holes)
  let bestRing = outerRings[0];
  let bestArea = ringAreaSqMeters(bestRing);
  for (let i = 1; i < outerRings.length; i++) {
    const a = ringAreaSqMeters(outerRings[i]);
    if (a > bestArea) {
      bestArea = a;
      bestRing = outerRings[i];
    }
  }

  const closed = closeAndRoundRing(bestRing, 6);
  if (!closed) return '';
  return JSON.stringify({ type: 'Polygon', coordinates: [closed] });
}

export const FENCE_CHUNK_SIZE = 30000;

/**
 * Split a long GeoJSON Polygon string every 30,000 chars into VNPost multi-row chunks:
 *   #FENCE:1/N#<chunk1>, #FENCE:2/N#<chunk2>, ...
 * Strings <= chunkSize stay as a single un-prefixed cell.
 */
export function splitFenceChunks(geoOneLine, chunkSize = FENCE_CHUNK_SIZE) {
  const raw = String(geoOneLine || '');
  if (!raw || raw.length <= chunkSize) return [raw];
  const total = Math.ceil(raw.length / chunkSize);
  const chunks = [];
  for (let i = 0; i < total; i++) {
    const part = raw.slice(i * chunkSize, (i + 1) * chunkSize);
    chunks.push(`#FENCE:${i + 1}/${total}#${part}`);
  }
  return chunks;
}

export function getMissingExcelFields(office) {
  const missing = [];
  const area = office?.officeAreaM2;
  if (area === null || area === undefined || area === '' || !Number.isFinite(Number(area)) || Number(area) <= 0) {
    missing.push('Diện tích (m²)');
  }
  if (!String(office?.contactName || '').trim()) {
    missing.push('Người liên hệ');
  }
  if (!String(office?.contactPhone || '').trim()) {
    missing.push('Số điện thoại');
  }
  return missing;
}

export function validateBcvhForExcelExport(offices = []) {
  if (!Array.isArray(offices) || offices.length === 0) {
    return {
      ok: false,
      incomplete: [],
      message: 'Chưa có Bưu cục Vận hành nào để xuất Excel.',
    };
  }
  const incomplete = [];
  for (const office of offices) {
    const missing = getMissingExcelFields(office);
    if (missing.length > 0) {
      incomplete.push({ id: office?.id || null, name: office?.name || 'BCVH', missing });
    }
  }
  if (incomplete.length === 0) {
    return { ok: true, incomplete: [], message: '' };
  }
  if (offices.length === 1) {
    const item = incomplete[0];
    return {
      ok: false,
      incomplete,
      message: `Không thể xuất Excel cho "${item.name}": thiếu ${item.missing.join(', ')}. Vui lòng bổ sung trong Quản trị (/admin#bcvh).`,
    };
  }
  const sample = incomplete
    .slice(0, 3)
    .map((x) => x.name)
    .join(', ');
  const more = incomplete.length > 3 ? `, +${incomplete.length - 3} BCVH khác` : '';
  return {
    ok: false,
    incomplete,
    message: `Không thể xuất Excel: có ${incomplete.length}/${offices.length} BCVH chưa điền đủ Diện tích (m²), Người liên hệ, Số điện thoại (${sample}${more}).`,
  };
}

export function bcvhOfficeToNodeRow(office) {
  const { nodeCode, deptCode } = parseBcvhCode(office.code);
  const adminPath = formatAdminPath(office.hostWardName);
  const geoOneLine = buildExcelSafePolygonOneLine(office.serviceGeojson);
  const areaVal = office.officeAreaM2 !== null && office.officeAreaM2 !== undefined ? Number(office.officeAreaM2) : '';
  const lngVal = office.lng !== null && office.lng !== undefined ? Number(office.lng) : '';
  const latVal = office.lat !== null && office.lat !== undefined ? Number(office.lat) : '';

  return [
    nodeCode,
    office.name || '',
    'POST_OFFICE',
    'OPERATIONS_POST_OFFICE',
    'SELF_OPERATED_COLLECTION_AND_DELIVERY',
    'VNPOST',
    'OWNED',
    areaVal,
    adminPath,
    office.address || '',
    '67',
    'BĐT Lâm Đồng',
    office.contactName || '',
    office.contactPhone || '',
    2000,
    DEFAULT_WORK_HOURS,
    'ENABLE',
    lngVal,
    latVal,
    geoOneLine,
    'POLYGON',
    '',
    deptCode,
  ];
}

export function bcvhOfficeToNodeRows(office, { chunkSize = FENCE_CHUNK_SIZE } = {}) {
  const baseRow = bcvhOfficeToNodeRow(office);
  const chunks = splitFenceChunks(baseRow[19], chunkSize);
  return chunks.map((chunk) => {
    const copy = baseRow.slice();
    copy[19] = chunk;
    return copy;
  });
}

// --- Zero-dependency Valid XLSX (OOXML + ZIP) Writer ---
function escapeXml(str) {
  return String(str ?? '')
    .replace(/[\x00-\x08\x0B\x0C\x0E-\x1F]/g, '')
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;')
    .replace(/'/g, '&apos;');
}

function colIndexToLetters(idx) {
  let n = idx + 1;
  let letters = '';
  while (n > 0) {
    const rem = (n - 1) % 26;
    letters = String.fromCharCode(65 + rem) + letters;
    n = Math.floor((n - 1) / 26);
  }
  return letters;
}

function buildWorksheetXml(rows, { headerStyle = 1, wrapCols = new Set() } = {}) {
  const rowXmls = [];
  for (let r = 0; r < rows.length; r++) {
    const row = rows[r];
    const cells = [];
    for (let c = 0; c < row.length; c++) {
      const val = row[c];
      if (val === '' || val === null || val === undefined) continue;
      const ref = `${colIndexToLetters(c)}${r + 1}`;
      const styleIdx = r === 0 ? headerStyle : wrapCols.has(c) ? 2 : 0;
      const sAttr = styleIdx ? ` s="${styleIdx}"` : '';
      if (typeof val === 'number' && Number.isFinite(val)) {
        cells.push(`<c r="${ref}"${sAttr}><v>${val}</v></c>`);
      } else {
        const text = escapeXml(val);
        cells.push(`<c r="${ref}" t="inlineStr"${sAttr}><is><t xml:space="preserve">${text}</t></is></c>`);
      }
    }
    rowXmls.push(`<row r="${r + 1}">${cells.join('')}</row>`);
  }

  return (
    '<?xml version="1.0" encoding="UTF-8" standalone="yes"?>' +
    '<worksheet xmlns="http://schemas.openxmlformats.org/spreadsheetml/2006/main">' +
    `<sheetData>${rowXmls.join('')}</sheetData>` +
    '</worksheet>'
  );
}

// Standard CRC32 table for ZIP archive entries
const CRC_TABLE = new Uint32Array(256);
for (let i = 0; i < 256; i++) {
  let c = i;
  for (let k = 0; k < 8; k++) c = c & 1 ? 0xedb88320 ^ (c >>> 1) : c >>> 1;
  CRC_TABLE[i] = c >>> 0;
}

function crc32(buf) {
  let c = 0xffffffff;
  for (let i = 0; i < buf.length; i++) c = CRC_TABLE[(c ^ buf[i]) & 0xff] ^ (c >>> 8);
  return (c ^ 0xffffffff) >>> 0;
}

function createZipBuffer(entries) {
  const localParts = [];
  const centralParts = [];
  let offset = 0;

  for (const { name, data } of entries) {
    const nameBuf = Buffer.from(name, 'utf8');
    const rawBuf = Buffer.isBuffer(data) ? data : Buffer.from(data, 'utf8');
    const compressed = zlib.deflateRawSync(rawBuf);
    const crc = crc32(rawBuf);

    const localHeader = Buffer.alloc(30);
    localHeader.writeUInt32LE(0x04034b50, 0); // local file header signature
    localHeader.writeUInt16LE(20, 4); // version needed
    localHeader.writeUInt16LE(0x0800, 6); // UTF-8 flag
    localHeader.writeUInt16LE(8, 8); // deflate
    localHeader.writeUInt16LE(0, 10);
    localHeader.writeUInt16LE(0, 12);
    localHeader.writeUInt32LE(crc, 14);
    localHeader.writeUInt32LE(compressed.length, 18);
    localHeader.writeUInt32LE(rawBuf.length, 22);
    localHeader.writeUInt16LE(nameBuf.length, 26);
    localHeader.writeUInt16LE(0, 28);

    localParts.push(localHeader, nameBuf, compressed);

    const centralHeader = Buffer.alloc(46);
    centralHeader.writeUInt32LE(0x02014b50, 0); // central dir signature
    centralHeader.writeUInt16LE(20, 4);
    centralHeader.writeUInt16LE(20, 6);
    centralHeader.writeUInt16LE(0x0800, 8);
    centralHeader.writeUInt16LE(8, 10);
    centralHeader.writeUInt16LE(0, 12);
    centralHeader.writeUInt16LE(0, 14);
    centralHeader.writeUInt32LE(crc, 16);
    centralHeader.writeUInt32LE(compressed.length, 20);
    centralHeader.writeUInt32LE(rawBuf.length, 24);
    centralHeader.writeUInt16LE(nameBuf.length, 28);
    centralHeader.writeUInt16LE(0, 30);
    centralHeader.writeUInt16LE(0, 32);
    centralHeader.writeUInt16LE(0, 34);
    centralHeader.writeUInt16LE(0, 36);
    centralHeader.writeUInt32LE(0, 38);
    centralHeader.writeUInt32LE(offset, 42);

    centralParts.push(centralHeader, nameBuf);
    offset += localHeader.length + nameBuf.length + compressed.length;
  }

  const centralDir = Buffer.concat(centralParts);
  const endRecord = Buffer.alloc(22);
  endRecord.writeUInt32LE(0x06054b50, 0);
  endRecord.writeUInt16LE(0, 4);
  endRecord.writeUInt16LE(0, 6);
  endRecord.writeUInt16LE(entries.length, 8);
  endRecord.writeUInt16LE(entries.length, 10);
  endRecord.writeUInt32LE(centralDir.length, 12);
  endRecord.writeUInt32LE(offset, 16);
  endRecord.writeUInt16LE(0, 20);

  return Buffer.concat([...localParts, centralDir, endRecord]);
}

export function buildBcvhWorkbookBuffer(offices = []) {
  const nodesRows = [NODES_HEADERS];
  const slaRows = [NODE_SLA_HEADERS];
  const counterRows = [COUNTERS_HEADERS];

  for (const office of offices) {
    const rowsForOffice = bcvhOfficeToNodeRows(office);
    const nodeCode = rowsForOffice[0]?.[0] || '';
    for (const row of rowsForOffice) nodesRows.push(row);
    slaRows.push([nodeCode, '', '', '', '', '', '', '', '', '']);
    counterRows.push([nodeCode, '', '']);
  }

  const contentTypesXml =
    '<?xml version="1.0" encoding="UTF-8" standalone="yes"?>' +
    '<Types xmlns="http://schemas.openxmlformats.org/package/2006/content-types">' +
    '<Default Extension="rels" ContentType="application/vnd.openxmlformats-package.relationships+xml"/>' +
    '<Default Extension="xml" ContentType="application/xml"/>' +
    '<Override PartName="/xl/workbook.xml" ContentType="application/vnd.openxmlformats-officedocument.spreadsheetml.sheet.main+xml"/>' +
    '<Override PartName="/xl/styles.xml" ContentType="application/vnd.openxmlformats-officedocument.spreadsheetml.styles+xml"/>' +
    '<Override PartName="/xl/worksheets/sheet1.xml" ContentType="application/vnd.openxmlformats-officedocument.spreadsheetml.worksheet+xml"/>' +
    '<Override PartName="/xl/worksheets/sheet2.xml" ContentType="application/vnd.openxmlformats-officedocument.spreadsheetml.worksheet+xml"/>' +
    '<Override PartName="/xl/worksheets/sheet3.xml" ContentType="application/vnd.openxmlformats-officedocument.spreadsheetml.worksheet+xml"/>' +
    '</Types>';

  const rootRelsXml =
    '<?xml version="1.0" encoding="UTF-8" standalone="yes"?>' +
    '<Relationships xmlns="http://schemas.openxmlformats.org/package/2006/relationships">' +
    '<Relationship Id="rId1" Type="http://schemas.openxmlformats.org/officeDocument/2006/relationships/officeDocument" Target="xl/workbook.xml"/>' +
    '</Relationships>';

  const workbookXml =
    '<?xml version="1.0" encoding="UTF-8" standalone="yes"?>' +
    '<workbook xmlns="http://schemas.openxmlformats.org/spreadsheetml/2006/main" xmlns:r="http://schemas.openxmlformats.org/officeDocument/2006/relationships">' +
    '<sheets>' +
    '<sheet name="Nodes" sheetId="1" r:id="rId1"/>' +
    '<sheet name="NodeSLA" sheetId="2" r:id="rId2"/>' +
    '<sheet name="Counters" sheetId="3" r:id="rId3"/>' +
    '</sheets>' +
    '</workbook>';

  const workbookRelsXml =
    '<?xml version="1.0" encoding="UTF-8" standalone="yes"?>' +
    '<Relationships xmlns="http://schemas.openxmlformats.org/package/2006/relationships">' +
    '<Relationship Id="rId1" Type="http://schemas.openxmlformats.org/officeDocument/2006/relationships/worksheet" Target="worksheets/sheet1.xml"/>' +
    '<Relationship Id="rId2" Type="http://schemas.openxmlformats.org/officeDocument/2006/relationships/worksheet" Target="worksheets/sheet2.xml"/>' +
    '<Relationship Id="rId3" Type="http://schemas.openxmlformats.org/officeDocument/2006/relationships/worksheet" Target="worksheets/sheet3.xml"/>' +
    '<Relationship Id="rId4" Type="http://schemas.openxmlformats.org/officeDocument/2006/relationships/styles" Target="styles.xml"/>' +
    '</Relationships>';

  // Styles: 0 = default, 1 = bold header with light gray fill, 2 = wrapText (for Giờ hoạt động)
  const stylesXml =
    '<?xml version="1.0" encoding="UTF-8" standalone="yes"?>' +
    '<styleSheet xmlns="http://schemas.openxmlformats.org/spreadsheetml/2006/main">' +
    '<fonts count="2">' +
    '<font><sz val="11"/><name val="Calibri"/></font>' +
    '<font><b/><sz val="11"/><name val="Calibri"/></font>' +
    '</fonts>' +
    '<fills count="3">' +
    '<fill><patternFill patternType="none"/></fill>' +
    '<fill><patternFill patternType="gray125"/></fill>' +
    '<fill><patternFill patternType="solid"><fgColor rgb="FFE2E8F0"/></patternFill></fill>' +
    '</fills>' +
    '<borders count="1"><border><left/><right/><top/><bottom/><diagonal/></border></borders>' +
    '<cellStyleXfs count="1"><xf numFmtId="0" fontId="0" fillId="0" borderId="0"/></cellStyleXfs>' +
    '<cellXfs count="3">' +
    '<xf numFmtId="0" fontId="0" fillId="0" borderId="0" xfId="0"/>' +
    '<xf numFmtId="0" fontId="1" fillId="2" borderId="0" xfId="0" applyFont="1" applyFill="1"/>' +
    '<xf numFmtId="0" fontId="0" fillId="0" borderId="0" xfId="0" applyAlignment="1"><alignment wrapText="1"/></xf>' +
    '</cellXfs>' +
    '</styleSheet>';

  const sheet1Xml = buildWorksheetXml(nodesRows, { wrapCols: new Set([15]) });
  const sheet2Xml = buildWorksheetXml(slaRows);
  const sheet3Xml = buildWorksheetXml(counterRows);

  return createZipBuffer([
    { name: '[Content_Types].xml', data: contentTypesXml },
    { name: '_rels/.rels', data: rootRelsXml },
    { name: 'xl/workbook.xml', data: workbookXml },
    { name: 'xl/_rels/workbook.xml.rels', data: workbookRelsXml },
    { name: 'xl/styles.xml', data: stylesXml },
    { name: 'xl/worksheets/sheet1.xml', data: sheet1Xml },
    { name: 'xl/worksheets/sheet2.xml', data: sheet2Xml },
    { name: 'xl/worksheets/sheet3.xml', data: sheet3Xml },
  ]);
}
