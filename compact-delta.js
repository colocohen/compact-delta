/*
 * compact-delta — generic optimal binary delta compression (optimized)
 *
 * Wire-format compatible with the original: [1-byte method tag][payload].
 *
 * Performance changes vs. original:
 *   1. BYTEDIFF anchor index: Int32Array hash chains (head+next) instead of a
 *      plain-object map — no string keys, no per-anchor allocation.
 *   2. Candidate loop: "quick reject" — a candidate can only beat the current
 *      best match if it matches at position `best`; check 1 byte before the
 *      full verify.
 *   3. Backward match extension — matches grow left into the pending literal
 *      region (smaller deltas, ~free).
 *   4. Myers: Int32Array V-vectors.
 *   5. Auto mode: LCS gets a time budget proportional to the possible gain
 *      (bestSoFar/raw). If bytediff already produced a tiny delta, LCS is
 *      skipped; if nothing worked so far, LCS gets the full budget.
 *      `exhaustive: true` restores always-run-everything.
 *   6. LCS encoding drops a trailing DELETE (dead bytes).
 *
 * Correctness fixes:
 *   - Reader.varint throws on truncated input (was: silent garbage).
 *   - encodeString/decodeString reject non-string input (was: silent
 *     '[object Uint8Array]' encoding).
 *   - Cached TextEncoder/TextDecoder.
 *   - inspect() runs each algorithm once (was: twice).
 *
 * New options: { window, lcsMs, exhaustive } — see README.
 *
 * License: Apache-2.0
 */

// ══ Method tags ════════════════════════════════════════════════════════════
var M_RAW = 0x00;
var M_BYTEDIFF = 0x01;
var M_LCS = 0x02;

// ══ Bytes <-> string ═══════════════════════════════════════════════════════
var TE = (typeof TextEncoder !== 'undefined') ? new TextEncoder() : null;
var TD = (typeof TextDecoder !== 'undefined') ? new TextDecoder() : null;
function utf8Encode(s) {
  if (TE) return TE.encode(s);
  return new Uint8Array(Buffer.from(s, 'utf8'));
}
function utf8Decode(u8) {
  if (TD) return TD.decode(u8);
  return Buffer.from(u8).toString('utf8');
}
function isU8(x) {
  return x != null && Object.prototype.toString.call(x) === '[object Uint8Array]';
}
function toU8(x) {
  if (isU8(x)) return x;
  if (typeof x === 'string') return utf8Encode(x);
  if (x && x.buffer instanceof ArrayBuffer) return new Uint8Array(x.buffer, x.byteOffset, x.byteLength);
  throw new TypeError('compact-delta: expected Uint8Array or string');
}
function bytesEqual(a, b) {
  if (a.length !== b.length) return false;
  for (var i = 0; i < a.length; i++) if (a[i] !== b[i]) return false;
  return true;
}

// ══ Byte writer / reader (LEB128 varints) ══════════════════════════════════
function Writer() { this.buf = new Uint8Array(256); this.len = 0; }
Writer.prototype._ensure = function (extra) {
  var need = this.len + extra;
  if (need <= this.buf.length) return;
  var cap = this.buf.length;
  while (cap < need) cap *= 2;
  var next = new Uint8Array(cap);
  next.set(this.buf.subarray(0, this.len));
  this.buf = next;
};
Writer.prototype.byte = function (b) { this._ensure(1); this.buf[this.len++] = b & 0xff; };
Writer.prototype.varint = function (n) {
  this._ensure(5); n = n >>> 0;
  while (n >= 0x80) { this.buf[this.len++] = (n & 0x7f) | 0x80; n >>>= 7; }
  this.buf[this.len++] = n;
};
Writer.prototype.bytes = function (u8, start, length) {
  this._ensure(length);
  this.buf.set(u8.subarray(start, start + length), this.len);
  this.len += length;
};
Writer.prototype.finish = function () { return this.buf.subarray(0, this.len); };

