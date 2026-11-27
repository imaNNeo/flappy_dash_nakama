# About

This is the back-end code using [Nakam](https://heroiclabs.com/nakama/) for the [FlappyDash](https://github.com/imaNNeo/flappy_dash) project. You can play it live her: [play.flappydash.com](https://play.flappydash.com)

## Where it runs (since 2026-11-27)

Flappy Dash runs on the one Nakama server every multiplayer game on games.imanneo.dev shares
(imaNNeo/games, [`nakama/`](https://github.com/imaNNeo/games/tree/main/nakama), whose README explains
how games plug in). `api.flappydash.com` points there, with the same server key and the same names
(match `multiDashMatchHandler`, the five RPCs, `main_leaderboard`), so the store apps keep working.
Every push to `main` that changes `data/modules/functions` is built into `build/module.js`
(`npx tsc && node scripts/make-module.mjs`) and copied there by
`.github/workflows/server-to-portal.yml` (secret `PORTAL_DEPLOY_KEY`); nothing to deploy by hand.
`src/game.ts` lists what the shared server registers. Server settings there start with `FLAPPY_DASH_`
(`FLAPPY_DASH_IS_PRODUCTION`, ...); this repo's own compose still passes the plain names.

## Running it on its own (local development)

```sh
cp .env.template .env   # then fill in real values
make runLocally         # builds the TypeScript module and starts Postgres + Nakama
```

`make deployFromMain` pulls `main`, rebuilds the module, pulls the images and restarts Nakama (used on the Raspberry Pi).

The Nakama image is the official multi-arch `heroiclabs/nakama`, so the same compose file works on amd64 and on the Pi (arm64).

### Server-authoritative netcode

The match handler runs the game: clients only send their jumps (input commands), the
server simulates every dash at 60 ticks/s and sends 20 binary snapshots per second, and the
clients predict their own dash and interpolate the others (Valve's Source networking model).
The shared physics lives in `data/modules/functions/src/netcode/`; the client has an exact
Dart twin. See [docs/netcode.md](https://github.com/imaNNeo/flappy_dash/blob/main/docs/netcode.md)
in the client repo for the full picture.

`tests/physics/golden.mjs --check` verifies the server physics against
`tests/physics/physics_golden.json`, the same file the client's parity test uses.

### Checking the match handler

`tests/bots` has headless clients that reproduce the problems that used to kill lobbies
(pings from a player who just left, malformed messages, reconnecting players). See its README.

### Postgres

Postgres stays on the 12.x line so the existing data directory keeps working. To move to a newer
major version, dump and restore into a new data directory:

```sh
docker compose exec postgres pg_dumpall -U postgres > backup.sql
docker compose down
# change the image to e.g. postgres:17-alpine and the volume to a new, empty directory
docker compose up -d postgres
docker compose exec -T postgres psql -U postgres < backup.sql
docker compose up -d
```
