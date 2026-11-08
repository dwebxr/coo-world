// Links to open phone wallets for WalletConnect. No dependencies: used by the wallet panel (main bundle)
// and by src/client/walletconnect.js (loaded on demand).

// Wallets offered on phones, by their universal links: <universal>/wc?uri=<encoded wc: uri>
export const WALLET_LINKS = Object.freeze([
  Object.freeze({ id: 'metamask', name: 'MetaMask', universal: 'https://metamask.app.link' }),
  Object.freeze({ id: 'trust', name: 'Trust Wallet', universal: 'https://link.trustwallet.com' }),
  Object.freeze({ id: 'rainbow', name: 'Rainbow', universal: 'https://rnbwapp.com' }),
])

export const walletConnectLink = (universal, uri) => `${universal}/wc?uri=${encodeURIComponent(uri)}`

// A wallet's link back as the wallet sent it (peer metadata, over the relay): only https universal links and
// plain app schemes pass; script, data, file and plain web pages never reach an href.
const BLOCKED_SCHEMES = new Set(['javascript:', 'data:', 'blob:', 'file:', 'http:', 'https:', 'about:', 'vbscript:'])
export function safeRedirect(redirect) {
  if (!redirect || typeof redirect !== 'object') return null
  const universal = typeof redirect.universal === 'string' ? redirect.universal.trim() : ''
  if (universal) {
    try {
      const url = new URL(universal)
      if (url.protocol === 'https:' && !url.username && !url.password) return url.href
    } catch {
      // not a URL
    }
  }
  const native = typeof redirect.native === 'string' ? redirect.native.trim() : ''
  if (native && native.length <= 200 && !/\s/.test(native) && /^[a-z][a-z0-9+.-]*:/i.test(native)) {
    const scheme = native.slice(0, native.indexOf(':') + 1).toLowerCase()
    if (!BLOCKED_SCHEMES.has(scheme)) return native
  }
  return null
}

// A WalletConnect pairing URI as the relay hands it out (wc:<topic>@2?...)
export const isWalletConnectUri = value => typeof value === 'string' && /^wc:[0-9a-f]{64}@2\?/.test(value)
