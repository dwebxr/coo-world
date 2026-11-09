// NFT door: a sliding or swinging door that opens for a player whose verified EVM wallet holds an OpenPay
// license NFT (ERC-1155 on Polygon). Players without one can click the pass panel to open the product's page.
//
// The model must have a static rigidbody `Frame` and kinematic rigidbodies `LeftDoor` and `RightDoor` (the
// door model of the "TOKEN GATE COO" app). The holding check runs in the server script with
// player.getEvmHolding(): the wallet address never reaches the script, and the answer goes to that player
// only, with app.sendTo. The door opens on that player's screen only (a modified client could open it for
// itself), and app settings and this script are sent to every visitor, so nothing here is secret.
//
// The defaults are the OpenPay license contract on Polygon and the "Coo-World NFT Gate" product
// (h_dc83087ae6050a26540f963151de4c1f). For another OpenPay product, set Token ID to
// keccak256('openpay:license:' + productId) in hex and Store URL to the product's page. The world needs
// PUBLIC_EVM_CHAIN_IDS with 137 and a server-side EVM_RPC_URL_137.

const OPENPAY_LICENSE_CONTRACT = '0x1c652241Cc820Ce897F0d8D9351Df9AD8a0916cc'
// keccak256('openpay:license:h_dc83087ae6050a26540f963151de4c1f')
const COO_WORLD_PASS_TOKEN_ID = '0x44ed4cd2617180c45b9c6e4c1043502f00094cd474effa009b2b84141ac4a171'
const COO_WORLD_PASS_URL = 'https://open-pay.jp/@coo?product=h_dc83087ae6050a26540f963151de4c1f'

app.configure([
  { key: 'nft', type: 'section', label: 'NFT (OpenPay license)' },
  { key: 'chainId', type: 'number', label: 'Chain ID', initial: 137 },
  { key: 'contract', type: 'text', label: 'Contract', initial: OPENPAY_LICENSE_CONTRACT },
  { key: 'tokenId', type: 'text', label: 'Token ID', initial: COO_WORLD_PASS_TOKEN_ID },
  { key: 'minBalance', type: 'number', label: 'Minimum balance', initial: 1 },
  { key: 'passName', type: 'text', label: 'Pass name', initial: 'Coo-World NFT Gate' },
  { key: 'storeUrl', type: 'text', label: 'Store URL (empty: no link)', initial: COO_WORLD_PASS_URL },
  { key: 'door', type: 'section', label: 'Door Settings' },
  {
    key: 'type',
    type: 'switch',
    label: 'Door Type',
    options: [
      { label: 'Sliding', value: '1' },
      { label: 'Swinging', value: '2' },
    ],
    initial: '1',
  },
  { key: 'slideDistance', type: 'textarea', label: 'Slide Distance', initial: '1.8', placeholder: '1.8' },
  { key: 'maxRotation', type: 'textarea', label: 'Swing Angle', initial: '45', placeholder: '45' },
  {
    key: 'direction',
    type: 'switch',
    label: 'Direction',
    options: [
      { label: 'Inward', value: '1' },
      { label: 'Outward', value: '2' },
    ],
    initial: '2',
  },
])

if (world.isServer) {
  const spec = () => ({
    chainId: Number(props.chainId) || 137,
    contract: String(props.contract || '').trim(),
    standard: 'erc1155',
    tokenId: String(props.tokenId || '').trim() || undefined,
    minBalance: Math.max(1, Math.floor(Number(props.minBalance) || 1)),
  })
  // players who asked at least once get a fresh answer when their wallet verification changes
  const asked = new Set()
  // the newest request each player sent, { run, nonce, open }. Every answer carries it back, so the client
  // can tell which answer belongs to its Open press, and to which build of the app (`run`)
  const requests = new Map()
  const NO_REQUEST = { run: '', nonce: 0, open: false }
  // one read per player at a time; a request that arrives meanwhile (for example after a new wallet) runs
  // again afterwards, and only the newest answer is sent
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
        const request = requests.get(playerId) || NO_REQUEST
        app.sendTo(playerId, 'nft-door:result', {
          verified: result.verified,
          known: result.known,
          holds: result.holds,
          run: request.run,
          nonce: request.nonce,
          open: request.open,
        })
      } while (current.again)
    } finally {
      running.delete(playerId)
    }
  }
  app.on('nft-door:check', (data, networkId) => {
    const nonce = data?.nonce
    requests.set(networkId, {
      run: typeof data?.run === 'string' ? data.run.slice(0, 32) : '',
      nonce: Number.isSafeInteger(nonce) && nonce > 0 ? nonce : 0,
      open: data?.open === true,
    })
    asked.add(networkId)
    check(networkId)
  })
  world.on('evmWallet', ({ playerId }) => {
    if (!asked.has(playerId)) return
    // a wallet change is not a press: an Open still waiting for its answer gets a status answer only
    const request = requests.get(playerId)
    if (request?.open) requests.set(playerId, { ...request, open: false })
    check(playerId)
  })
  world.on('leave', ({ playerId }) => {
    asked.delete(playerId)
    requests.delete(playerId)
  })
}

