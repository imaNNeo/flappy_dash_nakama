// Binary messages of the hot path (sent many times a second). Their twin on
// the client is lib/domain/netcode/net_protocol.dart in the flappy_dash repo.
// Everything is little endian.

// Client -> server, opcode DashOpCode.PlayerInput.
// The client simulates at 60 ticks/s and numbers every tick. One packet says
// "In my life that started at tick `lifeStartSeq`, I simulated every tick up
// to `upToSeq`, and I jumped in these ticks". Jumps the server hasn't
// confirmed yet are repeated in every packet, and every packet carries the
// life, so the first packet of a life starts it (no separate start message).
//   u8  version (1)
//   u32 lifeStartSeq
//   u32 upToSeq
//   u8  jumpCount
//   u32 jumpSeq * jumpCount
const inputPacketVersion = 1;
const inputPacketHeaderSize = 10;

interface InputPacket {
    lifeStartSeq: number;
    upToSeq: number;
    jumpSeqs: number[];
}

function decodeInputPacket(data: ArrayBuffer): InputPacket | null {
    if (!data || data.byteLength < inputPacketHeaderSize) {
        return null;
    }
    const view = new DataView(data);
    if (view.getUint8(0) !== inputPacketVersion) {
        return null;
    }
    const lifeStartSeq = view.getUint32(1, true);
    const upToSeq = view.getUint32(5, true);
    const jumpCount = view.getUint8(9);
    if (data.byteLength < inputPacketHeaderSize + jumpCount * 4) {
        return null;
    }
    const jumpSeqs: number[] = [];
    for (let i = 0; i < jumpCount; i++) {
        jumpSeqs.push(view.getUint32(inputPacketHeaderSize + i * 4, true));
    }
    return { lifeStartSeq, upToSeq, jumpSeqs };
}

// Server -> clients, opcode DashOpCode.MatchSnapshot. Sent every match loop
// while the match runs.
//   u8  kind (0 = delta: only players that changed since the previous
//       snapshot, 1 = full: every player)
//   u32 serverTime (ms since the match was created)
//   u8  entryCount
//   entry * entryCount:
//     u8  rosterIndex (index into the match state's `roster`)
//     u8  playingState (0 idle, 1 playing, 2 died)
//     u16 score
//     u32 seq (the last input tick of this player the server simulated)
//     f32 x (unwrapped: distance since spawn point, see dash_physics.ts)
//     f32 y
//     f32 vy
//     u16 lastScoredPipe
const snapshotHeaderSize = 6;
const snapshotEntrySize = 22;

const enum SnapshotKind {
    Delta = 0,
    Full = 1,
}

interface SnapshotEntry {
    rosterIndex: number;
    playingState: number;
    score: number;
    seq: number;
    x: number;
    y: number;
    vy: number;
    lastScoredPipe: number;
}

function encodeSnapshot(kind: SnapshotKind, serverTime: number, entries: SnapshotEntry[]): ArrayBuffer {
    const buffer = new ArrayBuffer(snapshotHeaderSize + entries.length * snapshotEntrySize);
    const view = new DataView(buffer);
    view.setUint8(0, kind);
    view.setUint32(1, Math.max(0, Math.floor(serverTime)) >>> 0, true);
    view.setUint8(5, entries.length);
    let o = snapshotHeaderSize;
    for (const e of entries) {
        view.setUint8(o, e.rosterIndex);
        view.setUint8(o + 1, e.playingState);
        view.setUint16(o + 2, Math.min(e.score, 65535), true);
        view.setUint32(o + 4, e.seq >>> 0, true);
        view.setFloat32(o + 8, e.x, true);
        view.setFloat32(o + 12, e.y, true);
        view.setFloat32(o + 16, e.vy, true);
        view.setUint16(o + 20, Math.max(0, Math.min(e.lastScoredPipe, 65535)), true);
        o += snapshotEntrySize;
    }
    return buffer;
}
