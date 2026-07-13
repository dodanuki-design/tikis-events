// ============================================================
// api/events.js — Tiki's Tokyo Event Calendar
// Google Calendar (iCal) → 構造化 JSON
//
// 出力契約 (index.html が消費):
//   {
//     events: [
//       {
//         date: "YYYY-MM-DD",
//         type: "hula" | "music" | "yoga" | "workshop" | "special" | "closed",
//         title: string,                 // pill / modal にそのまま表示
//         times: string[],               // ["19:30"] や ["15:00–17:00"]。空 = 時刻欄非表示
//         description: string | undefined  // モーダルに表示。ゲスト・Music Charge 等を含む
//       }
//     ],
//     fetchedAt: ISO string
//   }
//
// 依存ライブラリゼロ（native fetch + 軽量 iCal パーサー）。旧版で node-ical が
// CommonJS で require できず 500 になっていた問題を解消。
// ============================================================

const CATEGORIES_CONFIG = require('../config/categories.json');
const DISPLAY_CONFIG = require('../config/display.json');

// ---------- iCal パーサー (RFC5545 サブセット) ----------
function unfoldLines(text) {
  const raw = text.replace(/\r\n|\r/g, '\n').split('\n');
  const out = [];
  for (const line of raw) {
    if ((line.startsWith(' ') || line.startsWith('\t')) && out.length) {
      out[out.length - 1] += line.slice(1);
    } else {
      out.push(line);
    }
  }
  return out;
}

function unescapeText(s) {
  if (!s) return s;
  return s.replace(/\\n/gi, '\n').replace(/\\,/g, ',').replace(/\\;/g, ';').replace(/\\\\/g, '\\');
}

function splitProp(line) {
  const colon = line.indexOf(':');
  if (colon < 0) return null;
  const head = line.slice(0, colon);
  const value = line.slice(colon + 1);
  const parts = head.split(';');
  const name = parts[0].toUpperCase();
  const params = {};
  for (let i = 1; i < parts.length; i++) {
    const eq = parts[i].indexOf('=');
    if (eq > 0) params[parts[i].slice(0, eq).toUpperCase()] = parts[i].slice(eq + 1);
  }
  return { name, params, value };
}

function parseICalDateTime(value, params) {
  if (!value) return null;
  const isDateOnly = !value.includes('T');
  const m = value.match(/^(\d{4})(\d{2})(\d{2})(?:T(\d{2})(\d{2})(\d{2}))?(Z?)$/);
  if (!m) return null;
  const [, y, mo, d, h = '00', mi = '00', s = '00', z] = m;
  if (isDateOnly) {
    return { date: new Date(Date.UTC(+y, +mo - 1, +d, -9, 0, 0)), allDay: true };
  }
  if (z === 'Z') {
    return { date: new Date(Date.UTC(+y, +mo - 1, +d, +h, +mi, +s)), allDay: false };
  }
  const tzid = (params && params.TZID) || 'Asia/Tokyo';
  if (/^Asia\/Tokyo$|^JST$/i.test(tzid)) {
    return { date: new Date(Date.UTC(+y, +mo - 1, +d, +h - 9, +mi, +s)), allDay: false };
  }
  return { date: new Date(Date.UTC(+y, +mo - 1, +d, +h, +mi, +s)), allDay: false };
}

function parseICS(text) {
  const lines = unfoldLines(text);
  const events = [];
  let cur = null;
  for (const raw of lines) {
    if (!raw) continue;
    if (raw === 'BEGIN:VEVENT') { cur = {}; continue; }
    if (raw === 'END:VEVENT') {
      if (cur && cur.uid && cur.start) events.push(cur);
      cur = null;
      continue;
    }
    if (!cur) continue;
    const p = splitProp(raw);
    if (!p) continue;
    switch (p.name) {
      case 'UID': cur.uid = p.value; break;
      case 'SUMMARY': cur.summary = unescapeText(p.value); break;
      case 'DESCRIPTION': cur.description = unescapeText(p.value); break;
      case 'LOCATION': cur.location = unescapeText(p.value); break;
      case 'DTSTART': cur.start = parseICalDateTime(p.value, p.params); break;
      case 'DTEND': cur.end = parseICalDateTime(p.value, p.params); break;
      case 'STATUS': cur.status = p.value; break;
    }
  }
  return events;
}

