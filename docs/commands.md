# Commands

There are a few commands that can be used by entering them in the chat.

### `/admin <code>`

If your world has an admin code set, the only way to become an admin is to use this command with your code (see your .env file). Entering the code again gives admin up. An admin's rank is stored with their user, so the code is needed once per browser, not on every visit.

A wrong code is answered with "Wrong admin code." After three wrong codes, further attempts from the same user or network address have to wait (10 seconds, growing to a minute), and a connection that keeps trying is closed. This only slows guessing down: what protects a world is the code itself. Use 16 or more random characters, without spaces (the command is split on spaces).

If your .env doesn't have an ADMIN_CODE set:

- outside production (`NODE_ENV` is not `production`), or with `ADMIN_OPEN=true`, all players are treated as an admin;
- in production without `ADMIN_OPEN=true`, nobody becomes admin with a code and the server says so in its log at start-up. Users whose rank is already stored keep it.

### `/spawn set`

Sets the spawn point for all future players entering the world, to the current position and direction you are facing. Requires builder rank.

### `/spawn clear`

Resets the spawn point back to origin. Requires builder rank.

### `/name <name>`

Sets your player name.

### `/chat clear`

Clears all chat messages. Requires builder rank. 