// GraphQL v4: a small lexer/parser/executor covering exactly the document shapes the suite
// sends (queries, mutations, variables, input objects, aliases, inline fragments, batching,
// and the __type introspection probes), resolved over the same records as REST.

import {
  VIEWER,
  branchTip,
  findRepo,
  nextCommentId,
  nextSeq,
  reposOf,
  type IssueRec,
  type PullRec,
  type RepoRec,
} from './store.ts';
import { createIssueRecord, createPullRecord, mergePullRecord, pullFiles, pullMergeable } from './rest.ts';

// ---------------------------------------------------------------- lexer

type TokenKind = 'name' | 'int' | 'float' | 'string' | 'punct' | 'spread' | 'eof';
interface Token {
  kind: TokenKind;
  value: string;
}

function lex(source: string): Token[] {
  const tokens: Token[] = [];
  let i = 0;
  while (i < source.length) {
    const ch = source[i]!;
    if (ch === ' ' || ch === '\t' || ch === '\n' || ch === '\r' || ch === ',' || ch === '﻿') {
      i += 1;
      continue;
    }
    if (ch === '#') {
      while (i < source.length && source[i] !== '\n') i += 1;
      continue;
    }
    if (ch === '.' && source.slice(i, i + 3) === '...') {
      tokens.push({ kind: 'spread', value: '...' });
      i += 3;
      continue;
    }
    if ('!$():=@[]{}|'.includes(ch)) {
      tokens.push({ kind: 'punct', value: ch });
      i += 1;
      continue;
    }
    if (ch === '"') {
      if (source.slice(i, i + 3) === '"""') {
        const end = source.indexOf('"""', i + 3);
        const text = end === -1 ? source.slice(i + 3) : source.slice(i + 3, end);
        tokens.push({ kind: 'string', value: text.replace(/\\"""/g, '"""') });
        i = end === -1 ? source.length : end + 3;
        continue;
      }
      let text = '';
      i += 1;
      while (i < source.length && source[i] !== '"') {
        if (source[i] === '\\') {
          const esc = source[i + 1]!;
          if (esc === 'n') text += '\n';
          else if (esc === 't') text += '\t';
          else if (esc === 'r') text += '\r';
          else if (esc === 'b') text += '\b';
          else if (esc === 'f') text += '\f';
          else if (esc === 'u') {
            text += String.fromCharCode(parseInt(source.slice(i + 2, i + 6), 16));
            i += 4;
          } else text += esc;
          i += 2;
        } else {
          text += source[i];
          i += 1;
        }
      }
      i += 1;
      tokens.push({ kind: 'string', value: text });
      continue;
    }
    if (/[0-9-]/.test(ch)) {
      const match = /^-?\d+(\.\d+)?([eE][+-]?\d+)?/.exec(source.slice(i))!;
      const value = match[0];
      tokens.push({ kind: match[0].includes('.') || /[eE]/.test(match[0]) ? 'float' : 'int', value });
      i += value.length;
      continue;
    }
    if (/[_A-Za-z]/.test(ch)) {
      const match = /^[_0-9A-Za-z]+/.exec(source.slice(i))!;
      tokens.push({ kind: 'name', value: match[0] });
      i += match[0].length;
      continue;
    }
    throw new Error(`unexpected character ${JSON.stringify(ch)}`);
  }
  tokens.push({ kind: 'eof', value: '' });
  return tokens;
}

// ---------------------------------------------------------------- parser

type ValueNode =
  | { kind: 'var'; name: string }
  | { kind: 'int'; value: number }
  | { kind: 'float'; value: number }
  | { kind: 'string'; value: string }
  | { kind: 'bool'; value: boolean }
  | { kind: 'null' }
  | { kind: 'enum'; value: string }
  | { kind: 'list'; items: ValueNode[] }
  | { kind: 'object'; fields: Record<string, ValueNode> };

interface FieldNode {
  kind: 'field';
  alias?: string;
  name: string;
  args: Record<string, ValueNode>;
  selectionSet?: SelectionNode[];
}
type SelectionNode =
  | FieldNode
  | { kind: 'inline'; typeCondition?: string; selectionSet: SelectionNode[] }
  | { kind: 'spread'; name: string };

interface OperationNode {
  op: 'query' | 'mutation';
  name?: string;
  selectionSet: SelectionNode[];
}
interface FragmentNode {
  typeCondition: string;
  selectionSet: SelectionNode[];
}

class Parser {
  private tokens: Token[];
  private pos = 0;

  constructor(source: string) {
    this.tokens = lex(source);
  }

  private peek(): Token {
    return this.tokens[this.pos]!;
  }

  private next(): Token {
    const token = this.tokens[this.pos]!;
    this.pos += 1;
    return token;
  }

  private expectPunct(value: string): void {
    const token = this.next();
    if (token.kind !== 'punct' || token.value !== value) throw new Error(`expected ${value}, got ${token.value}`);
  }

  private atPunct(value: string): boolean {
    const token = this.peek();
    return token.kind === 'punct' && token.value === value;
  }

  parseDocument(): { operations: OperationNode[]; fragments: Map<string, FragmentNode> } {
    const operations: OperationNode[] = [];
    const fragments = new Map<string, FragmentNode>();
    while (this.peek().kind !== 'eof') {
      const token = this.peek();
      if (token.kind === 'punct' && token.value === '{') {
        operations.push({ op: 'query', selectionSet: this.parseSelectionSet() });
      } else if (token.kind === 'name' && (token.value === 'query' || token.value === 'mutation')) {
        this.next();
        let name: string | undefined;
        if (this.peek().kind === 'name') name = this.next().value;
        if (this.atPunct('(')) this.parseVariableDefinitions();
        this.skipDirectives();
        operations.push({ op: token.value, name, selectionSet: this.parseSelectionSet() });
      } else if (token.kind === 'name' && token.value === 'fragment') {
        this.next();
        const fragName = this.next().value;
        const onToken = this.next();
        if (onToken.value !== 'on') throw new Error('fragment without on');
        const typeCondition = this.next().value;
        this.skipDirectives();
        fragments.set(fragName, { typeCondition, selectionSet: this.parseSelectionSet() });
      } else {
        throw new Error(`unexpected token ${token.value}`);
      }
    }
    return { operations, fragments };
  }

  private parseVariableDefinitions(): void {
    this.expectPunct('(');
    while (!this.atPunct(')')) {
      this.expectPunct('$');
      this.next(); // variable name
      this.expectPunct(':');
      this.parseType();
      if (this.atPunct('=')) {
        this.next();
        this.parseValue();
      }
      this.skipDirectives();
    }
    this.expectPunct(')');
  }

  private parseType(): void {
    if (this.atPunct('[')) {
      this.next();
      this.parseType();
      this.expectPunct(']');
    } else {
      this.next();
    }
    if (this.atPunct('!')) this.next();
  }

  private skipDirectives(): void {
    while (this.atPunct('@')) {
      this.next();
      this.next(); // directive name
      if (this.atPunct('(')) this.parseArguments();
    }
  }

  private parseArguments(): Record<string, ValueNode> {
    const args: Record<string, ValueNode> = {};
    this.expectPunct('(');
    while (!this.atPunct(')')) {
      const name = this.next().value;
      this.expectPunct(':');
      args[name] = this.parseValue();
    }
    this.expectPunct(')');
    return args;
  }

  private parseValue(): ValueNode {
    const token = this.next();
    if (token.kind === 'punct' && token.value === '$') return { kind: 'var', name: this.next().value };
    if (token.kind === 'int') return { kind: 'int', value: Number(token.value) };
    if (token.kind === 'float') return { kind: 'float', value: Number(token.value) };
    if (token.kind === 'string') return { kind: 'string', value: token.value };
    if (token.kind === 'punct' && token.value === '[') {
      const items: ValueNode[] = [];
      while (!this.atPunct(']')) items.push(this.parseValue());
      this.expectPunct(']');
      return { kind: 'list', items };
    }
    if (token.kind === 'punct' && token.value === '{') {
      const fields: Record<string, ValueNode> = {};
      while (!this.atPunct('}')) {
        const name = this.next().value;
        this.expectPunct(':');
        fields[name] = this.parseValue();
      }
      this.expectPunct('}');
      return { kind: 'object', fields };
    }
    if (token.kind === 'name') {
      if (token.value === 'true') return { kind: 'bool', value: true };
      if (token.value === 'false') return { kind: 'bool', value: false };
      if (token.value === 'null') return { kind: 'null' };
      return { kind: 'enum', value: token.value };
    }
    throw new Error(`unexpected value token ${token.value}`);
  }

  private parseSelectionSet(): SelectionNode[] {
    this.expectPunct('{');
    const selections: SelectionNode[] = [];
    while (!this.atPunct('}')) selections.push(this.parseSelection());
    this.expectPunct('}');
    return selections;
  }

  private parseSelection(): SelectionNode {
    const token = this.peek();
    if (token.kind === 'spread') {
      this.next();
      if (this.peek().kind === 'name' && this.peek().value === 'on') {
        this.next();
        const typeCondition = this.next().value;
        this.skipDirectives();
        return { kind: 'inline', typeCondition, selectionSet: this.parseSelectionSet() };
      }
      const name = this.next().value;
      this.skipDirectives();
      return { kind: 'spread', name };
    }
    let name = this.next().value;
    let alias: string | undefined;
    if (this.atPunct(':')) {
      this.next();
      alias = name;
      name = this.next().value;
    }
    const args = this.atPunct('(') ? this.parseArguments() : {};
    this.skipDirectives();
    const selectionSet = this.atPunct('{') ? this.parseSelectionSet() : undefined;
    return { kind: 'field', alias, name, args, selectionSet };
  }
}

// ---------------------------------------------------------------- values and ids

type Variables = Record<string, unknown>;

function resolveValue(node: ValueNode, variables: Variables): unknown {
  switch (node.kind) {
    case 'var':
      return variables[node.name] ?? null;
    case 'int':
    case 'float':
    case 'string':
    case 'bool':
    case 'enum':
      return node.value;
    case 'null':
      return null;
    case 'list':
      return node.items.map((item) => resolveValue(item, variables));
    case 'object': {
      const out: Record<string, unknown> = {};
      for (const [key, value] of Object.entries(node.fields)) out[key] = resolveValue(value, variables);
      return out;
    }
  }
}

/** Opaque, stable global ids: base64 of a typed locator. Never the plain database id. */
export function globalId(type: string, ...parts: Array<string | number>): string {
  return Buffer.from([type, ...parts.map(String)].join(':'), 'utf8').toString('base64');
}

export function decodeGlobalId(id: string): { type: string; parts: string[] } | null {
  try {
    const text = Buffer.from(id, 'base64').toString('utf8');
    const [type, ...parts] = text.split(':');
    if (type === undefined || parts.length === 0) return null;
    return { type, parts };
  } catch {
    return null;
  }
}

// ---------------------------------------------------------------- object wrappers

interface Wrapped {
  __type: string;
  [key: string]: unknown;
}

const wrap = (type: string, fields: Record<string, unknown>): Wrapped => ({ __type: type, ...fields });
const userWrap = (): Wrapped => wrap('User', { login: VIEWER.login });
const repoWrap = (repo: RepoRec): Wrapped => wrap('Repository', { repo });
const issueWrap = (repo: RepoRec, issue: IssueRec): Wrapped => wrap('Issue', { repo, issue });
const pullWrap = (repo: RepoRec, pull: PullRec): Wrapped => wrap('PullRequest', { repo, pull });

// ---------------------------------------------------------------- connections

interface ConnectionSource {
  items: Wrapped[];
  /** The key each item paginates by (its number within the repository). */
  keys: number[];
  args: Record<string, unknown>;
}

function connection(items: Wrapped[], keys: number[], args: Record<string, unknown>): Wrapped {
  return wrap('Connection', { source: { items, keys, args } satisfies ConnectionSource });
}

function cursorFor(key: number): string {
  return Buffer.from(`cursor:${key}`, 'utf8').toString('base64');
}

function pageOf(source: ConnectionSource): { slice: Wrapped[]; hasNextPage: boolean; endCursor: string | null; startIndex: number } {
  const first = typeof source.args.first === 'number' ? Math.max(0, Math.trunc(source.args.first)) : source.items.length;
  let start = 0;
  const after = source.args.after;
  if (typeof after === 'string' && after !== '') {
    try {
      const text = Buffer.from(after, 'base64').toString('utf8');
      const key = Number(text.replace(/^cursor:/, ''));
      const index = source.keys.indexOf(key);
      if (index !== -1) start = index + 1;
    } catch {
      start = 0;
    }
  }
  const slice = source.items.slice(start, start + first);
  const lastKey = slice.length > 0 ? source.keys[start + slice.length - 1]! : null;
  return { slice, hasNextPage: start + slice.length < source.items.length, endCursor: lastKey === null ? null : cursorFor(lastKey), startIndex: start };
}

// ---------------------------------------------------------------- introspection tables

const TYPE_FIELDS: Readonly<Record<string, readonly string[]>> = Object.freeze({
  Issue: ['id', 'databaseId', 'number', 'title', 'state', 'body', 'labels', 'comments', 'repository', 'author', 'createdAt', 'updatedAt', 'closedAt', 'url'],
  PullRequest: ['id', 'databaseId', 'number', 'title', 'body', 'state', 'merged', 'mergeable', 'headRefName', 'baseRefName', 'headRefOid', 'baseRefOid', 'files', 'repository', 'author', 'createdAt', 'updatedAt', 'mergedAt', 'additions', 'deletions', 'changedFiles'],
  Repository: ['id', 'databaseId', 'name', 'nameWithOwner', 'owner', 'description', 'isPrivate', 'defaultBranchRef', 'viewerPermission', 'hasIssuesEnabled', 'issue', 'issues', 'pullRequest', 'pullRequests', 'createdAt', 'updatedAt', 'url', 'isEmpty', 'primaryLanguage'],
  User: ['id', 'login', 'name', 'email', 'url', 'createdAt'],
  Ref: ['name', 'prefix', 'target'],
  IssueComment: ['id', 'body', 'author', 'createdAt', 'updatedAt'],
  Query: ['viewer', 'repository', 'node', 'search', 'rateLimit'],
  Mutation: ['createIssue', 'closeIssue', 'createPullRequest', 'mergePullRequest', 'addComment'],
});

const ENUM_VALUES: Readonly<Record<string, readonly string[]>> = Object.freeze({
  SearchType: ['ISSUE', 'REPOSITORY', 'USER'],
  IssueState: ['OPEN', 'CLOSED'],
  PullRequestState: ['OPEN', 'CLOSED', 'MERGED'],
  MergeableState: ['MERGEABLE', 'CONFLICTING', 'UNKNOWN'],
  RepositoryPermission: ['ADMIN', 'MAINTAIN', 'WRITE', 'TRIAGE', 'READ'],
  OrderDirection: ['ASC', 'DESC'],
  PullRequestMergeMethod: ['MERGE', 'SQUASH', 'REBASE'],
});

// ---------------------------------------------------------------- resolvers

interface Ctx {
  variables: Variables;
  fragments: Map<string, FragmentNode>;
  errors: Array<{ message: string }>;
}

type Resolver = (source: Wrapped, args: Record<string, unknown>, ctx: Ctx) => unknown;

function repoOf(source: Wrapped): RepoRec {
  return source.repo as RepoRec;
}

function isoFromSeq(seq: number): string {
  return new Date(1_735_689_600_000 + seq * 1000).toISOString();
}

function issueConnection(repo: RepoRec, args: Record<string, unknown>): Wrapped {
  let issues = [...repo.issues.values()];
  const states = args.states;
  if (Array.isArray(states) && states.length > 0) {
    const wanted = new Set(states.map((state) => String(state).toLowerCase()));
    issues = issues.filter((issue) => wanted.has(issue.state));
  }
  const orderBy = (args.orderBy ?? {}) as { field?: string; direction?: string };
  const direction = typeof orderBy.direction === 'string' ? orderBy.direction : 'DESC';
  issues.sort((a, b) => (direction === 'ASC' ? a.createdSeq - b.createdSeq : b.createdSeq - a.createdSeq));
  return connection(
    issues.map((issue) => issueWrap(repo, issue)),
    issues.map((issue) => issue.number),
    args,
  );
}

function pullConnection(repo: RepoRec, args: Record<string, unknown>): Wrapped {
  let pulls = [...repo.pulls.values()];
  const states = args.states;
  if (Array.isArray(states) && states.length > 0) {
    const wanted = new Set(states.map((state) => String(state).toUpperCase()));
    pulls = pulls.filter((pull) => {
      if (pull.merged) return wanted.has('MERGED');
      return wanted.has(pull.state.toUpperCase());
    });
  }
  pulls.sort((a, b) => b.createdSeq - a.createdSeq);
  return connection(
    pulls.map((pull) => pullWrap(repo, pull)),
    pulls.map((pull) => pull.number),
    args,
  );
}

const RESOLVERS: Record<string, Record<string, Resolver>> = {
  Query: {
    viewer: () => userWrap(),
    repository: (_source, args) => {
      const repo = findRepo(String(args.owner ?? ''), String(args.name ?? ''));
      return repo === undefined ? null : repoWrap(repo);
    },
    node: (_source, args) => resolveNode(String(args.id ?? '')),
    __type: (_source, args) => {
      const name = String(args.name ?? '');
      if (TYPE_FIELDS[name] !== undefined) return wrap('__Type', { name, kind: 'OBJECT' });
      if (ENUM_VALUES[name] !== undefined) return wrap('__Type', { name, kind: 'ENUM' });
      return null;
    },
    __schema: () => wrap('__Schema', {}),
    search: (_source, args) => connection([], [], args),
  },
  Mutation: {
    createIssue: (_source, args, ctx) => {
      const input = (args.input ?? {}) as Record<string, unknown>;
      const decoded = decodeGlobalId(String(input.repositoryId ?? ''));
      const repo = decoded?.type === 'Repository' ? findRepo(VIEWER.login, repoNameById(Number(decoded.parts[0]))) : undefined;
      if (repo === undefined) {
        ctx.errors.push({ message: 'repository not found for createIssue' });
        return wrap('CreateIssuePayload', { issue: null });
      }
      const created = createIssueRecord(repo, { title: String(input.title ?? ''), body: String(input.body ?? '') });
      if ('error' in created) {
        ctx.errors.push({ message: created.error });
        return wrap('CreateIssuePayload', { issue: null });
      }
      return wrap('CreateIssuePayload', { issue: issueWrap(repo, created.issue) });
    },
    closeIssue: (_source, args, ctx) => {
      const input = (args.input ?? {}) as Record<string, unknown>;
      const located = locateIssue(String(input.issueId ?? ''));
      if (located === null) {
        ctx.errors.push({ message: 'issue not found for closeIssue' });
        return wrap('CloseIssuePayload', { issue: null });
      }
      located.issue.state = 'closed';
      return wrap('CloseIssuePayload', { issue: issueWrap(located.repo, located.issue) });
    },
    createPullRequest: (_source, args, ctx) => {
      const input = (args.input ?? {}) as Record<string, unknown>;
      const decoded = decodeGlobalId(String(input.repositoryId ?? ''));
      const repo = decoded?.type === 'Repository' ? findRepo(VIEWER.login, repoNameById(Number(decoded.parts[0]))) : undefined;
      if (repo === undefined) {
        ctx.errors.push({ message: 'repository not found for createPullRequest' });
        return wrap('CreatePullRequestPayload', { pullRequest: null });
      }
      const created = createPullRecord(repo, {
        title: String(input.title ?? ''),
        body: String(input.body ?? ''),
        head: String(input.headRefName ?? ''),
        base: String(input.baseRefName ?? ''),
      });
      if ('error' in created) {
        ctx.errors.push({ message: created.error });
        return wrap('CreatePullRequestPayload', { pullRequest: null });
      }
      return wrap('CreatePullRequestPayload', { pullRequest: pullWrap(repo, created.pull) });
    },
    mergePullRequest: (_source, args, ctx) => {
      const input = (args.input ?? {}) as Record<string, unknown>;
      const located = locatePull(String(input.pullRequestId ?? ''));
      if (located === null) {
        ctx.errors.push({ message: 'pull request not found for mergePullRequest' });
        return wrap('MergePullRequestPayload', { pullRequest: null });
      }
      const method = String(input.mergeMethod ?? 'SQUASH').toLowerCase();
      const merged = mergePullRecord(located.repo, located.pull, method === 'merge' ? 'merge' : 'squash');
      if ('conflict' in merged) {
        ctx.errors.push({ message: 'Pull Request is not mergeable' });
        return wrap('MergePullRequestPayload', { pullRequest: pullWrap(located.repo, located.pull) });
      }
      if ('error' in merged) {
        ctx.errors.push({ message: merged.error });
        return wrap('MergePullRequestPayload', { pullRequest: pullWrap(located.repo, located.pull) });
      }
      return wrap('MergePullRequestPayload', { pullRequest: pullWrap(located.repo, located.pull) });
    },
    addComment: (_source, args, ctx) => {
      const input = (args.input ?? {}) as Record<string, unknown>;
      const located = locateIssue(String(input.subjectId ?? ''));
      if (located === null) {
        ctx.errors.push({ message: 'subject not found for addComment' });
        return wrap('AddCommentPayload', { commentEdge: null });
      }
      const comment = { id: nextCommentId(), body: String(input.body ?? ''), createdSeq: nextSeq() };
      located.issue.comments.push(comment);
      const node = wrap('IssueComment', { repo: located.repo, issue: located.issue, comment });
      return wrap('AddCommentPayload', { commentEdge: wrap('IssueCommentEdge', { node }) });
    },
  },
  User: {
    id: () => globalId('User', VIEWER.login),
    login: () => VIEWER.login,
    name: () => VIEWER.name,
    email: () => VIEWER.email,
  },
  Repository: {
    id: (source) => globalId('Repository', repoOf(source).id),
    databaseId: (source) => repoOf(source).id,
    name: (source) => repoOf(source).name,
    nameWithOwner: (source) => `${repoOf(source).owner}/${repoOf(source).name}`,
    description: (source) => repoOf(source).description,
    isPrivate: (source) => repoOf(source).isPrivate,
    owner: () => userWrap(),
    defaultBranchRef: (source) => {
      const repo = repoOf(source);
      if (branchTip(repo, repo.defaultBranch) === undefined) return null;
      return wrap('Ref', { name: repo.defaultBranch, prefix: 'refs/heads/' });
    },
    viewerPermission: () => 'ADMIN',
    hasIssuesEnabled: () => true,
    isEmpty: (source) => branchTip(repoOf(source), repoOf(source).defaultBranch) === undefined,
    createdAt: (source) => isoFromSeq(repoOf(source).createdSeq),
    updatedAt: (source) => isoFromSeq(repoOf(source).createdSeq),
    issue: (source, args) => {
      const repo = repoOf(source);
      const issue = repo.issues.get(Number(args.number));
      return issue === undefined ? null : issueWrap(repo, issue);
    },
    issues: (source, args) => issueConnection(repoOf(source), args),
    pullRequest: (source, args) => {
      const repo = repoOf(source);
      const pull = repo.pulls.get(Number(args.number));
      return pull === undefined ? null : pullWrap(repo, pull);
    },
    pullRequests: (source, args) => pullConnection(repoOf(source), args),
  },
  Issue: {
    id: (source) => globalId('Issue', (source.repo as RepoRec).id, (source.issue as IssueRec).number),
    databaseId: (source) => (source.issue as IssueRec).id,
    number: (source) => (source.issue as IssueRec).number,
    title: (source) => (source.issue as IssueRec).title,
    body: (source) => (source.issue as IssueRec).body,
    state: (source) => ((source.issue as IssueRec).state === 'open' ? 'OPEN' : 'CLOSED'),
    repository: (source) => repoWrap(source.repo as RepoRec),
    author: () => userWrap(),
    createdAt: (source) => isoFromSeq((source.issue as IssueRec).createdSeq),
    updatedAt: (source) => isoFromSeq((source.issue as IssueRec).createdSeq),
    closedAt: (source) => ((source.issue as IssueRec).state === 'closed' ? isoFromSeq((source.issue as IssueRec).createdSeq) : null),
    labels: (source, args) => {
      const repo = source.repo as RepoRec;
      const issue = source.issue as IssueRec;
      const labels = issue.labels.map((name) => wrap('Label', { name, color: repo.labels.get(name)?.color ?? 'ededed' }));
      return connection(labels, labels.map((_, index) => index + 1), args);
    },
    comments: (source, args) => {
      const repo = source.repo as RepoRec;
      const issue = source.issue as IssueRec;
      const comments = issue.comments.map((comment) => wrap('IssueComment', { repo, issue, comment }));
      return connection(comments, comments.map((comment) => (comment.comment as { id: number }).id), args);
    },
  },
  PullRequest: {
    id: (source) => globalId('PullRequest', (source.repo as RepoRec).id, (source.pull as PullRec).number),
    databaseId: (source) => (source.pull as PullRec).id,
    number: (source) => (source.pull as PullRec).number,
    title: (source) => (source.pull as PullRec).title,
    body: (source) => (source.pull as PullRec).body,
    state: (source) => {
      const pull = source.pull as PullRec;
      return pull.merged ? 'MERGED' : pull.state.toUpperCase();
    },
    merged: (source) => (source.pull as PullRec).merged,
    mergeable: (source) => {
      const repo = source.repo as RepoRec;
      const pull = source.pull as PullRec;
      if (pull.state !== 'open') return 'UNKNOWN';
      return pullMergeable(repo, pull) ? 'MERGEABLE' : 'CONFLICTING';
    },
    headRefName: (source) => (source.pull as PullRec).headRef,
    baseRefName: (source) => (source.pull as PullRec).baseRef,
    headRefOid: (source) => branchTip(source.repo as RepoRec, (source.pull as PullRec).headRef) ?? (source.pull as PullRec).headShaSnapshot,
    baseRefOid: (source) => branchTip(source.repo as RepoRec, (source.pull as PullRec).baseRef) ?? (source.pull as PullRec).baseShaSnapshot,
    repository: (source) => repoWrap(source.repo as RepoRec),
    author: () => userWrap(),
    createdAt: (source) => isoFromSeq((source.pull as PullRec).createdSeq),
    updatedAt: (source) => isoFromSeq((source.pull as PullRec).createdSeq),
    mergedAt: (source) => (source.pull as PullRec).mergedAt,
    files: (source, args) => {
      const repo = source.repo as RepoRec;
      const pull = source.pull as PullRec;
      const files = pullFiles(repo, pull).map((file) => wrap('PullRequestFile', { path: file.filename, additions: file.additions, deletions: file.deletions }));
      return connection(files, files.map((_, index) => index + 1), args);
    },
  },
  Ref: {
    name: (source) => source.name,
    prefix: (source) => source.prefix ?? 'refs/heads/',
  },
  Label: {
    id: (source) => globalId('Label', String(source.name)),
    name: (source) => source.name,
    color: (source) => source.color,
  },
  IssueComment: {
    id: (source) => globalId('IssueComment', (source.comment as { id: number }).id),
    body: (source) => (source.comment as { body: string }).body,
    author: () => userWrap(),
    createdAt: (source) => isoFromSeq((source.comment as { createdSeq: number }).createdSeq),
    updatedAt: (source) => isoFromSeq((source.comment as { createdSeq: number }).createdSeq),
  },
  PullRequestFile: {
    path: (source) => source.path,
    additions: (source) => source.additions,
    deletions: (source) => source.deletions,
  },
  Connection: {
    nodes: (source) => pageOf(source.source as ConnectionSource).slice,
    edges: (source) => {
      const conn = source.source as ConnectionSource;
      const page = pageOf(conn);
      return page.slice.map((node, index) => wrap('Edge', { node, cursor: cursorFor(conn.keys[page.startIndex + index]!) }));
    },
    pageInfo: (source) => {
      const page = pageOf(source.source as ConnectionSource);
      return wrap('PageInfo', { hasNextPage: page.hasNextPage, hasPreviousPage: page.startIndex > 0, endCursor: page.endCursor, startCursor: page.endCursor });
    },
    totalCount: (source) => (source.source as ConnectionSource).items.length,
  },
  PageInfo: {
    hasNextPage: (source) => source.hasNextPage,
    hasPreviousPage: (source) => source.hasPreviousPage,
    endCursor: (source) => source.endCursor,
    startCursor: (source) => source.startCursor,
  },
  Edge: {
    node: (source) => source.node,
    cursor: (source) => source.cursor,
  },
  IssueCommentEdge: {
    node: (source) => source.node,
    cursor: () => cursorFor(0),
  },
  CreateIssuePayload: { issue: (source) => source.issue },
  CloseIssuePayload: { issue: (source) => source.issue },
  CreatePullRequestPayload: { pullRequest: (source) => source.pullRequest },
  MergePullRequestPayload: { pullRequest: (source) => source.pullRequest },
  AddCommentPayload: { commentEdge: (source) => source.commentEdge },
  __Type: {
    name: (source) => source.name,
    kind: (source) => source.kind,
    description: () => null,
    fields: (source) => (TYPE_FIELDS[String(source.name)] ?? []).map((name) => wrap('__Field', { name })),
    enumValues: (source) => (ENUM_VALUES[String(source.name)] ?? []).map((name) => wrap('__EnumValue', { name })),
    possibleTypes: () => [],
    inputFields: () => [],
    ofType: () => null,
    interfaces: () => [],
  },
  __Field: {
    name: (source) => source.name,
    description: () => null,
    args: () => [],
    type: () => null,
    isDeprecated: () => false,
    deprecationReason: () => null,
  },
  __EnumValue: {
    name: (source) => source.name,
    description: () => null,
    isDeprecated: () => false,
    deprecationReason: () => null,
  },
  __Schema: {
    types: () => Object.keys(TYPE_FIELDS).map((name) => wrap('__Type', { name, kind: 'OBJECT' })),
    queryType: () => wrap('__Type', { name: 'Query', kind: 'OBJECT' }),
    mutationType: () => wrap('__Type', { name: 'Mutation', kind: 'OBJECT' }),
    subscriptionType: () => null,
    directives: () => [],
  },
};

// Repository lookup by database id (mutation inputs carry global ids, not names).
function repoNameById(id: number): string {
  const repo = reposOf(VIEWER.login).find((candidate) => candidate.id === id);
  return repo?.name ?? '';
}

function locateIssue(globalIdValue: string): { repo: RepoRec; issue: IssueRec } | null {
  const decoded = decodeGlobalId(globalIdValue);
  if (decoded === null || decoded.type !== 'Issue') return null;
  const repo = reposOf(VIEWER.login).find((candidate) => candidate.id === Number(decoded.parts[0]));
  if (repo === undefined) return null;
  const issue = repo.issues.get(Number(decoded.parts[1]));
  return issue === undefined ? null : { repo, issue };
}

function locatePull(globalIdValue: string): { repo: RepoRec; pull: PullRec } | null {
  const decoded = decodeGlobalId(globalIdValue);
  if (decoded === null || decoded.type !== 'PullRequest') return null;
  const repo = reposOf(VIEWER.login).find((candidate) => candidate.id === Number(decoded.parts[0]));
  if (repo === undefined) return null;
  const pull = repo.pulls.get(Number(decoded.parts[1]));
  return pull === undefined ? null : { repo, pull };
}

function resolveNode(id: string): Wrapped | null {
  const decoded = decodeGlobalId(id);
  if (decoded === null) return null;
  if (decoded.type === 'Repository') {
    const repo = reposOf(VIEWER.login).find((candidate) => candidate.id === Number(decoded.parts[0]));
    return repo === undefined ? null : repoWrap(repo);
  }
  if (decoded.type === 'Issue') {
    const located = locateIssue(id);
    return located === null ? null : issueWrap(located.repo, located.issue);
  }
  if (decoded.type === 'PullRequest') {
    const located = locatePull(id);
    return located === null ? null : pullWrap(located.repo, located.pull);
  }
  if (decoded.type === 'User') return userWrap();
  return null;
}


// ---------------------------------------------------------------- executor

const NODE_TYPES = new Set(['Repository', 'Issue', 'PullRequest', 'User', 'IssueComment', 'Label']);

function executeSelectionSet(typeName: string, source: Wrapped, selections: readonly SelectionNode[], ctx: Ctx): Record<string, unknown> {
  const out: Record<string, unknown> = {};
  for (const selection of selections) {
    if (selection.kind === 'inline' || selection.kind === 'spread') {
      const condition = selection.kind === 'inline' ? selection.typeCondition : ctx.fragments.get(selection.name)?.typeCondition;
      const set = selection.kind === 'inline' ? selection.selectionSet : ctx.fragments.get(selection.name)?.selectionSet;
      if (set === undefined) continue;
      if (condition !== undefined && condition !== typeName && !(condition === 'Node' && NODE_TYPES.has(typeName))) continue;
      Object.assign(out, executeSelectionSet(typeName, source, set, ctx));
      continue;
    }
    const key = selection.alias ?? selection.name;
    out[key] = executeField(typeName, source, selection, ctx);
  }
  return out;
}

function executeField(typeName: string, source: Wrapped, field: FieldNode, ctx: Ctx): unknown {
  if (field.name === '__typename') return typeName;
  const args: Record<string, unknown> = {};
  for (const [name, value] of Object.entries(field.args)) args[name] = resolveValue(value, ctx.variables);
  const resolver = RESOLVERS[typeName]?.[field.name];
  let value: unknown;
  if (resolver !== undefined) {
    value = resolver(source, args, ctx);
  } else if (field.name in source && field.name !== '__type') {
    value = source[field.name];
  } else {
    ctx.errors.push({ message: `Field '${field.name}' doesn't exist on type '${typeName}'` });
    return null;
  }
  return completeValue(value, field, ctx);
}

function completeValue(value: unknown, field: FieldNode, ctx: Ctx): unknown {
  if (value === null || value === undefined) return null;
  if (Array.isArray(value)) return value.map((item) => completeValue(item, field, ctx));
  if (typeof value === 'object') {
    const wrapped = value as Wrapped;
    if (typeof wrapped.__type === 'string') {
      if (field.selectionSet === undefined) return null;
      return executeSelectionSet(wrapped.__type, wrapped, field.selectionSet, ctx);
    }
    return value;
  }
  return value;
}

export interface GraphQLResult {
  data?: Record<string, unknown> | null;
  errors?: Array<{ message: string }>;
}

/** Execute one GraphQL document (one operation) against the forge. */
export function executeGraphQL(query: string, variables: Variables, operationName?: string): GraphQLResult {
  let parsed: { operations: OperationNode[]; fragments: Map<string, FragmentNode> };
  try {
    parsed = new Parser(query).parseDocument();
  } catch (error) {
    return { errors: [{ message: error instanceof Error ? error.message : String(error) }] };
  }
  const operation = parsed.operations.find((candidate) => operationName === undefined || candidate.name === operationName) ?? parsed.operations[0];
  if (operation === undefined) return { errors: [{ message: 'no operation in document' }] };
  const ctx: Ctx = { variables, fragments: parsed.fragments, errors: [] };
  const rootType = operation.op === 'mutation' ? 'Mutation' : 'Query';
  const data = executeSelectionSet(rootType, wrap(rootType, {}), operation.selectionSet, ctx);
  const result: GraphQLResult = { data };
  if (ctx.errors.length > 0) result.errors = ctx.errors;
  return result;
}
