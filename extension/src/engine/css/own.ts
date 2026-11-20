// Marks the `<style>` nodes Duskling creates, so code that trusts them (css/csp.ts mirrors their text past the page's CSP)
// can tell them from a page-made `<style data-dusk>`. The mark is a JavaScript property on the element's wrapper in the
// content script's world: content worlds keep separate JavaScript environments and share only the DOM
// (https://developer.apple.com/documentation/webkit/wkcontentworld), so the page can neither see nor forge it.
// `Symbol.for`, so a second content.js instance (re-registration) and the pre-paint JS twin share it.
export const OWN_NODE = Symbol.for("dusk.own.node");

export function markOwn<T extends Element>(el: T): T {
  (el as unknown as Record<symbol, boolean>)[OWN_NODE] = true;
  return el;
}

export const isOwnNode = (el: Element): boolean => (el as unknown as Record<symbol, boolean>)[OWN_NODE] === true;
