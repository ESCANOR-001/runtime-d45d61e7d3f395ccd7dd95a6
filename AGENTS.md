# Server-only repository

- Keep Android source, native desktop installer projects, user profiles, credentials, and private Git history out of this repository.
- Preserve the existing NPM package identity. No separate application is built here.
- Keep all Windows background child processes hidden with `windowsHide: true` and PowerShell `-WindowStyle Hidden`.
- Run memory-intensive checks sequentially.
- GitHub Actions must use standard Windows and macOS runners only, read-only permissions, pinned actions, and no secrets or automatic publishing.
- Audit exports before pushing. A randomized public repository name is not a privacy boundary.
