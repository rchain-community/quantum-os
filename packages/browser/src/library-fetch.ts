// library-fetch.ts — moving a file from whoever has it to whoever asked.
//
// Layer 4 of `Media_Libraries.md`, and it is `attachments.ts` with the request
// turned around. An attachment is pushed: you send a file and everyone present
// receives it whether they wanted it or not, which is why it is capped at 8 MB
// — that cap is a property of broadcasting, not of the channel.
//
// A library is fetched. One asker, one holder, one hash, and the transfer is
// paced against that one connection, so the size limit can be what a person
// will wait for rather than what a room will tolerate.
//
// THE HASH IS WHY THIS IS SAFE. The name of what was asked for is the digest of
// what should arrive, so a sender cannot substitute other bytes: the fetch is
// verified against the name it was fetched by, and a mismatch is deleted rather
// than stored. Nothing here has to trust the peer that answered.
//
// Arrival is written to disk as it comes, under a `.part` name the index
// refuses to count, so a fetch interrupted by a closed tab leaves nothing that
// looks like a file we hold.

import type { QOSPeer } from "./peer.js";
import { hashBlob, openPart, dropPart, fmtSize, type PartWriter } from "./library.js";

/** What a fetch needs from the app. */
export interface FetchHost {
  peer(): QOSPeer | null;
  say(text: string): void;
  label(peerId: string): string;
  /** The bytes we hold for a hash, for serving someone else's ask. */
  bytesFor(hash: string): Promise<File | null>;
  /** A verified arrival: keep it, and tell the room we are now a holder. */
  received(hash: string, file: File, name: string, mime: string): Promise<void>;
}

export interface LibraryFetch {
  /** Ask one holder for one hash. */
  want(hash: string, from: string, name: string): void;
  /** Give up on one fetch, or all of them. */
  cancel(hash?: string): void;
  /** Handle a `lib-*` envelope. True when it was ours. */
  inbound(from: string, d: Record<string, unknown>): boolean;
  /** How many fetches are in flight. */
  active(): number;
}

/**
 * What a fetch will carry.
 *
 * Far past the 8 MB an attachment allows, and not unbounded: verifying an
 * arrival hashes it in one pass, so the whole file is briefly in memory at the
 * end. Streaming that digest is what would raise this again, and until it is
 * written the number should be one a laptop can hold.
 */
export const FETCH_MAX = 64 * 1024 * 1024;

/**
 * Bytes per chunk. Base64 inflates by 4/3 and the channel's payload cap is
 * 64 KB, so 12 KB of file is a ~16 KB message — the same arithmetic
 * `attachments.ts` does, done in the other direction.
 */
const BIN_CHUNK = 12 * 1024;
/** How often to say something while a large file arrives. */
const PROGRESS_EVERY = 0.2;
/** How long an unanswered ask stays outstanding before it can be asked again. */
const ASK_TIMEOUT_MS = 60_000;

interface Incoming {
  from: string;
  name: string;
  mime: string;
  size: number;
  total: number;
  next: number;
  part: PartWriter;
  started: number;
  toldAt: number;
}

