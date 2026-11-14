# Match handler bot checks

Headless clients that join the waiting match and check the things that used to break it:
pings from a player who just left, malformed messages, reconnecting with a new socket,
rejoining a running match, and parallel `get_waiting_match` calls.

```sh
npm install
npm test                                  # against a local server on 127.0.0.1:7350
HOST=api.flappydash.com PORT=7350 SSL=true SERVER_KEY=... npm test   # against production
```

Scenarios can be run one at a time: `node scenarios.mjs concurrency|ping-after-leave|reconnect`.
The `reconnect` scenario waits for a match to start, so it takes ~30 seconds.
Running against production creates a few bot accounts (`c0_<pid>`, `pa_<pid>`, ...).

## Netcode check

`netcode.mjs` plays a whole match with bots that speak the server-authoritative protocol
like the app does (local prediction at 60 ticks/s, input commands, snapshots). Half of them
get 60-90 ms of simulated latency. Every time a snapshot reports the server's state of a
bot's dash, the bot compares it with what it predicted for that tick:

```sh
node netcode.mjs 6 200   # 6 bots, until the match ends
```

`netbot.mjs` is the shared bot (it loads the server's own compiled physics).

## Load benchmark

`load.mjs` puts N netcode bots in one match and prints what each player receives and sends,
ping under load and, with `NAKAMA_PID` set, the Nakama process's CPU use:

```sh
NAKAMA_PID=$(pgrep -f "nakama --name") node load.mjs 20 30   # 20 bots, 30 seconds of play
```
