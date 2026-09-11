/**
 * Rotating control ids.
 *
 * This is the single highest-value detail in the target app. Real ASP.NET
 * WebForms apps - which is what a great deal of credit-union back office
 * actually is - generate ids like
 *
 *   ctl00_ContentPlaceHolder1_grdResults_ctl03_lnkView
 *
 * where the ordinal segments depend on control-tree position and shift when
 * anything above them in the render changes. Here they are regenerated on every
 * single render, which makes the point louder: a CSS or XPath selector captured
 * during discovery is *guaranteed* to be wrong by the next page load.
 *
 * That is not a gimmick. It is why this system locates controls the way a human
 * operator does - by role, by label, by which row has the data you asked for -
 * instead of by what a developer happened to name something. Without it, a
 * reviewer would have to take that argument on faith.
 */

let renderCounter = 0;

/** Call once per page render; ids generated afterwards belong to that render. */
export function newRender(): number {
  renderCounter += 1;
  return renderCounter;
}

/**
 * An id in the ASP.NET shape. The `ctlNN` ordinal is derived from the render
 * counter, so it differs every time the same page is served.
 */
export function ctl(container: string, name: string, row?: number): string {
  const ordinal = String((renderCounter * 7 + (row ?? 0) * 3) % 90 + 2).padStart(2, '0');
  const rowPart = row === undefined ? '' : `_ctl${ordinal}`;
  return `ctl00_ContentPlaceHolder1_${container}${rowPart}_${name}${
    row === undefined ? `_ctl${ordinal}` : ''
  }`;
}
