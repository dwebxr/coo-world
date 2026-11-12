// What the tip form tells the payer (client only, no dependencies): how a send ended, the note this browser keeps
// of a request to the wallet, look-alike names, and the texts. Used by src/client/evm-integration.js and
// src/client/components/TipForm.js.
//
// All of it is information for the payer, not a control. Anything running in the page (an app script that got
// out of its sandbox, an extension) can change both what the form shows and what the wallet is asked. Nor does
// this file limit an amount: the built-in tokens have a maximum per tip (1,000 JPYC, 10 USDC; evmTokens.js), a
// custom token has one only if its spec gives it, and none of this limits what code running in the page asks a
// wallet for.

// 0x1563…5508: enough to compare with a wallet's own short form, not the address itself
export const shortTipAddress = address =>
  typeof address === 'string' && /^0x[0-9a-fA-F]{40}$/.test(address)
    ? `${address.slice(0, 6)}…${address.slice(-4)}`
    : ''

// --- how a send ended ---

// An explicit rejection is judged from the wallet's own error and from nothing else: EIP-1193 code 4001. The
// WalletConnect adapter turns its wallets' rejection codes and texts into that code (walletconnect.js,
// `normalize`). A wallet that sent the transfer and then reported a rejection is not noticed here.
export const isWalletRejection = error => error?.code === 4001

// A wallet that was asked to send and did not answer with a transaction hash or an explicit rejection: the
// transfer may have left the wallet. `request` is what was asked ({ name, address, amount, token, at }; `at`:
// when the intent arrived).
export const tipUnknownOutcome = request => ({ ok: false, reason: 'outcome_unknown', request })

// An error thrown while tipping. `requested`: eth_sendTransaction had been handed to the wallet.
// - before that, nothing can have been sent: 'rejected' (4001, eg a refused network switch) or 'failed';
// - after it, only an explicit rejection is a known "not sent"; a dropped WalletConnect session, a relay
//   timeout or an internal wallet error say nothing about the transfer.
export function tipErrorOutcome(error, requested, request) {
  if (isWalletRejection(error)) return { ok: false, reason: 'rejected' }
  if (!requested) return { ok: false, reason: 'failed' }
  return tipUnknownOutcome(request)
}

// --- the note of a request (localStorage) ---

// Written just before the wallet is asked to send, with the time of that moment, and removed once the result was
// handed to this world (or the wallet explicitly rejected). What is left after a reload (iOS often comes back
// from the wallet app as one) or a lost connection is shown for ten minutes from that time: "a tip may have been
// sent". It is this browser's memory of a request, not a record of a payment: it says nothing about what the
// wallet did, another browser or a cleared storage never sees it, and anything running on this origin in this
// browser profile can read, write or remove it. Nothing removes a note while no page of this site is open: an old
// note stays in the storage until a page next reads the notes.
// Each request's note has a key of its own: TIP_MARKER_PREFIX and the note's id (16 hex digits, made when it is
// written). A request that ends removes its own key and no other, and Dismiss removes the key of the note it is
// shown beside: nothing is read to decide what to remove, so what another tab writes meanwhile stays.
// Reading never removes a note that is well formed and not expired: it gives all of them, newest first. It
// removes, under the prefix, a note that is expired (ten minutes after its own time), one whose time is more than
// ten minutes ahead of the reader's clock, a value that is not a note, longer than MARKER_TEXT_MAX or kept under a
// key that is not its own. A read looks at every key of this origin's storage and reads the values under the prefix:
// what bounds that is the browser's own limit on the storage (a few megabytes), nothing here. With a storage that
// answers and that no other tab changes during the read, every live note is found, whatever else was put under the
// prefix. A read that another tab's change cut short, or in which a value could not be read, gives fewer: the page
// reads again a moment after the browser tells it of another tab's change (TipForm.js), a read with an unreadable
// value says so (`incomplete`), and what the notice counts is the notes that were read.
export const TIP_MARKER_PREFIX = 'evmTipRequest:'
export const TIP_MARKER_TTL_MS = 600_000
// the notice shows this many, and says how many more there are
export const TIP_MARKERS_SHOWN = 4
// a note is a few hundred characters (a name of 256 at most); a longer value under the prefix is not parsed
const MARKER_TEXT_MAX = 2048

