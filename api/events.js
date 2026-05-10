// ============================================================
// api/events.js
// Google Calendar (iCal) → 構造化 JSON
// 判定ロジックは config/categories.json と config/display.json から読み込み。
// 1イベント複数カテゴリ対応 / 説明欄パース / 貸切時間範囲表示 等。
// ============================================================
const fs = require('fs');
const path = require('path');

// node-ical のロード失敗を捕捉（モジュールレベルのクラッシュ → FUNCTION_INVOCATION_FAILED を防ぐ）
let ical, _icalError;
try {
  ical = require('node-ical');
} catch (e) {
  _icalError = e;
}

// ----------- 設定ファイル読み込み（初回ハンドラ呼び出し時にキャッシュ） -----------
let CATEGORIES_CONFIG, DISPLAY_CONFIG, _initError;

function loadConfig(name) {
  const tryPaths = [
    path.join(process.cwd(), 'config', `${name}.json`),
    path.join(__dirname, '..', 'config', `${name}.json`),
    path.join(__dirname, 'config', `${name}.json`),
  ];
  for (const p of tryPaths) {
    if (fs.existsSync(p)) {
      return JSON.parse(fs.readFileSync(p, 'utf-8'));
    }
  }
  throw new Error(`Config not found: ${name}.json (tried: ${tryPaths.join(', ')})`);
}

function ensureConfig() {
  if (CATEGORIES_CONFIG && DISPLAY_CONFIG) return null;
  if (_initError) return _initError;
  try {
    CATEGORIES_CONFIG = loadConfig('categories');
    DISPLAY_CONFIG = loadConfig('display');
    return null;
  } catch (e) {
    _initError = e;
    return e;
  }
}

