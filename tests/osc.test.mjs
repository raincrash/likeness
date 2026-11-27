// OSC encoder/decoder: byte-exact against known-good packets (the first two are the examples in the
// OSC 1.0 specification, https://opensoundcontrol.stanford.edu/spec-1_0-examples.html).
import { decodePacket, encodeBundle, encodeMessage, encodeString, int, packBundles } from "../bridge/osc.mjs";

let failures = 0;
function check(name, ok, detail = "") {
  console.log(`${ok ? "ok  " : "FAIL"} ${name}${detail ? ` (${detail})` : ""}`);
  if (!ok) failures++;
}
const hex = (b) => Buffer.from(b).toString("hex");
const bytes = (s) => Buffer.from(s.replace(/\s+/g, ""), "hex");
function same(name, got, want) {
  check(name, hex(got) === hex(want), hex(got) === hex(want) ? `${want.length} bytes` : `got ${hex(got)}, want ${hex(want)}`);
}

// 1. Spec example: "/oscillator/4/frequency" ,f 440.0
same("spec: /oscillator/4/frequency 440.0", encodeMessage("/oscillator/4/frequency", [440]), bytes(`
  2f6f7363 696c6c61 746f722f 342f6672 65717565 6e637900
  2c660000
  43dc0000`));

// 2. Spec example: "/foo" ,iisff 1000 -1 "hello" 1.234 5.678
same("spec: /foo 1000 -1 hello 1.234 5.678", encodeMessage("/foo", [int(1000), int(-1), "hello", 1.234, 5.678]), bytes(`
  2f666f6f 00000000
  2c696973 66660000
  000003e8 ffffffff
  68656c6c 6f000000
  3f9df3b6 40b5b22d`));

// 3. String padding: 0..4 mod 4 lengths. A 4-byte string needs 4 NULs (terminator + padding).
same("pad: empty", encodeString(""), bytes("00000000"));
same("pad: 3 chars", encodeString("abc"), bytes("61626300"));
same("pad: 4 chars", encodeString("data"), bytes("64617461 00000000"));
same("pad: 5 chars", encodeString("hello"), bytes("68656c6c 6f000000"));
same("pad: UTF-8", encodeString("é"), bytes("c3a90000"));

// 4. No arguments: the type tag string is just "," padded to 4.
same("/VMC/Ext/Blend/Apply", encodeMessage("/VMC/Ext/Blend/Apply"), bytes(`
  2f564d43 2f457874 2f426c65 6e642f41 70706c79 00000000
  2c000000`));

// 5. A typical VMC message: ,sf with a name whose length is a multiple of 4.
same("/VMC/Ext/Blend/Val JawOpen 0.5", encodeMessage("/VMC/Ext/Blend/Val", ["JawOpen", 0.5]), bytes(`
  2f564d43 2f457874 2f426c65 6e642f56 616c0000
  2c736600
  4a61774f 70656e00
  3f000000`));

// 6. /VMC/Ext/OK with ints.
same("/VMC/Ext/OK 1 3 0 1", encodeMessage("/VMC/Ext/OK", [int(1), int(3), int(0), int(1)]), bytes(`
  2f564d43 2f457874 2f4f4b00
  2c696969 69000000
  00000001 00000003 00000000 00000001`));

// 7. Bundle: "#bundle\0", immediate time tag, then size-prefixed elements.
{
  const msg = encodeMessage("/a", [int(1)]); // 2f610000 2c690000 00000001
  same("bundle", encodeBundle([msg]), bytes(`
    2362756e 646c6500
    00000000 00000001
    0000000c
    2f610000 2c690000 00000001`));
}

// 8. Round trip through the decoder, including bundles.
{
  const m1 = encodeMessage("/foo", [int(1000), int(-1), "hello", 1.234, 5.678]);
  const m2 = encodeMessage("/VMC/Ext/Blend/Apply");
  const msgs = decodePacket(encodeBundle([m1, encodeBundle([m2])]));
  check("decode: bundle flattening", msgs.length === 2 && msgs[0].address === "/foo" && msgs[1].address === "/VMC/Ext/Blend/Apply");
  const a = msgs[0].args;
  check("decode: args", msgs[0].types === "iisff" && a[0] === 1000 && a[1] === -1 && a[2] === "hello" &&
    Math.abs(a[3] - 1.234) < 1e-6 && Math.abs(a[4] - 5.678) < 1e-6, JSON.stringify(a));
}

// 9. Packing respects the size limit and keeps order.
{
  const msgs = Array.from({ length: 100 }, (_, i) => encodeMessage("/VMC/Ext/Blend/Val", ["Shape" + i, i / 100]));
  const packets = packBundles(msgs, 1500);
  const decoded = packets.flatMap((p) => decodePacket(p));
  check("pack: <= 1500 bytes each", packets.every((p) => p.length <= 1500), `${packets.length} packets, max ${Math.max(...packets.map((p) => p.length))}`);
  check("pack: order kept", decoded.length === 100 && decoded.every((m, i) => m.args[0] === "Shape" + i));
}

// 10. Bad input is rejected.
{
  let threw = false;
  try { encodeMessage("no-slash", []); } catch { threw = true; }
  check("reject: address without /", threw);
}

if (failures) {
  console.log(`${failures} OSC test(s) failed`);
  process.exit(1);
}
