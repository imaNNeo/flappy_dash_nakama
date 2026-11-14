const multiDashHandlerName = "multiDashMatchHandler";
// The match loop runs 20 times a second. Each loop simulates the input ticks
// that arrived (players are simulated at 60 ticks/s, see dash_physics.ts) and
// sends one snapshot, like Source's default 20 updates/s. Fewer loops keeps the
// Raspberry Pi's CPU low; the simulation itself doesn't depend on it.
const tickRate = 20;
const minimumPlayers = 2;
const baseWaitingForPlayersDuration = 30 * 1000;
const checkToIncreaseWaitingTime = 10 * 1000;
const removeMatchAfter = 10 * 1000;
const terminateEmptyMatchAfter = 10 * 1000;
// A waiting match that is not the one handed out by `get_waiting_match`
// (e.g. created by a race) terminates itself once it stays empty this long.
const terminateOrphanWaitingMatchAfter = 60 * 1000;
const playerSpawnsAgainAfter = 5 * 1000;

// --- Server authoritative simulation ---
// A player's dash runs on the player's own tick numbers (seq), so a jump
// counts at the tick it was pressed on the client, however long the packet
// took to arrive (this is how lag compensation works out for this game).
// The server maps each player's seq to its own clock with an anchor time:
// expectedSeq(now) = lifeStartSeq + (now - anchorTime) * 60 / 1000.
const msPerPhysicsTick = 1000 / physicsTickRate;
// A client may not run more than this ahead of its expected seq (speed hacks).
const maxTicksAhead = 15;
// The anchor moves earlier when packets arrive early (the first one may have
// been slow), but never more than this in total.
const maxAnchorCorrectionMs = 250;
// A client that sends nothing for this long is simulated without jumps (a
// frozen or disconnected client falls instead of hanging in the air).
const maxTicksBehind = 30;
// Never simulate more than this many ticks of one player in one loop.
const maxTicksPerLoop = 60;
// Inputs of ticks before the end of the match still count if they arrive
// within this time after it.
const finishGraceMs = 350;
const maxOneWayLatencyMs = 250;
// A full snapshot (every player) is sent this often; the ones between only
// carry players that changed (delta compression).
const fullSnapshotEveryLoops = 20;
// The client's clock may be a bit off; accept a new life slightly before the
// respawn time.
const respawnClockToleranceMs = 1000;

// Key (in Nakama's in-memory local cache) of the match id that new players
// should join. Matches live in memory too, so after a restart both are gone.
const waitingMatchCacheKey = "flappy_dash_waiting_match_id";

enum MatchPhase {
    WaitingForPlayers,
    Running,
    Finished,
}

enum PlayingState {
    Idle,
    Playing,
    Died,
}

interface PlayerData {
    isInLobby: boolean;
    lastKnownX: number;
    lastKnownY: number;
    lastKnownVelocityY: number;
    score: number;
    playingState: PlayingState;
    displayName: string;
    userId: string;
    spawnsAgainAt: number;
    lastPing: number;
    // Index in State.roster, -1 when not playing in this match.
    rosterIndex: number;
    // Where the current/next life starts (unwrapped x, see dash_physics.ts).
    spawnX: number;
    spawnY: number;
    sim: DashSim | null;
    // The client tick the current life started at.
    lifeStartSeq: number;
    // The last tick the server simulated.
    lastSeq: number;
    // The client said it simulated every tick up to this one.
    receivedUpToSeq: number;
    // Ticks (> lastSeq) the player jumped in, ascending.
    pendingJumps: number[];
    anchorTime: number;
    minAnchorTime: number;
    // The snapshot entry last sent for this player (for delta compression).
    lastSentEntry: SnapshotEntry | null;
    // Set for server-side bots (see bots.ts); they have no presence.
    bot?: BotBrain;
}

interface State {
    matchInitializedAt: number;
    matchRunsAt: number;
    matchFinishesAt: number;
    currentPhase: MatchPhase;
    presences: nkruntime.Presence[];
    players: {
        [key: string]: PlayerData
    },
    matchIsEmptySince?: number;
    pipesPositions: number[];
    matchFinishTextSent: boolean;
    // userIds of the players of a running match; snapshots refer to them by index.
    roster: string[];
    loopsSinceFullSnapshot: number;
    forceFullSnapshot: boolean;
}

