// Git smart-HTTP: pkt-line framing, packfile reading (with delta application) and generation,
// protocol v2 (ls-refs + fetch) and v0 fetch, and receive-pack with report-status. The object
// model lives in store.ts; this file is the wire.

import { createHash } from 'node:crypto';
import { deflateSync, inflateSync } from 'node:zlib';
import {
  ZERO_OID,
  getObject,
  storeObject,
  parseCommit,
  flattenTree,
  peelToCommit,
  reachableCommits,
  isAncestor,
  type GitObj,
  type ObjType,
  type RepoRec,
} from './store.ts';

// ---------------------------------------------------------------- pkt-lines

export type Packet = { kind: 'data'; payload: Buffer } | { kind: 'flush' } | { kind: 'delim' } | { kind: 'end' };

export function pktLine(payload: string | Buffer): Buffer {
  const data = typeof payload === 'string' ? Buffer.from(payload, 'utf8') : payload;
  const header = (data.length + 4).toString(16).padStart(4, '0');
  return Buffer.concat([Buffer.from(header, 'ascii'), data]);
}

export const PKT_FLUSH = Buffer.from('0000', 'ascii');
export const PKT_DELIM = Buffer.from('0001', 'ascii');

/** Parse pkt-lines from `buf` starting at `start`; returns the packets and the offset just past the flush. */
export function parsePackets(buf: Buffer, start = 0): { packets: Packet[]; next: number } {
  const packets: Packet[] = [];
  let offset = start;
  while (offset + 4 <= buf.length) {
    const header = buf.toString('ascii', offset, offset + 4);
    if (!/^[0-9a-fA-F]{4}$/.test(header)) break;
    const length = parseInt(header, 16);
    if (length === 0) {
      packets.push({ kind: 'flush' });
      offset += 4;
      return { packets, next: offset };
    }
    if (length === 1) {
      packets.push({ kind: 'delim' });
      offset += 4;
      continue;
    }
    if (length === 2) {
      packets.push({ kind: 'end' });
      offset += 4;
      return { packets, next: offset };
    }
    if (length < 4 || offset + length > buf.length) break;
    packets.push({ kind: 'data', payload: buf.subarray(offset + 4, offset + length) });
    offset += length;
  }
  return { packets, next: offset };
}

/** All data-payload lines of a packet list, as text without the trailing newline. */
export function packetLines(packets: readonly Packet[]): string[] {
  const lines: string[] = [];
  for (const packet of packets) {
    if (packet.kind === 'data') lines.push(packet.payload.toString('utf8').replace(/\n$/, ''));
  }
  return lines;
}

// ---------------------------------------------------------------- packfiles

/** Inflate one zlib stream starting at `offset`; returns the data and the offset just past the stream. */
function inflateAt(buf: Buffer, offset: number): { data: Buffer; next: number } {
  const tryEnd = (end: number): Buffer | null => {
    try {
      return inflateSync(buf.subarray(offset, end));
    } catch {
      return null;
    }
  };
  // Exponential search for a succeeding end, then binary search for the smallest one:
  // inflateSync tolerates trailing bytes, so success is monotone in the end offset.
  let step = 64;
  let failEnd = offset;
  let okEnd = -1;
  while (offset + step <= buf.length) {
    if (tryEnd(offset + step) !== null) {
      okEnd = offset + step;
      break;
    }
    failEnd = offset + step;
    step *= 4;
  }
  if (okEnd === -1) {
    const data = tryEnd(buf.length);
    if (data === null) throw new Error('pack entry does not inflate');
    okEnd = buf.length;
  }
  let lo = failEnd + 1;
  let hi = okEnd;
  while (lo < hi) {
    const mid = (lo + hi) >> 1;
    if (tryEnd(mid) !== null) hi = mid;
    else lo = mid + 1;
  }
  const data = tryEnd(lo);
  if (data === null) throw new Error('pack entry does not inflate');
  return { data, next: lo };
}

