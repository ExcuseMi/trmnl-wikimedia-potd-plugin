// node --test plugin/test ; TRANSFORM=path runs the tests against another transform (used to see them fail)
const test = require('node:test');
const assert = require('node:assert');
const fs = require('node:fs');
const path = require('node:path');

const file = process.env.TRANSFORM || path.join(__dirname, '..', 'src', 'transform.js');
const run = new Function(fs.readFileSync(file, 'utf8') + '\nreturn run;')();
const meta = fs.readFileSync(path.join(__dirname, 'extmetadata.json'), 'utf8');
const okFetch = (body) => async () => ({ ok: true, json: async () => JSON.parse(body) });
// No test reaches the network: fetch fails unless a test stubs it
globalThis.fetch = async () => { throw new Error('no network in tests'); };
const atom = fs.readFileSync(path.join(__dirname, 'potd-sample.atom'), 'utf8');

const withState = (answer, state, mode) => ({
  data: answer, trmnl: { state, plugin_settings: { custom_fields_values: { mode: mode || 'today' } } },
});

// What an XML to JSON step may hand over: entries as objects with the summary as text
function asJson(xml) {
  const entry = [...xml.matchAll(/<entry>([\s\S]*?)<\/entry>/g)].map(([, e]) => {
    const g = (t) => (new RegExp(`<${t}[^>]*>([\\s\\S]*?)</${t}>`).exec(e) || [, ''])[1];
    return { id: g('id'), title: g('title'), updated: g('updated'), summary: { type: 'html', '#text': g('summary').replace(/&lt;/g, '<').replace(/&gt;/g, '>').replace(/&quot;/g, '"').replace(/&amp;/g, '&') }, author: { name: g('name') } };
  });
  return { feed: { entry } };
}

test('picture url is 1280 px, https, without tracking query', async () => {
  const out = await run({ data: atom });
  assert.ok(out.image, JSON.stringify(out));
  assert.match(out.image.image_url, /^https:\/\/thumb\.wikimedia\.org\/.*\/1280px-[^?]+$/);
  assert.ok(!out.image.image_url.includes('330px'));
  assert.ok(!out.image.image_url.includes('utm_'));
  assert.match(out.image.link, /^https:\/\/commons\.wikimedia\.org\/wiki\/File:/);
});

test('newest entry first, with date and position', async () => {
  const out = await run({ data: atom });
  const dates = [...atom.matchAll(/<updated>(\d{4}-\d\d-\d\d)/g)].map((m) => m[1]).slice(1).sort().reverse();
  assert.strictEqual(out.image.date, dates[0]);
  assert.strictEqual(out.image.position, '1 / 10');
  assert.match(out.image.date_label, /^\d{1,2} [A-Z][a-z]{2} 2026$/);
});

test('caption from the summary, text only; file name when there is none', async () => {
  const withCaption = await run({ data: atom.replace(/<entry>[\s\S]*$/, '') + '<entry><id>x/potd/20261001000000/en</id><updated>2026-10-01T00:00:00Z</updated><summary type="html">&lt;a href=&quot;/wiki/File:Rain_Quail_x.jpg&quot;&gt;&lt;img src=&quot;https://thumb.wikimedia.org/wikipedia/commons/thumb/6/64/Rain_Quail_x.jpg/330px-Rain_Quail_x.jpg&quot;&gt;&lt;/a&gt;&lt;div class=&quot;description en&quot;&gt;&lt;i&gt;Coturnix&lt;/i&gt; (Rain Quail) in &lt;a href=&quot;/u&quot;&gt;India&lt;/a&gt;.&lt;/div&gt;</summary></entry></feed>' });
  assert.strictEqual(withCaption.image.title, 'Coturnix (Rain Quail) in India.');
  const noCaption = await run({ data: '<feed><entry><id>x/potd/20261001000000/en</id><updated>2026-10-01T00:00:00Z</updated><summary>&lt;a href=&quot;/wiki/File:My_nice_%C3%A9t%C3%A9_photo.jpg&quot;&gt;&lt;img src=&quot;https://thumb.wikimedia.org/wikipedia/commons/thumb/a/ab/My_nice_%C3%A9t%C3%A9_photo.jpg/330px-My_nice_%C3%A9t%C3%A9_photo.jpg&quot;&gt;&lt;/a&gt;</summary></entry></feed>' });
  assert.strictEqual(noCaption.image.title, 'My nice été photo');
});

