// node --test plugin/test/lastpic.test.js ; TRANSFORM=path runs the tests against another transform (used to see them fail)
// Serverless run (empty polling_url): the feed first, the extras after, the last good picture kept in the state.
const test = require('node:test');
const assert = require('node:assert');
const fs = require('node:fs');
const path = require('node:path');

const file = process.env.TRANSFORM || path.join(__dirname, '..', 'src', 'transform.js');
const run = new Function(fs.readFileSync(file, 'utf8') + '\nreturn run;')();
const atom = fs.readFileSync(path.join(__dirname, 'potd-sample.atom'), 'utf8');
const info = JSON.parse(fs.readFileSync(path.join(__dirname, 'mahonia-info.json'), 'utf8'));
const noFetch = async () => { throw new Error('no network in tests'); };
globalThis.fetch = noFetch;

// feed: { delay, fail } for the feed call; other calls answer the file info at once (or after meta delay)
function stub(feed, urls) {
  return async (u) => {
    u = String(u); urls.push(u);
    if (/featuredfeed/.test(u)) {
      if (feed.delay) await new Promise((r) => setTimeout(r, feed.delay));
      if (feed.status) return { ok: false, status: feed.status };
      if (feed.throws) throw new Error(feed.throws);
      return { ok: true, text: async () => feed.body || atom };
    }
    if (/action=query&titles=File/.test(u)) return { ok: true, json: async () => info };
    return { ok: false, status: 404 };
  };
}
async function go(feed, input) {
  const urls = [];
  globalThis.fetch = stub(feed, urls);
  const t0 = Date.now();
  try { const out = await run(input || { trmnl: { user: { locale: 'en' } } }); return { out, urls, took: Date.now() - t0 }; }
  finally { globalThis.fetch = noFetch; }
}
const withState = (state) => ({ trmnl: { user: { locale: 'en' }, state } });

test('a good run keeps the last picture in the state, under 6 kB even with a 1000 char description', async () => {
  const long = JSON.parse(JSON.stringify(info));
  Object.values(long.query.pages)[0].imageinfo[0].extmetadata.ImageDescription.value = 'word '.repeat(300);
  const urls = [];
  globalThis.fetch = async (u) => (/titles=File/.test(u) ? { ok: true, json: async () => long } : stub({}, urls)(u));
  let out;
  try { out = await run({ trmnl: { user: { locale: 'en' } } }); } finally { globalThis.fetch = noFetch; }
  assert.ok(out.image.description.length > 900, 'description ' + out.image.description.length);
  const pic = out.trmnl_state.pic;
  assert.strictEqual(pic.image_url, out.image.image_url);
  assert.strictEqual(pic.title, out.image.title);
  assert.ok(pic.description.length <= 400);
  const size = JSON.stringify(out.trmnl_state).length;
  assert.ok(size < 6000 && size < 2500, 'state ' + size + ' bytes');
});

test('feed times out: the last picture again, no notice, state back, why in debug', { timeout: 9000 }, async () => {
  const first = await go({});
  const { out, took } = await go({ delay: 10000 }, withState(first.out.trmnl_state));
  assert.ok(took < 4600, 'took ' + took);
  assert.strictEqual(out.image.image_url, first.out.image.image_url);
  assert.strictEqual(out.image.notice, undefined);
  assert.strictEqual(out.notice, undefined);
  assert.deepStrictEqual(out.trmnl_state, first.out.trmnl_state);
  assert.match(out.debug, /feed: timeout after 3\d\d\d ms/);
});

test('feed answers 503 or throws: the last picture, debug says which', async () => {
  const first = await go({});
  const a = await go({ status: 503 }, withState(first.out.trmnl_state));
  assert.strictEqual(a.out.image.title, first.out.image.title);
  assert.match(a.out.debug, /status 503/);
  const b = await go({ throws: 'socket hang up' }, withState(first.out.trmnl_state));
  assert.strictEqual(b.out.image.title, first.out.image.title);
  assert.match(b.out.debug, /socket hang up/);
});

test('first run, no state, feed failed: the notice, and the reason in debug', async () => {
  const { out } = await go({ status: 500 });
  assert.strictEqual(out.image, null);
  assert.ok(out.notice && out.notice.length > 10);
  assert.match(out.debug, /feed: status 500/);
  assert.deepStrictEqual(out.trmnl_state, {});
});

test('a damaged picture in the state is not shown', async () => {
  const bad = { i: 0, last: 'x', pic: { image_url: 'javascript:alert(1)', title: 'x' } };
  const { out } = await go({ status: 500 }, withState(bad));
  assert.strictEqual(out.image, null);
});

test('feed took 3.4 s: the extras (metadata, Wikipedia) are skipped, the run stays under 4.5 s', { timeout: 9000 }, async () => {
  const { out, urls, took } = await go({ delay: 3400 });
  assert.ok(out.image, JSON.stringify(out));
  assert.ok(took < 4500, 'took ' + took);
  assert.deepStrictEqual(urls.filter((u) => !/featuredfeed/.test(u)), [], urls.join('\n'));
});

test('feed took 1 s: the metadata is fetched, the feed was not cut short', { timeout: 9000 }, async () => {
  const { out, urls } = await go({ delay: 1000 });
  assert.ok(urls.some((u) => /titles=File/.test(u)));
  assert.strictEqual(out.image.credit, 'Agnes Monkelbaan, CC BY-SA 4.0, Wikimedia Commons');
});
