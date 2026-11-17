// REST v3: repositories, branches, commits, contents, labels, issues, comments and pull
// requests, in the shapes checks-rest.ts asserts. The record operations (create issue / pull,
// merge, file diff, contents write) are exported: GraphQL and MCP are other views of the
// same records and call them too.

import {
  VIEWER,
  ZERO_OID,
  branchTip,
  buildTree,
  createCommit,
  findRepo,
  createRepo as createRepoRecord,
  deleteRepo as deleteRepoRecord,
  reposOf,
  flattenTree,
  flatTreeAt,
  getObject,
  headTip,
  isAncestor,
  mergeBase,
  nextCommentId,
  nextIssueId,
  nextSeq,
  parseCommit,
  parseIdent,
  peelToCommit,
  storeObject,
  subtreeSha,
  type IssueRec,
  type PullRec,
  type RepoRec,
} from './store.ts';

export interface RestResult {
  status: number;
  body?: unknown;
  headers?: Record<string, string>;
}

const notFound = (): RestResult => ({ status: 404, body: { message: 'Not Found' } });
const unprocessable = (message: string): RestResult => ({ status: 422, body: { message } });

// ---------------------------------------------------------------- serializers

export function repoJson(repo: RepoRec): Record<string, unknown> {
  return {
    id: repo.id,
    node_id: `R_${repo.id}`,
    name: repo.name,
    full_name: `${repo.owner}/${repo.name}`,
    owner: { login: repo.owner, id: VIEWER.id, type: 'User' },
    private: repo.isPrivate,
    description: repo.description,
    default_branch: repo.defaultBranch,
    fork: false,
    created_at: new Date(1_735_689_600_000 + repo.createdSeq * 1000).toISOString(),
    updated_at: new Date(1_735_689_600_000 + repo.createdSeq * 1000).toISOString(),
  };
}

export function issueJson(repo: RepoRec, issue: IssueRec): Record<string, unknown> {
  return {
    id: issue.id,
    node_id: `I_${issue.id}`,
    number: issue.number,
    title: issue.title,
    body: issue.body,
    state: issue.state,
    labels: issue.labels.map((name) => {
      const label = repo.labels.get(name);
      return { id: 0, name, color: label?.color ?? 'ededed', description: null, default: false };
    }),
    user: { login: repo.owner, id: VIEWER.id, type: 'User' },
    comments: issue.comments.length,
    created_at: new Date(1_735_689_600_000 + issue.createdSeq * 1000).toISOString(),
    updated_at: new Date(1_735_689_600_000 + issue.createdSeq * 1000).toISOString(),
    closed_at: issue.state === 'closed' ? new Date(1_735_689_600_000 + issue.createdSeq * 1000).toISOString() : null,
  };
}

export function commentJson(comment: { id: number; body: string; createdSeq: number }, owner: string): Record<string, unknown> {
  return {
    id: comment.id,
    node_id: `IC_${comment.id}`,
    body: comment.body,
    user: { login: owner, id: VIEWER.id, type: 'User' },
    created_at: new Date(1_735_689_600_000 + comment.createdSeq * 1000).toISOString(),
    updated_at: new Date(1_735_689_600_000 + comment.createdSeq * 1000).toISOString(),
  };
}

export function pullJson(repo: RepoRec, pull: PullRec): Record<string, unknown> {
  const headSha = branchTip(repo, pull.headRef) ?? pull.headShaSnapshot;
  const baseSha = branchTip(repo, pull.baseRef) ?? pull.baseShaSnapshot;
  return {
    id: pull.id,
    node_id: `PR_${pull.id}`,
    number: pull.number,
    state: pull.state,
    title: pull.title,
    body: pull.body,
    merged: pull.merged,
    merged_at: pull.mergedAt,
    merge_commit_sha: pull.mergeCommitSha,
    head: { ref: pull.headRef, sha: headSha, label: `${repo.owner}:${pull.headRef}` },
    base: { ref: pull.baseRef, sha: baseSha, label: `${repo.owner}:${pull.baseRef}` },
    user: { login: repo.owner, id: VIEWER.id, type: 'User' },
    created_at: new Date(1_735_689_600_000 + pull.createdSeq * 1000).toISOString(),
    updated_at: new Date(1_735_689_600_000 + pull.createdSeq * 1000).toISOString(),
  };
}

