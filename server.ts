/*
 ** http-over-ai
 **
 ** A HTTP/1.1 server simulated by a language model.
 */

import { ArrayBufferSink } from 'bun';
import fs from 'node:fs/promises';
import { OpenAI } from 'openai';
import { createSystemInstructions } from './createSystemInstructions';

const apiKey = process.env.OPENAI_API_KEY;
if (!apiKey) {
  console.error('Error: OPENAI_API_KEY environment variable not set.');
  process.exit(1);
}

const openai = new OpenAI({ apiKey });

const SERVER_NAME = 'http-over-ai';
const HOST = process.env.HOST || 'localhost';
const PORT = process.env.PORT || 9000;
const DEFAULT_USER_AGENT =
  'Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/123.0.0.0 Safari/537.36';

const MODEL_NAME = process.env.MODEL_NAME || 'gpt-4.1-mini';

function splitHttp(buf: string): [string, string] | null {
  const i = buf.indexOf('\r\n\r\n');
  return i === -1 ? null : [buf.slice(0, i), buf.slice(i + 4)];
}

function safeContentLength(headers: string, body: string): string {
  const len = new TextEncoder().encode(body).length;
  return /Content-Length:\s*\d+/i.test(headers)
    ? headers.replace(/Content-Length:\s*\d+/i, `Content-Length: ${len}`)
    : `${headers}\r\nContent-Length: ${len}`;
}

interface ChatMessage {
  role: 'user' | 'assistant';
  content: string;
}

class Connection {
  sock: Bun.Socket;
  buffer = '';
  sink = new ArrayBufferSink();
  history: ChatMessage[] = [];
  closing = false;
  logPath: string;
  verbose = process.env.DEBUG_HTTP_OVER_AI === '1';

  constructor(sock: Bun.Socket) {
    this.sock = sock;
    this.sink.start({ stream: true, highWaterMark: 1 << 20 });
    this.logPath = `./logs/${new Date().toISOString().replace(/[:.]/g, '-')}_${sock.remoteAddress?.replace(/[:.]/g, '_')}.log`;
    fs.mkdir('./logs', { recursive: true }).catch(() => { });
    this.log('info', `Connection opened from ${sock.remoteAddress}`);
  }

  log(lvl: 'debug' | 'info' | 'warn' | 'error', msg: string) {
    if (this.verbose) console[lvl](`[${this.sock.remoteAddress}] ${msg}`);
    Bun.write(this.logPath, Buffer.from(`[${new Date().toISOString()}] [${lvl}] ${msg}\n`), { createPath: true }).catch(() => { });
  }

  // Handle inbound TCP data
  onData(chunk: Uint8Array) {
    this.buffer += new TextDecoder().decode(chunk);
    while (true) {
      const parts = splitHttp(this.buffer);
      if (!parts) return;

      const [hdrs, rest] = parts;
      const clMatch = hdrs.match(/Content-Length:\s*(\d+)/i);
      const bodyLen = clMatch ? Number(clMatch[1]) : 0;
      if (rest.length < bodyLen) return; // wait for full body

      const reqText = this.buffer.slice(0, hdrs.length + 4 + bodyLen);
      this.buffer = this.buffer.slice(hdrs.length + 4 + bodyLen);
      this.handleRequest(new TextEncoder().encode(reqText));
    }
  }

  // Flush sink → socket, respecting back-pressure
  onDrain() {
    this.flush();
  }

  flush() {
    const chunk = this.sink.flush() as Uint8Array;

    if (chunk.byteLength === 0) {
      if (this.closing) this.sock.end();
      return;
    }

    const n = this.sock.write(chunk);
    if (n < chunk.length) {
      this.sink.write(chunk.subarray(n));
    }
  }

  /* Main request → OpenAI → response round-trip */
  async handleRequest(reqBytes: Uint8Array) {
    const raw = new TextDecoder().decode(reqBytes);
    const userAgent = raw.split('User-Agent: ')[1]?.split('\r\n')[0] ?? DEFAULT_USER_AGENT;
    this.history.push({ role: 'user', content: raw });

    try {
      const resp = await openai.responses.create({
        model: MODEL_NAME,
        instructions: createSystemInstructions({
          userAgent,
          host: HOST,
          port: +PORT,
          serverName: SERVER_NAME,
        }),
        input: this.history,
        temperature: 0.7,
      });

      let out = resp.output_text;
      const i = out.indexOf('\r\n\r\n');
      if (i !== -1) {
        const headers = out.slice(0, i);
        const body = out.slice(i + 4);
        out = safeContentLength(headers, body) + '\r\n\r\n' + body;
      }

      if (/Connection:\s*close/i.test(out)) {
        this.closing = true;
      }

      this.history.push({ role: 'assistant', content: out });
      this.sink.write(new TextEncoder().encode(out));
      this.flush();
    } catch (e) {
      const msg = e instanceof Error ? e.message : 'LLM proxy error';
      const body = `HTTP/1.1 500 Internal Server Error\r\nContent-Type: text/plain; charset=utf-8\r\nContent-Length: ${msg.length}\r\nConnection: close\r\n\r\n${msg}`;
      this.closing = true;
      this.sink.write(new TextEncoder().encode(body));
      this.flush();
    }
  }

  onClose() {
    this.log('info', 'Connection closed');
  }
}

Bun.listen<any>({
  hostname: '0.0.0.0',
  port: +PORT,
  socket: {
    open(sock) { sock.data = new Connection(sock); },
    data(sock, c) { (sock.data as Connection).onData(c); },
    drain(sock) { (sock.data as Connection).onDrain(); },
    close(sock) { (sock.data as Connection).onClose(); },
    end(sock) { (sock.data as Connection).onClose(); },
  },
});

console.log(`[${new Date().toISOString()}] 🚀 http-over-ai listening on http://${HOST}:${PORT}`);