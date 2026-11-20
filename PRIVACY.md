# Privacy

Last updated: 2026-11-19.

Duskling is an open-source project maintained by an independent developer ("we", "us" below). Contact:
developer@defec8ed.com.

Duskling collects no data. It has no servers of its own, no analytics, no crash reporting and no accounts, and it never
sends anything about you or what you browse to us or to anyone else. Its only network requests are fetches of style
sheets and images that the page you're viewing already references, described below. The App Store privacy label says
"Data Not Collected". The one exception is a problem report you choose to email us yourself (see "Reporting a site
problem").

## What stays on your device

Your settings (theme, mode, per-site choices) are stored on your device. The app and the Safari extension share them
through an App Group. The app syncs them between your own devices through your iCloud account (iCloud key-value storage,
operated by Apple). That includes the host names of sites whose settings you changed, such as `example.com`, never full
addresses or browsing history. We have no access to your iCloud data and no server of our own.

How long it's kept and how to delete it:

- Settings stay until you change them. When you remove a site in the app's Sites list, the removal syncs to your other
  devices, and a small deletion marker with that host name is kept for 30 days so devices that were offline also remove it.
- Deleting the app removes the data on that device. What it synced stays in your iCloud account, and it is used again if
  you reinstall: your settings, the host names of sites you changed, and the deletion markers of sites you removed in
  the last 30 days. Once the app is gone from all your devices, nothing removes them. Removing sites in the Sites list
  before deleting the app leaves only those markers behind, not your list.

## Fetching page resources

To recolor a style sheet or image that Safari won't let the extension read directly (it comes from another origin), the
extension's background script can fetch that one URL. The engine only asks for addresses the page itself already
references (style sheets it links or imports, images it shows). The background script, in
`extension/src/background/fetch-resource.ts`, enforces the rest:

- Only `http` and `https`, with no cookies or credentials (`credentials: "omit"`), at most 5 MB, with a 10 second timeout. Redirects are followed one hop at a time
  (at most 5), and every hop is checked again.
- Style sheets: only responses of type `text/css` are accepted, and the text is used on your device to compute colors.
- Images: only `image/*` responses are accepted. Duskling looks at an image only to classify it (for example, a dark icon or a
  photo). It changes an image's pixels only when the server's response allows the page to read it
  (`Access-Control-Allow-Origin`: `*` or the page's own origin). Images from the page's own origin are read from the page
  itself, with no request outside the page's own origin.
- Private-network guard: the extension refuses requests to addresses that look local. Addresses that are loopback,
  private, link-local, single-label names (such as `router`), `.local`, `.localhost`, `.internal`, `.lan` or `home.arpa`
  are refused unless the page you are on is itself in the same kind of address.
- Remaining limit: extensions can't look up DNS, so the guard sees host names, not the addresses behind them. A public
  host name that resolves (or is rebound) to a private address could still be fetched. What comes back is limited to a CSS
  file or image bytes that Duskling only classifies, and nothing is sent anywhere else.
- Accepted limit: to recolor a style sheet from another site, Duskling writes recolored rules from it into the page. A page could
  read those rules, so it could learn the colors and selectors of a style sheet it links to but isn't allowed to read itself.
  Only style sheets reachable without cookies are affected, and Duskling sends no page content anywhere.

## What a website can see

Duskling changes the page in ways the page's own scripts can observe, as any extension that restyles pages does. A page can
tell that Duskling is running, and which theme it uses, from the `data-dusk` marks and styles it adds, and from the events it
uses to talk to its own page script. That's a signal a site could use as part of fingerprinting. A page can also send
those events itself, which only makes Duskling do extra work on that same page. Duskling sends nothing about the page or about
you anywhere.

## Reporting a site problem

"Report a problem" opens a draft email in your mail app. The draft contains the site's host name (never the full address,
path or query), the mode and theme, whether the site's own dark theme was used, the Duskling and iOS versions and the device
type (iPhone or iPad). You review it and send it yourself. Duskling sends nothing in the background.

When you send a report, we receive what's in the draft plus your email address, as with any email.

## Contact

Questions: developer@defec8ed.com, or the repository's issue tracker. If this policy changes, the date at the top changes
with it.
