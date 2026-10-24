// Side effect: install the server-side fetch Brotli guard before any repo module can fetch.
// Imported by index.js right after the SES lockdown; see fetchGuard.js.
import { installFetchBrotliGuard } from './fetchGuard.js'

installFetchBrotliGuard()
console.log('[fetch] brotli guard installed')