test('a long caption is cut to one title line, at the first sentence or a word', async () => {
  const mk = (text) => '<feed><entry><id>x/potd/20261001000000/en</id><updated>2026-10-01T00:00:00Z</updated><summary>&lt;img src=&quot;https://thumb.wikimedia.org/a/330px-A.jpg&quot;&gt;&lt;div class=&quot;description en&quot;&gt;' + text + '&lt;/div&gt;</summary></entry></feed>';
  const sentence = await run({ data: mk('White teatfish at Ras Muhammad. This species of sea cucumber is found in shallow waters near islands and reefs.') });
  assert.strictEqual(sentence.image.title, 'White teatfish at Ras Muhammad.');
  const words = await run({ data: mk('word '.repeat(60)) });
  assert.ok(words.image.title.length <= 110 && words.image.title.endsWith('...'), words.image.title);
});

test('credit always names Wikimedia Commons; author and licence only when known', async () => {
  const plainOut = await run({ data: atom });
  assert.strictEqual(plainOut.image.credit, 'Wikimedia Commons');
  assert.strictEqual(plainOut.image.author, null);
  const xml = '<feed><entry><id>x/potd/20261001000000/en</id><updated>2026-10-01T00:00:00Z</updated><summary>&lt;img src=&quot;https://thumb.wikimedia.org/a/330px-A.jpg&quot;&gt;&lt;span class=&quot;licensetpl&quot;&gt;CC BY-SA 4.0&lt;/span&gt;&lt;span class=&quot;fileinfo-author&quot;&gt;Jane Doe&lt;/span&gt;</summary></entry></feed>';
  const rich = await run({ data: xml });
  assert.strictEqual(rich.image.credit, 'Jane Doe, CC BY-SA 4.0, Wikimedia Commons');
});

test('the same pictures come out of a parsed JSON answer and a raw string', async () => {
  const a = await run({ data: atom });
  const b = await run({ data: asJson(atom) });
  const c = await run(atom);
  const d = await run(asJson(atom));
  for (const o of [b, c, d]) assert.deepStrictEqual(o.image, a.image);
});

test('rotate advances and wraps across three runs using the returned state', async () => {
  const three = atom.replace(/<entry>[\s\S]*$/, '') +
    [3, 2, 1].map((n) => `<entry><id>x/potd/2026100${n}000000/en</id><updated>2026-10-0${n}T00:00:00Z</updated><summary>&lt;img src=&quot;https://thumb.wikimedia.org/p/330px-P${n}.jpg&quot;&gt;</summary></entry>`).join('') + '</feed>';
  let state; const seen = [];
  for (let i = 0; i < 4; i++) {
    const out = await run(withState(three, state, 'rotate'));
    seen.push(out.image.position);
    state = out.trmnl_state;
    assert.deepStrictEqual(Object.keys(state).sort(), ['i', 'last', 'pic']);
    assert.ok(JSON.stringify(state).length < 6000 && !/http/.test(JSON.stringify({ i: state.i, last: state.last })));
  }
  assert.deepStrictEqual(seen, ['1 / 3', '2 / 3', '3 / 3', '1 / 3']);
});

test('rotate follows the entry when a new day shifts the list', async () => {
  const mk = (days) => atom.replace(/<entry>[\s\S]*$/, '') + days.map((n) => `<entry><id>x/potd/202610${n}000000/en</id><updated>2026-10-${n}T00:00:00Z</updated><summary>&lt;img src=&quot;https://thumb.wikimedia.org/p/330px-P${n}.jpg&quot;&gt;</summary></entry>`).join('') + '</feed>';
  const first = await run(withState(mk(['03', '02', '01']), undefined, 'rotate'));
  const second = await run(withState(mk(['04', '03', '02', '01']), first.trmnl_state, 'rotate'));
  assert.strictEqual(first.image.date, '2026-10-03');
  assert.strictEqual(second.image.date, '2026-10-02');
});

for (const [name, state] of [['missing', undefined], ['a string', 'junk'], ['a negative index', { i: -3, last: 'a' }], ['a float', { i: 1.5, last: 'a' }], ['no id', { i: 2 }], ['an array', [1, 2]], ['null', null]]) {
  test(`state ${name} resets to the first picture`, async () => {
    const out = await run(withState(atom, state, 'rotate'));
    assert.strictEqual(out.image.position, '1 / 10');
    assert.strictEqual(out.trmnl_state.i, 0);
  });
}

