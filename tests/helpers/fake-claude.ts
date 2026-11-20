/** A stand-in for the Messages API on localhost: records each request and answers as told. Never the network. */
import { createServer, type IncomingHttpHeaders } from 'node:http';
import type { AddressInfo } from 'node:net';

export interface ClaudeCall { url?: string; headers: IncomingHttpHeaders; body: Record<string, unknown> }

/** A Messages API response holding one text block. */
export const claudeMessage = (text: string, stopReason = 'end_turn') => ({
  id: 'msg_test', type: 'message', role: 'assistant', model: 'claude-haiku-4-5',
  content: [{ type: 'text', text }], stop_reason: stopReason, stop_sequence: null,
  usage: { input_tokens: 120, output_tokens: 30 },
});

export async function fakeClaude(reply: (body: Record<string, unknown>) => { status: number; body: unknown }) {
  const calls: ClaudeCall[] = [];
  const server = createServer(async (req, res) => {
    const chunks: Buffer[] = [];
    for await (const chunk of req) chunks.push(chunk as Buffer);
    const body = JSON.parse(Buffer.concat(chunks).toString('utf8') || '{}') as Record<string, unknown>;
    calls.push({ url: req.url, headers: req.headers, body });
    const answer = reply(body);
    res.writeHead(answer.status, { 'content-type': 'application/json' });
    res.end(JSON.stringify(answer.body));
  });
  await new Promise<void>(done => server.listen(0, '127.0.0.1', done));
  return { calls, url: `http://127.0.0.1:${(server.address() as AddressInfo).port}`, close: () => server.close() };
}
