/** A small binary glTF for tests: one triangle, or a document of one's own with an optional BIN chunk. */

const pad = (data: Buffer, fill: number) => Buffer.concat([data, Buffer.alloc((4 - (data.length % 4)) % 4, fill)]);

export function makeGlb(doc?: object, bin?: Buffer): Buffer {
  const triangle = Buffer.from(new Float32Array([0, 0, 0, 1, 0, 0, 0, 1, 0]).buffer);
  const body = doc ?? {
    asset: { version: '2.0', generator: 'polycap tests' },
    buffers: [{ byteLength: triangle.length }],
    bufferViews: [{ buffer: 0, byteOffset: 0, byteLength: triangle.length }],
    accessors: [{ bufferView: 0, componentType: 5126, count: 3, type: 'VEC3', min: [0, 0, 0], max: [1, 1, 0] }],
    meshes: [{ primitives: [{ attributes: { POSITION: 0 } }] }],
    nodes: [{ mesh: 0 }], scenes: [{ nodes: [0] }], scene: 0,
  };
  const json = pad(Buffer.from(JSON.stringify(body)), 0x20);
  const binary = doc ? bin : triangle;
  const chunks = [chunk(json, 0x4e4f534a), ...(binary ? [chunk(pad(binary, 0), 0x004e4942)] : [])];
  const header = Buffer.alloc(12);
  header.writeUInt32LE(0x46546c67, 0); header.writeUInt32LE(2, 4);
  header.writeUInt32LE(12 + chunks.reduce((n, c) => n + c.length, 0), 8);
  return Buffer.concat([header, ...chunks]);
}

function chunk(data: Buffer, type: number): Buffer {
  const head = Buffer.alloc(8);
  head.writeUInt32LE(data.length, 0); head.writeUInt32LE(type, 4);
  return Buffer.concat([head, data]);
}

/**
 * A unit cube with a different colour on each face, normals and one material: something to turn and zoom
 * in the viewer. `npx tsx tests/helpers/glb.ts out.glb` writes one.
 */
export function makeCube(): Buffer {
  const faces: [number[], number[], number[]][] = [ // normal, then two edges, per face
    [[1, 0, 0], [0, 1, 0], [0, 0, 1]], [[-1, 0, 0], [0, 0, 1], [0, 1, 0]],
    [[0, 1, 0], [0, 0, 1], [1, 0, 0]], [[0, -1, 0], [1, 0, 0], [0, 0, 1]],
    [[0, 0, 1], [1, 0, 0], [0, 1, 0]], [[0, 0, -1], [0, 1, 0], [1, 0, 0]],
  ];
  const colours = [[0.85, 0.23, 0.17], [0.94, 0.66, 0.19], [0.47, 0.75, 0.43], [0.55, 0.71, 0.86], [0.94, 0.9, 0.82], [0.4, 0.3, 0.25]];
  const positions: number[] = [], normals: number[] = [], colour: number[] = [], indices: number[] = [];
  faces.forEach(([n, u, v], f) => {
    const base = positions.length / 3;
    for (const [a, b] of [[-1, -1], [1, -1], [1, 1], [-1, 1]]) {
      for (let i = 0; i < 3; i++) positions.push((n[i] + a * u[i] + b * v[i]) * 0.5);
      normals.push(...n); colour.push(...colours[f], 1);
    }
    indices.push(base, base + 1, base + 2, base, base + 2, base + 3);
  });
  const parts = [new Float32Array(positions), new Float32Array(normals), new Float32Array(colour), new Uint16Array(indices)].map(a => Buffer.from(a.buffer));
  let offset = 0;
  const views = parts.map(p => { const view = { buffer: 0, byteOffset: offset, byteLength: p.length }; offset += p.length; return view; });
  const bin = Buffer.concat(parts);
  return makeGlb({
    asset: { version: '2.0', generator: 'polycap tests' },
    buffers: [{ byteLength: bin.length }], bufferViews: views,
    accessors: [
      { bufferView: 0, componentType: 5126, count: 24, type: 'VEC3', min: [-0.5, -0.5, -0.5], max: [0.5, 0.5, 0.5] },
      { bufferView: 1, componentType: 5126, count: 24, type: 'VEC3' },
      { bufferView: 2, componentType: 5126, count: 24, type: 'VEC4' },
      { bufferView: 3, componentType: 5123, count: 36, type: 'SCALAR' },
    ],
    materials: [{ pbrMetallicRoughness: { baseColorFactor: [1, 1, 1, 1], metallicFactor: 0, roughnessFactor: 0.6 } }],
    meshes: [{ primitives: [{ attributes: { POSITION: 0, NORMAL: 1, COLOR_0: 2 }, indices: 3, material: 0 }] }],
    nodes: [{ mesh: 0 }], scenes: [{ nodes: [0] }], scene: 0,
  }, bin);
}

if (process.argv[1]?.endsWith('glb.ts') && process.argv[2]) {
  const { writeFileSync } = await import('node:fs');
  writeFileSync(process.argv[2], makeCube());
}
