export function downloadFile(file) {
  const url = URL.createObjectURL(file)
  const a = document.createElement('a')
  a.href = url
  a.download = file.name
  a.click()
  // the browser takes the url up after this turn, and some (Safari) only when the download really begins: a url
  // revoked at once could leave an empty file. A minute is long enough for that and the blob is the caller's
  // anyway, so nothing is held that was not held before
  setTimeout(() => URL.revokeObjectURL(url), 60_000)
}