interface MatchLabel {
    open: boolean;
}

enum DashOpCode {
    // Match
    MatchWelcome = 100,
    MatchWaitingTimeIncreased = 101,
    MatchPresencesUpdated = 102,
    MatchStarted = 103,
    MatchFinished = 104,
    MatchPing = 105,
    MatchPong = 106,

    // Player
    PlayerJoinedTheLobby = 200,
    PlayerStarted = 201,
    PlayerJumped = 202,
    PlayerScored = 203,
    PlayerDied = 204,
    PlayerIsIdle = 205,
    PlayerKickedFromLobby = 206,
    PlayerCorrectPosition = 207,
    PlayerDisplayNameUpdated = 208,
    PlayerWillSpawnAt = 209,
    PlayerInput = 210,
    // Client -> server: add or remove a bot in a waiting match (see bots.ts).
    BotAdd = 211,
    BotRemove = 212,

    // Server -> clients, binary, see net_protocol.ts
    MatchSnapshot = 110,
}

function makeLabel(open: boolean): string {
    const label: MatchLabel = { open };
    return JSON.stringify(label);
}

function isMatchOpen(nk: nkruntime.Nakama, matchId: string): boolean {
    const match = nk.matchGet(matchId);
    if (!match) {
        return false;
    }
    try {
        return (JSON.parse(match.label) as MatchLabel).open === true;
    } catch (e) {
        return false;
    }
}

function setWaitingMatchId(nk: nkruntime.Nakama, matchId: string) {
    nk.localcachePut(waitingMatchCacheKey, matchId);
}

function getCachedWaitingMatchId(nk: nkruntime.Nakama): string | null {
    const id = nk.localcacheGet(waitingMatchCacheKey);
    return typeof id === "string" && id.length > 0 ? id : null;
}

function getOrCreateWaitingMatch(nk: nkruntime.Nakama): string {
    const cached = getCachedWaitingMatchId(nk);
    if (cached && isMatchOpen(nk, cached)) {
        return cached;
    }
    const matchId = nk.matchCreate(multiDashHandlerName, {});
    setWaitingMatchId(nk, matchId);
    return matchId;
}

function readJson(nk: nkruntime.Nakama, data: ArrayBuffer): { [key: string]: any } {
    const text = nk.binaryToString(data);
    if (!text) {
        return {};
    }
    const parsed = JSON.parse(text);
    return parsed && typeof parsed === "object" ? parsed : {};
}

function toNumber(value: any, fallback: number): number {
    const n = Number(value);
    return isFinite(n) ? n : fallback;
}


function inLobbyPresences(state: State): nkruntime.Presence[] {
    return state.presences.filter(p => state.players[p.userId] && state.players[p.userId].isInLobby);
}

// The bots waiting in the lobby (they have no presence).
function inLobbyBots(state: State): PlayerData[] {
    const bots: PlayerData[] = [];
    for (const userId in state.players) {
        const player = state.players[userId];
        if (player.bot && player.isInLobby) {
            bots.push(player);
        }
    }
    return bots;
}

// Positions only need sub-pixel precision; full doubles make up a big part of
// every message.
function round2(n: number): number {
    return Math.round(n * 100) / 100;
}

// Every player event carries the whole match state to every player, so this
// is the bulk of the server's outgoing traffic. Only send the fields the
// clients read (server-only fields such as lastPing, matchFinishTextSent and
// the presences' node/reason stay out) and keep numbers short.
function serializeState(state: State): string {
    const players: { [key: string]: object } = {};
    for (const userId in state.players) {
        const p = state.players[userId];
        players[userId] = {
            userId: p.userId,
            displayName: p.displayName,
            isInLobby: p.isInLobby,
            lastKnownX: round2(p.lastKnownX),
            lastKnownY: round2(p.lastKnownY),
            lastKnownVelocityY: round2(p.lastKnownVelocityY),
            score: p.score,
            playingState: p.playingState,
            spawnsAgainAt: p.spawnsAgainAt,
            rosterIndex: p.rosterIndex,
            isBot: !!p.bot,
        };
    }
    return JSON.stringify({
        matchInitializedAt: state.matchInitializedAt,
        matchRunsAt: state.matchRunsAt,
        matchFinishesAt: state.matchFinishesAt,
        currentPhase: state.currentPhase,
        presences: state.presences.map(p => ({
            userId: p.userId,
            sessionId: p.sessionId,
            username: p.username,
        })),
        players,
        pipesPositions: state.pipesPositions,
        roster: state.roster,
    });
}

