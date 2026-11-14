// Bots: server-side players that fill a match when there aren't enough
// people online. A bot lives entirely inside the authoritative match: it has
// no socket and no presence, the match loop flies its dash with the same
// physics as everybody else, and clients see it in the snapshots like any
// other player.
//
// Who may add or remove bots:
// - on a non-production server (IS_PRODUCTION != "true", e.g. a local debug
//   server), everybody;
// - in production, only the user ids listed in the BOT_ADMIN_USER_IDS runtime
//   env (comma separated). The check runs on the server, the client only
//   uses it to decide whether to show the button.

const maxBotsPerMatch = 8;
// A bot waits a moment before starting a life, like a person tapping.
const botMinStartDelayMs = 600;
const botMaxStartDelayMs = 2200;

// Every bot is a real (custom-auth) account, so match results, the last
// winner badge and every other place that looks users up keep working.
const botProfiles: { id: string, name: string, skill: number }[] = [
    { id: "flappy_dash_bot_1", name: "Bot Pixel", skill: 0.97 },
    { id: "flappy_dash_bot_2", name: "Bot Nimbus", skill: 0.94 },
    { id: "flappy_dash_bot_3", name: "Bot Pebble", skill: 0.9 },
    { id: "flappy_dash_bot_4", name: "Bot Zippy", skill: 0.95 },
    { id: "flappy_dash_bot_5", name: "Bot Waffle", skill: 0.88 },
    { id: "flappy_dash_bot_6", name: "Bot Comet", skill: 0.96 },
    { id: "flappy_dash_bot_7", name: "Bot Noodle", skill: 0.86 },
    { id: "flappy_dash_bot_8", name: "Bot Sprout", skill: 0.92 },
];

interface BotBrain {
    // Chance to even try at each pipe; a bot that gives up stops jumping.
    skill: number;
    // When an idle bot starts its next life.
    startsAt: number;
    pilotPipe: number;
    givesUp: boolean;
    // A per-pipe offset of where the bot aims, so bots don't fly identically.
    aimOffset: number;
}

function botAdminUserIds(ctx: nkruntime.Context): string[] {
    const raw = (ctx.env && ctx.env.BOT_ADMIN_USER_IDS) || "";
    return raw.split(",").map(s => s.trim()).filter(s => s.length > 0);
}

function canManageBots(ctx: nkruntime.Context, userId: string): boolean {
    if (!userId) {
        return false;
    }
    if (!ctx.env || ctx.env.IS_PRODUCTION !== "true") {
        return true;
    }
    return botAdminUserIds(ctx).indexOf(userId) >= 0;
}

let canManageBotsRpc: nkruntime.RpcFunction = function (
    ctx: nkruntime.Context,
    logger: nkruntime.Logger,
    nk: nkruntime.Nakama,
    payload: string
): string {
    return JSON.stringify({ canManageBots: canManageBots(ctx, ctx.userId || "") });
}

function botCount(state: State): number {
    let count = 0;
    for (const userId in state.players) {
        if (state.players[userId].bot) {
            count++;
        }
    }
    return count;
}

function newBotPlayer(userId: string, displayName: string, skill: number): PlayerData {
    return {
        isInLobby: true,
        lastKnownX: 0.0,
        lastKnownY: 0.0,
        lastKnownVelocityY: 0.0,
        score: 0,
        playingState: PlayingState.Idle,
        displayName,
        userId,
        spawnsAgainAt: 0,
        lastPing: 0,
        rosterIndex: -1,
        spawnX: 0,
        spawnY: 0,
        sim: null,
        lifeStartSeq: -1,
        lastSeq: 0,
        receivedUpToSeq: 0,
        pendingJumps: [],
        anchorTime: 0,
        minAnchorTime: 0,
        lastSentEntry: null,
        bot: {
            skill,
            startsAt: 0,
            pilotPipe: -1,
            givesUp: false,
            aimOffset: 0,
        },
    };
}

