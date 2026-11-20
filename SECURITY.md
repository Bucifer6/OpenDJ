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
- The desktop app's local server only listens on `127.0.0.1` and rejects cross-site requests.
- Media-server tokens, streaming keys and passwords are stored in the app's data folder on
  your machine. Protect that folder like any other credentials file.

## Verifying downloads

Each release includes `SHA256SUMS.txt`. Check a download before running it:

```bash
sha256sum -c SHA256SUMS.txt --ignore-missing
```

On Windows (PowerShell): `Get-FileHash .\OpenDJ-Setup-<version>-x64.exe` and compare with the file.