let matchInit: nkruntime.MatchInitFunction<State> = function (ctx: nkruntime.Context, logger: nkruntime.Logger, nk: nkruntime.Nakama, params: { [key: string]: string }) {
    const now = Date.now();
    let state: State = {
        matchInitializedAt: now,
        matchRunsAt: now + baseWaitingForPlayersDuration,
        matchFinishesAt: 0,
        currentPhase: MatchPhase.WaitingForPlayers,
        presences: [],
        players: {},
        pipesPositions: [],
        matchFinishTextSent: false,
        roster: [],
        loopsSinceFullSnapshot: 0,
        forceFullSnapshot: false,
    }

    return {
        state,
        tickRate,
        label: makeLabel(true),
    }
}

let matchJoinAttempt: nkruntime.MatchJoinAttemptFunction<State> = function (ctx: nkruntime.Context, logger: nkruntime.Logger, nk: nkruntime.Nakama, dispatcher: nkruntime.MatchDispatcher, tick: number, state: State, presence: nkruntime.Presence, metadata: { [key: string]: any }) {
    // A player that is already part of this match (e.g. reconnecting) can always come back.
    if (state.players[presence.userId] && state.currentPhase !== MatchPhase.Finished) {
        return {
            state,
            accept: true,
        }
    }

    if (state.currentPhase !== MatchPhase.WaitingForPlayers) {
        logger.debug('Match join attempt by %s rejected: joining phase is over.', presence.userId);
        return {
            state,
            accept: false,
            rejectMessage: 'Match joining phase is already over.',
        }
    }

    return {
        state,
        accept: true,
    }
}

let matchJoin: nkruntime.MatchJoinFunction<State> = function (ctx: nkruntime.Context, logger: nkruntime.Logger, nk: nkruntime.Nakama, dispatcher: nkruntime.MatchDispatcher, tick: number, state: State, presences: nkruntime.Presence[]) {
    for (let presence of presences) {
        // A reconnecting player keeps their score/state; only the presence (session) changes.
        if (!state.players[presence.userId]) {
            let displayName = '';
            try {
                const account = nk.accountGetId(presence.userId);
                displayName = account.user.displayName || '';
            } catch (e) {
                logger.warn('Could not load account %s: %v', presence.userId, e);
            }
            state.players[presence.userId] = {
                isInLobby: false,
                lastKnownX: 0.0,
                lastKnownY: 0.0,
                lastKnownVelocityY: 0.0,
                score: 0,
                playingState: PlayingState.Idle,
                displayName: displayName,
                userId: presence.userId,
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
            }
        }
        // Replace any stale presence of the same user (a previous session that hasn't left yet).
        state.presences = state.presences.filter(p => p.userId !== presence.userId);
        state.presences.push(presence);
    }
    delete state.matchIsEmptySince;
    // Whoever (re)joins a running match needs every player's current state.
    state.forceFullSnapshot = true;
    dispatcher.broadcastMessage(DashOpCode.MatchWelcome, serializeState(state), presences);
    dispatcher.broadcastMessage(DashOpCode.MatchPresencesUpdated, serializeState(state));
    return { state };
}

