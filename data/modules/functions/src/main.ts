let InitModule: nkruntime.InitModule = function (
    ctx: nkruntime.Context,
    logger: nkruntime.Logger,
    nk: nkruntime.Nakama,
    initializer: nkruntime.Initializer,
) {
    initializer.registerMatch(multiDashHandlerName, {
        matchInit,
        matchJoinAttempt,
        matchJoin,
        matchLeave,
        matchLoop,
        matchTerminate,
        matchSignal,
    });

    createMainLeaderboard(ctx, logger, nk);
    createMainMatch(ctx, logger, nk, initializer);
    initializer.registerRpc("get_waiting_match", getWaitingMatchRpc);
    initializer.registerRpc("get_match_result", getMatchResultRpc);
}

function createMainLeaderboard(
    ctx: nkruntime.Context,
    logger: nkruntime.Logger,
    nk: nkruntime.Nakama,
) {
    let leaderboardId = "main_leaderboard";
    let authoritative = false;
    let sortOrder = nkruntime.SortOrder.DESCENDING;
    let operator = nkruntime.Operator.BEST;
    let resetSchedule = null;
    let metadata: {} = {};

    try {
        // Create or get the leaderboard
        nk.leaderboardCreate(leaderboardId, authoritative, sortOrder, operator, resetSchedule, metadata);
        logger.info("Leaderboard created or already exists: %s", leaderboardId);
    } catch (error) {
        logger.error("Error creating leaderboard: %v", error);
    }
}

function getActiveWaitingMatches(nk: nkruntime.Nakama): string[] {
    const matches = getWaitingMatches(nk);
    for (let i = 0; i < matches.length; i++) {
        const matchId = matches[i];
        const match = nk.matchGet(matchId);
        if (!match) {
            removeWaitingMatch(nk, matchId);
        }
    }
    return getWaitingMatches(nk);
}

function createMainMatch(
    ctx: nkruntime.Context,
    logger: nkruntime.Logger,
    nk: nkruntime.Nakama,
    initializer: nkruntime.Initializer,
) {
    const matches = getActiveWaitingMatches(nk);
    if (matches.length <= 0) {
        nk.matchCreate(multiDashHandlerName, {});
    }
}

// RPC function to return a waiting match
let getWaitingMatchRpc: nkruntime.RpcFunction = function (
    ctx: nkruntime.Context,
    logger: nkruntime.Logger,
    nk: nkruntime.Nakama,
    payload: string
): string {
    let matches = getActiveWaitingMatches(nk);

    if (matches.length > 0) {
        return matches[0];
    } else {
        return '';
    }
}

// RPC function to return a match result
let getMatchResultRpc: nkruntime.RpcFunction = function (
    ctx: nkruntime.Context,
    logger: nkruntime.Logger,
    nk: nkruntime.Nakama,
    payload: string
): string {
    const payloadJson = JSON.parse(payload);
    const matchId = payloadJson["matchId"].toString();
    const matchResult = getMatchResult(nk, matchId);
    if (!matchResult) {
        throw new Error(`No match result found for matchId: ${matchId}`);
    }
    const users = nk.usersGetId(matchResult.scores.map(score => score.playerId));

    const usersMap: { [key: string]: nkruntime.User } = {};
    users.forEach(user => {
        usersMap[user.userId] = user;
    });
    const resultResponse: MatchResultResponse = {
        initializedAt: matchResult.initializedAt,
        startedAt: matchResult.startedAt,
        finishedAt: matchResult.finishedAt,
        scores: matchResult.scores.map(score => {
            return {
                score: score.score,
                user: usersMap[score.playerId],
            };
        }),
    };

    return JSON.stringify(resultResponse);
}
