// Imported by index.js right after lockdown and before anything else of the server, so that a module that throws
// while it is loaded is covered too (startupExit.js).
import { installStartupExit } from './startupExit.js'

export const startup = installStartupExit()
