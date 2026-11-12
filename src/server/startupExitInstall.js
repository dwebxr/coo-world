// The first import of index.js, before SES and lockdown: a module that throws while it is loaded, lockdown itself
// among them, ends the process with 1 too (startupExit.js).
import { installStartupExit } from './startupExit.js'

export const startup = installStartupExit()
