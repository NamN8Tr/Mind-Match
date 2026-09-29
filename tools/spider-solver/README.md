# Smart Rot Spider board worker

This dependency-free C++17 executable is an independently written, bounded
Spider search worker. It accepts a mode, seed, wall-clock budget, state budget,
and frontier budget, then prints exactly one JSON result to stdout.

It never declares a timed-out deal unsolvable. Only results with `status` equal
to `solved` contain a board and replayable winning witness.

Build with `./build.sh`, then run:

```sh
./bin/spider-solver --mode 4 --seed 123 --timeout-ms 30000 --max-states 1000000
```

The server runs this executable outside the request/game-room path. Any result
is independently replayed by the authoritative TypeScript engine before it can
enter the ready-board pool.

See [NOTICE.md](./NOTICE.md) for implementation provenance and the projects
evaluated during design.
