const multiDashHandlerName = "multiDashMatchHandler";
const tickRate = 60;
const minimumPlayers = 2;
const baseWaitingForPlayersDuration = 30 * 1000;
const checkToIncreaseWaitingTime = 10 * 1000;
const removeMatchAfter = 10 * 1000;
const terminateEmptyMatchAfter = 10 * 1000;
// A waiting match that is not the one handed out by `get_waiting_match`
// (e.g. created by a race) terminates itself once it stays empty this long.
const terminateOrphanWaitingMatchAfter = 60 * 1000;
const playerSpawnsAgainAfter = 5 * 1000;

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

function updatePosition(player: PlayerData, data: { [key: string]: any }) {
    player.lastKnownX = toNumber(data['positionX'], player.lastKnownX);
    player.lastKnownY = toNumber(data['positionY'], player.lastKnownY);
    player.lastKnownVelocityY = toNumber(data['velocityY'], player.lastKnownVelocityY);
}

function inLobbyPresences(state: State): nkruntime.Presence[] {
    return state.presences.filter(p => state.players[p.userId] && state.players[p.userId].isInLobby);
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
            }
        }
        // Replace any stale presence of the same user (a previous session that hasn't left yet).
        state.presences = state.presences.filter(p => p.userId !== presence.userId);
        state.presences.push(presence);
    }
    delete state.matchIsEmptySince;
    dispatcher.broadcastMessage(DashOpCode.MatchWelcome, JSON.stringify(state), presences);
    dispatcher.broadcastMessage(DashOpCode.MatchPresencesUpdated, JSON.stringify(state));
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
                    dispatcher.broadcastMessage(DashOpCode.PlayerJoinedTheLobby, JSON.stringify(state), null, sender);
                    sendTelegramMessage(nk, logger, ctx, formatPlayerJoinedMessage(ctx, state, sender.userId));
                    break;
                case DashOpCode.PlayerDisplayNameUpdated:
                    const account = nk.accountGetId(sender.userId);
                    player.displayName = account.user.displayName || '';
                    dispatcher.broadcastMessage(DashOpCode.MatchPresencesUpdated, JSON.stringify(state), null, sender);
                    break;
            }
            break;
        case MatchPhase.Running:
            switch (message.opCode) {
                case DashOpCode.PlayerStarted:
                    player.playingState = PlayingState.Playing;
                    player.lastKnownX = 0.0;
                    player.lastKnownY = 0.0;
                    player.lastKnownVelocityY = 0.0;
                    dispatcher.broadcastMessage(DashOpCode.PlayerStarted, JSON.stringify(state), null, sender);
                    break;
                case DashOpCode.PlayerJumped:
                    updatePosition(player, readJson(nk, message.data));
                    dispatcher.broadcastMessage(DashOpCode.PlayerJumped, JSON.stringify(state), null, sender);
                    break;
                case DashOpCode.PlayerScored:
                    player.score += 1;
                    updatePosition(player, readJson(nk, message.data));
                    dispatcher.broadcastMessage(DashOpCode.PlayerScored, JSON.stringify(state), null, sender);
                    break;
                case DashOpCode.PlayerDied: {
                    const data = readJson(nk, message.data);
                    player.playingState = PlayingState.Died;
                    updatePosition(player, data);
                    dispatcher.broadcastMessage(DashOpCode.PlayerDied, JSON.stringify(state), null, sender);

                    player.lastKnownX = toNumber(data['newPositionX'], player.lastKnownX);
                    player.lastKnownY = toNumber(data['newPositionY'], player.lastKnownY);
                    player.spawnsAgainAt = Date.now() + playerSpawnsAgainAfter;
                    dispatcher.broadcastMessage(DashOpCode.PlayerWillSpawnAt, JSON.stringify(state), null, sender);
                    break;
                }
                case DashOpCode.PlayerIsIdle: {
                    const data = readJson(nk, message.data);
                    player.playingState = PlayingState.Idle;
                    player.lastKnownX = toNumber(data['positionX'], player.lastKnownX);
                    player.lastKnownY = toNumber(data['positionY'], player.lastKnownY);
                    player.spawnsAgainAt = 0;
                    player.lastKnownVelocityY = 0.0;
                    dispatcher.broadcastMessage(DashOpCode.PlayerIsIdle, JSON.stringify(state), null, sender);
                    break;
                }
                case DashOpCode.PlayerCorrectPosition:
                    updatePosition(player, readJson(nk, message.data));
                    dispatcher.broadcastMessage(DashOpCode.PlayerCorrectPosition, JSON.stringify(state), null, sender);
                    break;
            }
            break;
    }
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
    const playersInLobbyCount = inLobbyPlayers.length;
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
        dispatcher.broadcastMessage(DashOpCode.PlayerKickedFromLobby, JSON.stringify(state), outOfLobbyPlayers);
    }

    // Generate pipes based on the number of players.
    const pipesCount = Math.max(Math.min(playersInLobbyCount, 42), 3);
    state.pipesPositions = [];
    for (let i = 0; i < pipesCount; i++) {
        state.pipesPositions.push(Math.random() * 2 - 1);
    }

    // Notify all players that the match has started.
    dispatcher.broadcastMessage(DashOpCode.MatchStarted, JSON.stringify(state), inLobbyPlayers);
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

            const playersInLobbyCount = inLobbyPresences(state).length;
            if (now > state.matchRunsAt && playersInLobbyCount >= minimumPlayers) {
                startMatch(ctx, logger, nk, dispatcher, state);
                return { state };
            }

            // 10 seconds before the match starts, if there aren't enough players, increase the waiting time.
            if (now > state.matchRunsAt - checkToIncreaseWaitingTime && playersInLobbyCount < minimumPlayers) {
                state.matchRunsAt = state.matchRunsAt + (checkToIncreaseWaitingTime * 1.5);
                dispatcher.broadcastMessage(DashOpCode.MatchWaitingTimeIncreased, JSON.stringify(state));
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

            if (now > state.matchFinishesAt) {
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
                dispatcher.broadcastMessage(DashOpCode.MatchFinished, JSON.stringify(state));
            }
            return { state };
        }
        case MatchPhase.Finished:
            if (!state.matchFinishTextSent) {
                state.matchFinishTextSent = true;
                sendTelegramMessage(nk, logger, ctx, formatMatchResultMessage(ctx, state));
            }
            if (now > state.matchFinishesAt + removeMatchAfter) {
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
    }

    dispatcher.broadcastMessage(DashOpCode.MatchPresencesUpdated, JSON.stringify(state));

    return { state };
}

let matchTerminate: nkruntime.MatchTerminateFunction<State> = function (ctx: nkruntime.Context, logger: nkruntime.Logger, nk: nkruntime.Nakama, dispatcher: nkruntime.MatchDispatcher, tick: number, state: State, graceSeconds: number) {
    return { state };
}
