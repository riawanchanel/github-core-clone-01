// The forge's data model: a content-addressed git object store plus the repository / issue /
// pull-request records the REST, GraphQL and MCP surfaces all share. Everything is in memory;
// the trial pod is one process and the suite builds all of its data through the API.

import { createHash } from 'node:crypto';

export const VIEWER = Object.freeze({
  id: 1000,
  login: 'adaiversen',
  name: 'ada iversen',
  email: 'adaiversen@example.invalid',
});

export const ZERO_OID = '0'.repeat(40);

// ---------------------------------------------------------------- git object store

export type ObjType = 'commit' | 'tree' | 'blob' | 'tag';
export const OBJ_TYPE_IDS: Readonly<Record<ObjType, number>> = Object.freeze({ commit: 1, tree: 2, blob: 3, tag: 4 });
export const OBJ_TYPE_BY_ID: readonly ObjType[] = ['', 'commit', 'tree', 'blob', 'tag'] as unknown as readonly ObjType[];

export interface GitObj {
  type: ObjType;
  data: Buffer;
}

/** Every object the forge holds, by sha1 — shared across repositories, as in git. */
export const objects = new Map<string, GitObj>();

export function objectId(type: ObjType, data: Buffer): string {
  const hash = createHash('sha1');
  hash.update(`${type} ${data.length}\0`, 'utf8');
  hash.update(data);
  return hash.digest('hex');
}

/** Store an object (idempotent) and return its id. */
export function storeObject(type: ObjType, data: Buffer): string {
  const sha = objectId(type, data);
  if (!objects.has(sha)) objects.set(sha, { type, data });
  return sha;
}

export function getObject(sha: string): GitObj | undefined {
  return objects.get(sha);
}

// ---------------------------------------------------------------- commits and trees

export interface CommitInfo {
  tree: string;
  parents: string[];
  author: string;
  committer: string;
  /** Committer/author timestamp, seconds (from the committer line). */
  time: number;
  message: string;
}

const commitCache = new Map<string, CommitInfo>();

/** Parse a commit object (cached). Null when the object is missing or not a commit. */
export function parseCommit(sha: string): CommitInfo | null {
  const cached = commitCache.get(sha);
  if (cached !== undefined) return cached;
  const obj = objects.get(sha);
  if (obj === undefined || obj.type !== 'commit') return null;
  const text = obj.data.toString('utf8');
  const split = text.indexOf('\n\n');
  const header = split === -1 ? text : text.slice(0, split);
  const message = split === -1 ? '' : text.slice(split + 2);
  let tree = '';
  const parents: string[] = [];
  let author = '';
  let committer = '';
  for (const line of header.split('\n')) {
    if (line.startsWith('tree ')) tree = line.slice(5).trim();
    else if (line.startsWith('parent ')) parents.push(line.slice(7).trim());
    else if (line.startsWith('author ')) author = line.slice(7);
    else if (line.startsWith('committer ')) committer = line.slice(10);
  }
  const timeMatch = / (\d+) [+-]\d{4}$/.exec(committer);
  const info: CommitInfo = { tree, parents, author, committer, time: timeMatch === null ? 0 : Number(timeMatch[1]), message };
  commitCache.set(sha, info);
  return info;
}

/** Split an author/committer line into name, email and ISO date. */
export function parseIdent(line: string): { name: string; email: string; date: string } {
  const match = /^(.*?) <(.*?)> (\d+) [+-]\d{4}$/.exec(line);
  if (match === null) return { name: line, email: '', date: new Date(0).toISOString() };
  return { name: match[1] ?? '', email: match[2] ?? '', date: new Date(Number(match[3]) * 1000).toISOString() };
}

/** Create a commit object over `tree` and return its sha. */
export function createCommit(input: { tree: string; parents: string[]; message: string; time?: number }): string {
  const when = input.time ?? Math.floor(Date.now() / 1000);
  const ident = `${VIEWER.name} <${VIEWER.email}> ${when} +0000`;
  let text = `tree ${input.tree}\n`;
  for (const parent of input.parents) text += `parent ${parent}\n`;
  text += `author ${ident}\ncommitter ${ident}\n\n${input.message}`;
  return storeObject('commit', Buffer.from(text, 'utf8'));
}

export interface TreeEntry {
  mode: string;
  name: string;
  sha: string;
}