// ----------- 検出ヘルパー -----------
function detectCategories(title) {
  const matched = [];
  const t = (title || '').trim();
  if (!t) return matched;

  for (const cat of CATEGORIES_CONFIG.categories) {
    let matchType = null; // 'emoji' | 'keyword' | null

    // 1. 絵文字マッチ（明示的な意図表現）
    if (cat.emojis && cat.emojis.length) {
      for (const emoji of cat.emojis) {
        if (t.includes(emoji)) { matchType = 'emoji'; break; }
      }
    }

    // 2. キーワードマッチ後保険（保険時のみ。
    if (!matchType && cat.keywords && cat.keywords.length) {
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
  // 優先順位ルール:
  //   1) emoji マッチを keyword より優先（明示的な意図 > 部分文字列の偶然一致）
  //   2) 同じ matchType 内では priority の高い順
  // 例: 「🌸 ワークショップ（カンナフラワー）」
  //     - 🌸 → workshop (emoji) と 「フラ」→ hula_tahiti (keyword)
  //     - emoji 優先で workshop が primary になる
  return [...categories].sort((a, b) => {
    if (a.matchType !== b.matchType) {
      return a.matchType === 'emoji' ? -1 : 1;
    }
    return (b.priority || 0) - (a.priority || 0);
  })[0];
}

function isFeatured(categories, title) {
  // markFeatured カテゴリにマッチした、または special キーワード相当の場合
  return categories.some(c => c.markFeatured) || /1\s*周年|Anniversary|🎉|🎊/i.test(title || '');
}

// ----------- タイトル・ゲスト整形 -----------
function extractGuestAndCleanTitle(title) {
  if (!title) return { cleanTitle: '', guests: [] };
  let cleanTitle = title;
  const guests = [];

  const conf = DISPLAY_CONFIG.guestExtractor;
  if (conf && conf.patterns) {
    for (const p of conf.patterns) {
      const re = new RegExp(p.regex, 'g');
      let m;
      while ((m = re.exec(title)) !== null) {
        if (m[1]) {
          guests.push(m[1].trim());
        }
      }
      if (conf.stripFromTitle) {
        cleanTitle = cleanTitle.replace(re, '').trim();
      }
    }
  }

  // 表示用の追加クリーンアップ
  if (DISPLAY_CONFIG.titleCleanup && DISPLAY_CONFIG.titleCleanup.stripPatterns) {
    for (const ptn of DISPLAY_CONFIG.titleCleanup.stripPatterns) {
      cleanTitle = cleanTitle.replace(new RegExp(ptn, 'g'), '').trim();
    }
  }

  // 余分な空白を圧縮
  cleanTitle = cleanTitle.replace(/\s{2,}/g, ' ').trim();

  return { cleanTitle, guests: dedupe(guests) };
}

function dedupe(arr) {
  return Array.from(new Set(arr.filter(Boolean)));
}

// ----------- 説明欄パース -----------
function parseDescription(desc) {
  const result = { properties: [], freeText: '' };
  if (!desc) return result;

  const text = String(desc).replace(/\r\n/g, '\n').trim();
  const lines = text.split('\n').map(l => l.trim()).filter(Boolean);
  const fieldDefs = (DISPLAY_CONFIG.descriptionParsers && DISPLAY_CONFIG.descriptionParsers.fields) || [];

  const remainingLines = [];
  for (const line of lines) {
    const m = line.match(/^([^:：]+)[:：]\s*(.+)$/);
    if (!m) {
      remainingLines.push(line);
      continue;
    }
    const key = m[1].trim();
    const value = m[2].trim();
    const def = fieldDefs.find(d => d.keys.some(k => k.toLowerCase() === key.toLowerCase()));
    if (def) {
      result.properties.push({
        label: def.label,
        value: value,
        isLink: def.isLink || /^https?:\/\//.test(value),
      });
    } else {
      // 未定義のKey:Value も保持（汎用性）
      result.properties.push({
        label: key,
        value: value,
        isLink: /^https?:\/\//.test(value),
      });
    }
  }

  result.freeText = remainingLines.join('\n').trim();
  return result;
}

// ----------- 時刻処理 -----------
const JST_OFFSET_MS = 9 * 60 * 60 * 1000;

function toJSTDateStr(date) {
  const d = new Date(date.getTime() + JST_OFFSET_MS);
  const y = d.getUTCFullYear();
  const m = String(d.getUTCMonth() + 1).padStart(2, '0');
  const day = String(d.getUTCDate()).padStart(2, '0');
  return `${y}-${m}-${day}`;
}

function toJSTTime(date) {
  const d = new Date(date.getTime() + JST_OFFSET_MS);
  const h = String(d.getUTCHours()).padStart(2, '0');
  const m = String(d.getUTCMinutes()).padStart(2, '0');
  return `${h}:${m}`;
}

function isAllDay(ev) {
  // node-ical では DATE 型（時刻なし）の DTSTART は datetype === 'date'
  return ev.datetype === 'date' || ev.start?.dateOnly === true;
}

// ----------- 貸切表示 -----------
function buildClosedDisplay(ev, startTime, endTime, cleanTitle) {
  const conf = DISPLAY_CONFIG.closedDisplay || {};
  const label = (conf.labelFromTitle && cleanTitle) ? cleanTitle : (conf.fallbackLabel || '貸切');
  if (endTime) {
    return (conf.format || '{startTime}–{endTime} {label}')
      .replace('{startTime}', startTime)
      .replace('{endTime}', endTime)
      .replace('{label}', label);
  }
  return (conf.noEndTimeFormat || '{startTime}〜 {label}')
    .replace('{startTime}', startTime)
    .replace('{label}', label);
}

// ----------- iCal RRULE 展開（TZ補正付き） -----------
function expandRecurring(ev, rangeStart, rangeEnd, modifications) {
  const out = [];
  let rawDates;
  try {
    rawDates = ev.rrule.between(rangeStart, rangeEnd, true);
  } catch (e) {
    console.warn('RRULE expand failed:', ev.summary, e.message);
    return out;
  }

  // node-ical + rrule の TZ 整合バグ対策。
  // ev.start は TZID を正しく解釈した UTC Date。これと rrule 出力との差から JST 時刻を抽出。
  const evStartJST = new Date(ev.start.getTime() + JST_OFFSET_MS);
  const hourJST = evStartJST.getUTCHours();
  const minJST = evStartJST.getUTCMinutes();
  const durationMs = ev.end ? (ev.end.getTime() - ev.start.getTime()) : 0;

  for (const rawDate of rawDates) {
    const rawJST = new Date(rawDate.getTime() + JST_OFFSET_MS);
    const y = rawJST.getUTCFullYear();
    const m = rawJST.getUTCMonth();
    const d = rawJST.getUTCDate();
    const start = new Date(Date.UTC(y, m, d, hourJST - 9, minJST));
    const end = durationMs > 0 ? new Date(start.getTime() + durationMs) : null;

    // EXDATE チェック
    if (ev.exdate) {
      const excluded = Object.values(ev.exdate).some(ex => {
        const exJST = new Date(new Date(ex).getTime() + JST_OFFSET_MS);
        return exJST.getUTCFullYear() === y
            && exJST.getUTCMonth() === m
            && exJST.getUTCDate() === d;
      });
      if (excluded) continue;
    }

    // 個別変更（recurrence-id）
    const dateStr = `${y}-${String(m+1).padStart(2,'0')}-${String(d).padStart(2,'0')}`;
    let mod = null;
    for (const [modKey, modEv] of modifications.entries()) {
      if (!modKey.startsWith(ev.uid + '|')) continue;
      const recId = modKey.split('|')[1];
      const recJST = new Date(new Date(recId).getTime() + JST_OFFSET_MS);
      const recStr = `${recJST.getUTCFullYear()}-${String(recJST.getUTCMonth()+1).padStart(2,'0')}-${String(recJST.getUTCDate()).padStart(2,'0')}`;
      if (recStr === dateStr) { mod = modEv; break; }
    }

    if (mod) {
      out.push({
        uid: ev.uid + '|' + dateStr,
        start: mod.start,
        end: mod.end,
        summary: mod.summary || ev.summary,
        description: mod.description || '',
        location: mod.location || ev.location,
      });
    } else {
      out.push({
        uid: ev.uid + '|' + dateStr,
        start: start,
        end: end,
        summary: ev.summary,
        description: ev.description || '',
        location: ev.location,
      });
    }
  }

  return out;
}

// ----------- メインハンドラ -----------
module.exports = async (req, res) => {
  // モジュール初期化エラーを JSON で返す（FUNCTION_INVOCATION_FAILED 防止）
  if (_icalError) {
    return res.status(500).json({ error: 'node-ical load failed: ' + _icalError.message, events: [] });
  }
  const configErr = ensureConfig();
  if (configErr) {
    return res.status(500).json({
      error: 'Config load failed: ' + configErr.message,
      cwd: process.cwd(),
      dirname: __dirname,
      events: [],
    });
  }

  const url = process.env.GCAL_ICAL_URL;
  if (!url) {
    res.setHeader('Cache-Control', 'no-store');
    return res.status(500).json({ error: 'GCAL_ICAL_URL is not set', events: [] });
  }

  try {
    const response = await fetch(url);
    if (!response.ok) throw new Error(`Calendar fetch failed: ${response.status}`);
    const icalText = await response.text();
    const data = ical.parseICS(icalText);

    // 範囲: 1か月前〜6か月先
    const now = new Date();
    const rangeStart = new Date(now.getFullYear(), now.getMonth() - 1, 1);
    const rangeEnd = new Date(now.getFullYear(), now.getMonth() + 6, 31);

    // 個別変更を先に集める
    const modifications = new Map();
    for (const key in data) {
      const ev = data[key];
      if (ev.type === 'VEVENT' && ev.recurrenceid) {
        modifications.set(`${ev.uid}|${new Date(ev.recurrenceid).toISOString()}`, ev);
      }
    }

    // 全VEVENTを展開
    const flat = [];
    for (const key in data) {
      const ev = data[key];
      if (ev.type !== 'VEVENT') continue;
      if (ev.recurrenceid) continue;

      if (ev.rrule) {
        flat.push(...expandRecurring(ev, rangeStart, rangeEnd, modifications));
      } else {
        if (!ev.start) continue;
        if (ev.start < rangeStart || ev.start > rangeEnd) continue;
        flat.push({
          uid: ev.uid,
          start: ev.start,
          end: ev.end,
          summary: ev.summary,
          description: ev.description || '',
          location: ev.location,
          allDay: isAllDay(ev),
        });
      }
    }

    // 整形
    const events = flat.map(e => {
      const allDay = e.allDay === true;
      const dateStr = toJSTDateStr(e.start);
      const startTime = allDay ? null : toJSTTime(e.start);
      // endTime が startTime と同じ（または未指定）なら null 扱い
      // node-ical は DTEND 不在時に start と同じ値を end に入れるため
      let endTime = null;
      if (e.end && !allDay && e.end.getTime() > e.start.getTime()) {
        endTime = toJSTTime(e.end);
        if (endTime === startTime) endTime = null; // 念のため二重チェック
      }

      const matchedCats = detectCategories(e.summary);
      const primary = pickPrimary(matchedCats);
      const featured = isFeatured(matchedCats, e.summary);

      const { cleanTitle, guests } = extractGuestAndCleanTitle(e.summary);
      const desc = parseDescription(e.description);

      // 説明欄に Guest プロパティがあればそれも guests に追加
      const guestProps = desc.properties.filter(p => p.label === 'ゲスト').map(p => p.value);
      const allGuests = dedupe([...guests, ...guestProps]);

      // 貸切表示
      let displayTitle = cleanTitle || e.summary || '';
      const isClosed = matchedCats.some(c => c.isStatus && c.id === 'closed');
      if (isClosed && startTime) {
        displayTitle = buildClosedDisplay(e, startTime, endTime, cleanTitle);
      }

      // 時刻表示
      let timeLabel;
      if (allDay) {
        timeLabel = DISPLAY_CONFIG.timeDisplay?.allDay || '終日';
      } else if (endTime && DISPLAY_CONFIG.timeDisplay?.showTimeRange) {
        timeLabel = `${startTime}${DISPLAY_CONFIG.timeDisplay.rangeSeparator || '–'}${endTime}`;
      } else if (startTime) {
        timeLabel = `${startTime}〜`;
      } else {
        timeLabel = DISPLAY_CONFIG.timeDisplay?.tba || '時間未定';
      }

      return {
        id: e.uid,
        date: dateStr,
        startTime,
        endTime,
        timeLabel,
        allDay,
        rawTitle: e.summary || '',
        title: displayTitle,
        cleanTitle,
        categories: matchedCats.map(c => ({
          id: c.id,
          label: c.label,
          labelEn: c.labelEn,
          color: c.color,
        })),
        primaryCategory: primary ? {
          id: primary.id,
          label: primary.label,
          labelEn: primary.labelEn,
          color: primary.color,
        } : null,
        featured,
        guests: allGuests,
        properties: desc.properties,
        descriptionFreeText: desc.freeText,
        location: e.location || '代々木公園 BE STAGE 1F',
      };
    });

    // 同日同タイトルの集約（複数ショータイム対応）
    const groupKey = (ev) => `${ev.date}|${ev.cleanTitle}|${ev.primaryCategory?.id}`;
    const groups = new Map();
    for (const ev of events) {
      const k = groupKey(ev);
      if (!groups.has(k)) {
        groups.set(k, { ...ev, times: ev.startTime ? [ev.startTime] : [], timeLabels: [ev.timeLabel] });
      } else {
        const g = groups.get(k);
        if (ev.startTime && !g.times.includes(ev.startTime)) g.times.push(ev.startTime);
        if (!g.timeLabels.includes(ev.timeLabel)) g.timeLabels.push(ev.timeLabel);
      }
    }

    const merged = Array.from(groups.values())
      .sort((a, b) => {
        if (a.date !== b.date) return a.date.localeCompare(b.date);
        return (a.startTime || '').localeCompare(b.startTime || '');
      });

    res.setHeader('Cache-Control', 's-maxage=300, stale-while-revalidate=60');
    res.setHeader('Access-Control-Allow-Origin', '*');
    res.status(200).json({
      events: merged,
      lastUpdated: new Date().toISOString(),
      count: merged.length,
      meta: {
        categoriesAvailable: CATEGORIES_CONFIG.categories.map(c => ({
          id: c.id, label: c.label, color: c.color,
        })),
        timezone: 'Asia/Tokyo',
      },
    });
  } catch (err) {
    console.error('Events API error:', err);
    res.setHeader('Cache-Control', 'no-store');
    res.status(500).json({ error: err.message, events: [], lastUpdated: null });
  }
};
� UTC Date。こ�
