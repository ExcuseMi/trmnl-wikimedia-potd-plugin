// node --test plugin/test/modes.test.js ; TRANSFORM=path runs the tests against another transform (used to see them fail)
// Wikipedia summary for short captions, the archive and on_this_day modes, the 4 s deadline. fetch is stubbed with
// real answers (mahonia-*.json, archive-*.json: Commons/Wikidata/Wikipedia, 2026-10-15); no test reaches the network.
const test = require('node:test');
const assert = require('node:assert');
const fs = require('node:fs');
const path = require('node:path');

const file = process.env.TRANSFORM || path.join(__dirname, '..', 'src', 'transform.js');
const run = new Function(fs.readFileSync(file, 'utf8') + '\nreturn run;')();
const load = (n) => JSON.parse(fs.readFileSync(path.join(__dirname, n), 'utf8'));
const info = load('mahonia-info.json'), sdc = load('mahonia-sdc.json'), wd = load('mahonia-wikidata.json'), sumNl = load('mahonia-summary-nl.json');
const archive = { '2015-06-01': load('archive-2015-06-01.json'), '2004-11-29': load('archive-2004-11-29.json') };
const noFetch = async () => { throw new Error('no network in tests'); };
const realNow = Date.now, realRandom = Math.random;
globalThis.fetch = noFetch;

const feedWith = (text) => '<feed><entry><id>x/potd/20261006000000/en</id><updated>2026-10-06T00:00:00Z</updated><summary>&lt;a href=&quot;/wiki/File:Bessen.jpg&quot;&gt;&lt;img src=&quot;https://thumb.wikimedia.org/a/330px-Bessen.jpg&quot;&gt;&lt;/a&gt;&lt;div class=&quot;description en&quot;&gt;' + text + '&lt;/div&gt;</summary></entry></feed>';
const SHORT = feedWith('Berries from a Mahonia aquifolium shrub. Focus stack of 19 photos.');
const nl = (extra) => ({ data: SHORT, trmnl: { user: { locale: 'nl' }, ...extra } });

// A day's two template pages, in the shape of the real answers
function synthDay(date, ok = true) {
  const [y, m, d] = date.split('-');
  if (!ok) return { query: { pages: [{ ns: 10, title: 'Template:Potd/' + date, missing: true }, { ns: 10, title: 'Template:Potd/' + date + ' (en)', missing: true }] } };
  const page = (title, content) => ({ pageid: 1, ns: 10, title, revisions: [{ slots: { main: { content } } }] });
  return { query: { pages: [page('Template:Potd/' + date, `{{Potd filename|F_${date}.jpg|${y}|${m}|${d}}}`), page('Template:Potd/' + date + ' (en)', `{{Potd description|1=Picture of ${date}.|2=en|3=${y}|4=${m}|5=${d}}}`)] } };
}

// Routes the stubbed fetch by URL; every URL is recorded. A handler returns an object, or null for an HTTP 404.
function router(h = {}) {
  const urls = [];
  const f = async (u) => {
    u = String(u); urls.push(u);
    if (h.delay) await new Promise((r) => setTimeout(r, h.delay));
    let body;
    if (/action=query&titles=Template/.test(u)) {
      const date = decodeURIComponent(new URL(u).searchParams.get('titles').split('|')[0]).replace('Template:Potd/', '');
      body = h.day ? h.day(date) : (archive[date] || synthDay(date));
    } else if (/action=query&titles=File/.test(u)) body = h.infoFor ? h.infoFor(u) : h.info === undefined ? info : h.info;
    else if (/wbgetentities&ids=M/.test(u)) body = h.sdc === undefined ? sdc : h.sdc;
    else if (/wikidata\.org/.test(u)) body = h.wd === undefined ? wd : h.wd;
    else if (/rest_v1\/page\/summary/.test(u)) body = h.sum ? h.sum(u) : (/nl\.wikipedia/.test(u) ? sumNl : null);
    else throw new Error('unexpected ' + u);
    return body === null ? { ok: false, status: 404 } : { ok: true, json: async () => body };
  };
  return { f, urls };
}

async function using(r, fn, now) {
  globalThis.fetch = r.f;
  if (now) Date.now = () => now;
  try { return await fn(); } finally { globalThis.fetch = noFetch; Date.now = realNow; Math.random = realRandom; }
}
const NOW = Date.UTC(2026, 9, 15, 12);
const DAY = 86400000, FIRST = Date.UTC(2004, 10, 29);
const days = (NOW - DAY - FIRST) / DAY + 1 | 0; // 2004-11-29 .. 2026-10-14
const rnd = (date) => ((Date.UTC(...date.split('-').map((n, i) => i === 1 ? n - 1 : +n)) - FIRST) / DAY + 0.5) / days;
const modeIn = (mode, state, extra) => ({ trmnl: { user: { locale: 'nl' }, state, plugin_settings: { custom_fields_values: { mode } }, ...extra } });

// ---- Wikipedia summary

test('short caption: replaced by the Wikipedia extract (P180 -> sitelink in the user language -> summary)', async () => {
  const r = router();
  const out = await using(r, () => run(nl()));
  assert.strictEqual(out.image.description, sumNl.extract);
  assert.ok(r.urls.some((u) => u.includes('ids=M176608093')), r.urls.join('\n'));
  assert.ok(r.urls.some((u) => u.includes('ids=Q158303') && u.includes('sitefilter=nlwiki%7Cenwiki')));
  assert.ok(r.urls.some((u) => u.startsWith('https://nl.wikipedia.org/api/rest_v1/page/summary/Mahonie_(plant)')));
  assert.ok(out.trmnl_state.pic.description.length <= 400 && JSON.stringify(out.trmnl_state).length < 6000);
});

test('long caption stays: no Wikipedia call at all', async () => {
  const long = 'Berries from a Mahonia aquifolium shrub. ' + 'The berries ripen in late summer and are eaten by birds. '.repeat(4);
  const body = JSON.parse(JSON.stringify(info));
  Object.values(body.query.pages)[0].imageinfo[0].extmetadata.ImageDescription.value = long;
  const r = router({ info: body });
  const out = await using(r, () => run({ data: feedWith(long), trmnl: { user: { locale: 'nl' } } }));
  assert.ok(out.image.description.length >= 160 && out.image.description.startsWith('The berries ripen'), out.image.description);
  assert.ok(!r.urls.some((u) => /wbgetentities|wikipedia|wikidata/.test(u)), r.urls.join('\n'));
});

test('no P180 statement: the caption stays, Wikidata is not asked', async () => {
  const r = router({ sdc: { entities: { M176608093: { id: 'M176608093', statements: [] } } } });
  const out = await using(r, () => run(nl()));
  assert.strictEqual(out.image.description, 'Focus stack of 19 photos.');
  assert.ok(!r.urls.some((u) => /wikidata|wikipedia/.test(u)));
});

test('no sitelink in the user language: the English article', async () => {
  const onlyEn = JSON.parse(JSON.stringify(wd)); delete onlyEn.entities.Q158303.sitelinks.nlwiki;
  const r = router({ wd: onlyEn, sum: () => ({ type: 'standard', extract: 'Mahonia aquifolium is a shrub.' }) });
  const out = await using(r, () => run(nl()));
  assert.strictEqual(out.image.description, 'Mahonia aquifolium is a shrub.');
  assert.ok(r.urls.some((u) => u.startsWith('https://en.wikipedia.org/api/rest_v1/page/summary/Mahonia_aquifolium')));
  assert.ok(!r.urls.some((u) => u.includes('nl.wikipedia')));
});

test('summary 404 (both languages): the caption stays, no crash', async () => {
  const r = router({ sum: () => null });
  const out = await using(r, () => run(nl()));
  assert.strictEqual(out.image.description, 'Focus stack of 19 photos.');
  assert.ok(r.urls.some((u) => u.includes('nl.wikipedia')) && r.urls.some((u) => u.includes('en.wikipedia')), 'English tried after Dutch');
});

test('extract is cut to 1000 characters', async () => {
  const r = router({ sum: () => ({ extract: 'word '.repeat(400) }) });
  const out = await using(r, () => run(nl()));
  assert.ok(out.image.description.length <= 1000 && out.image.description.endsWith('...'));
});

// ---- archive

test('archive: a random day, the file and caption from the day pages (Dutch caption, else English), day in date_label, no position', async () => {
  Math.random = () => rnd('2015-06-01');
  const r = router();
  const out = await using(r, () => run(modeIn('archive')), NOW);
  assert.strictEqual(out.image.date, '2015-06-01');
  // the day goes to the title bar instance; no position count for archive (owner 2026-10-15)
  assert.strictEqual(out.image.date_label, '1 Jun 2015');
  assert.strictEqual(out.image.position, '');
  assert.strictEqual(out.image.title, 'Een pasgeboren kalf van een roodwitte Holstein-Friesian.');
  assert.match(out.image.image_url, /^https:\/\/thumb\.wikimedia\.org\/.*1280px-[^?]+$/);
  assert.deepStrictEqual({ ...out.trmnl_state, pic: 0 }, { i: out.trmnl_state.i, last: '2015-06-01', seen: ['2015-06-01'], pic: 0 });
  assert.ok(r.urls[0].includes('Template%3APotd%2F2015-06-01'));
  // the very first day has no Dutch page: English, with wiki links reduced to their words
  Math.random = () => rnd('2004-11-29');
  const first = await using(router(), () => run(modeIn('archive')), NOW);
  assert.strictEqual(first.image.date, '2004-11-29');
  assert.match(first.image.title, /^In the Valais canton of Switzerland, bisses are irrigation channels/);
  assert.ok(!/[\[\]{}|']/.test(first.image.title));
});

test('archive: no repeat within the last 20 shown, state holds dates only and stays small', async () => {
  let seed = 12345;
  const lcg = () => (seed = (seed * 1103515245 + 12345) % 2147483648) / 2147483648;
  let state; const shown = [];
  for (let i = 0; i < 60; i++) {
    let first = i % 7 === 0 && shown.length; // sometimes the first draw hits the day shown last
    Math.random = () => (first ? ((first = false), rnd(shown[shown.length - 1])) : lcg());
    const out = await using(router(), () => run(modeIn('archive', state)), NOW);
    shown.push(out.image.date); state = out.trmnl_state;
    assert.ok(state.seen.length <= 20 && JSON.stringify(state).length < 6000 && !/http/.test(JSON.stringify(state.seen)));
  }
  for (let i = 0; i < shown.length; i++) assert.ok(!shown.slice(Math.max(0, i - 20), i).includes(shown[i]), 'repeat at ' + i);
});

test('archive: a day without a page is skipped, another is tried', async () => {
  let n = 0;
  Math.random = () => rnd(n++ === 0 ? '2015-06-02' : '2004-11-29');
  const r = router({ day: (d) => archive[d] || synthDay(d, false) });
  const out = await using(r, () => run(modeIn('archive')), NOW);
  assert.strictEqual(out.image.date, '2004-11-29');
});

test('archive: every day page missing: the last picture again with a notice, state unchanged; none shown yet: notice only', async () => {
  Math.random = () => rnd('2015-06-02');
  const state = { i: 3, last: '2015-06-01', seen: ['2015-06-01'] };
  const r = router({ day: (d) => archive[d] || synthDay(d, false) });
  const out = await using(r, () => run(modeIn('archive', state)), NOW);
  assert.strictEqual(out.image.date, '2015-06-01');
  assert.ok(out.image.notice && out.image.notice.length > 20);
  assert.deepStrictEqual(out.trmnl_state, state);
  const none = await using(router({ day: (d) => synthDay(d, false) }), () => run(modeIn('archive')), NOW);
  assert.strictEqual(none.image, null);
  assert.ok(none.notice);
});

test('archive: Commons answers 500: last picture again when it works, never a crash', async () => {
  Math.random = () => rnd('2015-06-02');
  const state = { i: 3, last: '2015-06-01', seen: ['2015-06-01'] };
  const r = router({ day: (d) => (d === '2015-06-01' ? archive[d] : null) });
  const out = await using(r, () => run(modeIn('archive', state)), NOW);
  assert.strictEqual(out.image.date, '2015-06-01');
  assert.ok(out.image.notice);
});

// ---- on this day

const otd = async (now, n, h, state0) => {
  let state = state0; const out = [];
  for (let i = 0; i < n; i++) {
    const r = router(h);
    const o = await using(r, () => run(modeIn('on_this_day', state)), now);
    out.push({ o, urls: r.urls }); state = o.trmnl_state;
  }
  return out;
};

test('on_this_day: one year per refresh in turn from 2005, wrapping; header shows that date, position n / N', async () => {
  const runs = await otd(Date.UTC(2008, 2, 10, 12), 4);
  assert.deepStrictEqual(runs.map((x) => x.o.image.position), ['1 / 3', '2 / 3', '3 / 3', '1 / 3']);
  assert.deepStrictEqual(runs.map((x) => x.o.image.date_label), ['10 Mar 2005', '10 Mar 2006', '10 Mar 2007', '10 Mar 2005']);
  assert.deepStrictEqual({ ...runs[1].o.trmnl_state, pic: 0 }, { i: 1, last: '2006-03-10', pic: 0 });
});

test('on_this_day: years without a page are skipped', async () => {
  const h = { day: (d) => synthDay(d, !d.startsWith('2006')) };
  const runs = await otd(Date.UTC(2008, 2, 10, 12), 3, h);
  assert.deepStrictEqual(runs.map((x) => x.o.image.position), ['1 / 3', '3 / 3', '1 / 3']);
});

test('on_this_day: 29 Feb uses 28 Feb in years that have none', async () => {
  const runs = await otd(Date.UTC(2028, 1, 29, 12), 4);
  const dates = runs.map((x) => x.o.image.date);
  assert.deepStrictEqual(dates, ['2005-02-28', '2006-02-28', '2007-02-28', '2008-02-29']);
  assert.strictEqual(runs[0].o.image.position, '1 / 23');
});

// ---- the 4 s deadline

test('deadline hit midway: the chain stops, the picture and caption stay, the run ends near 4 s', { timeout: 8000 }, async () => {
  Math.random = () => rnd('2015-06-01');
  const t0 = Date.now();
  const r = router({ delay: 1400 });
  const out = await using(r, () => run(modeIn('archive')), undefined);
  const took = Date.now() - t0;
  assert.ok(took < 4600, 'took ' + took);
  assert.ok(out.image, JSON.stringify(out));
  assert.strictEqual(out.image.date, '2015-06-01');
  assert.ok(!r.urls.some((u) => /rest_v1/.test(u)), 'no time left for the summary');
});

test('deadline spent before the picture: no crash, notice, saved state back', { timeout: 8000 }, async () => {
  const state = { i: 3, last: '2015-06-01', seen: ['2015-06-01'] };
  const t0 = Date.now();
  const out = await using(router({ delay: 6000 }), () => run(modeIn('archive', state)), undefined);
  assert.ok(Date.now() - t0 < 4700, 'took ' + (Date.now() - t0));
  assert.strictEqual(out.image, null);
  assert.ok(out.notice);
  assert.deepStrictEqual(out.trmnl_state, state);
});

// 2026-10-15 on a real TRMNL: newer day pages write `{{Potd filename|1=NAME.jpg <!-- FILENAME HERE ... -->|...}}`; the
// comment and the 1= became part of the file name, the file lookup failed and on_this_day stayed on one picture.
test('on_this_day: a day page written as 1=NAME with a comment gives the plain file name', async () => {
  const page = (title, content) => ({ pageid: 1, ns: 10, title, revisions: [{ slots: { main: { content } } }] });
  const h = { day: (d) => ({ query: { pages: [page('Template:Potd/' + d, `{{Potd filename|1=F_${d}.jpg <!-- FILENAME HERE, e.g. Example.jpg -->|2=x}}`)] } }) };
  const runs = await otd(Date.UTC(2008, 2, 10, 12), 1, h);
  const fileUrl = runs[0].urls.find((u) => /titles=File/.test(u));
  assert.strictEqual(decodeURIComponent(new URL(fileUrl).searchParams.get('titles')), 'File:F_2005-03-10.jpg');
  assert.ok(runs[0].o.image && runs[0].o.image.image_url);
});

test('on_this_day: a year whose picture fails is passed over, the next refresh tries the next year', async () => {
  const h = { infoFor: (u) => (/2006/.test(decodeURIComponent(u)) ? null : info) };
  const runs = await otd(Date.UTC(2008, 2, 10, 12), 3, h);
  assert.deepStrictEqual(runs.map((x) => x.o.image.date), ['2005-03-10', '2005-03-10', '2007-03-10']);
  assert.match(runs[1].o.debug || '', /day 2006/);
});
