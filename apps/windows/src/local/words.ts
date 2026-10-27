// Local mode's words (the Mac's LocalMode.swift and the local setup screens, "Mac" read as "PC"). Relo runs on this PC and
// nothing leaves it: from the owner's view there is no account, no sign-in, no server address, no iPhone and no
// encryption, so the words for those never appear here. The test pins that.

export const LOCAL = {
  /** What the notch says when the link is lost or the credential is refused: the owner has nothing to type. */
  needsRepair: "Relo needs a quick repair on this PC.",
  repair: "Repair",
  hoverToRepair: "Relo · hover here to repair",
  hoverStartFailed: "Relo couldn't start · hover here",
  startFailedTitle: "Relo couldn't start on this PC",
  notAnswering: "Relo isn't answering on this PC.",
  notAnsweringShort: "Not answering",
  starting: "Starting Relo…",
  replyInTerminal: "Reply in your terminal",
  privateWorkFallback: "Work",
  onThisPC: "On this PC",
  tryAgain: "Try again",
  working: "Working…",
  showDetails: "Show details",
  pauseAlerts: "Pause alerts for 1 hour",
  resumeAlerts: "Resume alerts",
  /** What the owner confirms before Relo on this PC stops for a server of their own. */
  leaveConfirmation:
    "Relo on this PC stops. Your cards stay on this PC. To have your agents report to your server, add this PC in your server's Dashboard (Add a computer).",
  removed: "Relo was removed from this PC. You can quit Relo and uninstall the app.",
} as const

/** A card's title when it has none the notch can read. */
export const untitled = (local: boolean): string => (local ? LOCAL.privateWorkFallback : "Private work")

/** The line on a card whose text this PC could not open; local cards are never sealed. */
export const unreadable = (local: boolean): string => (local ? "Relo could not read this card." : "Approve this PC on your iPhone to read it")

export const offlineAnswer = (local: boolean): string => (local ? LOCAL.notAnswering : "Offline: answer on your iPhone")

export const textReply = (local: boolean): string => (local ? LOCAL.replyInTerminal : "Reply on your iPhone or in the Dashboard")

/** The capsule and chip for a feed that is not answering: "Offline" for a server, "Not answering" for Relo on this PC. */
export const offlineLabel = (local: boolean): string => (local ? LOCAL.notAnsweringShort : "Offline")

/** What the owner confirms before this PC's agents move to Relo on this PC. */
export const replaceLoginConfirmation = (host: string): string =>
  `Relo for Windows will sign out of ${host}, and your agents will report to Relo on this PC instead.`

// ---- The setup ("Run Relo on this PC"): the Mac's five steps and words ----

export const SETUP = {
  title: "Setting up Relo",
  titleDone: "Relo is running",
  steps: {
    starting: "Starting Relo",
    agents: "Choosing your agents",
    command: "Adding the relo command",
    settingUp: "Setting up your agents",
    done: "Done",
  },
  agentsNote: "Relo adds a few lines to their instructions so they report here.",
  noAgents: "No agents found yet. Install Claude Code or OpenCode, then choose Set up agents again in Settings.",
  skipped: "Skipped",
  runsHere: "Relo runs on this PC. Nothing leaves it.",
  testCard: "A test card is waiting in the notch: answer it there.",
  restartAgents: "Restart any agent that was already running, so it reads its new instructions.",
  back: "Back",
  continue: "Continue",
  skipAgents: "Skip agents for now",
  tryAgain: "Try again",
  showDetails: "Show details",
  genericFailure: "Relo could not finish setting up on this PC.",
  // The choice on the "How do you want to run Relo?" screen
  place: "Run Relo on this PC",
  placeHint: "Nothing leaves this PC",
  notBundled: "Not in this build",
} as const

/** Settings, Relo page, "Relo on this PC". */
export const SETTINGS = {
  group: "Relo on this PC",
  running: "Relo is running",
  starting: "Starting Relo…",
  notRunning: "Relo isn't running",
  version: (v: string) => `Version ${v}`,
  setUpAgents: "Set up agents again",
  setUpAgentsDetail: "Choose which agents report to Relo",
  setUp: "Set up",
  useAnother: "Use another Relo server…",
  useAnotherDetail: "Stop Relo on this PC and sign in to a server of yours",
  uninstall: "Uninstall Relo from this PC…",
  uninstallDetail: "Removes the setup in your agents, the background service and the relo command",
  uninstallConfirm: "Uninstall Relo from this PC?",
  deleteData: "Also delete my data on this PC",
  keepData: "Keep my data on this PC",
  cancel: "Cancel",
  runHere: "Run Relo on this PC instead…",
  runHereDetail: "Move your agents back to this PC",
  showDetails: "Show details",
  showDetailsDetail: "Open the folder Relo writes its logs to",
  setUpDone: "Your agents are set up. Restart them to pick it up.",
  runHereConfirm: "Run Relo on this PC instead?",
} as const

/** Every owner-facing string above, for the test that pins what they never mention. */
export function allWords(): string[] {
  const out: string[] = []
  const walk = (v: unknown): void => {
    if (typeof v === "string") out.push(v)
    else if (v && typeof v === "object") Object.values(v).forEach(walk)
  }
  walk(LOCAL)
  walk(SETUP)
  walk({ ...SETTINGS, version: SETTINGS.version("1.0.0") })
  for (const local of [true]) out.push(untitled(local), unreadable(local), offlineAnswer(local), textReply(local), offlineLabel(local))
  out.push(replaceLoginConfirmation("relo.example.com"))
  return out
}