function Reader(u8) { this.u8 = u8; this.pos = 0; }
Reader.prototype.byte = function () {
  if (this.pos >= this.u8.length) throw new Error('compact-delta: truncated delta');
  return this.u8[this.pos++];
};
Reader.prototype.varint = function () {
  var r = 0, sh = 0, b;
  do {
    if (this.pos >= this.u8.length) throw new Error('compact-delta: truncated varint');
    b = this.u8[this.pos++];
    // 32-bit cap: the 5th byte may carry only 4 data bits and no continuation.
    // (The encoder never emits more; anything else is corruption.)
    if (sh === 28 && (b & 0xf0)) throw new Error('compact-delta: varint overflow');
    r |= (b & 0x7f) << sh; sh += 7;
  } while (b & 0x80);
  return r >>> 0;
};
Reader.prototype.eof = function () { return this.pos >= this.u8.length; };

// ══════════════════════════════════════════════════════════════════════════
//  METHOD 0x01 — BYTEDIFF (copy/insert, Rabin-Karp rolling hash + chains)
// ══════════════════════════════════════════════════════════════════════════
var DEFAULT_WINDOW = 16;
var RK_BASE = 257;
var MAX_CHAIN = 32;      // candidates examined per hash slot
var HASH_MIX = 15;       // h ^ (h >>> HASH_MIX) before masking

var POW_CACHE = Object.create(null);
function rkPow(win) {
  var p = POW_CACHE[win];
  if (p === undefined) {
    p = 1;
    for (var i = 0; i < win - 1; i++) p = Math.imul(p, RK_BASE) >>> 0;
    POW_CACHE[win] = p;
  }
  return p;
}

var OP_COPY = 0, OP_INSERT = 1;

// Hash chains over every window position of base:
//   head[slot] -> most recent base offset whose window hashed into slot (-1 = none)
//   next[off]  -> previous offset in the same slot (-1 = end)
// Chains give O(1) insert, zero allocation per anchor, and cache-friendly walks.
function buildChains(base, win) {
  var n = base.length;
  if (n < win) return null;
  var count = n - win + 1;
  var tsize = 1;
  while (tsize < count * 2 && tsize < (1 << 24)) tsize <<= 1;
  var mask = tsize - 1;
  var head = new Int32Array(tsize).fill(-1);
  var next = new Int32Array(count);
  var pow = rkPow(win);
  var h = 0, i;
  for (i = 0; i < win; i++) h = (Math.imul(h, RK_BASE) + base[i]) >>> 0;
  var slot = (h ^ (h >>> HASH_MIX)) & mask;
  next[0] = head[slot]; head[slot] = 0;
  for (var off = 1; off < count; off++) {
    h = (Math.imul((h - Math.imul(base[off - 1], pow)) >>> 0, RK_BASE) + base[off + win - 1]) >>> 0;
    slot = (h ^ (h >>> HASH_MIX)) & mask;
    next[off] = head[slot]; head[slot] = off;
  }
  return { head: head, next: next, mask: mask };
}

// Verified match length at (baseOff, targetOff); 0 unless at least `win` bytes.
function matchLength(base, baseOff, target, targetOff, win) {
  var n = 0;
  if (Math.min(base.length - baseOff, target.length - targetOff) < win) return 0;
  for (; n < win; n++) if (base[baseOff + n] !== target[targetOff + n]) return 0;
  var bLen = base.length, tLen = target.length;
  while (baseOff + n < bLen && targetOff + n < tLen && base[baseOff + n] === target[targetOff + n]) n++;
  return n;
}

