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
#   the world folder         decided by /app/scripts/coo-world-folder.mjs (scripts/lib/worldFolder.mjs says how):
#                            WORLD joined to /app/ as the server joins it, then RESOLVED (links followed, as `mkdir`
#                            and `find` would follow them). The resolved folder is what is created, given away and
#                            chmodded: a world that is a link to a data folder is taken as that data folder.
#   a refused folder         `/`; /app; at or under /app/build, /app/node_modules, /app/src, /app/scripts; a folder
#                            that holds one of those; at or under a system tree (/usr, /etc, /bin, /lib, /var, /home,
#                            …); /tmp itself; something that is not a folder. Decided on the joined and on the
#                            resolved path, so a link in the path cannot lead into those. The decision says why, and
#                            the script exits 1, whoever started the container.
#   started as root          the folder is created if it is missing (as the server would create it), and decided
#                            again: it must be the same folder. Then, on EVERY start:
#                            - every entry at or under it that is not 1001:1001's is given to 1001:1001;
#                            - every file there that its owner cannot read and write gets u+rw, every folder that its
#                              owner cannot read, write and search gets u+rwx (a chown keeps the mode, and root used
#                              those files whatever their mode: a root-owned db.sqlite of mode 0400 worked before, and
#                              owned by 1001 with that mode it would open read-only, and nothing would be saved);
#                            - one line each says how many entries that were (0 included);
#                            - as 1001:1001 itself, the folder has to be writable and searchable, and db.sqlite, if it
#                              is there, readable and writable.
#                            If any of that fails the script exits 1, naming the folder or the file: the command is
#                            never run as root, nor started where it could not save. Then `exec su-exec 1001:1001` it.
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
#   used. The folder is always an absolute path, so neither `mkdir` nor `find` can take it for an option, and the
#   names `find` hands to `chown` and `chmod` all begin with it.
# - `find` does not follow symbolic links (no -L, no -H), and `chown -h` changes a link itself, never what it points
#   to. So a link inside the world folder to something outside it gives nothing outside away. Modes are changed on
#   regular files and folders only (`-type f`, `-type d`: a link is neither), since `chmod` would follow a link.
# - `-xdev` keeps `find` on the file system of the world folder. When the folder is a mount point (a volume), that
#   file system is the volume's, and everything on it is covered. A file system mounted BELOW the world folder is not
#   entered: its top folder (the mount point as seen from here) is given to 1001:1001, nothing on it is. If even that
#   top folder cannot be given away (mounted read-only), the start stops like any failed chown.
# - The decision, the walk and the server's use of the path are not one atomic step: something writing the world's
#   file system in between could swap a link into it. Nothing else runs in the container before the server, and on a
#   Fly volume attached to one machine nothing else writes the volume at that moment.
#
# Every message starts with `[entrypoint]`; scripts/lib/imageCheck.mjs looks for them in a container's log.
# test/entrypoint.test.js runs this very file with stand-ins for `id`, `su-exec`, `chown` and `find`, and for `node`
# only to find coo-world-folder.mjs in the checkout; it reaches folders outside /app through `..` in WORLD, so the
# script has no switch of any kind for tests.
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

# The folder, or exit 1 with the reason. The trailing dot keeps a line break at the end of the name through
# `$(...)`, which drops trailing line breaks.
world_folder() {
  node /app/scripts/coo-world-folder.mjs && printf .
}
dir="$(world_folder)" || die "not starting: WORLD names no folder that may be given to 1001:1001 (why: above)"
dir="${dir%.}"
[ -n "$dir" ] || die "not starting: no world folder was worked out from WORLD"

uid="$(id -u)" || die "could not tell which user this runs as"
if [ "$uid" != 0 ]; then
  say "started as uid $uid, not as root: nothing under $dir changes owner, and the command runs as that user"
  exec "$@"
fi

