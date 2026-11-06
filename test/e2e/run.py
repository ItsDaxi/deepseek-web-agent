"""End-to-end test: the real extension and native host in Chromium, against a mock DeepSeek.

Registers the native host for Playwright's Chromium only, and removes it when the run ends.
Usage: python -I test/e2e/run.py [screenshot_dir]
"""
import json
import os
import subprocess
import sys
import tempfile
import time
from pathlib import Path

from playwright.sync_api import sync_playwright

ROOT = Path(__file__).resolve().parents[2]
EXTENSION = ROOT / "extension"
MOCK_PAGE = (Path(__file__).parent / "mock-deepseek.html").read_text(encoding="utf-8")
SESSION_ID = "11111111-2222-3333-4444-555555555555"
CHAT_URL = f"https://chat.deepseek.com/a/chat/s/{SESSION_ID}"
SCREENSHOTS = Path(sys.argv[1]) if len(sys.argv) > 1 else None
IS_WINDOWS = os.name == "nt"

SLEEP = "Start-Sleep -Seconds 60" if IS_WINDOWS else "sleep 60"
FAIL = "Write-Output 'expected failure'; exit 3" if IS_WINDOWS else "echo expected failure; exit 3"
DANGER = "Remove-Item -Recurse -Force C:\\dsx-e2e-missing-folder"
STREAM = (
    "1..600 | ForEach-Object { Write-Output \"line$_\"; Start-Sleep -Milliseconds 100 }"
    if IS_WINDOWS
    else "for i in $(seq 1 600); do echo line$i; sleep 0.1; done"
)

# The scripted model: which raw text it answers with for each user request.
SCRIPT = {
    "list my files": f"I'll check that.\n<dsx:shell>\necho dsx-e2e-output\n</dsx:shell>\nOutput: invented text",
    "run a failing command": f"<dsx:shell>\n{FAIL}\n</dsx:shell>",
    "delete the folder": f"<dsx:shell>\n{DANGER}\n</dsx:shell>",
    "run a slow command": f"<dsx:shell>\n{SLEEP}\n</dsx:shell>",
    "stream some output": f"<dsx:shell>\n{STREAM}\n</dsx:shell>",
    "write the note": '<dsx:write path="note.txt">\nalpha\nbeta\n</dsx:write>',
    "edit the note": '<dsx:edit path="note.txt"><dsx:old>beta</dsx:old><dsx:new>gamma</dsx:new></dsx:edit>',
    "read the note": '<dsx:read path="note.txt"></dsx:read>',
    "find the note": "<dsx:glob>**/*.txt</dsx:glob>",
    "search the note": "<dsx:grep>gamma</dsx:grep>",
    "read outside": '<dsx:read path="C:\\Windows\\win.ini"></dsx:read>',
    "read the secret": '<dsx:read path=".env"></dsx:read>',
    "bypass run": "<dsx:shell>\necho dsx-bypass-output\n</dsx:shell>",
    "bypass danger": f"<dsx:shell>\n{DANGER}\n</dsx:shell>",
}

WORKDIR = Path(tempfile.mkdtemp(prefix="dsx-e2e-"))
failures = []
active_page = [None]


def check(name, condition, detail=""):
    print(f"{'PASS' if condition else 'FAIL'}  {name}{f'  [{detail}]' if detail and not condition else ''}")
    if not condition:
        failures.append(name)


def sse(message_id, text):
    tokens = [text[i : i + 7] for i in range(0, len(text), 7)] or [""]
    lines = [
        "event: ready",
        "data: " + json.dumps({"request_message_id": message_id - 1, "response_message_id": message_id, "model_type": "default"}),
        "",
        "data: " + json.dumps({"v": {"response": {"message_id": message_id, "status": "WIP", "fragments": [{"id": 1, "type": "THINK", "content": "Thinking."}]}}}),
        "",
        "data: " + json.dumps({"p": "response/fragments/-1/elapsed_secs", "o": "SET", "v": 0.5}),
        "",
        "data: " + json.dumps({"p": "response/fragments", "o": "APPEND", "v": [{"id": 2, "type": "RESPONSE", "content": tokens[0]}]}),
        "",
    ]
    for index, token in enumerate(tokens[1:]):
        patch = {"p": "response/fragments/-1/content", "o": "APPEND", "v": token} if index == 0 else {"v": token}
        lines += ["data: " + json.dumps(patch), ""]
    lines += [
        "data: " + json.dumps({"p": "response/status", "o": "SET", "v": "FINISHED"}),
        "",
        "event: close",
        'data: {"click_behavior":"none","auto_resume":false}',
        "",
        "",
    ]
    return "\n".join(lines)


