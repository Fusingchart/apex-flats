const { test } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const vm = require('node:vm');
const path = require('node:path');

test('Blender normals survive binding and repair, but update when the body dents', () => {
  class Attribute {
    constructor(array, size) { this.array = array; this.count = array.length / size; }
    setUsage() { return this; }
  }
  const context = { window: {}, THREE: { BufferAttribute: Attribute, DynamicDrawUsage: 35048 } };
  vm.runInNewContext(fs.readFileSync(path.join(__dirname, '../src/softbody.js'), 'utf8'), context);
  let recalculations = 0, displacement = 0;
  const authored = new Float32Array([0, 0.6, 0.8]);
  const geometry = {
    attributes: { position: new Attribute(new Float32Array([0.1, 0.2, 0.3]), 3), normal: new Attribute(authored.slice(), 3) },
    setAttribute(key, value) { this.attributes[key] = value; },
    computeVertexNormals() { recalculations++; this.attributes.normal.array.set([0, 1, 0]); },
    computeBoundingSphere() {},
  };
  const body = { cell: () => 0, _tri: (base, x, y, z, result) => result.set([displacement, 0, 0, 0, 0]) };
  const binding = context.window.SoftBody.prototype.bind.call(body, geometry, { wrinkle: 0 });
  const deform = () => context.window.SoftBody.prototype.deform.call(body, binding);
  assert.equal(recalculations, 0);
  deform();
  assert.deepEqual(geometry.attributes.normal.array, authored);
  displacement = 0.1;
  deform();
  assert.equal(recalculations, 1);
  assert.deepEqual(Array.from(geometry.attributes.normal.array), [0, 1, 0]);
  displacement = 0;
  deform();
  assert.deepEqual(geometry.attributes.normal.array, authored);
  assert.equal(recalculations, 1);
});