const isMarker = value =>
  !!value &&
  typeof value === 'object' &&
  typeof value.name === 'string' &&
  value.name.length <= 256 &&
  typeof value.address === 'string' &&
  /^0x[0-9a-fA-F]{4}…[0-9a-fA-F]{4}$/.test(value.address) &&
  typeof value.amount === 'string' &&
  /^\d{1,18}(\.\d{1,18})?$/.test(value.amount) &&
  typeof value.token === 'string' &&
  /^[A-Z0-9]{1,11}$/.test(value.token) &&
  Number.isFinite(value.at) &&
  typeof value.id === 'string' &&
  /^[0-9a-f]{16}$/.test(value.id)

const pickMarker = ({ name, address, amount, token, at, id }) => ({ name, address, amount, token, at, id })

// 16 hex digits from the browser's random source: tells one request's note from another's, nothing more
const markerId = () =>
  Array.from(globalThis.crypto.getRandomValues(new Uint8Array(8)), byte => byte.toString(16).padStart(2, '0')).join('')

// `backend`: returns the Storage (read on each call: reading the global can itself throw, storage.js). Every
// access is wrapped: storage that is missing, blocked or full must never stop the form or the send.
// `request`: { name, address, amount, token, at }. Returns the id of the note written, or null when none was.
export function writeTipMarker(backend, request) {
  try {
    const marker = pickMarker({ ...request, id: markerId() })
    if (!isMarker(marker)) return null
    backend().setItem(TIP_MARKER_PREFIX + marker.id, JSON.stringify(marker))
    return marker.id
  } catch {
    return null
  }
}

// The request with this id ended, or its note was dismissed: its key is removed, and no other. A request that
// wrote no note (no id) removes nothing.
export function clearTipMarker(backend, id) {
  if (typeof id !== 'string') return
  try {
    backend().removeItem(TIP_MARKER_PREFIX + id)
  } catch {
    // nothing to remove, or nothing that can be removed
  }
}

// The notes, newest first (see above). A note whose time is up to ten minutes ahead of `now` (another tab's clock,
// or this one set back) is kept and expires ten minutes after its own time, so at most twenty minutes from now. A
// key whose value cannot be read is left as it is and not shown. The array then has `incomplete: true`.
export function readTipMarkers(backend, now) {
  let storage
  const keys = []
  try {
    storage = backend()
    for (let i = 0; i < storage.length; i++) {
      const key = storage.key(i)
      if (typeof key === 'string' && key.startsWith(TIP_MARKER_PREFIX)) keys.push(key)
    }
  } catch {
    return []
  }
  const remove = key => {
    try {
      storage.removeItem(key)
    } catch {
      // nothing that can be removed
    }
  }
  const notes = []
  let incomplete = false
  for (const key of keys) {
    let text
    try {
      text = storage.getItem(key)
    } catch {
      incomplete = true
      continue
    }
    let value = null
    try {
      if (typeof text === 'string' && text.length <= MARKER_TEXT_MAX) value = JSON.parse(text)
    } catch {
      value = null
    }
    const kept =
      isMarker(value) &&
      key === TIP_MARKER_PREFIX + value.id &&
      now - value.at < TIP_MARKER_TTL_MS &&
      value.at - now <= TIP_MARKER_TTL_MS
    if (kept) notes.push(pickMarker(value))
    else remove(key)
  }
  notes.sort((a, b) => b.at - a.at || (a.id < b.id ? -1 : 1))
  // a value that could not be read may have been a note: the caller is told that these are not all
  if (incomplete) notes.incomplete = true
  return notes
}

// under the notes the notice shows, when there are more of them, or when a value could not be read (`incomplete`:
// the count is then of the notes that were read, and there may be others)
export const tipMarkerMoreText = (count, incomplete = false) => {
  if (incomplete && count === 0) return 'Other notes like these may be kept in this browser: some could not be read.'
  const more =
    count === 1
      ? '1 more note like these is kept in this browser. It is shown here when one of these is dismissed.'
      : `${count} more notes like these are kept in this browser. They are shown here as these are dismissed.`
  return incomplete ? `At least ${more} Some could not be read.` : more
}

// how long a note read at `now` is still shown
export const tipMarkerRemainingMs = (marker, now) => Math.max(0, marker.at + TIP_MARKER_TTL_MS - now)

// --- look-alike names ---

