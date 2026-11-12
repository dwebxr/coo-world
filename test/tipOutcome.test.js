import { test } from 'node:test'
import assert from 'node:assert/strict'
import {
  TIP_MARKERS_SHOWN,
  TIP_MARKER_PREFIX,
  TIP_MARKER_TTL_MS,
  TIP_NAME_TWIN_TEXT,
  TIP_UNCONFIRMED_TEXT,
  TIP_WALLET_VIEW_TEXT,
  clearTipMarker,
  hasNameTwin,
  isWalletRejection,
  normalizeTipName,
  readTipMarkers,
  shortTipAddress,
  tipErrorOutcome,
  tipMarkerMoreText,
  tipMarkerParts,
  tipMarkerRemainingMs,
  tipMarkerText,
  tipRecipientParts,
  tipRecipientText,
  tipSentParts,
  tipSentText,
  tipShownName,
  tipText,
  tipUnknownOutcome,
  tipUnknownParts,
  tipUnknownText,
  writeTipMarker,
} from '../src/core/extras/tipOutcome.js'

const ADDRESS = '0x1563915e194D8CfBA1943570603F7606A3115508'
const request = Object.freeze({ name: 'Bob', address: '0x1563…5508', amount: '100', token: 'JPYC', at: 1_000_000 })

// a Storage as the page has it: keys in the order they were set, `length` and `key(i)` to go through them
function fakeStorage() {
  const items = new Map()
  return {
    items,
    get length() {
      return items.size
    },
    key: index => [...items.keys()][index] ?? null,
    getItem: key => (items.has(key) ? items.get(key) : null),
    setItem: (key, value) => void items.set(key, String(value)),
    removeItem: key => void items.delete(key),
  }
}
// the same storage with one method replaced (the rest, `length` included, still the storage's)
const withMethod = (storage, name, fn) => Object.create(storage, { [name]: { value: fn } })
const denied = () => {
  throw new DOMException('The operation is insecure.', 'SecurityError')
}
// a note's id: 16 hex digits, made when the note is written
const MARKER_ID = /^[0-9a-f]{16}$/
const ID = '0123456789abcdef'
const KEY = id => `${TIP_MARKER_PREFIX}${id}`
// the notes kept in a storage, by key
const stored = storage =>
  Object.fromEntries([...storage.items].filter(([key]) => key.startsWith(TIP_MARKER_PREFIX)).map(([k, v]) => [k, v]))

test('tip outcome: the short address is the first six and last four characters of an address, else nothing', () => {
  assert.equal(shortTipAddress(ADDRESS), '0x1563…5508')
  assert.equal(shortTipAddress(ADDRESS.toLowerCase()), '0x1563…5508')
  for (const value of [undefined, null, '', '0x1563', `${ADDRESS}00`, ADDRESS.slice(2), 12, { length: 42 }]) {
    assert.equal(shortTipAddress(value), '', String(value))
  }
})

test('tip outcome: only code 4001 is an explicit rejection', () => {
  assert.equal(isWalletRejection(Object.assign(new Error('User rejected the request.'), { code: 4001 })), true)
  assert.equal(isWalletRejection({ code: 4001 }), true)
  for (const error of [
    new Error('User rejected the request.'),
    Object.assign(new Error('x'), { code: '4001' }),
    Object.assign(new Error('x'), { code: 4100 }),
    Object.assign(new Error('x'), { code: -32603 }),
    'rejected',
    null,
    undefined,
  ]) {
    assert.equal(isWalletRejection(error), false, String(error?.message ?? error))
  }
})