function bytediffEncode(base, target, win) {
  win = win || DEFAULT_WINDOW;
  var chains = buildChains(base, win);
  var w = new Writer();
  var tLen = target.length, bLen = base.length;
  var pow = rkPow(win);
  var i = 0, pendingStart = 0, h = 0, primed = false;

  function flush(upTo) {
    if (upTo > pendingStart) {
      w.byte(OP_INSERT);
      var len = upTo - pendingStart;
      w.varint(len);
      w.bytes(target, pendingStart, len);
    }
  }

  if (chains) {
    var head = chains.head, next = chains.next, mask = chains.mask;
    while (i < tLen) {
      if (i + win <= tLen) {
        if (!primed) {
          h = 0;
          for (var k = 0; k < win; k++) h = (Math.imul(h, RK_BASE) + target[i + k]) >>> 0;
          primed = true;
        }
        var e = head[(h ^ (h >>> HASH_MIX)) & mask];
        var best = 0, bestOff = -1, tries = MAX_CHAIN;
        while (e !== -1 && tries-- > 0) {
          // quick reject: to beat `best`, the candidate must match at
          // position `best` too — check one byte before the full verify.
          if (i + best >= tLen) break;
          if (e + best < bLen && base[e + best] === target[i + best]) {
            var ml = matchLength(base, e, target, i, win);
            if (ml > best) { best = ml; bestOff = e; }
          }
          e = next[e];
        }
        if (best >= win) {
          // extend the match backwards into the pending literal region
          while (bestOff > 0 && i > pendingStart && base[bestOff - 1] === target[i - 1]) {
            bestOff--; i--; best++;
          }
          flush(i);
          w.byte(OP_COPY); w.varint(bestOff); w.varint(best);
          i += best; pendingStart = i; primed = false; continue;
        }
        if (i + win < tLen) {
          h = (Math.imul((h - Math.imul(target[i], pow)) >>> 0, RK_BASE) + target[i + win]) >>> 0;
        } else primed = false;
        i++;
      } else i++;
    }
  } else {
    i = tLen; // base too small to copy from — everything is one INSERT
  }
  flush(tLen);
  return w.finish();
}

function bytediffDecode(base, r, out) {
  while (!r.eof()) {
    var op = r.byte();
    if (op === OP_COPY) {
      var off = r.varint(), len = r.varint();
      if (off + len > base.length) throw new Error('compact-delta: COPY out of base bounds');
      out.bytes(base, off, len);
    } else if (op === OP_INSERT) {
      var ilen = r.varint();
      if (r.pos + ilen > r.u8.length) throw new Error('compact-delta: truncated INSERT');
      out.bytes(r.u8, r.pos, ilen); r.pos += ilen;
    } else throw new Error('delta: corrupt bytediff op ' + op);
  }
}

// ══════════════════════════════════════════════════════════════════════════
//  METHOD 0x02 — LCS (Myers diff) with compact binary encoding
// ══════════════════════════════════════════════════════════════════════════
var DIFF_DELETE = -1, DIFF_INSERT = 1, DIFF_EQUAL = 0;

