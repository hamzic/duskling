# Changelog

All notable changes to Duskling are documented here. The format follows
[Keep a Changelog](https://keepachangelog.com/en/1.1.0/), and the project uses
[Semantic Versioning](https://semver.org/spec/v2.0.0.html).

## [1.0.3] - 2026-11-26

### Fixed

- Colors written as `color(display-p3 …)` are now made dark. Before, such a background stayed white while its text was lightened.

### Changed

- Less memory used on pages with many images from other sites.

## [1.0.2] - 2026-11-22

### Changed

- Same app as 1.0.1, released again to add iPhone Duo screenshots and shorter release notes to the App Store.

## [1.0.1] - 2026-11-21

### Added

- Setup step that shows how to allow Duskling on websites in Safari.
- Check at the end of setup that shows when everything works.
- iPhone Duo support.

### Changed

- Home shows "Needs website access" when Safari access is missing.
- "Report a problem" opens GitHub issues instead of email.

## [1.0.0] - 2026-11-20

First release.

### Added

- Dark mode for every website in Safari on iPhone and iPad, built from each site's own colors.
- Three themes: Dark, Midnight and Dim.
- Per-site controls in the Safari popup: turn dark mode off, pick a theme, use or ignore the site's own dark theme, and
  dim images.
- Uses a site's own dark theme when it has one.
- Companion app with setup, global settings and the list of sites you changed, synced through iCloud.
- Report a broken site by email, with the host name only.

[1.0.3]: https://github.com/hamzic/duskling/releases/tag/v1.0.3
[1.0.2]: https://github.com/hamzic/duskling/releases/tag/v1.0.2
[1.0.1]: https://github.com/hamzic/duskling/releases/tag/v1.0.1
[1.0.0]: https://github.com/hamzic/duskling/commit/b87fbab
