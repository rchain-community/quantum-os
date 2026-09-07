// calls.test.mjs — what a screen share actually sends.
//
// Written after a report from a room with nobody else in it: the camera was
// running, the preview showed it, and sharing refused with "no video is being
// sent". The check had asked the peer connections what they carried, and alone
// there are none — so it confused "nobody is receiving" with "nothing to send".
//
// What matters is not that the code runs but WHAT ENDS UP IN THE STREAM, since
// that stream is what a peer connecting later is given. So the media is stubbed
// and the assertions are about tracks: which one is in the stream we would send,
// and which one each sender carries.
//
//   node packages/browser/test/calls.test.mjs
//
// calls.ts is TypeScript, so it is bundled in-process rather than imported.

import { build } from "esbuild";
import { fileURLToPath } from "node:url";
import { dirname, join } from "node:path";

const here = dirname(fileURLToPath(import.meta.url));
const bundle = await build({
  absWorkingDir: here,
  entryPoints: [join(here, "..", "src", "calls.ts")],
  bundle: true, format: "esm", platform: "node", write: false,
});
const mod = await import(
  "data:text/javascript;base64," + Buffer.from(bundle.outputFiles[0].text).toString("base64")
);

// --- stub media -------------------------------------------------------------

class Track {
  constructor(kind, label) { this.kind = kind; this.label = label; this.enabled = true; this._h = {}; }
  stop() { this.stopped = true; }
  addEventListener(n, f) { this._h[n] = f; }
  fire(n) { this._h[n]?.(); }
}
class Stream {
  constructor(tracks = []) { this.tracks = tracks; }
  getTracks() { return this.tracks; }
  getVideoTracks() { return this.tracks.filter((t) => t.kind === "video"); }
  getAudioTracks() { return this.tracks.filter((t) => t.kind === "audio"); }
  addTrack(t) { this.tracks.push(t); }
  removeTrack(t) { this.tracks = this.tracks.filter((x) => x !== t); }
}
// Enough of an element to hold a tree: the tiles are looked up through it
// (`video.closest(".call-tile")`, `wrap.querySelector(".call-name")`), so a
// stub that answers those with throwaways would assert nothing.
const docHandlers = {};
const el = () => {
  const classes = new Set();
  const node = {
    hidden: true, dataset: {}, style: {}, textContent: "", title: "",
    disabled: false, muted: false, srcObject: null, autoplay: false, playsInline: false,
    children: [], parent: null, handlers: {},
    get className() { return [...classes].join(" "); },
    set className(v) { classes.clear(); for (const c of String(v).split(/\s+/).filter(Boolean)) classes.add(c); },
    classList: {
      add: (...c) => c.forEach((x) => classes.add(x)),
      remove: (...c) => c.forEach((x) => classes.delete(x)),
      contains: (c) => classes.has(c),
    },
    appendChild(kid) { kid.parent = node; node.children.push(kid); return kid; },
    append(...kids) { kids.forEach((k) => node.appendChild(k)); },
    remove() { node.parent = null; },
    addEventListener(n, f) { node.handlers[n] = f; },
    fire(n, ev = {}) { node.handlers[n]?.({ stopPropagation() {}, preventDefault() {}, ...ev }); },
    querySelector(sel) {
      const want = sel.replace(".", "");
      const hit = node.children.find((k) => k.classList.contains(want));
      return hit ?? node.children.map((k) => k.querySelector(sel)).find(Boolean) ?? null;
    },
    closest(sel) {
      const want = sel.replace(".", "");
      for (let n = node; n; n = n.parent) if (n.classList.contains(want)) return n;
      return null;
    },
  };
  return node;
};

// defineProperty, not assignment: node 22 defines `navigator` itself as a
// getter-only property, so `globalThis.navigator = …` throws there while
// working fine on node 20. CI runs 22.
const provide = (name, value) =>
  Object.defineProperty(globalThis, name, { value, configurable: true, writable: true });

provide("document", { createElement: () => el(), addEventListener(n, f) { docHandlers[n] = f; } });
provide("window", { isSecureContext: true });
// The browser's stored answer about camera/mic. "denied" is why a prompt never
// appears, which is the thing people report as "it doesn't ask".
let permission = "prompt";
const store = new Map();
provide("localStorage", {
  getItem: (k) => (store.has(k) ? store.get(k) : null),
  setItem: (k, v) => store.set(k, String(v)),
});

const camera = new Track("video", "camera");
const mic    = new Track("audio", "mic");
const screen = new Track("video", "screen");
screen.getSettings = () => ({ displaySurface: "monitor" });
provide("navigator", {
  permissions: { query: async () => ({ state: permission }) },
  mediaDevices: {
  getUserMedia:    async () => new Stream([mic, camera]),
  getDisplayMedia: async () => new Stream([screen]),
} });

