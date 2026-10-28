// Runs the extraction off the main thread.
//
// The Worker exists for two reasons. It keeps a long extraction from freezing
// the page, and it is the cancellation mechanism: the ABI has no cancel flag
// and cannot have one, so a host aborts a run by terminating the worker.
// Progress arrives as messages posted between stages.

import { extract } from "./extract.mjs";

self.onmessage = async (ev) => {
  const { wasmBytes, inputs, flags, expectedOutputs, maxOutputBytes } = ev.data;
  try {
    const { outputs, warnings } = await extract(wasmBytes, inputs, {
      flags,
      expectedOutputs,
      maxOutputBytes,
      onProgress: (p) => self.postMessage({ type: "progress", ...p }),
    });
    // Transfer rather than copy: these are megabytes.
    self.postMessage({ type: "done", outputs, warnings }, outputs.map((o) => o.data.buffer));
  } catch (e) {
    self.postMessage({ type: "error", message: String(e?.message ?? e) });
  }
};
