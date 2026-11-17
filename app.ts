// The forge's HTTP surface: git smart HTTP (/<owner>/<repo>.git/...), REST v3 (/api/v3),
// GraphQL v4 (/api/graphql) and MCP (/mcp), over the shared in-memory store. main.ts owns
// the entry <-> env lifecycle; this file is only the server.

import { createServer, type IncomingMessage, type Server, type ServerResponse } from 'node:http';
import { findRepo } from './store.ts';
import {
  fetchResponseV0,
  fetchResponseV2,
  infoRefs,
  lsRefs,
  packetLines,
  parseFetchArgs,
  parsePackets,
  planFetch,
  receivePack,
} from './git.ts';
import { handleRest } from './rest.ts';
import { executeGraphQL } from './graphql.ts';
import { handleMcp } from './mcp.ts';

const JSON_TYPE = 'application/json; charset=utf-8';

let requestCounter = 0;

function sendJson(res: ServerResponse, status: number, body: unknown, headers: Readonly<Record<string, string>> = {}): void {
  if (status === 204) {
    res.writeHead(204, headers);
    res.end();
    return;
  }
  const text = `${JSON.stringify(body)}\n`;
  res.writeHead(status, { 'content-type': JSON_TYPE, 'content-length': Buffer.byteLength(text), ...headers });
  res.end(text);
}

function sendBuffer(res: ServerResponse, status: number, body: Buffer, contentType: string): void {
  res.writeHead(status, { 'content-type': contentType, 'content-length': body.length });
  res.end(body);
}

/** Whether the request carries the shop token (any bearer when the env names none). */
function authorized(req: IncomingMessage): boolean {
  const header = req.headers.authorization;
  if (header === undefined || !header.startsWith('Bearer ')) return false;
  const token = header.slice('Bearer '.length);
  if (token === '') return false;
  const expected = process.env.MAKEFUN_SHOP_TOKEN ?? '';
  return expected === '' || token === expected;
}

async function readBody(req: IncomingMessage): Promise<Buffer> {
  const chunks: Buffer[] = [];
  for await (const chunk of req) chunks.push(chunk as Buffer);
  return Buffer.concat(chunks);
}

function baseUrlOf(req: IncomingMessage): string {
  const host = req.headers.host ?? '127.0.0.1';
  return `http://${host}`;
}

// ---------------------------------------------------------------- REST + GraphQL + MCP

async function handleApi(req: IncomingMessage, res: ServerResponse, url: URL): Promise<void> {
  const path = url.pathname;
  requestCounter += 1;
  const requestId = `F${requestCounter.toString(16).toUpperCase().padStart(4, '0')}:${Date.now().toString(16).toUpperCase()}`;
  const jsonHeaders = { 'x-github-request-id': requestId };

  if (path === '/api/graphql') {
    if (req.method !== 'POST') {
      sendJson(res, 404, { message: 'Not Found' }, jsonHeaders);
      return;
    }
    if (!authorized(req)) {
      sendJson(res, 401, { message: 'Bad credentials' }, jsonHeaders);
      return;
    }
    const raw = await readBody(req);
    let parsed: unknown;
    try {
      parsed = JSON.parse(raw.toString('utf8'));
    } catch {
      sendJson(res, 400, { errors: [{ message: 'Problems parsing JSON' }] }, jsonHeaders);
      return;
    }
    if (Array.isArray(parsed)) {
      const results = parsed.map((item) => {
        const op = (item ?? {}) as { query?: unknown; variables?: unknown; operationName?: unknown };
        return executeGraphQL(
          typeof op.query === 'string' ? op.query : '',
          typeof op.variables === 'object' && op.variables !== null ? (op.variables as Record<string, unknown>) : {},
          typeof op.operationName === 'string' ? op.operationName : undefined,
        );
      });
      sendJson(res, 200, results, jsonHeaders);
      return;
    }
    const op = (parsed ?? {}) as { query?: unknown; variables?: unknown; operationName?: unknown };
    const result = executeGraphQL(
      typeof op.query === 'string' ? op.query : '',
      typeof op.variables === 'object' && op.variables !== null ? (op.variables as Record<string, unknown>) : {},
      typeof op.operationName === 'string' ? op.operationName : undefined,
    );
    sendJson(res, 200, result, jsonHeaders);
    return;
  }

  if (path === '/mcp') {
    if (!authorized(req)) {
      sendJson(res, 401, { message: 'Bad credentials' }, jsonHeaders);
      return;
    }
    if (req.method === 'DELETE') {
      res.writeHead(204);
      res.end();
      return;
    }
    if (req.method !== 'POST') {
      sendJson(res, 405, { message: 'Method Not Allowed' }, jsonHeaders);
      return;
    }
    const raw = await readBody(req);
    const outcome = handleMcp(raw.toString('utf8'));
    if (outcome.body === null) {
      res.writeHead(outcome.status);
      res.end();
      return;
    }
    sendJson(res, outcome.status, outcome.body, jsonHeaders);
    return;
  }

  // REST v3.
  const isRoot = path === '/api/v3' || path === '/api/v3/';
  if (!isRoot && !authorized(req)) {
    sendJson(res, 401, { message: 'Bad credentials' }, jsonHeaders);
    return;
  }
  const method = req.method ?? 'GET';
  let body: Record<string, unknown> | null = null;
  if (method === 'POST' || method === 'PUT' || method === 'PATCH' || method === 'DELETE') {
    const raw = await readBody(req);
    if (raw.length > 0) {
      try {
        const parsed = JSON.parse(raw.toString('utf8')) as unknown;
        body = typeof parsed === 'object' && parsed !== null && !Array.isArray(parsed) ? (parsed as Record<string, unknown>) : {};
      } catch {
        sendJson(res, 400, { message: 'Problems parsing JSON' }, jsonHeaders);
        return;
      }
    }
  }
  const segments = path
    .replace(/^\/api\/v3\/?/, '')
    .split('/')
    .filter((segment) => segment !== '')
    .map((segment) => {
      try {
        return decodeURIComponent(segment);
      } catch {
        return segment;
      }
    });
  const result = handleRest({ method, segments, query: url.searchParams, body, baseUrl: baseUrlOf(req) });
  sendJson(res, result.status, result.body ?? { message: 'Not Found' }, { ...jsonHeaders, ...(result.headers ?? {}) });
}

