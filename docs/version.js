// Single source of truth for the app version.
//
// Bump this on every commit that changes the app. The service worker cache name
// in sw.js must contain the same string - a released version that reuses a
// cache name would leave installed copies serving the previous build forever.
// test/version.test.mjs enforces that they match.

export const VERSION = '0.16.2';
