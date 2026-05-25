/**
 * compact-delta — generic optimal binary delta compression.
 *
 * Produces the smallest binary delta among several methods (copy/insert,
 * Myers LCS, raw), chosen automatically at runtime. Content-agnostic,
 * reversible, and self-describing (a 1-byte method tag prefixes every delta).
 */

/** Accepted input: raw bytes or a UTF-8 string. */
export type Bytes = Uint8Array | string;

/** Numeric method tags written as the first byte of every delta. */
export interface MethodTags {
  /** 0x00 — full target verbatim (safety floor). */
  readonly RAW: 0;
  /** 0x01 — copy/insert via rolling hash. */
  readonly BYTEDIFF: 1;
  /** 0x02 — Myers diff, binary-encoded. */
  readonly LCS: 2;
}

/** Human-readable winning method name. */
export type MethodName = 'raw' | 'bytediff' | 'lcs';

/** A method that can be forced; 'auto' (the default) runs the selector. */
export type ForcedMethod = 'auto' | 'bytediff' | 'lcs' | 'raw';

/** Options for {@link encode} and {@link tryEncode}. */
export interface EncodeOptions {
  /**
   * Force a specific method instead of the automatic selector.
   * Default `'auto'` — try every method and pick the smallest.
   * Set e.g. `'bytediff'` to skip the others when you know it always wins
   * for your data (saves the cost of running the unused method).
   */
  method?: ForcedMethod;
  /**
   * When a method is forced, by default the encoder still falls back to RAW
   * if the forced delta would be larger than the full target (a cheap length
   * check — no extra algorithm runs). Set `strict: true` to send the forced
   * method's output verbatim, even if it is larger than RAW. Ignored when
   * `method` is `'auto'`.
   */
  strict?: boolean;
  /**
   * The result is only marked `worthwhile` if its size is strictly less than
   * `minRatio * target.length`. Default `1.0` (any real saving counts).
   * Set e.g. `0.9` to require at least a 10% reduction.
   */
  minRatio?: number;
}

/** @deprecated Renamed to {@link EncodeOptions}; kept as an alias. */
export type TryEncodeOptions = EncodeOptions;

/**
 * The optional third argument to {@link encode}/{@link tryEncode}: either a
 * method name as a shorthand, or a full options object.
 */
export type EncodeArg = ForcedMethod | EncodeOptions;

/** Full result returned by {@link tryEncode}. */
export interface EncodeResult {
  /** Which method produced the delta. */
  method: MethodName;
  /** The encoded delta (method tag + payload). Always valid for {@link decode}. */
  delta: Uint8Array;
  /** `false` when RAW won — i.e. no delta method beat sending the full target. */
  worthwhile: boolean;
  /** Size of `delta` in bytes (including the 1-byte tag). */
  size: number;
  /** Size of the full target in bytes. */
  raw: number;
  /** `size / raw` (0 when target is empty). */
  ratio: number;
}

/** Diagnostic breakdown returned by {@link inspect}. */
export interface InspectResult {
  /** Which method won. */
  method: MethodName;
  /** Size of the chosen delta in bytes. */
  size: number;
  /** Size of the full target in bytes. */
  raw: number;
  /** `size / raw`. */
  ratio: number;
  /** Size each candidate method would produce (including its tag). */
  candidates: {
    raw: number;
    bytediff?: number;
    lcs?: number;
  };
}

/**
 * Node-style callback: `error` first (null on success), result second.
 * All async operations deliver their result this way and always fire
 * asynchronously (on a microtask), exactly once.
 */
export type Callback<T> = (error: Error | null, result?: T) => void;

/**
 * Encode the smallest delta transforming `base` into `target`.
 * Delivers a valid, decodable Uint8Array to the callback.
 *
 * Pass a method name (`'bytediff'`) or options object before the callback to
 * override the automatic selector — e.g. `encode(a, b, 'bytediff', cb)`.
 */
export function encode(base: Bytes, target: Bytes, callback: Callback<Uint8Array>): void;
export function encode(base: Bytes, target: Bytes, options: EncodeArg, callback: Callback<Uint8Array>): void;

/**
 * Like {@link encode}, but delivers the chosen method and a `worthwhile` flag
 * so the caller can decide whether the delta is worth sending.
 */
export function tryEncode(base: Bytes, target: Bytes, callback: Callback<EncodeResult>): void;
export function tryEncode(base: Bytes, target: Bytes, options: EncodeArg, callback: Callback<EncodeResult>): void;

/** Reconstruct the target from `base` and a previously encoded `delta`. */
export function decode(base: Bytes, delta: Bytes, callback: Callback<Uint8Array>): void;

/** String convenience: `encode` taking/returning via UTF-8. */
export function encodeString(base: string, target: string, callback: Callback<Uint8Array>): void;
export function encodeString(base: string, target: string, options: EncodeArg, callback: Callback<Uint8Array>): void;

/** String convenience: `decode` returning a UTF-8 string. */
export function decodeString(base: string, delta: Bytes, callback: Callback<string>): void;

/** Diagnostics: which method wins and what each candidate would cost. */
export function inspect(base: Bytes, target: Bytes, callback: Callback<InspectResult>): void;

/**
 * Synchronous helper: was a given encoded delta produced by the RAW
 * (no-delta) method? Reads only the method tag — never touches the codec.
 */
export function isRaw(delta: Bytes): boolean;

/** Numeric method tags. */
export const METHODS: MethodTags;

declare const compactDelta: {
  encode: typeof encode;
  tryEncode: typeof tryEncode;
  decode: typeof decode;
  encodeString: typeof encodeString;
  decodeString: typeof decodeString;
  isRaw: typeof isRaw;
  inspect: typeof inspect;
  METHODS: MethodTags;
};

export default compactDelta;
