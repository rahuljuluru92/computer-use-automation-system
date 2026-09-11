/**
 * The Surface port.
 *
 * Everything above this interface - the artifact schema, the executor, the
 * error taxonomy, the escalation model - is written against these eight methods
 * and knows nothing about browsers. That is the whole answer to the brief's
 * "surface abstraction" question: the seam is here, and it is narrow enough
 * that a second implementation is a day's work rather than a rewrite.
 *
 * Two implementations exist: WebSurface (Playwright) and DesktopSurface (macOS
 * accessibility APIs, stubbed at this seam and documented as a cut).
 */

import type { UiNode, UiSnapshot } from './uinode.ts';

export interface ScreenshotOptions {
  /** Nodes to black out before the image is written, for sensitive fields. */
  mask?: UiNode[];
  fullPage?: boolean;
}

export interface Surface {
  readonly kind: 'web' | 'desktop';

  /** Perceive current state. The only way anything learns what is on screen. */
  observe(opts?: { depth?: number }): Promise<UiSnapshot>;

  click(node: UiNode): Promise<void>;
  type(node: UiNode, text: string, opts?: { clearFirst?: boolean }): Promise<void>;
  select(node: UiNode, option: string): Promise<void>;
  press(key: string): Promise<void>;
  scroll(direction: 'up' | 'down', amount: number): Promise<void>;

  /** Navigation is surface-specific: a URL on web, an app launch on desktop. */
  navigate(target: string): Promise<void>;

  /** Read a node's text content, for extraction. */
  readText(node: UiNode): Promise<string>;

  /**
   * Accessible structure of a subtree, as a comparable string. Backs the
   * `aria_subtree` checkpoint - asserting shape rather than a selector.
   */
  ariaSubtree(node: UiNode): Promise<string>;

  screenshot(opts?: ScreenshotOptions): Promise<Buffer>;

  currentUrl(): Promise<string>;

  close(): Promise<void>;
}

/**
 * Thrown when the surface itself breaks (browser crash, navigation error) as
 * opposed to the application misbehaving. Maps to FailureCode.surface_error -
 * the distinction matters because one is our problem and one is theirs.
 */
export class SurfaceError extends Error {
  constructor(message: string, options?: { cause?: unknown }) {
    super(message, options);
    this.name = 'SurfaceError';
  }
}
