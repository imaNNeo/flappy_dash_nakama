# About

This is the back-end code using [Nakam](https://heroiclabs.com/nakama/) for the [FlappyDash](https://github.com/imaNNeo/flappy_dash) project. You can play it live her: [play.flappydash.com](https://play.flappydash.com)

## Running it

```sh
cp .env.template .env   # then fill in real values
make runLocally         # builds the TypeScript module and starts Postgres + Nakama
```

`make deployFromMain` pulls `main`, rebuilds the module, pulls the images and restarts Nakama (used on the Raspberry Pi).

The Nakama image is the official multi-arch `heroiclabs/nakama`, so the same compose file works on amd64 and on the Pi (arm64).

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
