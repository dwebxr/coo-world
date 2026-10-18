// Production hierarchy, built locally instead of loading the owner's GLB.
// Only the fixture construction differs; the remainder matches .notes/tokengate/door.js.
for (const child of app.children) app.remove(child)
app.add(
  app.create('prim', {
    id: 'token-door-floor',
    type: 'box',
    size: [20, 0.5, 20],
    position: [0, -0.25, 0],
    color: '#555555',
    physics: 'static',
  })
)
function panel(id, type, position, size, center, yaw, color) {
  const node = app.create('rigidbody', { id, type, position, rotation: [0, yaw, 0] })
  node.add(app.create('collider', { type: 'box', width: size[0], height: size[1], depth: size[2], position: center }))
  node.add(app.create('prim', { type: 'box', size, position: center, color }))
  app.add(node)
}
panel('Frame', 'static', [0, 0, 0], [2, 0.47, 0.3], [0, 2.115, 0], 0, '#666666')
panel('LeftDoor', 'kinematic', [0.01, 0, 0], [0.77, 2.26, 0.15], [0.385, 1.13, 0], 0.02, '#336699')
panel('RightDoor', 'kinematic', [-0.01, 0, 0], [0.77, 2.26, 0.15], [-0.385, 1.13, 0], -0.02, '#336699')

// The gate and animation below are also used verbatim by test/e2e/apps/token-door.js.
app.configure(() => [
  { key: 'solana', type: 'section', label: 'Solana Settings' },
  { key: 'minimumAmount', type: 'number', label: 'Gated amount', defaultValue: 1 },
  { key: 'tokenSymbol', type: 'text', label: 'Token Symbol', defaultValue: 'COO', placeholder: 'COO' },
  { key: 'door', type: 'section', label: 'Door Settings' },
  {
    key: 'type',
    type: 'switch',
    label: 'Door Type',
    options: [
      { label: 'Sliding', value: '1' },
      { label: 'Swinging', value: '2' },
    ],
    defaultValue: '1',
  },
  { key: 'slideDistance', type: 'textarea', label: 'Slide Distance', defaultValue: '1.8', placeholder: '1.8' },
  { key: 'maxRotation', type: 'textarea', label: 'Swing Angle', defaultValue: '45', placeholder: '45' },
  {
    key: 'direction',
    type: 'switch',
    label: 'Direction',
    options: [
      { label: 'Inward', value: '1' },
      { label: 'Outward', value: '2' },
    ],
    defaultValue: '2',
  },
])

