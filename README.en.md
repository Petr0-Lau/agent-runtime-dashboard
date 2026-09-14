# Agent Runtime Dashboard

A local macOS-first developer tool that asks available Agent CLIs to report their own projects and ports, then deduplicates the results by normalized filesystem path and verifies running projects with local runtime evidence.

[中文 README](README.md)

## Features

- Starts one read-only discovery session for every callable Agent CLI.
- Shows reported project paths, runtime status, known ports, and port URLs.
- Cross-checks running projects with process cwd, parent processes, and LISTEN sockets.
- Keeps listening ports that cannot be safely attributed to a project in a separate list.
- Offers start actions for a project's own `dev`, `start`, or `serve` script.
- Opens known local web URLs without accepting arbitrary shell commands from the browser.

## How it works

Agent CLI sessions are the authority for project discovery; the dashboard does not recursively scan the disk:

1. The dashboard checks whether supported CLIs are executable in the current `PATH`.
2. Each available CLI receives a read-only prompt and returns structured JSON from its own project/session index and runtime evidence.
3. The dashboard merges duplicate projects and ports by normalized absolute path.
4. Local inspection only verifies current LISTEN sockets and process cwd; it does not guess that arbitrary directories are projects.

The built-in adapters currently cover `codex`, `claude`, and `opencode`. Only CLIs that are installed, executable, and visible under the current permissions can be called; there is no universal protocol for querying every unknown Agent. Projects hidden from the CLI, unavailable due to permissions, or absent from the Agent's own index cannot honestly be claimed as discovered.

## Run

```bash
npm install
npm run dev
```

Open <http://127.0.0.1:5173>.

The API runs at `127.0.0.1:4317`. Production-style serving is also available:

```bash
npm run build
npm start
```

## macOS App

Build a double-clickable local `.app` without manually starting terminal services:

```bash
npm run app:macos
open "release/Agent Runtime Dashboard.app"
```

The app starts its bundled Node service, displays the dashboard in a `WKWebView`, and cleans up the service when it exits. It still uses one dynamic loopback port bound to `127.0.0.1`, but the user does not need to find or start that port manually. The build contains a Node runtime for the current machine architecture and is an unsigned, not notarized local-development build.

## Configuration

Add explicit projects in `config/settings.json` when needed:

```json
{
  "scanRoots": ["~"],
  "preferredAgent": "auto",
  "projects": []
}
```

`scanRoots` is only used as the Agent working-root hint and for display; it does not trigger a local recursive project scan. Use `projects` to supplement projects that an Agent cannot report but that you explicitly know about.

## Checks

```bash
npm run build
npm run check
```

## License

This repository currently has no declared license.
