const matchHandlerName = "matchHandlerName";
const tickRate = 40;
const minimumPlayers = 2;
const baseWaitingForPlayersDuration = 30 * 1000;
const checkToIncreaseWaitingTime = 10 * 1000;
const removeMatchAfter = 10 * 1000;
const terminateEmptyMatchAfter = 10 * 1000;

let matchInit: nkruntime.MatchInitFunction<MatchState> = function (ctx: nkruntime.Context, logger: nkruntime.Logger, nk: nkruntime.Nakama, params: { [key: string]: string }) {
    let state: MatchState = {
        playingTickRate: tickRate,
        playingTickNumber: 0,
        pipesDistance: 0,
        pipesNormalizedYPositions: [],
        pipesHoleGap: 0,
        pipesYRange: 0,
        pipeWidth: 0,
        matchInitializedAt: Date.now(),
        matchRunsAt: Date.now() + baseWaitingForPlayersDuration,
        matchFinishesAt: 0,
        currentPhase: MatchPhase.WaitingForPlayers,
        presences: [],
        gravityY: 0,
        matchFinishTextSent: false,
        players: {},
        playersInitialXSpeed: 0,
        playerSpawnsAgainAfter: 5 * 1000,
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

let matchJoinAttempt: nkruntime.MatchJoinAttemptFunction<MatchState> = function (ctx: nkruntime.Context, logger: nkruntime.Logger, nk: nkruntime.Nakama, dispatcher: nkruntime.MatchDispatcher, tick: number, state: MatchState, presence: nkruntime.Presence, metadata: { [key: string]: any }) {
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

let matchJoin: nkruntime.MatchJoinFunction<MatchState> = function (ctx: nkruntime.Context, logger: nkruntime.Logger, nk: nkruntime.Nakama, dispatcher: nkruntime.MatchDispatcher, tick: number, state: MatchState, presences: nkruntime.Presence[]) {

    const joinedPlayersInfo: { [key: string]: PlayerInfo } = {};

    for (let presence of presences) {
        const account = nk.accountGetId(presence.userId);
        state.players[presence.userId] = {
            isInLobby: false,
            x: 0.0,
            y: 0.0,
            velocityX: 0.0,
            velocityY: 0.0,
            score: 0,
            diedCount: 0,
            playingState: PlayingState.Idle,
            displayName: account.user.displayName || '',
            userId: presence.userId,
            spawnsAgainIn: 0,
            lastPing: 0,
            jumpForce: 0,
        }
        joinedPlayersInfo[presence.userId] = state.players[presence.userId];
    }
    state.presences = state.presences.concat(presences);
    dispatcher.broadcastMessage(MatchOpCode.MatchWelcome, JSON.stringify(state), presences);
    dispatcher.broadcastMessage(MatchOpCode.MatchPlayersJoined, JSON.stringify(joinedPlayersInfo));
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

let matchLoop: nkruntime.MatchLoopFunction<MatchState> = function (ctx: nkruntime.Context, logger: nkruntime.Logger, nk: nkruntime.Nakama, dispatcher: nkruntime.MatchDispatcher, tick: number, state: MatchState, messages: nkruntime.MatchMessage[]) {
    for (let message of messages) {
        let opCode = message.opCode;
        switch (opCode) {
            case MatchOpCode.MatchPing:
                let envelope = arrayBufferToJson(message.data);
                state.players[message.sender.userId].lastPing = envelope['previousPing'];
                const pingId = envelope['pingId'];
                let sendingData = {
                    serverReceiveTime: Date.now(),
                    pingId: pingId,
                }
                dispatcher.broadcastMessage(MatchOpCode.MatchPong, JSON.stringify(sendingData), [message.sender], null);
                break;
        }
    }

    switch (state.currentPhase) {
        case MatchPhase.WaitingForPlayers:
            for (let message of messages) {
                let opCode = message.opCode;
                switch (opCode) {
                    case MatchOpCode.PlayerJoinedTheLobby:
                        state.players[message.sender.userId].isInLobby = true;
                        const joinedPlayer = state.players[message.sender.userId];
                        dispatcher.broadcastMessage(MatchOpCode.PlayerJoinedTheLobby, JSON.stringify(joinedPlayer), null, message.sender);
                        sendTelegramMessage(nk, logger, ctx, formatPlayerJoinedMessage(ctx, state, message.sender.userId));
                        break;
                    case MatchOpCode.MatchPlayerNameUpdated:
                        const account = nk.accountGetId(message.sender.userId);
                        state.players[message.sender.userId].displayName = account.user.displayName || '';
                        const newDisplayName = state.players[message.sender.userId].displayName;
                        dispatcher.broadcastMessage(MatchOpCode.MatchPlayerNameUpdated, JSON.stringify({
                            "newDisplayName": newDisplayName,
                        }), null, message.sender);
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

                var matchDuration: number;
                if (playersInLobbyCount <= 3) {
                    matchDuration = 2 * 60 * 1000;
                } else if (playersInLobbyCount <= 5) {
                    matchDuration = 2.5 * 60 * 1000;
                } else {
                    matchDuration = 3 * 60 * 1000;
                }

                state.matchFinishesAt = Date.now() + matchDuration;

                // Kick the players that are not in the lobby.
                const outOfLobbyPlayers = state.presences.filter(p => !state.players[p.userId].isInLobby);
                dispatcher.broadcastMessage(MatchOpCode.PlayerKickedFromLobby, null, outOfLobbyPlayers);

                // Notify all players that the match has started.
                const inLobbyPlayers = state.presences.filter(p => state.players[p.userId].isInLobby);

                state.gravityY = 1400.0;
                state.playersInitialXSpeed = 160.0;
                state.pipesDistance = 420.0;
                state.pipesHoleGap = 240.0;
                state.pipesYRange = 300.0;
                state.pipeWidth = 82.0;

                // Generate pipes based on the number of players.
                const playersCount = inLobbyPlayers.length;

                const pipesCount = Math.max(Math.min(playersCount, 42), 3);
                state.pipesNormalizedYPositions = [];
                for (let i = 0; i < pipesCount; i++) {
                    state.pipesNormalizedYPositions.push(Math.random() * 2 - 1);
                }

                // random player positions
                for (let presence of inLobbyPlayers) {
                    const randomPos = getPlayerRandomPosition(state);
                    state.players[presence.userId].x = randomPos.x;
                    state.players[presence.userId].y = randomPos.y;
                    state.players[presence.userId].velocityX = 0;
                    state.players[presence.userId].velocityY = 0;
                    state.players[presence.userId].score = 0;
                    state.players[presence.userId].diedCount = 0;
                    state.players[presence.userId].jumpForce = -500.0;
                    state.players[presence.userId].playingState = PlayingState.Idle;
                }

                dispatcher.broadcastMessage(MatchOpCode.MatchStarted, JSON.stringify(state), inLobbyPlayers);

                // Create a new match
                nk.matchCreate(matchHandlerName);

                return { state };
            }

            // check X seconds before the match starts to see if there aren't enough players, if so, increase the waiting time.
            if (Date.now() > state.matchRunsAt - checkToIncreaseWaitingTime && playersInLobbyCount < minimumPlayers) {
                state.matchRunsAt = state.matchRunsAt + (checkToIncreaseWaitingTime * 1.5);
                dispatcher.broadcastMessage(MatchOpCode.MatchWaitingTimeIncreased, JSON.stringify({
                    newMatchRunsAt: state.matchRunsAt,
                }));
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

            // Time is up! Finishing the match.
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
                dispatcher.broadcastMessage(MatchOpCode.MatchFinished, null);
                return { state };
            }

            // Handle the running match
            state.playingTickNumber++;
            const matchDiff: MatchDiff = {
                tickNumber: state.playingTickNumber,
                tickTimestamp: -1,
                diffInfo: [],
            }
            matchDiff.diffInfo.push(
                ...moveAlivePlayers(state),
                ...spawnOrDecreaseDieTimer(state),
            );

            for (let message of messages) {
                let opCode = message.opCode;
                // decode utf8 message.data
                switch (opCode) {
                    case MatchOpCode.PlayerStarted:
                        matchDiff.diffInfo.push(
                            handlePlayerStarted(state, message.sender.userId),
                        );
                        break;
                    case MatchOpCode.PlayerJumped:
                        matchDiff.diffInfo.push(
                            handlePlayerJumped(state, message.sender.userId),
                        );
                        break;
                        case MatchOpCode.PlayerScored:
                            matchDiff.diffInfo.push(
                                handlePlayerScored(state, message.sender.userId),
                            );
                        break;
                    case MatchOpCode.PlayerDied:
                        matchDiff.diffInfo.push(
                            handlePlayerDied(state, message.sender.userId),
                        );
                        break;
                    case MatchOpCode.PlayerFullStateNeeded:
                        dispatcher.broadcastMessage(MatchOpCode.PlayerFullStateNeeded, JSON.stringify(state), [message.sender]);
                        break;       
                }
            }
            matchDiff.tickTimestamp = Date.now();
            dispatcher.broadcastMessage(MatchOpCode.PlayerTickUpdate, JSON.stringify(matchDiff));

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

let matchSignal: nkruntime.MatchSignalFunction<MatchState> = function (ctx: nkruntime.Context, logger: nkruntime.Logger, nk: nkruntime.Nakama, dispatcher: nkruntime.MatchDispatcher, tick: number, state: MatchState) {
    logger.info('Match Signal, phase is %o, waitingRemaining is: %o seconds', state.currentPhase, (state.matchRunsAt - Date.now()) / 1000);
    return { state };
}

let matchLeave: nkruntime.MatchLeaveFunction<MatchState> = function (ctx: nkruntime.Context, logger: nkruntime.Logger, nk: nkruntime.Nakama, dispatcher: nkruntime.MatchDispatcher, tick: number, state: MatchState, presences: nkruntime.Presence[]) {

    if (state.currentPhase === MatchPhase.WaitingForPlayers) {
        for (let presence of presences) {
            delete state.players[presence.userId];
        }
    }

    state.presences = state.presences.filter(p =>
        !presences.some(pp => pp.userId === p.userId)
    )

    const leftPalyers = presences.map(p => p.userId);

    dispatcher.broadcastMessage(MatchOpCode.MatchPlayersLeft, JSON.stringify(leftPalyers));

    return { state };
}

let matchTerminate: nkruntime.MatchTerminateFunction<MatchState> = function (ctx: nkruntime.Context, logger: nkruntime.Logger, nk: nkruntime.Nakama, dispatcher: nkruntime.MatchDispatcher, tick: number, state: MatchState, graceSeconds: number) {
    if (ctx.matchId) {
        removeWaitingMatch(nk, ctx.matchId);
    }
    return { state };
}

let getPlayerRandomPosition = function (state: MatchState): { x: number, y: number } {
    const spawnOnPipeIndex = Math.floor(Math.random() * (state.pipesNormalizedYPositions.length - 1));
    const randomX = (spawnOnPipeIndex + 1) * state.pipesDistance;
    const randomY = state.pipesNormalizedYPositions[spawnOnPipeIndex] * state.pipesYRange;
    return { x: randomX, y: randomY };
}

let handlePlayerStarted = function (state: MatchState, userId: string): MatchMicroDiff {
    state.players[userId].playingState = PlayingState.Playing;
    state.players[userId].velocityX = state.playersInitialXSpeed;
    return {
        diffCode: MatchDiffCode.PlayerStarted,
        userId: userId,
        velocityX: state.playersInitialXSpeed,
        playingState: PlayingState.Playing,
    }
}

let moveAlivePlayers = function (state: MatchState): MatchMicroDiff[] {
    const diffs: MatchMicroDiff[] = [];
    for (let userId in state.players) {
        const player = state.players[userId];
        if (player.playingState !== PlayingState.Playing) {
            continue;
        }
        const dt = 1000 / state.playingTickRate / 1000;
        player.velocityY += state.gravityY * dt;
        player.y += player.velocityY * dt;
        player.x += player.velocityX * dt;

        const worldWidth = state.pipesDistance * state.pipesNormalizedYPositions.length;
        if (player.x > worldWidth) {
            player.x = player.x - worldWidth;
        }

        diffs.push({
            diffCode: MatchDiffCode.PlayerMoved,
            userId: userId,
            x: player.x,
            y: player.y,
            velocityX: player.velocityX,
            velocityY: player.velocityY,
        });
    }
    return diffs;
}

function handlePlayerJumped(state: MatchState, userId: string): MatchMicroDiff {
    state.players[userId].velocityY = state.players[userId].jumpForce;
    return {
        diffCode: MatchDiffCode.PlayerJumped,
        userId: userId,
        velocityY: state.players[userId].jumpForce,
    }
}

function handlePlayerScored(state: MatchState, userId: string): MatchMicroDiff {
    state.players[userId].score++;
    return {
        diffCode: MatchDiffCode.PlayerScored,
        userId: userId,
        score: state.players[userId].score,
    }
}

function handlePlayerDied(state: MatchState, userId: string): MatchMicroDiff {
    state.players[userId].diedCount++;
    state.players[userId].playingState = PlayingState.Died;
    state.players[userId].spawnsAgainIn = state.playerSpawnsAgainAfter;
    const newPosition = getPlayerRandomPosition(state);
    const diedAtX = state.players[userId].x;
    const diedAtY = state.players[userId].y;
    state.players[userId].x = newPosition.x;
    state.players[userId].y = newPosition.y;
    return {
        diffCode: MatchDiffCode.PlayerDied,
        userId: userId,
        x: diedAtX,
        y: diedAtY,
        spawnsAgainIn: state.players[userId].spawnsAgainIn,
        newX: state.players[userId].x,
        newY: state.players[userId].y,
        diedCount: state.players[userId].diedCount,
    }
}

let spawnOrDecreaseDieTimer = function (state: MatchState): MatchMicroDiff[] {
    const diffs: MatchMicroDiff[] = [];
    for (let userId in state.players) {
        const player = state.players[userId];
        if (player.playingState !== PlayingState.Died) {
            continue;
        }
        const dt = 1000 / state.playingTickRate / 1000; // 0.025

        player.spawnsAgainIn -= dt * 1000; // 25ms
        if (player.spawnsAgainIn <= 0) {
            player.playingState = PlayingState.Idle;
            player.velocityX = 0;
            player.velocityY = 0;
            diffs.push({
                diffCode: MatchDiffCode.PlayerSpawned,
                userId: userId,
                x: player.x,
                y: player.y,
            });
        } else {
            diffs.push({
                diffCode: MatchDiffCode.PlayerSpawnTimeDecreased,
                userId: userId,
                spawnsAgainIn: player.spawnsAgainIn,
            });
        }
    }
    return diffs;
}