class MockServer:
    def __init__(self):
        self.requests = []
        self.history_urls = []
        self.messages = []
        self.next_id = 1

    def answer(self, prompt):
        if "<dsx:result " in prompt:
            return "Finished, here is what happened."
        for key, reply in SCRIPT.items():
            if key in prompt:
                return reply
        return "Hello."

    def handle(self, route):
        request = route.request
        path = request.url.split("?")[0].replace("https://chat.deepseek.com", "")
        if path == "/api/v0/chat/completion":
            body = json.loads(request.post_data)
            self.requests.append(body)
            reply = self.answer(body["prompt"])
            user_id, reply_id = self.next_id, self.next_id + 1
            self.next_id += 2
            self.messages.append({"message_id": user_id, "role": "USER", "fragments": [{"type": "REQUEST", "content": body["prompt"]}]})
            self.messages.append({"message_id": reply_id, "role": "ASSISTANT", "fragments": [{"type": "THINK", "content": "Thinking."}, {"type": "RESPONSE", "content": reply}]})
            route.fulfill(status=200, headers={"content-type": "text/event-stream; charset=utf-8"}, body=sse(reply_id, reply))
        elif path == "/api/v0/chat/history_messages":
            self.history_urls.append(request.url)
            payload = {"data": {"biz_code": 0, "biz_data": {"chat_session": {"id": SESSION_ID}, "chat_messages": self.messages, "cache_control": "REPLACE"}}}
            route.fulfill(status=200, headers={"content-type": "application/json"}, body=json.dumps(payload))
        else:
            route.fulfill(status=200, headers={"content-type": "text/html"}, body=MOCK_PAGE)


class Shadow:
    """Reads and clicks through closed shadow roots using real, trusted input."""

    def __init__(self, page, context):
        self.page = page
        self.cdp = context.new_cdp_session(page)

    def _tree(self):
        return self.cdp.send("DOM.getDocument", {"depth": -1, "pierce": True})["root"]

    def _walk(self, node):
        yield node
        for key in ("children", "shadowRoots", "pseudoElements"):
            for child in node.get(key, []):
                yield from self._walk(child)
        if "contentDocument" in node:
            yield from self._walk(node["contentDocument"])

    def text(self):
        parts = []
        for node in self._walk(self._tree()):
            if node.get("nodeType") == 3:
                parts.append(node["nodeValue"])
        return "\n".join(parts)

    def card_text(self):
        parts = []

        def collect(node, inside):
            if node.get("nodeName") == "STYLE":
                return
            if inside and node.get("nodeType") == 3:
                parts.append(node["nodeValue"])
            for key in ("children", "shadowRoots"):
                for child in node.get(key, []):
                    collect(child, inside or node.get("nodeName") == "DSX-CARD")

        collect(self._tree(), False)
        return "\n".join(parts)

    def actions(self, action):
        found = []
        for node in self._walk(self._tree()):
            attributes = node.get("attributes", [])
            pairs = dict(zip(attributes[0::2], attributes[1::2]))
            if pairs.get("data-action") == action:
                found.append(node)
        return found

    def is_visible(self, class_name):
        for node in self._walk(self._tree()):
            attributes = node.get("attributes", [])
            pairs = dict(zip(attributes[0::2], attributes[1::2]))
            if class_name in pairs.get("class", "").split():
                return "hidden" not in pairs
        return False

    def click_last(self, action):
        nodes = self.actions(action)
        if not nodes:
            raise AssertionError(f"No button with action {action}")
        self.page.evaluate("window.scrollTo(0, document.body.scrollHeight)")
        self.cdp.send("DOM.scrollIntoViewIfNeeded", {"backendNodeId": nodes[-1]["backendNodeId"]})
        box = self.cdp.send("DOM.getBoxModel", {"backendNodeId": nodes[-1]["backendNodeId"]})["model"]["content"]
        self.page.mouse.click((box[0] + box[4]) / 2, (box[1] + box[5]) / 2)