function myersDiff(a, b, deadline) {
  if (deadline == null) deadline = Date.now() + 1000;
  if (a === b) return a ? [[DIFF_EQUAL, a]] : [];
  var pre = commonPrefix(a, b);
  var cp = a.substring(0, pre);
  a = a.substring(pre); b = b.substring(pre);
  var suf = commonSuffix(a, b);
  var cs = a.substring(a.length - suf);
  a = a.substring(0, a.length - suf); b = b.substring(0, b.length - suf);
  var diffs = myersCompute(a, b, deadline);
  if (cp) diffs.unshift([DIFF_EQUAL, cp]);
  if (cs) diffs.push([DIFF_EQUAL, cs]);
  cleanupMerge(diffs);
  return diffs;
}
function commonPrefix(a, b) { var n = Math.min(a.length, b.length); for (var i = 0; i < n; i++) if (a[i] !== b[i]) return i; return n; }
function commonSuffix(a, b) { var n = Math.min(a.length, b.length); for (var i = 1; i <= n; i++) if (a[a.length - i] !== b[b.length - i]) return i - 1; return n; }
function myersCompute(a, b, deadline) {
  if (!a) return [[DIFF_INSERT, b]];
  if (!b) return [[DIFF_DELETE, a]];
  var lt = a.length > b.length ? a : b, st = a.length > b.length ? b : a;
  var idx = lt.indexOf(st);
  if (idx !== -1) {
    var d = [[DIFF_INSERT, lt.substring(0, idx)], [DIFF_EQUAL, st], [DIFF_INSERT, lt.substring(idx + st.length)]];
    if (a.length > b.length) { d[0][0] = d[2][0] = DIFF_DELETE; }
    return d;
  }
  if (st.length === 1) return [[DIFF_DELETE, a], [DIFF_INSERT, b]];
  return myersBisect(a, b, deadline);
}
function myersBisect(a, b, deadline) {
  var n = a.length, m = b.length, max = Math.ceil((n + m) / 2), vo = max, vl = 2 * max;
  var v1 = new Int32Array(vl).fill(-1);
  var v2 = new Int32Array(vl).fill(-1);
  v1[vo + 1] = 0; v2[vo + 1] = 0;
  var delta = n - m, front = (delta % 2 !== 0);
  for (var d = 0; d < max; d++) {
    if (Date.now() > deadline) break;
    for (var k1 = -d; k1 <= d; k1 += 2) {
      var k1o = vo + k1, x1;
      if (k1 === -d || (k1 !== d && v1[k1o - 1] < v1[k1o + 1])) x1 = v1[k1o + 1]; else x1 = v1[k1o - 1] + 1;
      var y1 = x1 - k1;
      while (x1 < n && y1 < m && a.charCodeAt(x1) === b.charCodeAt(y1)) { x1++; y1++; }
      v1[k1o] = x1;
      if (x1 > n) continue;
      if (front) {
        var k2o = vo + delta - k1;
        if (k2o >= 0 && k2o < vl && v2[k2o] !== -1 && x1 >= n - v2[k2o]) return myersSplit(a, b, x1, y1, deadline);
      }
    }
    for (var k2 = -d; k2 <= d; k2 += 2) {
      var k2o2 = vo + k2, x2;
      if (k2 === -d || (k2 !== d && v2[k2o2 - 1] < v2[k2o2 + 1])) x2 = v2[k2o2 + 1]; else x2 = v2[k2o2 - 1] + 1;
      var y2 = x2 - k2;
      while (x2 < n && y2 < m && a.charCodeAt(n - x2 - 1) === b.charCodeAt(m - y2 - 1)) { x2++; y2++; }
      v2[k2o2] = x2;
      if (!front) {
        var k1o2 = vo + delta - k2;
        if (k1o2 >= 0 && k1o2 < vl && v1[k1o2] !== -1) {
          var xx = v1[k1o2], yy = xx - (k1o2 - vo);
          if (xx >= n - x2) return myersSplit(a, b, xx, yy, deadline);
        }
      }
    }
  }
  return [[DIFF_DELETE, a], [DIFF_INSERT, b]];
}
function myersSplit(a, b, x, y, deadline) {
  return myersDiff(a.substring(0, x), b.substring(0, y), deadline)
     .concat(myersDiff(a.substring(x), b.substring(y), deadline));
}
function cleanupMerge(diffs) {
  diffs.push([DIFF_EQUAL, '']);
  var ptr = 0, countDelete = 0, countInsert = 0, textDelete = '', textInsert = '', commonlength;
  while (ptr < diffs.length) {
    switch (diffs[ptr][0]) {
      case DIFF_INSERT:
        countInsert++; textInsert += diffs[ptr][1]; ptr++; break;
      case DIFF_DELETE:
        countDelete++; textDelete += diffs[ptr][1]; ptr++; break;
      case DIFF_EQUAL:
        if (countDelete + countInsert > 1) {
          if (countDelete !== 0 && countInsert !== 0) {
            commonlength = commonPrefix(textInsert, textDelete);
            if (commonlength !== 0) {
              if ((ptr - countDelete - countInsert) > 0 &&
                  diffs[ptr - countDelete - countInsert - 1][0] === DIFF_EQUAL) {
                diffs[ptr - countDelete - countInsert - 1][1] += textInsert.substring(0, commonlength);
              } else {
                diffs.splice(0, 0, [DIFF_EQUAL, textInsert.substring(0, commonlength)]);
                ptr++;
              }
              textInsert = textInsert.substring(commonlength);
              textDelete = textDelete.substring(commonlength);
            }
            commonlength = commonSuffix(textInsert, textDelete);
            if (commonlength !== 0) {
              diffs[ptr][1] = textInsert.substring(textInsert.length - commonlength) + diffs[ptr][1];
              textInsert = textInsert.substring(0, textInsert.length - commonlength);
              textDelete = textDelete.substring(0, textDelete.length - commonlength);
            }
          }
          ptr -= countDelete + countInsert;
          diffs.splice(ptr, countDelete + countInsert);
          if (textDelete.length) { diffs.splice(ptr, 0, [DIFF_DELETE, textDelete]); ptr++; }
          if (textInsert.length) { diffs.splice(ptr, 0, [DIFF_INSERT, textInsert]); ptr++; }
          ptr++;
        } else if (ptr !== 0 && diffs[ptr - 1][0] === DIFF_EQUAL) {
          diffs[ptr - 1][1] += diffs[ptr][1];
          diffs.splice(ptr, 1);
        } else ptr++;
        countInsert = 0; countDelete = 0; textDelete = ''; textInsert = '';
        break;
    }
  }
  if (diffs.length && diffs[diffs.length - 1][1] === '') diffs.pop();
}

