// MCP at POST /mcp: streamable HTTP JSON-RPC. Speaks the modern server/discover revision and
// the legacy initialize handshake; the tools are thin views over the same records as REST.

import { VIEWER, createRepo, findRepo, type RepoRec } from './store.ts';
import {
  createIssueRecord,
  createPullRecord,
  issueJson,
  mergePullRecord,
  pullJson,
  repoJson,
} from './rest.ts';

const SERVER_INFO = Object.freeze({ name: 'github-core-clone', version: '1.0.0' });
const SUPPORTED_VERSIONS = Object.freeze(['2026-07-28', '2025-11-25', '2025-06-18', '2025-03-26']);

interface ToolDef {
  name: string;
  description: string;
  inputSchema: {
    type: 'object';
    properties: Record<string, { type: string; description: string }>;
    required: string[];
  };
}

const prop = (type: string, description: string): { type: string; description: string } => ({ type, description });

export const TOOLS: readonly ToolDef[] = Object.freeze([
  {
    name: 'create_repo',
    description: 'Create a new repository owned by the authenticated user.',
    inputSchema: {
      type: 'object',
      properties: {
        name: prop('string', 'The repository name.'),
        description: prop('string', 'A short description of the repository.'),
        private: prop('boolean', 'Whether the repository is private.'),
      },
      required: ['name'],
    },
  },
  {
    name: 'get_repo',
    description: 'Get a repository by owner and name.',
    inputSchema: {
      type: 'object',
      properties: {
        owner: prop('string', 'The repository owner login.'),
        repo: prop('string', 'The repository name.'),
      },
      required: ['owner', 'repo'],
    },
  },
  {
    name: 'create_issue',
    description: 'Create an issue in a repository.',
    inputSchema: {
      type: 'object',
      properties: {
        owner: prop('string', 'The repository owner login.'),
        repo: prop('string', 'The repository name.'),
        title: prop('string', 'The issue title.'),
        body: prop('string', 'The issue body.'),
      },
      required: ['owner', 'repo', 'title'],
    },
  },
  {
    name: 'list_issues',
    description: 'List issues in a repository, optionally filtered by state (open, closed, all).',
    inputSchema: {
      type: 'object',
      properties: {
        owner: prop('string', 'The repository owner login.'),
        repo: prop('string', 'The repository name.'),
        state: prop('string', 'Filter by state: open, closed or all.'),
      },
      required: ['owner', 'repo'],
    },
  },
  {
    name: 'get_issue',
    description: 'Get one issue by number.',
    inputSchema: {
      type: 'object',
      properties: {
        owner: prop('string', 'The repository owner login.'),
        repo: prop('string', 'The repository name.'),
        issue_number: prop('number', 'The issue number.'),
      },
      required: ['owner', 'repo', 'issue_number'],
    },
  },
  {
    name: 'create_pull_request',
    description: 'Create a pull request from a head branch into a base branch.',
    inputSchema: {
      type: 'object',
      properties: {
        owner: prop('string', 'The repository owner login.'),
        repo: prop('string', 'The repository name.'),
        title: prop('string', 'The pull request title.'),
        body: prop('string', 'The pull request body.'),
        head: prop('string', 'The head branch name.'),
        base: prop('string', 'The base branch name.'),
      },
      required: ['owner', 'repo', 'title', 'head', 'base'],
    },
  },
  {
    name: 'list_pull_requests',
    description: 'List pull requests in a repository, optionally filtered by state.',
    inputSchema: {
      type: 'object',
      properties: {
        owner: prop('string', 'The repository owner login.'),
        repo: prop('string', 'The repository name.'),
        state: prop('string', 'Filter by state: open, closed or all.'),
      },
      required: ['owner', 'repo'],
    },
  },
  {
    name: 'merge_pull_request',
    description: 'Merge a pull request into its base branch.',
    inputSchema: {
      type: 'object',
      properties: {
        owner: prop('string', 'The repository owner login.'),
        repo: prop('string', 'The repository name.'),
        pull_number: prop('number', 'The pull request number.'),
        merge_method: prop('string', 'The merge method: merge, squash or rebase.'),
      },
      required: ['owner', 'repo', 'pull_number'],
    },
  },
]);

