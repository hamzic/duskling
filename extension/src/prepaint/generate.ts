import { PALETTES, type Palette } from "../engine/color/palettes";
import { paletteCss } from "../engine/color/transform";
import { bootFiles } from "../shared/boot";

/** The pre-paint template. Scoped to html:not([data-dusk-ready]) so it switches off once the engine takes over. */
export function prepaintCss(p: Palette): string {
  const { bg, fg } = paletteCss(p);
  const sel = "html:not([data-dusk-ready]):not([data-dusk-sampling])";
  return (
    "@media screen {\n" +
    `  ${sel} { background-color: ${bg} !important; color-scheme: dark !important; }\n` +
    `  ${sel} body { background-color: ${bg} !important; color: ${fg} !important; }\n` +
    // The content too: a box the page paints light from a sheet Duskling hasn't rewritten yet
    // (a cross-origin one waits for the background fetch) must not show. Plain until ready, never light.
    `  ${sel} body * { background-color: transparent !important; color: ${fg} !important; }\n` +
    // A frame's page still light gets a transparent canvas, not an opaque light one (CSS Color Adjust 1 §2.2).
    `  ${sel} iframe { color-scheme: normal !important; }\n` +
    "}\n"
  );
}

/**
 * Fallback twin of prepaintCss: inserts the identical CSS synchronously into document.documentElement.
 * Idempotent, because re-registration injects into already-open pages.
 * documentElement exists at document_start in Safari: WebKit maps a content script's document_start to
 * WebCore::UserScriptInjectionTime::DocumentStart (Source/WebKit/UIProcess/Extensions/WebExtensionContext.cpp, WebKit
 * 760bea879bd0), the time Apple documents as "after the creation of the webpage's document element"
 * (developer.apple.com/documentation/webkit/wkuserscriptinjectiontime/atdocumentstart). The `!r` guard is defensive.
 */
export function prepaintJs(p: Palette): string {
  return (
    `(()=>{const d=document,r=d.documentElement;if(!r||r.querySelector('style[data-dusk="prepaint"]'))return;` +
    `const s=d.createElement("style");s[Symbol.for("dusk.own.node")]=true;s.setAttribute("data-dusk","prepaint");s.media="screen";` +
    `s.textContent=${JSON.stringify(prepaintCss(p))};r.appendChild(s)})();`
  );
}

/** dist/prepaint/<theme>.css|js. */
export const prepaintFiles = (): Record<string, string> =>
  Object.fromEntries(Object.values(PALETTES).flatMap((p) => [[`${p.id}.css`, prepaintCss(p)], [`${p.id}.js`, prepaintJs(p)]]));

/** dist/boot/<class>.js. Re-exported so build.mjs imports one module. */
export { bootFiles };