test('tip outcome: an error after the wallet was asked to send is unknown unless it is an explicit rejection', () => {
  const rejection = Object.assign(new Error('User rejected the request.'), { code: 4001 })
  const dropped = Object.assign(new Error('The WalletConnect session ended.'), { code: 4100 })
  // before the request nothing can have been sent
  assert.deepEqual(tipErrorOutcome(rejection, false, null), { ok: false, reason: 'rejected' })
  assert.deepEqual(tipErrorOutcome(dropped, false, null), { ok: false, reason: 'failed' })
  assert.deepEqual(tipErrorOutcome(new Error('wrong chain'), false, null), { ok: false, reason: 'failed' })
  assert.deepEqual(tipErrorOutcome(undefined, false, null), { ok: false, reason: 'failed' })
  // a request that is known but was not handed to the wallet yet changes nothing
  assert.deepEqual(tipErrorOutcome(dropped, false, request), { ok: false, reason: 'failed' })
  // after it
  assert.deepEqual(tipErrorOutcome(rejection, true, request), { ok: false, reason: 'rejected' })
  for (const error of [dropped, new Error('relay timeout'), { code: -32603 }, 'text', null, undefined]) {
    const outcome = tipErrorOutcome(error, true, request)
    assert.deepEqual(outcome, { ok: false, reason: 'outcome_unknown', request }, String(error?.message ?? error))
    // the outcome carries whom, how much and of what
    assert.equal(outcome.request.name, 'Bob')
    assert.equal(outcome.request.address, '0x1563…5508')
    assert.equal(outcome.request.amount, '100')
    assert.equal(outcome.request.token, 'JPYC')
  }
  assert.deepEqual(tipUnknownOutcome(request), { ok: false, reason: 'outcome_unknown', request })
})

test('tip marker: written under a key of its own, read back for ten minutes, then removed', () => {
  const storage = fakeStorage()
  const backend = () => storage
  assert.equal(TIP_MARKER_PREFIX, 'evmTipRequest:')
  assert.deepEqual(readTipMarkers(backend, 1_000_000), [])
  const id = writeTipMarker(backend, request)
  assert.match(id, MARKER_ID)
  assert.deepEqual([...storage.items.keys()], [KEY(id)])
  assert.deepEqual(JSON.parse(storage.items.get(KEY(id))), {
    name: 'Bob',
    address: '0x1563…5508',
    amount: '100',
    token: 'JPYC',
    at: 1_000_000,
    id,
  })
  assert.deepEqual(readTipMarkers(backend, 1_000_000), [{ ...request, id }])
  assert.equal(TIP_MARKER_TTL_MS, 600_000)
  assert.deepEqual(readTipMarkers(backend, 1_000_000 + 599_999), [{ ...request, id }])
  assert.equal(storage.items.has(KEY(id)), true, 'reading keeps it')
  assert.equal(tipMarkerRemainingMs(request, 1_000_000), 600_000)
  assert.equal(tipMarkerRemainingMs(request, 1_000_000 + 599_999), 1)
  assert.equal(tipMarkerRemainingMs(request, 1_000_000 + 700_000), 0)
  assert.deepEqual(readTipMarkers(backend, 1_000_000 + 600_000), [])
  assert.equal(storage.items.has(KEY(id)), false, 'an old note is removed, not only hidden')
  const later = writeTipMarker(backend, request)
  assert.notEqual(later, id, 'each note has an id of its own')
  clearTipMarker(backend, later)
  // cleared on a known result, or dismissed: by its id
  const known = writeTipMarker(backend, request)
  clearTipMarker(backend, known)
  assert.equal(storage.items.size, 0)
  // only the six fields are kept, whatever the object holds, and the id is the one made here
  const own = writeTipMarker(backend, { ...request, recipient: ADDRESS, txHash: '0xabc', id: ID })
  assert.notEqual(own, ID)
  assert.deepEqual([...storage.items.keys()], [KEY(own)])
  assert.deepEqual(Object.keys(JSON.parse(storage.items.get(KEY(own)))).sort(), [
    'address',
    'amount',
    'at',
    'id',
    'name',
    'token',
  ])
  assert.equal(JSON.parse(storage.items.get(KEY(own))).id, own)
})