function applyDelta(base: Buffer, delta: Buffer): Buffer {
  let offset = 0;
  const readVarint = (): number => {
    let value = 0;
    let shift = 0;
    for (;;) {
      const byte = delta[offset]!;
      offset += 1;
      value |= (byte & 0x7f) << shift;
      shift += 7;
      if ((byte & 0x80) === 0) break;
    }
    return value;
  };
  const sourceSize = readVarint();
  if (sourceSize !== base.length) throw new Error('delta base size mismatch');
  const targetSize = readVarint();
  const chunks: Buffer[] = [];
  let produced = 0;
  while (offset < delta.length) {
    const op = delta[offset]!;
    offset += 1;
    if (op & 0x80) {
      let copyOffset = 0;
      let copySize = 0;
      for (let bit = 0; bit < 4; bit += 1) {
        if (op & (1 << bit)) {
          copyOffset |= delta[offset]! << (8 * bit);
          offset += 1;
        }
      }
      for (let bit = 0; bit < 3; bit += 1) {
        if (op & (0x10 << bit)) {
          copySize |= delta[offset]! << (8 * bit);
          offset += 1;
        }
      }
      if (copySize === 0) copySize = 0x10000;
      chunks.push(base.subarray(copyOffset, copyOffset + copySize));
      produced += copySize;
    } else if (op !== 0) {
      chunks.push(delta.subarray(offset, offset + op));
      produced += op;
      offset += op;
    } else {
      throw new Error('delta opcode 0');
    }
  }
  const out = Buffer.concat(chunks);
  if (out.length !== targetSize || produced !== targetSize) throw new Error('delta target size mismatch');
  return out;
}

interface PackEntry {
  type: ObjType;
  data: Buffer;
  sha: string;
}

/**
 * Read a packfile, store every object it carries, and return the stored entries.
 * Deltas are resolved against the pack itself or the object store (thin packs).
 */
export function readPack(pack: Buffer): PackEntry[] {
  if (pack.length < 12 + 20 || pack.toString('ascii', 0, 4) !== 'PACK') throw new Error('not a packfile');
  const version = pack.readUInt32BE(4);
  if (version !== 2 && version !== 3) throw new Error(`pack version ${version}`);
  const count = pack.readUInt32BE(8);
  let offset = 12;
  const raw: Array<{ typeId: number; data: Buffer; baseOffset?: number; baseSha?: string }> = [];
  const entryStarts: number[] = [];
  for (let index = 0; index < count; index += 1) {
    entryStarts.push(offset);
    let byte = pack[offset]!;
    offset += 1;
    const typeId = (byte >> 4) & 0x7;
    let size = byte & 0x0f;
    let shift = 4;
    while (byte & 0x80) {
      byte = pack[offset]!;
      offset += 1;
      size |= (byte & 0x7f) << shift;
      shift += 7;
    }
    let baseOffset: number | undefined;
    let baseSha: string | undefined;
    if (typeId === 6) {
      byte = pack[offset]!;
      offset += 1;
      let back = byte & 0x7f;
      while (byte & 0x80) {
        byte = pack[offset]!;
        offset += 1;
        back = ((back + 1) << 7) | (byte & 0x7f);
      }
      baseOffset = entryStarts[index]! - back;
    } else if (typeId === 7) {
      baseSha = pack.toString('hex', offset, offset + 20);
      offset += 20;
    }
    const inflated = inflateAt(pack, offset);
    if (inflated.data.length !== size) throw new Error('pack entry size mismatch');
    offset = inflated.next;
    raw.push({ typeId, data: inflated.data, baseOffset, baseSha });
  }
  // Resolve entries to objects, following delta chains.
  const byStart = new Map<number, number>();
  entryStarts.forEach((start, index) => byStart.set(start, index));
  const resolved: Array<PackEntry | null> = raw.map(() => null);
  const resolve = (index: number): PackEntry => {
    const done = resolved[index];
    if (done !== null) return done;
    const entry = raw[index]!;
    let out: PackEntry;
    if (entry.typeId >= 1 && entry.typeId <= 4) {
      const type = (['', 'commit', 'tree', 'blob', 'tag'] as const)[entry.typeId] as ObjType;
      out = { type, data: entry.data, sha: storeObject(type, entry.data) };
    } else if (entry.typeId === 6 || entry.typeId === 7) {
      let baseType: ObjType;
      let baseData: Buffer;
      if (entry.typeId === 6) {
        const baseIndex = byStart.get(entry.baseOffset!);
        if (baseIndex === undefined) throw new Error('ofs-delta base outside the pack');
        const base = resolve(baseIndex);
        baseType = base.type;
        baseData = base.data;
      } else {
        const base = getObject(entry.baseSha!);
        if (base === undefined) throw new Error('ref-delta base is unknown');
        baseType = base.type;
        baseData = base.data;
      }
      const data = applyDelta(baseData, entry.data);
      out = { type: baseType, data, sha: storeObject(baseType, data) };
    } else {
      throw new Error(`pack entry type ${entry.typeId}`);
    }
    resolved[index] = out;
    return out;
  };
  const entries: PackEntry[] = [];
  for (let index = 0; index < raw.length; index += 1) entries.push(resolve(index));
  return entries;
}

