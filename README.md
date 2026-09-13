# Agent Runtime Dashboard

Local macOS-first dashboard for discovering developer projects, their running
processes, listening ports, and optional start/open actions.

## Run

```bash
npm install
npm run dev
```

Open <http://127.0.0.1:5173>.

The API runs on `127.0.0.1:4317`. Production-style serving is available with:

```bash
npm run build
npm start
```

## Project discovery

The default Agent working root is the current user's home directory (`~`). The
project list comes from read-only Agent CLI inventory sessions, while every
visible LISTEN socket is checked locally against the returned project paths. A stopped project keeps known ports;
missing paths and listening ports without readable project ownership are shown
separately instead of being silently discarded. Add extra roots or explicit
projects in `config/settings.json` when a project lives outside the home
directory. A project's `package.json` `dev`, `start`, or `serve` script is shown
as a start candidate. The Start button only runs a command belonging to the
discovered project and never accepts a raw command from the browser.

## Agent CLI

On startup the dashboard starts one read-only inventory session for every
available `codex`, `claude`, or `opencode` CLI. Each session returns structured
project paths, observed ports, and evidence; the dashboard normalizes paths and
merges duplicate reports. The local process/socket scan only verifies current
runtime ownership and exposes sockets that no Agent could safely attribute.
