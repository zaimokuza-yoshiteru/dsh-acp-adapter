// Isolated renderer harness; packaged shell, preload and upgrades have their own desktop checks.
const { app } = require('electron')
app.commandLine.appendSwitch('lang', process.env.DSH_E2E_BROWSER_LANGUAGE ?? 'en-US')
// Keep native windows owned until the runner closes their pages.
globalThis.dshRegressionWindows = new Set()
// The runner creates a fresh window for each scenario and explicitly quits.
app.on('window-all-closed', () => {})
