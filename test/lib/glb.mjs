// A .glb (as an ArrayBuffer) of the JSON and binary chunk given, each padded to four bytes as the format asks.
export function glb(json, bin = new Uint8Array(0)) {
  const pad = (bytes, fill) => {
    const out = new Uint8Array(Math.ceil(bytes.length / 4) * 4).fill(fill)
    out.set(bytes)
    return out
  }
  const jsonBytes = pad(new TextEncoder().encode(JSON.stringify(json)), 0x20)
  const binBytes = pad(bin, 0)
  const total = 12 + 8 + jsonBytes.length + 8 + binBytes.length
  const out = new Uint8Array(total)
  const view = new DataView(out.buffer)
  view.setUint32(0, 0x46546c67, true)
  view.setUint32(4, 2, true)
  view.setUint32(8, total, true)
  view.setUint32(12, jsonBytes.length, true)
  view.setUint32(16, 0x4e4f534a, true)
  out.set(jsonBytes, 20)
  view.setUint32(20 + jsonBytes.length, binBytes.length, true)
  view.setUint32(24 + jsonBytes.length, 0x004e4942, true)
  out.set(binBytes, 28 + jsonBytes.length)
  return out.buffer
}
