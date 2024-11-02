interface MatchResult {
    initializedAt: number;
    startedAt: number;
    finishedAt: number;
    scores: {
        playerId: string;
        score: number;
    }[];
}