interface ToolResult {
  content: Array<{ type: 'text'; text: string }>;
  structuredContent?: Record<string, unknown>;
  isError?: boolean;
}

function okResult(value: unknown): ToolResult {
  const text = JSON.stringify(value);
  const result: ToolResult = { content: [{ type: 'text', text }] };
  if (typeof value === 'object' && value !== null && !Array.isArray(value)) {
    result.structuredContent = value as Record<string, unknown>;
  }
  return result;
}

function errorResult(message: string): ToolResult {
  return { content: [{ type: 'text', text: message }], isError: true };
}

function repoFor(args: Record<string, unknown>): RepoRec | null {
  const owner = typeof args.owner === 'string' ? args.owner : '';
  const repo = typeof args.repo === 'string' ? args.repo : '';
  return findRepo(owner, repo) ?? null;
}

function callTool(name: string, args: Record<string, unknown>): ToolResult | { rpcError: { code: number; message: string } } {
  const def = TOOLS.find((tool) => tool.name === name);
  if (def === undefined) return { rpcError: { code: -32602, message: `Unknown tool: ${name}` } };
  for (const required of def.inputSchema.required) {
    if (args[required] === undefined || args[required] === null || args[required] === '') {
      return errorResult(`Missing required argument: ${required}`);
    }
  }
  switch (name) {
    case 'create_repo': {
      const repoName = String(args.name);
      if (findRepo(VIEWER.login, repoName) !== undefined) return errorResult(`Repository ${VIEWER.login}/${repoName} already exists`);
      const repo = createRepo(VIEWER.login, repoName, typeof args.description === 'string' ? args.description : '', args.private === true);
      return okResult(repoJson(repo));
    }
    case 'get_repo': {
      const repo = repoFor(args);
      if (repo === null) return errorResult(`Repository ${String(args.owner)}/${String(args.repo)} not found`);
      return okResult(repoJson(repo));
    }
    case 'create_issue': {
      const repo = repoFor(args);
      if (repo === null) return errorResult('repository not found');
      const created = createIssueRecord(repo, { title: String(args.title), body: typeof args.body === 'string' ? args.body : '' });
      if ('error' in created) return errorResult(created.error);
      return okResult(issueJson(repo, created.issue));
    }
    case 'list_issues': {
      const repo = repoFor(args);
      if (repo === null) return errorResult('repository not found');
      const state = typeof args.state === 'string' ? args.state : 'open';
      const issues = [...repo.issues.values()]
        .filter((issue) => state === 'all' || issue.state === state)
        .sort((a, b) => a.createdSeq - b.createdSeq);
      return okResult(issues.map((issue) => issueJson(repo, issue)));
    }
    case 'get_issue': {
      const repo = repoFor(args);
      if (repo === null) return errorResult('repository not found');
      const issue = repo.issues.get(Number(args.issue_number));
      if (issue === undefined) return errorResult(`issue ${String(args.issue_number)} not found`);
      return okResult(issueJson(repo, issue));
    }
    case 'create_pull_request': {
      const repo = repoFor(args);
      if (repo === null) return errorResult('repository not found');
      const created = createPullRecord(repo, {
        title: String(args.title),
        body: typeof args.body === 'string' ? args.body : '',
        head: String(args.head),
        base: String(args.base),
      });
      if ('error' in created) return errorResult(created.error);
      return okResult(pullJson(repo, created.pull));
    }
    case 'list_pull_requests': {
      const repo = repoFor(args);
      if (repo === null) return errorResult('repository not found');
      const state = typeof args.state === 'string' ? args.state : 'open';
      const pulls = [...repo.pulls.values()]
        .filter((pull) => state === 'all' || pull.state === state)
        .sort((a, b) => a.createdSeq - b.createdSeq);
      return okResult(pulls.map((pull) => pullJson(repo, pull)));
    }
    case 'merge_pull_request': {
      const repo = repoFor(args);
      if (repo === null) return errorResult('repository not found');
      const pull = repo.pulls.get(Number(args.pull_number));
      if (pull === undefined) return errorResult(`pull request ${String(args.pull_number)} not found`);
      const method = typeof args.merge_method === 'string' ? args.merge_method : 'squash';
      const merged = mergePullRecord(repo, pull, method);
      if ('conflict' in merged) return errorResult('Pull Request is not mergeable');
      if ('error' in merged) return errorResult(merged.error);
      return okResult(pullJson(repo, pull));
    }
    default:
      return { rpcError: { code: -32602, message: `Unknown tool: ${name}` } };
  }
}

