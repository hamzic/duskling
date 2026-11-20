# Security

## Reporting a vulnerability

Please report security problems privately, not in a public issue.

- On GitHub: open the repository's **Security** tab and choose **Report a vulnerability**. Only the maintainer sees the
  report.
- By email: developer@defec8ed.com, with "Duskling security" in the subject.

Include what's affected (the Safari extension or the app), the Duskling and iOS versions, and steps or a test page that
shows the problem. You'll get a reply within 7 days. Please give us a reasonable time to ship a fix before you publish
details.

## Scope

In scope: the Safari extension (content script, popup, background), the Duskling app, and how they store and sync
settings. Examples: a page reading or changing Duskling's settings, the extension leaking page data, the extension
making a network request, or styles the extension inserts weakening a page's protections.

Out of scope: bugs in Safari or iOS themselves (report those to Apple), and sites that only look wrong in dark mode
(open a normal issue for those).

## Supported versions

Duskling isn't released yet. Once it is, only the latest release gets security fixes.
