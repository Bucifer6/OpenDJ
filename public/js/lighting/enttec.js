// Enttec DMX USB Pro (and compatible) widget framing. Pure, shared by the renderer and the tests.
// Label 6 "Output Only Send DMX Packet Request": 0x7E, 6, len LSB, len MSB, start code 0, 512 slots, 0xE7.
export function encodeEnttecDmx(data) {
  const slots = Math.min(512, data.length);
  const len = slots + 1; // + start code
  const b = new Uint8Array(5 + len);
  b[0] = 0x7e; b[1] = 6; b[2] = len & 0xff; b[3] = len >> 8; b[4] = 0x00;
  b.set(data.subarray(0, slots), 5);
  b[4 + len] = 0xe7;
  return b;
}

export function base64ToBytes(s) {
  const bin = atob(s);
  const out = new Uint8Array(bin.length);
  for (let i = 0; i < bin.length; i++) out[i] = bin.charCodeAt(i);
  return out;
}
