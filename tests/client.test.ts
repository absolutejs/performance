import { test, expect } from "bun:test";
import { startResourceTiming } from "../src/client";
test("custom transport drains bursts, excludes telemetry, strips queries and reports failures", async () => {
  const saved = Object.fromEntries(
    ["window", "location", "PerformanceObserver"].map((k) => [
      k,
      Object.getOwnPropertyDescriptor(globalThis, k),
    ]),
  );
  let callback: any;
  let disconnected = false;
  class Observer {
    constructor(cb: any) {
      callback = cb;
    }
    observe() {}
    disconnect() {
      disconnected = true;
    }
  }
  Object.defineProperty(globalThis, "window", {
    configurable: true,
    value: {
      PerformanceObserver: Observer,
      addEventListener() {},
      removeEventListener() {},
    },
  });
  Object.defineProperty(globalThis, "location", {
    configurable: true,
    value: { pathname: "/play", href: "https://example.test/play" },
  });
  Object.defineProperty(globalThis, "PerformanceObserver", {
    configurable: true,
    value: Observer,
  });
  let stop = () => {};
  try {
    const batches: any[] = [],
      failures: unknown[] = [];
    stop = startResourceTiming({
      endpoint: "/diagnostics",
      maxBatch: 2,
      flushMs: 5,
      transport: async (batch) => {
        batches.push(batch);
        if (batches.length === 1) throw Error("offline");
      },
      onTransportError: (error) => failures.push(error),
    });
    callback({
      getEntries: () =>
        Array.from({ length: 6 }, (_, i) => ({
          entryType: "resource",
          name:
            i === 5
              ? "https://example.test/diagnostics"
              : "https://example.test/asset" + i + "?token=secret",
          duration: 10,
          transferSize: 0,
          decodedBodySize: 20,
          initiatorType: "img",
        })),
    });
    await new Promise((resolve) => setTimeout(resolve, 60));
    expect(batches.map((b) => b.resources.length)).toEqual([2, 2, 1]);
    expect(batches.flatMap((b) => b.resources).map((r) => r.target)).toEqual([
      "/asset0",
      "/asset1",
      "/asset2",
      "/asset3",
      "/asset4",
    ]);
    expect(failures).toHaveLength(1);
    stop();
    expect(disconnected).toBe(true);
  } finally {
    stop();
    for (const [k, d] of Object.entries(saved)) {
      if (d) Object.defineProperty(globalThis, k, d);
      else Reflect.deleteProperty(globalThis, k);
    }
  }
});