const entryCache = new Map<string, Buffer>();

/** The pack entry bytes (header + deflated data) for one object, cached by sha. */
function packEntryBytes(sha: string, obj: GitObj): Buffer {
  const cached = entryCache.get(sha);
  if (cached !== undefined) return cached;
  const typeId = { commit: 1, tree: 2, blob: 3, tag: 4 }[obj.type];
  let size = obj.data.length;
  const header: number[] = [];
  let first = (typeId << 4) | (size & 0x0f);
  size >>= 4;
  if (size > 0) first |= 0x80;
  header.push(first);
  while (size > 0) {
    let byte = size & 0x7f;
    size >>= 7;
    if (size > 0) byte |= 0x80;
    header.push(byte);
  }
  const bytes = Buffer.concat([Buffer.from(header), deflateSync(obj.data, { level: 6 })]);
  entryCache.set(sha, bytes);
  return bytes;
}

/** Build a packfile carrying exactly `shas` (plain objects, no deltas). */
export function writePack(shas: readonly string[]): Buffer {
  const header = Buffer.alloc(12);
  header.write('PACK', 0, 'ascii');
  header.writeUInt32BE(2, 4);
  header.writeUInt32BE(shas.length, 8);
  const chunks: Buffer[] = [header];
  for (const sha of shas) {
    const obj = getObject(sha);
    if (obj === undefined) throw new Error(`pack wants unknown object ${sha}`);
    chunks.push(packEntryBytes(sha, obj));
  }
  const body = Buffer.concat(chunks);
  const trailer = createHash('sha1').update(body).digest();
  return Buffer.concat([body, trailer]);
}

// ---------------------------------------------------------------- ref advertisement

export interface RefLine {
  oid: string;
  name: string;
  peeled?: string;
  symrefTarget?: string;
  unborn?: boolean;
}

/** The refs a repository advertises, HEAD first, then branches and tags in name order. */
export function advertisedRefs(repo: RepoRec): RefLine[] {
  const lines: RefLine[] = [];
  const headRef = `refs/heads/${repo.defaultBranch}`;
  const headTip = repo.refs.get(headRef);
  if (headTip !== undefined) lines.push({ oid: headTip, name: 'HEAD', symrefTarget: headRef });
  const names = [...repo.refs.keys()].sort();
  for (const name of names) {
    const oid = repo.refs.get(name)!;
    const line: RefLine = { oid, name };
    const obj = getObject(oid);
    if (obj !== undefined && obj.type === 'tag') line.peeled = peelToCommit(oid);
    lines.push(line);
  }
  return lines;
}

const UPLOAD_CAPS_V0 = 'side-band-64k thin-pack ofs-delta shallow agent=forge/1.0.0';
const RECEIVE_CAPS = 'report-status delete-refs side-band-64k ofs-delta agent=forge/1.0.0';