test('tip marker: a request removes its own note and no other, whatever another tab writes meanwhile', () => {
  // two tabs of the site share one storage
  const storage = fakeStorage()
  const backend = () => storage
  // A's request ends while B writes: in either order, B's note stays (nothing is read to remove A's)
  for (const aFirst of [true, false]) {
    storage.items.clear()
    const a = writeTipMarker(backend, { ...request, amount: '1' })
    if (aFirst) clearTipMarker(backend, a)
    const b = writeTipMarker(backend, { ...request, amount: '2', at: 1_000_001 })
    if (!aFirst) clearTipMarker(backend, a)
    assert.deepEqual(readTipMarkers(backend, 1_000_000), [{ ...request, amount: '2', at: 1_000_001, id: b }])
    // B's ends: gone
    clearTipMarker(backend, b)
    assert.deepEqual(stored(storage), {})
  }
  // A's removal reads nothing: a storage whose reads throw still loses A's note, and only A's
  const unreadable = withMethod(storage, 'getItem', () => assert.fail('read'))
  const one = writeTipMarker(backend, request)
  const two = writeTipMarker(backend, request)
  clearTipMarker(() => unreadable, one)
  assert.deepEqual(Object.keys(stored(storage)), [KEY(two)])
  // a request that wrote no note (no id) removes none, and does not touch the storage
  let touched = 0
  for (const none of [null, undefined, 7, {}]) {
    clearTipMarker(() => (touched++, storage), none)
    assert.deepEqual(Object.keys(stored(storage)), [KEY(two)], String(none))
  }
  assert.equal(touched, 0)
  // other keys are left alone
  storage.items.set('prefs', '{}')
  clearTipMarker(backend, two)
  assert.deepEqual([...storage.items.keys()], ['prefs'])
})

test('tip marker: every live note is read, newest first; none is removed for being one too many', () => {
  const storage = fakeStorage()
  const backend = () => storage
  assert.equal(TIP_MARKERS_SHOWN, 4)
  const ids = [1, 2, 3].map(n => writeTipMarker(backend, { ...request, amount: String(n), at: 1_000_000 + n }))
  assert.deepEqual(
    readTipMarkers(backend, 1_000_010).map(note => note.amount),
    ['3', '2', '1']
  )
  // the one in the middle is dismissed: the other two stay
  clearTipMarker(backend, ids[1])
  assert.deepEqual(
    readTipMarkers(backend, 1_000_010).map(note => note.id),
    [ids[2], ids[0]]
  )
  // five and nine notes: all are read, and all are kept in the storage
  for (const count of [5, 9]) {
    storage.items.clear()
    const written = Array.from({ length: count }, (_, n) =>
      writeTipMarker(backend, { ...request, amount: String(n + 1), at: 1_000_001 + n })
    )
    const read = readTipMarkers(backend, 1_000_100)
    assert.deepEqual(
      read.map(note => note.amount),
      written.map((_, n) => String(count - n)),
      String(count)
    )
    assert.equal(Object.keys(stored(storage)).length, count, `${count}: none removed`)
    // the oldest is dismissed: the others stay, and nothing else goes
    clearTipMarker(backend, written[0])
    assert.equal(readTipMarkers(backend, 1_000_100).length, count - 1)
    assert.equal(Object.keys(stored(storage)).length, count - 1)
  }
  // each note has its own ten minutes
  storage.items.clear()
  const old = writeTipMarker(backend, { ...request, at: 1_000_000 })
  const young = writeTipMarker(backend, { ...request, at: 1_300_000 })
  assert.deepEqual(
    readTipMarkers(backend, 1_599_999).map(note => note.id),
    [young, old]
  )
  assert.deepEqual(
    readTipMarkers(backend, 1_600_000).map(note => note.id),
    [young]
  )
  assert.deepEqual(Object.keys(stored(storage)), [KEY(young)])
  assert.deepEqual(readTipMarkers(backend, 1_900_000), [])
  assert.deepEqual(stored(storage), {})
})