function bytesToLatin1(u8) {
  var CHUNK = 0x8000, parts = [];
  for (var i = 0; i < u8.length; i += CHUNK) parts.push(String.fromCharCode.apply(null, u8.subarray(i, i + CHUNK)));
  return parts.join('');
}

var LCS_EQUAL = 0, LCS_INSERT = 1, LCS_DELETE = 2;

function lcsEncode(base, target, budgetMs) {
  var deadline = Date.now() + (typeof budgetMs === 'number' ? budgetMs : 1000);
  var diffs = myersDiff(bytesToLatin1(base), bytesToLatin1(target), deadline);
  // a trailing DELETE only skips base bytes nobody will read — drop it
  while (diffs.length && diffs[diffs.length - 1][0] === DIFF_DELETE) diffs.pop();
  var w = new Writer();
  for (var i = 0; i < diffs.length; i++) {
    var op = diffs[i][0], s = diffs[i][1], len = s.length;
    if (op === DIFF_EQUAL) { w.byte(LCS_EQUAL); w.varint(len); }
    else if (op === DIFF_DELETE) { w.byte(LCS_DELETE); w.varint(len); }
    else {
      w.byte(LCS_INSERT); w.varint(len);
      for (var j = 0; j < len; j++) w.byte(s.charCodeAt(j));
    }
  }
  return w.finish();
}

function lcsDecode(base, r, out) {
  var basePos = 0;
  while (!r.eof()) {
    var op = r.byte(), len = r.varint();
    if (op === LCS_EQUAL) {
      if (basePos + len > base.length) throw new Error('compact-delta: EQUAL out of base bounds');
      out.bytes(base, basePos, len); basePos += len;
    }
    else if (op === LCS_DELETE) { basePos += len; }
    else if (op === LCS_INSERT) {
      if (r.pos + len > r.u8.length) throw new Error('compact-delta: truncated INSERT');
      out.bytes(r.u8, r.pos, len); r.pos += len;
    }
    else throw new Error('delta: corrupt lcs op ' + op);
  }
}

// ══════════════════════════════════════════════════════════════════════════
//  SELECTOR
// ══════════════════════════════════════════════════════════════════════════
var METHOD_NAMES = { 0: 'raw', 1: 'bytediff', 2: 'lcs' };
var LCS_MIN_BUDGET_MS = 5;    // below this, running Myers isn't worth the setup
var LCS_SKIP_BELOW = 64;      // if best delta ≤ this many bytes, nothing to gain

