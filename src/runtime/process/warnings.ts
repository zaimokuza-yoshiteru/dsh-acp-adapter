/** A diagnostic sink must never interrupt the managed-process teardown ladder. */
export function processWarningReporter(report?: (message: string) => void): (message: string) => void {
  return (message) => {
    try {
      if (report !== undefined) {
        report(message)
        return
      }
    } catch {
      // A withdrawn or broken Host logger needs an independent fallback.
    }
    console.error(message)
  }
}