/** Parse a tree object's entries, in stored order. */
export function parseTree(data: Buffer): TreeEntry[] {
  const entries: TreeEntry[] = [];
  let offset = 0;
  while (offset < data.length) {
    const space = data.indexOf(0x20, offset);
    if (space === -1) break;
    const mode = data.toString('utf8', offset, space);
    const nul = data.indexOf(0x00, space + 1);
    if (nul === -1 || nul + 21 > data.length) break;
    const name = data.toString('utf8', space + 1, nul);
    const sha = data.toString('hex', nul + 1, nul + 21);
    entries.push({ mode, name, sha });
    offset = nul + 21;
  }
  return entries;
}

export interface FlatEntry {
  sha: string;
  mode: string;
}

const flatCache = new Map<string, Map<string, FlatEntry>>();

/** Flatten a tree (recursively) into path -> blob entry. Cached by tree sha. */
export function flattenTree(treeSha: string): Map<string, FlatEntry> {
  const cached = flatCache.get(treeSha);
  if (cached !== undefined) return cached;
  const out = new Map<string, FlatEntry>();
  const walk = (sha: string, prefix: string): void => {
    const obj = objects.get(sha);
    if (obj === undefined || obj.type !== 'tree') return;
    for (const entry of parseTree(obj.data)) {
      if (entry.mode === '40000') walk(entry.sha, `${prefix}${entry.name}/`);
      else out.set(`${prefix}${entry.name}`, { sha: entry.sha, mode: entry.mode });
    }
  };
  if (treeSha !== '') walk(treeSha, '');
  flatCache.set(treeSha, out);
  return out;
}

/** Git's tree-entry order: by name, directories as if they ended in '/'. */
function treeSortKey(entry: { name: string; mode: string }): string {
  return entry.mode === '40000' ? `${entry.name}/` : entry.name;
}

/** Build (and store) a tree object from flattened paths; returns the tree sha. */
export function buildTree(flat: ReadonlyMap<string, FlatEntry>): string {
  interface Node {
    files: Map<string, FlatEntry>;
    dirs: Map<string, Node>;
  }
  const root: Node = { files: new Map(), dirs: new Map() };
  for (const [path, entry] of flat) {
    const parts = path.split('/');
    let node = root;
    for (let i = 0; i < parts.length - 1; i += 1) {
      const part = parts[i]!;
      let next = node.dirs.get(part);
      if (next === undefined) {
        next = { files: new Map(), dirs: new Map() };
        node.dirs.set(part, next);
      }
      node = next;
    }
    node.files.set(parts[parts.length - 1]!, entry);
  }
  const build = (node: Node): string => {
    const entries: Array<{ mode: string; name: string; sha: string }> = [];
    for (const [name, entry] of node.files) entries.push({ mode: entry.mode, name, sha: entry.sha });
    for (const [name, child] of node.dirs) entries.push({ mode: '40000', name, sha: build(child) });
    entries.sort((a, b) => {
      const ka = treeSortKey(a);
      const kb = treeSortKey(b);
      return ka < kb ? -1 : ka > kb ? 1 : 0;
    });
    const chunks: Buffer[] = [];
    for (const entry of entries) {
      chunks.push(Buffer.from(`${entry.mode} ${entry.name}\0`, 'utf8'));
      chunks.push(Buffer.from(entry.sha, 'hex'));
    }
    return storeObject('tree', Buffer.concat(chunks));
  };
  return build(root);
}

/** The subtree sha at `prefix/` inside a tree, or null (used for directory listings). */
export function subtreeSha(treeSha: string, prefix: string): string | null {
  let current = treeSha;
  for (const part of prefix.split('/')) {
    const obj = objects.get(current);
    if (obj === undefined || obj.type !== 'tree') return null;
    const entry = parseTree(obj.data).find((candidate) => candidate.name === part && candidate.mode === '40000');
    if (entry === undefined) return null;
    current = entry.sha;
  }
  return current;
}

/** Every commit reachable from `tips` (following all parents), tips included. */
export function reachableCommits(tips: readonly string[], treatAsParentless?: ReadonlySet<string>): Set<string> {
  const seen = new Set<string>();
  const stack = [...tips];
  while (stack.length > 0) {
    const sha = stack.pop()!;
    if (seen.has(sha)) continue;
    const commit = parseCommit(sha);
    if (commit === null) continue;
    seen.add(sha);
    if (treatAsParentless !== undefined && treatAsParentless.has(sha)) continue;
    for (const parent of commit.parents) stack.push(parent);
  }
  return seen;
}

/** Whether `ancestor` is reachable from `descendant` (a fast-forward test). */
export function isAncestor(ancestor: string, descendant: string): boolean {
  if (ancestor === descendant) return true;
  return reachableCommits([descendant]).has(ancestor);
}