// ── internal synchronous core (will call into WASM in the future) ──
function tryEncodeSync(baseInput, targetInput, options) {
  var base = toU8(baseInput), target = toU8(targetInput);
  if (typeof options === 'string') options = { method: options };
  options = options || {};
  var minRatio = (typeof options.minRatio === 'number') ? options.minRatio : 1.0;
  var method = options.method || 'auto';
  var strict = options.strict === true;
  var win = (typeof options.window === 'number') ? options.window : DEFAULT_WINDOW;
  var lcsMs = (typeof options.lcsMs === 'number') ? options.lcsMs : 1000;
  var exhaustive = options.exhaustive === true;

  if (method !== 'auto' && method !== 'bytediff' && method !== 'lcs' && method !== 'raw') {
    throw new TypeError("compact-delta: method must be 'auto', 'bytediff', 'lcs', or 'raw'");
  }
  if (win < 4 || win > 1024) {
    throw new TypeError('compact-delta: window must be between 4 and 1024');
  }

  var tag, payload, candidates = null;

  // NOTE: the identical shortcut emits 3 bytes (tag+op+varint), which would
  // exceed the RAW floor (target.length+1) for targets shorter than 2 bytes —
  // those fall through to the general path. (This was a bug in the original:
  // encode('', '') produced 3 bytes, violating the documented bound.)
  if (method === 'auto' && target.length >= 2 && bytesEqual(base, target)) {
    var we = new Writer();
    we.byte(LCS_EQUAL); we.varint(base.length);
    tag = M_LCS; payload = we.finish();
  } else if (method === 'auto' && base.length === 0) {
    tag = M_RAW; payload = target;
  } else if (method === 'raw') {
    tag = M_RAW; payload = target;
  } else if (method === 'bytediff' || method === 'lcs') {
    payload = (method === 'bytediff') ? bytediffEncode(base, target, win) : lcsEncode(base, target, lcsMs);
    tag = (method === 'bytediff') ? M_BYTEDIFF : M_LCS;
    if (!strict && payload.length >= target.length) { tag = M_RAW; payload = target; }
  } else {
    // ── auto: bytediff first (fast, linear), then LCS with a budget
    //    proportional to the possible gain ──
    var bd = bytediffEncode(base, target, win);
    tag = M_RAW; payload = target;
    if (bd.length < payload.length) { tag = M_BYTEDIFF; payload = bd; }

    candidates = { raw: 1 + target.length, bytediff: 1 + bd.length };

    // How much could LCS still save us? If the best delta so far is already
    // a tiny fraction of the target, Myers' possible win is a few bytes —
    // don't spend milliseconds hunting them. If nothing has worked so far
    // (ratio ≈ 1), LCS is the last hope — give it the full budget.
    var bestRatio = target.length ? payload.length / target.length : 0;
    var budget = exhaustive ? lcsMs : Math.min(lcsMs, lcsMs * bestRatio);
    var runLcs = exhaustive ||
      (budget >= LCS_MIN_BUDGET_MS && payload.length > LCS_SKIP_BELOW);

    if (runLcs) {
      var lcs = lcsEncode(base, target, budget);
      candidates.lcs = 1 + lcs.length;
      if (lcs.length < payload.length) { tag = M_LCS; payload = lcs; }
    }
  }

  var deltaBytes = prepend(tag, payload);
  var worthwhile = (tag !== M_RAW) && (deltaBytes.length < minRatio * target.length);

  return {
    method: METHOD_NAMES[tag],
    delta: deltaBytes,
    worthwhile: worthwhile,
    size: deltaBytes.length,
    raw: target.length,
    ratio: target.length ? deltaBytes.length / target.length : 0,
    candidates: candidates
  };
}

// ── async delivery helper ──────────────────────────────────────────────────
var schedule = (typeof queueMicrotask === 'function')
  ? queueMicrotask
  : function (fn) { Promise.resolve().then(fn); };