mkdir -p "$dir" || die "could not create $dir; not starting"
[ -d "$dir" ] || die "$dir is not a folder; not starting"
# decided again, now that the folder exists: it has to be the same one
again="$(world_folder)" || die "not starting: after it was made, $dir may not be given to 1001:1001 (why: above)"
[ "${again%.}" = "$dir" ] || die "not starting: the world folder changed while it was made ($dir, then ${again%.})"

# One dot for each entry the `find` arguments after "$dir" select. Counted in dots, not in lines of names, so that a
# name with a line break in it counts once. `find` runs `printf` with as many names as fit on a command line; the
# format is used once per name, and `%.0s` prints nothing of the name.
count() {
  find "$dir" -xdev "$@" -exec printf '.%.0s' {} +
}

# Owners: what is not 1001:1001's
not_theirs() {
  count \( ! -user 1001 -o ! -group 1001 \)
}
given="$(not_theirs)" || die "could not look through $dir; not starting"
if [ -n "$given" ]; then
  find "$dir" -xdev \( ! -user 1001 -o ! -group 1001 \) -exec chown -h 1001:1001 {} + ||
    die "could not give $dir to 1001:1001 (a read-only volume, or a file system on which root may not change owners); not starting as root"
  # an exit code of 0 from `find` is not taken as proof that every `chown` worked (BusyBox find reports only the
  # last batch of names): what is left is counted again
  left="$(not_theirs)" || die "could not look through $dir after the chown; not starting"
  [ -z "$left" ] ||
    die "could not give $dir to 1001:1001: ${#left} of ${#given} entries are still not theirs after the chown; not starting as root"
fi
say "entries given to 1001:1001 under $dir: ${#given}"

# Modes: files the owner cannot read and write, folders it cannot read, write and search. `-perm -600`: all of the
# bits of 0600 are set (BusyBox find's `-perm -MODE`); `! -perm -600`: one of them is missing.
lacking() {
  count \( -type f ! -perm -600 -o -type d ! -perm -700 \)
}
modes="$(lacking)" || die "could not look through $dir; not starting"
if [ -n "$modes" ]; then
  { find "$dir" -xdev -type f ! -perm -600 -exec chmod u+rw {} + &&
    find "$dir" -xdev -type d ! -perm -700 -exec chmod u+rwx {} +; } ||
    die "could not give the owner read and write under $dir (a read-only volume?); not starting"
  left="$(lacking)" || die "could not look through $dir after the chmod; not starting"
  [ -z "$left" ] ||
    die "could not give the owner read and write under $dir: ${#left} of ${#modes} entries still lack it after the chmod; not starting"
fi
say "entries given u+rw (files) or u+rwx (folders) under $dir: ${#modes}"

# Last, as 1001:1001 itself: what the server needs before it can save. Whatever the reason this fails (a folder above
# the world folder that 1001 may not search, a db.sqlite that is a link to a root-owned file elsewhere), a server
# started now would run without saving: it is not started.
as_service() {
  su-exec 1001:1001 "$@"
}
{ as_service test -w "$dir" && as_service test -x "$dir"; } ||
  die "1001:1001 cannot write or search $dir (can it reach it: is every folder above it searchable?); not starting"
db="$dir/db.sqlite"
if [ -e "$db" ] || [ -L "$db" ]; then
  { as_service test -r "$db" && as_service test -w "$db"; } ||
    die "1001:1001 cannot read and write $db; not starting"
  # SQLite keeps its journal beside the database it has open, which is beside the file a link leads to when
  # db.sqlite is one. A database that can be written in a folder that cannot loads, and then no change is saved.
  db_real=$(readlink -f "$db") || die "$db cannot be resolved; not starting"
  # (the folder by cutting the name off, not by `dirname` in a command substitution: that would drop a newline a
  # folder's name ends with, and the check would look at another folder)
  db_dir=${db_real%/*}
  [ -n "$db_dir" ] || db_dir=/
  { as_service test -w "$db_dir" && as_service test -x "$db_dir"; } ||
    die "1001:1001 cannot write or search $db_dir, the folder of the database ($db): SQLite keeps its journal there; not starting"
fi

exec su-exec 1001:1001 "$@"
