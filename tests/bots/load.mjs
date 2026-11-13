// Load benchmark: N bots play one match the way real clients do and we measure
// what the server sends and how much CPU it burns.
//
//   node load.mjs [bots=20] [playSeconds=30]
//
// Prints bytes/messages received per bot, the average payload size, ping RTT
// under load and (when NAKAMA_PID is set) the CPU time the Nakama process used
// while the match was running.
import { Client } from "@heroiclabs/nakama-js";
import { readFileSync } from "node:fs";

const HOST = process.env.HOST || "127.0.0.1";
const PORT = process.env.PORT || "7350";
const SSL = process.env.SSL === "true";
const SERVER_KEY = process.env.SERVER_KEY || "defaultkey";
const BOTS = Number(process.argv[2] || 20);
const PLAY_SECONDS = Number(process.argv[3] || 30);
const OP = { Started: 103, Ping: 105, Pong: 106, JoinLobby: 200, PStarted: 201, Jumped: 202, Scored: 203, Correct: 207 };
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
const enc = (o) => new TextEncoder().encode(JSON.stringify(o));

function cpuTicks(pid) {
  if (!pid) return null;
  const f = readFileSync(`/proc/${pid}/stat`, "utf8").split(") ")[1].split(" ");
  return Number(f[11]) + Number(f[12]); // utime + stime (clock ticks)
}

async function bot(i) {
  const client = new Client(SERVER_KEY, HOST, PORT, SSL);
  const session = await client.authenticateDevice(`load-bot-${i}-${process.pid}`, true, `load${i}_${process.pid}`);
  const socket = client.createSocket(SSL, false);
  const b = { socket, session, bytes: 0, msgs: 0, started: false, rtts: [], pings: {} };
  socket.onmatchdata = (m) => {
    if (!b.measuring) {
      if (m.op_code === OP.Started) b.started = true;
      return;
    }
    b.msgs++;
    b.bytes += m.data ? m.data.byteLength : 0;
    if (m.op_code === OP.Pong) {
      const pingId = JSON.parse(new TextDecoder().decode(m.data)).pingId;
      if (b.pings[pingId]) b.rtts.push(Date.now() - b.pings[pingId]);
    }
  };
  await socket.connect(session, true);
  return b;
}

async function main() {
  const pid = process.env.NAKAMA_PID;
  const bots = await Promise.all([...Array(BOTS)].map((_, i) => bot(i)));
  const res = await fetch(`${SSL ? "https" : "http"}://${HOST}:${PORT}/v2/rpc/get_waiting_match`, {
    method: "POST", headers: { Authorization: `Bearer ${bots[0].session.token}` }, body: JSON.stringify("{}"),
  });
  const matchId = (await res.json()).payload;
  for (const b of bots) await b.socket.joinMatch(matchId);
  for (const b of bots) await b.socket.sendMatchState(matchId, OP.JoinLobby, enc({}));
  console.log(`${BOTS} bots in lobby of ${matchId}, waiting for the match to start...`);
  while (!bots.every((b) => b.started)) await sleep(200);

  for (const b of bots) b.measuring = true;
  const cpuBefore = cpuTicks(pid);
  const t0 = Date.now();
  let x = 0;
  const timers = [];
  bots.forEach((b, i) => {
    const send = (op, payload) => b.socket.sendMatchState(matchId, op, payload).catch(() => {});
    send(OP.PStarted, new Uint8Array());
    const pos = () => ({ positionX: (x += 1) % 4000, positionY: Math.random() * 400 - 200, velocityY: -500, timestamp: Date.now() });
    // A real player jumps ~2.5x/s, scores every ~2.6s, corrects every 5s and pings every 1s.
    timers.push(setInterval(() => send(OP.Jumped, enc(pos())), 400 + (i % 5) * 10));
    timers.push(setInterval(() => send(OP.Scored, enc(pos())), 2600));
    timers.push(setInterval(() => send(OP.Correct, enc(pos())), 5000));
    let n = 0;
    timers.push(setInterval(() => {
      const id = `p${i}_${n++}`;
      b.pings[id] = Date.now();
      send(OP.Ping, enc({ previousPing: 0, pingId: id, sentAt: new Date().toISOString() }));
    }, 1000));
  });
  await sleep(PLAY_SECONDS * 1000);
  timers.forEach(clearInterval);
  const seconds = (Date.now() - t0) / 1000;
  const cpuAfter = cpuTicks(pid);
  await sleep(300);

  const bytes = bots.reduce((s, b) => s + b.bytes, 0);
  const msgs = bots.reduce((s, b) => s + b.msgs, 0);
  const rtts = bots.flatMap((b) => b.rtts).sort((a, b) => a - b);
  const pct = (p) => rtts[Math.min(rtts.length - 1, Math.floor(rtts.length * p))];
  const result = {
    bots: BOTS,
    seconds: +seconds.toFixed(1),
    kbPerBotPerSec: +(bytes / BOTS / seconds / 1024).toFixed(1),
    msgsPerBotPerSec: +(msgs / BOTS / seconds).toFixed(1),
    avgPayloadBytes: Math.round(bytes / msgs),
    pingP50: pct(0.5),
    pingP95: pct(0.95),
    nakamaCpuPercent: cpuBefore == null ? null : +(((cpuAfter - cpuBefore) / 100 / seconds) * 100).toFixed(1),
  };
  console.log(JSON.stringify(result));
  bots.forEach((b) => b.socket.disconnect(false));
  process.exit(0);
}

main().catch((e) => { console.error(e); process.exit(1); });