function handleMessage(ctx: nkruntime.Context, logger: nkruntime.Logger, nk: nkruntime.Nakama, dispatcher: nkruntime.MatchDispatcher, state: State, message: nkruntime.MatchMessage) {
    const sender = message.sender;
    const player = state.players[sender.userId];
    if (!player) {
        // Messages that were in flight when the sender left the match.
        return;
    }

    if (message.opCode === DashOpCode.MatchPing) {
        const envelope = readJson(nk, message.data);
        player.lastPing = toNumber(envelope['previousPing'], 0);
        dispatcher.broadcastMessage(DashOpCode.MatchPong, JSON.stringify({
            serverReceiveTime: Date.now(),
            pingId: envelope['pingId'],
        }), [sender], null);
        return;
    }

    switch (state.currentPhase) {
        case MatchPhase.WaitingForPlayers:
            switch (message.opCode) {
                case DashOpCode.PlayerJoinedTheLobby:
                    player.isInLobby = true;
                    dispatcher.broadcastMessage(DashOpCode.PlayerJoinedTheLobby, serializeState(state), null, sender);
                    sendTelegramMessage(nk, logger, ctx, formatPlayerJoinedMessage(ctx, state, sender.userId));
                    break;
                case DashOpCode.BotAdd:
                case DashOpCode.BotRemove:
                    if (!canManageBots(ctx, sender.userId)) {
                        logger.warn('User %s is not allowed to manage bots.', sender.userId);
                        break;
                    }
                    const changed = message.opCode === DashOpCode.BotAdd
                        ? addBot(nk, logger, state)
                        : removeBot(state);
                    if (changed) {
                        dispatcher.broadcastMessage(DashOpCode.MatchPresencesUpdated, serializeState(state));
                    }
                    break;
                case DashOpCode.PlayerDisplayNameUpdated:
                    const account = nk.accountGetId(sender.userId);
                    player.displayName = account.user.displayName || '';
                    dispatcher.broadcastMessage(DashOpCode.MatchPresencesUpdated, serializeState(state), null, sender);
                    break;
            }
            break;
        case MatchPhase.Running:
            if (message.opCode === DashOpCode.PlayerInput) {
                const packet = decodeInputPacket(message.data);
                if (packet) {
                    handlePlayerInput(nk, dispatcher, state, player, packet, Date.now());
                }
            }
            // Clients don't report positions, scores or deaths any more: the
            // server simulates them. Old message types are ignored.
            break;
    }
}

function presenceOf(state: State, userId: string): nkruntime.Presence | null {
    for (const p of state.presences) {
        if (p.userId === userId) {
            return p;
        }
    }
    const player = state.players[userId];
    if (player && player.bot) {
        // Clients tell whose event it is by its sender, so a bot's events
        // carry a stand-in presence (it isn't connected to anything).
        return botPresence(player);
    }
    return null;
}

// Every packet carries the tick its life started at, so a lost or early
// start can't leave the client and the server in different lives.
function handlePlayerInput(nk: nkruntime.Nakama, dispatcher: nkruntime.MatchDispatcher, state: State, player: PlayerData, packet: InputPacket, now: number) {
    if (player.rosterIndex < 0 || packet.upToSeq < packet.lifeStartSeq) {
        return;
    }
    if (packet.lifeStartSeq !== player.lifeStartSeq) {
        if (!canStartNewLife(state, player, now)) {
            return;
        }
        startLife(state, player, packet, now);
        dispatcher.broadcastMessage(DashOpCode.PlayerStarted, serializeState(state), null, presenceOf(state, player.userId));
    }
    if (player.playingState !== PlayingState.Playing) {
        // Late packets of a life that already ended.
        return;
    }
    if (packet.upToSeq > player.receivedUpToSeq) {
        player.receivedUpToSeq = packet.upToSeq;
        // The packet left the client right after tick upToSeq. If it arrived
        // earlier than the anchor says, the anchor was late (slow first packet).
        const arrivedAnchor = now - (packet.upToSeq - player.lifeStartSeq) * msPerPhysicsTick;
        if (arrivedAnchor < player.anchorTime) {
            player.anchorTime = Math.max(arrivedAnchor, player.minAnchorTime);
        }
    }
    // Always build a new array and assign it: arrays kept in the match state
    // can be wrapped Go slices in Nakama's runtime, and push() on those doesn't
    // always stick (the first jump of a life got lost that way).
    const jumps: number[] = [];
    for (const seq of player.pendingJumps) {
        jumps.push(seq);
    }
    for (const seq of packet.jumpSeqs) {
        if (seq > player.lastSeq && seq <= packet.upToSeq && jumps.indexOf(seq) < 0) {
            jumps.push(seq);
        }
    }
    jumps.sort((a, b) => a - b);
    player.pendingJumps = jumps;
}

