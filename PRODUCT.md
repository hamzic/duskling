# Product

## Users

iPhone and iPad Safari users who read at night or prefer dark interfaces, and who don't want to pay or be tracked.

## Jobs

- "Make every site dark without thinking about it."
- "Fix one site that looks wrong in one tap."
- "Turn it off for one site."

## Goals

1. **Privacy.** Nothing about you or what you browse is sent to us or anyone else. No analytics, no accounts, no servers. The App Store privacy label says
   "Data Not Collected".
2. **It just works.** Install it, turn it on, and every site is dark with no broken buttons.
3. **Adaptation without breakage.** It recolors the site's own colors and never inverts the whole page by default, it
   respects sites that are already dark, and it gives users one obvious escape hatch when a site looks wrong.
4. **Small and fast.** A strict size and speed budget, enforced in CI.

## Non-goals (v1)

- Mac Safari.
- Scheduling or "follow system appearance". Dark mode is always on by default, and users pause it globally or per site.
- Shortcuts, Control Center, widgets, Focus filters.
- Per-site brightness, contrast or sepia sliders, and custom CSS editors.
- Site-specific fixes of any kind, remote or bundled.

## Anti-goals (must never happen)

- A request that sends data about the user or the page to us or to anyone else.
- Persuasion patterns: nagging, upsells or locked features.
- Breaking a site's interaction: the engine only changes colors, images and filters, never layout, events or DOM structure.
- Site-specific CSS or selectors in shipped code. The only host-keyed data is a tiny mode-default list, and it is empty at launch.

## Page job

The app and the popup are *operate* surfaces, not persuasion. They help someone check state and change it in a tap or two.
They don't sell, onboard at length or ask for anything.