if (world.isClient) {
  const doorFrame = app.get('Frame')
  // The production model's panel names are reversed relative to the animation variables.
  const doorR = app.get('LeftDoor')
  const doorL = app.get('RightDoor')
  const initialL = { position: doorL.position.clone(), rotation: doorL.rotation.clone() }
  const initialR = { position: doorR.position.clone(), rotation: doorR.rotation.clone() }
  const minimumAmount = Number.isFinite(Number(app.config.minimumAmount)) ? Number(app.config.minimumAmount) : 1
  const tokenSymbol = app.config.tokenSymbol || 'COO'
  const required = `${tokenSymbol} REQUIRED: ${minimumAmount}`
  const DOOR_OPEN_TIME = 3
  const speed = 2
  let isOpen = false
  let isMoving = false
  let currentPosition = 0
  let targetPosition = 0
  let openTimer = 0
  let checking = false
  let walletRevision = 0

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
    id: 'token-door-status',
    textAlign: 'center',
    value: required,
    color: 'white',
    fontSize: 16,
  })
  const hintLabel = app.create('uitext', {
    id: 'token-door-hint',
    textAlign: 'center',
    value: '',
    color: 'white',
    fontSize: 12,
  })
  doorSign.add(signLabel)
  doorSign.add(hintLabel)
  app.add(doorSign)
  const ui = app.create('ui', {
    width: 220,
    height: 40,
    backgroundColor: 'rgba(0, 0, 0, 0.7)',
    position: [1, 1.2, 0.5],
    billboard: 'full',
    justifyContent: 'center',
    alignItems: 'center',
    padding: 2,
  })
  const balanceLabel = app.create('uitext', {
    id: 'token-door-balance',
    textAlign: 'center',
    value: 'Wallet not connected',
    color: 'white',
    fontSize: 12,
  })
  ui.add(balanceLabel)
  app.add(ui)

  const formatBalance = balance => {
    const formatted = balance.toLocaleString('en-US', { maximumFractionDigits: 2 })
    if (formatted !== String(balance)) return formatted
    // SES tames toLocaleString and omits Intl. Round decimal digits and group locally.
    const [coefficient, exponent = '0'] = String(balance).split('e')
    const [whole, fraction = ''] = coefficient.split('.')
    const shift = Number(exponent) - fraction.length + 2
    let cents = BigInt(whole + fraction)
    if (shift >= 0) cents *= 10n ** BigInt(shift)
    else {
      const divisor = 10n ** BigInt(-shift)
      cents = (cents + divisor / 2n) / divisor
    }
    const integer = (cents / 100n).toString().replace(/\B(?=(\d{3})+(?!\d))/g, ',')
    const decimal = (cents % 100n).toString().padStart(2, '0').replace(/0+$/, '')
    return decimal ? `${integer}.${decimal}` : integer
  }

  const showBalance = result => {
    balanceLabel.value =
      result?.verified && result.known
        ? `Your Balance: ${formatBalance(result.balance)} ${tokenSymbol}`
        : 'Wallet not connected'
  }

  const refreshBalance = async () => {
    const revision = walletRevision
    try {
      const result = await world.getPlayer().getTokenBalance()
      if (revision === walletRevision) showBalance(result)
    } catch {
      if (revision !== walletRevision) return
      showBalance(null)
      signLabel.value = 'TRY AGAIN'
    }
  }

  const openDoor = () => {
    if (isMoving) return
    openTimer = 0
    if (isOpen) return
    isOpen = true
    targetPosition = 1
    isMoving = true
  }

  const action = app.create('action', {
    id: 'token-door-open',
    label: 'Open',
    position: [0, 1.5, 0],
    distance: 3,
  })
  action.onTrigger = async () => {
    if (checking || isMoving) return
    checking = true
    const revision = walletRevision
    signLabel.value = 'CHECKING…'
    signLabel.color = 'white'
    hintLabel.value = ''
    try {
      const result = await world.getPlayer().getTokenBalance()
      if (revision !== walletRevision) return
      showBalance(result)
      if (!result.verified) {
        signLabel.value = 'CONNECT WALLET'
        hintLabel.value = '右上のウォレットボタンで接続して署名してください'
      } else if (!result.known) {
        signLabel.value = 'TRY AGAIN'
      } else if (result.balance < minimumAmount) {
        signLabel.value = `INSUFFICIENT ${tokenSymbol}`
        signLabel.color = '#ff0000'
      } else {
        signLabel.value = 'ACCESS GRANTED'
        signLabel.color = '#00ff00'
        openDoor()
      }
    } catch {
      if (revision !== walletRevision) return
      showBalance(null)
      signLabel.value = 'TRY AGAIN'
    } finally {
      checking = false
    }
  }
  doorFrame.add(action)
  world.on('wallet', () => {
    walletRevision++
    hintLabel.value = ''
    signLabel.value = required
    signLabel.color = 'white'
    refreshBalance()
  })
  refreshBalance()

  app.on('update', dt => {
    if (isOpen && !isMoving) {
      openTimer += dt
      if (openTimer >= DOOR_OPEN_TIME) {
        isOpen = false
        targetPosition = 0
        isMoving = true
        openTimer = 0
        signLabel.value = required
        signLabel.color = 'white'
      }
    }
    if (!isMoving) return
    const movement = speed * dt
    currentPosition = isOpen ? Math.min(currentPosition + movement, 1) : Math.max(currentPosition - movement, 0)
    const directionMultiplier = app.config.direction === '1' ? -1 : 1
    const slideDistance = Math.min(Math.max(parseFloat(app.config.slideDistance) || 1.8, 0.5), 2)
    const maxRotation = Math.min(Math.max(parseFloat(app.config.maxRotation) || 45, 0), 90) * (Math.PI / 180)
    if (app.config.type !== '2') {
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