// ---------- カテゴリ判定 ----------
function detectCategories(text) {
  const matched = [];
  const t = (text || '').trim();
  if (!t) return matched;
  for (const cat of CATEGORIES_CONFIG.categories) {
    let matchType = null;
    if (Array.isArray(cat.emojis)) {
      for (const emoji of cat.emojis) {
        if (t.includes(emoji)) { matchType = 'emoji'; break; }
      }
    }
    if (!matchType && Array.isArray(cat.keywords)) {
      for (const kw of cat.keywords) {
        if (t.includes(kw)) { matchType = 'keyword'; break; }
      }
    }
    if (matchType) matched.push({ ...cat, matchType });
  }
  return matched;
}

function pickPrimary(categories) {
  if (!categories.length) {
    const fb = CATEGORIES_CONFIG.categories.find(c => c.id === CATEGORIES_CONFIG.fallbackCategoryId);
    return fb || CATEGORIES_CONFIG.categories[0];
  }
  return [...categories].sort((a, b) => {
    if (a.matchType !== b.matchType) return a.matchType === 'emoji' ? -1 : 1;
    return (b.priority || 0) - (a.priority || 0);
  })[0];
}

function isFeatured(categories, title) {
  return categories.some(c => c.markFeatured) || /1\s*周年|周年記念|Anniversary|🎉|🎊/i.test(title || '');
}

// ---------- タイトル / ゲスト整形 ----------
function dedupe(arr) {
  return Array.from(new Set((arr || []).map(s => (s || '').trim()).filter(Boolean)));
}

function extractGuestAndCleanTitle(title) {
  if (!title) return { cleanTitle: '', guests: [] };
  let cleanTitle = title;
  const guests = [];
  const conf = DISPLAY_CONFIG.guestExtractor;
  if (conf && Array.isArray(conf.patterns)) {
    for (const p of conf.patterns) {
      const re = new RegExp(p.regex, 'g');
      let m;
      while ((m = re.exec(title)) !== null) {
        if (m[1]) guests.push(m[1].trim());
      }
      if (conf.stripFromTitle) cleanTitle = cleanTitle.replace(re, '').trim();
    }
  }
  if (DISPLAY_CONFIG.titleCleanup && Array.isArray(DISPLAY_CONFIG.titleCleanup.stripPatterns)) {
    for (const ptn of DISPLAY_CONFIG.titleCleanup.stripPatterns) {
      cleanTitle = cleanTitle.replace(new RegExp(ptn, 'g'), '').trim();
    }
  }
  cleanTitle = cleanTitle.replace(/\s{2,}/g, ' ').trim();
  return { cleanTitle, guests: dedupe(guests) };
}

// ---------- 説明欄パース → properties (ラベル/値ペア) ----------
function parseDescription(desc) {
  const result = { properties: [], freeText: '' };
  if (!desc) return result;
  const text = String(desc).replace(/\r\n/g, '\n').trim();
  const lines = text.split('\n').map(l => l.trim()).filter(Boolean);
  const fieldDefs = (DISPLAY_CONFIG.descriptionParsers && DISPLAY_CONFIG.descriptionParsers.fields) || [];
  const remaining = [];
  for (const line of lines) {
    const m = line.match(/^([^:：]+)[:：]\s*(.+)$/);
    if (!m) { remaining.push(line); continue; }
    const key = m[1].trim();
    const value = m[2].trim();
    const def = fieldDefs.find(d => d.keys.some(k => k.toLowerCase() === key.toLowerCase()));
    result.properties.push({
      label: def ? def.label : key,
      value,
    });
  }
  result.freeText = remaining.join('\n').trim();
  return result;
}

// ---------- 説明文の組み立て: ゲスト + properties + freeText ----------
function buildDescription(guests, properties, freeText) {
  const lines = [];
  const conf = DISPLAY_CONFIG.guestExtractor || {};
  const prefix = conf.guestPrefix || 'ゲスト：';
  const sep = conf.guestSeparator || ' / ';

  // 説明欄の "ゲスト" プロパティもタイトル抽出ゲストとマージ
  const propGuests = properties.filter(p => p.label === 'ゲスト').map(p => p.value);
  const allGuests = dedupe([...guests, ...propGuests]);
  if (allGuests.length) lines.push(prefix + allGuests.join(sep));

  for (const p of properties) {
    if (p.label === 'ゲスト') continue;
    lines.push(`${p.label}：${p.value}`);
  }
  if (freeText) lines.push(freeText);
  return lines.join('\n');
}