function canStartNewLife(state: State, player: PlayerData, now: number): boolean {
    if (state.matchFinishesAt > 0 && now >= state.matchFinishesAt) {
        return false;
    }
    switch (player.playingState) {
        case PlayingState.Idle:
            return true;
        case PlayingState.Died:
            return now >= player.spawnsAgainAt - respawnClockToleranceMs;
        default:
            return false;
    }
}

function startLife(state: State, player: PlayerData, packet: InputPacket, now: number) {
    player.playingState = PlayingState.Playing;
    player.spawnsAgainAt = 0;
    player.sim = newDashSim(player.spawnX, player.spawnY, player.score);
    player.lifeStartSeq = packet.lifeStartSeq;
    player.lastSeq = packet.lifeStartSeq - 1;
    player.receivedUpToSeq = packet.lifeStartSeq - 1;
    player.pendingJumps = [];
    // Assume the packet left the client right now (it was sent right after
    // tick upToSeq), so its tick lifeStartSeq happened a bit earlier.
    player.anchorTime = now - (packet.upToSeq - packet.lifeStartSeq) * msPerPhysicsTick;
    player.minAnchorTime = player.anchorTime - maxAnchorCorrectionMs;
}

// The tick of this player that matches the end of the match on their screen.
function finishSeqOf(state: State, player: PlayerData): number {
    const oneWay = Math.max(0, Math.min(player.lastPing / 2, maxOneWayLatencyMs));
    return player.lifeStartSeq + Math.floor((state.matchFinishesAt + oneWay - player.anchorTime) / msPerPhysicsTick);
}

function simulatePlayer(ctx: nkruntime.Context, logger: nkruntime.Logger, nk: nkruntime.Nakama, dispatcher: nkruntime.MatchDispatcher, state: State, player: PlayerData, now: number, matchIsOver: boolean) {
    const sim = player.sim;
    if (player.playingState !== PlayingState.Playing || !sim) {
        return;
    }
    const expectedSeq = player.lifeStartSeq + Math.floor((now - player.anchorTime) / msPerPhysicsTick);
    let target = Math.min(player.receivedUpToSeq, expectedSeq + maxTicksAhead);
    // A client that went quiet doesn't freeze its dash: it keeps falling.
    target = Math.max(target, expectedSeq - maxTicksBehind);
    if (now > state.matchFinishesAt) {
        const finishSeq = finishSeqOf(state, player);
        // At the very end, whatever didn't arrive is simulated without jumps.
        target = matchIsOver ? finishSeq : Math.min(target, finishSeq);
    }
    target = Math.min(target, player.lastSeq + maxTicksPerLoop);

    // Read-only here; the jumps left over are assigned back below (see the
    // note in handlePlayerInput about arrays in the match state).
    const jumps = player.pendingJumps;
    let nextJump = 0;
    while (player.lastSeq < target) {
        const seq = player.lastSeq + 1;
        while (nextJump < jumps.length && jumps[nextJump] < seq) {
            nextJump++;
        }
        const jump = nextJump < jumps.length && jumps[nextJump] === seq;
        const result = stepDash(sim, jump, state.pipesPositions);
        player.lastSeq = seq;
        if (result === DashStepResult.Scored) {
            // Scores reach the clients with the next snapshot.
            player.score = sim.score;
        } else if (result === DashStepResult.Died) {
            onPlayerDied(dispatcher, state, player, now);
            return;
        }
    }
    while (nextJump < jumps.length && jumps[nextJump] <= player.lastSeq) {
        nextJump++;
    }
    if (nextJump > 0) {
        player.pendingJumps = jumps.slice(nextJump);
    }
}

