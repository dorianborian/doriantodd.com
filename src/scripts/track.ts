// Google Analytics 4 events. The gtag snippet is only on the production site (Shell.astro), so in dev and
// in headless checks this is a no-op. Page views, scrolling, outbound clicks and downloads are tracked by
// GA4 enhanced measurement; these are the site-specific actions on top.
type Params = Record<string, string | number | boolean | undefined>;
export function track(name: string, params: Params = {}) {
  const g = (window as unknown as { gtag?: (...a: unknown[]) => void }).gtag;
  if (g) g('event', name, params);
}