test('tip marker: a note up to ten minutes ahead of the reader is kept and expires ten minutes after its own time', () => {
  const storage = fakeStorage()
  const backend = () => storage
  const now = 5_000_000
  // exactly ten minutes ahead: a note, with twenty minutes left
  const ahead = writeTipMarker(backend, { ...request, at: now + TIP_MARKER_TTL_MS })
  assert.deepEqual(readTipMarkers(backend, now), [{ ...request, at: now + TIP_MARKER_TTL_MS, id: ahead }])
  assert.equal(tipMarkerRemainingMs({ at: now + TIP_MARKER_TTL_MS }, now), 2 * TIP_MARKER_TTL_MS)
  // a millisecond more: not a note, and removed
  const beyond = writeTipMarker(backend, { ...request, at: now + TIP_MARKER_TTL_MS + 1 })
  assert.deepEqual(
    readTipMarkers(backend, now).map(note => note.id),
    [ahead]
  )
  assert.equal(storage.items.has(KEY(beyond)), false)
  // the kept one expires ten minutes after its own time: at most twenty minutes from the first read
  assert.equal(readTipMarkers(backend, now + 2 * TIP_MARKER_TTL_MS - 1).length, 1)
  assert.deepEqual(readTipMarkers(backend, now + 2 * TIP_MARKER_TTL_MS), [])
  assert.deepEqual(stored(storage), {})
})

test('tip marker: a read finds every live note, however many there are and whatever else is under the prefix', () => {
  const storage = fakeStorage()
  const backend = () => storage
  // 70 live notes: all are read, and nothing is removed
  const ids = Array.from({ length: 70 }, (_, n) => writeTipMarker(backend, { ...request, at: 1_000_000 + n }))
  const read = readTipMarkers(backend, 1_000_100)
  assert.equal(read.length, 70)
  assert.deepEqual(read.map(note => note.id).sort(), [...ids].sort())
  assert.equal(Object.keys(stored(storage)).length, 70)
  // 200 values that are not notes come first: the same read removes them and still finds the note behind them
  storage.items.clear()
  for (let n = 0; n < 200; n++) storage.items.set(KEY(n.toString(16).padStart(16, '0')), 'junk')
  const behind = writeTipMarker(backend, request)
  assert.deepEqual(readTipMarkers(backend, 1_000_000), [{ ...request, id: behind }])
  assert.deepEqual(Object.keys(stored(storage)), [KEY(behind)])
  // 200 notes timed ahead of a current one (another tab's clock) do not hide it
  storage.items.clear()
  for (let n = 0; n < 200; n++) writeTipMarker(backend, { ...request, at: 1_000_000 + TIP_MARKER_TTL_MS - n })
  const current = writeTipMarker(backend, request)
  const all = readTipMarkers(backend, 1_000_000)
  assert.equal(all.length, 201)
  assert.equal(all.at(-1).id, current)
  // keys outside the prefix are not read and not removed
  storage.items.clear()
  for (let n = 0; n < 100; n++) storage.items.set(`other:${n}`, 'x')
  const last = writeTipMarker(backend, request)
  let reads = 0
  const counting = withMethod(storage, 'getItem', key => (reads++, storage.getItem(key)))
  assert.deepEqual(
    readTipMarkers(() => counting, 1_000_000),
    [{ ...request, id: last }]
  )
  assert.equal(reads, 1)
  assert.equal(storage.items.size, 101)
})

test('tip marker: the line under the notes that the notice shows says how many more there are', () => {
  assert.equal(
    tipMarkerMoreText(1),
    '1 more note like these is kept in this browser. It is shown here when one of these is dismissed.'
  )
  assert.equal(
    tipMarkerMoreText(5),
    '5 more notes like these are kept in this browser. They are shown here as these are dismissed.'
  )
})

