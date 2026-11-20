// Simple mode: the whole page is inverted with one CSS filter on `html` and media is inverted back.
//
// The filter sits on the root element on purpose. A filter other than `none` makes an element the containing block for
// its absolutely and fixed positioned descendants, "unless the element it applies to is document root element in the
// current browsing context" (Filter Effects 1, https://drafts.fxtf.org/filter-effects/#FilterProperty), so
// `position: fixed` headers keep working. `filter`: BCD css.properties.filter safari_ios 9.3. Both facts are checked in
// WebKit by test/unit-webkit/engine.spec.ts.
//
// `html { background-color: white }` (zero specificity, so a page's own root background still wins) gives transparent
// pages something to invert. Re-inverted media nested in another re-inverted element (an <img> in an element with an
// inline `url()` background) is skipped, since the ancestor's filter already applies to it. `<picture>` isn't
// re-inverted itself, its `<img>` is: a filter on the (usually empty, inline) `<picture>` box would make it the
// containing block of an absolutely positioned `<img>` inside it, sizing the image to nothing (same Filter Effects 1 rule
// as above). Images the classifier marks as dark icons (`data-dusk-img="invert"`) are not re-inverted, so they turn light.
import { markOwn } from "../css/own";

const MEDIA = 'img,video,canvas,iframe,svg image,[style*="url("]';
const OUTER = 'video,iframe,[style*="url("]';

export const FILTER_CSS =
  "html{filter:invert(.9) hue-rotate(180deg)!important}:where(html){background-color:white}" +
  `:is(${MEDIA}):not(:is(${OUTER}) *):not([data-dusk-img="invert"]){filter:invert(1) hue-rotate(180deg)!important}`;

/** The theme-color tint matching the inverted page: white through `invert(.9)` (255 × 0.1 ≈ 26). */
export const FILTER_TINT = "rgb(26, 26, 26)";

/** Applies Simple mode to `doc` and returns the teardown, which removes exactly what it added. */
export function applyFilterMode(doc: Document): () => void {
  const style = markOwn(doc.createElement("style"));
  style.setAttribute("data-dusk", "filter");
  style.setAttribute("media", "screen");
  style.textContent = FILTER_CSS;
  (doc.head ?? doc.documentElement).append(style);
  return () => style.remove();
}
