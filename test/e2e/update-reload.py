"""Tests how the extension reacts when the host reports newer files after an update.

The setup replaces the extension's files while the browser keeps running the old ones. The host
reports the version of the files, and the extension reloads when that is newer than its own, along
with the tabs that have nothing to lose.

Chromium cannot bring back an extension loaded from the command line once it reloads, so the call
to chrome.runtime.reload() is replaced by a counter. Everything before it, the version check on
a real host, the questions to the tabs and the tabs reloaded afterwards, runs for real.
"""

import json
import os
import shutil
import subprocess
import sys
import tempfile
import time
from pathlib import Path

from playwright.sync_api import sync_playwright

ROOT = Path(__file__).resolve().parents[2]
IS_WINDOWS = sys.platform == "win32"
MOCK_PAGE = (ROOT / "test" / "e2e" / "mock-deepseek.html").read_text(encoding="utf-8")
failures = []


def check(name, condition, detail=""):
    print(("PASS  " if condition else "FAIL  ") + name + ("" if condition or not detail else f"  ({detail})"))
    if not condition:
        failures.append(name)


def wait_until(predicate, timeout=15, step=0.25):
    deadline = time.time() + timeout
    while time.time() < deadline:
        try:
            if predicate():
                return True
        except Exception:
            pass
        time.sleep(step)
    return False


class Session:
    def __init__(self, context):
        self.page = context.new_page()
        self.worker = context.service_workers[0] if context.service_workers else context.wait_for_event("serviceworker")
        # Count the reloads instead of doing them.
        self.worker.evaluate("() => { globalThis.__reloads = 0; chrome.runtime.reload = () => { globalThis.__reloads += 1; }; return 0; }")

    def reloads(self):
        return self.worker.evaluate("globalThis.__reloads")

    def stored(self, key):
        return self.worker.evaluate(f"chrome.storage.local.get('{key}').then((items) => items['{key}'] ?? null)")

    def open_page(self):
        self.page.goto("https://chat.deepseek.com/")
        self.page.wait_for_selector("#composer")
        # Give the content script time to connect, so the page counts as a connected tab.
        time.sleep(1.5)

    def mark_page(self):
        self.page.evaluate("window.__marker = 'same page'")

    def page_was_reloaded(self):
        return self.page.evaluate("window.__marker === undefined")

    def call(self, expression):
        return self.worker.evaluate(f"(async () => {{ await {expression}; return 0; }})()")


def run(session):
    page = session.page
    session.open_page()

    # The host reports its version when it connects, and the files here claim to be older than it.
    check("a host that reports newer files makes the extension reload", wait_until(lambda: session.reloads() == 1, timeout=20), str(session.reloads()))
    tabs = (session.stored("reloadTabs") or {}).get("ids", [])
    check("an idle page is chosen to follow the reload", len(tabs) == 1, str(tabs))

    # The same version does not trigger it again soon, even after the page connects again.
    session.open_page()
    time.sleep(4)
    check("the same version does not reload twice in a row", session.reloads() == 1, str(session.reloads()))

    # After the reload the new worker brings back the tabs that were chosen.
    session.mark_page()
    session.call("reloadTabsAfterUpdate()")
    check("the chosen page is reloaded once the extension is back", wait_until(session.page_was_reloaded, timeout=10))
    page.wait_for_selector("#composer")
    check("the list of tabs is used only once", session.stored("reloadTabs") is None)

    # Text typed in the composer is never lost.
    session.open_page()
    page.fill("#composer", "a draft the user is typing")
    session.mark_page()
    session.call("chrome.storage.local.remove('selfReload')")
    session.call("reloadIfFilesAreNewer('9.9.9')")
    check("the extension still reloads when a page is busy", wait_until(lambda: session.reloads() == 2, timeout=10), str(session.reloads()))
    check("a page with a draft is not chosen", (session.stored("reloadTabs") or {}).get("ids") == [], str(session.stored("reloadTabs")))
    session.call("reloadTabsAfterUpdate()")
    time.sleep(2)
    check("a page with a draft is left as it is", not session.page_was_reloaded())
    check("the draft is still there", page.input_value("#composer") == "a draft the user is typing")

    # A call waiting for the user's answer is not lost either.
    session.open_page()
    session.mark_page()
    page.evaluate(
        "() => window.postMessage({ source: 'dsx-page', type: 'tool-call', id: 'waiting-1', sessionId: 's', command: 'echo hi', attributes: {}, live: true }, location.origin)"
    )
    time.sleep(0.5)
    session.call("chrome.storage.local.remove('selfReload')")
    session.call("reloadIfFilesAreNewer('9.9.10')")
    check("a page with an unanswered card is not chosen", wait_until(lambda: session.reloads() == 3, timeout=10) and (session.stored("reloadTabs") or {}).get("ids") == [], str(session.stored("reloadTabs")))
    session.call("reloadTabsAfterUpdate()")
    time.sleep(2)
    check("a page with an unanswered card is left as it is", not session.page_was_reloaded())

    # Files that are not newer never trigger a reload.
    before = session.reloads()
    session.call("chrome.storage.local.remove('selfReload')")
    for version in ("0.0.1", "0.0.0", "not a version", None):
        session.call(f"reloadIfFilesAreNewer({json.dumps(version)})")
    time.sleep(1)
    check("equal, older or unreadable versions do nothing", session.reloads() == before, f"{before} -> {session.reloads()}")

    # A list of tabs that is too old is dropped, so a page is not reloaded by an old reload.
    session.open_page()
    session.mark_page()
    session.worker.evaluate("chrome.storage.local.set({ reloadTabs: { ids: [1], at: Date.now() - 5 * 60 * 1000 } })")
    session.call("reloadTabsAfterUpdate()")
    time.sleep(1.5)
    check("an old list of tabs is ignored and dropped", not session.page_was_reloaded() and session.stored("reloadTabs") is None)


