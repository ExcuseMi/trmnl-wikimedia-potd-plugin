/**
 * Wikimedia Commons Picture of the Day. Source: the featured-feed Atom answer (last 10 days).
 * TRMNL turns an XML answer into JSON; the shape is not documented, so the feed is found by
 * looking for `entry` nodes anywhere in it, and a raw XML string is parsed here as well.
 * State (replaced by what we return, kept under 6 kB): { i: index shown, last: id (feed modes) or date (archive,
 * on_this_day) shown, seen: last 20 archive dates, pic: the last good picture (link, texts cut, see snap) }.
 * The last picture is shown again, without a notice, when a run cannot get a new one.
 * One 4.5 s deadline covers every fetch of a run (DEADLINE_MS). The feed or day page comes first and gets the time
 * it needs (FEED_MS); the extras (file metadata, then the Wikipedia chain) start only when enough time is left.
 */

var WIDTH = 1280; // a standard Wikimedia thumbnail step
var MONTHS = ['Jan', 'Feb', 'Mar', 'Apr', 'May', 'Jun', 'Jul', 'Aug', 'Sep', 'Oct', 'Nov', 'Dec'];
var MAX_TITLE = 110; // three title lines in the side column
var COMMONS = 'https://commons.wikimedia.org';

function decodeEntities(text) {
  if (!text) return '';
  return String(text)
    .replace(/&#(\d+);/g, function (_, n) { return String.fromCodePoint(Number(n)); })
    .replace(/&#x([0-9a-f]+);/gi, function (_, n) { return String.fromCodePoint(parseInt(n, 16)); })
    .replace(/&quot;/g, '"').replace(/&apos;/g, "'").replace(/&lt;/g, '<').replace(/&gt;/g, '>')
    .replace(/&nbsp;/g, ' ').replace(/&amp;/g, '&');
}

function plain(html) {
  return decodeEntities(String(html || '').replace(/<\/?(br|p|div|li|tr|td|th)\b[^>]*>/gi, ' ').replace(/<[^>]+>/g, '')).replace(/\s+/g, ' ').trim();
}

/** Text of a parsed XML node: a string, or an object with #text / _ / text / $t, else its first string. */
function nodeText(n) {
  if (n == null) return '';
  if (typeof n === 'string') return n;
  if (typeof n === 'number') return String(n);
  if (Array.isArray(n)) return nodeText(n[0]);
  if (typeof n === 'object') {
    var keys = ['#text', '_', 'text', '$t', 'content', '__text'];
    for (var i = 0; i < keys.length; i++) if (typeof n[keys[i]] === 'string') return n[keys[i]];
    for (var k in n) if (typeof n[k] === 'string' && k.charAt(0) !== '@' && k !== 'type') return n[k];
  }
  return '';
}

function attrOf(tag, name) {
  var m = new RegExp('\\s' + name + '="([^"]*)"').exec(tag);
  return m ? m[1] : '';
}

/** Entries from raw Atom text. */
function entriesFromString(xml) {
  var out = [], re = /<entry\b[^>]*>([\s\S]*?)<\/entry>/g, m;
  var inner = function (s, tag) {
    var r = new RegExp('<' + tag + '\\b[^>]*>([\\s\\S]*?)</' + tag + '>').exec(s);
    return r ? r[1] : '';
  };
  while ((m = re.exec(xml))) {
    var e = m[1];
    var link = /<link\b[^>]*>/.exec(e);
    out.push({
      id: decodeEntities(inner(e, 'id')), title: decodeEntities(inner(e, 'title')),
      updated: inner(e, 'updated'), summary: decodeEntities(inner(e, 'summary')),
      link: link ? decodeEntities(attrOf(link[0], 'href')) : '',
      author: decodeEntities(inner(inner(e, 'author'), 'name')),
    });
  }
  return out;
}

/** Entry nodes anywhere in a parsed answer (depth-limited). */
function findEntries(node, depth) {
  if (!node || typeof node !== 'object' || depth > 5) return null;
  if (node.entry != null) return Array.isArray(node.entry) ? node.entry : [node.entry];
  var keys = Object.keys(node);
  for (var i = 0; i < keys.length; i++) {
    var r = findEntries(node[keys[i]], depth + 1);
    if (r) return r;
  }
  return null;
}

function linkOf(node) {
  var l = node && node.link;
  if (Array.isArray(l)) l = l[0];
  if (l && typeof l === 'object') return l.href || l['@href'] || l['@_href'] || (l.$ && l.$.href) || '';
  return typeof l === 'string' ? l : '';
}

function entriesFromAnswer(input) {
  var d = input;
  if (d && typeof d === 'object' && !Array.isArray(d) && d.data !== undefined && d.entry === undefined) d = d.data;
  if (typeof d === 'string') return entriesFromString(d);
  var nodes = Array.isArray(d) ? d : findEntries(d, 0);
  if (!nodes) return [];
  return nodes.filter(function (n) { return n && typeof n === 'object'; }).map(function (n) {
    return {
      id: nodeText(n.id), title: nodeText(n.title), updated: nodeText(n.updated),
      summary: nodeText(n.summary), link: linkOf(n), author: nodeText(n.author && (n.author.name != null ? n.author.name : n.author)),
    };
  });
}

/** Summary HTML arrives escaped in the raw feed and may be decoded already after the XML to JSON step. */
function summaryHtml(s) {
  s = String(s || '');
  return /&lt;img\b/i.test(s) ? decodeEntities(s) : s;
}

/** Thumbnail URL in 1280 px; null when there is no picture. */
function pictureUrl(html) {
  var m = /<img\b[^>]*?\ssrc="([^"]+)"/i.exec(html);
  if (!m) return null;
  var url = decodeEntities(m[1]).replace(/^http:\/\//i, 'https://').split('?')[0];
  if (!/^https:\/\//i.test(url)) return null;
  return url.replace(/\/\d+px-([^\/]+)$/, '/' + WIDTH + 'px-$1');
}

function fileName(html) {
  var m = /href="\/wiki\/(File:[^"#?]+)"/i.exec(html);
  if (m) return m[1];
  var u = /\/thumb\/[0-9a-f]\/[0-9a-f]{2}\/([^\/]+)\//i.exec(html);
  return u ? 'File:' + u[1] : '';
}

function nameToTitle(file) {
  var n = file.replace(/^File:/i, '');
  try { n = decodeURIComponent(n); } catch (e) { /* keep as is */ }
  return n.replace(/\.[A-Za-z0-9]{2,5}$/, '').replace(/_/g, ' ').trim();
}

/** The whole caption text of the summary (the title is its first sentence). */
function fullCaption(html) {
  var m = /<div\b[^>]*class="[^"]*\bdescription\b[^"]*"[^>]*>([\s\S]*?)<\/div>/i.exec(html);
  return m ? cut(plain(m[1]), 1000) : '';
}

function caption(html) {
  var m = /<div\b[^>]*class="[^"]*\bdescription\b[^"]*"[^>]*>([\s\S]*?)<\/div>/i.exec(html);
  return titleOf(m ? plain(m[1]) : '');
}

/** The first sentence of a caption (one title line), cut at a word when still too long. */
function titleOf(t) {
  // One line in the title bar: the first sentence, cut at a word when still too long
  var dot = /^(.{20,}?[.!?])\s/.exec(t);
  if (dot && dot[1].length <= MAX_TITLE) t = dot[1];
  if (t.length > MAX_TITLE) t = t.slice(0, MAX_TITLE - 3).replace(/\s+\S*$/, '') + '...';
  return t;
}

/** Author and licence only when the summary carries them (elements with class author / licen*). */
function classText(html, word) {
  var m = new RegExp('<(\\w+)\\b[^>]*class="[^"]*' + word + '[^"]*"[^>]*>([\\s\\S]*?)</\\1>', 'i').exec(html);
  return m ? plain(m[2]) : '';
}

function dateParts(updated) {
  var m = /^(\d{4})-(\d{2})-(\d{2})/.exec(String(updated || ''));
  if (!m) return { date: '', label: '' };
  return { date: m[0], label: Number(m[3]) + ' ' + MONTHS[Number(m[2]) - 1] + ' ' + m[1] };
}

function shortId(id) {
  var m = /potd\/(\d+)/.exec(String(id));
  return m ? m[1] : String(id || '');
}

/** Pictures newest first; entries without a picture are skipped. */
function pictures(input) {
  var list = entriesFromAnswer(input).map(function (e) {
    var html = summaryHtml(e.summary), url = pictureUrl(html);
    if (!url) return null;
    var file = fileName(html), d = dateParts(e.updated);
    var author = classText(html, 'author') || plain(e.author);
    var license = classText(html, 'licen');
    return {
      id: shortId(e.id) || d.date || url, sort: String(e.updated || ''),
      caption: fullCaption(html) || null,
      title: caption(html) || (file ? nameToTitle(file) : plain(e.title)),
      link: file ? COMMONS + '/wiki/' + file : (e.link || COMMONS),
      image_url: url, date: d.date, date_label: d.label,
      author: author || null, license: license || null,
      credit: creditLine(author, license),
    };
  }).filter(Boolean);
  list.sort(function (a, b) { return a.sort < b.sort ? 1 : a.sort > b.sort ? -1 : 0; });
  return list;
}

function creditLine(author, license) {
  return [author, license, 'Wikimedia Commons'].filter(Boolean).join(', ');
}

var FETCH_MS = 2000; // one extra fetch, never longer than the time left of the run
var FEED_MS = 3500; // the feed or the day page: the one fetch a run cannot do without
var DEADLINE_MS = 4500; // the whole run, inside the 5 s budget
var META_MIN_MS = 1200; // file metadata (size, credit) starts only with this much time left
var WIKI_MIN_MS = 2000; // the Wikipedia chain (three to four requests) only with this much left; skipped first
var lastFail = ''; // why the last getWithTimeout returned null (for the debug key)

function cut(t, max) {
  return t.length > max ? t.slice(0, max - 3).replace(/\s+\S*$/, '') + '...' : t;
}

/**
 * Artist, licence and description of one file from the Commons API: { author, license, description },
 * any of them null; null as a whole when the call fails, times out, or answers garbage.
 * Never stored in the state.
 */
/** One GET with the 2 s abort; resolves to parsed JSON or text, null on any failure. Never throws. */
async function getWithTimeout(url, asJson, deadline, cap) {
  var left = deadline ? Math.min(cap || FETCH_MS, deadline - Date.now()) : (cap || FETCH_MS);
  if (left < 50) { lastFail = 'no time left'; return null; } // the run's time is spent
  var t0 = Date.now();
  lastFail = '';
  var timer, ctl = typeof AbortController === 'function' ? new AbortController() : null;
  try {
    var timeout = new Promise(function (_, reject) {
      timer = setTimeout(function () { if (ctl) ctl.abort(); reject(new Error('timeout')); }, left);
    });
    var work = (async function () {
      var res = await fetch(url, ctl ? { signal: ctl.signal } : undefined);
      if (!res || res.ok === false) { lastFail = 'status ' + (res && res.status); return null; }
      return asJson ? await res.json() : await res.text();
    })();
    work.catch(function () { /* the race below reports it */ });
    return await Promise.race([work, timeout]);
  } catch (e) {
    lastFail = (e && e.message === 'timeout' ? 'timeout after ' + (Date.now() - t0) + ' ms' : 'error ' + String(e && e.message).slice(0, 80));
    return null;
  } finally {
    clearTimeout(timer);
  }
}

/** The feed languages checked against the live featuredfeed answer (2026-10-15); any other code gets English. */
var FEED_LANGS = ['en', 'nl', 'de', 'fr', 'es', 'it', 'pt', 'pl', 'ja', 'ru', 'sv', 'cs'];

async function fileMeta(link, lang, deadline) {
  try {
    var name = link.replace(/^.*\/wiki\/File:/, '');
    try { name = decodeURIComponent(name); } catch (e) { /* keep as is */ }
    var url = COMMONS + '/w/api.php?action=query&titles=' + encodeURIComponent('File:' + name) +
      '&prop=imageinfo&iiprop=extmetadata%7Csize%7Curl&iiurlwidth=' + WIDTH + '&iiextmetadatafilter=Artist%7CLicenseShortName%7CImageDescription' +
      '&uselang=' + lang + '&format=json&origin=*';
    var json = await getWithTimeout(url, true, deadline);
    var pages = json && json.query && json.query.pages;
    var page = pages && pages[Object.keys(pages)[0]];
    var info = page && page.imageinfo && page.imageinfo[0];
    var ext = info && info.extmetadata;
    if (!ext || typeof ext !== 'object') return null;
    var val = function (k) { return ext[k] && typeof ext[k].value === 'string' ? plain(ext[k].value) : ''; };
    return { author: cut(val('Artist'), 40) || null, license: val('LicenseShortName') || null, description: cut(val('ImageDescription'), 1000) || null,
      w: Number.isFinite(info.width) ? info.width : null, h: Number.isFinite(info.height) ? info.height : null,
      pageid: Number.isInteger(page.pageid) ? page.pageid : null,
      thumb: typeof info.thumburl === 'string' && /^https:\/\//.test(info.thumburl) ? info.thumburl.split('?')[0] : null };
  } catch (e) {
    return null;
  }
}

/** Language from the user's TRMNL locale ("nl", "nl-BE", "pt_BR"); English when missing or not in FEED_LANGS. */
function langOf(input) {
  var loc = input && input.trmnl && input.trmnl.user && input.trmnl.user.locale;
  var l = String(loc || '').split(/[-_]/)[0].toLowerCase();
  return FEED_LANGS.indexOf(l) >= 0 ? l : 'en';
}

/** Saved state, or null when missing or garbage. */
var DATE_RE = /^\d{4}-\d\d-\d\d$/;
var SEEN_MAX = 20;
var PIC_DESC = 400; // description kept in the state

/** The last good picture as kept in the state: only what the templates show, texts cut. About 1 kB. */
function snap(img) {
  var o = {};
  ['image_url', 'title', 'credit', 'date', 'date_label', 'position', 'flow', 'w', 'h'].forEach(function (k) {
    if (img[k] != null && img[k] !== '') o[k] = img[k];
  });
  if (img.description) o.description = cut(String(img.description), PIC_DESC);
  return o;
}

/** A picture read back from the state: checked field by field, never trusted as it is. */
function cleanPic(p) {
  if (!p || typeof p !== 'object' || typeof p.image_url !== 'string' || !/^https:\/\//.test(p.image_url) || p.image_url.length > 400) return null;
  var str = function (v, max) { return typeof v === 'string' ? v.slice(0, max) : ''; };
  var out = {
    image_url: p.image_url, title: str(p.title, 200), credit: str(p.credit, 200), date: str(p.date, 10),
    date_label: str(p.date_label, 20), position: str(p.position, 40), flow: p.flow === 'top' ? 'top' : 'side',
    w: Number.isFinite(p.w) ? p.w : null, h: Number.isFinite(p.h) ? p.h : null,
  };
  if (typeof p.description === 'string' && p.description) out.description = cut(p.description, PIC_DESC);
  return out;
}

function cleanState(s) {
  if (!s || typeof s !== 'object') return null;
  var pic = cleanPic(s.pic);
  var ok = Number.isInteger(s.i) && s.i >= 0 && typeof s.last === 'string' && s.last.length < 64;
  if (!ok && !pic) return null;
  var out = ok ? { i: s.i, last: s.last } : { i: 0, last: '' };
  var seen = Array.isArray(s.seen) ? s.seen.filter(function (d) { return typeof d === 'string' && DATE_RE.test(d); }).slice(-SEEN_MAX) : [];
  if (seen.length) out.seen = seen;
  if (pic) out.pic = pic;
  return out;
}

/** Nothing new this run: the last picture again, no notice; only without one the notice. State and debug as given. */
function stale(state, notice, debug) {
  var out = state && state.pic ? { image: Object.assign({}, state.pic), trmnl_state: state }
    : { image: null, trmnl_state: state || {}, notice: notice };
  if (debug) out.debug = debug;
  return out;
}

function pick(list, mode, state) {
  var n = list.length;
  if (mode === 'rotate') {
    if (!state || !state.last) return 0;
    var p = list.findIndex(function (x) { return x.id === state.last; });
    return ((p >= 0 ? p : state.i) + 1) % n;
  }
  if (mode === 'random') {
    if (n === 1) return 0;
    // Draw from the others, so it ends and never repeats the one just shown
    var last = state ? list.findIndex(function (x) { return x.id === state.last; }) : -1;
    var k = Math.floor(Math.random() * (last >= 0 ? n - 1 : n));
    return last >= 0 && k >= last ? k + 1 : k;
  }
  return 0;
}

function modeOf(input) {
  var cfv = (input && input.trmnl && input.trmnl.plugin_settings && input.trmnl.plugin_settings.custom_fields_values) || {};
  var m = String(cfv.mode || (input && input.mode) || 'today').toLowerCase();
  return ['rotate', 'random', 'archive', 'on_this_day'].indexOf(m) >= 0 ? m : 'today';
}

var SHORT_DESC = 160; // a description shorter than this is replaced by the Wikipedia summary
var FIRST_DAY = Date.UTC(2004, 10, 29); // the first picture of the day on Commons
var FIRST_YEAR = 2005; // on this day: the first year with a whole run of pages
var DAY_MS = 86400000;
var SPENT = 'Wikimedia Commons did not answer in time. This is the last picture again; the next refresh tries a new one.'; // old states without pic

/** Wikitext of a caption as plain text: links to their label, quotes, templates and tags dropped. */
function wikiPlain(t) {
  t = String(t || '').replace(/<ref\b[^>]*>[\s\S]*?<\/ref>/gi, '').replace(/<[^>]+>/g, '');
  for (var n = 0; n < 4; n++) t = t.replace(/\{\{[^{}]*\}\}/g, '');
  t = t.replace(/\[\[(?:File|Image):[^\]]*\]\]/gi, '')
    .replace(/\[\[[^\]|]*\|([^\]]*)\]\]/g, '$1').replace(/\[\[:?([^\]]*)\]\]/g, '$1')
    .replace(/\[https?:\/\/\S+\s+([^\]]*)\]/g, '$1').replace(/'{2,5}/g, '');
  return decodeEntities(t).replace(/\s+/g, ' ').trim();
}

