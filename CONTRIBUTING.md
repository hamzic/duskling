# Contributing

## Project rules

1. **Look up platform behavior, don't assume it.** Before relying on any Safari, WebKit, iOS, Xcode or StoreKit
   behavior, check a primary source and cite it in the commit message or a code comment: Apple Developer Documentation,
   webkit.org and bugs.webkit.org, MDN together with `@mdn/browser-compat-data` (the `safari_ios` entries), or the
   XcodeGen `ProjectSpec.md`.
2. **If it's still unclear, test the assumption first** with a small experiment, and note the question, the method and
   the result in the pull request.
3. **No site-specific fixes.** See "Fixing a broken site" below.
4. **Privacy is a hard constraint.** Nothing about the user or the page is sent anywhere. The extension's only
   requests re-fetch resources the page already references, without cookies (see [PRIVACY.md](PRIVACY.md)).
5. **Tests first.** Write the failing test, see it fail, implement, see it pass. Don't loosen a test threshold to get
   green.

## License of contributions

Duskling is MIT-licensed. By sending a contribution you agree that it is licensed under the same [MIT License](LICENSE).
Only contribute code you wrote yourself or code under a license compatible with MIT, and say where any copied code comes
from. Don't paste code from GPL, LGPL or AGPL projects (many dark-mode extensions are GPL): it can't be shipped in an
MIT app on the App Store.

## Reporting a broken site

Open an issue with the site's host, the Duskling mode and theme, and what looks wrong (a screenshot helps). Don't paste
full URLs that contain personal information.

## Fixing a broken site

Duskling never ships per-site CSS or selectors (rule 3). To fix a site:

1. Find the general cause (for example a color format, a pseudo-element, a CSS variable pattern, a shadow root).
2. Reproduce it as a fixture page in `extension/test/fixtures/pages/`.
3. Write a failing end-to-end test that loads the fixture and checks contrast and darkness.
4. Fix the cause in the engine (`extension/src/engine/`) and watch the test pass.

The only host-keyed data allowed is `extension/src/shared/site-defaults.json`. It is empty at launch, and every entry
needs a linked issue explaining why no generic fix exists.

## Running tests

```sh
cd extension
pnpm install --frozen-lockfile
pnpm run typecheck
pnpm run lint
pnpm test            # unit tests (Vitest)
pnpm run build
pnpm run size        # size budgets
pnpm run test:e2e    # Playwright WebKit
```

Node 24 is required. Use Conventional Commits.

## Adding a language

Strings live in `extension/src/_locales/<lang>/messages.json` and in the app's `Localizable.xcstrings`. Add the new
language to both, keep every key, and keep the copy rules in [DESIGN.md](DESIGN.md) (short, concrete, sentence case).
