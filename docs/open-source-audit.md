# Open-source audit

Last reviewed: 2026-09-13

This repository starts with the following planned dependency and reuse boundary.
No upstream source files are copied into this repository.

| Project | Source | License | Use | Attribution / condition |
| --- | --- | --- | --- | --- |
| AgentHUD | https://github.com/neochoon/agenthud | MIT declared in README and package.json; the checked GitHub checkout did not contain a LICENSE file | Design reference only | Confirm the distributed license before shipping if added |
| AgentMonitor | https://github.com/jiweiyeah/AgentMonitor | MIT | Design reference only | No source copied |
| yunhaoli24/codex-gateway | https://github.com/yunhaoli24/codex-gateway | MIT | Design reference only | No source copied |
| AgentMeter | https://github.com/LyleMi/AgentMeter | Apache-2.0 | Design reference only | No source copied |
| systeminformation | https://github.com/sebhildebrandt/systeminformation | MIT | Process, resource and listening-port collection | Retain the dependency license notice in any distribution |
| proc | https://github.com/yazeed/proc | MIT | CLI interaction reference only | No source copied |

## Current decision

The current implementation asks each available supported Agent CLI to return a
read-only structured inventory. `systeminformation` is retained only to verify
current listening sockets and process cwd/parent ownership. No upstream source
files are copied into the repository.