/** Commons structured data (P180 depicts) -> Wikidata sitelinks -> Wikipedia summary extract (1000 chars), or null. */
async function wikiSummary(pageid, lang, deadline) {
  var sdc = await getWithTimeout(COMMONS + '/w/api.php?action=wbgetentities&ids=M' + pageid + '&format=json', true, deadline);
  var ent = sdc && sdc.entities && sdc.entities['M' + pageid];
  var stmts = ent && ent.statements && ent.statements.P180;
  var q = '';
  if (Array.isArray(stmts)) {
    for (var i = 0; i < stmts.length && !q; i++) {
      var v = stmts[i] && stmts[i].mainsnak && stmts[i].mainsnak.datavalue && stmts[i].mainsnak.datavalue.value;
      if (v && typeof v.id === 'string' && /^Q\d+$/.test(v.id)) q = v.id;
    }
  }
  if (!q) return null;
  var langs = lang === 'en' ? ['en'] : [lang, 'en'];
  var wd = await getWithTimeout('https://www.wikidata.org/w/api.php?action=wbgetentities&ids=' + q +
    '&props=sitelinks&sitefilter=' + langs.map(function (l) { return l + 'wiki'; }).join('%7C') + '&format=json', true, deadline);
  var links = wd && wd.entities && wd.entities[q] && wd.entities[q].sitelinks;
  if (!links || typeof links !== 'object') return null;
  for (var k = 0; k < langs.length; k++) {
    var link = links[langs[k] + 'wiki'];
    if (!link || typeof link.title !== 'string') continue;
    var sum = await getWithTimeout('https://' + langs[k] + '.wikipedia.org/api/rest_v1/page/summary/' +
      encodeURIComponent(link.title.replace(/ /g, '_')), true, deadline);
    var ex = sum && sum.type !== 'disambiguation' && typeof sum.extract === 'string' ? plain(sum.extract) : '';
    if (ex) return cut(ex, 1000);
  }
  return null;
}

