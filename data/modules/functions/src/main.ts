let InitModule: nkruntime.InitModule = function (
    ctx: nkruntime.Context,
    logger: nkruntime.Logger,
    nk: nkruntime.Nakama,
    initializer: nkruntime.Initializer,
) {
    initializeMatchStorageHelper(initializer, logger);
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
    getOrCreateWaitingMatch(nk);
    initializer.registerRpc("get_waiting_match", getWaitingMatchRpc);
    initializer.registerRpc("get_match_result", getMatchResultRpc);
    initializer.registerRpc("get_last_match_overview", getLastMatchOverview);
    initializer.registerRpc("get_config", getConfig);
    initializer.registerRpc("can_manage_bots", canManageBotsRpc);
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

// RPC function to return the match that new players should join
let getWaitingMatchRpc: nkruntime.RpcFunction = function (
    ctx: nkruntime.Context,
    logger: nkruntime.Logger,
    nk: nkruntime.Nakama,
    payload: string
): string {
    return getOrCreateWaitingMatch(nk);
}

function parseRpcPayload(payload: string): { [key: string]: any } {
    let parsed: any = JSON.parse(payload || "{}");
    // The web client wraps the payload in an extra JSON string.
    if (typeof parsed === "string") {
        parsed = JSON.parse(parsed);
    }
    return parsed || {};
}

// RPC function to return a match result
let getMatchResultRpc: nkruntime.RpcFunction = function (
    ctx: nkruntime.Context,
    logger: nkruntime.Logger,
    nk: nkruntime.Nakama,
    payload: string
): string {
    const matchId = String(parseRpcPayload(payload)["matchId"] || "");
    if (!matchId) {
        throw new Error("matchId is required");
    }
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
        id: matchId,
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

// RPC function to return the server configuration
let getConfig: nkruntime.RpcFunction = function (
    ctx: nkruntime.Context,
    logger: nkruntime.Logger,
    nk: nkruntime.Nakama,
    payload: string
): string {
    return JSON.stringify({
        minimumAppVersion: parseInt("00002"),
    });
}

// RPC function to return a match result
let getLastMatchOverview: nkruntime.RpcFunction = function (
    ctx: nkruntime.Context,
    logger: nkruntime.Logger,
    nk: nkruntime.Nakama,
    payload: string
): string {
    const lastMatchId = getLastMatchId(nk);
    const matchResult = getMatchResult(nk, lastMatchId);
    if (!matchResult) {
        throw new Error(`No match result found`);
    }

    const top3Scores = matchResult.scores.sort((a, b) => b.score - a.score).slice(0, 3);

    const users = nk.usersGetId(top3Scores.map(score => score.playerId));

    const usersMap: { [key: string]: nkruntime.User } = {};
    users.forEach(user => {
        usersMap[user.userId] = user;
    });
    const resultResponse: MatchOverviewResponse = {
        id: lastMatchId,
        initializedAt: matchResult.initializedAt,
        startedAt: matchResult.startedAt,
        finishedAt: matchResult.finishedAt,
        scores: top3Scores.map(score => {
            return {
                score: score.score,
                user: usersMap[score.playerId],
            };
        }),
    };

    return JSON.stringify(resultResponse);
}