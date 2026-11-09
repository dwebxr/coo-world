// NFT gate: a barrier that opens only on the screen of a player whose verified EVM wallet holds the
// configured NFT (ERC-721 or ERC-1155), and a welcome line for holders.
//
// The decision is made by the server script with player.getEvmHolding(): the wallet address never reaches
// the script, and the answer is sent with app.sendTo to that player only. The barrier is opened on the
// holder's own screen (a modified client could open it for itself).
//
// IMPORTANT: nothing in this app is secret. App settings (props) and the script itself are sent to every
// visitor, so the welcome text below is readable by anyone who looks. Content that must reach holders only
// has to come from somewhere visitors cannot read, for example your own server, and be sent by the server
// script with app.sendTo after the check.
//
// Paste this into an app's script, configure it in the app's settings and export the app as a .hyp file to
// place it in other worlds. The world needs PUBLIC_EVM_CHAIN_IDS and a server-side EVM_RPC_URL_<chainId>.
// For an OpenPay license NFT use ERC-1155, the contract 0x1c652241Cc820Ce897F0d8D9351Df9AD8a0916cc on Polygon (137)
// and keccak256('openpay:license:' + productId) as the token id (hex). nft-door.js is a door preset for one.

app.configure([
  { key: 'nft', type: 'section', label: 'NFT' },
  { key: 'chainId', type: 'number', label: 'Chain ID', initial: 137 },
  { key: 'contract', type: 'text', label: 'Contract', placeholder: '0x...' },
  {
    key: 'standard',
    type: 'switch',
    label: 'Standard',
    options: [
      { label: 'ERC-1155', value: 'erc1155' },
      { label: 'ERC-721', value: 'erc721' },
    ],
    initial: 'erc1155',
  },
  { key: 'tokenId', type: 'text', label: 'Token ID', placeholder: '0x... or 123 (empty: any ERC-721 token)' },
  { key: 'minBalance', type: 'number', label: 'Minimum balance', initial: 1 },
  { key: 'welcome', type: 'textarea', label: 'Welcome text (not secret: visible to every visitor)' },
])

const barrier = app.create('prim', {
  id: 'nft-gate-barrier',
  type: 'box',
  size: [2, 2.4, 0.2],
  position: [0, 1.2, 0],
  color: '#7c3aed',
  opacity: 0.6,
  physics: 'static',
})
app.add(barrier)

if (world.isServer) {
  const spec = () => ({
    chainId: Number(props.chainId) || 137,
    contract: String(props.contract || ''),
    standard: props.standard === 'erc721' ? 'erc721' : 'erc1155',
    tokenId: props.tokenId ? String(props.tokenId) : undefined,
    minBalance: Math.max(1, Math.floor(Number(props.minBalance) || 1)),
  })
  // players who asked at least once get a fresh answer when their wallet verification changes
  const asked = new Set()
  // one read per player at a time; a request that arrives meanwhile (for example a new wallet) runs again
  // afterwards, and only the newest answer is sent
  const running = new Map()
  const check = async playerId => {
    const state = running.get(playerId)
    if (state) {
      state.again = true
      return
    }
    const current = { again: false }
    running.set(playerId, current)
    try {
      do {
        current.again = false
        const player = world.getPlayer(playerId)
        if (!player) return
        const result = await player.getEvmHolding(spec())
        if (current.again) continue
        app.sendTo(playerId, 'nft-gate:result', {
          verified: result.verified,
          known: result.known,
          holds: result.holds,
          message: result.holds ? String(props.welcome || '') : '',
        })
      } while (current.again)
    } finally {
      running.delete(playerId)
    }
  }
  app.on('nft-gate:check', (data, networkId) => {
    asked.add(networkId)
    check(networkId)
  })
  world.on('evmWallet', ({ playerId }) => {
    if (asked.has(playerId)) check(playerId)
  })
  world.on('leave', ({ playerId }) => asked.delete(playerId))
}

if (world.isClient) {
  const sign = app.create('ui', {
    width: 320,
    height: 70,
    backgroundColor: 'rgba(0, 0, 0, 0.7)',
    position: [0, 2.8, 0.2],
    justifyContent: 'center',
    alignItems: 'center',
    padding: 4,
    gap: 3,
  })
  const status = app.create('uitext', {
    id: 'nft-gate-status',
    textAlign: 'center',
    value: 'NFT HOLDERS ONLY',
    color: 'white',
    fontSize: 16,
  })
  const message = app.create('uitext', {
    id: 'nft-gate-message',
    textAlign: 'center',
    value: '',
    color: 'white',
    fontSize: 12,
  })
  sign.add(status)
  sign.add(message)
  app.add(sign)

  const action = app.create('action', {
    id: 'nft-gate-check',
    label: 'Check NFT',
    position: [0, 1.5, 0.4],
    distance: 3,
  })
  action.onTrigger = () => {
    status.value = 'CHECKING…'
    message.value = ''
    app.send('nft-gate:check', {})
  }
  app.add(action)

  app.on('nft-gate:result', result => {
    if (!result.verified) {
      status.value = 'CONNECT AN EVM WALLET'
      message.value = 'Use the wallet button in the upper-right corner, EVM tab'
    } else if (!result.known) {
      status.value = 'TRY AGAIN'
      message.value = 'The NFT could not be checked right now'
    } else if (!result.holds) {
      status.value = 'NFT NOT FOUND'
      message.value = 'This wallet does not hold the NFT'
    } else {
      status.value = 'WELCOME, HOLDER'
      message.value = result.message
    }
    // local only: the barrier disappears on this player's screen
    barrier.active = !result.holds
  })
}