function serviceHeader(service: string): Buffer {
  return pktLine(`# service=${service}\n`);
}

/** GET info/refs for upload-pack or receive-pack. Returns status + body + content type. */
export function infoRefs(repo: RepoRec | undefined, service: string, protocolV2: boolean): { status: number; contentType: string; body: Buffer } {
  if (service !== 'git-upload-pack' && service !== 'git-receive-pack') {
    return { status: 400, contentType: 'text/plain', body: Buffer.from('unknown service') };
  }
  if (repo === undefined) {
    return { status: 404, contentType: 'text/plain', body: Buffer.from('repository not found') };
  }
  const contentType = `application/x-${service}-advertisement`;
  const chunks: Buffer[] = [serviceHeader(service), PKT_FLUSH];
  if (service === 'git-upload-pack' && protocolV2) {
    chunks.push(pktLine('version 2\n'));
    chunks.push(pktLine('agent=forge/1.0.0\n'));
    chunks.push(pktLine('object-format=sha1\n'));
    chunks.push(pktLine('ls-refs=unborn\n'));
    chunks.push(pktLine('fetch=shallow wait-for-done\n'));
    chunks.push(PKT_FLUSH);
    return { status: 200, contentType, body: Buffer.concat(chunks) };
  }
  const refs = advertisedRefs(repo).filter((line) => service === 'git-upload-pack' || line.name !== 'HEAD');
  if (service === 'git-upload-pack') {
    const caps = `${UPLOAD_CAPS_V0} symref=HEAD:refs/heads/${repo.defaultBranch}`;
    if (refs.length === 0) {
      chunks.push(pktLine(`${ZERO_OID} capabilities^{}\0${caps}`));
    } else {
      refs.forEach((line, index) => {
        const suffix = index === 0 ? `\0${caps}` : '';
        chunks.push(pktLine(`${line.oid} ${line.name}${suffix}\n`));
        if (line.peeled !== undefined) chunks.push(pktLine(`${line.peeled} ${line.name}^{}\n`));
      });
    }
  } else {
    if (refs.length === 0) {
      chunks.push(pktLine(`${ZERO_OID} capabilities^{}\0${RECEIVE_CAPS}`));
    } else {
      refs.forEach((line, index) => {
        const suffix = index === 0 ? `\0${RECEIVE_CAPS}` : '';
        chunks.push(pktLine(`${line.oid} ${line.name}${suffix}\n`));
        if (line.peeled !== undefined) chunks.push(pktLine(`${line.peeled} ${line.name}^{}\n`));
      });
    }
  }
  chunks.push(PKT_FLUSH);
  return { status: 200, contentType, body: Buffer.concat(chunks) };
}

// ---------------------------------------------------------------- ls-refs

export function lsRefs(repo: RepoRec, args: readonly string[]): Buffer {
  let peel = false;
  let symrefs = false;
  let unborn = false;
  const prefixes: string[] = [];
  for (const arg of args) {
    if (arg === 'peel') peel = true;
    else if (arg === 'symrefs') symrefs = true;
    else if (arg === 'unborn') unborn = true;
    else if (arg.startsWith('ref-prefix ')) prefixes.push(arg.slice('ref-prefix '.length));
  }
  const matches = (name: string): boolean => prefixes.length === 0 || prefixes.some((prefix) => name.startsWith(prefix));
  const chunks: Buffer[] = [];
  const headRef = `refs/heads/${repo.defaultBranch}`;
  const headTip = repo.refs.get(headRef);
  if (matches('HEAD')) {
    if (headTip !== undefined) {
      chunks.push(pktLine(`${headTip} HEAD${symrefs ? ` symref-target:${headRef}` : ''}\n`));
    } else if (unborn) {
      chunks.push(pktLine(`unborn HEAD${symrefs ? ` symref-target:${headRef}` : ''}\n`));
    }
  }
  const names = [...repo.refs.keys()].sort();
  for (const name of names) {
    if (!matches(name)) continue;
    const oid = repo.refs.get(name)!;
    let line = `${oid} ${name}`;
    const obj = getObject(oid);
    if (peel && obj !== undefined && obj.type === 'tag') line += ` peeled:${peelToCommit(oid)}`;
    chunks.push(pktLine(`${line}\n`));
  }
  chunks.push(PKT_FLUSH);
  return Buffer.concat(chunks);
}

