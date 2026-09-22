// faucet-http.selftest.mjs — the faucet's HTTP face (faucet-http.mjs) against
// a stub `send`: no chain, no key, no room. Covers what a public port needs
// that the room command does not — the per-address cooldown, the per-client
// hourly cap, X-Forwarded-For as the client behind a proxy — plus the wire
// shape a wallet will code against (JSON in and out, CORS, GET and POST).
//
//   node scripts/qos-cli/faucet-http.selftest.mjs

import { createFaucetServer } from "./faucet-http.mjs";

let failed = 0;
const check = (label, cond, detail = "") => {
  if (cond) console.log(`  ok   ${label}`);
  else { failed++; console.log(`  FAIL ${label}  (${detail})`); }
};

let clock = 1_000_000;
const sent = [];
let sendResult = { ok: true, confirmed: true, message: "transfer ok", deployId: "3045deadbeef" };
const { server, admit } = createFaucetServer({
  send: async (a) => { sent.push(a); return sendResult; },
  amount: 1_000_000_000n, amountRev: 10n, fundingAddress: "1111faucet", rnode: "https://rnode.example", ipPerHour: 3, now: () => clock,
});
await new Promise((r) => server.listen(0, "127.0.0.1", r));
const base = `http://127.0.0.1:${server.address().port}`;
const call = (path, init = {}) => fetch(base + path, init).then(async (r) => ({ status: r.status, headers: r.headers, body: await r.json().catch(() => null) }));
const post = (address, headers = {}) => call("/faucet", { method: "POST", headers: { "content-type": "application/json", ...headers }, body: JSON.stringify({ address }) });
const A = "1111bn92xHbttqWHEXqD8PiykFxgeUjizzquT6JRePj2pAoHFAuiK";
const B = "11112wWGeUA5qt6MpH9CantYj2UWWt4C3LP4cx8TpQmeM79dyen6Sk";
const C = "1111bRUvDCJ2ZtDMtCYU1ScW19uTRbVd9VHUmtPunMEQzS4oSxEkY";
const D = "1111pJu4TJaJDNJDTinnftr2fcHvMfnDeTRXRzwgPfwuKmGMa5juj";

// --- shape ------------------------------------------------------------------
{
  const h = await call("/health");
  check("/health answers with the faucet's terms, including which chain", h.status === 200 && h.body.amount === 1_000_000_000 && h.body.amountRev === "10" && h.body.fundingAddress === "1111faucet" && h.body.rnode === "https://rnode.example", JSON.stringify(h.body));
  const o = await call("/faucet", { method: "OPTIONS" });
  check("OPTIONS preflight is allowed (a wallet is a web page)", o.status === 204 && o.headers.get("access-control-allow-origin") === "*");
  const nf = await call("/nope");
  check("unknown path is 404", nf.status === 404);
  const bad = await post("not-an-address");
  check("a malformed address is 400, and nothing is sent", bad.status === 400 && sent.length === 0, JSON.stringify(bad.body));
}

// --- a grant, then the address cooldown ------------------------------------
{
  const r = await post(A);
  check("POST /faucet grants", r.status === 200 && r.body.ok && r.body.address === A && sent.length === 1, JSON.stringify(r.body));
  check("…in rnode's own shape: deployId, amount in dust, to", r.body.deployId === "3045deadbeef" && r.body.amount === 1_000_000_000 && r.body.to === A, JSON.stringify(r.body));
  const viaApi = await call("/api/faucet", { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify({ address: B }) });
  check("POST /api/faucet — rnode's path — is the same endpoint", viaApi.status === 200 && viaApi.body.to === B && sent.length === 2, JSON.stringify(viaApi.body));
  const again = await post(A);
  check("the same address again is 429 with a retryAfterMs", again.status === 429 && again.body.retryAfterMs > 0 && sent.length === 2, JSON.stringify(again.body));
  clock += 24 * 3_600_000 + 1;
  const later = await post(A);
  check("…and grants again once the day has passed", later.status === 200 && sent.length === 3);
}

// --- the per-client hourly cap, and what a client is ------------------------
{
  // Two grants from this client so far (A twice); the cap is 3 per hour, but
  // the first was over a day ago — only the second is inside the hour.
  // Inside this hour so far: A's second grant (its first was a day ago) and
  // B (granted through /api/faucet above, before the clock moved — a day ago
  // too). So this hour holds one grant; the cap is 3.
  const r1 = await post(C); check("second distinct address inside the hour: granted", r1.status === 200, JSON.stringify(r1.body));
  const r2 = await post(D); check("third: granted (that's the cap)", r2.status === 200, JSON.stringify(r2.body));
  const r3 = await post(D.replace(/.$/, "m")); check("fourth distinct address from the same client is 429", r3.status === 429 && /client/.test(r3.body.error), JSON.stringify(r3.body));
  const proxied = await post(D.replace(/.$/, "m"), { "x-forwarded-for": "203.0.113.9, 10.0.0.1" });
  check("a different X-Forwarded-For hop is a different client — granted", proxied.status === 200, JSON.stringify(proxied.body));
  clock += 3_600_000 + 1;
  const fresh = await post(D.replace(/.$/, "k") /* yet another address */);
  check("the hour passing frees the cap", fresh.status === 200, `status ${fresh.status}`);
}

// --- GET form, and a chain that fails --------------------------------------
{
  const V = "11112ZZXokd6fYeGWiE9gXqxwp9gJxDuXBncJFS8m6SfDKCiuenoeM";
  const g = await call(`/faucet?address=${V}`);
  check("GET /faucet?address= is accepted", g.status === 200 && g.body.address === V, JSON.stringify(g.body));
  sendResult = { ok: false, message: "preCharge: insufficient funds" };
  const before = sent.length;
  const F = "11112t3hUy9ncNy4YyA9wypBq1AznJrs2zVeX4zxQuuqAdcAidsk7L";
  const f = await post(F);
  check("a failed deploy is 502 with the node's reason", f.status === 502 && /insufficient/.test(f.body.detail), JSON.stringify(f.body));
  check("…and the address's grant is spent anyway (no retry hammering)", admit(F, "x") !== null && sent.length === before + 1);
}

server.close();
console.log(failed === 0 ? "\nfaucet-http: all passed" : `\nfaucet-http: ${failed} FAILED`);
process.exit(failed ? 1 : 0);