export function createLibraryFetch(host: FetchHost): LibraryFetch {
  const incoming = new Map<string, Incoming>();
  /**
   * What we asked for, and of whom.
   *
   * A fetch is something you started. Without this, any peer could open a
   * transfer at any moment and write 64 MB into your storage unasked — which is
   * the push model this exists to get away from.
   */
  const asked = new Map<string, { from: string; name: string }>();

  /** Wait for the channel's buffers to drain, as attachments.ts does. */
  const pace = (): Promise<void> => new Promise((resolve) => {
    const check = (): void => {
      const peer = host.peer();
      if (!peer || peer.maxBufferedAmount() < (1 << 20)) resolve();
      else setTimeout(check, 30);
    };
    check();
  });

  const toB64 = (buf: ArrayBuffer): string => {
    const bytes = new Uint8Array(buf);
    let s = "";
    for (let i = 0; i < bytes.length; i += 0x8000) {
      s += String.fromCharCode(...bytes.subarray(i, i + 0x8000));
    }
    return btoa(s);
  };

  const fromB64 = (s: string): ArrayBuffer => {
    const bin = atob(s);
    const out = new Uint8Array(new ArrayBuffer(bin.length));
    for (let i = 0; i < bin.length; i++) out[i] = bin.charCodeAt(i);
    return out.buffer;
  };

  /**
   * Somebody asked us for a hash. Answer with the bytes, or say we cannot.
   *
   * Read a slice at a time rather than the whole file: the receiver writes as
   * it goes, and a sender that held 64 MB plus its base64 in memory to serve it
   * would be the one place in the transfer that could not survive its own size.
   */
  async function serve(to: string, hash: string): Promise<void> {
    const peer = host.peer();
    if (!peer) return;
    const file = await host.bytesFor(hash);
    if (!file) { peer.send(to, { kind: "lib-deny", hash, why: "not held" }); return; }
    const total = Math.max(1, Math.ceil(file.size / BIN_CHUNK));
    peer.send(to, {
      kind: "lib-head", hash, name: file.name, mime: file.type || "application/octet-stream",
      size: file.size, total,
    });
    for (let i = 0; i < total; i++) {
      // The asker may have gone; sending into a closed channel is wasted work.
      if (!peer.hasChannel(to)) return;
      const slice = file.slice(i * BIN_CHUNK, (i + 1) * BIN_CHUNK);
      // Bulk: over the direct channel only (see peer.ts SendOptions).
      peer.send(to, { kind: "lib-part", hash, seq: i, data: toB64(await slice.arrayBuffer()) }, { bulk: true });
      if ((i & 31) === 31) await pace();
    }
    host.say(`↑ sent ${file.name} to ${host.label(to)}  (${fmtSize(file.size)})`);
  }

  /** Stop a fetch and leave nothing behind. */
  async function abandon(hash: string, why: string): Promise<void> {
    asked.delete(hash);
    const inc = incoming.get(hash);
    if (!inc) return;
    incoming.delete(hash);
    await inc.part.abort();
    host.say(`✗ ${inc.name}: ${why}`);
  }

  async function finish(hash: string, inc: Incoming): Promise<void> {
    incoming.delete(hash);
    asked.delete(hash);
    const file = await inc.part.close();
    if (!file) { await dropPart(hash); host.say(`✗ ${inc.name}: could not be written`); return; }
    // The name was the digest, so this is the whole of the trust model: bytes
    // that do not hash to what was asked for are not the file, whoever sent them.
    const got = await hashBlob(file);
    if (got !== hash) {
      await dropPart(hash);
      host.say(`✗ ${inc.name}: what arrived is not what was asked for — ${got.slice(0, 12)} ≠ ${hash.slice(0, 12)}. Discarded.`);
      return;
    }
    await host.received(hash, file, inc.name, inc.mime);
    await dropPart(hash);
    const secs = Math.max(1, Math.round((Date.now() - inc.started) / 1000));
    host.say(`✓ ${inc.name}  ${fmtSize(inc.size)} in ${secs}s — verified and held`);
  }

  return {
    want(hash, from, name) {
      const peer = host.peer();
      if (!peer) { host.say("connect to a room before fetching"); return; }
      if (incoming.has(hash) || asked.has(hash)) { host.say(`already fetching ${name}`); return; }
      asked.set(hash, { from, name });
      if (!peer.hasChannel(from)) {
        host.say(`no channel to ${host.label(from)} — they are in the room but not reachable from here`);
        return;
      }
      peer.send(from, { kind: "lib-want", hash });
      host.say(`↓ asked ${host.label(from)} for ${name}…`);
      // An ask that is never answered should not block asking again forever.
      setTimeout(() => { if (!incoming.has(hash)) asked.delete(hash); }, ASK_TIMEOUT_MS);
    },

    cancel(hash) {
      const targets = hash ? [hash] : [...new Set([...incoming.keys(), ...asked.keys()])];
      for (const h of targets) { asked.delete(h); void abandon(h, "cancelled"); }
    },

    inbound(from, d) {
      const kind = String(d.kind ?? "");
      const hash = String(d.hash ?? "").toLowerCase();
      if (!kind.startsWith("lib-")) return false;
      if (!/^[0-9a-f]{64}$/.test(hash)) return true;   // ours, and malformed

      if (kind === "lib-want") { void serve(from, hash); return true; }

      if (kind === "lib-deny") {
        void abandon(hash, `${host.label(from)} does not have it`);
        return true;
      }

      if (kind === "lib-head") {
        // Only what we asked for, and only from whom we asked. An unrequested
        // head is a peer pushing a file at us; broadcasting is where that
        // belongs, and it has its own much smaller cap.
        const want = asked.get(hash);
        if (!want || want.from !== from || incoming.has(hash)) return true;
        const size = Number(d.size ?? 0);
        const total = Number(d.total ?? 0);
        if (!(size > 0) || size > FETCH_MAX || !(total > 0) || total > Math.ceil(FETCH_MAX / BIN_CHUNK) + 2) {
          host.say(`✗ refused a transfer of ${fmtSize(size)} — over the ${fmtSize(FETCH_MAX)} fetch limit`);
          return true;
        }
        void (async () => {
          const part = await openPart(hash);
          if (!part) { host.say("✗ this browser's storage refused the file"); return; }
          incoming.set(hash, {
            from, name: String(d.name ?? "file").slice(0, 200),
            mime: String(d.mime ?? "application/octet-stream").slice(0, 100),
            size, total, next: 0, part, started: Date.now(), toldAt: 0,
          });
        })();
        return true;
      }

      if (kind === "lib-part") {
        const inc = incoming.get(hash);
        if (!inc || from !== inc.from) return true;
        const seq = Number(d.seq ?? -1);
        // Data channels are ordered, so a gap is a bug or a liar, not weather.
        if (seq !== inc.next) { void abandon(hash, `chunk ${seq} arrived where ${inc.next} was due`); return true; }
        inc.next++;
        void (async () => {
          try { await inc.part.write(fromB64(String(d.data ?? ""))); }
          catch { void abandon(hash, "could not be written"); return; }
          const done = inc.next / inc.total;
          if (done - inc.toldAt >= PROGRESS_EVERY && inc.next < inc.total) {
            inc.toldAt = done;
            host.say(`↓ ${inc.name}  ${Math.round(done * 100)}%`);
          }
          if (inc.next >= inc.total) await finish(hash, inc);
        })();
        return true;
      }

      return true;
    },

    active: () => incoming.size,
  };
}
