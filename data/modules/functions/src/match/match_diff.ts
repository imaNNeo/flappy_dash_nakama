// MatchDiffCode Enum
enum MatchDiffCode {
    PlayerSpawned = 1,
    PlayerStarted = 2,
    PlayerMoved = 3,
    PlayerDied = 4,
    PlayerScored = 5,
    asdf = 6,
  }
  
  // MatchMicroDiff: Discriminated Union
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
      }
    | {
        readonly diffCode: MatchDiffCode.PlayerScored;
        userId: string;
        velocityY: number;
      };
  
  // MatchDiff Container
  interface MatchDiff {
    tickNumber: number;
    diffInfo: MatchMicroDiff[];
  }