// ---------------------------------------------------------------- fetch planning

export interface FetchArgs {
  wants: string[];
  haves: string[];
  clientShallow: string[];
  depth?: number;
  deepen?: number;
  deepenSince?: number;
  deepenNot: string[];
  done: boolean;
  noProgress: boolean;
}

export interface FetchPlan {
  /** Object shas to pack, commits first. */
  objects: string[];
  shallow: string[];
  unshallow: string[];
  /** Haves that exist in the store (for ACK lines). */
  commonHaves: string[];
}

function collectTreeObjects(treeSha: string, into: Set<string>): void {
  if (into.has(treeSha)) return;
  const obj = getObject(treeSha);
  if (obj === undefined || obj.type !== 'tree') return;
  into.add(treeSha);
  const flat = flattenTree(treeSha);
  for (const entry of flat.values()) into.add(entry.sha);
  // Subtree shas: walk the tree structure itself.
  const walk = (sha: string): void => {
    const current = getObject(sha);
    if (current === undefined || current.type !== 'tree') return;
    const data = current.data;
    let offset = 0;
    while (offset < data.length) {
      const space = data.indexOf(0x20, offset);
      if (space === -1) break;
      const mode = data.toString('utf8', offset, space);
      const nul = data.indexOf(0x00, space + 1);
      if (nul === -1 || nul + 21 > data.length) break;
      const childSha = data.toString('hex', nul + 1, nul + 21);
      if (mode === '40000') {
        if (!into.has(childSha)) {
          into.add(childSha);
          walk(childSha);
        }
      }
      offset = nul + 21;
    }
  };
  walk(treeSha);
}

