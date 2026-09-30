# Security policy

The Termdeck agent runs as your user, reads your transcript roots and spawns your
coding-agent CLIs. That is a lot of trust, which is why the agent source is in this
repository rather than shipped as an opaque binary.

## Reporting a vulnerability

Email **hello@termdeck.io** with `[termdeck-security]` in the subject. Please include
what you found, how to reproduce it, and the agent version (`~/.termdeck/agent/package.json`).

Do not open a public issue for a vulnerability.

You will get an acknowledgement within 48 hours and a fix or a plan within 7 days.
Agents self-update, so a shipped fix reaches connected machines without you doing
anything.

## Scope

In scope:

- The agent's capability surface (`agent/capabilities.js`): any read outside the
  transcript roots and the open chat's project folder, or any write beyond the named ones.
- Turn execution on the machine (`agent/engine-runs.js`).
- The install and heal scripts.
- The self-update path: staging, compile check, rollback, quarantine.
- Token handling and log redaction (`agent/log.js`).

Out of scope:

- The hosted control plane at termdeck.io (report those the same way, they are just
  not in this repo).
- Anything requiring an attacker to already have local shell as your user.