// Long-delay timers (the post-start media-reach check) are captured so the test
// can fire them without waiting; short ones (settle) stay real.
const realSetTimeout = globalThis.setTimeout;
const longTimers = [];
provide("setTimeout", (fn, ms) => {
  if (ms <= 1000) return realSetTimeout(fn, ms);
  longTimers.push(fn);
  return -longTimers.length;
});
provide("clearTimeout", (id) => {
  if (typeof id === "number" && id < 0) longTimers[-id - 1] = null;
});
const fireLong = () => {
  while (longTimers.length) { const f = longTimers.shift(); if (f) { f(); return; } }
};

// --- the room: one person, nobody connected ---------------------------------

const sentToJoiners = [];      // what addLocalMedia was handed, by track label
let senders = [];              // what the connections carry, when there are any
const peer = {
  peerId: "abc123",
  addLocalMedia(s) { sentToJoiners.push(s.getVideoTracks().map((t) => t.label)); },
  removeLocalMedia() {}, broadcast() {},
  videoSenders() { return senders; },
};
const said = [];
const tilesEl = el();
const calls = mod.createCalls(
  { peer: () => peer, say: (t) => said.push(t), label: () => "peer", isAgent: () => false, mediaBlocked: () => [] },
  { bar: el(), tiles: tilesEl, mute: el(), cam: el(), share: el() },
);
const tileFor = (key) => tilesEl.children.find((c) => c.dataset.key === key);

let failed = 0;
const settle = () => new Promise((r) => setTimeout(r, 20));
const check = (label, cond, detail) => {
  if (cond) console.log(`  ok   ${label}`);
  else { failed++; console.log(`  FAIL ${label}  (${detail})`); }
};
const lastSent = () => sentToJoiners[sentToJoiners.length - 1] ?? [];

calls.toggle();
await settle();
check("a call starts", calls.inCall(), "not in a call");

// --- alone in the room ------------------------------------------------------
calls.toggleScreen();
await settle();
check("sharing alone is not refused",
      !said.some((s) => s.includes("nothing to share in its place")), said.join(" | "));
check("it says it is sharing", said.some((s) => s.includes("you are sharing")), said.join(" | "));
check("a joiner would be given the screen", lastSent().includes("screen"), JSON.stringify(sentToJoiners));
check("a joiner would not be given the camera", !lastSent().includes("camera"), JSON.stringify(sentToJoiners));

// --- with somebody connected ------------------------------------------------
let replaced = [];
senders = [{ track: camera, replaceTrack: async (t) => { replaced.push(t?.label ?? null); } }];

calls.toggleScreen();          // stop
await settle();
check("stopping puts the camera back", replaced.includes("camera"), JSON.stringify(replaced));

calls.toggleScreen();          // share again, now with a sender to swap
await settle();
check("with a peer, the sender is swapped rather than renegotiated",
      replaced.includes("screen"), JSON.stringify(replaced));

replaced = [];
screen.fire("ended");          // the browser's own "stop sharing" control
await settle();
check("the browser's stop-sharing restores the camera",
      replaced.includes("camera"), JSON.stringify(replaced));

// --- what a recording can reach ---------------------------------------------
// A recording needs the room's voices from the call itself: capturing a window
// offers no audio, so the picker cannot supply them.
calls.remoteStream("ann", new Stream([new Track("audio", "ann-voice"), new Track("video", "ann-cam")]));
check("a peer's voice is reachable for recording",
      calls.audioTracks().map((t) => t.label).includes("ann-voice"),
      JSON.stringify(calls.audioTracks().map((t) => t.label)));
calls.peerGone("ann");
check("and is gone when they leave", calls.audioTracks().length === 0,
      JSON.stringify(calls.audioTracks().map((t) => t.label)));

// --- a screen is not a thumbnail --------------------------------------------
// 160×120 is unreadable for a shared screen, so any tile can be clicked to
// fill the window, and our own tile says which one it is (the caption, and
// `contain` instead of `cover` via the data attribute).
const localTile = () => tileFor("__local__");

calls.toggleScreen();          // share once more
await settle();
check("the local tile knows it is a screen", localTile()?.dataset.screen === "1",
      JSON.stringify(localTile()?.dataset));
check("and says so", localTile()?.querySelector(".call-name")?.textContent === "you — screen",
      localTile()?.querySelector(".call-name")?.textContent);

calls.toggleScreen();          // stop
await settle();
check("and is a face again when sharing stops", localTile()?.dataset.screen === undefined,
      JSON.stringify(localTile()?.dataset));

