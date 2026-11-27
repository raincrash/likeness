// Minimal OSC 1.0 encoder/decoder (no dependencies). Enough for the VMC protocol:
// int32 ("i"), float32 ("f") and string ("s") arguments, messages and bundles.
// Spec: https://opensoundcontrol.stanford.edu/spec-1_0.html

/** Wraps a number so it is encoded as an OSC int32 ("i"). Plain numbers encode as float32 ("f"). */
export const int = (value) => ({ type: "i", value });
/** Wraps a number so it is encoded as an OSC float32 ("f"). */
export const float = (value) => ({ type: "f", value });

/** "Immediately" time tag (NTP 0x00000000_00000001). */
export const IMMEDIATE = 1n;

const pad4 = (n) => (n + 3) & ~3;

/** OSC-string: UTF-8 bytes, a NUL terminator, then NULs up to a multiple of 4. */
export function encodeString(s) {
  const bytes = Buffer.from(String(s), "utf8");
  const out = Buffer.alloc(pad4(bytes.length + 1)); // zero-filled, so the padding is NULs
  bytes.copy(out);
  return out;
}

function normaliseArg(a) {
  if (a !== null && typeof a === "object" && "type" in a) return a;
  if (typeof a === "string") return { type: "s", value: a };
  if (typeof a === "number") return { type: "f", value: a };
  throw new TypeError(`unsupported OSC argument: ${a}`);
}

/** Encodes one OSC message. `args` are strings, numbers (float32), or int()/float() wrappers. */
export function encodeMessage(address, args = []) {
  if (typeof address !== "string" || !address.startsWith("/")) throw new TypeError(`bad OSC address: ${address}`);
  const typed = args.map(normaliseArg);
  const parts = [encodeString(address), encodeString("," + typed.map((a) => a.type).join(""))];
  for (const a of typed) {
    if (a.type === "s") parts.push(encodeString(a.value));
    else if (a.type === "f") {
      const b = Buffer.alloc(4);
      b.writeFloatBE(a.value);
      parts.push(b);
    } else if (a.type === "i") {
      const b = Buffer.alloc(4);
      b.writeInt32BE(a.value | 0);
      parts.push(b);
    } else throw new TypeError(`unsupported OSC type tag: ${a.type}`);
  }
  return Buffer.concat(parts);
}

/** Encodes a bundle of already-encoded elements (messages or nested bundles). */
export function encodeBundle(elements, timetag = IMMEDIATE) {
  const head = Buffer.alloc(16);
  head.write("#bundle\0", 0, "ascii");
  head.writeBigUInt64BE(BigInt(timetag), 8);
  const parts = [head];
  for (const e of elements) {
    const size = Buffer.alloc(4);
    size.writeInt32BE(e.length);
    parts.push(size, e);
  }
  return Buffer.concat(parts);
}

/**
 * Packs messages into as few bundles as possible, each at most `maxBytes` (the VMC spec asks for
 * packets of roughly 1500 bytes). Order is preserved, so a trailing /VMC/Ext/Blend/Apply stays last.
 */
export function packBundles(encodedMessages, maxBytes = 1500) {
  const out = [];
  let cur = [];
  let size = 16;
  for (const m of encodedMessages) {
    const add = 4 + m.length;
    if (cur.length && size + add > maxBytes) {
      out.push(encodeBundle(cur));
      cur = [];
      size = 16;
    }
    cur.push(m);
    size += add;
  }
  if (cur.length) out.push(encodeBundle(cur));
  return out;
}

function readString(buf, off) {
  let end = off;
  while (end < buf.length && buf[end] !== 0) end++;
  if (end >= buf.length) throw new RangeError("unterminated OSC string");
  return [buf.toString("utf8", off, end), pad4(end + 1)];
}

/**
 * Decodes a packet into a flat list of messages: [{ address, types, args }].
 * Bundles are flattened in order. Supports i, f, s, and the argument-less T/F/N/I tags.
 */
export function decodePacket(buf, out = []) {
  if (buf.length >= 8 && buf.toString("ascii", 0, 8) === "#bundle\0") {
    let off = 16;
    while (off < buf.length) {
      const n = buf.readInt32BE(off);
      off += 4;
      if (n < 0 || off + n > buf.length) throw new RangeError("bad OSC bundle element size");
      decodePacket(buf.subarray(off, off + n), out);
      off += n;
    }
    return out;
  }
  let [address, off] = readString(buf, 0);
  let types = "";
  if (off < buf.length) {
    [types, off] = readString(buf, off);
    if (!types.startsWith(",")) throw new RangeError("missing OSC type tag string");
    types = types.slice(1);
  }
  const args = [];
  for (const t of types) {
    if (t === "i") { args.push(buf.readInt32BE(off)); off += 4; }
    else if (t === "f") { args.push(buf.readFloatBE(off)); off += 4; }
    else if (t === "s") { const [s, next] = readString(buf, off); args.push(s); off = next; }
    else if (t === "T") args.push(true);
    else if (t === "F") args.push(false);
    else if (t === "N" || t === "I") args.push(null);
    else throw new RangeError(`unsupported OSC type tag: ${t}`);
  }
  out.push({ address, types, args });
  return out;
}
