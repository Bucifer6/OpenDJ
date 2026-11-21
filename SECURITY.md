# Security policy

## Supported versions

Security fixes go into the latest release only. Please update to the newest version from the
[Releases page](https://github.com/Bucifer6/OpenDJ/releases) before reporting.

## Reporting a vulnerability

**Please do not open a public issue for security problems.**

Report privately through GitHub: go to the repository's **Security** tab →
**Report a vulnerability**. Include:

- what is affected (desktop app, hosted web app / Docker image, or both) and the version
- steps to reproduce, or a proof of concept
- the impact you expect (for example: file read outside the music folders, login bypass in hosted mode)

You should get a first reply within 7 days. Once a fix is released the advisory is published,
and you are credited unless you ask not to be.

## Scope notes

- **Hosted mode** (the Docker image, or `npm run web` with `HOST=0.0.0.0`) is meant to sit behind
  HTTPS on a network you trust. Set a strong `OPENDJ_PASSWORD`, and limit `OPENDJ_MUSIC_ROOTS`
  to your music folders.
- The desktop app's local server only listens on `127.0.0.1`, rejects cross-site requests, and only answers
  the app window that started it (a random per-launch token in an HttpOnly cookie). `npm run web` on
  `127.0.0.1` has no token: anyone who can open connections on that computer can use it.
- Media-server tokens, streaming keys and passwords are stored in the app's data folder on
  your machine (files readable by your user only, `0600`). Protect that folder like any other credentials file.
- Media sources (Plex, Jellyfin, Subsonic…) and lighting outputs (Art-Net, WLED, Hue) connect to whatever
  address you enter, LAN and local addresses included, because that is what they are for.

- **Update checks** (Settings → About, on by default) contact `api.github.com` only: a GET of the latest
  release with the User-Agent `OpenDJ/<version>`, no cookies and no user data, a timeout and a 1 MB response cap.
  On the desktop and web app the OpenDJ server makes the request (the page keeps `connect-src 'self'` for it);
  in hosted mode only signed-in users can trigger it. Release notes are rendered as a small Markdown subset built
  from DOM nodes (no HTML, `http(s)` links only). The desktop app's *Update now* runs entirely in the main process:
  it only downloads `https://github.com/Bucifer6/OpenDJ/releases/download/...` files with allow-listed names
  (redirects only to GitHub's release storage hosts), verifies each against the release's `SHA256SUMS.txt`
  (a missing entry or mismatch is refused), re-checks the hash before starting an installer, and only after the
  user clicks *Restart to update*. The builds are not code-signed, so the checksum list on the release is the trust anchor.

- **Remote control for AI assistants (MCP)** is **off by default** (Settings → Remote control). Turning it on
  creates one random per-install token (256 bit, `odj_mcp_…`), shown once and stored only as a SHA-256 hash
  (`mcp-token.json`, `0600`); a new token disconnects every client. Permissions: *read* (status, library search),
  *playback* (decks, automix, crossfader, sampler, dedications), *broadcast* (start / stop configured targets by id).
  The desktop app and `npm run web` serve it on a separate listener bound to `127.0.0.1` (default port 47800); binding
  it to all networks is an explicit choice behind a warning, and then the token is the only protection. Hosted mode
  has no separate listener: `POST /api/mcp/rpc` on the main server needs the login session **and** the token. The
  endpoint refuses browser `Origin`s, checks `Host` on loopback (DNS rebinding), limits bodies to 64 KB, rate-limits
  requests (120/min), control actions (30/min) and failed tokens (10/min), validates every tool input against a
  closed schema, and keeps an audit log (Settings → Remote control, and `mcp-audit.log`; tokens are never logged).
  Tools return metadata only: no file paths, source URLs, settings or credentials; broadcast targets are used by id
  and their passwords / stream keys never leave the server. The settings, scopes and token can only be changed
  through OpenDJ's own UI (the normal API checks: Origin, Host, launch token or login).
- **Speech (MC voice, dedications)**: the server renders text with the operating system's speech engine (SAPI via
  PowerShell, macOS `say`, `espeak-ng`). The text goes through stdin only, never a command line or shell; at most
  500 characters, one at a time, 30 per minute, time and size limits.
- **Local AI planning (desktop)** talks only to Ollama on `127.0.0.1:11434` (IPC accepted from the app window only).
  The model's answer is treated as untrusted data: size-capped, reduced to a track order and a plain-text sentence.
- The desktop app keeps its local server port between launches (`server-port.json`) so the page's browser storage
  survives restarts; the per-launch token still guards every request.

## Verifying downloads

Each release includes `SHA256SUMS.txt`. Check a download before running it:

```bash
sha256sum -c SHA256SUMS.txt --ignore-missing
```

On Windows (PowerShell): `Get-FileHash .\OpenDJ-Setup-<version>-x64.exe` and compare with the file.