// ---------- 複合カテゴリのタイトル分割 ----------
// 1イベントに複数カテゴリ (例: "🎵 MONDAY MUSIC × HULA SHOW") がある時、
// 区切り文字でタイトルを分割し、各カテゴリにマッチする部分タイトルを取り出す。
function splitCompositeTitle(cleanTitle, matchedCats) {
  const conf = DISPLAY_CONFIG.compositeSplitter;
  if (!conf || !conf.enabled) return null;
  if (matchedCats.length < 2) return null;

  const seps = (conf.separators && conf.separators.length) ? conf.separators : ['×', '✕'];
  // 全 separator を統一マーカーに置換 → split
  const MARKER = ' SPLIT ';
  let working = cleanTitle;
  for (const s of seps) working = working.split(s).join(MARKER);
  const parts = working.split(MARKER).map(s => s.trim()).filter(Boolean);
  if (parts.length < 2) return null;

  // 各部分タイトルのカテゴリを再判定し、対応する {type, title} を返す
  const segs = [];
  const seenTypes = new Set();
  for (const part of parts) {
    const cats = detectCategories(part);
    if (!cats.length) continue;
    const prim = pickPrimary(cats);
    if (seenTypes.has(prim.id)) continue;
    seenTypes.add(prim.id);
    segs.push({ type: prim.id, title: part });
  }
  return segs.length >= 2 ? segs : null;
}

// ---------- 複数日イベントの展開 ----------
// 終日イベントが複数日にまたがる場合（例: 予約停止期間 7/20〜7/25）、日ごとの
// イベントに分割して各日のマスに表示させる。iCal の DTEND は排他的
// （7/20〜7/25 の予定は DTEND=7/26）なので span がそのまま日数になる。
const DAY_MS = 24 * 60 * 60 * 1000;
const MULTI_DAY_CAP = 92; // 3か月上限（入力ミスによる無限展開ガード）

function expandMultiDay(e) {
  if (!e.start || !e.start.allDay || !e.end || !e.end.allDay) return [e];
  const span = Math.round((e.end.date.getTime() - e.start.date.getTime()) / DAY_MS);
  if (span <= 1) return [e];
  const out = [];
  const days = Math.min(span, MULTI_DAY_CAP);
  for (let i = 0; i < days; i++) {
    const d = new Date(e.start.date.getTime() + i * DAY_MS);
    out.push({
      ...e,
      start: { date: d, allDay: true },
      end: { date: new Date(d.getTime() + DAY_MS), allDay: true },
    });
  }
  return out;
}

// ---------- JST 時刻ヘルパ ----------
const JST_OFFSET_MS = 9 * 60 * 60 * 1000;
function toJSTDateStr(date) {
  const d = new Date(date.getTime() + JST_OFFSET_MS);
  return `${d.getUTCFullYear()}-${String(d.getUTCMonth() + 1).padStart(2, '0')}-${String(d.getUTCDate()).padStart(2, '0')}`;
}
function toJSTTime(date) {
  const d = new Date(date.getTime() + JST_OFFSET_MS);
  return `${String(d.getUTCHours()).padStart(2, '0')}:${String(d.getUTCMinutes()).padStart(2, '0')}`;
}