function onPlayerDied(dispatcher: nkruntime.MatchDispatcher, state: State, player: PlayerData, now: number) {
    const sender = presenceOf(state, player.userId);
    player.playingState = PlayingState.Died;
    player.pendingJumps = [];
    // No separate PlayerDied message: the snapshot shows the death and
    // PlayerWillSpawnAt below carries the new state (one full state message
    // per death instead of two).

    // Respawn in the gap of a random pipe (the server decides, so nobody can
    // pick a convenient spot).
    const pipesCount = state.pipesPositions.length;
    const spawnOnPipeIndex = Math.floor(Math.random() * (pipesCount - 1));
    player.spawnX = (spawnOnPipeIndex + 1) * physicsPipesDistance;
    player.spawnY = state.pipesPositions[spawnOnPipeIndex] * physicsPipesPositionArea;
    player.lastKnownX = player.spawnX;
    player.lastKnownY = player.spawnY;
    player.lastKnownVelocityY = 0;
    player.spawnsAgainAt = now + playerSpawnsAgainAfter;
    dispatcher.broadcastMessage(DashOpCode.PlayerWillSpawnAt, serializeState(state), null, sender);
}

function snapshotEntryOf(player: PlayerData): SnapshotEntry {
    const sim = player.sim;
    const isPlaying = player.playingState === PlayingState.Playing && sim;
    return {
        rosterIndex: player.rosterIndex,
        playingState: player.playingState,
        score: player.score,
        seq: player.lastSeq,
        x: sim && player.playingState !== PlayingState.Idle ? sim.x : player.spawnX,
        y: sim && player.playingState !== PlayingState.Idle ? sim.y : player.spawnY,
        vy: isPlaying ? sim!.vy : 0,
        lastScoredPipe: sim ? sim.lastScoredPipe : 0,
    };
}

function sameEntry(a: SnapshotEntry, b: SnapshotEntry): boolean {
    return a.playingState === b.playingState && a.seq === b.seq && a.score === b.score
        && a.x === b.x && a.y === b.y && a.vy === b.vy && a.lastScoredPipe === b.lastScoredPipe;
}

function broadcastSnapshot(dispatcher: nkruntime.MatchDispatcher, state: State, now: number) {
    state.loopsSinceFullSnapshot++;
    const full = state.forceFullSnapshot || state.loopsSinceFullSnapshot >= fullSnapshotEveryLoops;
    const entries: SnapshotEntry[] = [];
    for (const userId of state.roster) {
        const player = state.players[userId];
        if (!player) {
            continue;
        }
        const entry = snapshotEntryOf(player);
        if (full || !player.lastSentEntry || !sameEntry(entry, player.lastSentEntry)) {
            entries.push(entry);
            player.lastSentEntry = entry;
        }
    }
    if (full) {
        state.loopsSinceFullSnapshot = 0;
        state.forceFullSnapshot = false;
    } else if (entries.length === 0) {
        // Nothing moved: nothing to send.
        return;
    }
    if (state.presences.length === 0) {
        return;
    }
    const kind = full ? SnapshotKind.Full : SnapshotKind.Delta;
    dispatcher.broadcastMessage(DashOpCode.MatchSnapshot, encodeSnapshot(kind, now - state.matchInitializedAt, entries), null, null, true);
}