/** Compute the object set and shallow bookkeeping for one fetch. */
export function planFetch(repo: RepoRec, args: FetchArgs): FetchPlan {
  const boundary = new Set(args.clientShallow);
  const commonHaves = args.haves.filter((have) => getObject(have) !== undefined);
  const haveCommits = reachableCommits(args.haves, boundary);
  // Objects the client provably holds: its have-closure commits and their trees/blobs.
  const negative = new Set<string>();
  for (const sha of haveCommits) {
    negative.add(sha);
    const commit = parseCommit(sha);
    if (commit !== null) collectTreeObjects(commit.tree, negative);
  }
  for (const notRef of args.deepenNot) {
    const tip = repo.refs.get(notRef) ?? (getObject(notRef) !== undefined ? notRef : undefined);
    if (tip !== undefined) {
      for (const sha of reachableCommits([tip])) {
        negative.add(sha);
        const commit = parseCommit(sha);
        if (commit !== null) collectTreeObjects(commit.tree, negative);
      }
    }
  }
  // Generation-limited BFS from the wants.
  const shallowMode = args.depth !== undefined || args.deepen !== undefined || args.deepenSince !== undefined || boundary.size > 0;
  const generation = new Map<string, number>();
  const included = new Set<string>();
  const queue: Array<{ sha: string; gen: number }> = [];
  const tagObjects: string[] = [];
  for (const want of args.wants) {
    const obj = getObject(want);
    if (obj === undefined) continue;
    if (obj.type === 'tag') {
      tagObjects.push(want);
      const target = peelToCommit(want);
      queue.push({ sha: target, gen: 0 });
    } else if (obj.type === 'commit') {
      queue.push({ sha: want, gen: 0 });
    }
  }
  // The deepen limit: generations below the first boundary commit the client already holds.
  // A `deepen` with no shallow state is a plain depth from the wants (the v2 wire sends the
  // client's depth as `deepen N`); with shallow state it extends the boundary by N.
  let maxGeneration = Number.POSITIVE_INFINITY;
  if (args.depth !== undefined) maxGeneration = args.depth - 1;
  else if (args.deepen !== undefined && boundary.size === 0) maxGeneration = args.deepen - 1;
  const deepen = args.deepen;
  let boundaryGeneration: number | null = null;
  while (queue.length > 0) {
    const { sha, gen } = queue.shift()!;
    const known = generation.get(sha);
    if (known !== undefined && known <= gen) continue;
    generation.set(sha, gen);
    const commit = parseCommit(sha);
    if (commit === null) continue;
    const isBoundary = boundary.has(sha);
    if (isBoundary && boundaryGeneration === null) boundaryGeneration = gen;
    if (deepen !== undefined && boundaryGeneration !== null) {
      maxGeneration = Math.min(maxGeneration, boundaryGeneration + deepen - 1);
    }
    if (haveCommits.has(sha) && !isBoundary) continue; // the client has it and its ancestry
    if (gen > maxGeneration) continue;
    if (args.deepenSince !== undefined && commit.time < args.deepenSince && !args.wants.includes(sha)) continue;
    included.add(sha);
    if (gen >= maxGeneration && args.deepenSince === undefined) {
      // Depth-limited: parents are not expanded.
      if (!(deepen !== undefined && isBoundary)) continue;
    }
    for (const parent of commit.parents) queue.push({ sha: parent, gen: gen + 1 });
  }
  // Boundary commits are the client's own: never include them, but traversal above already
  // walked through them when a deepen was requested.
  for (const sha of boundary) included.delete(sha);
  const objects: string[] = [];
  const objectSet = new Set<string>();
  const pushObject = (sha: string): void => {
    if (!objectSet.has(sha) && !negative.has(sha)) {
      objectSet.add(sha);
      objects.push(sha);
    }
  };
  for (const sha of tagObjects) pushObject(sha);
  const includedSorted = [...included].sort((a, b) => (generation.get(a) ?? 0) - (generation.get(b) ?? 0));
  for (const sha of includedSorted) pushObject(sha);
  const treeObjects = new Set<string>();
  for (const sha of included) {
    const commit = parseCommit(sha);
    if (commit !== null) collectTreeObjects(commit.tree, treeObjects);
  }
  for (const sha of treeObjects) pushObject(sha);
  // Shallow bookkeeping.
  const shallow: string[] = [];
  const unshallow: string[] = [];
  if (shallowMode) {
    for (const sha of included) {
      const commit = parseCommit(sha);
      if (commit === null) continue;
      const cut = commit.parents.some((parent) => !included.has(parent) && !haveCommits.has(parent));
      if (cut) shallow.push(sha);
    }
    for (const sha of boundary) {
      const commit = parseCommit(sha);
      if (commit === null) continue;
      if (commit.parents.some((parent) => included.has(parent))) unshallow.push(sha);
    }
  }
  return { objects, shallow, unshallow, commonHaves };
}

const packCache = new Map<string, Buffer>();

export function packFor(objects: readonly string[]): Buffer {
  const key = objects.join(' ');
  const cached = packCache.get(key);
  if (cached !== undefined) return cached;
  const pack = writePack(objects);
  if (packCache.size > 64) packCache.clear();
  packCache.set(key, pack);
  return pack;
}

/** Frame a pack as sideband packets (band 1), each payload within the 64k pkt-line limit. */
export function sidebandPackets(pack: Buffer): Buffer[] {
  const chunks: Buffer[] = [];
  const BAND_DATA = 65515;
  for (let offset = 0; offset < pack.length; offset += BAND_DATA) {
    const slice = pack.subarray(offset, Math.min(pack.length, offset + BAND_DATA));
    chunks.push(pktLine(Buffer.concat([Buffer.from([1]), slice])));
  }
  if (chunks.length === 0) chunks.push(pktLine(Buffer.concat([Buffer.from([1]), Buffer.alloc(0)])));
  return chunks;
}

