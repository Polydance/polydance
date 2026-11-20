// The publish check's rules (scripts/publish-rules.ts), on made-up names: what counts as private, what looks like a
// secret, and what never goes public at all.
import { describe, expect, it } from 'vitest';
import { denyListSchema, privateLinks, publishable, scanFile, secretFileName, summarise } from '../scripts/publish-rules.js';

const deny = denyListSchema.parse({ rules: [
  { pattern: 'example-host', why: 'the host' },
  { pattern: '/Users/someone', caseSensitive: true, why: 'a home folder' },
  { pattern: '\\bQuill\\b', regex: true, caseSensitive: true, why: 'a person' },
] }).rules;

describe('the publish check', () => {
  it('keeps private/ out and everything else in', () => {
    expect(publishable('private/publish-deny.json')).toBe(false);
    expect(publishable('.claude/skills/tidy/SKILL.md')).toBe(false);
    expect(publishable('src/cli.ts')).toBe(true);
    expect(publishable('docs/private-notes.md')).toBe(true);
  });

  it('finds deny-listed names by line, ignoring case unless told not to', () => {
    const found = scanFile('docs/x.md', 'one\nRuns on EXAMPLE-HOST.\n/users/someone is fine\n/Users/someone is not\nQuill said; quills are fine', deny);
    expect(found.map(f => [f.line, f.why])).toEqual([[2, 'the host'], [4, 'a home folder'], [5, 'a person']]);
    expect(found.every(f => f.kind === 'private')).toBe(true);
  });

  it('treats a literal pattern literally', () => {
    expect(scanFile('a.md', 'example.host', [{ pattern: 'example.host', why: 'dot' }])).toHaveLength(1);
    expect(scanFile('a.md', 'exampleXhost', [{ pattern: 'example.host', why: 'dot' }])).toHaveLength(0);
  });

  it('finds secret shapes but not the tests\' short stand-ins', () => {
    const key = 'sk-ant-' + 'a'.repeat(30);
    const pem = '-----BEGIN OPENSSH ' + 'PRIVATE KEY-----';
    const found = scanFile('src/a.ts', `const k = '${key}';\nconst t = 'sk-ant-test';\n${pem}`, []);
    expect(found.map(f => [f.line, f.why, f.kind])).toEqual([[1, 'an Anthropic API key', 'secret'], [3, 'a private key', 'secret']]);
  });

  it('refuses files that are secrets by name, except .env.example', () => {
    expect(secretFileName('.env.local')).toBe('an environment file');
    expect(secretFileName('app/upload.jks')).toBe('a key or signing file');
    expect(secretFileName('.env.example')).toBeUndefined();
    expect(scanFile('.env', '', [])).toEqual([{ path: '.env', line: 0, why: 'an environment file', kind: 'secret', text: '' }]);
  });

  it('leaves a short text-only pattern out of binary files, where random bytes would match it', () => {
    const rules = [{ pattern: '\\bQRX\\b', regex: true, textOnly: true, why: 'short' }];
    expect(scanFile('a.png', 'x QRX y', rules, true)).toHaveLength(0);
    expect(scanFile('a.md', 'x QRX y', rules)).toHaveLength(1);
  });

  it('finds links that would be broken in the public repository, and leaves the rest', () => {
    const text = 'See [the roadmap](../private/docs/ROADMAP.md#where) and [tidy](../.claude/skills/x.md).\n[design](DESIGN.md), [site](https://example.com/private/x.md), `private/docs/ROADMAP.md`';
    expect(privateLinks('docs/x.md', text).map(f => f.line)).toEqual([1, 1]);
    expect(privateLinks('src/x.ts', text)).toEqual([]);
  });

  it('refuses a deny-list that is not one', () => {
    expect(denyListSchema.safeParse({ rules: [] }).success).toBe(false);
    expect(denyListSchema.safeParse({ rules: [{ pattern: 'ab', why: 'too short to mean anything' }] }).success).toBe(false);
    expect(denyListSchema.safeParse({ rules: [{ pattern: 'abc', why: 'x', extra: true }] }).success).toBe(false);
  });

  it('summarises by rule and by top folder', () => {
    const found = [...scanFile('docs/a.md', 'example-host\nexample-host', deny), ...scanFile('README.md', 'example-host', deny)];
    const { byRule, byFolder } = summarise(found);
    expect(byRule.get('the host')).toEqual({ lines: 3, files: new Set(['docs/a.md', 'README.md']) });
    expect([...byFolder.keys()].sort()).toEqual(['(root)', 'docs/']);
  });
});
