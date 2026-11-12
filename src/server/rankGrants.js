// Session-only builder grants (a verified wallet token) and the moment a rank becomes stored.
// Pure: the wallet table and the socket are passed in, so the pieces ServerNetwork wires
// together can be exercised on their own.

// A rank an admin (or the admin code) decided for this player has landed in the database: a statement that carried
// that decision, or a later one for the same user, was taken (userRows.js calls this once for each decision, and
// never for a statement that started before it). `rank` is what the database now holds.
// When the session has that rank, it is a stored rank from here on: a session-only grant is over and the user is a
// plain stored-rank user. When the session has another rank (a later decision still on its way, or one that failed),
// nothing is touched. So the mark is cleared only at a moment when the database holds the rank the session has:
// ending "the grant" afterwards does not take a stored rank, and a builder rank the database never took stays
// marked as a grant (a wallet disconnect takes it from the session).
// Nothing is touched either for a player that is no longer its user's session (isCurrent): the wallet table is
// keyed by the user's id, and the entry there now is the session's that replaced it.
// A write that fails calls nothing: the session keeps its grant state.
export function rankStored({ player, rank, wallets, isCurrent }) {
  if (player.data.rank !== rank || !isCurrent()) return false
  player.data.tokenGrantedRank = false
  wallets.clearWallet(player.data.id)
  return true
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
