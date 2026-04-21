# Changelog

## 1.0.0 (2026-04-21)


### Features

* add bootstrap script, seed memory from 195 recent sessions ([6cc4341](https://github.com/samfoy/pi-memory/commit/6cc43412ee9f674bdd01b154fe26f04bb1dfd9d3))
* consolidate memory on session switch, improve extraction quality ([849ca3c](https://github.com/samfoy/pi-memory/commit/849ca3ced01f3ae16d4a491440c72730335e7089))
* FTS5 search, consolidation context, flexible key validation, last_accessed tracking ([3c7ee5b](https://github.com/samfoy/pi-memory/commit/3c7ee5b13747ed8e5c7e2b3ba33c2bb561327e22))
* initial pi-memory extension — persistent memory with consolidation ([37ef7b9](https://github.com/samfoy/pi-memory/commit/37ef7b91cdde3c55c75ae5116d97ad60232484a1))
* migrate from better-sqlite3 to node:sqlite (Node 24+) ([3ecbaba](https://github.com/samfoy/pi-memory/commit/3ecbaba2cc9f4c87589e79b98cdc4a016c41783d))
* selective injection — search memory by user prompt instead of dumping all entries ([c3476cf](https://github.com/samfoy/pi-memory/commit/c3476cf02abbc78cdc052c0169a469e884f02faf))
* selective lesson injection with category-aware filtering ([e79fe97](https://github.com/samfoy/pi-memory/commit/e79fe9773bd73ddb73d97b93ade060f5ab49f361))
* show status immediately on session shutdown ([69964c5](https://github.com/samfoy/pi-memory/commit/69964c58f72c5771e258a0db1975da21ef24074d))


### Bug Fixes

* add SQLite busy_timeout to prevent lock contention ([e71206b](https://github.com/samfoy/pi-memory/commit/e71206b43b33dae2d2474d7e7fe626e6c99f9e43))
* gracefully degrade when node:sqlite lacks FTS5 support ([9861f2a](https://github.com/samfoy/pi-memory/commit/9861f2a4392fdb53b587e4edcc6cd32d473aa007)), closes [#3](https://github.com/samfoy/pi-memory/issues/3)
* prevent recursive extension loading, capture sessionId, cap message arrays, ctx after store init ([354bed9](https://github.com/samfoy/pi-memory/commit/354bed9aaee3154b6b72aff8dd7070c54981cdc4))
* race condition in store writes, cache bounds, key normalization ([a22e722](https://github.com/samfoy/pi-memory/commit/a22e722d03084d00310ea3dcdfbdfc1bb2720f71))
* support prefix matching in deleteLesson for truncated IDs ([861dc11](https://github.com/samfoy/pi-memory/commit/861dc110ed0795554f9590bb67d922aa697ad2cb))
