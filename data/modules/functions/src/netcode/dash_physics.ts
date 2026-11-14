// Shared, deterministic dash simulation.
//
// This file has a twin on the client: lib/domain/netcode/dash_physics.dart in
// the flappy_dash repo. Both must stay in sync, operation for operation, so
// that the client can predict its own dash and land on exactly the same
// numbers the server computes (doubles are IEEE 754 on both sides, so the same
// operations in the same order give the same bits).
//
// Every dash only interacts with the pipes (never with another dash) and the
// pipes are fixed for the whole match, so a dash's whole life is a pure
// function of its spawn point and the ticks at which its player jumped.

const physicsTickRate = 60;
const physicsDt = 1 / physicsTickRate;

const physicsGravity = 1400.0;
const physicsJumpVelocity = -500.0;
const physicsDashSpeed = 160.0;

const physicsPipesDistance = 420.0;
const physicsPipeWidth = 82.0;
const physicsPipeHoleGap = 240.0;
const physicsPipesPositionArea = 300.0;
// pipe.png is 247x2266, drawn 82 wide.
const physicsPipeHeight = physicsPipeWidth * 2266 / 247;

// The dash is 80x80, anchored at its center. Its hitbox is a circle of radius
// 30 whose center sits 4px right of and below the dash's position.
const physicsDashHitboxRadius = 30.0;
const physicsDashHitboxOffset = 4.0;

// The hidden coin of a pipe pair (you score when you touch it).
const physicsCoinOffsetX = 30.0;
const physicsCoinWidth = 40.0;
const physicsCoinHeight = physicsPipeHoleGap * 0.9;

// The visible world is 1000 high (fixed resolution camera); leaving it kills.
const physicsOutOfBoundsY = 520.0;

// Precomputed so both sides do the exact same floating point operations.
const physicsHalfGravityDtSquared = 0.5 * physicsGravity * physicsDt * physicsDt;
const physicsGravityDt = physicsGravity * physicsDt;
const physicsDashStep = physicsDashSpeed * physicsDt;

interface DashSim {
    // Distance travelled since the spawn point, NOT wrapped around the world.
    x: number;
    y: number;
    vy: number;
    alive: boolean;
    score: number;
    // Pipes with an index below this are ignored (the pipe the dash spawns on).
    firstPipe: number;
    // The highest pipe index whose coin was collected.
    lastScoredPipe: number;
}

const enum DashStepResult {
    None = 0,
    Scored = 1,
    Died = 2,
}

// Pipe k stands at x = k * pipesDistance (in unwrapped coordinates), its gap
// center comes from the match's pipesPositions, repeating every
// pipesPositions.length pipes (the world loops).
function pipeGapCenterY(pipesPositions: number[], pipeIndex: number): number {
    const n = pipesPositions.length;
    const i = (((pipeIndex - 1) % n) + n) % n;
    return pipesPositions[i] * physicsPipesPositionArea;
}

function newDashSim(spawnX: number, spawnY: number, score: number): DashSim {
    const spawnPipe = Math.floor(spawnX / physicsPipesDistance + 0.5);
    return {
        x: spawnX,
        y: spawnY,
        vy: 0,
        alive: true,
        score,
        firstPipe: spawnPipe + 1,
        lastScoredPipe: spawnPipe,
    };
}

function circleIntersectsRect(cx: number, cy: number, r: number, left: number, top: number, right: number, bottom: number): boolean {
    const nearestX = cx < left ? left : (cx > right ? right : cx);
    const nearestY = cy < top ? top : (cy > bottom ? bottom : cy);
    const dx = cx - nearestX;
    const dy = cy - nearestY;
    return dx * dx + dy * dy < r * r;
}

// Advances the dash by one tick. `jump` is whether the player jumped in this tick.
function stepDash(sim: DashSim, jump: boolean, pipesPositions: number[]): DashStepResult {
    if (!sim.alive) {
        return DashStepResult.None;
    }
    if (jump) {
        sim.vy = physicsJumpVelocity;
    }
    // Exact for constant gravity, so the arc doesn't depend on the tick rate.
    sim.y = sim.y + sim.vy * physicsDt + physicsHalfGravityDtSquared;
    sim.vy = sim.vy + physicsGravityDt;
    sim.x = sim.x + physicsDashStep;

    if (sim.y > physicsOutOfBoundsY || sim.y < -physicsOutOfBoundsY) {
        sim.alive = false;
        return DashStepResult.Died;
    }

    const cx = sim.x + physicsDashHitboxOffset;
    const cy = sim.y + physicsDashHitboxOffset;
    const r = physicsDashHitboxRadius;
    // Pipes are 420 apart and the hitbox only reaches 80px around a pipe's
    // center line, so only the nearest pipe can touch the dash.
    const k = Math.floor(cx / physicsPipesDistance + 0.5);
    if (k < sim.firstPipe) {
        return DashStepResult.None;
    }
    const px = k * physicsPipesDistance;
    const gapY = pipeGapCenterY(pipesPositions, k);
    const halfPipe = physicsPipeWidth / 2;
    const halfGap = physicsPipeHoleGap / 2;
    const hitsBottomPipe = circleIntersectsRect(cx, cy, r, px - halfPipe, gapY + halfGap, px + halfPipe, gapY + halfGap + physicsPipeHeight);
    const hitsTopPipe = circleIntersectsRect(cx, cy, r, px - halfPipe, gapY - halfGap - physicsPipeHeight, px + halfPipe, gapY - halfGap);
    if (hitsBottomPipe || hitsTopPipe) {
        sim.alive = false;
        return DashStepResult.Died;
    }
    if (k > sim.lastScoredPipe) {
        const coinLeft = px + physicsCoinOffsetX - physicsCoinWidth / 2;
        const coinTop = gapY - physicsCoinHeight / 2;
        if (circleIntersectsRect(cx, cy, r, coinLeft, coinTop, coinLeft + physicsCoinWidth, coinTop + physicsCoinHeight)) {
            sim.lastScoredPipe = k;
            sim.score = sim.score + 1;
            return DashStepResult.Scored;
        }
    }
    return DashStepResult.None;
}