// ---------- メインハンドラ ----------
module.exports = async (req, res) => {
  const url = process.env.GCAL_ICAL_URL;
  if (!url) {
    res.setHeader('Cache-Control', 'no-store');
    return res.status(500).json({ error: 'GCAL_ICAL_URL is not set', events: [] });
  }

  try {
    const response = await fetch(url);
    if (!response.ok) throw new Error(`Calendar fetch failed: ${response.status}`);
    const icalText = await response.text();
    const rawEvents = parseICS(icalText);

    // 範囲: 1か月前〜6か月先
    const now = new Date();
    const rangeStart = new Date(now.getFullYear(), now.getMonth() - 1, 1);
    const rangeEnd = new Date(now.getFullYear(), now.getMonth() + 6, 31);

    // 複数日イベントを日ごとに展開してから範囲フィルタ
    // （範囲開始前に始まり範囲内まで続く期間イベントを取りこぼさないため、展開が先）
    const expanded = rawEvents.flatMap(expandMultiDay);
    const inRange = expanded.filter(e => e.start && e.start.date >= rangeStart && e.start.date <= rangeEnd);

    // ---- 中間表現にマップ ----
    const intermediate = inRange.map(e => {
      const startDate = e.start.date;
      const endDate = e.end ? e.end.date : null;
      const allDay = e.start.allDay === true;

      const dateStr = toJSTDateStr(startDate);
      const startTime = allDay ? null : toJSTTime(startDate);
      let endTime = null;
      if (endDate && !allDay && endDate.getTime() > startDate.getTime()) {
        endTime = toJSTTime(endDate);
        if (endTime === startTime) endTime = null;
      }

      const matchedCats = detectCategories(e.summary);
      const primary = pickPrimary(matchedCats);
      const featured = isFeatured(matchedCats, e.summary);
      const { cleanTitle, guests } = extractGuestAndCleanTitle(e.summary);
      const desc = parseDescription(e.description);
      const description = buildDescription(guests, desc.properties, desc.freeText) || undefined;

      return {
        dateStr, startTime, endTime, allDay,
        matchedCats, primary, featured,
        cleanTitle, description,
        rawTitle: e.summary || '',
      };
    });

    // ---- デザイン契約形式へ変換 + 複合分割 ----
    const closedConf = DISPLAY_CONFIG.closedDisplay || {};
    const timeConf = DISPLAY_CONFIG.timeDisplay || {};

    const events = [];
    for (const it of intermediate) {
      // (1) ステータス系（貸切 / ご予約受付停止中 など isStatus: true のカテゴリ）
      // タイトル行 = statusLabel 固定文言、時刻行 = 範囲。終日なら時刻なし。
      const statusCat = it.matchedCats.find(c => c.isStatus);
      if (statusCat) {
        let timeStr = '';
        if (it.startTime && it.endTime) {
          timeStr = (closedConf.rangeFormat || '{startTime}–{endTime}')
            .replace('{startTime}', it.startTime).replace('{endTime}', it.endTime);
        } else if (it.startTime) {
          timeStr = (closedConf.noEndTimeFormat || '{startTime}〜').replace('{startTime}', it.startTime);
        }
        events.push({
          date: it.dateStr,
          type: statusCat.id,
          title: statusCat.statusLabel || closedConf.label || '貸切',
          times: timeStr ? [timeStr] : [],
          description: it.description,
        });
        continue;
      }

      // (2) featured + allDay: 時刻欄なし
      const hideTime = timeConf.hideTimeForFeaturedAllDay && it.featured && it.allDay;
      const baseTimes = hideTime ? [] : (it.allDay ? [] : (it.startTime ? [it.startTime] : []));

      // (3) 複合カテゴリ分割 (5/11 MONDAY MUSIC × HULA SHOW など)
      const segs = splitCompositeTitle(it.cleanTitle, it.matchedCats);
      if (segs) {
        for (const seg of segs) {
          events.push({
            date: it.dateStr,
            type: seg.type,
            title: seg.title,
            times: baseTimes.slice(),
            description: it.description,
          });
        }
        continue;
      }

      // (4) 通常イベント
      events.push({
        date: it.dateStr,
        type: it.primary ? it.primary.id : (CATEGORIES_CONFIG.fallbackCategoryId || 'hula'),
        title: it.cleanTitle || it.rawTitle,
        times: baseTimes,
        description: it.description,
      });
    }

    // ---- 同日同タイトル＋同 type の集約 (複数ショータイム対応) ----
    const groupKey = (ev) => `${ev.date}|${ev.title}|${ev.type}`;
    const groups = new Map();
    for (const ev of events) {
      const k = groupKey(ev);
      if (!groups.has(k)) {
        groups.set(k, { ...ev, times: ev.times.slice() });
      } else {
        const g = groups.get(k);
        for (const t of ev.times) if (!g.times.includes(t)) g.times.push(t);
        // description: 最初のものを採用 (重複防止)
        if (!g.description && ev.description) g.description = ev.description;
      }
    }

    const merged = Array.from(groups.values()).sort((a, b) => {
      if (a.date !== b.date) return a.date.localeCompare(b.date);
      const ta = (a.times[0] || '');
      const tb = (b.times[0] || '');
      return ta.localeCompare(tb);
    });

    res.setHeader('Cache-Control', 's-maxage=300, stale-while-revalidate=60');
    res.setHeader('Access-Control-Allow-Origin', '*');
    return res.status(200).json({
      events: merged,
      fetchedAt: new Date().toISOString(),
      count: merged.length,
    });
  } catch (err) {
    console.error('Events API error:', err);
    res.setHeader('Cache-Control', 'no-store');
    return res.status(500).json({ error: err.message, events: [], fetchedAt: null });
  }
};
