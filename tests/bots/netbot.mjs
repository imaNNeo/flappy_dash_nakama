// A headless player that speaks the server-authoritative protocol the way the
// Flutter client does: it simulates its dash locally at 60 ticks/s with the
// server's own physics code (predicting), sends input commands (jumps right
// away, a heartbeat every 3 ticks) and reads the snapshots. Optional
// simulated network latency in both directions.
//
// It also checks the netcode: whenever a snapshot tells us the server's state
// of our dash at tick N, we compare it with what we predicted for tick N.
import { Client } from "@heroiclabs/nakama-js";
import fs from "node:fs";
import path from "node:path";
import vm from "node:vm";
import { fileURLToPath } from "node:url";

const here = path.dirname(fileURLToPath(import.meta.url));
vm.runInThisContext(
  fs.readFileSync(path.join(here, "../../data/modules/functions/build/index.js"), "utf8") +
    "\n;globalThis.__physics = { newDashSim, stepDash, pipeGapCenterY };",
);
export const { newDashSim, stepDash, pipeGapCenterY } = globalThis.__physics;

export const HOST = process.env.HOST || "127.0.0.1";
export const PORT = process.env.PORT || "7350";
export const SSL = process.env.SSL === "true";
export const SERVER_KEY = process.env.SERVER_KEY || "defaultkey";
export const OP = {
  Welcome: 100, WaitingIncreased: 101, Presences: 102, Started: 103, Finished: 104, Ping: 105, Pong: 106, Snapshot: 110,
  JoinLobby: 200, PStarted: 201, Scored: 203, Died: 204, Idle: 205, Kicked: 206, WillSpawn: 209, Input: 210,
};
export const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
const enc = (o) => new TextEncoder().encode(JSON.stringify(o));
const dec = (d) => JSON.parse(new TextDecoder().decode(d));
const TICK_MS = 1000 / 60;

export function encodeInput(lifeStartSeq, upToSeq, jumps) {
  const buf = new ArrayBuffer(10 + jumps.length * 4);
  const v = new DataView(buf);
  v.setUint8(0, 1);
  v.setUint32(1, lifeStartSeq, true);
  v.setUint32(5, upToSeq, true);
  v.setUint8(9, jumps.length);
  jumps.forEach((j, i) => v.setUint32(10 + i * 4, j, true));
  return new Uint8Array(buf);
}

export function decodeSnapshot(data) {
  const v = new DataView(data.buffer, data.byteOffset, data.byteLength);
  const n = v.getUint8(5);
  const entries = [];
  for (let i = 0, o = 6; i < n; i++, o += 22) {
    entries.push({
      rosterIndex: v.getUint8(o), state: v.getUint8(o + 1), score: v.getUint16(o + 2, true), seq: v.getUint32(o + 4, true),
      x: v.getFloat32(o + 8, true), y: v.getFloat32(o + 12, true), vy: v.getFloat32(o + 16, true), lastScoredPipe: v.getUint16(o + 20, true),
    });
  }
  return { full: v.getUint8(0) === 1, serverTime: v.getUint32(1, true), entries };
}

export class NetBot {
  constructor(name, { latencyMs = 0, jitterMs = 0, skill = 0.97, autoplay = true } = {}) {
    this.name = name;
    this.latencyMs = latencyMs;
    this.jitterMs = jitterMs;
    this.skill = skill;
    this.autoplay = autoplay;
    this.events = [];
    this.stats = { snapshots: 0, snapshotBytes: 0, otherBytes: 0, otherMsgs: 0, inputs: 0, inputBytes: 0, compared: 0, mismatches: 0, maxError: 0, deathsLocal: 0, deathsServer: 0, rtts: [] };
    this.seq = 1000 + Math.floor(Math.random() * 1000);
    this.sim = null;
    this.history = new Map();
    this.unackedJumps = [];
    this.lifeStart = -1;
    this.lastSentUpTo = -1;
    this.jumpedSinceSend = false;
    this.started = false;
    this.finished = false;
    this.measuring = false;
    this._lastDelivery = 0;
  }

  // Delivers in order (like TCP), after the simulated latency.
  _delay(fn) {
    if (!this.latencyMs && !this.jitterMs) return fn();
    const at = Math.max(Date.now() + this.latencyMs + Math.random() * this.jitterMs, this._lastDelivery);
    this._lastDelivery = at;
    setTimeout(fn, at - Date.now());
  }

  async connect() {
    this.client = new Client(SERVER_KEY, HOST, PORT, SSL);
    this.session = await this.client.authenticateDevice(`netbot-${this.name}-${process.pid}`, true, `${this.name}_${process.pid}`);
    this.userId = this.session.user_id;
    this.socket = this.client.createSocket(SSL, false);
    this.socket.onmatchdata = (m) => this._delay(() => this._onData(m));
    this.socket.ondisconnect = () => {};
    await this.socket.connect(this.session, true);
  }

  async join(matchId) {
    this.matchId = matchId;
    await this.socket.joinMatch(matchId);
  }

  joinLobby() { return this.socket.sendMatchState(this.matchId, OP.JoinLobby, enc({})); }

  _send(op, payload) {
    this._delay(() => this.socket.sendMatchState(this.matchId, op, payload).catch(() => {}));
  }