test('tip marker: what is not a note is neither written nor shown, and under the prefix it is removed', () => {
  const storage = fakeStorage()
  const backend = () => storage
  const bad = [
    null,
    undefined,
    'text',
    [],
    { ...request, name: 7 },
    { ...request, name: 'x'.repeat(257) },
    // a full address is never kept
    { ...request, address: ADDRESS },
    { ...request, address: '' },
    { ...request, amount: '1e3' },
    { ...request, amount: 100 },
    { ...request, token: 'jpyc' },
    { ...request, token: '<b>' },
    { ...request, at: '1000000' },
    { ...request, at: NaN },
    { ...request, at: Infinity },
  ]
  // an object as it would be stored: with an id (the write makes one), under that id's key
  const asStored = value => (value && typeof value === 'object' && !Array.isArray(value) ? { ...value, id: ID } : value)
  for (const value of bad) {
    assert.equal(writeTipMarker(backend, value), null, JSON.stringify(value))
    assert.equal(storage.items.size, 0)
    // the same thing found under the prefix (written by something else in the page) is removed, not shown
    storage.items.set(KEY(ID), JSON.stringify(asStored(value)) ?? 'undefined')
    assert.deepEqual(readTipMarkers(backend, 1_000_000), [], JSON.stringify(value))
    assert.equal(storage.items.size, 0, JSON.stringify(value))
  }
  // a note without an id, or with one that is not 16 hex digits, under the key its id would make
  for (const id of [undefined, '', 'ABCDEF0123456789', '0123456789abcde', '0123456789abcdef0', 7]) {
    storage.items.set(KEY(id), JSON.stringify({ ...request, id }))
    assert.deepEqual(readTipMarkers(backend, 1_000_000), [], String(id))
    assert.equal(storage.items.size, 0, String(id))
  }
  // a note kept under a key that is not its own (another note's, or a made-up one)
  storage.items.set(KEY('fedcba9876543210'), JSON.stringify({ ...request, id: ID }))
  storage.items.set(`${TIP_MARKER_PREFIX}x`, JSON.stringify({ ...request, id: ID }))
  storage.items.set(TIP_MARKER_PREFIX, JSON.stringify({ ...request, id: ID }))
  assert.deepEqual(readTipMarkers(backend, 1_000_000), [])
  assert.equal(storage.items.size, 0)
  // not JSON, or longer than a note can be (a valid note with 2,048 spaces after it)
  storage.items.set(KEY(ID), '{not json')
  assert.deepEqual(readTipMarkers(backend, 1_000_000), [])
  assert.equal(storage.items.size, 0)
  storage.items.set(KEY(ID), `${JSON.stringify({ ...request, id: ID })}${' '.repeat(2048)}`)
  assert.deepEqual(readTipMarkers(backend, 1_000_000), [])
  assert.equal(storage.items.size, 0)
  storage.items.set(KEY(ID), `${JSON.stringify({ ...request, id: ID })}${' '.repeat(100)}`)
  assert.deepEqual(readTipMarkers(backend, 1_000_000), [{ ...request, id: ID }], 'a little white space is read')
  storage.items.clear()
  // a note with more in it than a note has (something else in the page wrote it): only the six fields come back
  storage.items.set(KEY(ID), JSON.stringify({ ...request, id: ID, recipient: ADDRESS, html: '<b>' }))
  assert.deepEqual(readTipMarkers(backend, 1_000_000), [{ ...request, id: ID }])
  storage.items.clear()
  // keys outside the prefix are neither read nor removed, whatever they hold
  storage.items.set('prefs', '{}')
  storage.items.set('evmTipRequest', JSON.stringify({ ...request, id: ID }))
  storage.items.set(`x${TIP_MARKER_PREFIX}${ID}`, 'junk')
  assert.deepEqual(readTipMarkers(backend, 1_000_000), [])
  assert.deepEqual([...storage.items.keys()], ['prefs', 'evmTipRequest', `x${TIP_MARKER_PREFIX}${ID}`])
})