/** Parse fetch arguments from the lines after `command=fetch`. */
export function parseFetchArgs(lines: readonly string[]): FetchArgs {
  const args: FetchArgs = { wants: [], haves: [], clientShallow: [], deepenNot: [], done: false, noProgress: false };
  for (const line of lines) {
    if (line.startsWith('want ')) args.wants.push(line.slice(5).trim().split(' ')[0]!);
    else if (line.startsWith('have ')) args.haves.push(line.slice(5).trim());
    else if (line.startsWith('shallow ')) args.clientShallow.push(line.slice(8).trim());
    else if (line.startsWith('deepen ')) args.deepen = Number(line.slice(7).trim());
    else if (line.startsWith('deepen-since ')) args.deepenSince = Number(line.slice(13).trim());
    else if (line.startsWith('deepen-not ')) args.deepenNot.push(line.slice(11).trim());
    else if (line === 'done') args.done = true;
    else if (line === 'no-progress') args.noProgress = true;
  }
  return args;
}

/** A v2 fetch response: acknowledgments, shallow-info, then the packfile section. */
export function fetchResponseV2(plan: FetchPlan, args: FetchArgs): Buffer {
  const chunks: Buffer[] = [];
  chunks.push(pktLine('acknowledgments\n'));
  if (args.done) {
    if (plan.commonHaves.length > 0) {
      for (const have of plan.commonHaves) chunks.push(pktLine(`ACK ${have}\n`));
      chunks.push(pktLine('ready\n'));
    } else {
      chunks.push(pktLine('NAK\n'));
    }
  } else if (plan.commonHaves.length > 0) {
    for (const have of plan.commonHaves) chunks.push(pktLine(`ACK ${have}\n`));
  } else {
    chunks.push(pktLine('NAK\n'));
  }
  chunks.push(PKT_FLUSH);
  if (!args.done) return Buffer.concat(chunks);
  if (plan.shallow.length > 0 || plan.unshallow.length > 0) {
    chunks.push(pktLine('shallow-info\n'));
    for (const sha of plan.shallow) chunks.push(pktLine(`shallow ${sha}\n`));
    for (const sha of plan.unshallow) chunks.push(pktLine(`unshallow ${sha}\n`));
    chunks.push(PKT_FLUSH);
  }
  chunks.push(pktLine('packfile\n'));
  chunks.push(...sidebandPackets(packFor(plan.objects)));
  chunks.push(PKT_FLUSH);
  return Buffer.concat(chunks);
}

/** A v0 fetch response: shallow lines, one ACK or NAK, then the sideband pack. */
export function fetchResponseV0(plan: FetchPlan, args: FetchArgs): Buffer {
  const chunks: Buffer[] = [];
  for (const sha of plan.shallow) chunks.push(pktLine(`shallow ${sha}\n`));
  for (const sha of plan.unshallow) chunks.push(pktLine(`unshallow ${sha}\n`));
  if (!args.done) {
    if (plan.commonHaves.length > 0) chunks.push(pktLine(`ACK ${plan.commonHaves[plan.commonHaves.length - 1]}\n`));
    else chunks.push(pktLine('NAK\n'));
    return Buffer.concat(chunks);
  }
  if (plan.commonHaves.length > 0) chunks.push(pktLine(`ACK ${plan.commonHaves[plan.commonHaves.length - 1]}\n`));
  else chunks.push(pktLine('NAK\n'));
  chunks.push(...sidebandPackets(packFor(plan.objects)));
  chunks.push(PKT_FLUSH);
  return Buffer.concat(chunks);
}

// ---------------------------------------------------------------- receive-pack

export interface PushOutcome {
  status: number;
  body: Buffer;
}

