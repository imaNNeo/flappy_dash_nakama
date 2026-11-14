// Golden trajectories of the shared dash simulation.
//
//   node golden.mjs > physics_golden.json   # regenerate (after a deliberate change)
//   node golden.mjs --check                 # verify the server code against the file
//
// The client (flappy_dash, test/netcode/dash_physics_parity_test.dart) checks
// its Dart port against the same file, bit for bit. If both pass, client-side
// prediction lands exactly where the server does.
import fs from "node:fs";
import path from "node:path";
import vm from "node:vm";
import { fileURLToPath } from "node:url";

const here = path.dirname(fileURLToPath(import.meta.url));
const build = path.join(here, "../../data/modules/functions/build/index.js");
vm.runInThisContext(fs.readFileSync(build, "utf8") + "\n;globalThis.__physics = { newDashSim, stepDash, pipeGapCenterY };");
const { newDashSim, stepDash, pipeGapCenterY } = globalThis.__physics;

// A tiny deterministic PRNG, only used to make up the scenarios.
function rng(seed) {
  return () => {
    seed = (seed + 0x6d2b79f5) | 0;
    let t = Math.imul(seed ^ (seed >>> 15), 1 | seed);
    t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t;
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

function scenario(name, seed, pipesCount, spawnPipe, ticks, skill) {
  const random = rng(seed);
  const pipesPositions = [...Array(pipesCount)].map(() => Math.round((random() * 2 - 1) * 10000) / 10000);
  const spawnX = spawnPipe * 420;
  const spawnY = spawnPipe === 0 ? 0 : pipesPositions[spawnPipe - 1] * 300;
  const sim = newDashSim(spawnX, spawnY, 3);
  const jumps = [];
  const checkpoints = [];
  const events = [];
  for (let t = 1; t <= ticks && sim.alive; t++) {
    // A bot that aims at the next gap, and sometimes misses on purpose.
    const next = Math.floor((sim.x - 60) / 420) + 1;
    const target = pipeGapCenterY(pipesPositions, next) + 25;
    const jump = sim.vy > 150 && sim.y > target && random() < skill;
    if (jump) jumps.push(t);
    const r = stepDash(sim, jump, pipesPositions);
    if (r !== 0) events.push([t, r]);
    if (t % 20 === 0 || !sim.alive) {
      checkpoints.push([t, sim.x, sim.y, sim.vy, sim.alive, sim.score, sim.lastScoredPipe]);
    }
  }
  return { name, pipesPositions, spawnX, spawnY, score: 3, ticks, jumps, events, checkpoints };
}

const scenarios = [
  scenario("good player, long run", 1, 5, 0, 3600, 0.97),
  scenario("respawn in a gap", 2, 12, 7, 3600, 0.9),
  scenario("sloppy player", 3, 3, 2, 3600, 0.6),
  scenario("never jumps", 4, 8, 3, 600, 0),
  scenario("many pipes, wraps the world", 5, 42, 41, 6000, 0.99),
];

if (process.argv.includes("--check")) {
  const golden = JSON.parse(fs.readFileSync(path.join(here, "physics_golden.json"), "utf8"));
  const ok = JSON.stringify(golden) === JSON.stringify(scenarios);
  console.log(ok ? "PASS  server physics matches physics_golden.json" : "FAIL  server physics differs from physics_golden.json");
  process.exit(ok ? 0 : 1);
} else {
  process.stdout.write(JSON.stringify(scenarios, null, 1) + "\n");
}
