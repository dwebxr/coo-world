// Session-only builder grants (a verified wallet token) and the moment a rank becomes stored.
// Pure: the database, the wallet table and the socket are passed in, so the pieces ServerNetwork wires
// together can be exercised on their own.

// writes the rank; once it is in the database any session-only grant is over and the user is a plain
// stored-rank user. a failed write rejects and leaves the session as it was, for the caller to report
export async function persistRank({ db, player, rank, wallets, isCurrent }) {
  const revision = player.rankRevision
  await db('users').where('id', player.data.id).update({ rank })
  if (player.rankRevision === revision && isCurrent()) {
    player.data.tokenGrantedRank = false
    wallets.clearWallet(player.data.id)
  }
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
