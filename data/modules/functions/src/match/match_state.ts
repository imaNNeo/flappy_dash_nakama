interface MatchState {
    playingTickNumber: number;
    pipesDistance: number;
    pipesNormalizedYPositions: number[];
    pipesHoleGap: number;
    pipesYRange: number;
    matchInitializedAt: number;
    matchRunsAt: number;
    matchFinishesAt: number;
    currentPhase: MatchPhase;
    presences: nkruntime.Presence[];
    gravityY: number;
    players: { [key: string]: PlayerInfo };
    matchIsEmptySince?: number;
    matchFinishTextSent: boolean;
}

interface PlayerInfo {
    isInLobby: boolean;
    x: number;
    y: number;
    velocityX: number;
    velocityY: number;
    score: number;
    diedCount: number;
    playingState: PlayingState;
    displayName: string;
    userId: string;
    spawnsAgainAt: number;
    lastPing: number;
}

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
