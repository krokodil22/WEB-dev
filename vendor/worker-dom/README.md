# WorkerDOM 0.36.0

Vendored from the npm package `@ampproject/worker-dom@0.36.0` (Apache-2.0).
`main.mjs` comes from `dist/amp-production/main.mjs` (configurable renderer),
`worker.js` from `dist/worker/worker.js` (standard DOM runtime).
Installation is not required to run this static site. See LICENSE.

Local integration patch in `main.mjs`: base-element event subscriptions use
`baseElement.ownerDocument.addEventListener/removeEventListener` instead of
ambient global listeners. This confines document events to the preview iframe
and ensures they disappear with that iframe. User code must never subscribe to
or prevent editor events. Regression coverage: `tests/preview.test.cjs`.

`preview-runner.js` accesses the pinned wrapper's `workerContext_.worker` to add
an external heartbeat watchdog and filter mutation sizes before rendering.
Recheck this adapter, the patch, and the browser tests when updating WorkerDOM.
