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

Edit `config/settings.json` to add scan roots or explicit project entries. A
project's `package.json` `dev`, `start`, or `serve` script is shown as a start
candidate. The Start button only runs a command belonging to the discovered
project and never accepts a raw command from the browser.

## Agent CLI

The Agent CLI button prefers `agenthud follow --json --once` when installed,
then uses the installed `codex` CLI with a read-only, ephemeral invocation. The
dashboard itself does not require an Agent CLI to scan processes and ports.

