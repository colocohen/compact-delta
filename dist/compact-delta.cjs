/*
 * compact-delta — generic optimal binary delta compression
 *
 * Given an old "base" and a new "target", produce the smallest possible
 * binary delta to send to a peer who already has the base. The peer calls
 * decode(base, delta) to reconstruct the target exactly.
 *
 * It is content-agnostic (works on any bytes), reversible, and self-describing:
 * the first byte of every delta is a method tag, so the decoder always knows
 * how to read it — and old decoders keep working when new methods are added.
 *
 * Strategy: run every applicable delta method, measure, emit the smallest.
 * Cheap short-circuits (identical / empty / tiny target) skip work up front.
 * This is "optimal-in-practice": the smallest delta among proven methods,
 * chosen at runtime, independent of the kind of edit that was made.
 *
 *   Methods (and what each is strong at):
 *     0x00 RAW       full target verbatim          — safety floor (huge edits)
 *     0x01 BYTEDIFF  copy/insert via rolling hash   — moves, copy/paste, repeats
 *     0x02 LCS       Myers diff, binary-encoded     — in-place substitutions
 *
 * Public API:
 *     compactDelta.encode(base, target)        -> Uint8Array
 *     compactDelta.decode(base, deltaBytes)    -> Uint8Array
 *     compactDelta.encodeString(base, target)  -> Uint8Array
 *     compactDelta.decodeString(base, delta)   -> string
 *     compactDelta.tryEncode(base, target)     -> { method, delta, worthwhile, ... }
 *     compactDelta.inspect(base, target)       -> { method, size, raw, ratio, candidates }
 *
 * License: Apache-2.0
 */