// ---------------------------------------------------------------- shared operations

export function createIssueRecord(
  repo: RepoRec,
  input: { title: string; body?: string; labels?: string[] },
): { issue: IssueRec } | { error: string } {
  const labels = input.labels ?? [];
  for (const name of labels) {
    if (!repo.labels.has(name)) return { error: `Label "${name}" does not exist in ${repo.owner}/${repo.name}` };
  }
  const issue: IssueRec = {
    kind: 'issue',
    id: nextIssueId(),
    number: repo.nextNumber,
    title: input.title,
    body: input.body ?? '',
    state: 'open',
    labels: [...labels],
    comments: [],
    createdSeq: nextSeq(),
  };
  repo.nextNumber += 1;
  repo.issues.set(issue.number, issue);
  return { issue };
}

export function createPullRecord(
  repo: RepoRec,
  input: { title: string; body?: string; head: string; base: string },
): { pull: PullRec } | { error: string } {
  const headTipSha = branchTip(repo, input.head);
  if (headTipSha === undefined) return { error: `Head branch "${input.head}" does not exist` };
  const baseTipSha = branchTip(repo, input.base);
  if (baseTipSha === undefined) return { error: `Base branch "${input.base}" does not exist` };
  const pull: PullRec = {
    kind: 'pull',
    id: nextIssueId(),
    number: repo.nextNumber,
    title: input.title,
    body: input.body ?? '',
    state: 'open',
    merged: false,
    headRef: input.head,
    baseRef: input.base,
    headShaSnapshot: headTipSha,
    baseShaSnapshot: baseTipSha,
    mergedAt: null,
    mergeCommitSha: null,
    createdSeq: nextSeq(),
  };
  repo.nextNumber += 1;
  repo.pulls.set(pull.number, pull);
  return { pull };
}

export interface PullFileEntry {
  filename: string;
  status: 'added' | 'removed' | 'modified';
  additions: number;
  deletions: number;
  changes: number;
  sha: string;
}

function countLines(text: string): number {
  if (text === '') return 0;
  const lines = text.split('\n');
  return text.endsWith('\n') ? lines.length - 1 : lines.length;
}

/** Line-level diff counts via a longest-common-subsequence over lines (files here are small). */
function lineDiff(before: string, after: string): { additions: number; deletions: number } {
  const a = before === '' ? [] : before.split('\n');
  const b = after === '' ? [] : after.split('\n');
  if (before.endsWith('\n')) a.pop();
  if (after.endsWith('\n')) b.pop();
  const dp: number[] = new Array(b.length + 1).fill(0);
  for (let i = 1; i <= a.length; i += 1) {
    let diagonal = 0;
    for (let j = 1; j <= b.length; j += 1) {
      const above = dp[j]!;
      if (a[i - 1] === b[j - 1]) dp[j] = diagonal + 1;
      else dp[j] = Math.max(dp[j]!, dp[j - 1]!);
      diagonal = above;
    }
  }
  const common = dp[b.length]!;
  return { additions: b.length - common, deletions: a.length - common };
}

/** The files a pull request changes: merge-base tree versus head tip tree. */
export function pullFiles(repo: RepoRec, pull: PullRec): PullFileEntry[] {
  const headSha = branchTip(repo, pull.headRef) ?? pull.headShaSnapshot;
  const baseSha = branchTip(repo, pull.baseRef) ?? pull.baseShaSnapshot;
  const ancestor = mergeBase(baseSha, headSha) ?? baseSha;
  const fromFlat = flatTreeAt(repo, ancestor);
  const toFlat = flatTreeAt(repo, headSha);
  const entries: PullFileEntry[] = [];
  const paths = new Set([...fromFlat.keys(), ...toFlat.keys()]);
  for (const path of [...paths].sort()) {
    const from = fromFlat.get(path);
    const to = toFlat.get(path);
    if (from !== undefined && to !== undefined && from.sha === to.sha) continue;
    const beforeText = from === undefined ? '' : (getObject(from.sha)?.data.toString('utf8') ?? '');
    const afterText = to === undefined ? '' : (getObject(to.sha)?.data.toString('utf8') ?? '');
    if (from === undefined) {
      const additions = countLines(afterText);
      entries.push({ filename: path, status: 'added', additions, deletions: 0, changes: additions, sha: to!.sha });
    } else if (to === undefined) {
      const deletions = countLines(beforeText);
      entries.push({ filename: path, status: 'removed', additions: 0, deletions, changes: deletions, sha: from.sha });
    } else {
      const { additions, deletions } = lineDiff(beforeText, afterText);
      entries.push({ filename: path, status: 'modified', additions, deletions, changes: additions + deletions, sha: to.sha });
    }
  }
  return entries;
}