// ---------------------------------------------------------------- JSON-RPC

export interface McpResponse {
  status: number;
  body: unknown | null;
}

function rpcResult(id: unknown, result: unknown): Record<string, unknown> {
  return { jsonrpc: '2.0', id: id ?? null, result };
}

function rpcError(id: unknown, code: number, message: string): Record<string, unknown> {
  return { jsonrpc: '2.0', id: id ?? null, error: { code, message } };
}

function handleOne(message: Record<string, unknown>): Record<string, unknown> | null {
  const method = typeof message.method === 'string' ? message.method : '';
  const id = message.id;
  const isNotification = id === undefined || id === null;
  const params = (typeof message.params === 'object' && message.params !== null ? message.params : {}) as Record<string, unknown>;
  switch (method) {
    case 'server/discover':
      return rpcResult(id, {
        supportedVersions: [...SUPPORTED_VERSIONS],
        capabilities: { tools: {} },
        serverInfo: { ...SERVER_INFO },
      });
    case 'initialize': {
      const requested = typeof params.protocolVersion === 'string' ? params.protocolVersion : '';
      const protocolVersion = (SUPPORTED_VERSIONS as readonly string[]).includes(requested) ? requested : '2025-11-25';
      return rpcResult(id, { protocolVersion, capabilities: { tools: {} }, serverInfo: { ...SERVER_INFO } });
    }
    case 'ping':
      return rpcResult(id, {});
    case 'tools/list':
      return rpcResult(id, { tools: TOOLS });
    case 'tools/call': {
      const toolName = typeof params.name === 'string' ? params.name : '';
      const args = (typeof params.arguments === 'object' && params.arguments !== null ? params.arguments : {}) as Record<string, unknown>;
      const outcome = callTool(toolName, args);
      if ('rpcError' in outcome) return rpcError(id, outcome.rpcError.code, outcome.rpcError.message);
      return rpcResult(id, outcome);
    }
    default:
      if (method.startsWith('notifications/')) return null;
      if (isNotification) return null;
      return rpcError(id, -32601, `Method not found: ${method}`);
  }
}

/** Handle one POST /mcp body (already authenticated). */
export function handleMcp(bodyText: string): McpResponse {
  let parsed: unknown;
  try {
    parsed = JSON.parse(bodyText);
  } catch {
    return { status: 400, body: rpcError(null, -32700, 'Parse error') };
  }
  if (Array.isArray(parsed)) {
    const responses: unknown[] = [];
    for (const item of parsed) {
      if (typeof item === 'object' && item !== null) {
        const response = handleOne(item as Record<string, unknown>);
        if (response !== null) responses.push(response);
      }
    }
    if (responses.length === 0) return { status: 202, body: null };
    return { status: 200, body: responses };
  }
  if (typeof parsed !== 'object' || parsed === null) {
    return { status: 400, body: rpcError(null, -32600, 'Invalid Request') };
  }
  const response = handleOne(parsed as Record<string, unknown>);
  if (response === null) return { status: 202, body: null };
  return { status: 200, body: response };
}
