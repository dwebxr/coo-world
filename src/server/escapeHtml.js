const entities = { '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }

// escapes a value for html text/attribute content; coerces non-strings the way replaceAll did
export function escapeHtml(value) {
  return String(value).replace(/[&<>"']/g, ch => entities[ch])
}
