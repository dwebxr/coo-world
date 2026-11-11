// The cursor a node may ask the page to show while the pointer is over it: one of CSS's cursor keywords.
//
// A CSS cursor value can also be an image (`url(https://…) 4 4, auto`). The cursor is a style of the page's body, so
// it is also what shows over the engine's own interface while it applies: a script's image could stand in for the
// pointer over the wallet, tip and confirmation dialogs, drawn away from where a click really lands. (That the
// browser fetches the image is not the reason: a script can already make a visitor's browser fetch an image through
// any node that shows one.) Only the keywords are passed on. A list that ends in a keyword, as CSS asks of an image
// cursor (`url(a.png), pointer`), gives that keyword, so a script written with an image cursor gets its fallback.
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

// the keyword a value names (CSS keywords ignore case and surrounding space), the keyword its list ends in, or null
export function cursorKeyword(value) {
  if (typeof value !== 'string') return null
  const keyword = value
    .slice(value.lastIndexOf(',') + 1)
    .trim()
    .toLowerCase()
  return KEYWORDS.has(keyword) ? keyword : null
}