// ---------------------------------------------------------------- git smart HTTP

const GIT_PATH = /^\/([^/]+)\/([^/]+)\.git\/(info\/refs|git-upload-pack|git-receive-pack)$/;

async function handleGit(req: IncomingMessage, res: ServerResponse, url: URL, match: RegExpExecArray): Promise<void> {
  const owner = decodeURIComponent(match[1]!);
  const name = decodeURIComponent(match[2]!);
  const action = match[3]!;
  const repo = findRepo(owner, name);
  const method = req.method ?? 'GET';

  if (action === 'info/refs') {
    if (method !== 'GET') {
      sendBuffer(res, 405, Buffer.from('method not allowed'), 'text/plain');
      return;
    }
    const service = url.searchParams.get('service') ?? '';
    const protocolV2 = (req.headers['git-protocol'] ?? '') === 'version=2';
    const answer = infoRefs(repo, service, protocolV2);
    sendBuffer(res, answer.status, answer.body, answer.contentType);
    return;
  }

  if (repo === undefined) {
    sendBuffer(res, 404, Buffer.from('repository not found'), 'text/plain');
    return;
  }
  const body = await readBody(req);

  if (action === 'git-receive-pack') {
    const outcome = await receivePack(repo, body);
    sendBuffer(res, outcome.status, outcome.body, 'application/x-git-receive-pack-result');
    return;
  }

  // git-upload-pack POST: a v2 command stream, or a v0 fetch (two pkt-line sections).
  const first = parsePackets(body, 0);
  const firstLines = packetLines(first.packets);
  const command = firstLines[0] ?? '';
  if (command === 'command=ls-refs') {
    sendBuffer(res, 200, lsRefs(repo, firstLines.slice(1)), 'application/x-git-upload-pack-result');
    return;
  }
  if (command === 'command=fetch') {
    const args = parseFetchArgs(firstLines.slice(1));
    const plan = planFetch(repo, args);
    sendBuffer(res, 200, fetchResponseV2(plan, args), 'application/x-git-upload-pack-result');
    return;
  }
  const second = parsePackets(body, first.next);
  const args = parseFetchArgs([...firstLines, ...packetLines(second.packets)]);
  const plan = planFetch(repo, args);
  sendBuffer(res, 200, fetchResponseV0(plan, args), 'application/x-git-upload-pack-result');
}

/** Build the server. It binds nothing until the caller listens; the entry listens on an ephemeral port. */
export function createApp(): Server {
  return createServer((req: IncomingMessage, res: ServerResponse) => {
    void (async () => {
      try {
        const url = new URL(req.url ?? '/', 'http://entry');
        const path = url.pathname;
        if (req.method === 'GET' && path === '/healthz') {
          sendJson(res, 200, { ok: true });
          return;
        }
        if (path === '/api/v3' || path.startsWith('/api/v3/') || path === '/api/graphql' || path === '/mcp') {
          await handleApi(req, res, url);
          return;
        }
        const gitMatch = GIT_PATH.exec(path);
        if (gitMatch !== null) {
          await handleGit(req, res, url, gitMatch);
          return;
        }
        sendJson(res, 404, { message: 'Not Found' });
      } catch {
        if (!res.headersSent) sendJson(res, 500, { message: 'Internal Server Error' });
        else res.end();
      }
    })();
  });
}
