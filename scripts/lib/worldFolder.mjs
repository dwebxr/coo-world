// Which folder the image's entrypoint (scripts/coo-entrypoint.sh) may give to the service user, 1001:1001, for a
// WORLD: the decision, made on the folder as the file system resolves it. Run through scripts/coo-world-folder.mjs
// (/app/scripts/coo-world-folder.mjs in the image), as root, before anything is created, given away or chmodded.
// Node's own modules only: the image runs it with its node and no install.
//
// 1. WORLD is joined to the app root as the server joins it (path.join('/app/', WORLD): src/server/index.js).
// 2. That path is resolved: its deepest part that exists is put through realpath, and the part that does not exist
//    yet is put back after it. The resolved folder is what the entrypoint creates, gives away and chmods. So a link
//    anywhere in the path is followed here as `mkdir` and `find` would follow it, and a world that is a link to a
//    data folder is taken as that data folder.
// 3. Refused, for the joined path and for the resolved folder alike:
//    - `/`;
//    - the app root, and any folder at or under its build, node_modules, src or scripts (the image's code), as
//      written and as resolved;
//    - any folder that is an ANCESTOR of those (giving it away gives them away: the app root's parent, `/`);
//    - any folder at or under a system tree (SYSTEM_TREES): node, the entrypoint itself, the shell, the libraries,
//      the accounts. Handed to 1001, those could be replaced by the server, and the entrypoint runs as root;
//    - /tmp itself: the owner of that shared, sticky folder may remove anyone's files in it;
//    - a folder that exists but is not a folder, a link that leads nowhere, a path that cannot be looked at;
//    - (a belt) a resolved folder whose realpath is not itself.
//    Not refused, on purpose: folders BELOW /tmp (a throw-away world), and /data, /mnt, /media, /srv and anything else
//    outside the trees above: a data volume mounted outside /app (`WORLD=../data` with a volume at /data) has to
//    stay possible.
//
// NOT atomic: the decision, the `mkdir`, the walk that changes owners and modes, and the server's own use of the
// path are separate steps, and something that wrote the world's file system between them (a link swapped into a
// component) could change what they reach. The entrypoint decides a second time after its `mkdir`; beyond that, the
// guard is that nothing else runs in the container before the server, and that on a Fly volume attached to one
// machine nothing else writes the volume at that moment.
import nodeFs from 'node:fs'
import path from 'node:path'

export const APP_ROOT = '/app'
export const CODE_FOLDERS = ['build', 'node_modules', 'src', 'scripts']
export const SYSTEM_TREES = [
  '/bin',
  '/sbin',
  '/lib',
  '/lib64',
  '/usr',
  '/etc',
  '/dev',
  '/proc',
  '/sys',
  '/run',
  '/root',
  '/home',
  '/boot',
  '/var',
  '/opt',
]
// refused as the folder itself only (what is below it is not)
export const SHARED_FOLDERS = ['/tmp']

const atOrUnder = (folder, tree) => folder === tree || folder.startsWith(tree === '/' ? '/' : `${tree}/`)
const ancestorOf = (folder, tree) => folder !== tree && atOrUnder(tree, folder)
// a path without its trailing slash (path.join keeps one: `world/` is /app/world/)
const trimmed = folder => (folder.length > 1 && folder.endsWith('/') ? folder.slice(0, -1) : folder)

/**
 * The folder for `world`: `{ ok: true, folder, joined }`, or `{ ok: false, reason }` naming the WORLD value and the
 * folder. `fs` is node:fs or a stand-in with lstatSync, realpathSync and statSync.
 */
export function resolveWorldFolder({ world, appRoot = APP_ROOT, fs = nodeFs }) {
  const named = `WORLD=${JSON.stringify(world ?? '')}`
  if (typeof world !== 'string' || world === '') return { ok: false, reason: `${named} names no folder` }
  const joined = trimmed(path.join(`${appRoot}/`, world))
  const refuse = (folder, why) => ({ ok: false, joined, reason: `${named} resolves to ${folder}: ${why}` })

  // the deepest part of the path that exists, and the names after it that do not exist yet
  let existing = joined
  const rest = []
  for (;;) {
    try {
      fs.lstatSync(existing)
      break
    } catch (err) {
      if (err?.code !== 'ENOENT' && err?.code !== 'ENOTDIR') {
        return refuse(joined, `${existing} cannot be looked at (${err?.code ?? err})`)
      }
      if (existing === '/') return refuse(joined, '/ cannot be looked at')
      rest.unshift(path.basename(existing))
      existing = path.dirname(existing)
    }
  }
  let real
  try {
    real = fs.realpathSync(existing)
  } catch (err) {
    return refuse(joined, `${existing} is a link that leads nowhere, or through one (${err?.code ?? err})`)
  }
  // (path.join took every `..` and `.` out; looked at again, since the names are put after a resolved path)
  if (rest.some(name => name === '' || name === '.' || name === '..' || name.includes('/'))) {
    return refuse(joined, `the part that does not exist yet, ${rest.join('/')}, is not plain names`)
  }
  const folder = rest.length ? path.join(real, ...rest) : real
  if (!fs.statSync(real).isDirectory()) {
    return refuse(folder, rest.length ? `${real} is not a folder` : 'it is not a folder')
  }

  // the image's code, as written and as resolved (in the image /app is no link; elsewhere it may be)
  const roots = [appRoot]
  try {
    roots.push(fs.realpathSync(appRoot))
  } catch {
    // (no app root here: the written one is all there is)
  }
  const codeTrees = [...new Set(roots.flatMap(root => CODE_FOLDERS.map(name => path.join(root, name))))]
  for (const candidate of [...new Set([joined, folder])]) {
    if (candidate === '/') return refuse(folder, 'that is the root of the file system')
    if (roots.includes(candidate)) return refuse(folder, `that is the app root, which holds the image's code`)
    const code = codeTrees.find(tree => atOrUnder(candidate, tree))
    if (code) return refuse(folder, `that is the image's own code (at or under ${code})`)
    const holds = codeTrees.find(tree => ancestorOf(candidate, tree))
    if (holds) return refuse(folder, `that folder holds the image's own code (${holds})`)
    const system = SYSTEM_TREES.find(tree => atOrUnder(candidate, tree))
    if (system) return refuse(folder, `that is a system folder (at or under ${system})`)
    const above = SYSTEM_TREES.find(tree => ancestorOf(candidate, tree))
    if (above) return refuse(folder, `that folder holds a system folder (${above})`)
    if (SHARED_FOLDERS.includes(candidate)) {
      return refuse(folder, `that folder is shared by every user of the container (a folder below it may be used)`)
    }
  }
  for (const shared of SHARED_FOLDERS) {
    try {
      if (folder === fs.realpathSync(shared)) {
        return refuse(
          folder,
          `that is ${shared}, shared by every user of the container (a folder below it may be used)`
        )
      }
    } catch {
      // (not there)
    }
  }
  // a belt: what was resolved resolves to itself
  if (fs.realpathSync(real) !== real) return refuse(folder, `${real} does not resolve to itself`)
  return { ok: true, folder, joined }
}
