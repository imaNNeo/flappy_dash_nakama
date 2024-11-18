// MatchDiffCode Enum
enum MatchDiffCode {
  PlayerSpawned = 1,
  PlayerStarted = 2,
  PlayerJumped = 3,
  PlayerMoved = 4,
  PlayerDied = 5,
  PlayerScored = 6,
  PlayerSpawnTimeDecreased = 7,
}

type MatchMicroDiff =
  | {
    readonly diffCode: MatchDiffCode.PlayerSpawned;
    userId: string;
    x: number;
    y: number;
  }
  | {
    readonly diffCode: MatchDiffCode.PlayerStarted;
    userId: string;
    playingState: PlayingState;
    velocityX: number;
  }
  | {
    readonly diffCode: MatchDiffCode.PlayerJumped;
    userId: string;
    velocityY: number;
  }
  | {
    readonly diffCode: MatchDiffCode.PlayerMoved;
    userId: string;
    x: number;
    y: number;
    velocityX: number;
    velocityY: number;
  }
  | {
    readonly diffCode: MatchDiffCode.PlayerDied;
    userId: string;
    x: number;
    y: number;
    spawnAt: number;
    newX: number;
    newY: number;
    diedCount: number;
  }
  | {
    readonly diffCode: MatchDiffCode.PlayerScored;
    userId: string;
    score: number;
  }
  | {
    readonly diffCode: MatchDiffCode.PlayerSpawnTimeDecreased;
    userId: string;
    spawnsAgainIn: number;
  };

// MatchDiff Container
interface MatchDiff {
  tickNumber: number;
  diffInfo: MatchMicroDiff[];
}