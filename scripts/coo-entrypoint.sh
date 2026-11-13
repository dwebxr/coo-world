#!/bin/sh
# The image's entry point (the Dockerfile copies it to /usr/local/bin/coo-entrypoint.sh). Its arguments are the
# command to run: the image's CMD (`node build/index.js`) or whatever the container was given. POSIX sh; in the image
# it runs under BusyBox ash.
#
# A container of the image starts as root (the Dockerfile has no USER). This script gives the world folder to the
# service user, 1001:1001 (`nodeuser` in the image), and then replaces itself with the command, run as that user
# through su-exec. So the server process has no root rights, and the only part of /app it can write is the world
# folder. This script itself starts as root and gives root up at its `exec`; a `docker exec` and the image's health
# check still run as root.
#
#   WORLD empty or unset     the command is run at once, as whoever started the container, and nothing is looked
#                            at: the server says `[envs] WORLD not set` itself and exits 1. No default is made up.
#   the world folder         WORLD joined to /app/ with Node's path.join, as the server joins it (src/server/index.js:
#                            rootDir is the folder above build/, /app/ in the image). So `world` is /app/world, and
#                            `../data` is /data.
#   a refused folder         /, /app, and anything at or under /app/build, /app/node_modules, /app/src or /app/scripts:
#                            exit 1, whoever started the container. The server would take such a WORLD; giving that
#                            folder to the service user would hand it the image's own code. Nothing else is refused: a
#                            WORLD that leaves /app through `..` names whatever folder it names, and that folder is
#                            given to 1001:1001 like any other world folder.
#   started as root          the folder is created if it is missing (as the server would create it). Then, on EVERY
#                            start, every entry at or under it that is not 1001:1001's is given to 1001:1001, and one
#                            line says how many entries that were (0 included). If that cannot be done the script
#                            exits 1: the command is never run as root because a chown failed. Then
#                            `exec su-exec 1001:1001` the command.
#   started as another user  (`docker run --user`, a platform that sets a uid) nothing can be given away: the command
#                            is run at once as that user, and the server's own start-up reports a folder it cannot
#                            write (`[server] start-up failed; exiting with code 1: … EACCES …`).
#
# Why on every start, and not only when the top folder is someone else's: a file root wrote later under a folder that
# is already 1001's (a root shell in the container, a restore) would otherwise stay root's. A root-owned db.sqlite
# opens read-only: the server starts, /health answers, and no save is written.
#
# Names, links and mounts:
# - Every expansion is quoted, so a WORLD with spaces, or one that begins with a dash, is one word wherever it is
#   used. The folder is always an absolute path (path.join with /app/), so neither `mkdir` nor `find` can take it for
#   an option, and the names `find` hands to `chown` all begin with it.
# - `find` does not follow symbolic links (no -L, no -H), and `chown -h` changes a link itself, never what it points
#   to. So a link inside the world folder to something outside it gives nothing outside away. A world folder that is
#   itself a link is not followed either: only the link changes owner, and what it points to stays as it is.
# - `-xdev` keeps `find` on the file system of the world folder. When the folder is a mount point (a volume), that
#   file system is the volume's, and everything on it is covered. A file system mounted BELOW the world folder is not
#   entered: its top folder (the mount point as seen from here) is given to 1001:1001, nothing on it is. If even that
#   top folder cannot be given away (mounted read-only), the start stops like any failed chown.
#
# Every message starts with `[entrypoint]`; scripts/lib/imageCheck.mjs looks for them in a container's log.
# test/entrypoint.test.js runs this very file with stand-ins for `id`, `su-exec`, `chown` and `find`; it reaches
# folders outside /app through `..` in WORLD, so the script has no switch of any kind for tests.
set -eu

say() {
  printf '[entrypoint] %s\n' "$*"
}
die() {
  printf '[entrypoint] %s\n' "$*" >&2
  exit 1
}

[ "$#" -gt 0 ] || die "no command to run"

if [ -z "${WORLD:-}" ]; then
  exec "$@"
fi

# The trailing dot keeps a line break at the end of the name through `$(...)`, which drops trailing line breaks: the
# folder looked at here is the one the server uses, whatever WORLD holds.
dir="$(node -p 'require("path").join("/app/", process.env.WORLD) + "."')" ||
  die "could not work out the world folder from WORLD"
dir="${dir%.}"
# path.join keeps one trailing slash (`world/` is /app/world/): the same folder, compared without it
case "$dir" in
  /) ;;
  */) dir="${dir%/}" ;;
esac

case "$dir" in
  / | /app | \
    /app/build | /app/build/* | \
    /app/node_modules | /app/node_modules/* | \
    /app/src | /app/src/* | \
    /app/scripts | /app/scripts/*)
    die "refused: WORLD names $dir. The world folder is given to 1001:1001, so it must not be /, /app, or at or under /app/build, /app/node_modules, /app/src or /app/scripts"
    ;;
esac

uid="$(id -u)" || die "could not tell which user this runs as"
if [ "$uid" != 0 ]; then
  say "started as uid $uid, not as root: nothing under $dir changes owner, and the command runs as that user"
  exec "$@"
fi

mkdir -p "$dir" || die "could not create $dir; not starting"
[ -d "$dir" ] || die "$dir is not a folder; not starting"

# One dot for each entry at or under the folder that is not 1001:1001's (the folder itself among them). Counted in
# dots, not in lines of names, so that a name with a line break in it counts once. `find` runs `printf` with as many
# names as fit on a command line; the format is used once per name, and `%.0s` prints nothing of the name.
not_theirs() {
  find "$dir" -xdev \( ! -user 1001 -o ! -group 1001 \) -exec printf '.%.0s' {} +
}

before="$(not_theirs)" || die "could not look through $dir; not starting"
if [ -n "$before" ]; then
  find "$dir" -xdev \( ! -user 1001 -o ! -group 1001 \) -exec chown -h 1001:1001 {} + ||
    die "could not give $dir to 1001:1001 (a read-only volume, or a file system on which root may not change owners); not starting as root"
  # an exit code of 0 from `find` is not taken as proof that every `chown` worked: what is left is counted again
  left="$(not_theirs)" || die "could not look through $dir after the chown; not starting"
  [ -z "$left" ] ||
    die "could not give $dir to 1001:1001: ${#left} of ${#before} entries are still not theirs after the chown; not starting as root"
fi
say "entries given to 1001:1001 under $dir: ${#before}"

exec su-exec 1001:1001 "$@"
