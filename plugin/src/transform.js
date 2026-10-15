/**
 * Wikimedia Commons Picture of the Day. Source: the featured-feed Atom answer (last 10 days).
 * TRMNL turns an XML answer into JSON; the shape is not documented, so the feed is found by
 * looking for `entry` nodes anywhere in it, and a raw XML string is parsed here as well.
 * State (replaced by what we return, max 8 kB): { i: index shown, last: id of the entry shown }. No links.
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
  var t = m ? plain(m[1]) : '';
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

var FETCH_MS = 2000; // well inside the 5 s budget

function cut(t, max) {
  return t.length > max ? t.slice(0, max - 3).replace(/\s+\S*$/, '') + '...' : t;
}

/**
 * Artist, licence and description of one file from the Commons API: { author, license, description },
 * any of them null; null as a whole when the call fails, times out, or answers garbage.
 * Never stored in the state.
 */
async function fileMeta(link, lang) {
  var timer, ctl = typeof AbortController === 'function' ? new AbortController() : null;
  try {
    var name = link.replace(/^.*\/wiki\/File:/, '');
    try { name = decodeURIComponent(name); } catch (e) { /* keep as is */ }
    var url = COMMONS + '/w/api.php?action=query&titles=' + encodeURIComponent('File:' + name) +
      '&prop=imageinfo&iiprop=extmetadata%7Csize&iiextmetadatafilter=Artist%7CLicenseShortName%7CImageDescription' +
      '&uselang=' + lang + '&format=json&origin=*';
    var timeout = new Promise(function (_, reject) {
      timer = setTimeout(function () { if (ctl) ctl.abort(); reject(new Error('timeout')); }, FETCH_MS);
    });
    var work = (async function () {
      var res = await fetch(url, ctl ? { signal: ctl.signal } : undefined);
      if (!res || res.ok === false) return null;
      return await res.json();
    })();
    work.catch(function () { /* the race below reports it */ });
    var json = await Promise.race([work, timeout]);
    var pages = json && json.query && json.query.pages;
    var page = pages && pages[Object.keys(pages)[0]];
    var info = page && page.imageinfo && page.imageinfo[0];
    var ext = info && info.extmetadata;
    if (!ext || typeof ext !== 'object') return null;
    var val = function (k) { return ext[k] && typeof ext[k].value === 'string' ? plain(ext[k].value) : ''; };
    return { author: cut(val('Artist'), 40) || null, license: val('LicenseShortName') || null, description: cut(val('ImageDescription'), 1000) || null,
      w: Number.isFinite(info.width) ? info.width : null, h: Number.isFinite(info.height) ? info.height : null };
  } catch (e) {
    return null;
  } finally {
    clearTimeout(timer);
  }
}

function langOf(input) {
  var cfv = (input && input.trmnl && input.trmnl.plugin_settings && input.trmnl.plugin_settings.custom_fields_values) || {};
  var l = String(cfv.language || (input && input.language) || 'en').toLowerCase();
  return /^[a-z]{2,3}(-[a-z]{2,4})?$/.test(l) ? l : 'en';
}

/** Saved state, or null when missing or garbage. */
function cleanState(s) {
  if (s && typeof s === 'object' && Number.isInteger(s.i) && s.i >= 0 && typeof s.last === 'string' && s.last.length < 64) {
    return { i: s.i, last: s.last };
  }
  return null;
}

function pick(list, mode, state) {
  var n = list.length;
  if (mode === 'rotate') {
    if (!state) return 0;
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
  return m === 'rotate' || m === 'random' ? m : 'today';
}

async function run(input) {
  var state = cleanState(input && input.trmnl && input.trmnl.state);
  var list = pictures(input);
  if (list.length === 0) {
    // The saved state is replaced by what we return: hand it back unchanged
    return {
      image: null, trmnl_state: state || {},
      notice: 'Wikimedia Commons did not send a picture list. The next refresh tries again.',
    };
  }
  var idx = pick(list, modeOf(input), state);
  var img = Object.assign({}, list[idx], { position: (idx + 1) + ' / ' + list.length, n: idx + 1, total: list.length });
  delete img.sort;
  var meta = await fileMeta(img.link, langOf(input));
  if (meta) {
    img.author = meta.author || img.author;
    img.license = meta.license || img.license;
    img.credit = creditLine(img.author, img.license);
    img.w = meta.w; img.h = meta.h;
  }
  // Layout flow: a landscape picture goes on top at full width, others beside the text (never cropped)
  img.flow = img.w && img.h && img.w / img.h >= 1.25 ? 'top' : 'side';
  img.description = (meta && meta.description) || img.caption || null;
  // the title is the first sentence of the caption: do not repeat it at the start of the description
  var t = (img.title || '').trim();
  if (t && !/(\.\.\.|\u2026)$/.test(t) && img.description && img.description.indexOf(t.replace(/\.$/, '')) === 0) {
    img.description = img.description.slice(t.replace(/\.$/, '').length).replace(/^[\s.,;:]+/, '') || null;
  }
  return { image: img, trmnl_state: { i: idx, last: list[idx].id } };
}