(function (root, factory) {
  if (typeof module === 'object' && module.exports) {
    module.exports = factory();          // CommonJS / Node require()
  } else if (typeof define === 'function' && define.amd) {
    define([], factory);                 // AMD
  } else {
    root.compactDelta = factory();       // browser global
  }
}(typeof self !== 'undefined' ? self : this, function () {
  'use strict';

  // ══ Method tags ════════════════════════════════════════════════════════════
  var M_RAW = 0x00;
  var M_BYTEDIFF = 0x01;
  var M_LCS = 0x02;

  // ══ Bytes <-> string ═══════════════════════════════════════════════════════
  function utf8Encode(s) {
    if (typeof TextEncoder !== 'undefined') return new TextEncoder().encode(s);
    return new Uint8Array(Buffer.from(s, 'utf8'));
  }
  function utf8Decode(u8) {
    if (typeof TextDecoder !== 'undefined') return new TextDecoder().decode(u8);
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
  Reader.prototype.byte = function () { return this.u8[this.pos++]; };
  Reader.prototype.varint = function () {
    var r = 0, sh = 0, b;
    do { b = this.u8[this.pos++]; r |= (b & 0x7f) << sh; sh += 7; } while (b & 0x80);
    return r >>> 0;
  };
  Reader.prototype.eof = function () { return this.pos >= this.u8.length; };

  // ══════════════════════════════════════════════════════════════════════════
  //  METHOD 0x01 — BYTEDIFF (copy/insert, Rabin-Karp rolling hash)
  // ══════════════════════════════════════════════════════════════════════════
  var WINDOW = 16;
  var RK_BASE = 257;
  var RK_POW = (function () { var p = 1; for (var i = 0; i < WINDOW - 1; i++) p = Math.imul(p, RK_BASE) >>> 0; return p >>> 0; })();
  var OP_COPY = 0, OP_INSERT = 1;

  function buildAnchors(base) {
    var anchors = Object.create(null);
    if (base.length < WINDOW) return anchors;
    var h = 0, i;
    for (i = 0; i < WINDOW; i++) h = (Math.imul(h, RK_BASE) + base[i]) >>> 0;
    pushAnchor(anchors, h, 0);
    for (var off = 1; off + WINDOW <= base.length; off++) {
      var leaving = base[off - 1], entering = base[off + WINDOW - 1];
      h = (Math.imul((h - Math.imul(leaving, RK_POW)) >>> 0, RK_BASE) + entering) >>> 0;
      pushAnchor(anchors, h, off);
    }
    return anchors;
  }
  function pushAnchor(anchors, h, off) {
    var list = anchors[h];
    if (list === undefined) anchors[h] = off;
    else if (typeof list === 'number') anchors[h] = [list, off];
    else if (list.length < 32) list.push(off);
  }
  function anchorOffsets(anchors, h) {
    var list = anchors[h];
    if (list === undefined) return null;
    return (typeof list === 'number') ? [list] : list;
  }
  function matchLength(base, baseOff, target, targetOff) {
    var n = 0;
    if (Math.min(base.length - baseOff, target.length - targetOff) < WINDOW) return 0;
    for (; n < WINDOW; n++) if (base[baseOff + n] !== target[targetOff + n]) return 0;
    var bLen = base.length, tLen = target.length;
    while (baseOff + n < bLen && targetOff + n < tLen && base[baseOff + n] === target[targetOff + n]) n++;
    return n;
  }

  function bytediffEncode(base, target) {
    var anchors = buildAnchors(base);
    var w = new Writer();
    var tLen = target.length, i = 0, pendingStart = 0, h = 0, primed = false;

    function flush(upTo) {
      if (upTo > pendingStart) {
        w.byte(OP_INSERT);
        var len = upTo - pendingStart;
        w.varint(len);
        w.bytes(target, pendingStart, len);
      }
    }

    while (i < tLen) {
      if (i + WINDOW <= tLen) {
        if (!primed) {
          h = 0;
          for (var k = 0; k < WINDOW; k++) h = (Math.imul(h, RK_BASE) + target[i + k]) >>> 0;
          primed = true;
        }
        var offsets = anchorOffsets(anchors, h), best = 0, bestOff = -1;
        if (offsets) for (var oi = 0; oi < offsets.length; oi++) {
          var ml = matchLength(base, offsets[oi], target, i);
          if (ml > best) { best = ml; bestOff = offsets[oi]; }
        }
        if (best >= WINDOW) {
          flush(i);
          w.byte(OP_COPY); w.varint(bestOff); w.varint(best);
          i += best; pendingStart = i; primed = false; continue;
        }
        var leaving = target[i];
        if (i + WINDOW < tLen) {
          var entering = target[i + WINDOW];
          h = (Math.imul((h - Math.imul(leaving, RK_POW)) >>> 0, RK_BASE) + entering) >>> 0;
        } else primed = false;
        i++;
      } else i++;
    }
    flush(tLen);
    return w.finish();
  }

  function bytediffDecode(base, r, out) {
    while (!r.eof()) {
      var op = r.byte();
      if (op === OP_COPY) { var off = r.varint(), len = r.varint(); out.bytes(base, off, len); }
      else if (op === OP_INSERT) { var ilen = r.varint(); out.bytes(r.u8, r.pos, ilen); r.pos += ilen; }
      else throw new Error('delta: corrupt bytediff op ' + op);
    }
  }

  // ══════════════════════════════════════════════════════════════════════════
  //  METHOD 0x02 — LCS (Myers diff) with compact binary encoding
  // ══════════════════════════════════════════════════════════════════════════
  // We run Myers on the two byte arrays (mapped to a string of code units so the
  // classic char-based implementation works), producing a list of
  // [op, slice] where op ∈ {EQUAL, INSERT, DELETE}. We then encode it as:
  //   EQUAL(len)   -> tag 0, varint len            (copy len bytes from base)
  //   INSERT(len)  -> tag 1, varint len, len bytes  (literal new bytes)
  //   DELETE(len)  -> tag 2, varint len             (skip len bytes of base)
  // The decoder walks base and delta in lockstep.
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
    var v1 = new Array(vl), v2 = new Array(vl), x;
    for (x = 0; x < vl; x++) { v1[x] = -1; v2[x] = -1; }
    v1[vo + 1] = 0; v2[vo + 1] = 0;
    var delta = n - m, front = (delta % 2 !== 0);
    for (var d = 0; d < max; d++) {
      if (Date.now() > deadline) break;
      for (var k1 = -d; k1 <= d; k1 += 2) {
        var k1o = vo + k1, x1;
        if (k1 === -d || (k1 !== d && v1[k1o - 1] < v1[k1o + 1])) x1 = v1[k1o + 1]; else x1 = v1[k1o - 1] + 1;
        var y1 = x1 - k1;
        while (x1 < n && y1 < m && a[x1] === b[y1]) { x1++; y1++; }
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
        while (x2 < n && y2 < m && a[n - x2 - 1] === b[m - y2 - 1]) { x2++; y2++; }
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
          // upon reaching an equality, merge the accumulated delete+insert run
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

  // Map bytes <-> a JS string of char codes so Myers (char-based) operates on
  // byte identity. Each byte 0..255 becomes one UTF-16 code unit 0..255.
  function bytesToLatin1(u8) {
    var CHUNK = 0x8000, parts = [];
    for (var i = 0; i < u8.length; i += CHUNK) parts.push(String.fromCharCode.apply(null, u8.subarray(i, i + CHUNK)));
    return parts.join('');
  }

  var LCS_EQUAL = 0, LCS_INSERT = 1, LCS_DELETE = 2;

  function lcsEncode(base, target) {
    var diffs = myersDiff(bytesToLatin1(base), bytesToLatin1(target));
    var w = new Writer();
    for (var i = 0; i < diffs.length; i++) {
      var op = diffs[i][0], s = diffs[i][1], len = s.length;
      if (op === DIFF_EQUAL) { w.byte(LCS_EQUAL); w.varint(len); }
      else if (op === DIFF_DELETE) { w.byte(LCS_DELETE); w.varint(len); }
      else { // INSERT — write literal bytes (low byte of each code unit)
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
      if (op === LCS_EQUAL) { out.bytes(base, basePos, len); basePos += len; }
      else if (op === LCS_DELETE) { basePos += len; }
      else if (op === LCS_INSERT) { out.bytes(r.u8, r.pos, len); r.pos += len; }
      else throw new Error('delta: corrupt lcs op ' + op);
    }
  }

  // ══════════════════════════════════════════════════════════════════════════
  //  SELECTOR
  // ══════════════════════════════════════════════════════════════════════════
  // Build all applicable candidates, return the smallest, tagged.
  function buildCandidates(base, target) {
    var cands = {};
    // RAW is always available — the safety floor.
    cands.raw = 1 + target.length;
    // BYTEDIFF and LCS only make sense if there's a base to copy from.
    if (base.length > 0) {
      cands.bytediff = 1 + bytediffEncode(base, target).length;
      cands.lcs = 1 + lcsEncode(base, target).length;
    }
    return cands;
  }

  var METHOD_NAMES = { 0: 'raw', 1: 'bytediff', 2: 'lcs' };

  // Core: choose the best method and return a full result object.
  // `options.minRatio` (default 1.0): the delta is only "worthwhile" if it is
  //   strictly smaller than minRatio * target.length. With the default, any
  //   real saving counts; set e.g. 0.9 to require at least a 10% reduction.
  function tryEncode(baseInput, targetInput, options) {
    var base = toU8(baseInput), target = toU8(targetInput);
    options = options || {};
    var minRatio = (typeof options.minRatio === 'number') ? options.minRatio : 1.0;

    var tag, payload;

    // ── cheap short-circuits (certainties, not guesses) ──
    if (bytesEqual(base, target)) {
      var we = new Writer();
      we.byte(LCS_EQUAL); we.varint(base.length);
      tag = M_LCS; payload = we.finish();
    } else if (base.length === 0) {
      // nothing to copy from — raw is the only sensible choice
      tag = M_RAW; payload = target;
    } else {
      // ── try the real methods, pick the smallest ──
      var bd = bytediffEncode(base, target);
      var lcs = lcsEncode(base, target);
      tag = M_RAW; payload = target;
      if (bd.length < payload.length) { tag = M_BYTEDIFF; payload = bd; }
      if (lcs.length < payload.length) { tag = M_LCS; payload = lcs; }
    }

    var deltaBytes = prepend(tag, payload);
    // "worthwhile" = a delta method beat RAW by enough to be worth sending as a delta.
    var worthwhile = (tag !== M_RAW) && (deltaBytes.length < minRatio * target.length);

    return {
      method: METHOD_NAMES[tag],
      delta: deltaBytes,
      worthwhile: worthwhile,
      size: deltaBytes.length,
      raw: target.length,
      ratio: target.length ? deltaBytes.length / target.length : 0
    };
  }

  // Simple form: always returns a valid, decodable Uint8Array.
  function encode(baseInput, targetInput) {
    return tryEncode(baseInput, targetInput).delta;
  }

  // Was a given encoded delta produced by the RAW (no-delta) method?
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

  function decode(baseInput, deltaInput) {
    var base = toU8(baseInput), delta = toU8(deltaInput);
    if (delta.length === 0) throw new Error('delta: empty input');
    var tag = delta[0];
    var r = new Reader(delta); r.pos = 1;
    var out = new Writer();
    if (tag === M_RAW) out.bytes(delta, 1, delta.length - 1);
    else if (tag === M_BYTEDIFF) bytediffDecode(base, r, out);
    else if (tag === M_LCS) lcsDecode(base, r, out);
    else throw new Error('delta: unknown method tag 0x' + tag.toString(16));
    return out.finish();
  }

  // ── string conveniences ──
  function encodeString(baseStr, targetStr) { return encode(utf8Encode(baseStr), utf8Encode(targetStr)); }
  function decodeString(baseStr, delta) { return utf8Decode(decode(utf8Encode(baseStr), delta)); }

  // ── diagnostics ──
  function inspect(baseInput, targetInput) {
    var base = toU8(baseInput), target = toU8(targetInput);
    var cands = buildCandidates(base, target);
    var best = encode(base, target);
    var names = { 0: 'raw', 1: 'bytediff', 2: 'lcs' };
    return {
      method: names[best[0]],
      size: best.length,
      raw: target.length,
      ratio: target.length ? best.length / target.length : 0,
      candidates: cands
    };
  }

  var METHODS = { RAW: M_RAW, BYTEDIFF: M_BYTEDIFF, LCS: M_LCS };

  return {
    encode: encode,
    tryEncode: tryEncode,
    isRaw: isRaw,
    decode: decode,
    encodeString: encodeString,
    decodeString: decodeString,
    inspect: inspect,
    METHODS: METHODS
  };
}));