def main():
    node = "node"
    install = str(ROOT / "host" / "install.js")
    # Brave shares this registry key on Windows, so a real installation must survive the test run.
    already_installed = IS_WINDOWS and subprocess.run(
        ["reg", "query", "HKCU\\Software\\Chromium\\NativeMessagingHosts\\com.dsx.shell_host"],
        stdout=subprocess.DEVNULL,
        stderr=subprocess.DEVNULL,
    ).returncode == 0
    subprocess.run([node, install, "--browsers", "chromium"], check=True, stdout=subprocess.DEVNULL)
    try:
        with tempfile.TemporaryDirectory() as workspace, sync_playwright() as playwright:
            extension_dir = Path(workspace) / "extension"
            shutil.copytree(ROOT / "extension", extension_dir)
            # Older than the host beside it, so the host's first answer already looks like an update.
            manifest_path = extension_dir / "manifest.json"
            manifest = json.loads(manifest_path.read_text(encoding="utf-8"))
            manifest["version"] = "0.0.1"
            manifest_path.write_text(json.dumps(manifest, indent=2), encoding="utf-8")

            browser_path = os.environ.get("DSX_E2E_BROWSER")
            target = {"executable_path": browser_path, "headless": False} if browser_path else {"channel": "chromium", "headless": True}
            context = playwright.chromium.launch_persistent_context(
                str(Path(workspace) / "profile"),
                viewport={"width": 1100, "height": 900},
                args=[f"--disable-extensions-except={extension_dir}", f"--load-extension={extension_dir}", "--no-first-run"],
                # The host reads the MCP setups of Claude Code and Codex when a page connects: point it at an empty folder.
                env={**os.environ, "CLAUDE_CONFIG_DIR": workspace, "CODEX_HOME": str(Path(workspace) / ".codex"), "DSX_USER_DIR": str(Path(workspace) / "user")},
                **target,
            )
            context.route("https://chat.deepseek.com/**", lambda route: route.fulfill(status=200, headers={"content-type": "text/html"}, body=MOCK_PAGE))
            try:
                run(Session(context))
            finally:
                context.close()
    finally:
        if not already_installed:
            subprocess.run([node, install, "--uninstall", "--browsers", "chromium"], check=True, stdout=subprocess.DEVNULL)

    print(f"\n{'ALL PASSED' if not failures else f'{len(failures)} FAILED: ' + ', '.join(failures)}")
    sys.exit(1 if failures else 0)


if __name__ == "__main__":
    main()
