/*
 * build.js — generate dist files from the single ESM source.
 * Pure Node, zero dependencies.
 *
 *   src/compact-delta.js  (ESM, source of truth)
 *        │
 *        ├─→ dist/compact-delta.mjs   (ESM, copied verbatim — for `import`)
 *        └─→ dist/compact-delta.cjs   (UMD — for `require` and browser <script>)
 */
'use strict';
const fs = require('fs');
const path = require('path');

const SRC = path.join(__dirname, 'src', 'compact-delta.js');
const DIST = path.join(__dirname, 'dist');
fs.mkdirSync(DIST, { recursive: true });

let src = fs.readFileSync(SRC, 'utf8');

// 1) ESM build: the source already is ESM — copy it verbatim.
fs.writeFileSync(path.join(DIST, 'compact-delta.mjs'), src);

// 2) UMD build: strip the ESM export statements, capture the public names,
//    and wrap the remaining declarations in a UMD factory.
const headerEnd = src.indexOf('*/') + 2;
const header = src.slice(0, headerEnd);

// Remove everything from the first `// ── Public API ──` marker onward
// (the export blocks), keeping only the implementation body.
const apiMarker = '// ── Public API ──';
const bodyStart = headerEnd;
const bodyEnd = src.indexOf(apiMarker);
let body = src.slice(bodyStart, bodyEnd).trim();

// Indent body by two spaces to live inside the factory function.
const indentedBody = body.split('\n').map(l => (l.length ? '  ' + l : l)).join('\n');

const umd = `${header}
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

${indentedBody}

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
`;

fs.writeFileSync(path.join(DIST, 'compact-delta.cjs'), umd);
// 3) The same UMD under the .umd.js name — this is what the README's
//    <script src="./dist/compact-delta.umd.js"> and the playground load.
fs.writeFileSync(path.join(DIST, 'compact-delta.umd.js'), umd);

console.log('Built:');
console.log('  dist/compact-delta.mjs     (ESM)  ', fs.statSync(path.join(DIST,'compact-delta.mjs')).size, 'bytes');
console.log('  dist/compact-delta.cjs     (UMD)  ', fs.statSync(path.join(DIST,'compact-delta.cjs')).size, 'bytes');
console.log('  dist/compact-delta.umd.js  (UMD)  ', fs.statSync(path.join(DIST,'compact-delta.umd.js')).size, 'bytes');
