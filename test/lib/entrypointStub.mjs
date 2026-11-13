// Stand-ins for test/entrypoint.test.js, which runs scripts/coo-entrypoint.sh with a PATH on which `id`, `su-exec`,
// `chown`, `find` and the command the entrypoint runs (`coo-test-command`) are one-line wrappers around this file:
// `node entrypointStub.mjs <name> <arguments…>`. Every call is appended to STUB_DIR/calls.jsonl as
// [name, …arguments], exactly as the entrypoint passed them. (`node` itself is a shell wrapper the test writes: the
// real node, with the image's path of coo-world-folder.mjs mapped to this checkout's.)
//   id               only `id -u` is answered: STUB_UID (0 for the root branch)
//   su-exec          `su-exec 1001:1001 test …` (the entrypoint's last checks) runs the real `test` as the test's
//                    own user, which stands for 1001 here as it does for `find`; any other command is recorded and
//                    not run (it is the server)
//   coo-test-command recorded
//   chown            STUB_CHOWN 'apply' (the default): only `chown -h 1001:1001 <names…>` is accepted, and what it
//                    stands for is done with the test's own ids: `chgrp -h <the test's group>` on the names (a test
//                    that is not root can change a group, not an owner). 'fail': exits 1 and changes nothing (a
//                    read-only volume). 'noop': exits 0 and changes nothing (a chown whose failures were not
//                    reported).
//   chmod            STUB_CHMOD 'real' (the default): the real chmod (the test owns the files). 'fail': exits 1 and
//                    changes nothing. 'noop': exits 0 and changes nothing.
//   find             the real /usr/bin/find, with the one change that 1001 after `-user` and `-group` is the test's
//                    own uid and gid: the test cannot make files that belong to 1001. Everything else (the
//                    traversal, -xdev, links not followed, `-exec … {} +` and the `printf` and `chown` it runs) is
//                    the real find's.
import fs from 'node:fs'
import path from 'node:path'
import { spawnSync } from 'node:child_process'

const [name, ...args] = process.argv.slice(2)
const dir = process.env.STUB_DIR
fs.appendFileSync(path.join(dir, 'calls.jsonl'), `${JSON.stringify([name, ...args])}\n`)

const own = { uid: String(process.getuid()), gid: String(process.getgid()) }
const run = (command, argv) => {
  const result = spawnSync(command, argv, { stdio: 'inherit' })
  if (result.error) throw result.error
  return result.status ?? 1
}

switch (name) {
  case 'id':
    if (args.length !== 1 || args[0] !== '-u') {
      process.stderr.write(`id stand-in: only \`id -u\` is answered, not ${JSON.stringify(args)}\n`)
      process.exitCode = 2
    } else {
      process.stdout.write(`${process.env.STUB_UID}\n`)
    }
    break
  case 'su-exec':
    if (args[0] !== '1001:1001') {
      process.stderr.write(`su-exec stand-in: expected 1001:1001, got ${JSON.stringify(args[0])}\n`)
      process.exitCode = 2
    } else if (args[1] === 'test') {
      process.exitCode = run('test', args.slice(2))
    }
    break
  case 'coo-test-command':
    break
  case 'chown': {
    const mode = process.env.STUB_CHOWN || 'apply'
    if (args[0] !== '-h' || args[1] !== '1001:1001' || args.length < 3) {
      process.stderr.write(`chown stand-in: expected -h 1001:1001 <names…>, got ${JSON.stringify(args)}\n`)
      process.exitCode = 2
    } else if (mode === 'fail') {
      process.stderr.write(`chown: ${args[2]}: Read-only file system\n`)
      process.exitCode = 1
    } else if (mode === 'apply') {
      process.exitCode = run('chgrp', ['-h', own.gid, ...args.slice(2)])
    }
    break
  }
  case 'chmod': {
    const mode = process.env.STUB_CHMOD || 'real'
    if (mode === 'fail') {
      process.stderr.write(`chmod: ${args.at(-1)}: Read-only file system\n`)
      process.exitCode = 1
    } else if (mode === 'real') {
      process.exitCode = run('/bin/chmod', args)
    }
    break
  }
  case 'find': {
    const mapped = args.map((arg, i) => {
      if (arg !== '1001') return arg
      if (args[i - 1] === '-user') return own.uid
      if (args[i - 1] === '-group') return own.gid
      return arg
    })
    process.exitCode = run('/usr/bin/find', mapped)
    break
  }
  default:
    process.stderr.write(`no stand-in named ${name}\n`)
    process.exitCode = 2
}