  _onData(m) {
    const op = m.op_code;
    if (op === OP.Snapshot) {
      if (this.measuring) { this.stats.snapshots++; this.stats.snapshotBytes += m.data.byteLength; }
      this._onSnapshot(decodeSnapshot(m.data));
      return;
    }
    if (this.measuring) { this.stats.otherMsgs++; this.stats.otherBytes += m.data ? m.data.byteLength : 0; }
    if (op === OP.Pong) {
      const p = dec(m.data);
      if (this.pings && this.pings[p.pingId]) this.stats.rtts.push(Date.now() - this.pings[p.pingId]);
      return;
    }
    const data = m.data && m.data.byteLength ? dec(m.data) : null;
    this.events.push({ op, data, at: Date.now(), sender: m.presence?.user_id });
    if (data && data.players) this.state = data;
    if (op === OP.Started) {
      this.started = true;
      this.roster = data.roster;
      this.pipes = data.pipesPositions;
      this.myIndex = data.roster.indexOf(this.userId);
      this.spawn = { x: data.players[this.userId].lastKnownX, y: data.players[this.userId].lastKnownY, at: 0 };
    }
    if (op === OP.WillSpawn && m.presence?.user_id === this.userId) {
      const me = data.players[this.userId];
      this.spawn = { x: me.lastKnownX, y: me.lastKnownY, at: me.spawnsAgainAt };
    }
    if (op === OP.Finished) this.finished = true;
  }

  _onSnapshot(s) {
    if (this.stopped) return;
    for (const e of s.entries) {
      if (e.rosterIndex !== this.myIndex || this.lifeStart < 0) continue;
      if (e.state === 2 && e.seq >= this.lifeStart) {
        if (!this.serverDeath) { this.serverDeath = true; this.stats.deathsServer++; }
        if (this.sim && this.sim.alive) {
          // The server says we died and we didn't see it: a misprediction.
          this.stats.mismatches++;
          this.sim.alive = false;
        }
      }
      if (e.state !== 1 || e.seq < this.lifeStart) continue;
      this.unackedJumps = this.unackedJumps.filter((j) => j > e.seq);
      const predicted = this.history.get(e.seq);
      if (!predicted) continue;
      this.stats.compared++;
      const err = Math.max(Math.abs(predicted.x - e.x), Math.abs(predicted.y - e.y), Math.abs(predicted.vy - e.vy));
      this.stats.maxError = Math.max(this.stats.maxError, err);
      if (err > 0.05 || predicted.score !== e.score) this.stats.mismatches++;
    }
  }

  _startLife() {
    // The next respawn time comes with the next PlayerWillSpawnAt.
    this.spawn = { ...this.spawn, at: Infinity };
    this.lifeStart = this.seq + 1;
    this.sim = newDashSim(this.spawn.x, this.spawn.y, this.state.players[this.userId].score);
    this.unackedJumps = [];
    this.lastSentUpTo = this.lifeStart - 1;
    this.serverDeath = false;
    this.diedAt = -1;
    this.history.clear();
  }

  _pilot() {
    const s = this.sim;
    const next = Math.floor((s.x - 60) / 420) + 1;
    const target = pipeGapCenterY(this.pipes, next) + 25;
    // `skill` is the chance to even try at each pipe; a bot that gives up
    // stops jumping and dies.
    if (next !== this.pilotPipe) {
      this.pilotPipe = next;
      this.givesUp = Math.random() > this.skill;
    }
    return !this.givesUp && s.vy > 150 && s.y > target;
  }

  _tick() {
    if (!this.sim) return;
    this.seq++;
    if (this.sim.alive) {
      const jump = this.autoplay && this._pilot();
      if (jump) { this.unackedJumps.push(this.seq); this.jumpedSinceSend = true; }
      const r = stepDash(this.sim, jump, this.pipes);
      this.history.set(this.seq, { x: this.sim.x, y: this.sim.y, vy: this.sim.vy, score: this.sim.score });
      if (this.history.size > 600) this.history.delete(this.history.keys().next().value);
      if (r === 2) { this.diedAt = this.seq; this.stats.deathsLocal++; }
    }
    const afterDeath = this.diedAt >= 0 && this.seq - this.diedAt > 120;
    if (this.serverDeath || afterDeath) return;
    if (this.jumpedSinceSend || this.seq - this.lastSentUpTo >= 3) {
      this.lastSentUpTo = this.seq;
      this.jumpedSinceSend = false;
      const packet = encodeInput(this.lifeStart, this.seq, this.unackedJumps);
      if (this.measuring) { this.stats.inputs++; this.stats.inputBytes += packet.byteLength; }
      this._send(OP.Input, packet);
    }
  }

  // Plays until the match finishes (or `seconds` pass).
  async play(seconds = Infinity) {
    const t0 = Date.now();
    let ticksDone = 0;
    let pingN = 0;
    this.pings = {};
    let nextPing = Date.now();
    while (!this.finished && Date.now() - t0 < seconds * 1000) {
      const due = Math.floor((Date.now() - t0) / TICK_MS);
      // A dead dash respawns once the server's respawn time passed.
      const canStart = !this.sim || (!this.sim.alive && this.spawn.at && Date.now() >= this.spawn.at);
      if (canStart && this.spawn && this.state && Date.now() < this.state.matchFinishesAt - 500) {
        this._startLife();
      }
      while (ticksDone < due) { this._tick(); ticksDone++; }
      if (Date.now() >= nextPing) {
        const id = `${this.name}_${pingN++}`;
        this.pings[id] = Date.now();
        const prev = this.stats.rtts.length ? this.stats.rtts[this.stats.rtts.length - 1] : 0;
        this._send(OP.Ping, enc({ previousPing: prev, pingId: id }));
        nextPing += 1000;
      }
      await sleep(4);
    }
    // We stop sending inputs now, so the server will let our dash fall.
    this.stopped = true;
  }

  close() { try { this.socket.disconnect(false); } catch (e) {} }
}

export async function waitingMatch(bot) {
  const res = await fetch(`${SSL ? "https" : "http"}://${HOST}:${PORT}/v2/rpc/get_waiting_match`, {
    method: "POST", headers: { Authorization: `Bearer ${bot.session.token}` }, body: JSON.stringify("{}"),
  });
  return (await res.json()).payload;
}
