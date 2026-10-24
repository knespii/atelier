// The script the test session's GNOME Shell runs (--automation-script, see
// tools/shell-test.sh): as small as it can be. GNOME imports it first and
// only then listens for the end of its startup, which is when it runs it
// (ui/main.js, 48 to 50); a big script still loading as the startup
// completes is never run, and the session sits there until it times out.
// So the suite itself (shell-test.js) is loaded once this one runs.

export async function run() {
    const suite = await import('./shell-test.js');
    await suite.run();
}
