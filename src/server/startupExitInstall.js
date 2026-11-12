// The first of the server's own modules that index.js loads, so before lockdown runs: a module of the server that
// throws while it is loaded, lockdown itself among them, ends the process with 1 too (startupExit.js). In the built
// server the packages are imported before any of this (they are not bundled): one that throws while it is imported
// is Node's to report, which then exits with 1, since nothing has installed a listener yet.
import { installStartupExit } from './startupExit.js'

export const startup = installStartupExit()
