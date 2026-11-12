# Migration Guide

## This fork (Coo World)

This fork records its behaviour changes and upgrade notes in [CHANGELOG.md](CHANGELOG.md), under `## [Unreleased]`: that section is where the changes made since upstream Hyperfy v0.16.0 (the version `package.json` still carries) are written down. Read it before upgrading a world; the notes are not repeated here.

## Upstream Hyperfy's note for upgrading from 0.15.0 (history)

Kept as upstream wrote it, for worlds that come from Hyperfy 0.15.0. It is the text of this file at upstream's `v0.16.0` tag; only its heading, which named a placeholder version (`0.15.0 -> X.XX.X`), was replaced.

### Self Hosting

- The `PUBLIC_ASSETS_URL` environment variable was renamed to `ASSETS_BASE_URL`.
- A new `ASSETS=local` environment variable is now required. This can also be set to `s3` allowing assets to be stored in a remote S3-compatible bucket with `ASSETS_S3_URI` (such as Amazon S3 and Cloudflare R2)
- A new `CLEAN` environment variable has been added which defaults to `CLEAN=true` for new installations. When enabled, all unused data (blueprints and assets) are purged during world startup.

### Apps

- The `app.keepActive` toggle has been removed as apps are now active and will run scripts by default, even while being moved. If you come across an app behaving weirdly while moving them, it's likely that adding `app.resetOnMove = true` at the top of the script will fix it.