function startMatch(ctx: nkruntime.Context, logger: nkruntime.Logger, nk: nkruntime.Nakama, dispatcher: nkruntime.MatchDispatcher, state: State) {
    // Close this match for new players and hand out a fresh waiting match right away,
    // so `get_waiting_match` never returns a match that is about to reject the join.
    dispatcher.matchLabelUpdate(makeLabel(false));
    try {
        const nextMatchId = nk.matchCreate(multiDashHandlerName, {});
        setWaitingMatchId(nk, nextMatchId);
    } catch (e) {
        logger.error('Failed to create the next waiting match: %v', e);
    }

    const inLobbyPlayers = inLobbyPresences(state);
    const bots = inLobbyBots(state);
    const playersInLobbyCount = inLobbyPlayers.length + bots.length;
    state.currentPhase = MatchPhase.Running;

    let matchDuration: number;
    if (playersInLobbyCount <= 3) {
        matchDuration = 2 * 60 * 1000;
    } else if (playersInLobbyCount <= 5) {
        matchDuration = 2.5 * 60 * 1000;
    } else {
        matchDuration = 3 * 60 * 1000;
    }
    state.matchFinishesAt = Date.now() + matchDuration;

    // Kick the players that are not in the lobby.
    const outOfLobbyPlayers = state.presences.filter(p => !state.players[p.userId] || !state.players[p.userId].isInLobby);
    if (outOfLobbyPlayers.length > 0) {
        dispatcher.broadcastMessage(DashOpCode.PlayerKickedFromLobby, serializeState(state), outOfLobbyPlayers);
    }

    // Generate pipes based on the number of players.
    const pipesCount = Math.max(Math.min(playersInLobbyCount, 42), 3);
    state.pipesPositions = [];
    for (let i = 0; i < pipesCount; i++) {
        // 4 decimals is ~0.03px on screen and keeps every message shorter.
        state.pipesPositions.push(Math.round((Math.random() * 2 - 1) * 10000) / 10000);
    }

    // Only the players in the lobby play. Each gets a random spawn point
    // (pipe i stands at x = i * pipesDistance) and an index for snapshots.
    state.roster = [];
    for (const presence of inLobbyPlayers) {
        const player = state.players[presence.userId];
        if (!player || player.rosterIndex >= 0) {
            continue;
        }
        player.rosterIndex = state.roster.length;
        state.roster.push(player.userId);
        player.playingState = PlayingState.Idle;
        player.spawnX = Math.floor(Math.random() * pipesCount) * physicsPipesDistance;
        player.spawnY = 0;
        player.lastKnownX = player.spawnX;
        player.lastKnownY = player.spawnY;
    }
    for (const bot of bots) {
        bot.rosterIndex = state.roster.length;
        state.roster.push(bot.userId);
        bot.playingState = PlayingState.Idle;
        bot.spawnX = Math.floor(Math.random() * pipesCount) * physicsPipesDistance;
        bot.spawnY = 0;
        bot.lastKnownX = bot.spawnX;
        bot.lastKnownY = bot.spawnY;
    }
    state.forceFullSnapshot = true;

    // Notify all players that the match has started.
    dispatcher.broadcastMessage(DashOpCode.MatchStarted, serializeState(state), inLobbyPlayers);
}

let matchLoop: nkruntime.MatchLoopFunction<State> = function (ctx: nkruntime.Context, logger: nkruntime.Logger, nk: nkruntime.Nakama, dispatcher: nkruntime.MatchDispatcher, tick: number, state: State, messages: nkruntime.MatchMessage[]) {
    // An exception escaping matchLoop makes Nakama stop the match for everybody,
    // so every message is handled in isolation.
    for (let message of messages) {
        try {
            handleMessage(ctx, logger, nk, dispatcher, state, message);
        } catch (e) {
            logger.warn('Failed to handle message with opCode %v from %s: %v', message.opCode, message.sender.userId, e);
        }
    }

    const now = Date.now();
    switch (state.currentPhase) {
        case MatchPhase.WaitingForPlayers: {
            if (state.presences.length === 0) {
                if (!state.matchIsEmptySince) {
                    state.matchIsEmptySince = now;
                }
                const isCurrentWaitingMatch = getCachedWaitingMatchId(nk) === ctx.matchId;
                if (!isCurrentWaitingMatch && now > state.matchIsEmptySince + terminateOrphanWaitingMatchAfter) {
                    logger.info('Terminating empty orphan waiting match %s', ctx.matchId);
                    return null;
                }
            }

            // Bots count as players, but a match never starts with bots only.
            const humansInLobbyCount = inLobbyPresences(state).length;
            const playersInLobbyCount = humansInLobbyCount > 0 ? humansInLobbyCount + inLobbyBots(state).length : 0;
            if (now > state.matchRunsAt && playersInLobbyCount >= minimumPlayers) {
                startMatch(ctx, logger, nk, dispatcher, state);
                return { state };
            }

            // 10 seconds before the match starts, if there aren't enough players, increase the waiting time.
            if (now > state.matchRunsAt - checkToIncreaseWaitingTime && playersInLobbyCount < minimumPlayers) {
                state.matchRunsAt = state.matchRunsAt + (checkToIncreaseWaitingTime * 1.5);
                dispatcher.broadcastMessage(DashOpCode.MatchWaitingTimeIncreased, serializeState(state));
            }
            return { state };
        }
        case MatchPhase.Running: {
            if (state.presences.length === 0 && !state.matchIsEmptySince) {
                state.matchIsEmptySince = now;
            }
            if (state.presences.length > 0 && state.matchIsEmptySince) {
                delete state.matchIsEmptySince;
            }
            if (state.matchIsEmptySince && now > state.matchIsEmptySince + terminateEmptyMatchAfter) {
                logger.debug('Match is empty since %v, terminating the match.', state.matchIsEmptySince);
                return null;
            }

            // Inputs from before the end of the match may still be on their
            // way; they count until the grace time is over.
            const matchIsOver = now > state.matchFinishesAt + finishGraceMs;
            for (const userId of state.roster) {
                const player = state.players[userId];
                if (!player) {
                    continue;
                }
                try {
                    if (player.bot) {
                        simulateBot(dispatcher, state, player, now);
                    } else {
                        simulatePlayer(ctx, logger, nk, dispatcher, state, player, now, matchIsOver);
                    }
                } catch (e) {
                    logger.warn('Failed to simulate player %s: %v', userId, e);
                }
                if (player.playingState === PlayingState.Died && now >= player.spawnsAgainAt && !matchIsOver) {
                    player.playingState = PlayingState.Idle;
                    dispatcher.broadcastMessage(DashOpCode.PlayerIsIdle, serializeState(state), null, presenceOf(state, userId));
                }
            }
            broadcastSnapshot(dispatcher, state, now);

            if (matchIsOver) {
                state.currentPhase = MatchPhase.Finished;
                try {
                    addMatchResult(nk, ctx.matchId!, {
                        initializedAt: state.matchInitializedAt,
                        startedAt: state.matchRunsAt,
                        finishedAt: state.matchFinishesAt,
                        scores: Object.keys(state.players).map(key => {
                            return {
                                playerId: key,
                                score: state.players[key].score,
                            }
                        }).sort((a, b) => b.score - a.score),
                    });
                } catch (e) {
                    logger.error('Failed to store the match result: %v', e);
                }
                dispatcher.broadcastMessage(DashOpCode.MatchFinished, serializeState(state));
            }
            return { state };
        }
        case MatchPhase.Finished:
            if (!state.matchFinishTextSent) {
                state.matchFinishTextSent = true;
                sendTelegramMessage(nk, logger, ctx, formatMatchResultMessage(ctx, state));
            }
            if (now > state.matchFinishesAt + finishGraceMs + removeMatchAfter) {
                return null;
            }
            return { state };
    }
    return { state };
}

