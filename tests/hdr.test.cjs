const { test } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const vm = require('node:vm');

test('HDR sun detection finds the brightest pixel after a bright cloud', async () => {
  const width = 8, height = 4;
  const rows = Array.from({ length: height }, () => Array.from({ length: width }, () => [1, 1, 1, 128]));
  // Row 1 is above the horizon, and is scanned before row 0. Its bright cloud must
  // not cause the later, brighter sun to be skipped by comparing exponent to radiance.
  rows[1][1] = [200, 200, 200, 140];
  rows[0][6] = [250, 250, 250, 144];
  const bytes = [...Buffer.from('#?RADIANCE\nFORMAT=32-bit_rle_rgbe\n\n-Y 4 +X 8\n')];
  for (const row of rows) {
    bytes.push(2, 2, 0, width);
    for (let channel = 0; channel < 4; channel++) bytes.push(width, ...row.map(p => p[channel]));
  }
  class Vector3 {
    constructor(x, y, z) { Object.assign(this, { x, y, z }); }
    normalize() { const n = Math.hypot(this.x, this.y, this.z); this.x /= n; this.y /= n; this.z /= n; return this; }
  }
  const context = { window: {}, THREE: { Vector3, DataTexture: class {} }, fetch: async () => ({ ok: true, arrayBuffer: async () => Uint8Array.from(bytes).buffer }) };
  vm.runInNewContext(fs.readFileSync(require('node:path').join(__dirname, '../src/hdr.js'), 'utf8'), context);
  const result = await context.window.loadHDR('synthetic.hdr');
  const longitude = ((6.5 / width) - 0.5) * Math.PI * 2;
  const latitude = ((3.5 / height) - 0.5) * Math.PI;
  assert.ok(Math.abs(result.sunDir.x - Math.cos(longitude) * Math.cos(latitude)) < 1e-7);
  assert.ok(Math.abs(result.sunDir.y - Math.sin(latitude)) < 1e-7);
  assert.ok(Math.abs(result.sunDir.z - Math.sin(longitude) * Math.cos(latitude)) < 1e-7);
  assert.ok(Number.isFinite(result.gain) && result.gain > 0);
});
