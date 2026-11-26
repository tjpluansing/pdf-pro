# Releasing PDF Pro and automatic updates

Pushing a version tag such as `v0.2.0` builds the Windows and Mac installers,
publishes them as a GitHub release, and tells every installed copy of PDF Pro
that a new version is out. The app checks a few seconds after launch and twice
a day after that, shows a bar with **What's new**, **Install and restart** and
**Later**, and verifies each download against a key built into the app before
installing it.

## Where releases live, and why

Installed apps download updates without signing in, so the files have to be
public. Release files in a **private** repo can only be downloaded with a
token, and a token built into the app would let anyone read the source code.

So releases go to a separate **public repo that holds only releases**,
`tjpluansing/pdf-pro-releases`. The source repo can then go private without
breaking updates. GitHub Releases is free for public repos, has no bandwidth
charge, and allows files up to 2 GB (PDF Pro's installers are about 400 MB).

The download address is built into each installed app. **Set up the releases
repo before the first public release and keep it afterwards**: apps installed
from a release look there for updates for as long as they're installed. (If
you ever need to move, publish one last release in the old place whose app
points to the new one.)

If you'd rather not have a second repo, Cloudflare R2 or Amazon S3 could host
the same files; the workflow would need an upload step for them instead.

## One-time setup

All of this is in GitHub: repo **Settings → Secrets and variables → Actions**
(secrets on the *Secrets* tab, variables on the *Variables* tab).

### 1. Make the update signing key

On any computer with Node.js:

```bash
npx @tauri-apps/cli signer generate -w pdf-pro-updater.key
```

It asks for a password and writes two files: `pdf-pro-updater.key` (private)
and `pdf-pro-updater.key.pub` (public).

**Keep the private key and its password somewhere safe, such as a password
manager.** If they're lost, installed apps can't be updated any more; people
would have to download a new installer by hand.

| Kind | Name | Value |
| --- | --- | --- |
| Secret | `TAURI_SIGNING_PRIVATE_KEY` | the whole contents of `pdf-pro-updater.key` |
| Secret | `TAURI_SIGNING_PRIVATE_KEY_PASSWORD` | the password you chose |
| Variable | `UPDATER_PUBKEY` | the whole contents of `pdf-pro-updater.key.pub` |

This key only protects updates. It's separate from the Windows and Mac
code-signing certificates in [SIGNING.md](SIGNING.md), and updates work
without those.

### 2. Make the releases repo

1. github.com → **New repository**, name `pdf-pro-releases`, **Public**, tick
   **Add a README file** (the repo needs one commit to hang releases on).
2. Make a token that can publish there: github.com → Settings → Developer
   settings → **Fine-grained tokens** → Generate new token. Repository access:
   **Only select repositories** → `pdf-pro-releases`. Permissions: **Contents:
   Read and write**. Pick an expiry (up to a year) and set a reminder to renew
   it; a release fails with an authentication error once it expires.

| Kind | Name | Value |
| --- | --- | --- |
| Variable | `RELEASES_REPO` | `tjpluansing/pdf-pro-releases` |
| Secret | `RELEASES_TOKEN` | the token from step 2 |

Without `RELEASES_REPO`, releases go to this repo itself. That only works
while this repo is public.

## Making a release

1. Make sure `CHANGELOG.md` lists the changes under **Unreleased**, written for
   people using the app; it becomes the release notes and the in-app
   *What's new*.
2. Set the version and date the changelog:

   ```bash
   node scripts/release.mjs bump 0.2.0
   ```

   This writes the version into `package.json`, `package-lock.json`,
   `src-tauri/tauri.conf.json`, `Cargo.toml` and `Cargo.lock`. Merge that change
   to `Primary` (directly or through a PR).
3. Tag the merged commit and push the tag:

   ```bash
   git tag v0.2.0 && git push origin v0.2.0
   ```

The **Desktop app** workflow then checks that the tag matches the version
files, builds and signs the installers, and the *release* job publishes them.
The release stays a draft until every file is uploaded, so apps never see a
half-finished one. A tag with a suffix, such as `v0.3.0-beta.1`, becomes a
pre-release, which installed apps ignore; use it to test installers.

Versions follow [semantic versioning](https://semver.org): the last number for
fixes, the middle one for new features, the first one for big changes. Apps
only update to a higher version, so never reuse or lower one.

### What a release contains

| File | For |
| --- | --- |
| `PDF-Pro_<version>_windows-x64-setup.exe` | Windows download, and the Windows update |
| `PDF-Pro_<version>_windows-x64.msi` | Windows installs managed by IT (updates stay on .msi) |
| `PDF-Pro_<version>_macos-apple-silicon.dmg` / `_macos-intel.dmg` | Mac downloads |
| `PDF-Pro_<version>_macos-*.app.tar.gz` | Mac updates (the finished app, LibreOffice included) |
| `latest.json` | What the app reads: newest version, notes, and each file's address and signature |

## If something goes wrong

- **"Tag says X, but … says Y":** the tag and the version files disagree.
  Delete the tag (`git push origin :v0.2.0 && git tag -d v0.2.0`), run
  `bump`, merge, and tag again.
- **"No update files in this build":** `UPDATER_PUBKEY` or
  `TAURI_SIGNING_PRIVATE_KEY` wasn't set. The installers are still published,
  but installed apps aren't told about the release.
- **A release job fails after the builds succeeded:** re-run just that job
  from the workflow run page; it picks up an existing draft and replaces its
  files.
- **A bad release went out:** publish a fixed, higher version. Deleting a
  release makes apps see the previous one as newest, but anyone who already
  updated stays on the bad one until the next release.

## Before certificates are set up

Updates install fine without the Windows and Mac certificates. The first
download still shows the "unknown publisher" warnings described in
[SIGNING.md](SIGNING.md); updates installed from inside the app generally don't, because the app downloads them itself rather than through a browser.
