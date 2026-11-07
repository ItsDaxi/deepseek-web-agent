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
# Where the host looks for the user's own instructions (/evil) during this run.
PROMPT_FILE = Path(tempfile.gettempdir()) / f"dsx-e2e-evil-{os.getpid()}.txt"
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


# Replies whose reasoning streams as this many one-token chunks, like the real thing.
THINK_CHUNKS = {"think hard": 1234, "think briefly": 7}


def sse(message_id, text, think_chunks=1):
    tokens = [text[i : i + 7] for i in range(0, len(text), 7)] or [""]
    lines = [
        "event: ready",
        "data: " + json.dumps({"request_message_id": message_id - 1, "response_message_id": message_id, "model_type": "default"}),
        "",
        "data: " + json.dumps({"v": {"response": {"message_id": message_id, "status": "WIP", "fragments": [{"id": 1, "type": "THINK", "content": "Thinking."}]}}}),
        "",
    ]
    for index in range(think_chunks - 1):
        patch = {"p": "response/fragments/-1/content", "o": "APPEND", "v": " t"} if index == 0 else {"v": " t"}
        lines += ["data: " + json.dumps(patch), ""]
    lines += [
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
            chunks = next((count for key, count in THINK_CHUNKS.items() if key in body["prompt"]), 1)
            route.fulfill(status=200, headers={"content-type": "text/event-stream; charset=utf-8"}, body=sse(reply_id, reply, chunks))
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
    if os.environ.get("DSX_DEBUG"):
        page.on("console", lambda message: print("PAGE", message.type, message.text[:300]))
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
    # A stopped command shows "stopped" and a rejected one "rejected", each on its own card.
    check("restored stopped and rejected cards", wait_until(lambda: "stopped" in shadow.card_text() and "rejected" in shadow.card_text(), message="restored outcomes"))
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
    check("the permission button starts on Read Only", "Read Only" in shadow.text() and "Full access" not in shadow.text())
    check("the composer shows the workspace and the fixed model", "Default workspace" in shadow.text() and "DeepSeek-V4.1-Flash" in shadow.text())
    check("the shortcut hint of New chat is switched off", page.evaluate("getComputedStyle(document.getElementById('new-chat'), '::after').content") == "none")
    check("DeepThink and Search are hidden", page.evaluate("[...document.querySelectorAll('.ds-toggle-button')].every((toggle) => getComputedStyle(toggle).display === 'none')"))
    check("both are on by default", page.evaluate("[...document.querySelectorAll('.ds-toggle-button')].every((toggle) => toggle.classList.contains('ds-toggle-button--selected'))"))
    check("the pill only reports the connection", "Shell · Connected" in shadow.text() and "Shell · Read Only" not in shadow.text())
    check("nothing asks for a timeout", not shadow.actions("timeout"))
    if SCREENSHOTS:
        page.screenshot(path=str(SCREENSHOTS / "7-composer-manual.png"))
    chosen_folder = tempfile.gettempdir()
    # This opens a real dialog on the screen, so it only runs when asked for: DSX_TEST_DIALOG=1.
    test_dialog = IS_WINDOWS and os.environ.get("DSX_TEST_DIALOG")
    if test_dialog:
        shadow.click_last("workspace-menu")
        wait_until(lambda: shadow.actions("add-workspace"), message="workspace menu")
        shadow.click_last("add-workspace")
        helper = ROOT / "test" / "helpers" / "answer-folder-dialog.ps1"
        answer = subprocess.Popen(["powershell.exe", "-NoLogo", "-NoProfile", "-NonInteractive", "-ExecutionPolicy", "Bypass", "-File", str(helper), "-Path", chosen_folder])
        check("the folder dialog sets the working directory", wait_until(lambda: (stored("cwd") or "").lower() == chosen_folder.lower(), timeout=40, message="chosen folder"))
        answer.wait()
    shadow.click_last("permission-menu")
    check("the permission menu lists the three presets", wait_until(lambda: all(label in shadow.text() for label in ("Read Only", "Workspace Write", "Full access")) and shadow.actions("mode-workspace"), message="permission menu"))
    if SCREENSHOTS:
        page.screenshot(path=str(SCREENSHOTS / "7b-permission-menu.png"))
    shadow.click_last("mode-bypass")
    check("picking Full access switches to bypass", wait_until(lambda: "Full access" in shadow.text() and "Read Only" not in shadow.text() and stored("mode") == "bypass", message="bypass mode"))
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

    # The real page keeps the text in the composer for seconds while it solves a proof of work. A result
    # must still go out once: a second press in that time would send the bare marker to the model.
    page.evaluate("window.__powMs = 1800")
    count = len(server.requests)
    type_message(page, "bypass run")
    wait_until(lambda: len(server.requests) >= count + 2, message="result sent after a slow proof of work")
    pause(6)
    sent = server.requests[count:]
    bare = [request["prompt"] for request in sent if "dsx-result:" in request["prompt"] and "<dsx:result " not in request["prompt"]]
    check("a slow proof of work still sends the result exactly once", len(sent) == 2 and not bare, f"{len(sent)} requests, bare markers: {len(bare)}")
    page.evaluate("window.__powMs = 0")

    # The reasoning is counted as it streams, one token per chunk, and large counts get a K.
    def badges():
        return page.evaluate("[...document.querySelectorAll('[data-dsx-tokens]')].map((node) => node.textContent)")

    type_message(page, "think hard")
    check("the reasoning counter shows thousands with a K", wait_until(lambda: badges()[-1:] == ["· 1.2K tokens"], message="1.2K badge"), str(badges()))
    type_message(page, "think briefly")
    check("a small count is shown as it is, and the earlier block keeps its own", wait_until(lambda: badges()[-2:] == ["· 1.2K tokens", "· 7 tokens"], message="7 badge"), str(badges()))
    wait_until(lambda: not page.evaluate("document.querySelector('#composer')?.hasAttribute('data-dsx-sending')"), message="composer free")

    # A reply with two calls: the first one finishes while the model is still writing the second.
    # Both results belong to the same reply, so they go back together once the reply has ended.
    def post_event(event):
        page.evaluate("(event) => window.postMessage({source:'dsx-page', ...event}, location.origin)", event)

    first_file = WORKDIR / "two-calls.txt"
    first_file.unlink(missing_ok=True)
    count = len(server.requests)
    post_event({"type": "tool-call", "id": "two-1", "tool": "write", "sessionId": SESSION_ID, "command": "one", "attributes": {"path": str(first_file)}, "live": True})
    wait_until(lambda: first_file.exists(), message="first call ran while the reply was still going")
    pause(1.5)
    post_event({"type": "tool-call", "id": "two-2", "tool": "shell", "sessionId": SESSION_ID, "command": "echo two-calls-second", "attributes": {}, "live": True})
    pause(1.5)
    check("nothing goes back while the reply is still being written", len(server.requests) == count)
    post_event({"type": "stream-end", "sessionId": SESSION_ID})
    wait_until(lambda: len(server.requests) > count, message="results sent after the reply ended")
    pause(3)
    sent = server.requests[count:]
    check("two calls of one reply come back in one message", len(sent) == 1 and "two-calls-second" in sent[0]["prompt"] and 'id="two-1"' in sent[0]["prompt"], f"{len(sent)} requests")

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
    shadow.click_last("permission-menu")
    wait_until(lambda: shadow.actions("mode-ask"), message="permission menu again")
    shadow.click_last("mode-ask")
    check("picking Read Only goes back to manual", wait_until(lambda: "Read Only" in shadow.text() and "Full access" not in shadow.text() and stored("mode") == "ask", message="manual mode"))
    check("the extension has no toolbar popup", "action" not in worker.evaluate("chrome.runtime.getManifest()"))
    check("no page errors from the hook", not errors, str(errors))

    # Slash commands: the menu, the keys, and what each command does. /cd is left out, because it
    # would open the real folder dialog on the screen.
    page.click("#composer")
    page.keyboard.type("/")
    check("a slash opens the command menu", wait_until(lambda: all(label in shadow.text() for label in ("Add", "Commands", "Skills", "File", "Feedback", "Permission", "Model")) and not any(label in shadow.text() for label in ("Goal", "Compact", "Export")), message="slash menu"))
    if SCREENSHOTS:
        page.screenshot(path=str(SCREENSHOTS / "7c-slash-menu.png"))
    page.keyboard.type("perm")
    check("typing filters the menu", wait_until(lambda: "Record feedback about this session" not in shadow.text() and "Switch the permission preset (sandbox mode + approval policy)" in shadow.text(), message="filtered menu"))
    page.keyboard.press("Tab")
    check("Tab on Permission opens the preset menu and keeps the text", wait_until(lambda: shadow.actions("mode-workspace") and "Search..." not in "" and page.input_value("#composer") == "/perm", message="permission menu by tab"))
    if SCREENSHOTS:
        page.screenshot(path=str(SCREENSHOTS / "7d-slash-permission.png"))
    requests_before = len(server.requests)
    check("a Workspace Write preset exists", bool(shadow.actions("mode-workspace")))
    shadow.click_last("mode-workspace")
    check("picking it switches the mode and clears the composer", wait_until(lambda: stored("mode") == "workspace" and page.input_value("#composer") == "" and page.evaluate("document.activeElement.id") == "composer", message="workspace write by menu"))
    pause(1)
    check("a command is never sent to DeepSeek", len(server.requests) == requests_before)
    page.keyboard.type("/perm")
    page.keyboard.press("Enter")
    wait_until(lambda: shadow.actions("mode-ask"), message="permission menu by enter")
    # The menu opens on the current preset (Workspace Write), so one Up is Read Only.
    page.keyboard.press("ArrowUp")
    page.keyboard.press("Enter")
    check("keys pick a preset in the menu", wait_until(lambda: stored("mode") == "ask", message="read only by keys"))

    # The workspace menu, attach, and the model panel.
    shadow.click_last("workspace-menu")
    check("the workspace menu lists the default and Add workspace", wait_until(lambda: "Default workspace" in shadow.text() and "Add workspace..." in shadow.text() and shadow.actions("workspace-default"), message="workspace menu"))
    if SCREENSHOTS:
        page.screenshot(path=str(SCREENSHOTS / "7e-workspace-menu.png"))
    page.keyboard.press("Escape")
    check("Escape closes the workspace menu", wait_until(lambda: "Add workspace..." not in shadow.text(), message="workspace menu closed"))
    check("DeepSeek's own attach button is hidden", page.evaluate("getComputedStyle(document.getElementById('attach')).display") == "none")
    shadow.click_last("attach")
    check("our attach button opens DeepSeek's own", wait_until(lambda: page.evaluate("window.__attachClicks || 0") == 1, message="attach click"))

    shadow.click_last("model-menu")
    check("the model panel shows the model, effort and teamwork", wait_until(lambda: all(text in shadow.text() for text in ("Model", "Effort", "Enable agent teamwork")) and shadow.actions("effort-row"), message="model panel"))
    if SCREENSHOTS:
        page.screenshot(path=str(SCREENSHOTS / "7f-model-panel.png"))
    check("the model cannot be changed", not shadow.actions("model-row") and "DeepSeek-V4.1-Flash" in shadow.text())
    shadow.click_last("effort-row")
    wait_until(lambda: shadow.actions("effort-off"), message="effort options")
    shadow.click_last("effort-off")
    check("Effort off turns DeepThink off", wait_until(lambda: stored("thinking") is False and page.evaluate("!document.getElementById('deepthink').classList.contains('ds-toggle-button--selected')"), message="thinking off"))
    check("Search stays on", page.evaluate("document.getElementById('search').classList.contains('ds-toggle-button--selected')"))
    page.keyboard.press("Escape")
    count = len(server.requests)
    type_message(page, "effort off message")
    wait_until(lambda: len(server.requests) > count, message="effort off message sent")
    check("the request goes out with thinking off and search on", server.requests[-1]["thinking_enabled"] is False and server.requests[-1]["search_enabled"] is True, str(server.requests[-1]))
    # The page turning Search off by itself (a new chat does) is undone.
    page.evaluate("document.getElementById('search').classList.remove('ds-toggle-button--selected')")
    check("Search is turned back on when the page turns it off", wait_until(lambda: page.evaluate("document.getElementById('search').classList.contains('ds-toggle-button--selected')"), message="search forced on"))
    shadow.click_last("model-menu")
    wait_until(lambda: shadow.actions("effort-row"), message="model panel again")
    shadow.click_last("effort-row")
    wait_until(lambda: shadow.actions("effort-on"), message="effort options again")
    shadow.click_last("effort-on")
    check("Effort on turns DeepThink back on", wait_until(lambda: stored("thinking") is True and page.evaluate("document.getElementById('deepthink').classList.contains('ds-toggle-button--selected')"), message="thinking on"))
    page.keyboard.press("Escape")

    page.fill("#composer", "/status")
    page.press("#composer", "Enter")
    check("/status shows the connection and the mode", wait_until(lambda: "Shell host: connected" in shadow.text() and "Permissions: Read Only" in shadow.text(), message="status"))
    page.fill("#composer", "/help")
    page.press("#composer", "Enter")
    check("/help lists the commands", wait_until(lambda: "/thinking collapse|default: Keep the thinking blocks collapsed or not" in shadow.text(), message="help"))
    page.fill("#composer", "/thinking default")
    page.press("#composer", "Enter")
    check("/thinking default stops collapsing the thinking blocks", wait_until(lambda: stored("collapseThinking") is False, message="thinking default"))
    page.fill("#composer", "/thinking collapse")
    page.press("#composer", "Enter")
    check("/thinking collapse turns it back on", wait_until(lambda: stored("collapseThinking") is True, message="thinking collapse"))
    page.keyboard.type("/he")
    page.keyboard.press("Escape")
    check("Escape closes the menu and keeps the text", wait_until(lambda: "Show the available commands" not in shadow.text(), message="menu closed") and page.input_value("#composer") == "/he")
    page.fill("#composer", "")
    page.keyboard.press("Tab")
    check("Tab alone never moves the focus out of the composer", page.evaluate("document.activeElement.id") == "composer")
    # /evil adds the user's own instructions, read from a file, to the hidden prompt.
    def run_command(text):
        page.fill("#composer", text)
        page.press("#composer", "Enter")

    def send_and_wait(text):
        count = len(server.requests)
        type_message(page, text)
        wait_until(lambda: len(server.requests) > count, message="message sent")
        pause(1)
        return server.requests[-1]["prompt"]

    def reload_page():
        nonlocal shadow
        page.reload()
        shadow = Shadow(page, context)
        wait_until(lambda: "Shell · Connected" in shadow.text(), message="connected after reload")
        pause(1)

    PROMPT_FILE.unlink(missing_ok=True)
    run_command("/evil")
    check("/evil refuses a missing file and names it", wait_until(lambda: stored("evilOn") in (False, None) and "There is no evil.txt yet" in shadow.text(), message="on without file"))
    PROMPT_FILE.write_text("Always answer in rhyme.", encoding="utf-8")
    run_command("/evil")
    check("/evil reads the file and turns it on without a message", wait_until(lambda: stored("evilOn") is True, message="evil on") and "evil.txt" not in shadow.text())
    check("it never prints the text back", "Always answer in rhyme." not in shadow.text())
    # With Evil Mode on, a change of preset plays the red flickering wave instead of the white one.
    wait_until(lambda: not page.evaluate("!!document.querySelector('dsx-awakening')"), timeout=5, message="awakening done")
    shadow.click_last("permission-menu")
    wait_until(lambda: shadow.actions("mode-workspace"), message="permission menu in evil mode")
    shadow.click_last("mode-workspace")
    check("a preset change in Evil Mode plays the red flickering wave", wait_until(lambda: page.evaluate("!!document.querySelector('dsx-wave')"), timeout=3, message="red wave"))
    if SCREENSHOTS:
        for index in range(3):
            pause(0.2)
            page.screenshot(path=str(SCREENSHOTS / f"evil-glitch-wave-{index}.png"), clip={"x": 150, "y": 740, "width": 800, "height": 150})
    wait_until(lambda: not page.evaluate("!!document.querySelector('dsx-wave')"), timeout=3, message="red wave done")
    shadow.click_last("permission-menu")
    wait_until(lambda: shadow.actions("mode-ask"), message="permission menu again in evil mode")
    shadow.click_last("mode-ask")
    wait_until(lambda: stored("mode") == "ask", message="back to read only")
    first = send_and_wait("hello there")
    check("the instructions go with the next message", "Additional instructions from the user" in first and "Always answer in rhyme." in first)
    check("they are in a hidden block", "<dsx:system>Additional instructions" in first)
    check("they never show in the chat", "Always answer in rhyme." not in visible_text(page))
    check("they are sent once, not with every message", "Always answer in rhyme." not in send_and_wait("and again"))
    PROMPT_FILE.write_text("Be very short.", encoding="utf-8")
    reload_page()
    check("reloading the page reads the file again", "Be very short." in send_and_wait("third message"))
    # No limit: a text of hundreds of thousands of characters crosses the whole chain unchanged.
    huge = ("Pensa in grande. " * 20000).strip()
    PROMPT_FILE.write_text(huge, encoding="utf-8")
    reload_page()
    check("a very long file is read whole and sent whole", huge in send_and_wait("a long one"))
    run_command("/evil")
    check("/evil again turns it off", wait_until(lambda: stored("evilOn") is False, message="evil off"))
    check("turning it off plays the animation too", wait_until(lambda: page.evaluate("!!document.querySelector('dsx-awakening')"), timeout=3, message="awakening on exit"))
    check("the original look is back once it ends", wait_until(lambda: page.evaluate("!document.querySelector('dsx-awakening') && !document.documentElement.hasAttribute('data-dsx-evil')"), timeout=5, message="original look"))
    check("the chat is told to forget them", "no longer apply" in send_and_wait("fourth message"))
    check("and only once", "no longer apply" not in send_and_wait("fifth message"))
    PROMPT_FILE.unlink(missing_ok=True)

    # A page script could fake the keys to change the permission mode, so faked ones must do nothing.
    page.fill("#composer", "/perm")
    wait_until(lambda: "Switch the permission preset" in shadow.text(), message="permission command")
    page.evaluate("document.getElementById('composer').dispatchEvent(new KeyboardEvent('keydown', { key: 'Enter', bubbles: true, cancelable: true }))")
    pause(1)
    check("a faked Enter does not run a command", stored("mode") == "ask" and not shadow.actions("mode-bypass"))
    page.fill("#composer", "")
    requests_before = len(server.requests)
    type_message(page, "/etc/hosts what is this file")
    check("a message that only starts with a slash is sent as usual", wait_until(lambda: len(server.requests) > requests_before, message="slash message sent"))
    wait_until(lambda: visible_text(page).count("Hello.") >= 1, message="slash message answered")

    # Update notice: GitHub is faked inside the service worker, so this never touches the network.
    def fake_release(tag):
        worker.evaluate("(tag) => { globalThis.fetch = async () => new Response(JSON.stringify({ tag_name: tag }), { status: 200 }); return 0; }", tag)
        worker.evaluate("chrome.storage.local.remove(['updateCheck', 'dismissedUpdate'])")
        page.reload()

    fake_release("v0.0.1")
    shadow = Shadow(page, context)
    pause(2)
    check("no notice for an older release", "Update available" not in shadow.text())
    fake_release("v9.0.0")
    shadow = Shadow(page, context)
    check("a newer release shows a notice", wait_until(lambda: "Update available: v9.0.0" in shadow.text(), message="update notice"))
    shadow.click_last("dismiss-update")
    check("closing the notice hides it", wait_until(lambda: "Update available" not in shadow.text(), message="notice closed"))
    check("the closed notice is remembered", stored("dismissedUpdate") == "v9.0.0")
    page.reload()
    shadow = Shadow(page, context)
    pause(2)
    check("a closed notice stays closed after a reload", "Update available" not in shadow.text())

    # A repeat lookup, an hour later, only asks whether the release changed.
    worker.evaluate("""() => {
        globalThis.__seen = [];
        globalThis.fetch = async (url, options) => {
            const condition = options.headers['If-None-Match'];
            globalThis.__seen.push(condition || null);
            return condition ? new Response(null, { status: 304 }) : new Response(JSON.stringify({ tag_name: 'v9.0.0' }), { status: 200, headers: { ETag: '"abc"' } });
        };
        return 0;
    }""")
    worker.evaluate("chrome.storage.local.remove('updateCheck')")
    page.reload()
    pause(2)
    worker.evaluate("chrome.storage.local.get('updateCheck').then(({ updateCheck }) => chrome.storage.local.set({ updateCheck: { ...updateCheck, checkedAt: 0 } }))")
    page.reload()
    pause(2)
    seen = worker.evaluate("globalThis.__seen")
    check("a repeat lookup is conditional", seen == [None, '"abc"'], str(seen))
    check("a 304 keeps the known release", (stored("updateCheck") or {}).get("tag") == "v9.0.0")
    shadow = Shadow(page, context)

    # /update asks GitHub at once, and brings the pill back if the user had closed it.
    def ask_update_command(tag):
        worker.evaluate("(tag) => { globalThis.fetch = async () => new Response(JSON.stringify({ tag_name: tag }), { status: 200 }); return 0; }", tag)
        worker.evaluate("chrome.storage.local.remove('updateCheck')")
        page.fill("#composer", "/update")
        page.press("#composer", "Enter")

    worker.evaluate("chrome.storage.local.set({ dismissedUpdate: 'v9.5.0' })")
    ask_update_command("v9.5.0")
    check("/update reports a newer release", wait_until(lambda: "Update available: v9.5.0." in shadow.text(), message="update command"))
    check("/update brings back a closed notice", wait_until(lambda: stored("dismissedUpdate") == "" and shadow.actions("dismiss-update"), message="notice back"))
    ask_update_command("v0.0.1")
    check("/update says when nothing is newer", wait_until(lambda: "You have the latest version" in shadow.text(), message="up to date"))
    worker.evaluate("chrome.storage.local.set({ checkForUpdates: false })")
    ask_update_command("v9.6.0")
    check("/update works when the automatic check is off", wait_until(lambda: "Update available: v9.6.0." in shadow.text(), message="update while off"))
    worker.evaluate("chrome.storage.local.set({ checkForUpdates: true })")

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
                # The host inherits this, so /evil reads a file of the test and never a real one.
                env={**os.environ, "DSX_PROMPT_FILE": str(PROMPT_FILE)},
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