function runAsync(cb, work) {
  if (typeof cb !== 'function') {
    throw new TypeError('compact-delta: a callback function is required as the last argument');
  }
  schedule(function () {
    var err = null, result;
    try { result = work(); } catch (e) { err = e; }
    cb(err, result);
  });
}

function splitOptsCb(opt, cb) {
  if (typeof opt === 'function') { return { options: undefined, cb: opt }; }
  return { options: opt, cb: cb };
}

// ── public callback API ──────────────────────────────────────────────────────

function encode(base, target, opt, cb) {
  var a = splitOptsCb(opt, cb);
  runAsync(a.cb, function () { return tryEncodeSync(base, target, a.options).delta; });
}

function tryEncode(base, target, opt, cb) {
  var a = splitOptsCb(opt, cb);
  runAsync(a.cb, function () { return tryEncodeSync(base, target, a.options); });
}

function decode(base, delta, cb) {
  runAsync(cb, function () { return decodeSync(base, delta); });
}

function encodeString(base, target, opt, cb) {
  var a = splitOptsCb(opt, cb);
  runAsync(a.cb, function () {
    if (typeof base !== 'string' || typeof target !== 'string') {
      throw new TypeError('compact-delta: encodeString expects string arguments (use encode for bytes)');
    }
    return tryEncodeSync(utf8Encode(base), utf8Encode(target), a.options).delta;
  });
}

function decodeString(base, delta, cb) {
  runAsync(cb, function () {
    if (typeof base !== 'string') {
      throw new TypeError('compact-delta: decodeString expects a string base (use decode for bytes)');
    }
    return utf8Decode(decodeSync(utf8Encode(base), delta));
  });
}

function inspect(base, target, cb) {
  runAsync(cb, function () { return inspectSync(base, target); });
}

// ── synchronous, side-effect-free helpers (never touch WASM) stay sync ──

function isRaw(deltaInput) {
  var d = toU8(deltaInput);
  return d.length > 0 && d[0] === M_RAW;
}

function prepend(tag, payload) {
  var out = new Uint8Array(payload.length + 1);
  out[0] = tag;
  out.set(payload, 1);
  return out;
}

function decodeSync(baseInput, deltaInput) {
  var base = toU8(baseInput), delta = toU8(deltaInput);
  if (delta.length === 0) throw new Error('compact-delta: empty input');
  var tag = delta[0];
  var r = new Reader(delta); r.pos = 1;
  var out = new Writer();
  if (tag === M_RAW) out.bytes(delta, 1, delta.length - 1);
  else if (tag === M_BYTEDIFF) bytediffDecode(base, r, out);
  else if (tag === M_LCS) lcsDecode(base, r, out);
  else throw new Error('compact-delta: unknown method tag 0x' + tag.toString(16));
  return out.finish();
}

// ── diagnostics ── one pass: reuse the candidates computed by the selector,
// and force-run whatever the adaptive policy skipped (inspect is exhaustive
// by definition — it exists to show the full comparison).
function inspectSync(baseInput, targetInput) {
  var base = toU8(baseInput), target = toU8(targetInput);
  var r = tryEncodeSync(base, target, { exhaustive: true });
  var cands = r.candidates;
  if (!cands) { // short-circuit paths (identical / empty base)
    cands = { raw: 1 + target.length };
    if (base.length > 0) {
      cands.bytediff = 1 + bytediffEncode(base, target, DEFAULT_WINDOW).length;
      cands.lcs = 1 + lcsEncode(base, target, 1000).length;
    }
  }
  return {
    method: r.method,
    size: r.size,
    raw: r.raw,
    ratio: r.ratio,
    candidates: cands
  };
}

// ── Public API ──
export {
  encode,
  tryEncode,
  isRaw,
  decode,
  encodeString,
  decodeString,
  inspect
};

export const METHODS = { RAW: M_RAW, BYTEDIFF: M_BYTEDIFF, LCS: M_LCS };

export default {
  encode, tryEncode, isRaw, decode, encodeString, decodeString, inspect, METHODS
};
