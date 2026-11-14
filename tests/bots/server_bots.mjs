// Checks the server-side bots (data/modules/functions/src/bots.ts).
//
//   node server_bots.mjs admin-id   prints the user id of the "admin" test device
//   node server_bots.mjs dev        server with IS_PRODUCTION=false: anyone adds bots,
//                                   bots play a real match next to a NetBot player
//   node server_bots.mjs prod       server with IS_PRODUCTION=true and
//                                   BOT_ADMIN_USER_IDS=<admin-id>: only the admin may
import { Client } from "@heroiclabs/nakama-js";
import { NetBot, OP, HOST, PORT, SSL, SERVER_KEY, sleep, decodeSnapshot, waitingMatch } from "./netbot.mjs";

const BOT_ADD = 211;
const BOT_REMOVE = 212;
const enc = (o) => new TextEncoder().encode(JSON.stringify(o));

const results = [];
function check(name, ok, detail = "") {
  results.push(ok);
  console.log(`${ok ? "PASS" : "FAIL"}  ${name}${detail ? "  (" + detail + ")" : ""}`);
}

async function canManageBots(bot) {
  const res = await bot.client.rpc(bot.session, "can_manage_bots", {});
  return res.payload.canManageBots;
}

const botsIn = (state) => Object.values(state?.players || {}).filter((p) => p.isBot);

async function player(name, deviceId) {
  const p = new NetBot(name);
  if (deviceId) {
    // A fixed device, so the admin keeps its user id across runs.
    p.client = new Client(SERVER_KEY, HOST, PORT, SSL);
    p.session = await p.client.authenticateDevice(deviceId, true);
    p.userId = p.session.user_id;
    p.socket = p.client.createSocket(SSL, false);
    p.socket.onmatchdata = (m) => p._onData(m);
    p.socket.ondisconnect = () => {};
    await p.socket.connect(p.session, true);
  } else {
    await p.connect();
  }
  return p;
}

async function dev() {
  const human = await player("human");
  check("can_manage_bots is true on a dev server", (await canManageBots(human)) === true);
  const matchId = await waitingMatch(human);
  await human.join(matchId);
  await human.joinLobby();
  await sleep(300);
  for (let i = 0; i < 3; i++) await human.socket.sendMatchState(matchId, BOT_ADD, enc({}));
  await sleep(300);
  check("three bots joined the lobby", botsIn(human.state).length === 3 && botsIn(human.state).every((b) => b.isInLobby),
    botsIn(human.state).map((b) => b.displayName).join(", "));
  await human.socket.sendMatchState(matchId, BOT_REMOVE, enc({}));
  await sleep(300);
  check("removing a bot leaves two", botsIn(human.state).length === 2);
  const botIds = botsIn(human.state).map((b) => b.userId);

  // A second person sees the bots too.
  const watcher = await player("watcher");
  await watcher.join(matchId);
  await sleep(300);
  check("a newcomer sees the bots in the welcome state", botsIn(watcher.state).length === 2);
  watcher.close();

  console.log("waiting for the match to start (up to the lobby timer)...");
  const t0 = Date.now();
  while (!human.started && Date.now() - t0 < 60000) await sleep(100);
  check("one person + bots start a match", human.started, `after ${((Date.now() - t0) / 1000).toFixed(1)}s`);
  if (!human.started) return;
  check("bots are on the roster", botIds.every((id) => human.roster.includes(id)), `roster=${human.roster.length}`);

  // Watch the bots' snapshot entries while our own NetBot plays.
  const botIndexes = new Set(botIds.map((id) => human.roster.indexOf(id)));
  const seen = { playing: 0, died: 0, maxScore: 0, seqBackwards: 0 };
  const lastSeq = {};
  const original = human._onSnapshot.bind(human);
  human._onSnapshot = (s) => {
    for (const e of s.entries) {
      if (!botIndexes.has(e.rosterIndex)) continue;
      if (e.state === 1) seen.playing++;
      if (e.state === 2) seen.died++;
      seen.maxScore = Math.max(seen.maxScore, e.score);
      if (lastSeq[e.rosterIndex] !== undefined && e.seq < lastSeq[e.rosterIndex]) seen.seqBackwards++;
      lastSeq[e.rosterIndex] = e.seq;
    }
    original(s);
  };
  await human.play(45);
  const botEvents = human.events.filter((e) => botIds.includes(e.sender));
  check("bots fly (playing entries in snapshots)", seen.playing > 50, `entries=${seen.playing}`);
  check("bots score", seen.maxScore > 0, `best bot score=${seen.maxScore}`);
  check("bot seq never goes backwards", seen.seqBackwards === 0);
  check("bot events carry the bot as sender (PlayerStarted)", botEvents.some((e) => e.op === OP.PStarted));
  const diedOrNot = botEvents.some((e) => e.op === OP.WillSpawn) || seen.died === 0;
  check("a dying bot sends PlayerWillSpawnAt as itself", diedOrNot, `deaths seen=${seen.died}`);
  check("our own prediction still matches the server", human.stats.mismatches === 0, `mismatches=${human.stats.mismatches}`);
  human.close();

  // When the last person leaves a waiting lobby, its bots leave as well.
  const a = await player("leaver");
  const m2 = await waitingMatch(a);
  await a.join(m2);
  await a.joinLobby();
  await a.socket.sendMatchState(m2, BOT_ADD, enc({}));
  await sleep(300);
  await a.socket.leaveMatch(m2);
  await sleep(300);
  const b = await player("next");
  await b.join(m2);
  await sleep(300);
  check("bots leave with the last person in the lobby", botsIn(b.state).length === 0);
  check("a lobby with only bots doesn't start", b.state.currentPhase === 0);
  a.close(); b.close();
}

async function prod() {
  const admin = await player("admin", "flappy-dash-bot-admin-test-device");
  const other = await player("other");
  check("can_manage_bots is true for the admin", (await canManageBots(admin)) === true);
  check("can_manage_bots is false for others", (await canManageBots(other)) === false);
  const matchId = await waitingMatch(admin);
  await admin.join(matchId);
  await other.join(matchId);
  await other.joinLobby();
  await sleep(300);
  await other.socket.sendMatchState(matchId, BOT_ADD, enc({}));
  await sleep(400);
  check("others can't add bots in production", botsIn(other.state).length === 0);
  await admin.socket.sendMatchState(matchId, BOT_ADD, enc({}));
  await sleep(400);
  check("the admin can add a bot in production", botsIn(other.state).length === 1);
  await other.socket.sendMatchState(matchId, BOT_REMOVE, enc({}));
  await sleep(400);
  check("others can't remove bots in production", botsIn(other.state).length === 1);
  await admin.socket.sendMatchState(matchId, BOT_REMOVE, enc({}));
  await sleep(400);
  check("the admin can remove a bot", botsIn(other.state).length === 0);
  admin.close(); other.close();
}

const mode = process.argv[2] || "dev";
if (mode === "admin-id") {
  const c = new Client(SERVER_KEY, HOST, PORT, SSL);
  console.log((await c.authenticateDevice("flappy-dash-bot-admin-test-device", true)).user_id);
  process.exit(0);
}
await (mode === "prod" ? prod() : dev());
const failed = results.filter((ok) => !ok).length;
console.log(failed ? `${failed} FAILED` : "all passed");
process.exit(failed ? 1 : 0);