/** Handle one receive-pack POST body. Never throws: a malformed body is a 400. */
export function receivePack(repo: RepoRec, body: Buffer): PushOutcome {
  let packets: Packet[];
  let next: number;
  try {
    const parsed = parsePackets(body, 0);
    packets = parsed.packets;
    next = parsed.next;
  } catch {
    return { status: 400, body: Buffer.from('malformed pkt-line stream') };
  }
  const lines = packetLines(packets);
  if (lines.length === 0 && packets.length === 0) return { status: 400, body: Buffer.from('empty push') };
  // The first command line carries the client's capabilities after a NUL.
  let clientCaps = '';
  const commands: Array<{ oldOid: string; newOid: string; ref: string }> = [];
  lines.forEach((line, index) => {
    let text = line;
    if (index === 0) {
      const nul = text.indexOf('\0');
      if (nul !== -1) {
        clientCaps = text.slice(nul + 1);
        text = text.slice(0, nul);
      }
    }
    const parts = text.split(' ');
    if (parts.length === 3) commands.push({ oldOid: parts[0]!, newOid: parts[1]!, ref: parts[2]! });
  });
  if (commands.length === 0) return { status: 400, body: Buffer.from('no ref commands') };
  const packBytes = body.subarray(next);
  let unpackOk = true;
  let unpackDetail = '';
  if (packBytes.length > 0) {
    try {
      readPack(packBytes);
    } catch (error) {
      unpackOk = false;
      unpackDetail = error instanceof Error ? error.message : String(error);
      if (process.env.FORGE_DEBUG_PACKS === '1') {
        import('node:fs').then((fs) => fs.writeFileSync(`/tmp/badpack-${Date.now()}.bin`, packBytes)).catch(() => undefined);
      }
    }
  }
  const results: Array<{ ref: string; ok: boolean; reason: string }> = [];
  if (!unpackOk) {
    for (const command of commands) results.push({ ref: command.ref, ok: false, reason: 'unpack failed' });
  } else {
    for (const command of commands) {
      results.push(applyPushCommand(repo, command));
    }
  }
  const report: Buffer[] = [pktLine(unpackOk ? 'unpack ok\n' : `unpack ${unpackDetail || 'failed'}\n`)];
  for (const result of results) {
    report.push(pktLine(result.ok ? `ok ${result.ref}\n` : `ng ${result.ref} ${result.reason}\n`));
  }
  report.push(PKT_FLUSH);
  const reportStream = Buffer.concat(report);
  if (clientCaps.split(' ').includes('side-band-64k')) {
    return { status: 200, body: Buffer.concat([...sidebandPackets(reportStream), PKT_FLUSH]) };
  }
  return { status: 200, body: reportStream };
}

function applyPushCommand(repo: RepoRec, command: { oldOid: string; newOid: string; ref: string }): { ref: string; ok: boolean; reason: string } {
  const { ref, oldOid, newOid } = command;
  if (!ref.startsWith('refs/')) return { ref, ok: false, reason: 'invalid ref' };
  const current = repo.refs.get(ref);
  if (newOid === ZERO_OID) {
    // Delete.
    if (current === undefined) return { ref, ok: false, reason: 'reference does not exist' };
    repo.refs.delete(ref);
    return { ref, ok: true, reason: '' };
  }
  const target = getObject(newOid);
  if (target === undefined) return { ref, ok: false, reason: 'unknown object' };
  if (current === undefined) {
    if (oldOid !== ZERO_OID && oldOid !== undefined) {
      // Creating over a missing ref with a non-zero old is a mismatch; git tolerates only zero.
      if (oldOid !== ZERO_OID) return { ref, ok: false, reason: 'reference does not exist' };
    }
    repo.refs.set(ref, newOid);
    return { ref, ok: true, reason: '' };
  }
  if (current === newOid) return { ref, ok: true, reason: '' };
  if (ref.startsWith('refs/heads/')) {
    const targetCommit = target.type === 'tag' ? peelToCommit(newOid) : newOid;
    const currentCommit = getObject(current)?.type === 'tag' ? peelToCommit(current) : current;
    if (!isAncestor(currentCommit, targetCommit)) return { ref, ok: false, reason: 'non-fast-forward' };
    if (oldOid !== current && oldOid !== ZERO_OID) return { ref, ok: false, reason: 'stale ref' };
  }
  repo.refs.set(ref, newOid);
  return { ref, ok: true, reason: '' };
}
