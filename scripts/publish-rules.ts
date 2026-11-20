/**
 * What may leave this repository for the public one (private/docs/BUSINESS.md, "Before the repository is public", item 8).
 * The public repository is a snapshot of every tracked file outside `private/`, so this module answers two
 * questions about each such file: does it name something private (the deny-list, kept in
 * `private/publish-deny.json` because it names those things itself), and does anything in it look like a secret
 * (the patterns below, the same shapes the tidy sweep looks for, plus a few more)? Pure, so it is tested without
 * the real repository; scripts/publish.ts reads git and the files.
 */
import { posix } from 'node:path';
import { z } from 'zod';

/** Everything under this folder stays private and is never scanned or published. */
export const PRIVATE_DIR = 'private/';
/** This team's Claude Code settings and skills (the tidy sweep runs against the live host); kept out like private/. */
export const AGENT_DIR = '.claude/';

/**
 * One private name: a literal string unless `regex`, matched without regard to case unless `caseSensitive`.
 * `textOnly` skips binary files, for a short pattern that random bytes in an image would match by chance.
 */
export const denyRuleSchema = z.object({
  pattern: z.string().min(3),
  why: z.string().min(1),
  regex: z.boolean().optional(),
  caseSensitive: z.boolean().optional(),
  textOnly: z.boolean().optional(),
}).strict();
export const denyListSchema = z.object({ rules: z.array(denyRuleSchema).min(1) }).strict();
export type DenyRule = z.infer<typeof denyRuleSchema>;

/** Secret shapes, matched wherever they appear. Test fixtures' short stand-ins (`sk-ant-test`) are too short to match. */
export const SECRET_RULES: { why: string; re: RegExp }[] = [
  { why: 'a private key', re: /-----BEGIN (RSA |EC |OPENSSH |DSA |ENCRYPTED )?PRIVATE KEY-----/ },
  { why: 'an Anthropic API key', re: /sk-ant-[A-Za-z0-9_-]{20,}/ },
  { why: 'an AWS access key id', re: /\bAKIA[0-9A-Z]{16}\b/ },
  { why: 'a GitHub token', re: /\b(ghp|gho|ghu|ghs|ghr)_[A-Za-z0-9]{30,}\b|\bgithub_pat_[A-Za-z0-9_]{40,}\b/ },
  { why: 'a Slack token', re: /\bxox[abprs]-[A-Za-z0-9-]{10,}\b/ },
  { why: 'a Google API key', re: /\bAIza[0-9A-Za-z_-]{35}\b/ },
  { why: 'a Meta access token', re: /\b(OC|FRL)[A-Za-z0-9]{40,}\b/ },
];

/** File names that are secrets by their nature, whatever they hold; `.env.example` is the documented exception. */
export function secretFileName(path: string): string | undefined {
  if (path === '.env.example' || path.endsWith('/.env.example')) return undefined;
  if (/(^|\/)\.env($|\.)/.test(path)) return 'an environment file';
  if (/\.(pem|p12|p8|jks|keystore|mobileprovision)$/.test(path)) return 'a key or signing file';
  if (/(^|\/)id_(rsa|ed25519|ecdsa)$/.test(path)) return 'an SSH key';
  return undefined;
}

export interface Finding { path: string; line: number; why: string; kind: 'private' | 'secret'; text: string }

/** Whether a tracked path goes into the public snapshot at all. */
export function publishable(path: string): boolean {
  return !path.startsWith(PRIVATE_DIR) && !path.startsWith(AGENT_DIR);
}

function denyRegExp(rule: DenyRule): RegExp {
  const source = rule.regex ? rule.pattern : rule.pattern.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
  return new RegExp(source, rule.caseSensitive ? '' : 'i');
}

/**
 * Every finding in one file. `text` is the file's content (binary files decoded as latin1, so a name inside an
 * image's metadata still matches). Each finding carries its line, cut to 160 characters, for the report.
 */
export function scanFile(path: string, text: string, deny: DenyRule[], binary = false): Finding[] {
  const out: Finding[] = [];
  const named = secretFileName(path);
  if (named) out.push({ path, line: 0, why: named, kind: 'secret', text: '' });
  const rules: { why: string; re: RegExp; kind: Finding['kind'] }[] = [
    ...deny.filter(rule => !(binary && rule.textOnly)).map(rule => ({ why: rule.why, re: denyRegExp(rule), kind: 'private' as const })),
    ...SECRET_RULES.map(rule => ({ why: rule.why, re: rule.re, kind: 'secret' as const })),
  ];
  text.split('\n').forEach((line, i) => {
    for (const rule of rules) {
      if (rule.re.test(line)) out.push({ path, line: i + 1, why: rule.why, kind: rule.kind, text: line.trim().slice(0, 160) });
    }
  });
  return out;
}

/**
 * Markdown links in a published file that lead into a folder the public repository lacks: they would be broken
 * there. Name the private file as plain text instead (`private/docs/ROADMAP.md`).
 */
export function privateLinks(path: string, text: string): Finding[] {
  if (!path.endsWith('.md')) return [];
  const out: Finding[] = [];
  text.split('\n').forEach((line, i) => {
    for (const m of line.matchAll(/\]\(([^)\s#]+)(#[^)\s]*)?\)/g)) {
      if (/^[a-z]+:/i.test(m[1])) continue;
      const target = posix.normalize(posix.join(posix.dirname(path), m[1]));
      if (!publishable(target)) out.push({ path, line: i + 1, why: 'a link into a folder that is not published', kind: 'private', text: line.trim().slice(0, 160) });
    }
  });
  return out;
}

/** Findings grouped for the report: how many lines each rule hit, and in how many files under each top folder. */
export function summarise(findings: Finding[]): { byRule: Map<string, { lines: number; files: Set<string> }>; byFolder: Map<string, Set<string>> } {
  const byRule = new Map<string, { lines: number; files: Set<string> }>();
  const byFolder = new Map<string, Set<string>>();
  for (const f of findings) {
    const r = byRule.get(f.why) ?? { lines: 0, files: new Set<string>() };
    r.lines++; r.files.add(f.path); byRule.set(f.why, r);
    const folder = f.path.includes('/') ? `${f.path.split('/')[0]}/` : '(root)';
    const s = byFolder.get(folder) ?? new Set<string>();
    s.add(f.path); byFolder.set(folder, s);
  }
  return { byRule, byFolder };
}
