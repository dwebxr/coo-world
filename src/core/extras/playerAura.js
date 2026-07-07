import { createNode } from './createNode'

export function createPlayerAura({ label, health, bubbleId } = {}) {
  const aura = createNode('group')

  const nametag = createNode('nametag', { label, health, active: false })
  aura.add(nametag)

  const bubble = createNode('ui', {
    id: bubbleId,
    width: 300,
    height: 512,
    pivot: 'bottom-center',
    billboard: 'full',
    scaler: [3, 30],
    justifyContent: 'flex-end',
    alignItems: 'center',
    active: false,
  })
  const bubbleBox = createNode('uiview', {
    backgroundColor: 'rgba(0, 0, 0, 0.8)',
    borderRadius: 10,
    padding: 10,
  })
  const bubbleText = createNode('uitext', {
    color: 'white',
    fontWeight: 100,
    lineHeight: 1.4,
    fontSize: 16,
  })
  bubble.add(bubbleBox)
  bubbleBox.add(bubbleText)
  aura.add(bubble)

  return { aura, nametag, bubble, bubbleBox, bubbleText }
}

export function chatBubble(player, msg) {
  player.nametag.active = false
  player.bubbleText.value = msg
  player.bubble.active = true
  clearTimeout(player.chatTimer)
  player.chatTimer = setTimeout(() => {
    player.bubble.active = false
    player.nametag.active = true
  }, 5000)
}