test('tip marker: storage that throws, or is not there, never throws to the caller', () => {
  const throwing = { length: 1, key: denied, getItem: denied, setItem: denied, removeItem: denied }
  for (const [name, backend] of [
    ['reading the global throws', denied],
    ['every method throws', () => throwing],
    ['undefined', () => undefined],
    ['null', () => null],
    ['not a storage', () => ({})],
  ]) {
    assert.equal(writeTipMarker(backend, request), null, name)
    assert.deepEqual(readTipMarkers(backend, 1_000_000), [], name)
    assert.equal(clearTipMarker(backend, ID), undefined, name)
  }
  // full: the write fails, and what was there before can still be read and removed
  const storage = fakeStorage()
  const id = writeTipMarker(() => storage, request)
  const full = withMethod(storage, 'setItem', denied)
  assert.equal(
    writeTipMarker(() => full, { ...request, amount: '5' }),
    null
  )
  assert.equal(readTipMarkers(() => full, 1_000_000)[0].amount, '100')
  // a value that cannot be read is neither shown nor removed
  const unreadable = withMethod(storage, 'getItem', denied)
  assert.deepEqual(
    readTipMarkers(() => unreadable, 1_000_000),
    []
  )
  assert.equal(storage.items.has(KEY(id)), true)
  // an old note that cannot be removed is still not shown
  const stuck = withMethod(storage, 'removeItem', denied)
  assert.deepEqual(
    readTipMarkers(() => stuck, 1_000_000 + TIP_MARKER_TTL_MS),
    []
  )
  // live notes are all read, whether or not anything can be removed
  for (let n = 0; n < 5; n++) writeTipMarker(() => storage, { ...request, at: 1_000_001 + n })
  assert.equal(readTipMarkers(() => stuck, 1_000_010).length, 6)
  assert.equal(
    clearTipMarker(() => stuck, id),
    undefined
  )
})

test('tip names: the same after NFKC, case, undrawn characters and white space', () => {
  assert.equal(normalizeTipName('Bob'), 'bob')
  // full-width letters fold
  assert.equal(normalizeTipName('Ｂｏｂ'), 'bob')
  assert.equal(normalizeTipName('ＢＯＢ'), 'bob')
  // compatibility forms fold too (a ligature, a circled letter)
  assert.equal(normalizeTipName('ﬁona'), 'fiona')
  assert.equal(normalizeTipName('Ⓑob'), 'bob')
  // surrounding and repeated white space (a page draws a run of spaces as one), also the ideographic space
  assert.equal(normalizeTipName('  Bob  '), 'bob')
  assert.equal(normalizeTipName('Bob　 Smith'), 'bob smith')
  assert.equal(normalizeTipName('bob  smith'), 'bob smith')
  assert.notEqual(normalizeTipName('bobsmith'), normalizeTipName('bob smith'))
  // characters that are not drawn: zero-width space and joiner, a direction mark, a soft hyphen
  assert.equal(normalizeTipName('B​o‍b‮'), 'bob')
  assert.equal(normalizeTipName('Bo­b'), 'bob')
  // composed and decomposed accents are one name; an accent is still a different name
  assert.equal(normalizeTipName('Zoë'), normalizeTipName('Zoë'))
  assert.notEqual(normalizeTipName('Zoë'), normalizeTipName('Zoe'))
  for (const value of [undefined, null, 7, {}, ['Bob']]) assert.equal(normalizeTipName(value), '')
})

test('tip names: a tab, a line break or a no-break space is one space, as a page draws it', () => {
  const plain = normalizeTipName('Bob Smith')
  assert.equal(plain, 'bob smith')
  for (const name of [
    'Bob\tSmith',
    'Bob\nSmith',
    'Bob\r\nSmith',
    'Bob\vSmith',
    'Bob\u0085Smith',
    'Bob\u00a0Smith',
    'Bob\u2003Smith',
    'Bob\u202fSmith',
    'Bob\u2028Smith',
    'Bob\u3000Smith',
    // mixed runs, and around the name
    'Bob \t\u00a0\n Smith',
    '\tBob\r\nSmith\u00a0',
    // a character that is not drawn inside a run of white space
    'Bob \u200b Smith',
    'Bob\t\u200b\tSmith',
  ]) {
    assert.equal(normalizeTipName(name), plain, JSON.stringify(name))
  }
  // where nothing is drawn between two letters there is still no space
  assert.equal(normalizeTipName('Bob\u200bSmith'), 'bobsmith')
  assert.equal(normalizeTipName('Bob\ufeffSmith'), 'bobsmith')
  // so another player named with a tab or a line break is the recipient's twin
  const players = (...names) => names.map((name, index) => ({ data: { id: `p${index}`, name } }))
  for (const twin of ['Bob\tSmith', 'Bob\nSmith', 'Bob\u00a0Smith', 'bob \t smith']) {
    assert.equal(hasNameTwin(players('Bob Smith', twin, 'Alice'), 'p0', 'p2'), true, JSON.stringify(twin))
    assert.equal(hasNameTwin(players(twin, 'Bob Smith', 'Alice'), 'p0', 'p2'), true, JSON.stringify(twin))
  }
})