/** The description of an image: Commons caption; when short or missing, the Wikipedia summary of what it depicts. */
async function describe(img, meta, lang, deadline) {
  img.description = (meta && meta.description) || img.caption || null;
  // the title is the first sentence of the caption: do not repeat it at the start of the description
  var t = (img.title || '').trim();
  if (t && !/(\.\.\.|…)$/.test(t) && img.description && img.description.indexOf(t.replace(/\.$/, '')) === 0) {
    img.description = img.description.slice(t.replace(/\.$/, '').length).replace(/^[\s.,;:]+/, '') || null;
  }
  if ((!img.description || img.description.length < SHORT_DESC) && meta && meta.pageid && deadline - Date.now() >= WIKI_MIN_MS) {
    var ex = await wikiSummary(meta.pageid, lang, deadline);
    if (ex) img.description = ex;
  }
}

function iso(ms) { return new Date(ms).toISOString().slice(0, 10); }
function isLeap(y) { return (y % 4 === 0 && y % 100 !== 0) || y % 400 === 0; }
function labelOf(date) { return dateParts(date + 'T').label; }

/**
 * One picture of a given day from its Commons template pages (the file name, the caption in the user's language
 * else English), then the file's thumbnail and credit. { img } on success, 'missing' when the day has no page,
 * null on a failure or when the time is spent.
 */