// Adds the next free bot to a waiting match. Returns false when it is full.
function addBot(nk: nkruntime.Nakama, logger: nkruntime.Logger, state: State): boolean {
    if (botCount(state) >= maxBotsPerMatch) {
        return false;
    }
    for (const profile of botProfiles) {
        let userId: string;
        try {
            const auth = nk.authenticateCustom(profile.id, profile.id, true);
            userId = auth.userId;
            if (auth.created) {
                nk.accountUpdateId(userId, null, profile.name);
            }
        } catch (e) {
            logger.error("Failed to get the bot account %s: %v", profile.id, e);
            return false;
        }
        if (state.players[userId]) {
            continue;
        }
        state.players[userId] = newBotPlayer(userId, profile.name, profile.skill);
        return true;
    }
    return false;
}

// Removes the most recently added bot. Returns false when there is none.
function removeBot(state: State): boolean {
    let last: string | null = null;
    for (const userId in state.players) {
        if (state.players[userId].bot) {
            last = userId;
        }
    }
    if (!last) {
        return false;
    }
    delete state.players[last];
    return true;
}

function removeAllBots(state: State) {
    for (const userId in state.players) {
        if (state.players[userId].bot) {
            delete state.players[userId];
        }
    }
}

// The sender of a bot's events. Bots aren't connected, so the session id is
// just the user id (both are UUIDs) and nothing is ever sent to it.
function botPresence(player: PlayerData): nkruntime.Presence {
    return {
        userId: player.userId,
        sessionId: player.userId,
        username: player.displayName,
        node: "",
    } as nkruntime.Presence;
}

function randomBetween(min: number, max: number): number {
    return min + Math.random() * (max - min);
}

// The same rule as tests/bots/netbot.mjs: jump when falling below the gap
// center of the next pipe.
function botWantsToJump(brain: BotBrain, sim: DashSim, pipesPositions: number[]): boolean {
    const next = Math.floor((sim.x - 60) / physicsPipesDistance) + 1;
    if (next !== brain.pilotPipe) {
        brain.pilotPipe = next;
        brain.givesUp = Math.random() > brain.skill;
        brain.aimOffset = randomBetween(10, 40);
    }
    const target = pipeGapCenterY(pipesPositions, next) + brain.aimOffset;
    return !brain.givesUp && sim.vy > 150 && sim.y > target;
}

// Called every match loop for each bot of a running match.
function simulateBot(dispatcher: nkruntime.MatchDispatcher, state: State, player: PlayerData, now: number) {
    const brain = player.bot!;
    const matchHasTimeLeft = now < state.matchFinishesAt;

    if (player.playingState === PlayingState.Idle) {
        if (brain.startsAt === 0) {
            brain.startsAt = now + randomBetween(botMinStartDelayMs, botMaxStartDelayMs);
        }
        if (now < brain.startsAt || !matchHasTimeLeft) {
            return;
        }
        brain.startsAt = 0;
        brain.pilotPipe = -1;
        player.playingState = PlayingState.Playing;
        player.spawnsAgainAt = 0;
        player.sim = newDashSim(player.spawnX, player.spawnY, player.score);
        // Bots count ticks on the server's clock; seq only has to grow.
        const seq = player.lastSeq + 1;
        player.lifeStartSeq = seq;
        player.lastSeq = seq - 1;
        player.receivedUpToSeq = seq - 1;
        player.anchorTime = now;
        player.minAnchorTime = now;
        player.pendingJumps = [];
        dispatcher.broadcastMessage(DashOpCode.PlayerStarted, serializeState(state), null, botPresence(player));
        return;
    }

    const sim = player.sim;
    if (player.playingState !== PlayingState.Playing || !sim) {
        return;
    }
    let target = player.lifeStartSeq + Math.floor((now - player.anchorTime) / msPerPhysicsTick);
    if (now > state.matchFinishesAt) {
        const finishSeq = player.lifeStartSeq + Math.floor((state.matchFinishesAt - player.anchorTime) / msPerPhysicsTick);
        target = Math.min(target, finishSeq);
    }
    target = Math.min(target, player.lastSeq + maxTicksPerLoop);
    while (player.lastSeq < target) {
        const jump = botWantsToJump(brain, sim, state.pipesPositions);
        const result = stepDash(sim, jump, state.pipesPositions);
        player.lastSeq = player.lastSeq + 1;
        if (result === DashStepResult.Scored) {
            player.score = sim.score;
        } else if (result === DashStepResult.Died) {
            onPlayerDied(dispatcher, state, player, now);
            return;
        }
    }
}
