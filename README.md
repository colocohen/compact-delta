# compact-delta

**The only JS delta library that auto-picks the smallest encoding.** Given an
old `base` and a new `target`, it produces the smallest possible binary delta to
send to a peer who already has the base — by trying several methods and emitting
the winner. Zero dependencies. Works in Node (ESM + CJS) and the browser.

```
npm install compact-delta
```

## Why

There is no single delta algorithm that wins for every kind of edit:

- **in-place substitutions** → an LCS/Myers diff is smallest
- **block moves, copy/paste, repeats** → a copy/insert (rsync-style) delta wins
- **a brand-new payload** → no delta helps; sending it raw is best

Other libraries pick one algorithm. `compact-delta` runs every applicable method,
measures the result, and emits the smallest — with a 1-byte tag so the decoder
always knows how to read it. The choice is made by the numbers at runtime, not by
the caller. Cheap short-circuits (identical / empty base) skip work up front.

This is **optimal-in-practice**: the smallest delta among proven methods,
independent of the kind of edit.

## Usage

All operations are **callback-based** (Node-style `(err, result)`), so the API
is ready for an async backend (e.g. a future WebAssembly codec) without changing
any call sites. The callback always fires asynchronously, exactly once.

### ESM / TypeScript

```js
import { encode, decode } from 'compact-delta';

encode(oldText, newText, (err, delta) => {
  if (err) throw err;
  // delta is a Uint8Array, ready to send
  decode(oldText, delta, (err2, restored) => {
    // restored === newText (as bytes)
  });
});
```

### CommonJS

```js
const { encode, decode } = require('compact-delta');
```

### Browser (no bundler, opens over file://)

```html
<script src="./dist/compact-delta.umd.js"></script>
<script>
  compactDelta.encodeString('hello world', 'hello brave world', (err, delta) => {
    compactDelta.decodeString('hello world', delta, (err2, text) => console.log(text));
  });
</script>
```

## API

```ts
encode(base, target, [optionsOrMethod], callback)        // cb(err, Uint8Array)
decode(base, delta, callback)                            // cb(err, Uint8Array)
encodeString(base, target, [optionsOrMethod], callback)  // cb(err, Uint8Array)
decodeString(base, delta, callback)                      // cb(err, string)
tryEncode(base, target, [optionsOrMethod], callback)     // cb(err, { method, delta, worthwhile, size, raw, ratio })
inspect(base, target, callback)                          // cb(err, { method, size, raw, ratio, candidates })

isRaw(deltaBytes)   // → boolean  (synchronous — reads only the method tag)
METHODS             // { RAW: 0, BYTEDIFF: 1, LCS: 2 }
```

`base`/`target` accept `Uint8Array | string`. The callback is always the last
argument and always fires asynchronously. Full TypeScript declarations bundled.

### Forcing a method

By default the encoder runs every method and picks the smallest. If you *know*
one method always wins for your data, force it (skipping the others). Pass a
method name or options object before the callback:

```js
encode(base, target, cb)                              // auto — try all
encode(base, target, 'bytediff', cb)                  // force bytediff
encode(base, target, { method: 'lcs' }, cb)           // object form
encode(base, target, { method: 'bytediff', strict: true }, cb)
```

A forced method still falls back to RAW if its delta would be larger than the
full target (cheap length check). `strict: true` sends it verbatim regardless.
The method tag travels in the delta, so a forced delta decodes like any other.

### Deciding whether a delta is worth sending

```js
tryEncode(oldText, newText, (err, r) => {
  if (r.worthwhile) send(r.delta);     // a delta method beat the full target
  else sendFullViaGzip(newText);       // RAW won — delta didn't help
});
```

### Inspecting the decision

```js
inspect(offerSdp, answerSdp, (err, info) => {
  // info = { method: 'bytediff', size: 104, raw: 439, ratio: 0.237,
  //          candidates: { raw: 440, bytediff: 104, lcs: 128 } }
});
```

## Wire format

Every delta is `[ 1-byte method tag ][ payload ]`:

| tag  | method   | payload                     | strong at                        |
| ---- | -------- | --------------------------- | -------------------------------- |
| 0x00 | RAW      | the target, verbatim        | brand-new content (safety floor) |
| 0x01 | BYTEDIFF | COPY/INSERT op stream       | moves, copy/paste, repeats       |
| 0x02 | LCS      | Myers diff, binary-encoded  | in-place substitutions           |

Because the method is self-describing, **adding a method later does not break old
deltas** — old decoders still read old tags.

## Guarantees

- **Reversible**: `decode(base, encode(base, target))` reproduces `target`, for any bytes.
- **Bounded**: a delta is never larger than `target.length + 1` (the RAW floor).
- **Content-agnostic**: no assumptions about the data (SDP, JSON, anything).
- **Cross-realm safe**: accepts `Uint8Array` from any realm (worker, iframe).

## Algorithms

- **BYTEDIFF** — Rabin-Karp rolling hash builds an anchor map of the base; the
  target is scanned in linear time, matches are verified byte-for-byte and
  extended greedily. Output is a varint-encoded COPY/INSERT stream.
- **LCS** — Myers' O(ND) diff over the byte sequences, then a compact binary
  encoding (EQUAL/INSERT/DELETE with varint lengths) — not the verbose
  unified-diff text format.

## Development

```
npm run build   # regenerate dist/ from src/compact-delta.js
npm test        # core suite + format-interop suite
```

Single source of truth: `src/compact-delta.js` (ESM). `build.cjs` derives the
UMD build. Tests cover correctness, binary/unicode, 500 randomized fuzz cases
across all edit types, a per-edit-type benchmark proving the selector picks the
right winner, and cross-format byte-identity.

## License

Apache-2.0
