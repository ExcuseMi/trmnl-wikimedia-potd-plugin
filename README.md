# Wikimedia Commons Picture of the Day (TRMNL plugin)

Shows the Commons picture of the day with caption, date and a credit line. Source: the Commons featured feed (last 10 days, Atom), no key needed.

| Setting | Values |
|---|---|
| Picture Selection | Today (newest), Rotate (next picture each refresh, kept in `trmnl_state` as index and entry id), Random |
| Caption Language | en, nl, de, fr, es |

Author and licence are shown only when the feed carries them; the credit line always names Wikimedia Commons. Each file has its own licence on its Commons page (linked as `image.link`).

Test: `node --test plugin/test/transform.test.js` (`TRANSFORM=path` tests another transform file). Render: `cd plugin && ./bin/trmnlp build --png` (writes `plugin/_build`).