test('tip names: a look-alike in another script is NOT caught (the documented miss)', () => {
  // Cyrillic В (U+0412) and о (U+043E) with a Latin b: drawn like "Bob" in most fonts, a different name here
  const cyrillic = 'Воb'
  assert.notEqual(normalizeTipName(cyrillic), normalizeTipName('Bob'))
  const players = [
    { data: { id: 'bob', name: 'Bob' } },
    { data: { id: 'fake', name: cyrillic } },
    { data: { id: 'me', name: 'Alice' } },
  ]
  assert.equal(hasNameTwin(players, 'bob', 'me'), false)
  // nor a name that only resembles another
  players[1].data.name = 'B0b'
  assert.equal(hasNameTwin(players, 'bob', 'me'), false)
  players[1].data.name = 'Bob_'
  assert.equal(hasNameTwin(players, 'bob', 'me'), false)
})

test('tip names: another connected player with the recipient’s name is a twin', () => {
  const players = (...names) => names.map((name, index) => ({ data: { id: `p${index}`, name } }))
  assert.equal(hasNameTwin(players('Bob', 'Carol', 'Alice'), 'p0', 'p2'), false)
  assert.equal(hasNameTwin(players('Bob', 'Bob', 'Alice'), 'p0', 'p2'), true)
  assert.equal(hasNameTwin(players('Bob', 'Ｂｏｂ', 'Alice'), 'p0', 'p2'), true, 'full-width')
  assert.equal(hasNameTwin(players('Bob', ' bOB​', 'Alice'), 'p0', 'p2'), true)
  // whichever of the two the form is open for
  assert.equal(hasNameTwin(players('Bob', 'Ｂｏｂ', 'Alice'), 'p1', 'p2'), true)
  // the payer's own name does not count: the payer has no Tip button to mistake for the recipient's
  assert.equal(hasNameTwin(players('Bob', 'Carol', 'bob'), 'p0', 'p2'), false)
  // any iterable of players (the client keeps a Map), in any order
  const map = new Map(players('Carol', 'bob', 'Bob').map(player => [player.data.id, player]))
  assert.equal(hasNameTwin(map.values(), 'p2', 'none'), true)
  // a recipient who is not in the list, or whose name is not text, has no twin; odd entries are skipped
  assert.equal(hasNameTwin(players('Bob', 'Bob'), 'gone', 'p9'), false)
  assert.equal(hasNameTwin([{ data: { id: 'p0', name: 7 } }, { data: { id: 'p1', name: 8 } }], 'p0', 'x'), false)
  assert.equal(hasNameTwin([null, {}, { data: { id: 'p0', name: 'Bob' } }, { data: { name: 'Bob' } }], 'p0', 'x'), true)
  assert.equal(hasNameTwin([], 'p0', 'x'), false)
})

test('tip texts: each outcome says what is known, and names whom, how much and of what', () => {
  assert.equal(tipRecipientText(request), 'To Bob · 0x1563…5508')
  assert.equal(tipSentText(request), 'Sent 100 JPYC to Bob (0x1563…5508).')
  assert.equal(
    tipUnknownText(request),
    "The wallet did not give a clear answer. Your tip of 100 JPYC to Bob (0x1563…5508) may have been sent: check your wallet's activity before trying again."
  )
  assert.equal(
    tipMarkerText(request),
    "A tip may have been sent: 100 JPYC to Bob (0x1563…5508). This browser asked your wallet for it and this world did not get the result. Check your wallet's activity before sending it again."
  )
  // without an address (an outcome from before the intent, or an old note) the name stands alone
  assert.equal(tipSentText({ name: 'Bob', amount: '1', token: 'USDC' }), 'Sent 1 USDC to Bob.')
  assert.equal(
    tipUnknownText({ name: 'Bob', amount: '1', token: 'USDC', address: '' }),
    "The wallet did not give a clear answer. Your tip of 1 USDC to Bob may have been sent: check your wallet's activity before trying again."
  )
  assert.equal(TIP_NAME_TWIN_TEXT, 'Another player here has the same name. Check that this is the one you mean.')
  // "may not": after a `no_finality` a later read of the tag can work and confirm a tip sent meanwhile
  assert.equal(
    TIP_UNCONFIRMED_TEXT,
    'This world is not confirming tips right now. The transfer still goes through your wallet and may not be confirmed or announced here.'
  )
  assert.doesNotMatch(TIP_UNCONFIRMED_TEXT, /will not|never/)
  assert.equal(
    TIP_WALLET_VIEW_TEXT,
    'Your wallet may show the token contract as the destination, and may not show this address at all.'
  )
})

