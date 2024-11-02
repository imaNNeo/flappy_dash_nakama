interface MatchResultResponse {
    initializedAt: number;
    startedAt: number;
    finishedAt: number;
    scores: {
        score: number;
        user: nkruntime.User;
    }[];
}