if (world.isClient) {
  const doorFrame = app.get('Frame')
  // The production model's panel names are reversed relative to the animation variables.
  const doorR = app.get('LeftDoor')
  const doorL = app.get('RightDoor')
  const initialL = { position: doorL.position.clone(), rotation: doorL.rotation.clone() }
  const initialR = { position: doorR.position.clone(), rotation: doorR.rotation.clone() }
  const passName = String(props.passName || '').trim() || 'NFT pass'
  const storeUrl = String(props.storeUrl || '').trim()
  // shown on the sign for players whose browser blocks the new tab, eg 'open-pay.jp/@coo'
  const storeHost = storeUrl
    .replace(/^https?:\/\//i, '')
    .replace(/[?#].*$/, '')
    .replace(/\/$/, '')
  const REQUIRED = 'NFT PASS REQUIRED'
  const DOOR_OPEN_TIME = 3
  // longer than the server's own limit for one read (10 s), after which it answers "unknown" by itself;
  // an answer that has not come back by then was dropped on the way. Measured on the clock, not by adding
  // up frame times: the world caps a frame at 1/30 s, so on a slow device frame time runs behind
  const ANSWER_TIMEOUT_MS = 15000
  const speed = 2
  let isOpen = false
  let isMoving = false
  let currentPosition = 0
  let targetPosition = 0
  let openTimer = 0
  // this build of the app: answers meant for an earlier build (before a script or settings change) are ignored
  const run = uuid()
  // requests are numbered; each answer carries back the newest request the server had from this player
  let nonce = 0
  let answered = 0
  let waitSince = 0
  // the number of an Open press still waiting for its answer (0: none). Only the answer to exactly that
  // request, still marked `open` by the server (no wallet change in between), opens the door
  let openNonce = 0
  // the status check on load is sent again once if it gets no answer: on the screen of the builder who
  // just dropped the app, the script runs before the server has the app, so that first check is lost
  let statusRetried = false
  // the newest answer, shown whenever no Open press is in progress (null: none yet)
  let status = null
  let statusLost = false

  const doorSign = app.create('ui', {
    width: 300,
    height: 65,
    backgroundColor: 'rgba(0, 0, 0, 0.7)',
    position: [0, 2.2, 0.25],
    justifyContent: 'center',
    alignItems: 'center',
    padding: 4,
    gap: 3,
  })
  const signLabel = app.create('uitext', {
    id: 'nft-door-status',
    textAlign: 'center',
    value: REQUIRED,
    color: 'white',
    fontSize: 16,
  })
  const hintLabel = app.create('uitext', {
    id: 'nft-door-hint',
    textAlign: 'center',
    value: passName,
    color: 'white',
    fontSize: 12,
  })
  doorSign.add(signLabel)
  doorSign.add(hintLabel)
  app.add(doorSign)
  // the pass panel; it becomes a link to the store after an answer that this wallet has no pass
  const panel = app.create('ui', {
    id: 'nft-door-pass-panel',
    width: 220,
    height: 40,
    backgroundColor: 'rgba(0, 0, 0, 0.7)',
    position: [1, 1.2, 0.5],
    billboard: 'full',
    justifyContent: 'center',
    alignItems: 'center',
    padding: 2,
  })
  const passLabel = app.create('uitext', {
    id: 'nft-door-pass',
    textAlign: 'center',
    value: 'Checking pass…',
    color: 'white',
    fontSize: 12,
  })
  panel.add(passLabel)
  app.add(panel)

  const openStore = () => world.open(storeUrl, true)
  const setStoreLink = on => {
    panel.onPointerDown = on ? openStore : null
    panel.cursor = on ? 'pointer' : null
  }

  const showStatus = () => {
    setStoreLink(false)
    signLabel.color = 'white'
    if (!status) {
      signLabel.value = REQUIRED
      hintLabel.value = passName
      passLabel.value = statusLost ? 'Pass: unknown' : 'Checking pass…'
    } else if (!status.verified) {
      signLabel.value = 'CONNECT EVM WALLET'
      hintLabel.value = 'Wallet button (upper right) → EVM → sign in'
      passLabel.value = 'EVM wallet not connected'
    } else if (!status.known) {
      signLabel.value = 'TRY AGAIN'
      hintLabel.value = ''
      passLabel.value = 'Pass: unknown'
    } else if (!status.holds) {
      signLabel.value = REQUIRED
      signLabel.color = '#ff0000'
      hintLabel.value = storeHost ? `Get the pass: ${storeHost}` : passName
      passLabel.value = storeUrl ? 'No pass · Get it here' : 'Pass: not held'
      setStoreLink(!!storeUrl)
    } else {
      signLabel.value = 'PASS VERIFIED'
      signLabel.color = '#00ff00'
      hintLabel.value = 'Open the door'
      passLabel.value = 'Pass: held'
    }
  }

  const showMessage = text => {
    signLabel.value = text
    signLabel.color = 'white'
    hintLabel.value = ''
  }

  // opens the door from where it is (closed or closing), or keeps an opening or open door open for another
  // DOOR_OPEN_TIME
  const openDoor = () => {
    openTimer = 0
    if (isOpen) return
    isOpen = true
    targetPosition = 1
    isMoving = true
  }

  const request = open => {
    nonce += 1
    if (open) openNonce = nonce
    waitSince = Date.now()
    if (app.send('nft-door:check', { run, nonce, open }) === false) {
      answered = nonce
      openNonce = 0
      showMessage('TRY AGAIN')
    }
  }

  const action = app.create('action', {
    id: 'nft-door-open',
    label: 'Open',
    position: [0, 1.5, 0],
    distance: 3,
  })
  action.onTrigger = () => {
    // ignored while the door moves or an earlier press waits for its answer. An open door is kept open only
    // after a fresh check, like the first time
    if (isMoving || openNonce) return
    showMessage('CHECKING…')
    request(true)
  }
  doorFrame.add(action)

  app.on('nft-door:result', result => {
    // an answer for an earlier build of this app, or for a request this build never sent
    if (result?.run !== run) return
    const number = Number.isSafeInteger(result.nonce) ? result.nonce : 0
    if (number < 1 || number > nonce) return
    // an Open answer that arrives after the timeout (eg after a long pause, before the next frame has
    // timed it out) is shown, but the press has expired and does not open the door
    if (openNonce && Date.now() - waitSince >= ANSWER_TIMEOUT_MS) openNonce = 0
    answered = Math.max(answered, number)
    status = { verified: result.verified === true, known: result.known === true, holds: result.holds === true }
    // an Open press is waiting: only its own answer is shown (an older one only updates `status`)
    if (openNonce && number !== openNonce) return
    const forOpen = openNonce !== 0
    openNonce = 0
    showStatus()
    if (forOpen && result.open === true && status.verified && status.known && status.holds) {
      showMessage('ACCESS GRANTED')
      signLabel.color = '#00ff00'
      openDoor()
    }
  })

  // the status shown before anyone presses Open; a player without a verified EVM wallet costs no RPC read
  request(false)

  app.on('update', dt => {
    if (answered < nonce) {
      if (Date.now() - waitSince >= ANSWER_TIMEOUT_MS) {
        answered = nonce
        if (openNonce) {
          openNonce = 0
          showMessage('TRY AGAIN')
        } else if (!statusRetried) {
          statusRetried = true
          request(false)
        } else if (!status) {
          statusLost = true
          showStatus()
        }
      }
    }
    if (isOpen && !isMoving) {
      openTimer += dt
      if (openTimer >= DOOR_OPEN_TIME) {
        isOpen = false
        targetPosition = 0
        isMoving = true
        openTimer = 0
        // back to the newest status, eg CONNECT EVM WALLET after a disconnect while the door was open
        if (!openNonce) showStatus()
      }
    }
    if (!isMoving) return
    const movement = speed * dt
    currentPosition = isOpen ? Math.min(currentPosition + movement, 1) : Math.max(currentPosition - movement, 0)
    const directionMultiplier = props.direction === '1' ? -1 : 1
    const slideDistance = Math.min(Math.max(parseFloat(props.slideDistance) || 1.8, 0.5), 2)
    const maxRotation = Math.min(Math.max(parseFloat(props.maxRotation) || 45, 0), 90) * (Math.PI / 180)
    if (props.type !== '2') {
      const offset = slideDistance * currentPosition
      doorL.rotation.y = initialL.rotation.y
      doorR.rotation.y = initialR.rotation.y
      doorL.position.x = initialL.position.x - offset
      doorR.position.x = initialR.position.x + offset
    } else {
      const angle = maxRotation * currentPosition * directionMultiplier
      doorL.position.x = initialL.position.x
      doorR.position.x = initialR.position.x
      doorL.rotation.y = initialL.rotation.y + angle
      doorR.rotation.y = initialR.rotation.y - angle
    }
    if (currentPosition === targetPosition) isMoving = false
  })
}