/** Whether the pull's head still merges cleanly into its base (three-way, per path). */
export function pullMergeable(repo: RepoRec, pull: PullRec): boolean {
  if (pull.state !== 'open') return false;
  const headSha = branchTip(repo, pull.headRef) ?? pull.headShaSnapshot;
  const baseSha = branchTip(repo, pull.baseRef) ?? pull.baseShaSnapshot;
  const ancestor = mergeBase(baseSha, headSha);
  const baseFlat = ancestor === null ? new Map() : flatTreeAt(repo, ancestor);
  const oursFlat = flatTreeAt(repo, baseSha);
  const theirsFlat = flatTreeAt(repo, headSha);
  const paths = new Set([...baseFlat.keys(), ...oursFlat.keys(), ...theirsFlat.keys()]);
  for (const path of paths) {
    const base = baseFlat.get(path)?.sha;
    const ours = oursFlat.get(path)?.sha;
    const theirs = theirsFlat.get(path)?.sha;
    if (ours === theirs || base === theirs || base === ours) continue;
    return false;
  }
  return true;
}

/** Merge a pull request into its base branch. Squash and merge are both supported. */
export function mergePullRecord(
  repo: RepoRec,
  pull: PullRec,
  method: string,
): { sha: string } | { conflict: true } | { error: string } {
  if (pull.merged) return { error: 'Pull Request is already merged' };
  if (pull.state !== 'open') return { error: 'Pull Request is not open' };
  const headSha = branchTip(repo, pull.headRef) ?? pull.headShaSnapshot;
  const baseSha = branchTip(repo, pull.baseRef) ?? pull.baseShaSnapshot;
  const ancestor = mergeBase(baseSha, headSha);
  const baseFlat = ancestor === null ? new Map<string, { sha: string; mode: string }>() : flatTreeAt(repo, ancestor);
  const oursFlat = flatTreeAt(repo, baseSha);
  const theirsFlat = flatTreeAt(repo, headSha);
  const merged = new Map(oursFlat);
  const paths = new Set([...baseFlat.keys(), ...oursFlat.keys(), ...theirsFlat.keys()]);
  for (const path of paths) {
    const base = baseFlat.get(path);
    const ours = oursFlat.get(path);
    const theirs = theirsFlat.get(path);
    if (ours?.sha === theirs?.sha) continue;
    if (base?.sha === ours?.sha) {
      if (theirs === undefined) merged.delete(path);
      else merged.set(path, theirs);
      continue;
    }
    if (base?.sha === theirs?.sha) continue;
    return { conflict: true };
  }
  const tree = buildTree(merged);
  const parents = method === 'merge' ? [baseSha, headSha] : [baseSha];
  const message = method === 'merge' ? `Merge pull request #${pull.number} from ${pull.headRef}\n\n${pull.title}` : `${pull.title} (#${pull.number})`;
  const sha = createCommit({ tree, parents, message });
  repo.refs.set(`refs/heads/${pull.baseRef}`, sha);
  pull.state = 'closed';
  pull.merged = true;
  pull.mergedAt = new Date().toISOString();
  pull.mergeCommitSha = sha;
  return { sha };
}

export interface PutContentResult {
  status: number;
  contentSha?: string;
  commitSha?: string;
  error?: string;
}