test('today always shows the newest, random never repeats the last shown', async () => {
  let state;
  for (let i = 0; i < 3; i++) {
    const out = await run(withState(atom, state, 'today'));
    assert.strictEqual(out.image.position, '1 / 10');
    state = out.trmnl_state;
  }
  const real = Math.random; Math.random = () => 0; // always index 0, the one just shown
  try {
    const out = await run(withState(atom, state, 'random'));
    assert.notStrictEqual(out.trmnl_state.last, state.last);
  } finally { Math.random = real; }
});

test('an entry without a picture is skipped', async () => {
  const broken = atom.replace(/&lt;img /, '&lt;nope ');
  const out = await run({ data: broken });
  assert.match(out.image.position, / \/ 9$/);
  const only = await run({ data: '<feed><entry><id>a</id><summary>no picture here</summary></entry></feed>' });
  assert.strictEqual(only.image, null);
  assert.ok(only.notice);
});

for (const [name, input] of [
  ['nothing', undefined], ['null', null], ['an empty object', {}], ['an empty string', ''],
  ['an error object', { data: { code: 'x', data: { status: 503 } } }],
  ['an error page', { data: '<html><body>Service unavailable</body></html>' }],
  ['a number', 42], ['entries that are not objects', { feed: { entry: [1, null, 'x'] } }],
  ['an empty feed', { data: '<feed></feed>' }],
]) {
  test(`no crash on ${name}: a notice, and the saved state is kept`, async () => {
    const state = { i: 3, last: '20261003000000' };
    const out = await run(input && typeof input === 'object' ? { ...input, trmnl: { state } } : input);
    assert.strictEqual(out.image, null);
    assert.ok(out.notice && out.notice.length > 10);
    if (input && typeof input === 'object') assert.deepStrictEqual(out.trmnl_state, state);
  });
}

test('credit and description come from the Commons metadata call; nothing of it in the state', async () => {
  let url;
  globalThis.fetch = async (u) => { url = u; return okFetch(meta)(); };
  try {
    const out = await run({ data: atom, trmnl: { user: { locale: 'nl' } } });
    assert.strictEqual(out.image.credit, 'Diego Delso, CC BY-SA 4.0, Wikimedia Commons');
    assert.strictEqual(out.image.title, 'White teatfish (Holothuria fuscogilva), Ras Muhammad National Park, Red Sea, Egypt.');
    // the title sentence is not repeated at the start of the description
    assert.match(out.image.description, /^This species of sea cucumber/);
    assert.ok(out.image.description.length <= 1000 && !/[<>]/.test(out.image.description));
    assert.match(url, /titles=File%3APepino_de_mar_/);
    assert.match(url, /iiextmetadatafilter=Artist%7CLicenseShortName%7CImageDescription/);
    assert.match(url, /uselang=nl/);
    // the state holds the last picture (texts cut), but never the long metadata description
    assert.ok(JSON.stringify(out.trmnl_state).length < 6000 && (out.trmnl_state.pic.description || '').length <= 400);
  } finally { delete globalThis.fetch; globalThis.fetch = async () => { throw new Error('no network in tests'); }; }
});

const failures = {
  'fetch throws': async () => { throw new Error('boom'); },
  'fetch answers garbage': async () => ({ ok: true, json: async () => ({ query: 'x' }) }),
  'fetch answers text': async () => ({ ok: true, json: async () => { throw new SyntaxError('bad'); } }),
  'fetch answers an HTTP error': async () => ({ ok: false, json: async () => JSON.parse(meta) }),
  'fetch answers without fields': async () => ({ ok: true, json: async () => ({ query: { pages: { 1: { imageinfo: [{ extmetadata: {} }] } } } }) }),
  'a slow fetch that ignores the abort': () => new Promise(() => {}),
};
for (const [name, stub] of Object.entries(failures)) {
  test(`${name}: credit and description fall back to the feed, no crash`, { timeout: 4500 }, async () => {
    globalThis.fetch = stub;
    const t0 = Date.now();
    try {
      const out = await run({ data: atom });
      assert.strictEqual(out.image.credit, 'Wikimedia Commons');
      // the feed caption's story after its first sentence (the title), not repeated and not lost (2026-10-15: a
      // caption cut to its first sentence left no description at all on a real TRMNL)
      assert.strictEqual(out.image.title, 'White teatfish (Holothuria fuscogilva), Ras Muhammad National Park, Red Sea, Egypt.');
      assert.match(out.image.description, /^This species of sea cucumber/);
      assert.ok(Date.now() - t0 < 3500, 'stays inside the 5 s budget');
    } finally { globalThis.fetch = async () => { throw new Error('no network in tests'); }; }
  });
}

