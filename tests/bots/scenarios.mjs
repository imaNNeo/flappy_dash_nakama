// Headless bots that exercise the Flappy Dash Nakama match handler.
import { Client } from "@heroiclabs/nakama-js";

const HOST = process.env.HOST || "127.0.0.1";
const PORT = process.env.PORT || "7350";
const SSL = process.env.SSL === "true";
const SERVER_KEY = process.env.SERVER_KEY || "defaultkey";
const OP = { Welcome: 100, Presences: 102, Started: 103, Finished: 104, Ping: 105, Pong: 106, JoinLobby: 200, PStarted: 201, Jumped: 202, Kicked: 206 };
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
const enc = (o) => new TextEncoder().encode(JSON.stringify(o));
const dec = (d) => JSON.parse(new TextDecoder().decode(d));

async function bot(name) {
  const client = new Client(SERVER_KEY, HOST, PORT, SSL);
  const session = await client.authenticateDevice(`bot-device-${name}-${process.pid}`, true, `${name}_${process.pid}`);
  const b = { name, client, session, events: [], sockets: [] };
  b.connect = async () => {
    const socket = client.createSocket(SSL, false);
    socket.onmatchdata = (m) => b.events.push({ op: m.op_code, data: m.data ? dec(m.data) : null, at: Date.now(), socket });
    socket.ondisconnect = () => {};
    await socket.connect(session, true);
    b.sockets.push(socket);
    return socket;
  };
  b.waitingMatch = async () => (await client.rpc(session, "get_waiting_match", {})).payload;
  b.count = (op) => b.events.filter((e) => e.op === op).length;
  return b;
}

const results = [];
function check(name, ok, detail = "") {
  results.push({ name, ok });
  console.log(`${ok ? "PASS" : "FAIL"}  ${name}${detail ? "  (" + detail + ")" : ""}`);
}

async function rawRpc(b) {
  // get_waiting_match returns the id as a raw string payload
  const res = await fetch(`${SSL ? "https" : "http"}://${HOST}:${PORT}/v2/rpc/get_waiting_match`, {
    method: "POST", headers: { Authorization: `Bearer ${b.session.token}` }, body: JSON.stringify("{}"),
  });
  const j = await res.json();
  return j.payload;
}

async function main() {
  const which = process.argv[2] || "all";

  if (which === "all" || which === "concurrency") {
    const bots = await Promise.all([...Array(12)].map((_, i) => bot(`c${i}`)));
    const ids = await Promise.all(bots.map((b) => rawRpc(b)));
    check("12 parallel get_waiting_match calls return one match", new Set(ids).size === 1, [...new Set(ids)].join(","));
  }

  if (which === "all" || which === "ping-after-leave") {
    const [a, b2] = await Promise.all([bot("pa"), bot("pb")]);
    const sa = await a.connect(); const sb = await b2.connect();
    const matchId = await rawRpc(a);
    await sa.joinMatch(matchId); await sb.joinMatch(matchId);
    await sa.sendMatchState(matchId, OP.JoinLobby, enc({}));
    // b sends a burst of pings and leaves in the same instant
    for (let i = 0; i < 5; i++) sb.sendMatchState(matchId, OP.Ping, enc({ previousPing: 10, pingId: "x" + i }));
    await sb.leaveMatch(matchId);
    for (let i = 0; i < 5; i++) sb.sendMatchState(matchId, OP.Ping, enc({ previousPing: 10, pingId: "y" + i })).catch(() => {});
    await sleep(500);
    const before = a.count(OP.Pong);
    await sa.sendMatchState(matchId, OP.Ping, enc({ previousPing: 1, pingId: "after" }));
    await sleep(500);
    const alive = (await rawRpc(a)) === matchId;
    check("match survives pings from a player who just left", a.count(OP.Pong) > before && alive, `pongs=${a.count(OP.Pong)} sameMatch=${alive}`);
    // malformed payload must not kill the match
    await sa.sendMatchState(matchId, OP.Ping, new Uint8Array([0xff, 0x00, 0x7b]));
    await sleep(300);
    await sa.sendMatchState(matchId, OP.Ping, enc({ previousPing: 1, pingId: "after2" }));
    await sleep(500);
    check("match survives a malformed message", a.events.some((e) => e.op === OP.Pong && e.data.pingId === "after2"));
    await sa.leaveMatch(matchId);
    a.sockets.forEach((s) => s.disconnect(false)); b2.sockets.forEach((s) => s.disconnect(false));
  }

  if (which === "all" || which === "reconnect") {
    // Player reconnects with a new socket before the old one's leave is processed,
    // then the old one drops. The player must still be part of the lobby and get MatchStarted.
    const [a, b2] = await Promise.all([bot("ra"), bot("rb")]);
    const matchId = await rawRpc(a);
    const s1 = await a.connect();
    await s1.joinMatch(matchId);
    await s1.sendMatchState(matchId, OP.JoinLobby, enc({}));
    const s2 = await a.connect();
    await s2.joinMatch(matchId);
    await sleep(200);
    s1.disconnect(false);
    const sb = await b2.connect();
    await sb.joinMatch(matchId);
    await sb.sendMatchState(matchId, OP.JoinLobby, enc({}));
    await s2.sendMatchState(matchId, OP.JoinLobby, enc({}));
    console.log("   waiting up to 45s for the match to start...");
    const t0 = Date.now();
    while (Date.now() - t0 < 45000 && !(a.count(OP.Started) && b2.count(OP.Started))) await sleep(500);
    check("reconnected player still receives MatchStarted", a.events.some((e) => e.op === OP.Started && e.socket === s2), `a=${a.count(OP.Started)} b=${b2.count(OP.Started)}`);

    // during the running phase: jumps are relayed, and the next waiting match is different
    await s2.sendMatchState(matchId, OP.PStarted, enc({}));
    await s2.sendMatchState(matchId, OP.Jumped, enc({ positionX: 10.5, positionY: -3.25, velocityY: -300, timestamp: Date.now() }));
    await sleep(500);
    const jump = b2.events.find((e) => e.op === OP.Jumped);
    check("jump is relayed to the other player", !!jump && jump.data.players[a.session.user_id].lastKnownX === 10.5);
    const next = await rawRpc(a);
    check("a new waiting match is handed out once a match starts", next && next !== matchId);
    // a fresh player trying to join the running match is rejected
    const c = await bot("rc"); const sc = await c.connect();
    let rejected = false; try { await sc.joinMatch(matchId); } catch (e) { rejected = true; }
    check("new players can't join a running match", rejected);
    // the reconnecting player can rejoin a running match and keeps their score
    await s2.sendMatchState(matchId, OP.PStarted, enc({}));
    await s2.sendMatchState(matchId, 203, enc({ positionX: 1, positionY: 1, velocityY: 1 }));
    await sleep(300);
    s2.disconnect(false);
    await sleep(300);
    const s3 = await a.connect();
    await s3.joinMatch(matchId);
    await sleep(300);
    const welcome = a.events.filter((e) => e.op === OP.Welcome && e.socket === s3).pop();
    check("player rejoining a running match keeps their score", welcome && welcome.data.players[a.session.user_id].score === 1, JSON.stringify(welcome?.data.players[a.session.user_id]?.score));
    [a, b2, c].forEach((x) => x.sockets.forEach((s) => s.disconnect(false)));
  }

  const failed = results.filter((r) => !r.ok).length;
  console.log(`\n${results.length - failed}/${results.length} passed`);
  process.exit(failed ? 1 : 0);
}

main().catch((e) => { console.error(e); process.exit(2); });