async function loadDay(date, lang, deadline) {
  var base = 'Template:Potd/' + date;
  var titles = [base, base + ' (' + lang + ')', base + ' (en)'].filter(function (t, i, a) { return a.indexOf(t) === i; });
  var json = await getWithTimeout(COMMONS + '/w/api.php?action=query&titles=' + encodeURIComponent(titles.join('|')) +
    '&prop=revisions&rvprop=content&rvslots=main&format=json&formatversion=2', true, deadline, FEED_MS);
  var pages = json && json.query && json.query.pages;
  if (!Array.isArray(pages)) return null;
  var text = {};
  pages.forEach(function (p) {
    var c = p && !p.missing && p.revisions && p.revisions[0] && p.revisions[0].slots && p.revisions[0].slots.main;
    if (c && typeof c.content === 'string') text[String(p.title)] = c.content;
  });
  // the answer holds only the pages asked for: match them by their name pattern, not by the exact date
  var byTail = function (re) { var k = Object.keys(text).filter(function (t) { return re.test(t); })[0]; return k ? text[k] : ''; };
  var dayPage = byTail(/^Template:Potd\/\d{4}-\d\d-\d\d$/);
  var fm = /\{\{\s*Potd filename\s*\|\s*([^|}]+)/i.exec(dayPage);
  if (!fm) return 'missing';
  var name = fm[1].trim().replace(/^File:/i, '');
  var capText = byTail(new RegExp(' \\(' + lang + '\\)$')) || byTail(/ \(en\)$/);
  var cm = /\|\s*1=([\s\S]*?)\|\s*2=[\w-]+\s*\|\s*3=/.exec(capText) || /\|\s*1=([\s\S]*?)\}\}/.exec(capText);
  var caption = cm ? cut(wikiPlain(cm[1]), 1000) : '';
  var link = COMMONS + '/wiki/File:' + name.replace(/ /g, '_');
  var meta = await fileMeta(link, lang, deadline);
  if (!meta || !meta.thumb) return null;
  var d = dateParts(date);
  var img = {
    id: date, link: link, image_url: meta.thumb, date: d.date, date_label: d.label,
    author: meta.author, license: meta.license, w: meta.w, h: meta.h,
  };
  img.credit = creditLine(img.author, img.license);
  img.caption = caption || meta.description || null;
  img.title = titleOf(img.caption || '') || nameToTitle(name);
  await describe(img, { pageid: meta.pageid }, lang, deadline);
  img.flow = img.w && img.h && img.w / img.h >= 1.25 ? 'top' : 'side';
  return { img: img };
}