test('tip texts: a name is shown without bidirectional controls, in a part of its own apart from the address', () => {
  // each control that can reorder the text after it: embeddings, overrides, isolates, marks
  for (const control of [
    '\u202a',
    '\u202b',
    '\u202c',
    '\u202d',
    '\u202e',
    '\u2066',
    '\u2067',
    '\u2068',
    '\u2069',
    '\u200e',
    '\u200f',
    '\u061c',
  ]) {
    assert.equal(tipShownName(`B${control}ob${control}`), 'Bob', JSON.stringify(control))
  }
  // letters of a right-to-left script stay (the form isolates the name), and so does everything else
  assert.equal(tipShownName('בוב'), 'בוב')
  assert.equal(tipShownName('Zoë\u200d'), 'Zoë\u200d')
  for (const value of [undefined, null, 7, {}]) assert.equal(tipShownName(value), '')

  const rlo = { ...request, name: 'Bob\u202e' }
  const bob = { name: 'Bob' }
  const address = { address: '0x1563…5508' }
  assert.deepEqual(tipRecipientParts(rlo), ['To ', bob, ' · ', address])
  assert.deepEqual(tipSentParts(rlo), ['Sent 100 JPYC to ', bob, ' (', address, ')', '.'])
  assert.deepEqual(tipUnknownParts(rlo), [
    'The wallet did not give a clear answer. Your tip of 100 JPYC to ',
    bob,
    ' (',
    address,
    ')',
    " may have been sent: check your wallet's activity before trying again.",
  ])
  assert.deepEqual(tipMarkerParts(rlo), [
    'A tip may have been sent: 100 JPYC to ',
    bob,
    ' (',
    address,
    ')',
    ". This browser asked your wallet for it and this world did not get the result. Check your wallet's activity before sending it again.",
  ])
  // without an address the name stands alone
  assert.deepEqual(tipSentParts({ name: 'Bob\u202e', amount: '1', token: 'USDC' }), ['Sent 1 USDC to ', bob, '.'])
  // each text is its parts joined, without the controls
  for (const [parts, text] of [
    [tipRecipientParts, tipRecipientText],
    [tipSentParts, tipSentText],
    [tipUnknownParts, tipUnknownText],
    [tipMarkerParts, tipMarkerText],
  ]) {
    assert.equal(tipText(parts(rlo)), text(rlo))
    assert.equal(text(rlo), text(request))
    assert.doesNotMatch(text(rlo), /[\u202a-\u202e]/)
  }
  assert.equal(tipText(['a', { name: 'b' }, { address: 'c' }]), 'abc')
})

test('tip texts: nothing the form says promises what a wallet shows, or that a second payment cannot happen', () => {
  const texts = [
    tipRecipientText(request),
    tipSentText(request),
    tipUnknownText(request),
    tipMarkerText(request),
    TIP_NAME_TWIN_TEXT,
    TIP_UNCONFIRMED_TEXT,
    TIP_WALLET_VIEW_TEXT,
  ].join('\n')
  assert.doesNotMatch(texts, /your wallet will show/i)
  assert.doesNotMatch(texts, /cannot pay twice|prevent|protect|safe|guarantee/i)
  // an unknown outcome is never worded as a failure to send
  assert.doesNotMatch(tipUnknownText(request), /not sent|could not send|failed/i)
  assert.doesNotMatch(tipMarkerText(request), /not sent|could not send|failed/i)
})