/** PUT /contents semantics: write one file on a branch (creating the branch when needed). */
export function putContentRecord(
  repo: RepoRec,
  input: { path: string; content: Buffer; message: string; branch?: string; sha?: string },
): PutContentResult {
  const branch = input.branch ?? repo.defaultBranch;
  let tip = branchTip(repo, branch);
  if (tip === undefined && branch !== repo.defaultBranch) tip = headTip(repo);
  const flat = tip === undefined ? new Map<string, { sha: string; mode: string }>() : flatTreeAt(repo, tip);
  const existing = flat.get(input.path);
  if (existing !== undefined && input.sha !== undefined && input.sha !== existing.sha) {
    return { status: 409, error: `${input.path} has sha ${existing.sha}, not ${input.sha}` };
  }
  const blobSha = storeObject('blob', input.content);
  const next = new Map(flat);
  next.set(input.path, { sha: blobSha, mode: existing?.mode ?? '100644' });
  const tree = buildTree(next);
  const commitSha = createCommit({ tree, parents: tip === undefined ? [] : [tip], message: input.message });
  repo.refs.set(`refs/heads/${branch}`, commitSha);
  return { status: existing === undefined ? 201 : 200, contentSha: blobSha, commitSha };
}

/** DELETE /contents semantics: remove one file on a branch with a commit. */
export function deleteContentRecord(
  repo: RepoRec,
  input: { path: string; message: string; branch?: string; sha?: string },
): PutContentResult {
  const branch = input.branch ?? repo.defaultBranch;
  const tip = branchTip(repo, branch);
  if (tip === undefined) return { status: 404, error: 'branch not found' };
  const flat = flatTreeAt(repo, tip);
  const existing = flat.get(input.path);
  if (existing === undefined) return { status: 404, error: 'file not found' };
  if (input.sha !== undefined && input.sha !== existing.sha) {
    return { status: 409, error: `${input.path} has sha ${existing.sha}, not ${input.sha}` };
  }
  const next = new Map(flat);
  next.delete(input.path);
  const tree = buildTree(next);
  const commitSha = createCommit({ tree, parents: [tip], message: input.message });
  repo.refs.set(`refs/heads/${branch}`, commitSha);
  return { status: 200, commitSha };
}

// ---------------------------------------------------------------- pagination

interface Page {
  items: unknown[];
  headers: Record<string, string>;
}

function paginate(items: unknown[], query: URLSearchParams, baseUrl: string, path: string): Page {
  const perPageRaw = Number(query.get('per_page') ?? '30');
  const perPage = Number.isFinite(perPageRaw) && perPageRaw > 0 ? Math.min(100, Math.trunc(perPageRaw)) : 30;
  const pageRaw = Number(query.get('page') ?? '1');
  const page = Number.isFinite(pageRaw) && pageRaw > 0 ? Math.trunc(pageRaw) : 1;
  const start = (page - 1) * perPage;
  const slice = items.slice(start, start + perPage);
  const headers: Record<string, string> = {};
  if (start + perPage < items.length) {
    const params = new URLSearchParams(query);
    params.set('per_page', String(perPage));
    params.set('page', String(page + 1));
    const lastParams = new URLSearchParams(query);
    lastParams.set('per_page', String(perPage));
    lastParams.set('page', String(Math.ceil(items.length / perPage)));
    headers.link = `<${baseUrl}${path}?${params.toString()}>; rel="next", <${baseUrl}${path}?${lastParams.toString()}>; rel="last"`;
  }
  return { items: slice, headers };
}

// ---------------------------------------------------------------- the router

export interface RestRequest {
  method: string;
  /** Decoded path segments after /api/v3 (empty for the root). */
  segments: string[];
  query: URLSearchParams;
  body: Record<string, unknown> | null;
  baseUrl: string;
}

function bodyString(body: Record<string, unknown> | null, key: string): string | undefined {
  const value = body?.[key];
  return typeof value === 'string' ? value : undefined;
}

function labelNames(body: Record<string, unknown> | null): string[] {
  const raw = body?.labels;
  if (!Array.isArray(raw)) return [];
  const names: string[] = [];
  for (const entry of raw) {
    if (typeof entry === 'string') names.push(entry);
    else if (typeof entry === 'object' && entry !== null && typeof (entry as { name?: unknown }).name === 'string') {
      names.push((entry as { name: string }).name);
    }
  }
  return names;
}

