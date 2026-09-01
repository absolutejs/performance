/**
 * The browser half: sampling static asset loads and sending them home.
 *
 * Separate entry point, no server imports, no dependencies. This runs on every
 * page load, so it batches, sends on idle, and gives up quietly rather than
 * competing with the page it is measuring.
 */

const MAX_BATCH = 60;
const IDLE_FLUSH_MS = 4000;
const URL_MAX = 512;

export type ResourceSample = {
  at: number;
  cacheHit: boolean;
  durationMs: number;
  initiatorType: string;
  page: string;
  protocol?: string;
  target: string;
  transferSize: number;
};

export type StartResourceTimingOptions = {
  /** Where samples are POSTed. */
  endpoint: string;
  environment?: string;
  release?: string;
  /** Paths whose loads are not measured. The collector's own endpoint belongs
   *  here, along with any other telemetry: left in, they are reliably the
   *  busiest assets on the page and tell you nothing. */
  ignorePaths?: readonly string[];
  /** Samples buffered before a flush is forced. Default 60. */
  maxBatch?: number;
  /** Quiet period before a buffered batch is sent. Default 4s. */
  flushMs?: number;
};

/**
 * Drop query strings and the page's own origin from an asset URL.
 *
 * Query strings carry ids and cache-busters that would fragment one asset into
 * thousands of rows. The origin is dropped for same-origin files because
 * keeping it ties every row to the hostname it was served from, so the day an
 * application moves to a different domain its whole history stops matching.
 * Third-party origins stay: telling one vendor's script from another's is the
 * point.
 */
export const assetKey = (value: string, origin?: string): string => {
  try {
    const base =
      origin ?? (typeof location === "undefined" ? undefined : location.href);
    const url = new URL(value, base);

    return (
      url.origin === (base === undefined ? url.origin : new URL(base).origin)
        ? url.pathname
        : `${url.origin}${url.pathname}`
    ).slice(0, URL_MAX);
  } catch {
    return value.replace(/[?#].*$/u, "").slice(0, URL_MAX);
  }
};

/**
 * A transfer size of zero with a non-zero decoded size is the browser saying it
 * served this from cache. It is the only cache signal Resource Timing gives.
 */
const cacheHitOf = (entry: PerformanceResourceTiming) =>
  entry.transferSize === 0 && entry.decodedBodySize > 0;

/**
 * Sample every static asset the page loads.
 *
 * Everything, not only what crossed a threshold: a threshold can say a file was
 * slow, but never that a fast file loaded on every page is the one worth
 * caching. Returns a stop handle; a no-op where PerformanceObserver does not
 * exist.
 */
export const startResourceTiming = (
  options: StartResourceTimingOptions,
): (() => void) => {
  const {
    endpoint,
    environment,
    flushMs = IDLE_FLUSH_MS,
    ignorePaths = [],
    maxBatch = MAX_BATCH,
    release,
  } = options;
  if (typeof window === "undefined" || !("PerformanceObserver" in window))
    return () => undefined;

  const pending: ResourceSample[] = [];
  let timer: ReturnType<typeof setTimeout> | undefined;

  const flush = () => {
    timer = undefined;
    if (pending.length === 0) return;
    const batch = pending.splice(0, maxBatch);
    const body = JSON.stringify({ environment, release, resources: batch });
    // sendBeacon survives the page going away, which is exactly when the last
    // and most interesting samples are taken.
    if (typeof navigator !== "undefined" && navigator.sendBeacon)
      navigator.sendBeacon(
        endpoint,
        new Blob([body], { type: "application/json" }),
      );
  };

  const schedule = () => {
    if (timer !== undefined) return;
    timer = setTimeout(flush, flushMs);
  };

  const ignored = [endpoint, ...ignorePaths];
  const observer = new PerformanceObserver((list) => {
    for (const entry of list.getEntries()) {
      if (entry.entryType !== "resource") continue;
      const resource = entry as PerformanceResourceTiming;
      if (ignored.some((path) => resource.name.includes(path))) continue;
      pending.push({
        at: Date.now(),
        cacheHit: cacheHitOf(resource),
        durationMs: Math.round(resource.duration),
        initiatorType: resource.initiatorType,
        page: assetKey(location.pathname),
        ...(resource.nextHopProtocol
          ? { protocol: resource.nextHopProtocol }
          : {}),
        target: assetKey(resource.name),
        transferSize: resource.transferSize,
      });
    }
    if (pending.length >= maxBatch) flush();
    else schedule();
  });

  try {
    // buffered: the assets that matter most loaded before this ran.
    observer.observe({ buffered: true, type: "resource" });
  } catch {
    return () => undefined;
  }

  // A batch is worthless if the tab closes before it is sent, and mobile Safari
  // never fires beforeunload.
  const onHide = () => flush();
  window.addEventListener("pagehide", onHide);

  return () => {
    window.removeEventListener("pagehide", onHide);
    observer.disconnect();
    if (timer !== undefined) clearTimeout(timer);
    flush();
  };
};
