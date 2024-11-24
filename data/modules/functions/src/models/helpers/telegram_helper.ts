function sendTelegramMessage(
    nk: nkruntime.Nakama, 
    logger: nkruntime.Logger, 
    ctx: nkruntime.Context, 
    message: string,
) {
    const TELEGRAM_TOKEN = ctx.env.TELEGRAM_BOT_API_KEY || '';
    const TELEGRAM_CHAT_ID = ctx.env.TELEGRAM_CHANNEL_ID || '';

    if (ctx.env.IS_PRODUCTION != "true") {
        return;
    }

    if (!TELEGRAM_TOKEN || !TELEGRAM_CHAT_ID) {
        return;
    }

    const url = `https://api.telegram.org/bot${TELEGRAM_TOKEN}/sendMessage`;

    const payload = {
        chat_id: TELEGRAM_CHAT_ID,
        text: message,
    };
    const body = JSON.stringify(payload);

    logger.info(`Sending message to Telegram: ${message}, body: ${body}`);
    const response = nk.httpRequest(
        url,
        "post",
        {
            "Content-Type": "application/json",
        },
        body,
    );
    logger.info(`Telegram response: ${response.code}, ${response.body}`);
}

function formatMatchResultMessage(ctx: nkruntime.Context, state: State): string {
    const matchId = ctx.matchId || "Unknown";
    const matchFinishTime = new Date(state.matchFinishesAt).toLocaleString();
    const matchDuration = state.matchFinishesAt - state.matchRunsAt;
    const formattedDuration = `${Math.floor(matchDuration / 60000)} minutes and ${(matchDuration % 60000) / 1000} seconds`;
    const playersCount = Object.keys(state.players).length;

    const sortedPlayers = Object.keys(state.players)
        .map(key => state.players[key])
        .sort((a, b) => b.score - a.score)
        .map((player, index) => `${index + 1} – ${player.displayName} (${player.score})`)
        .join("\n");

    return `
🏆 Match Results

Match ID: ${matchId}
Match Finish Time: ${matchFinishTime}
Match Duration: ${formattedDuration}
Players Count: ${playersCount}

Player Rankings:
${sortedPlayers}
`;
}

function formatPlayerJoinedMessage(ctx: nkruntime.Context, state: State, playerId: string): string {
    const BASE_URL = ctx.env.APP_BASE_URL || '';
    const matchId = ctx.matchId || "Unknown";
    const lobbyUrl = `${BASE_URL}/#/lobby/${matchId}`;

    const player = state.players[playerId];
    return `
👤 ${player.displayName} joined the match!
all in lobby players (isInLobby: true):
${Object.keys(state.players)
        .map(key => state.players[key])
        .filter(player => player.isInLobby)
        .map(player => player.displayName)
        .join("\n")}

Click to join:
${lobbyUrl}
`;
}