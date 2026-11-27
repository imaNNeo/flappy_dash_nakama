// What the shared Nakama server registers for Flappy Dash (scripts/make-module.mjs exports it from
// build/module.js). Last in tsconfig.json's files: everything it names is defined by then.
const FLAPPY_DASH_GAME = {
    id: "flappy_dash",
    matches: {
        [multiDashHandlerName]: { matchInit, matchJoinAttempt, matchJoin, matchLeave, matchLoop, matchTerminate, matchSignal },
    },
    rpcs: {
        get_waiting_match: getWaitingMatchRpc,
        get_match_result: getMatchResultRpc,
        get_last_match_overview: getLastMatchOverview,
        get_config: getConfig,
        can_manage_bots: canManageBotsRpc,
    },
    setup: flappyDashSetup,
};