let matchSignal: nkruntime.MatchSignalFunction<State> = function (ctx: nkruntime.Context, logger: nkruntime.Logger, nk: nkruntime.Nakama, dispatcher: nkruntime.MatchDispatcher, tick: number, state: State, data: string) {
    logger.info('Match Signal, phase is %v, waitingRemaining is: %v seconds', state.currentPhase, (state.matchRunsAt - Date.now()) / 1000);
    return { state, data };
}

let matchLeave: nkruntime.MatchLeaveFunction<State> = function (ctx: nkruntime.Context, logger: nkruntime.Logger, nk: nkruntime.Nakama, dispatcher: nkruntime.MatchDispatcher, tick: number, state: State, presences: nkruntime.Presence[]) {
    // Compare by session, not user: when a player reconnects, the old session's
    // leave can arrive after the new session already joined.
    const leftSessions: { [sessionId: string]: boolean } = {};
    for (let presence of presences) {
        leftSessions[presence.sessionId] = true;
    }
    state.presences = state.presences.filter(p => !leftSessions[p.sessionId]);

    if (state.currentPhase === MatchPhase.WaitingForPlayers) {
        for (let presence of presences) {
            const stillConnected = state.presences.some(p => p.userId === presence.userId);
            if (!stillConnected) {
                delete state.players[presence.userId];
            }
        }
        // Bots only keep people company: when the last person leaves the
        // lobby, they go too.
        if (state.presences.length === 0) {
            removeAllBots(state);
        }
    }

    dispatcher.broadcastMessage(DashOpCode.MatchPresencesUpdated, serializeState(state));

    return { state };
}

let matchTerminate: nkruntime.MatchTerminateFunction<State> = function (ctx: nkruntime.Context, logger: nkruntime.Logger, nk: nkruntime.Nakama, dispatcher: nkruntime.MatchDispatcher, tick: number, state: State, graceSeconds: number) {
    return { state };
}