// --- clicking a tile is what makes it big ------------------------------------
// Nothing comes up big on its own: a tile is big because somebody clicked it.
calls.remoteStream("bob", new Stream([new Track("video", "bob-video")]));
check("a tile arrives small", !tileFor("bob")?.classList.contains("expanded"),
      tileFor("bob")?.className);

tileFor("bob")?.fire("click");
check("clicking it makes it big", tileFor("bob")?.classList.contains("expanded"),
      tileFor("bob")?.className);

docHandlers.keydown?.({ key: "Escape" });
check("Esc shrinks it", !tileFor("bob")?.classList.contains("expanded"), tileFor("bob")?.className);

tileFor("bob")?.fire("click");
calls.remoteStream("dot", new Stream([new Track("video", "dot-video")]));
tileFor("dot")?.fire("click");
check("only one tile is ever big",
      tilesEl.children.filter((c) => c.classList.contains("expanded")).length === 1,
      tilesEl.children.map((c) => c.className).join(" | "));


check("it says which surface was actually shared",
      said.some((s) => s.includes("sharing your entire screen")), said.join(" | "));

// --- "I allowed it to ask, but it never asks" --------------------------------
// A prompt appears only when the answer is unknown. A stored block means
// silence, which is reported as the app being broken — so the app reads the
// stored answer and says it.
said.length = 0;
permission = "denied";
calls.end();
calls.toggle();
await settle();
check("a stored block is explained rather than waited on",
      said.some((t) => t.includes("will not ask again")), said.join(" | "));
check("and it says where to change it",
      said.some((t) => t.includes("Site settings")), said.join(" | "));
check("including when the browser itself lacks the permission",
      said.some((t) => t.includes("operating system")), said.join(" | "));
permission = "prompt";

// --- a call adds media on start and removes it on end ----------------------
// Full mesh: a direct connection to every room peer already exists, so
// addLocalMedia adds the call's tracks to each and renegotiates; end() takes
// them back off. No pinning — there is nothing to pin.
{
  const calls2 = [];
  const mediaPeer = {
    peerId: "m1",
    addLocalMedia() { calls2.push("add"); },
    removeLocalMedia() { calls2.push("remove"); },
    broadcast() {}, videoSenders() { return []; },
  };
  const mediaCalls = mod.createCalls(
    { peer: () => mediaPeer, say: () => {}, label: () => "peer", isAgent: () => false, mediaBlocked: () => [] },
    { bar: el(), tiles: el(), mute: el(), cam: el(), share: el() },
  );
  mediaCalls.toggle();   // start
  await settle();
  check("starting a call adds local media to the mesh", calls2[0] === "add", JSON.stringify(calls2));
  mediaCalls.toggle();   // end
  check("ending a call removes local media", calls2.includes("remove"), JSON.stringify(calls2));
}

// --- a call the media can't cross to a peer says so, once ------------------
// Chat floods through the overlay so it keeps working; a MediaStreamTrack
// can't, so a call between two networks with no relay that crosses is silently
// one-way. Checked a short time after start, because that is when it is wrong
// with nothing on screen to say so (quantum-os#126).
{
  const saidR = [];
  let blocked = ["r1"];
  const rPeer = {
    peerId: "r0", addLocalMedia() {}, removeLocalMedia() {}, broadcast() {},
    videoSenders() { return []; },
  };
  const rCalls = mod.createCalls(
    {
      peer: () => rPeer, say: (t) => saidR.push(t), label: (id) => id,
      isAgent: () => false, mediaBlocked: () => blocked,
    },
    { bar: el(), tiles: el(), mute: el(), cam: el(), share: el() },
  );
  const crossings = () => saidR.filter((t) => t.includes("can't get the call")).length;

  longTimers.length = 0;        // drop any stale timers from earlier instances
  rCalls.toggle();              // start
  await settle();
  fireLong();                   // the early check
  check("a call participant the media can't reach is named, with a fix to try",
        saidR.some((t) => t.includes("r1") && t.includes("/ice turn")), saidR.join(" | "));
  const once = crossings();
  fireLong();                   // the later check — still blocked, already warned
  check("and is named only once per call", crossings() === once, saidR.join(" | "));

  rCalls.toggle();              // end
  blocked = [];                 // everyone connects this time
  rCalls.toggle();              // start again
  await settle();
  fireLong(); fireLong();
  check("a call where everyone connects says nothing",
        crossings() === once, saidR.join(" | "));

  rCalls.toggle();              // end
  blocked = ["r1"];
  rCalls.toggle();              // a third call — the once-per-call set cleared on end
  await settle();
  fireLong();
  check("a fresh call re-checks", crossings() === once + 1, saidR.join(" | "));
}

console.log(failed === 0 ? "\ncalls: all passed" : `\ncalls: ${failed} FAILED`);
process.exit(failed ? 1 : 0);
