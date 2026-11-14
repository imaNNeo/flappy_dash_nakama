// Load benchmark: N bots play one match the way real clients do (60 ticks/s
// prediction, input commands, snapshots, pings) and we measure what the
// server sends and how much CPU it burns.
//
//   node load.mjs [bots=20] [playSeconds=30]
//
// Prints bytes/messages received and sent per bot, ping RTT under load and
// (when NAKAMA_PID is set) the CPU time the Nakama process used while the
// match was running.
import { readFileSync } from "node:fs";
import { NetBot, sleep, waitingMatch } from "./netbot.mjs";

const BOTS = Number(process.argv[2] || 20);
const PLAY_SECONDS = Number(process.argv[3] || 30);

function cpuTicks(pid) {
  if (!pid) return null;
  const f = readFileSync(`/proc/${pid}/stat`, "utf8").split(") ")[1].split(" ");
  return Number(f[11]) + Number(f[12]); // utime + stime (clock ticks)
}

async function main() {
  const pid = process.env.NAKAMA_PID;
  const bots = [...Array(BOTS)].map((_, i) => new NetBot(`load${i}`, { skill: 0.9 }));
  await Promise.all(bots.map((b) => b.connect()));
  const matchId = await waitingMatch(bots[0]);
  for (const b of bots) await b.join(matchId);
  for (const b of bots) await b.joinLobby();
  console.log(`${BOTS} bots in lobby of ${matchId}, waiting for the match to start...`);
  while (!bots.every((b) => b.started)) await sleep(200);

  bots.forEach((b) => (b.measuring = true));
  const cpuBefore = cpuTicks(pid);
  const t0 = Date.now();
  await Promise.all(bots.map((b) => b.play(PLAY_SECONDS)));
  const seconds = (Date.now() - t0) / 1000;
  const cpuAfter = cpuTicks(pid);
  await sleep(300);

  const sum = (f) => bots.reduce((s, b) => s + f(b.stats), 0);
  const bytesIn = sum((s) => s.snapshotBytes + s.otherBytes);
  const msgsIn = sum((s) => s.snapshots + s.otherMsgs);
  const rtts = bots.flatMap((b) => b.stats.rtts).sort((a, b) => a - b);
  const pct = (p) => rtts[Math.min(rtts.length - 1, Math.floor(rtts.length * p))];
  const result = {
    bots: BOTS,
    seconds: +seconds.toFixed(1),
    kbInPerBotPerSec: +(bytesIn / BOTS / seconds / 1024).toFixed(2),
    msgsInPerBotPerSec: +(msgsIn / BOTS / seconds).toFixed(1),
    snapshotsPerBotPerSec: +(sum((s) => s.snapshots) / BOTS / seconds).toFixed(1),
    avgSnapshotBytes: Math.round(sum((s) => s.snapshotBytes) / sum((s) => s.snapshots)),
    inputsPerBotPerSec: +(sum((s) => s.inputs) / BOTS / seconds).toFixed(1),
    kbOutPerBotPerSec: +(sum((s) => s.inputBytes) / BOTS / seconds / 1024).toFixed(2),
    mispredictions: sum((s) => s.mismatches),
    pingP50: pct(0.5),
    pingP95: pct(0.95),
    nakamaCpuPercent: cpuBefore == null ? null : +(((cpuAfter - cpuBefore) / 100 / seconds) * 100).toFixed(1),
  };
  console.log(JSON.stringify(result));
  bots.forEach((b) => b.close());
  process.exit(0);
}

main().catch((e) => { console.error(e); process.exit(1); });
