const multiDashHandlerName = "multiDashMatchHandler";
const tickRate = 60;
const minimumPlayers = 2;
const baseWaitingForPlayersDuration = 30 * 1000;
const checkToIncreaseWaitingTime = 10 * 1000;
const matchDuration = 3 * 60 * 1000; 
const removeMatchAfter = 10 * 1000;
const terminateEmptyMatchAfter = 10 * 1000;
const playerSpawnsAgainAfter = 5 * 1000;


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

interface State {
    matchInitializedAt: number;
    matchRunsAt: number;
    matchFinishesAt: number;
    currentPhase: MatchPhase;
    presences: nkruntime.Presence[];
    players: {
        [key: string]: {
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
    },
    matchIsEmptySince?: number;
    pipesPositions: number[];
    matchFinishTextSent: boolean;
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

let matchInit: nkruntime.MatchInitFunction<State> = function (ctx: nkruntime.Context, logger: nkruntime.Logger, nk: nkruntime.Nakama, params: { [key: string]: string }) {

    let state: State = {
        matchInitializedAt: Date.now(),
        matchRunsAt: Date.now() + baseWaitingForPlayersDuration,
        matchFinishesAt: 0,
        currentPhase: MatchPhase.WaitingForPlayers,
        presences: [],
        players: {},
        pipesPositions: [],
        matchFinishTextSent: false,
    }

    if (ctx.matchId) {
        addWaitingMatch(nk, ctx.matchId);
    }

    return {
        state,
        tickRate,
        label: 'Flappy Dash Match',
    }
}

let matchJoinAttempt: nkruntime.MatchJoinAttemptFunction<State> = function (ctx: nkruntime.Context, logger: nkruntime.Logger, nk: nkruntime.Nakama, dispatcher: nkruntime.MatchDispatcher, tick: number, state: State, presence: nkruntime.Presence, metadata: { [key: string]: any }) {
    // Check if it's a user attempting to rejoin after a disconnect.
    logger.info('Match Join Attempt: %o', presence.userId);
    if (state.players[presence.userId]) {
        return {
            state,
            accept: true,
        }
    }

    // Check if match is already running.
    if (state.currentPhase !== MatchPhase.WaitingForPlayers) {
        logger.info('Match Join Attempt: %o, Match joining phase is already over.', presence.userId);
        return {
            state,
            accept: false,
            rejectMessage: 'Match joining phase is already over.',
        }
    }

    logger.info('Match Join Attempt: %o successfully joined the match.', presence.userId);
    return {
        state,
        accept: true,
    }
}

let matchJoin: nkruntime.MatchJoinFunction<State> = function (ctx: nkruntime.Context, logger: nkruntime.Logger, nk: nkruntime.Nakama, dispatcher: nkruntime.MatchDispatcher, tick: number, state: State, presences: nkruntime.Presence[]) {
    for (let presence of presences) {

        const account = nk.accountGetId(presence.userId);
        // Hash code of the user id
        state.players[presence.userId] = {
            isInLobby: false,
            lastKnownX: 0.0,
            lastKnownY: 0.0,
            lastKnownVelocityY: 0.0,
            score: 0,
            playingState: PlayingState.Idle,
            displayName: account.user.displayName || '',
            userId: presence.userId,
            spawnsAgainAt: 0,
            lastPing: 0,
        }
    }
    state.presences = state.presences.concat(presences);
    dispatcher.broadcastMessage(DashOpCode.MatchWelcome, JSON.stringify(state), presences);
    dispatcher.broadcastMessage(DashOpCode.MatchPresencesUpdated, JSON.stringify(state));
    return { state };
}

function arrayBufferToJson(buffer: ArrayBuffer) {
    let binary = '';
    let bytes = new Uint8Array(buffer);
    for (let i = 0; i < bytes.length; i++) {
        binary += String.fromCharCode(bytes[i]);
    }
    return JSON.parse(decodeURIComponent(encodeURIComponent(binary)));
}

let matchLoop: nkruntime.MatchLoopFunction<State> = function (ctx: nkruntime.Context, logger: nkruntime.Logger, nk: nkruntime.Nakama, dispatcher: nkruntime.MatchDispatcher, tick: number, state: State, messages: nkruntime.MatchMessage[]) {
    for (let message of messages) {
        let opCode = message.opCode;
        switch (opCode) {
            case DashOpCode.MatchPing:
                let envelope = arrayBufferToJson(message.data);
                state.players[message.sender.userId].lastPing = envelope['previousPing'];
                const pingId = envelope['pingId'];
                let sendingData = {
                    serverReceiveTime: Date.now(),
                    pingId: pingId,
                }
                dispatcher.broadcastMessage(DashOpCode.MatchPong, JSON.stringify(sendingData), [message.sender], null);
                break;
        }
    }

    switch (state.currentPhase) {
        case MatchPhase.WaitingForPlayers:
            for (let message of messages) {
                let opCode = message.opCode;
                switch (opCode) {
                    case DashOpCode.PlayerJoinedTheLobby:
                        state.players[message.sender.userId].isInLobby = true;
                        dispatcher.broadcastMessage(DashOpCode.PlayerJoinedTheLobby, JSON.stringify(state), null, message.sender);
                        sendTelegramMessage(nk, logger, ctx, formatPlayerJoinedMessage(state, message.sender.userId));
                        break;
                    case DashOpCode.PlayerDisplayNameUpdated:
                        const account = nk.accountGetId(message.sender.userId);
                        state.players[message.sender.userId].displayName = account.user.displayName || '';
                        dispatcher.broadcastMessage(DashOpCode.MatchPresencesUpdated, JSON.stringify(state), null, message.sender);
                        break;
                }
            }


            const playersInLobbyCount = state.presences.filter(p => state.players[p.userId].isInLobby).length;
            // Check if the match should start.
            if (Date.now() > state.matchRunsAt && playersInLobbyCount >= minimumPlayers) {
                if (ctx.matchId) {
                    removeWaitingMatch(nk, ctx.matchId);
                }
                state.currentPhase = MatchPhase.Running;

                state.matchFinishesAt = Date.now() + matchDuration;

                // Kick the players that are not in the lobby.
                const outOfLobbyPlayers = state.presences.filter(p => !state.players[p.userId].isInLobby);
                dispatcher.broadcastMessage(DashOpCode.PlayerKickedFromLobby, JSON.stringify(state), outOfLobbyPlayers);

                // Notify all players that the match has started.
                const inLobbyPlayers = state.presences.filter(p => state.players[p.userId].isInLobby);

                // Generate pipes based on the number of players.
                const playersCount = inLobbyPlayers.length;
                const pipesCount = Math.min(Math.ceil((playersCount * 1.5)), 42);
                state.pipesPositions = [];
                for (let i = 0; i < pipesCount; i++) {
                    state.pipesPositions.push(Math.random() * 2 - 1);
                }

                dispatcher.broadcastMessage(DashOpCode.MatchStarted, JSON.stringify(state), inLobbyPlayers);

                // Create a new match
                nk.matchCreate(multiDashHandlerName);

                // Todo: Set an initial position for each player.
                return { state };
            }

            // check 10 seconds before the match starts to see if there aren't enough players, if so, increase the waiting time.
            if (Date.now() > state.matchRunsAt - checkToIncreaseWaitingTime && playersInLobbyCount < minimumPlayers) {
                state.matchRunsAt = state.matchRunsAt + (checkToIncreaseWaitingTime * 1.5);
                dispatcher.broadcastMessage(DashOpCode.MatchWaitingTimeIncreased, JSON.stringify(state));
                return { state };
            }

            return { state };
        case MatchPhase.Running:

            if (state.presences.length === 0 && !state.matchIsEmptySince) {
                state.matchIsEmptySince = Date.now();
            }
            if (state.presences.length > 0 && state.matchIsEmptySince) {
                delete state.matchIsEmptySince;
            }
            if (state.matchIsEmptySince && Date.now() > state.matchIsEmptySince + terminateEmptyMatchAfter) {
                logger.debug('Match is empty since %o, terminating the match.', state.matchIsEmptySince);
                return null;
            }

            // Handle the running match
            if (Date.now() > state.matchFinishesAt) {
                state.currentPhase = MatchPhase.Finished;
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
                dispatcher.broadcastMessage(DashOpCode.MatchFinished, JSON.stringify(state));
                return { state };
            }

            for (let message of messages) {
                let opCode = message.opCode;
                // decode utf8 message.data
                switch (opCode) {
                    case DashOpCode.PlayerStarted:
                        state.players[message.sender.userId].playingState = PlayingState.Playing;
                        state.players[message.sender.userId].lastKnownX = 0.0;
                        state.players[message.sender.userId].lastKnownY = 0.0;
                        state.players[message.sender.userId].lastKnownVelocityY = 0.0;
                        dispatcher.broadcastMessage(DashOpCode.PlayerStarted, JSON.stringify(state), null, message.sender);
                        break;
                    case DashOpCode.PlayerJumped:
                        let data1 = arrayBufferToJson(message.data);
                        state.players[message.sender.userId].lastKnownX = data1['positionX'];
                        state.players[message.sender.userId].lastKnownY = data1['positionY'];
                        state.players[message.sender.userId].lastKnownVelocityY = data1['velocityY'];
                        dispatcher.broadcastMessage(DashOpCode.PlayerJumped, JSON.stringify(state), null, message.sender);
                        break;
                    case DashOpCode.PlayerScored:
                        let data2 = arrayBufferToJson(message.data);
                        state.players[message.sender.userId].score += 1;
                        state.players[message.sender.userId].lastKnownX = data2['positionX'];
                        state.players[message.sender.userId].lastKnownY = data2['positionY'];
                        state.players[message.sender.userId].lastKnownVelocityY = data2['velocityY'];
                        dispatcher.broadcastMessage(DashOpCode.PlayerScored, JSON.stringify(state), null, message.sender);
                        break;
                    case DashOpCode.PlayerDied:
                        let data3 = arrayBufferToJson(message.data);
                        state.players[message.sender.userId].playingState = PlayingState.Died;
                        state.players[message.sender.userId].lastKnownX = data3['positionX'];
                        state.players[message.sender.userId].lastKnownY = data3['positionY'];
                        state.players[message.sender.userId].lastKnownVelocityY = data3['velocityY'];
                        dispatcher.broadcastMessage(DashOpCode.PlayerDied, JSON.stringify(state), null, message.sender);

                        state.players[message.sender.userId].lastKnownX = data3['newPositionX'];
                        state.players[message.sender.userId].lastKnownY = data3['newPositionY'];
                        state.players[message.sender.userId].spawnsAgainAt = Date.now() + playerSpawnsAgainAfter;
                        dispatcher.broadcastMessage(DashOpCode.PlayerWillSpawnAt, JSON.stringify(state), null, message.sender);
                        break;
                    case DashOpCode.PlayerIsIdle:
                        let data4 = arrayBufferToJson(message.data);
                        state.players[message.sender.userId].playingState = PlayingState.Idle;
                        state.players[message.sender.userId].lastKnownX = data4['positionX'];
                        state.players[message.sender.userId].lastKnownY = data4['positionY'];
                        state.players[message.sender.userId].spawnsAgainAt = 0;
                        state.players[message.sender.userId].lastKnownVelocityY = 0.0;
                        dispatcher.broadcastMessage(DashOpCode.PlayerIsIdle, JSON.stringify(state), null, message.sender);
                        break;

                    case DashOpCode.PlayerCorrectPosition:
                        let data5 = arrayBufferToJson(message.data);
                        state.players[message.sender.userId].lastKnownX = data5['positionX'];
                        state.players[message.sender.userId].lastKnownY = data5['positionY'];
                        state.players[message.sender.userId].lastKnownVelocityY = data5['velocityY'];
                        dispatcher.broadcastMessage(DashOpCode.PlayerCorrectPosition, JSON.stringify(state), null, message.sender);
                        break;
                }
            }

            return { state };
        case MatchPhase.Finished:
            if (!state.matchFinishTextSent) {
                state.matchFinishTextSent = true;
                sendTelegramMessage(nk, logger, ctx, formatMatchResultMessage(ctx, state));
            }
            if (Date.now() > state.matchFinishesAt + removeMatchAfter) {
                return null;
            }
            return { state };
    }
}

let matchSignal: nkruntime.MatchSignalFunction<State> = function (ctx: nkruntime.Context, logger: nkruntime.Logger, nk: nkruntime.Nakama, dispatcher: nkruntime.MatchDispatcher, tick: number, state: State) {
    logger.info('Match Signal, phase is %o, waitingRemaining is: %o seconds', state.currentPhase, (state.matchRunsAt - Date.now()) / 1000);
    return { state };
}

let matchLeave: nkruntime.MatchLeaveFunction<State> = function (ctx: nkruntime.Context, logger: nkruntime.Logger, nk: nkruntime.Nakama, dispatcher: nkruntime.MatchDispatcher, tick: number, state: State, presences: nkruntime.Presence[]) {

    if (state.currentPhase === MatchPhase.WaitingForPlayers) {
        for (let presence of presences) {
            delete state.players[presence.userId];
        }
    }

    state.presences = state.presences.filter(p =>
        !presences.some(pp => pp.userId === p.userId)
    )

    dispatcher.broadcastMessage(DashOpCode.MatchPresencesUpdated, JSON.stringify(state));

    return { state };
}

let matchTerminate: nkruntime.MatchTerminateFunction<State> = function (ctx: nkruntime.Context, logger: nkruntime.Logger, nk: nkruntime.Nakama, dispatcher: nkruntime.MatchDispatcher, tick: number, state: State, graceSeconds: number) {
    if (ctx.matchId) {
        removeWaitingMatch(nk, ctx.matchId);
    }
    return { state };
}