// Names are free text and not unique. Two names count as the same when they are equal after Unicode NFKC
// (full-width "Ｂｏｂ" folds to "Bob"), collapsing every run of white space (tabs, line breaks and the Unicode
// spaces included) to one space, removing characters that are not drawn (zero-width and other
// default-ignorable, control and format characters), lower-casing, and trimming and collapsing white space
// again. The white space goes first: a tab or a line break is a control character too, and removing it would
// join the words ("Bob\tSmith", drawn as "Bob Smith", would read as "bobsmith").
// NOT caught: look-alike letters of another script (Cyrillic "Воb" is a different name here), and any name
// that merely resembles another. The warning is a hint to look twice, nothing more.
export const normalizeTipName = name =>
  typeof name === 'string'
    ? name
        .normalize('NFKC')
        .replace(/\p{White_Space}+/gu, ' ')
        .replace(/[\p{Default_Ignorable_Code_Point}\p{Cc}\p{Cf}]/gu, '')
        .toLowerCase()
        .replace(/\s+/g, ' ')
        .trim()
    : ''

// true when a connected player other than the recipient (and other than the payer) has the recipient's name.
// `players`: the player entities ({ data: { id, name } })
export function hasNameTwin(players, recipientId, selfId) {
  let wanted = null
  const others = []
  for (const player of players) {
    const id = player?.data?.id
    if (id === recipientId) wanted = normalizeTipName(player.data.name)
    else if (id !== selfId) others.push(normalizeTipName(player?.data?.name))
  }
  return !!wanted && others.includes(wanted)
}

// --- texts ---

// A name is free text: one with bidirectional controls in it (U+202E RIGHT-TO-LEFT OVERRIDE and the like) would
// reorder what follows it on the line, the address and the rest of the sentence. These texts show the name
// without those characters, and come in parts (strings, { name } and { address }) so that the form renders the
// name isolated in a <bdi> of its own and the address in an element of its own with dir="ltr" (TipText in
// TipForm.js); tipText joins the parts where one string is wanted. Only the texts built here: the player's name
// elsewhere in the interface (the tip form's title and confirmation sentence, the Players list, nametags, chat)
// is shown as before.
const BIDI_CONTROLS = /[\u061C\u200E\u200F\u202A-\u202E\u2066-\u2069]/g
export const tipShownName = name => (typeof name === 'string' ? name.replace(BIDI_CONTROLS, '') : '')

export const tipText = parts =>
  parts.map(part => (typeof part === 'string' ? part : (part.name ?? part.address))).join('')

const whom = request => {
  const name = { name: tipShownName(request?.name) }
  return request?.address ? [name, ' (', { address: request.address }, ')'] : [name]
}

// the sending step: who is about to be paid, once the server's tip intent has arrived
export const tipRecipientParts = request => [
  'To ',
  { name: tipShownName(request.name) },
  ' · ',
  { address: request.address },
]
export const tipRecipientText = request => tipText(tipRecipientParts(request))

// For an ERC-20 transfer the wallet's "to" is the token's contract; the recipient is inside the call data, which
// some mobile wallets do not decode at all. The form never promises what a wallet will show.
export const TIP_WALLET_VIEW_TEXT =
  'Your wallet may show the token contract as the destination, and may not show this address at all.'

export const tipSentParts = request => [`Sent ${request.amount} ${request.token} to `, ...whom(request), '.']
export const tipSentText = request => tipText(tipSentParts(request))

export const tipUnknownParts = request => [
  `The wallet did not give a clear answer. Your tip of ${request.amount} ${request.token} to `,
  ...whom(request),
  " may have been sent: check your wallet's activity before trying again.",
]
export const tipUnknownText = request => tipText(tipUnknownParts(request))

export const tipMarkerParts = marker => [
  `A tip may have been sent: ${marker.amount} ${marker.token} to `,
  ...whom(marker),
  ". This browser asked your wallet for it and this world did not get the result. Check your wallet's activity before sending it again.",
]
export const tipMarkerText = marker => tipText(tipMarkerParts(marker))

export const TIP_NAME_TWIN_TEXT = 'Another player here has the same name. Check that this is the one you mean.'

// The world has no chain RPC to watch with, or its RPC left the `finalized` tag unanswered. "May not": after a
// `no_finality` a later read of the tag can work, and a tip sent meanwhile can still be confirmed and announced.
export const TIP_UNCONFIRMED_TEXT =
  'This world is not confirming tips right now. The transfer still goes through your wallet and may not be confirmed or announced here.'