def pause(seconds):
    # Sync Playwright only serves routes while its own event loop runs, so never use time.sleep here.
    active_page[0].wait_for_timeout(seconds * 1000)


def wait_until(predicate, timeout=20, message="condition"):
    deadline = time.time() + timeout
    while time.time() < deadline:
        if predicate():
            return True
        pause(0.1)
    print(f"      timed out waiting for {message}")
    return False


def type_message(page, text):
    page.fill("#composer", text)
    page.press("#composer", "Enter")


def visible_text(page):
    return page.inner_text("body")


LEAK_TOKENS = ["dsx:shell", "dsx:system", "dsx:result", "dsx-result:", "dsx-tool:", "invented text"]


def assert_no_leaks(page, label):
    text = visible_text(page)
    leaked = [token for token in LEAK_TOKENS if token in text]
    check(f"{label}: no raw protocol text on screen", not leaked, str(leaked))


def run(context, server):
    page = context.new_page()
    active_page[0] = page
    errors = []
    page.on("pageerror", lambda error: errors.append(str(error)))
    context.route("https://chat.deepseek.com/**", server.handle)
    page.goto(CHAT_URL)
    shadow = Shadow(page, context)
    worker = context.service_workers[0] if context.service_workers else context.wait_for_event("serviceworker")

    check("status pill reports the host as connected", wait_until(lambda: "Shell · Connected" in shadow.text(), message="connected pill"))
    check("history request drops the local cache parameters", server.history_urls and "cache_version" not in server.history_urls[0])

    # First message: hidden prompt, approval, execution, hidden result, final answer.
    type_message(page, "list my files please")
    check("approval card appears", wait_until(lambda: shadow.actions("run"), message="run button"))
    first = server.requests[0]["prompt"]
    check("first request carries the hidden prompt", "<dsx:system>" in first and "list my files please" in first)
    check("user bubble shows only what the user typed", "list my files please" in visible_text(page) and "You have one tool" not in visible_text(page))
    assert_no_leaks(page, "while awaiting approval")
    check("nothing ran before approval", len(server.requests) == 1)
    if SCREENSHOTS:
        page.screenshot(path=str(SCREENSHOTS / "1-approval.png"))

    shadow.click_last("run")
    check("result goes back to the model", wait_until(lambda: len(server.requests) >= 2, message="result request"))
    result = server.requests[1]["prompt"] if len(server.requests) > 1 else ""
    check("result holds the real command output", "dsx-e2e-output" in result and 'status="ok"' in result, result[:200])
    check("model continues after the result", wait_until(lambda: "Finished, here is what happened." in visible_text(page), message="final answer"))
    check("result message stays hidden", "dsx-e2e-output" not in visible_text(page))
    check("second request has only the short reminder", "You have one tool" not in result and "Reminder:" in result)
    assert_no_leaks(page, "after the result")
    check("card shows the success state", wait_until(lambda: "exit 0" in shadow.card_text(), message="exit 0"))

    # Failing command: the card opens on its own with the output.
    type_message(page, "run a failing command")
    wait_until(lambda: shadow.actions("run"), message="run button")
    shadow.click_last("run")
    check("failure is reported", wait_until(lambda: "exit 3" in shadow.card_text(), message="exit 3"))
    check("failure output is visible", wait_until(lambda: "expected failure" in shadow.card_text(), message="failure output"))
    wait_until(lambda: "exit=\"3\"" in server.requests[-1]["prompt"], message="failure result")
    check("failure reaches the model with its exit code", 'exit="3"' in server.requests[-1]["prompt"])
    wait_until(lambda: not shadow.actions("run") and visible_text(page).count("Finished") >= 2, message="second answer")
    if SCREENSHOTS:
        page.screenshot(path=str(SCREENSHOTS / "2-finished.png"))

    # Dangerous command: labelled, and rejecting it never runs it.
    type_message(page, "delete the folder")
    check("dangerous command gets a warning", wait_until(lambda: "Deletes files" in shadow.card_text(), message="danger label"))
    if SCREENSHOTS:
        page.screenshot(path=str(SCREENSHOTS / "3-danger.png"))
    shadow.click_last("reject")
    check("rejection reaches the model", wait_until(lambda: 'status="rejected"' in server.requests[-1]["prompt"], message="rejection"))
    check("rejected card is shown", wait_until(lambda: "rejected" in shadow.card_text(), message="rejected state"))
    wait_until(lambda: visible_text(page).count("Finished") >= 3, message="third answer")

    # Slow command: live state, stop, and the user's draft survives the hidden send.
    type_message(page, "run a slow command")
    wait_until(lambda: shadow.actions("run"), message="run button")
    shadow.click_last("run")
    check("running card offers stop", wait_until(lambda: shadow.actions("stop"), message="stop button"))
    if SCREENSHOTS:
        page.screenshot(path=str(SCREENSHOTS / "4-running.png"))
    page.fill("#composer", "my unfinished draft")
    shadow.click_last("stop")
    check("stopping reaches the model", wait_until(lambda: 'status="stopped"' in server.requests[-1]["prompt"], message="stopped result"))
    wait_until(lambda: visible_text(page).count("Finished") >= 4, message="fourth answer")
    check("the user's draft is restored", wait_until(lambda: page.input_value("#composer") == "my unfinished draft", timeout=3, message="draft"), page.input_value("#composer"))
    page.fill("#composer", "")

    # Streaming output must not rebuild the card, or the stop button would lose real clicks.
    type_message(page, "stream some output")
    wait_until(lambda: shadow.actions("run"), message="run button")
    shadow.click_last("run")
    check("output streams into the running card", wait_until(lambda: "line3" in shadow.card_text(), message="live output"))
    stop_before = [node["backendNodeId"] for node in shadow.actions("stop")]
    lines_before = shadow.card_text().count("line")
    pause(1.5)
    stop_after = [node["backendNodeId"] for node in shadow.actions("stop")]
    check("more output arrived while waiting", shadow.card_text().count("line") > lines_before)
    check("stop button survives streaming output", stop_before and stop_before == stop_after, f"{stop_before} -> {stop_after}")
    shadow.click_last("stop")
    check("streaming command stops on click", wait_until(lambda: 'status="stopped"' in server.requests[-1]["prompt"] and "line3" in server.requests[-1]["prompt"], message="stopped stream"))
    wait_until(lambda: visible_text(page).count("Finished") >= 5, message="fifth answer")

    # Reload: cards come back from history, and nothing runs again.
    requests_before = len(server.requests)
    page.reload()
    shadow = Shadow(page, context)
    check("cards return after a reload", wait_until(lambda: "exit 0" in shadow.card_text() and "exit 3" in shadow.card_text(), message="restored cards"))
    check("restored output is available", "stopped by you" in shadow.card_text() and "rejected" in shadow.card_text())
    assert_no_leaks(page, "after a reload")
    check("the hidden prompt is gone from history", "You have one tool" not in visible_text(page))
    pause(1.5)
    check("a reload runs nothing again", len(server.requests) == requests_before, f"{requests_before} -> {len(server.requests)}")
    check("a reload asks for nothing again", not shadow.actions("run"))
    if SCREENSHOTS:
        page.screenshot(path=str(SCREENSHOTS / "5-reloaded.png"))

    # A page script cannot start a command in ask mode.
    forged_file = Path(tempfile.gettempdir()) / f"dsx-forged-{os.getpid()}.txt"
    forged_command = f'Set-Content -Path "{forged_file}" -Value x' if IS_WINDOWS else f'touch "{forged_file}"'
    page.evaluate(
        "(command) => window.postMessage({source:'dsx-page',type:'tool-call',id:'forged-1',sessionId:'x',command,attributes:{},live:true}, location.origin)",
        forged_command,
    )
    pause(2)
    check("a forged page message does not execute in ask mode", not forged_file.exists())
    forged_file.unlink(missing_ok=True)

    # File tools: reading inside the chosen folder runs by itself, changes and outside reads ask first.
    worker.evaluate("(cwd) => chrome.storage.local.set({cwd})", str(WORKDIR))
    pause(0.5)
    note = WORKDIR / "note.txt"
    type_message(page, "write the note")
    check("write asks for approval", wait_until(lambda: "Write this file?" in shadow.card_text() and shadow.actions("run"), message="write approval"))
    check("write has not touched the disk", not note.exists())
    if SCREENSHOTS:
        page.screenshot(path=str(SCREENSHOTS / "9-write.png"))
    shadow.click_last("run")
    check("write creates the file", wait_until(lambda: note.exists() and note.read_text(encoding="utf-8") == "alpha\nbeta", message="written file"))
    wait_until(lambda: 'status="ok"' in server.requests[-1]["prompt"] and "note.txt" in server.requests[-1]["prompt"], message="write result")
    wait_until(lambda: not shadow.actions("run"), message="write finished")
    type_message(page, "edit the note")
    check("edit asks for approval with a diff", wait_until(lambda: "Edit this file?" in shadow.card_text() and "- beta" in shadow.card_text() and "+ gamma" in shadow.card_text(), message="edit approval"))
    if SCREENSHOTS:
        page.screenshot(path=str(SCREENSHOTS / "10-edit.png"))
    shadow.click_last("run")
    check("edit changes the file", wait_until(lambda: note.read_text(encoding="utf-8") == "alpha\ngamma", message="edited file"))
    wait_until(lambda: "Edited" in server.requests[-1]["prompt"], message="edit result")
    type_message(page, "read the note")
    check("read inside the folder runs without asking", wait_until(lambda: "1\talpha" in server.requests[-1]["prompt"], message="read result"))
    type_message(page, "find the note")
    check("glob runs without asking", wait_until(lambda: "note.txt" in server.requests[-1]["prompt"] and "newest first" in server.requests[-1]["prompt"], message="glob result"))
    type_message(page, "search the note")
    check("grep runs without asking", wait_until(lambda: "note.txt:2:gamma" in server.requests[-1]["prompt"], message="grep result"))
    check("automatic reads are not labelled as bypass", "auto" not in shadow.card_text().split())
    type_message(page, "read outside")
    check("read outside the folder asks first", wait_until(lambda: "Read this file?" in shadow.card_text() and shadow.actions("run"), message="outside read approval"))
    shadow.click_last("reject")
    wait_until(lambda: 'status="rejected"' in server.requests[-1]["prompt"], message="outside read rejected")
    type_message(page, "read the secret")
    check("a sensitive file asks first", wait_until(lambda: "Read this file?" in shadow.card_text() and shadow.actions("run"), message="secret approval"))
    shadow.click_last("reject")
    wait_until(lambda: 'status="rejected"' in server.requests[-1]["prompt"], message="secret rejected")
    assert_no_leaks(page, "with file tools")
    leaked = [token for token in ("dsx:old", "dsx:new", "dsx:read", "dsx:write", "dsx:edit") if token in visible_text(page) or token in shadow.card_text()]
    check("no raw file tool syntax anywhere", not leaked, str(leaked))
    wait_until(lambda: not shadow.actions("run"), message="no pending approval")
    worker.evaluate("chrome.storage.local.set({cwd: ''})")

    # Bypass mode: commands run with no click, and the mode is clearly shown.
    stored = lambda key: worker.evaluate(f"chrome.storage.local.get('{key}').then((items) => items['{key}'])")
    order = page.evaluate("[...document.querySelector('.composer-toggles').children].map((child) => child.tagName + ':' + child.textContent.trim())")
    check("composer order is folder, native toggles, permission", order == ["DSX-COMPOSER-BUTTON:", "DIV:DeepThink", "DIV:Search", "DSX-COMPOSER-BUTTON:"], str(order))
    check("the permission button starts on manual", "Manual" in shadow.text() and "Bypass" not in shadow.text())
    check("the pill only reports the connection", "Shell · Connected" in shadow.text() and "Shell · Manual" not in shadow.text())
    check("nothing asks for a timeout", not shadow.actions("timeout"))
    if SCREENSHOTS:
        page.screenshot(path=str(SCREENSHOTS / "7-composer-manual.png"))
    chosen_folder = tempfile.gettempdir()
    # This opens a real dialog on the screen, so it only runs when asked for: DSX_TEST_DIALOG=1.
    test_dialog = IS_WINDOWS and os.environ.get("DSX_TEST_DIALOG")
    if test_dialog:
        shadow.click_last("pick-folder")
        helper = ROOT / "test" / "helpers" / "answer-folder-dialog.ps1"
        answer = subprocess.Popen(["powershell.exe", "-NoLogo", "-NoProfile", "-NonInteractive", "-ExecutionPolicy", "Bypass", "-File", str(helper), "-Path", chosen_folder])
        check("the folder dialog sets the working directory", wait_until(lambda: (stored("cwd") or "").lower() == chosen_folder.lower(), timeout=40, message="chosen folder"))
        answer.wait()
    shadow.click_last("cycle-permission")
    check("the permission button cycles to bypass", wait_until(lambda: "Bypass" in shadow.text() and "Manual" not in shadow.text() and stored("mode") == "bypass", message="bypass mode"))
    if SCREENSHOTS:
        page.screenshot(path=str(SCREENSHOTS / "8-composer-bypass.png"))
    clicks_needed = len(shadow.actions("run"))
    type_message(page, "bypass run")
    check("bypass runs without approval", wait_until(lambda: "dsx-bypass-output" in server.requests[-1]["prompt"], message="bypass result"))
    check("bypass showed no approval button", clicks_needed == 0 and not shadow.actions("run"))
    check("bypass cards are labelled as automatic", wait_until(lambda: "auto" in shadow.card_text().split(), message="auto label"))
    assert_no_leaks(page, "in bypass mode")
    wait_until(lambda: "Finished" in visible_text(page), message="bypass answer")
    if SCREENSHOTS:
        page.screenshot(path=str(SCREENSHOTS / "6-bypass.png"))

    # A replayed stream never auto-runs, even in bypass mode.
    page.evaluate(
        "(command) => window.postMessage({source:'dsx-page',type:'tool-call',id:'replayed-1',sessionId:'x',command,attributes:{},live:false}, location.origin)",
        forged_command,
    )
    pause(2)
    check("a replayed call does not auto-run in bypass mode", not forged_file.exists())
    forged_file.unlink(missing_ok=True)

    if test_dialog:
        check("the model is told the chosen folder", chosen_folder.lower() in server.requests[-1]["prompt"].lower())
    worker.evaluate("chrome.storage.local.set({cwd: ''})")
    shadow.click_last("cycle-permission")
    check("the permission button cycles back to manual", wait_until(lambda: "Manual" in shadow.text() and "Bypass" not in shadow.text() and stored("mode") == "ask", message="manual mode"))
    check("the extension has no toolbar popup", "action" not in worker.evaluate("chrome.runtime.getManifest()"))
    check("no page errors from the hook", not errors, str(errors))

    # Losing the extension must never look like nothing happened.
    type_message(page, "run a slow command")
    wait_until(lambda: len(shadow.actions("run")) == 1, message="run button")
    shadow.click_last("run")
    wait_until(lambda: shadow.actions("stop"), message="stop button")
    try:
        worker.evaluate("chrome.runtime.reload()")
    except Exception:
        pass  # The worker can die before it answers.
    check("a lost connection ends the running card", wait_until(lambda: "couldn't start" in shadow.card_text() and not shadow.actions("stop"), message="connection error"))
    check("a lost connection is reported to the model", wait_until(lambda: "connection to the shell host was lost" in server.requests[-1]["prompt"], message="lost connection result"))
    answers = visible_text(page).count("Finished")
    wait_until(lambda: visible_text(page).count("Finished") >= answers, message="answer")
    pause(1)
    type_message(page, "list my files again")
    wait_until(lambda: len(shadow.actions("run")) == 1, message="run button")
    shadow.click_last("run")
    check("clicking run without the extension explains what to do", wait_until(lambda: "Reload this page to run this command" in shadow.card_text(), message="reload message"))
    check("status pill asks for a reload", wait_until(lambda: "Shell · Reload page" in shadow.text(), message="reload pill"))


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
    server = MockServer()
    try:
        with tempfile.TemporaryDirectory() as profile, sync_playwright() as playwright:
            # Set DSX_E2E_BROWSER to a browser executable (such as brave.exe) to test that browser instead.
            browser_path = os.environ.get("DSX_E2E_BROWSER")
            target = {"executable_path": browser_path, "headless": False} if browser_path else {"channel": "chromium", "headless": True}
            context = playwright.chromium.launch_persistent_context(
                profile,
                viewport={"width": 1100, "height": 900},
                args=[f"--disable-extensions-except={EXTENSION}", f"--load-extension={EXTENSION}", "--no-first-run"],
                **target,
            )
            try:
                run(context, server)
            finally:
                context.close()
    finally:
        if not already_installed:
            subprocess.run([node, install, "--uninstall", "--browsers", "chromium"], check=True, stdout=subprocess.DEVNULL)

    print(f"\n{'ALL PASSED' if not failures else f'{len(failures)} FAILED: ' + ', '.join(failures)}")
    sys.exit(1 if failures else 0)


if __name__ == "__main__":
    main()
