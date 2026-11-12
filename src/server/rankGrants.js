// Session-only builder grants (a verified wallet token), and what ends one.
// Pure: the wallet table and the socket are passed in, so the pieces ServerNetwork wires
// together can be exercised on their own.

// An admin (or the admin code) decided a rank for this player. From that moment it is the user's rank for this
// server, written or not: the session has it and every later join of the user gets it (userRows.js). So the
// session's rank is no longer one a token granted, whatever rank was decided and whatever becomes of the write: the
// mark is cleared and the wallet's entry removed here, at the decision, and nothing looks at them when a write
// lands or fails. A token can grant builder again afterwards, when the decided rank is below it.
// What the database holds is another matter: when the write fails for good, the next process has the database's
// rank, not this one.
export function endGrantByDecision({ player, wallets }) {
  player.data.tokenGrantedRank = false
  wallets.clearWallet(player.data.id)
}

// marks the session as token-granted and keys its limits to the wallet. a grant that lands after the
// session ended (the chain was consulted while the socket went away) is dropped: there is nobody to rank
// and the wallet table was already cleared for that socket
export function grantTokenRank({ socket, player, walletAddress, wallets }) {
  if (socket.disconnected) return false
  player.data.tokenGrantedRank = true
  wallets.recordWallet(socket.id, walletAddress)
  return true
}

export function revokeTokenRank({ socket, player, wallets }) {
  player.data.tokenGrantedRank = false
  wallets.clearWallet(socket.id)
}
