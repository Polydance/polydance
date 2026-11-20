import { execFile, type ExecFileException } from 'node:child_process';

export class ToolError extends Error {
  constructor(readonly tool: string, message: string, readonly code: number | null, readonly stderr: string) {
    super(message); this.name = 'ToolError';
  }
}
export interface ExecResult { stdout: string; stderr: string; code: number }
export interface ExecOptions { cwd?: string; timeoutMs?: number; maxBuffer?: number; allowFailure?: boolean; env?: NodeJS.ProcessEnv }

const tail = (text: string, lines = 8) => text.trim().split('\n').slice(-lines).join('\n');

/** Runs an external tool without a shell. Arguments are passed as an array, never interpolated. */
export function exec(file: string, args: string[], options: ExecOptions = {}): Promise<ExecResult> {
  return new Promise((resolve, reject) => {
    execFile(file, args, {
      cwd: options.cwd, env: options.env ?? process.env, encoding: 'utf8',
      timeout: options.timeoutMs ?? 120_000, maxBuffer: options.maxBuffer ?? 64 * 1024 * 1024,
    }, (error: ExecFileException | null, stdout: string, stderr: string) => {
      if (!error) return resolve({ stdout, stderr, code: 0 });
      if (error.code === 'ENOENT') return reject(new ToolError(file, `${file} is not installed or not on PATH`, null, ''));
      if (error.killed) return reject(new ToolError(file, `${file} timed out after ${options.timeoutMs ?? 120_000} ms`, null, stderr));
      const code = typeof error.code === 'number' ? error.code : -1;
      if (options.allowFailure) return resolve({ stdout, stderr, code });
      reject(new ToolError(file, `${file} ${args[0] ?? ''} failed (exit ${code}): ${tail(stderr) || tail(stdout) || 'no output'}`, code, stderr));
    });
  });
}

/** True when the binary can be started at all. A non-zero exit still counts as installed. */
export async function installed(file: string, probeArgs: string[] = ['--version']): Promise<boolean> {
  try { await exec(file, probeArgs, { allowFailure: true, timeoutMs: 15_000 }); return true; }
  catch (error) { if (error instanceof ToolError && error.code === null && error.message.includes('not installed')) return false; return true; }
}
