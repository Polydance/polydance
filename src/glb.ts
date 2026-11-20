/**
 * 3D models a thread can carry (docs/THREADS.md, Models): one binary glTF 2.0 file, checked the same way by
 * the CLI before it pushes and by the receiver before it keeps one. The headset opens it in a viewer panel
 * with nothing else to fetch, so a model that points at outside files (textures beside a .gltf) is refused
 * with a way to pack it, rather than half-loading on the headset. Only the container and its JSON are read
 * here; whether the meshes draw is the viewer's to say.
 */
import { z } from 'zod';

/** Under the hosted receiver's nginx limit of 64 MB a request (deploy/receiver/nginx-site.conf.example). */
export const MODEL_MAX_BYTES = 60 * 1024 * 1024;
export const SHA256 = /^[0-9a-f]{64}$/;

/** A file name to show on the headset, never a path. */
export const modelNameSchema = z.string().trim().min(5).max(120)
  .regex(/^[^/\\\u0000-\u001f]+\.glb$/i, 'a model is named like chair.glb, with no folders');

const MAGIC = 0x46546c67; // "glTF"
const JSON_CHUNK = 0x4e4f534a; // "JSON"
const BIN_CHUNK = 0x004e4942; // "BIN\0"

export interface GlbInfo { meshes: number; animations: number; extensionsRequired: string[] }

const docSchema = z.looseObject({
  asset: z.looseObject({ version: z.string() }),
  buffers: z.array(z.looseObject({ uri: z.string().optional(), byteLength: z.number() })).optional(),
  images: z.array(z.looseObject({ uri: z.string().optional() })).optional(),
  meshes: z.array(z.unknown()).optional(),
  animations: z.array(z.unknown()).optional(),
  extensionsRequired: z.array(z.string()).optional(),
});

/** What is wrong with a .glb in words, or what it holds; `name` only colours the messages. */
export function inspectGlb(data: Uint8Array, name = 'the model'): { problems: string[]; info?: GlbInfo } {
  const view = new DataView(data.buffer, data.byteOffset, data.byteLength);
  const fail = (problem: string) => ({ problems: [`${name}: ${problem}`] });
  if (data.byteLength < 20 || view.getUint32(0, true) !== MAGIC) return fail('not a binary glTF (.glb) file; a .gltf with separate files must be packed into one .glb first');
  if (view.getUint32(4, true) !== 2) return fail(`glTF container version ${view.getUint32(4, true)}; only version 2 is supported`);
  if (view.getUint32(8, true) !== data.byteLength) return fail(`its header says ${view.getUint32(8, true)} bytes but the file is ${data.byteLength}; it is cut short or damaged`);
  const jsonLength = view.getUint32(12, true);
  if (view.getUint32(16, true) !== JSON_CHUNK || 20 + jsonLength > data.byteLength) return fail('its first chunk is not the glTF JSON');
  let doc: z.infer<typeof docSchema>;
  try {
    const parsed = docSchema.safeParse(JSON.parse(new TextDecoder('utf-8', { fatal: true }).decode(data.subarray(20, 20 + jsonLength))));
    if (!parsed.success) return fail(`its glTF JSON is not valid: ${parsed.error.issues.map(i => `${i.path.join('.') || 'document'} ${i.message}`).join('; ')}`);
    doc = parsed.data;
  } catch { return fail('its glTF JSON cannot be read'); }
  if (!doc.asset.version.startsWith('2.')) return fail(`glTF ${doc.asset.version}; only glTF 2 is supported`);

  const problems: string[] = [];
  // Everything must be inside the file: a uri other than data: is a file beside it, or a link the headset would have to follow.
  const outside = [...(doc.buffers ?? []), ...(doc.images ?? [])].flatMap(item => item.uri && !item.uri.startsWith('data:') ? [item.uri.slice(0, 80)] : []);
  if (outside.length) problems.push(`${name}: refers to files outside it (${outside.slice(0, 3).join(', ')}${outside.length > 3 ? ', …' : ''}); pack them into one .glb, for example with npx gltf-pipeline -i model.gltf -o model.glb`);
  // A buffer with no uri is the file's own BIN chunk, which must follow the JSON.
  if ((doc.buffers ?? []).some(b => b.uri === undefined)) {
    const at = 20 + jsonLength + ((4 - (jsonLength % 4)) % 4);
    const binary = at + 8 <= data.byteLength && view.getUint32(at + 4, true) === BIN_CHUNK;
    if (!binary || at + 8 + view.getUint32(at, true) > data.byteLength) problems.push(`${name}: its binary chunk is missing or cut short`);
  }
  if (!doc.meshes?.length) problems.push(`${name}: has no meshes, so there is nothing to see`);
  if (problems.length) return { problems };
  return { problems, info: { meshes: doc.meshes!.length, animations: doc.animations?.length ?? 0, extensionsRequired: doc.extensionsRequired ?? [] } };
}