/** The best common ancestor of two commits (first found by BFS from `a`), or null. */
export function mergeBase(a: string, b: string): string | null {
  const fromB = reachableCommits([b]);
  const seen = new Set<string>();
  const queue = [a];
  while (queue.length > 0) {
    const sha = queue.shift()!;
    if (seen.has(sha)) continue;
    seen.add(sha);
    if (fromB.has(sha)) return sha;
    const commit = parseCommit(sha);
    if (commit !== null) queue.push(...commit.parents);
  }
  return null;
}

/** Follow a tag object chain to the commit it names (or return the sha itself). */
export function peelToCommit(sha: string): string {
  let current = sha;
  for (let guard = 0; guard < 16; guard += 1) {
    const obj = objects.get(current);
    if (obj === undefined || obj.type !== 'tag') return current;
    const match = /^object ([0-9a-f]{40})$/m.exec(obj.data.toString('utf8'));
    if (match === null) return current;
    current = match[1]!;
  }
  return current;
}

// ---------------------------------------------------------------- forge records

export interface LabelRec {
  name: string;
  color: string;
}

export interface CommentRec {
  id: number;
  body: string;
  createdSeq: number;
}

export interface IssueRec {
  kind: 'issue';
  id: number;
  number: number;
  title: string;
  body: string;
  state: 'open' | 'closed';
  labels: string[];
  comments: CommentRec[];
  createdSeq: number;
}

export interface PullRec {
  kind: 'pull';
  id: number;
  number: number;
  title: string;
  body: string;
  state: 'open' | 'closed';
  merged: boolean;
  headRef: string;
  baseRef: string;
  headShaSnapshot: string;
  baseShaSnapshot: string;
  mergedAt: string | null;
  mergeCommitSha: string | null;
  createdSeq: number;
}

export interface RepoRec {
  id: number;
  owner: string;
  name: string;
  description: string;
  isPrivate: boolean;
  defaultBranch: string;
  /** Full ref name ('refs/heads/main', 'refs/tags/v1') -> object sha. */
  refs: Map<string, string>;
  labels: Map<string, LabelRec>;
  issues: Map<number, IssueRec>;
  pulls: Map<number, PullRec>;
  /** The shared issue/PR number counter (GitHub numbers both from one sequence). */
  nextNumber: number;
  createdSeq: number;
}

let repoIdCounter = 0;
let issueIdCounter = 0;
let commentIdCounter = 0;
let sequence = 0;

export function nextSeq(): number {
  sequence += 1;
  return sequence;
}

export function nextCommentId(): number {
  commentIdCounter += 1;
  return commentIdCounter;
}

export function nextIssueId(): number {
  issueIdCounter += 1;
  return issueIdCounter;
}

const repos = new Map<string, RepoRec>();

export function repoKey(owner: string, name: string): string {
  return `${owner}/${name}`;
}

export function findRepo(owner: string, name: string): RepoRec | undefined {
  return repos.get(repoKey(owner, name));
}

export function createRepo(owner: string, name: string, description: string, isPrivate: boolean): RepoRec {
  repoIdCounter += 1;
  const repo: RepoRec = {
    id: repoIdCounter,
    owner,
    name,
    description,
    isPrivate,
    defaultBranch: 'main',
    refs: new Map(),
    labels: new Map(),
    issues: new Map(),
    pulls: new Map(),
    nextNumber: 1,
    createdSeq: nextSeq(),
  };
  repos.set(repoKey(owner, name), repo);
  return repo;
}

export function deleteRepo(owner: string, name: string): boolean {
  return repos.delete(repoKey(owner, name));
}

/** All repositories owned by `owner`, in creation order. */
export function reposOf(owner: string): RepoRec[] {
  return [...repos.values()].filter((repo) => repo.owner === owner).sort((a, b) => a.createdSeq - b.createdSeq);
}

/** The commit sha a branch points at, or undefined. */
export function branchTip(repo: RepoRec, branch: string): string | undefined {
  return repo.refs.get(`refs/heads/${branch}`);
}

/** The default branch's tip, or undefined for an unborn repository. */
export function headTip(repo: RepoRec): string | undefined {
  return repo.refs.get(`refs/heads/${repo.defaultBranch}`);
}

/** The flattened tree at a ref (branch name or commit sha); empty map when unborn/unknown. */
export function flatTreeAt(repo: RepoRec, ref: string): Map<string, FlatEntry> {
  let sha = repo.refs.get(`refs/heads/${ref}`) ?? repo.refs.get(ref) ?? ref;
  if (sha === undefined) return new Map();
  const obj = objects.get(sha);
  if (obj !== undefined && obj.type === 'tag') sha = peelToCommit(sha);
  const commit = parseCommit(sha);
  if (commit === null) return new Map();
  return flattenTree(commit.tree);
}
