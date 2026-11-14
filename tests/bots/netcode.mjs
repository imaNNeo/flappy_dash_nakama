// Plays a whole match with bots that use the server-authoritative protocol and
// checks that client-side prediction agrees with the server, with and without
// network latency.
//
//   node netcode.mjs [bots=4] [playSeconds=40]
//
// Half of the bots get 60-90ms one-way latency (with jitter).
import { NetBot, OP, sleep, waitingMatch } from "./netbot.mjs";

const BOTS = Number(process.argv[2] || 4);
const PLAY_SECONDS = Number(process.argv[3] || 40);

const bots = [...Array(BOTS)].map((_, i) => new NetBot(`nc${i}`, ({ latencyMs: i % 2 ? 60 : 0, jitterMs: i % 2 ? 30 : 0, skill: [0.97, 0.9, 0.6][i % 3] })));
await Promise.all(bots.map((b) => b.connect()));
const matchId = await waitingMatch(bots[0]);
for (const b of bots) await b.join(matchId);
for (const b of bots) await b.joinLobby();
console.log(`${BOTS} bots in lobby of ${matchId}, waiting for the match to start...`);
while (!bots.every((b) => b.started)) await sleep(200);
bots.forEach((b) => (b.measuring = true));
await Promise.all(bots.map((b) => b.play(PLAY_SECONDS)));
await sleep(500);

let ok = true;
for (const b of bots) {
  const s = b.stats;
  const serverScore = b.state.players[b.userId].score;
  const line = { bot: b.name, latency: b.latencyMs, compared: s.compared, mismatches: s.mismatches, maxError: +s.maxError.toFixed(4),
    deathsLocal: s.deathsLocal, deathsServer: s.deathsServer, predictedScore: b.sim?.score, serverScore, snapshotsPerSec: +(s.snapshots / PLAY_SECONDS).toFixed(1) };
  console.log(JSON.stringify(line));
  if (s.compared < 100 || s.mismatches > 0) ok = false;
}
console.log(ok ? "PASS  prediction matched the server for every bot" : "FAIL  see above");
bots.forEach((b) => b.close());
process.exit(ok ? 0 : 1);
