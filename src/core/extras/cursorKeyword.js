// The cursor a node may ask the page to show while the pointer is over it: one of CSS's cursor keywords.
//
// A CSS cursor value can also be an image (`url(https://…) 4 4, auto`), and the browser fetches that image when the
// value is applied: a script would make every visitor's browser request an address of its choosing, with the page as
// referrer, just by being hovered. Only the keywords are passed on.
const KEYWORDS = new Set([
  'auto',
  'default',
  'none',
  'context-menu',
  'help',
  'pointer',
  'progress',
  'wait',
  'cell',
  'crosshair',
  'text',
  'vertical-text',
  'alias',
  'copy',
  'move',
  'no-drop',
  'not-allowed',
  'grab',
  'grabbing',
  'all-scroll',
  'col-resize',
  'row-resize',
  'n-resize',
  'e-resize',
  's-resize',
  'w-resize',
  'ne-resize',
  'nw-resize',
  'se-resize',
  'sw-resize',
  'ew-resize',
  'ns-resize',
  'nesw-resize',
  'nwse-resize',
  'zoom-in',
  'zoom-out',
])

// the keyword a string names (CSS keywords ignore case and surrounding space), or null
export function cursorKeyword(value) {
  if (typeof value !== 'string') return null
  const keyword = value.trim().toLowerCase()
  return KEYWORDS.has(keyword) ? keyword : null
}