function localToday(input) {
  var off = input && input.trmnl && input.trmnl.user && input.trmnl.user.utc_offset;
  var t = new Date(Date.now() + (Number.isFinite(off) ? off * 1000 : 0));
  return { y: t.getUTCFullYear(), m: t.getUTCMonth() + 1, d: t.getUTCDate(), ms: Date.UTC(t.getUTCFullYear(), t.getUTCMonth(), t.getUTCDate()) };
}

function pad(n) { return (n < 10 ? '0' : '') + n; }

/** Modes archive and on_this_day: pictures of chosen days, fetched one by one. */
async function runDays(input, mode, state, lang, deadline) {
  var today = localToday(input);
  var lastDate = state && DATE_RE.test(state.last) ? state.last : null;
  var years = today.y - FIRST_YEAR; // 2005 up to last year
  var show = function (img, idx) {
    img = Object.assign({}, img);
    if (mode === 'archive') { img.position = img.date_label; img.date_label = ''; } else { img.position = (idx + 1) + ' / ' + years; }
    return img;
  };
  // leave time to show the last picture again when picking a new one fails
  var pickBy = lastDate && !(state && state.pic) ? deadline - 1200 : deadline;
  var debug = '';
  var got = null, idx = 0, seen = state && state.seen ? state.seen : [];
  if (mode === 'archive') {
    var days = Math.floor((today.ms - DAY_MS - FIRST_DAY) / DAY_MS) + 1;
    for (var a = 0; a < 5 && !got; a++) {
      var k = 0, date = '';
      for (var tries = 0; tries < 50; tries++) {
        k = Math.floor(Math.random() * days);
        date = iso(FIRST_DAY + k * DAY_MS);
        if (seen.indexOf(date) < 0) break;
      }
      var r = await loadDay(date, lang, pickBy);
      if (r === null) { debug = 'day ' + date + ': ' + lastFail; break; }
      if (r !== 'missing') { got = r; idx = k; }
    }
    if (got) {
      var seen2 = seen.filter(function (d) { return d !== got.img.id; }).concat(got.img.id).slice(-SEEN_MAX);
      var shown = show(got.img, idx);
      return { image: shown, trmnl_state: { i: idx, last: got.img.id, seen: seen2, pic: snap(shown) } };
    }
  } else if (years >= 1) {
    var start = lastDate && state.i < years ? state.i : -1;
    for (var n = 1; n <= years && !got; n++) {
      var yi = (start + n) % years, yr = FIRST_YEAR + yi;
      var dd = today.m === 2 && today.d === 29 && !isLeap(yr) ? 28 : today.d;
      var r2 = await loadDay(yr + '-' + pad(today.m) + '-' + pad(dd), lang, pickBy);
      if (r2 === null) { debug = 'day ' + yr + ': ' + lastFail; break; }
      if (r2 !== 'missing') { got = r2; idx = yi; }
    }
    if (got) {
      var shown2 = show(got.img, idx);
      return { image: shown2, trmnl_state: { i: idx, last: got.img.id, pic: snap(shown2) } };
    }
  }
  // nothing new: the last picture again (no notice), the state unchanged
  if (state && state.pic) return stale(state, '', debug);
  // an old state without a picture: fetch the last day again, with a notice
  if (lastDate) {
    var again = await loadDay(lastDate, lang, deadline);
    if (again && again !== 'missing') {
      var im = show(again.img, state.i);
      im.notice = SPENT;
      return { image: im, trmnl_state: state, debug: debug };
    }
  }
  return stale(state, 'Wikimedia Commons did not send a picture. The next refresh tries again.', debug);
}

