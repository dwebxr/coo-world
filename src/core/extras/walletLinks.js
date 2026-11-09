// Links to open phone wallets for WalletConnect. No dependencies: used by the wallet panel (main bundle)
// and by src/client/walletconnect.js (loaded on demand).

// Wallets offered on phones, with the links in Reown's wallet registry (explorer-api.walletconnect.com and
// AppKit's api.web3modal.org, 2026-11-09). HashPort Wallet and Myna Wallet hold JPYC. Myna Wallet is a
// smart-contract account: its sign-in needs the server's contract check (EVM_RPC_URL_<chainId>).
// - `native`: the app's own scheme, which AppKit uses on phones. It opens the app whenever it is installed;
//   Safari asks "Open in …?" first. "Open wallet" uses it, since a connected wallet is installed.
// - `universal`: pairs through <universal>/wc?uri=…, which opens without asking. When iOS does not hand the
//   link to the app, the wallet's page sends the player to the App Store and the pairing link is lost. MetaMask's
//   and Myna's work for players. HashPort's (https://link.wallet.hashport.com) did not open the app on an iPhone
//   tested on 2026-11-09, so HashPort pairs through its scheme.
export const WALLET_LINKS = Object.freeze([
  Object.freeze({ id: 'metamask', name: 'MetaMask', native: 'metamask://', universal: 'https://metamask.app.link' }),
  Object.freeze({ id: 'hashport', name: 'HashPort Wallet', native: 'expo2025-wallet://' }),
  Object.freeze({
    id: 'myna',
    name: 'Myna Wallet',
    native: 'mynawallet://',
    universal: 'https://prd-api.mynawallet.jp/deeplink',
  }),
])

// the pairing link for a listed wallet: <universal>/wc?uri=… or <scheme>://wc?uri=… (AppKit's two forms)
export const walletConnectLink = (wallet, uri) =>
  `${wallet.universal ? `${wallet.universal}/` : wallet.native}wc?uri=${encodeURIComponent(uri)}`

// an app scheme as a link can carry it: no script, data, file or web scheme, no spaces, at most 200 characters
const BLOCKED_SCHEMES = new Set(['javascript:', 'data:', 'blob:', 'file:', 'http:', 'https:', 'about:', 'vbscript:'])
export function safeAppLink(value) {
  const link = typeof value === 'string' ? value.trim() : ''
  if (!link || link.length > 200 || /\s/.test(link) || !/^[a-z][a-z0-9+.-]*:/i.test(link)) return null
  return BLOCKED_SCHEMES.has(link.slice(0, link.indexOf(':') + 1).toLowerCase()) ? null : link
}

// A wallet's link back as the wallet sent it (peer metadata, over the relay), validated before it reaches an
// href: its app scheme first (the app is installed: it holds the session), else an https universal link
export function safeRedirect(redirect) {
  if (!redirect || typeof redirect !== 'object') return null
  const native = safeAppLink(redirect.native)
  if (native) return native
  const universal = typeof redirect.universal === 'string' ? redirect.universal.trim() : ''
  if (universal) {
    try {
      const url = new URL(universal)
      if (url.protocol === 'https:' && !url.username && !url.password) return url.href
    } catch {
      // not a URL
    }
  }
  return null
}

// a link with a scheme of its own (it opens an app), not an https page
export const isAppScheme = link =>
  typeof link === 'string' && /^[a-z][a-z0-9+.-]*:/i.test(link) && !/^https:/i.test(link)

// A WalletConnect pairing URI as the relay hands it out (wc:<topic>@2?...)
export const isWalletConnectUri = value => typeof value === 'string' && /^wc:[0-9a-f]{64}@2\?/.test(value)
