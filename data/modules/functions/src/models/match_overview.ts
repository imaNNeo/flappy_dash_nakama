interface MatchOverview {
    initializedAt: number;
    startedAt: number;
    finishedAt: number;
    top3Scores: {
        playerId: string;
        score: number;
    }[];
}