import fs from 'node:fs/promises';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);
const LOCAL_TABLE_PATH = path.resolve(__dirname, '..', '..', 'table.html');

export const LAMDONG_WIKI_PAGE_URL =
  'https://vi.wikipedia.org/wiki/Danh_s%C3%A1ch_%C4%91%C6%A1n_v%E1%BB%8B_h%C3%A0nh_ch%C3%ADnh_thu%E1%BB%99c_t%E1%BB%89nh_L%C3%A2m_%C4%90%E1%BB%93ng';

const USER_AGENT = 'WikiGeoJSONExtractor/2.0 (https://localhost; local-dev-tool)';

function decodeHtmlEntities(str) {
  return String(str || '')
    .replace(/&nbsp;/gi, ' ')
    .replace(/&amp;/gi, '&')
    .replace(/&quot;/gi, '"')
    .replace(/&#39;|&apos;/gi, "'")
    .replace(/&lt;/gi, '<')
    .replace(/&gt;/gi, '>')
    .replace(/&#(\d+);/g, (_, num) => String.fromCharCode(Number(num)))
    .replace(/&#x([0-9a-f]+);/gi, (_, hex) => String.fromCharCode(parseInt(hex, 16)));
}

function stripTagsAndRefs(html) {
  return decodeHtmlEntities(
    String(html || '')
      .replace(/<sup\b[^>]*>[\s\S]*?<\/sup>/gi, '')
      .replace(/<[^>]+>/g, ' '),
  )
    .replace(/\s+/g, ' ')
    .trim();
}

export function normalizeWikiMapUrl(href) {
  const raw = decodeHtmlEntities(String(href || '').trim());
  if (!raw) return '';
  try {
    const full = raw.startsWith('http')
      ? raw
      : `https://vi.wikipedia.org${raw.startsWith('/') ? '' : '/'}${raw}`;
    const u = new URL(full);
    return `${u.origin}${u.pathname}#/map/0`;
  } catch {
    return raw;
  }
}

function parseViNumber(text, isInteger = false) {
  const cleaned = String(text || '')
    .replace(/\s+/g, '')
    .replace(/[^0-9.,]/g, '');
  if (!cleaned) return 0;
  if (isInteger) {
    return Number.parseInt(cleaned.replace(/[.,]/g, ''), 10) || 0;
  }
  // Vietnamese format: thousands '.', decimal ','
  const normalized = cleaned.replace(/\./g, '').replace(',', '.');
  return Number.parseFloat(normalized) || 0;
}

function normalizeUnitType(rawText) {
  const lower = rawText.trim().toLowerCase();
  if (lower.startsWith('phường')) return 'Phường';
  if (lower.startsWith('đặc khu')) return 'Đặc khu';
  if (lower.startsWith('xã')) return 'Xã';
  if (lower.startsWith('thị trấn')) return 'Thị trấn';
  return 'Xã';
}

export function parseLamDongTableHtml(html) {
  const source = String(html || '');
  const trMatches = source.matchAll(/<tr\b[^>]*>([\s\S]*?)<\/tr>/gi);
  const units = [];
  const seenStt = new Set();

  for (const trMatch of trMatches) {
    const rowHtml = trMatch[1];
    const cells = [...rowHtml.matchAll(/<td\b[^>]*>([\s\S]*?)<\/td>/gi)].map((m) => m[1]);
    if (cells.length < 4) continue;

    const sttText = stripTagsAndRefs(cells[0]);
    if (!/^\d+$/.test(sttText)) continue;
    const stt = Number.parseInt(sttText, 10);
    if (stt <= 0 || seenStt.has(stt)) continue;

    const nameCellHtml = cells[1];
    const rawName = stripTagsAndRefs(nameCellHtml);
    if (!rawName) continue;

    const unitType = normalizeUnitType(rawName);
    // Normalize lowercase leading prefix like "xã Cát Tiên" -> "Xã Cát Tiên"
    const cleanName = rawName.replace(/^(phường|xã|đặc khu|thị trấn)\s+/i, `${unitType} `);

    const linkMatch = nameCellHtml.match(/<a\b[^>]*\bhref\s*=\s*"([^"]+)"/i);
    const wikiUrl = linkMatch ? normalizeWikiMapUrl(linkMatch[1]) : '';

    const areaOfficialKm2 = parseViNumber(stripTagsAndRefs(cells[2]), false);
    const population2025 = parseViNumber(stripTagsAndRefs(cells[3]), true);
    const subUnits = cells[4] ? stripTagsAndRefs(cells[4]) : '';

    seenStt.add(stt);
    units.push({
      stt,
      unitType,
      name: cleanName,
      wikiUrl,
      areaOfficialKm2,
      population2025,
      subUnits,
    });
  }

  return units.sort((a, b) => a.stt - b.stt);
}

export async function loadLamDongUnitsFromLocalFile() {
  const html = await fs.readFile(LOCAL_TABLE_PATH, 'utf8');
  return parseLamDongTableHtml(html);
}

export async function fetchLamDongUnitsFromWikipedia(pageUrl = LAMDONG_WIKI_PAGE_URL) {
  const parsed = new URL(pageUrl);
  const title = parsed.pathname.startsWith('/wiki/')
    ? decodeURIComponent(parsed.pathname.slice('/wiki/'.length))
    : 'Danh_sách_đơn_vị_hành_chính_thuộc_tỉnh_Lâm_Đồng';

  const apiUrl = new URL(`https://${parsed.hostname}/w/api.php`);
  apiUrl.searchParams.set('action', 'parse');
  apiUrl.searchParams.set('page', title);
  apiUrl.searchParams.set('prop', 'text');
  apiUrl.searchParams.set('redirects', '1');
  apiUrl.searchParams.set('format', 'json');
  apiUrl.searchParams.set('formatversion', '2');

  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), 20000);
  try {
    const resp = await fetch(apiUrl.toString(), {
      headers: { 'User-Agent': USER_AGENT, Accept: 'application/json' },
      signal: controller.signal,
    });
    if (!resp.ok) throw new Error(`HTTP ${resp.status} từ Wikipedia`);
    const data = await resp.json();
    const html = data?.parse?.text;
    if (!html) throw new Error('Wikipedia không trả về nội dung bảng.');

    // Extract tables and find the main 2025 commune-level administrative table
    const tables = [...html.matchAll(/<table\b[^>]*>[\s\S]*?<\/table>/gi)].map((m) => m[0]);
    for (const tbl of tables) {
      if (!/Đơn vị hành chính cấp xã/i.test(tbl)) continue;
      const units = parseLamDongTableHtml(tbl);
      if (units.length >= 100) return units;
    }

    const fallbackUnits = parseLamDongTableHtml(html);
    if (fallbackUnits.length === 0) {
      throw new Error('Không tìm thấy bảng đơn vị hành chính cấp xã trên trang Wikipedia.');
    }
    return fallbackUnits;
  } finally {
    clearTimeout(timer);
  }
}
