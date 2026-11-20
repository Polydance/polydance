/**
 * The one checked step between this private repository and the public one (private/docs/BUSINESS.md, "Before the
 * repository is public", item 8). `check` scans every tracked file outside `private/` against the deny-list in
 * `private/publish-deny.json` and the secret shapes in publish-rules.ts, and says what would leak. `snapshot`
 * refuses unless the tree is clean and the check finds nothing, then copies those files into a new folder as one
 * commit of a new history. Nothing here pushes: sending the snapshot to github.com/Polydance/polydance is its own
 * step, taken with Robin's go.
 *
 *   npx tsx scripts/publish.ts check [--lines]
 *   npx tsx scripts/publish.ts snapshot --out DIR
 */
import { execFile } from 'node:child_process';
import { chmod, copyFile, mkdir, readdir, readFile } from 'node:fs/promises';
import { dirname, join, resolve } from 'node:path';
import { parseArgs, promisify } from 'node:util';
import { denyListSchema, privateLinks, publishable, scanFile, summarise, type DenyRule, type Finding } from './publish-rules.js';

const run = promisify(execFile);
const ROOT = resolve(dirname(new URL(import.meta.url).pathname), '..');
const DENY_FILE = join(ROOT, 'private/publish-deny.json');

async function git(args: string[], cwd = ROOT): Promise<string> {
  return (await run('git', args, { cwd, maxBuffer: 64 * 1024 * 1024 })).stdout;
}

async function denyRules(): Promise<DenyRule[]> {
  const raw = await readFile(DENY_FILE, 'utf8').catch(() => { throw new Error(`no deny-list at ${DENY_FILE}`); });
  const parsed = denyListSchema.safeParse(JSON.parse(raw));
  if (!parsed.success) throw new Error(`${DENY_FILE} is not a deny-list: ${parsed.error.issues.map(i => `${i.path.join('.')}: ${i.message}`).join('; ')}`);
  return parsed.data.rules;
}

/** Tracked files that would be published, with their git mode (100644, 100755). */
async function publicFiles(): Promise<{ path: string; mode: string }[]> {
  return (await git(['ls-files', '-s', '-z'])).split('\0').filter(Boolean).map(entry => {
    const [meta, path] = entry.split('\t');
    return { path, mode: meta.split(' ')[0] };
  }).filter(f => publishable(f.path));
}

async function scan(): Promise<{ files: { path: string; mode: string }[]; findings: Finding[] }> {
  const deny = await denyRules();
  const files = await publicFiles();
  const findings: Finding[] = [];
  for (const f of files) {
    if (f.mode === '120000') { findings.push({ path: f.path, line: 0, why: 'a symbolic link (not published)', kind: 'secret', text: '' }); continue; }
    const bytes = await readFile(join(ROOT, f.path));
    const binary = bytes.subarray(0, 8000).includes(0);
    const text = bytes.toString(binary ? 'latin1' : 'utf8');
    findings.push(...scanFile(f.path, text, deny, binary), ...(binary ? [] : privateLinks(f.path, text)));
  }
  return { files, findings };
}

function report(findings: Finding[], files: number, lines: boolean): void {
  if (!findings.length) { console.log(`${files} files outside private/ checked: nothing private and nothing secret-shaped.`); return; }
  const { byRule, byFolder } = summarise(findings);
  const paths = new Set(findings.map(f => f.path));
  console.log(`${files} files outside private/ checked: ${findings.length} line(s) in ${paths.size} file(s) would leak.\n`);
  console.log('By rule:');
  for (const [why, r] of [...byRule].sort((a, b) => b[1].files.size - a[1].files.size)) console.log(`  ${String(r.files.size).padStart(4)} files  ${String(r.lines).padStart(5)} lines  ${why}`);
  console.log('\nBy folder:');
  for (const [folder, s] of [...byFolder].sort((a, b) => b[1].size - a[1].size)) console.log(`  ${String(s.size).padStart(4)} files  ${folder}`);
  if (lines) {
    console.log('\nEvery line:');
    for (const f of findings) console.log(`  ${f.path}${f.line ? `:${f.line}` : ''}  [${f.why}]${f.text ? `  ${f.text}` : ''}`);
  } else {
    console.log('\nFiles:');
    for (const p of [...paths].sort()) console.log(`  ${p}`);
    console.log('\n--lines prints each line.');
  }
}

async function snapshot(out: string): Promise<number> {
  if ((await git(['status', '--porcelain', '--untracked-files=normal'])).trim()) throw new Error('commit everything first: a snapshot comes from a clean tree');
  const { files, findings } = await scan();
  if (findings.length) { report(findings, files.length, false); console.log('\nNo snapshot: fix the above, or move the files under private/.'); return 3; }
  const dir = resolve(out);
  await mkdir(dir, { recursive: true, mode: 0o700 });
  if ((await readdir(dir)).length) throw new Error(`${dir} is not empty`);
  for (const f of files) {
    await mkdir(dirname(join(dir, f.path)), { recursive: true });
    await copyFile(join(ROOT, f.path), join(dir, f.path));
    await chmod(join(dir, f.path), f.mode === '100755' ? 0o755 : 0o644);
  }
  const head = (await git(['rev-parse', '--short', 'HEAD'])).trim();
  await git(['init', '-q', '-b', 'main'], dir);
  await git(['add', '-A'], dir);
  await git(['commit', '-q', '-m', `Polydance, from the private repository's ${head}`], dir);
  console.log(`${files.length} files in ${dir}, one commit on main from ${head}. Nothing was pushed.`);
  return 0;
}

async function main(): Promise<number> {
  const { values, positionals } = parseArgs({ allowPositionals: true, options: { lines: { type: 'boolean' }, out: { type: 'string' } } });
  const command = positionals[0] ?? 'check';
  if (command === 'check') {
    const { files, findings } = await scan();
    report(findings, files.length, Boolean(values.lines));
    return findings.length ? 3 : 0;
  }
  if (command === 'snapshot') {
    if (!values.out) throw new Error('snapshot needs --out DIR');
    return snapshot(values.out);
  }
  throw new Error(`unknown command ${command}: check or snapshot`);
}

main().then(code => process.exit(code), (error: Error) => { console.error(error.message); process.exit(2); });