export function handleRest(req: RestRequest): RestResult {
  const { method, segments, query, body, baseUrl } = req;

  if (segments.length === 0) {
    if (method !== 'GET') return notFound();
    return {
      status: 200,
      body: {
        current_user_url: `${baseUrl}/api/v3/user`,
        rate_limit_url: `${baseUrl}/api/v3/rate_limit`,
        repository_url: `${baseUrl}/api/v3/repos/{owner}/{repo}`,
        issue_search_url: `${baseUrl}/api/v3/search/issues?q={query}`,
      },
      headers: { 'x-oauth-scopes': 'repo, read:org' },
    };
  }

  if (segments[0] === 'meta' && segments.length === 1 && method === 'GET') {
    return { status: 200, body: { installed_version: 'forge-1.0.0', verifiable_password_authentication: false } };
  }

  if (segments[0] === 'rate_limit' && segments.length === 1 && method === 'GET') {
    return { status: 200, body: { rate: { limit: 5000, used: 1, remaining: 4999, reset: 1893456000 }, resources: {} } };
  }

  if (segments[0] === 'user' && segments.length === 1 && method === 'GET') {
    return {
      status: 200,
      body: { login: VIEWER.login, id: VIEWER.id, name: VIEWER.name, email: VIEWER.email, type: 'User' },
    };
  }

  if (segments[0] === 'user' && segments[1] === 'repos' && segments.length === 2) {
    if (method === 'GET') {
      const mine = reposOf(VIEWER.login).map((repo) => repoJson(repo));
      const page = paginate(mine, query, baseUrl, '/api/v3/user/repos');
      return { status: 200, body: page.items, headers: page.headers };
    }
    if (method === 'POST') {
      const name = bodyString(body, 'name');
      if (name === undefined || name === '') return unprocessable('Repository name is required');
      if (findRepo(VIEWER.login, name) !== undefined) {
        return {
          status: 422,
          body: { message: 'Repository creation failed.', errors: [{ resource: 'Repository', code: 'custom', field: 'name', message: 'name already exists on this account' }] },
        };
      }
      const description = bodyString(body, 'description') ?? '';
      const isPrivate = body?.private === true;
      const repo = createRepoRecord(VIEWER.login, name, description, isPrivate);
      const defaultBranch = bodyString(body, 'default_branch');
      if (defaultBranch !== undefined && defaultBranch !== '') repo.defaultBranch = defaultBranch;
      return { status: 201, body: repoJson(repo) };
    }
    return notFound();
  }

  if (segments[0] !== 'repos' || segments.length < 3) return notFound();
  const owner = segments[1]!;
  const name = segments[2]!;
  const repo = findRepo(owner, name);
  if (repo === undefined) return notFound();
  const rest = segments.slice(3);

  if (rest.length === 0) {
    if (method === 'GET') return { status: 200, body: repoJson(repo) };
    if (method === 'PATCH') {
      const description = bodyString(body, 'description');
      if (description !== undefined) repo.description = description;
      if (typeof body?.private === 'boolean') repo.isPrivate = body.private;
      return { status: 200, body: repoJson(repo) };
    }
    if (method === 'DELETE') {
      deleteRepoRecord(owner, name);
      return { status: 204 };
    }
    return notFound();
  }

  // branches
  if (rest[0] === 'branches') {
    if (rest.length === 1 && method === 'GET') {
      const branches = [...repo.refs.keys()]
        .filter((ref) => ref.startsWith('refs/heads/'))
        .map((ref) => ref.slice('refs/heads/'.length))
        .sort()
        .map((branch) => ({ name: branch, commit: { sha: repo.refs.get(`refs/heads/${branch}`)! }, protected: false }));
      return { status: 200, body: branches };
    }
    if (rest.length >= 2 && method === 'GET') {
      const branch = rest.slice(1).join('/');
      const tip = branchTip(repo, branch);
      if (tip === undefined) return notFound();
      return { status: 200, body: { name: branch, commit: { sha: tip }, protected: false } };
    }
    return notFound();
  }

  // commits
  if (rest[0] === 'commits' && rest.length === 1 && method === 'GET') {
    const ref = query.get('sha') ?? repo.defaultBranch;
    let tip = branchTip(repo, ref) ?? (getObject(ref) !== undefined ? ref : undefined);
    if (tip !== undefined && getObject(tip)?.type === 'tag') tip = peelToCommit(tip);
    if (tip === undefined) return notFound();
    if (parseCommit(tip) === null) return { status: 409, body: { message: 'Git Repository is empty.' } };
    const ordered: string[] = [];
    const seen = new Set<string>();
    const stack = [tip];
    while (stack.length > 0) {
      const sha = stack.pop()!;
      if (seen.has(sha)) continue;
      seen.add(sha);
      const commit = parseCommit(sha);
      if (commit === null) continue;
      ordered.push(sha);
      for (let i = commit.parents.length - 1; i >= 0; i -= 1) stack.push(commit.parents[i]!);
    }
    const items = ordered.map((sha) => {
      const commit = parseCommit(sha)!;
      return {
        sha,
        commit: {
          message: commit.message,
          tree: { sha: commit.tree },
          author: parseIdent(commit.author),
          committer: parseIdent(commit.committer),
        },
        parents: commit.parents.map((parent) => ({ sha: parent })),
      };
    });
    const page = paginate(items, query, baseUrl, `/api/v3/repos/${owner}/${name}/commits`);
    return { status: 200, body: page.items, headers: page.headers };
  }

  // contents
  if (rest[0] === 'contents') {
    const path = rest.slice(1).join('/');
    return handleContents(repo, method, path, query, body);
  }

  // git refs
  if (rest[0] === 'git' && rest[1] === 'refs') {
    if (rest.length === 2 && method === 'POST') {
      const ref = bodyString(body, 'ref');
      const sha = bodyString(body, 'sha');
      if (ref === undefined || sha === undefined || !ref.startsWith('refs/')) return unprocessable('ref and sha are required');
      const target = getObject(sha);
      if (target === undefined) return unprocessable(`Object ${sha} does not exist`);
      if (repo.refs.has(ref)) return unprocessable('Reference already exists');
      repo.refs.set(ref, sha);
      return { status: 201, body: { ref, object: { sha, type: target.type } } };
    }
    if (rest.length >= 3 && method === 'GET') {
      const ref = `refs/${rest.slice(2).join('/')}`;
      const sha = repo.refs.get(ref);
      if (sha === undefined) return notFound();
      return { status: 200, body: { ref, object: { sha, type: getObject(sha)?.type ?? 'commit' } } };
    }
    return notFound();
  }

  // labels
  if (rest[0] === 'labels' && rest.length === 1) {
    if (method === 'GET') {
      return { status: 200, body: [...repo.labels.values()].map((label, index) => ({ id: index + 1, name: label.name, color: label.color, description: null, default: false })) };
    }
    if (method === 'POST') {
      const labelName = bodyString(body, 'name');
      if (labelName === undefined || labelName === '') return unprocessable('Label name is required');
      if (repo.labels.has(labelName)) return unprocessable('Validation Failed: label already exists');
      const color = (bodyString(body, 'color') ?? 'ededed').replace(/^#/, '');
      repo.labels.set(labelName, { name: labelName, color });
      return { status: 201, body: { id: repo.labels.size, name: labelName, color, description: null, default: false } };
    }
    return notFound();
  }

  // issues
  if (rest[0] === 'issues') {
    if (rest.length === 1) {
      if (method === 'GET') {
        const state = query.get('state') ?? 'open';
        let issues = [...repo.issues.values()];
        if (state === 'open' || state === 'closed') issues = issues.filter((issue) => issue.state === state);
        const direction = query.get('direction') ?? 'desc';
        issues.sort((a, b) => (direction === 'asc' ? a.createdSeq - b.createdSeq : b.createdSeq - a.createdSeq));
        const items = issues.map((issue) => issueJson(repo, issue));
        const page = paginate(items, query, baseUrl, `/api/v3/repos/${owner}/${name}/issues`);
        return { status: 200, body: page.items, headers: page.headers };
      }
      if (method === 'POST') {
        const title = bodyString(body, 'title');
        if (title === undefined) return unprocessable('Issue title is required');
        const created = createIssueRecord(repo, { title, body: bodyString(body, 'body') ?? '', labels: labelNames(body) });
        if ('error' in created) return unprocessable(created.error);
        return { status: 201, body: issueJson(repo, created.issue) };
      }
      return notFound();
    }
    const number = Number(rest[1]);
    const issue = Number.isInteger(number) ? repo.issues.get(number) : undefined;
    if (rest.length === 2) {
      if (issue === undefined) return notFound();
      if (method === 'GET') return { status: 200, body: issueJson(repo, issue) };
      if (method === 'PATCH') {
        const state = bodyString(body, 'state');
        if (state === 'open' || state === 'closed') issue.state = state;
        const title = bodyString(body, 'title');
        if (title !== undefined) issue.title = title;
        const issueBody = bodyString(body, 'body');
        if (issueBody !== undefined) issue.body = issueBody;
        if (body?.labels !== undefined) {
          const names = labelNames(body);
          for (const labelName of names) if (!repo.labels.has(labelName)) return unprocessable(`Label "${labelName}" does not exist`);
          issue.labels = names;
        }
        return { status: 200, body: issueJson(repo, issue) };
      }
      return notFound();
    }
    if (rest.length === 3 && rest[2] === 'comments') {
      if (issue === undefined) return notFound();
      if (method === 'GET') {
        return { status: 200, body: issue.comments.map((comment) => commentJson(comment, repo.owner)) };
      }
      if (method === 'POST') {
        const commentBody = bodyString(body, 'body');
        if (commentBody === undefined) return unprocessable('Comment body is required');
        const comment = { id: nextCommentId(), body: commentBody, createdSeq: nextSeq() };
        issue.comments.push(comment);
        return { status: 201, body: commentJson(comment, repo.owner) };
      }
      return notFound();
    }
    return notFound();
  }

  // pulls
  if (rest[0] === 'pulls') {
    if (rest.length === 1) {
      if (method === 'GET') {
        const state = query.get('state') ?? 'open';
        let pulls = [...repo.pulls.values()];
        if (state === 'open' || state === 'closed') pulls = pulls.filter((pull) => pull.state === state);
        pulls.sort((a, b) => b.createdSeq - a.createdSeq);
        const items = pulls.map((pull) => pullJson(repo, pull));
        const page = paginate(items, query, baseUrl, `/api/v3/repos/${owner}/${name}/pulls`);
        return { status: 200, body: page.items, headers: page.headers };
      }
      if (method === 'POST') {
        const title = bodyString(body, 'title');
        const head = (bodyString(body, 'head') ?? '').split(':').pop()!;
        const base = (bodyString(body, 'base') ?? repo.defaultBranch).split(':').pop()!;
        if (title === undefined || head === '') return unprocessable('title and head are required');
        const created = createPullRecord(repo, { title, body: bodyString(body, 'body') ?? '', head, base });
        if ('error' in created) return unprocessable(created.error);
        return { status: 201, body: pullJson(repo, created.pull) };
      }
      return notFound();
    }
    const number = Number(rest[1]);
    const pull = Number.isInteger(number) ? repo.pulls.get(number) : undefined;
    if (rest.length === 2 && method === 'GET') {
      if (pull === undefined) return notFound();
      return { status: 200, body: pullJson(repo, pull) };
    }
    if (rest.length === 3 && rest[2] === 'files' && method === 'GET') {
      if (pull === undefined) return notFound();
      return { status: 200, body: pullFiles(repo, pull).map((file) => ({ sha: file.sha, filename: file.filename, status: file.status, additions: file.additions, deletions: file.deletions, changes: file.changes })) };
    }
    if (rest.length === 3 && rest[2] === 'merge' && method === 'PUT') {
      if (pull === undefined) return notFound();
      const mergeMethod = bodyString(body, 'merge_method') ?? 'merge';
      const merged = mergePullRecord(repo, pull, mergeMethod);
      if ('conflict' in merged) return { status: 405, body: { message: 'Pull Request is not mergeable' } };
      if ('error' in merged) return { status: 405, body: { message: merged.error } };
      return { status: 200, body: { sha: merged.sha, merged: true, message: 'Pull Request successfully merged' } };
    }
    return notFound();
  }

  return notFound();
}

function handleContents(repo: RepoRec, method: string, path: string, query: URLSearchParams, body: Record<string, unknown> | null): RestResult {
  if (method === 'PUT') {
    const message = bodyString(body, 'message') ?? '';
    const contentB64 = bodyString(body, 'content');
    if (contentB64 === undefined) return unprocessable('content is required');
    const content = Buffer.from(contentB64.replace(/[\r\n\t ]+/g, ''), 'base64');
    const result = putContentRecord(repo, {
      path,
      content,
      message,
      branch: bodyString(body, 'branch'),
      sha: bodyString(body, 'sha'),
    });
    if (result.error !== undefined) return { status: result.status, body: { message: result.error } };
    const commit = parseCommit(result.commitSha!);
    return {
      status: result.status,
      body: {
        content: { type: 'file', name: path.split('/').pop() ?? path, path, sha: result.contentSha, size: content.length, encoding: 'base64' },
        commit: { sha: result.commitSha, message, author: parseIdent(commit?.author ?? ''), committer: parseIdent(commit?.committer ?? '') },
      },
    };
  }
  if (method === 'DELETE') {
    const result = deleteContentRecord(repo, {
      path,
      message: bodyString(body, 'message') ?? '',
      branch: bodyString(body, 'branch'),
      sha: bodyString(body, 'sha'),
    });
    if (result.error !== undefined) return { status: result.status, body: { message: result.error } };
    return { status: 200, body: { content: null, commit: { sha: result.commitSha } } };
  }
  if (method !== 'GET') return notFound();
  const ref = query.get('ref') ?? repo.defaultBranch;
  let tip = branchTip(repo, ref) ?? (getObject(ref) !== undefined ? ref : undefined);
  if (tip !== undefined && getObject(tip)?.type === 'tag') tip = peelToCommit(tip);
  if (tip === undefined) return notFound();
  const commit = parseCommit(tip);
  if (commit === null) return notFound();
  const flat = flattenTree(commit.tree);
  const file = flat.get(path);
  if (file !== undefined) {
    const data = getObject(file.sha)?.data ?? Buffer.alloc(0);
    return {
      status: 200,
      body: {
        type: 'file',
        name: path.split('/').pop() ?? path,
        path,
        sha: file.sha,
        size: data.length,
        encoding: 'base64',
        content: data.toString('base64'),
      },
    };
  }
  // Directory listing: the root ('' path) or a path that prefixes stored files.
  const prefix = path === '' ? '' : `${path}/`;
  const isDir = path === '' || [...flat.keys()].some((candidate) => candidate.startsWith(prefix));
  if (!isDir) return notFound();
  const dirSha = path === '' ? commit.tree : subtreeSha(commit.tree, path);
  if (dirSha === null) return notFound();
  const children = new Map<string, { type: 'file' | 'dir'; sha: string; size: number }>();
  for (const [candidate, entry] of flat) {
    if (!candidate.startsWith(prefix)) continue;
    const remainder = candidate.slice(prefix.length);
    const slash = remainder.indexOf('/');
    if (slash === -1) {
      children.set(remainder, { type: 'file', sha: entry.sha, size: getObject(entry.sha)?.data.length ?? 0 });
    } else {
      const dirName = remainder.slice(0, slash);
      if (!children.has(dirName)) {
        const sub = subtreeSha(commit.tree, prefix + dirName);
        children.set(dirName, { type: 'dir', sha: sub ?? dirSha, size: 0 });
      }
    }
  }
  const entries = [...children.entries()]
    .sort(([a], [b]) => (a < b ? -1 : a > b ? 1 : 0))
    .map(([childName, entry]) => ({ type: entry.type, name: childName, path: prefix + childName, sha: entry.sha, size: entry.size }));
  return { status: 200, body: entries };
}