test('no description anywhere: null, not a crash', async () => {
  const bare = '<feed><entry><id>x/potd/20261001000000/en</id><updated>2026-10-01T00:00:00Z</updated><summary>&lt;img src=&quot;https://thumb.wikimedia.org/a/330px-A.jpg&quot;&gt;</summary></entry></feed>';
  const out = await run({ data: bare });
  assert.strictEqual(out.image.description, null);
  assert.strictEqual(out.image.credit, 'Wikimedia Commons');
});

test('summary author and licence stay when the call lacks them', async () => {
  const xml = '<feed><entry><id>x/potd/20261001000000/en</id><updated>2026-10-01T00:00:00Z</updated><summary>&lt;img src=&quot;https://thumb.wikimedia.org/a/330px-A.jpg&quot;&gt;&lt;span class=&quot;fileinfo-author&quot;&gt;Jane Doe&lt;/span&gt;</summary></entry></feed>';
  globalThis.fetch = failures['fetch answers without fields'];
  try { assert.strictEqual((await run({ data: xml })).image.credit, 'Jane Doe, Wikimedia Commons'); }
  finally { globalThis.fetch = async () => { throw new Error('no network in tests'); }; }
});

// Layout flow from the picture's size: never cropped (2026-10-15: a landscape picture was cut at both sides)
for (const [w, h, flow] of [[4000, 2667, 'top'], [2000, 3000, 'side'], [1200, 1100, 'side'], [null, null, 'side']]) {
  test(`picture ${w}x${h}: flow ${flow}`, async () => {
    const body = JSON.parse(meta);
    const page = Object.values(body.query.pages)[0];
    if (w) { page.imageinfo[0].width = w; page.imageinfo[0].height = h; } else { delete page.imageinfo[0].width; delete page.imageinfo[0].height; }
    globalThis.fetch = okFetch(JSON.stringify(body));
    try {
      const out = await run({ data: atom });
      assert.strictEqual(out.image.flow, flow);
      assert.ok(!('flow' in (out.trmnl_state || {})) && !('w' in (out.trmnl_state || {})) && out.trmnl_state.pic.flow === flow);
    } finally { globalThis.fetch = async () => { throw new Error('no network in tests'); }; }
  });
}

// Language comes from the user's TRMNL locale; the feed and the metadata call use the same one
for (const [locale, want] of [['nl', 'nl'], ['nl-BE', 'nl'], ['pt_BR', 'pt'], ['NL', 'nl'], ['xx', 'en'], ['', 'en'], [undefined, 'en']]) {
  test(`locale ${JSON.stringify(locale)} asks Commons for ${want}`, async () => {
    const urls = [];
    globalThis.fetch = async (u) => {
      urls.push(String(u));
      if (/featuredfeed/.test(u)) return { ok: true, text: async () => atom };
      return okFetch(meta)();
    };
    try {
      const out = await run({ trmnl: { user: locale === undefined ? {} : { locale } } });
      assert.ok(out.image, JSON.stringify(out));
      assert.ok(urls.some((u) => u.includes('featuredfeed') && u.endsWith('language=' + want)), urls.join('\n'));
      assert.ok(urls.some((u) => u.includes('uselang=' + want + '&')), urls.join('\n'));
    } finally { globalThis.fetch = async () => { throw new Error('no network in tests'); }; }
  });
}

test('feed fetch fails or is slow: a notice, the saved state back, no crash', async () => {
  globalThis.fetch = () => new Promise(() => {});
  try {
    const out = await run({ trmnl: { state: { i: 2, last: 'x' } } });
    assert.strictEqual(out.image, null);
    assert.deepStrictEqual(out.trmnl_state, { i: 2, last: 'x' });
  } finally { globalThis.fetch = async () => { throw new Error('no network in tests'); }; }
});