async function run(input) {
  var deadline = Date.now() + DEADLINE_MS;
  var state = cleanState(input && input.trmnl && input.trmnl.state);
  var lang = langOf(input);
  var mode = modeOf(input);
  if (mode === 'archive' || mode === 'on_this_day') return runDays(input, mode, state, lang, deadline);
  var list = pictures(input), debug = '';
  if (list.length === 0 && !(input && input.data !== undefined)) {
    // serverless with an empty polling_url: fetch the feed here, in the user's language. It comes first and gets
    // the time it needs; everything after it is an extra.
    var feed = await getWithTimeout(COMMONS + '/w/api.php?action=featuredfeed&feed=potd&feedformat=atom&language=' + lang, false, deadline, FEED_MS);
    if (typeof feed === 'string') {
      list = pictures({ data: feed });
      if (list.length === 0) debug = 'feed: no picture in ' + feed.length + ' bytes';
    } else {
      debug = 'feed: ' + lastFail;
    }
  }
  if (list.length === 0) {
    // The saved state is replaced by what we return: hand it back unchanged; the last picture, else the notice
    return stale(state, 'Wikimedia Commons did not send a picture list. The next refresh tries again.', debug);
  }
  var idx = pick(list, mode, state);
  var img = Object.assign({}, list[idx], { position: (idx + 1) + ' / ' + list.length, n: idx + 1, total: list.length });
  delete img.sort;
  var meta = deadline - Date.now() >= META_MIN_MS ? await fileMeta(img.link, lang, deadline) : null;
  if (meta) {
    img.author = meta.author || img.author;
    img.license = meta.license || img.license;
    img.credit = creditLine(img.author, img.license);
    img.w = meta.w; img.h = meta.h;
  }
  // Layout flow: a landscape picture goes on top at full width, others beside the text (never cropped)
  img.flow = img.w && img.h && img.w / img.h >= 1.25 ? 'top' : 'side';
  await describe(img, meta, lang, deadline);
  return { image: img, trmnl_state: { i: idx, last: list[idx].id, pic: snap(img) } };
}
