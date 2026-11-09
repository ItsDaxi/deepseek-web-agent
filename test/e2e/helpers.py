"""End-to-end test of the helpers (sub-agents): the real extension and native host in Chromium, against a
mock DeepSeek that answers from a script.

A chat asks for three helpers. At most two work at once, each in a tab of its own, and the third waits.
One helper reads a file, one asks for a command it is not allowed to run, and one is refused by DeepSeek
before it starts and again in the middle of its work, so the waits and retries run for real.

Usage: python -I test/e2e/helpers.py
"""
import json
import os
import re
import subprocess
import sys
import tempfile
from pathlib import Path

from playwright.sync_api import sync_playwright

sys.path.insert(0, str(Path(__file__).parent))
import run as harness  # noqa: E402  (the shared mock, shadow-DOM reader and waits)

ROOT = harness.ROOT
SESSION_ID = harness.SESSION_ID
CHAT_URL = harness.CHAT_URL
check = harness.check
failures = harness.failures

WORKDIR = Path(tempfile.mkdtemp(prefix="dsx-e2e-helpers-"))
(WORKDIR / "notes.txt").write_text("the notes say hello\n", encoding="utf-8")

TASKS = {
    "HELPER-TASK-1": "Read notes.txt and report what it says.",
    "HELPER-TASK-2": "Run a command that prints hi, and report what happened.",
    "HELPER-TASK-3": "Read notes.txt and report what it says, in one line.",
}


def refusal(reason, message_id):
    lines = [
        "event: ready",
        "data: " + json.dumps({"request_message_id": message_id - 1, "response_message_id": message_id, "model_type": "default"}),
        "",
        "event: hint",
        "data: " + json.dumps({"type": "error", "content": "Si sta generando un messaggio, riprova più tardi.", "clear_response": True, "finish_reason": reason}),
        "",
        "event: close",
        'data: {"click_behavior":"retry","auto_resume":false}',
        "",
        "",
    ]
    return "\n".join(lines)


def with_usage(body, total):
    """DeepSeek ends a reply with the token total of the whole chat; the extension shows input as that minus the output."""
    status = "data: " + json.dumps({"p": "response/status", "o": "SET", "v": "FINISHED"})
    usage = "data: " + json.dumps({"p": "response", "o": "BATCH", "v": [{"p": "accumulated_token_usage", "v": total}, {"p": "quasi_status", "v": "FINISHED"}]})
    return body.replace(status, usage + "\n\n" + status)


class HelperServer(harness.MockServer):
    def __init__(self):
        super().__init__()
        self.sessions = {SESSION_ID: self.messages}
        self.paths = []
        self.task_of = {}
        self.refused = []
        self.parent_prompts = []
        # Refusals to hand out: the first message of helper 3, and the first result sent for helper 1.
        self.refuse_first_of = {"HELPER-TASK-3": "parallel_chat_limit"}
        self.refuse_result_of = {"HELPER-TASK-1": "rate_limit_reached"}

    def script(self, session, prompt):
        """The raw text the scripted model answers with, or None to refuse."""
        if session == SESSION_ID:
            self.parent_prompts.append(prompt)
            if "start three helpers" in prompt:
                return "I'll hand these out.\n" + "\n".join(
                    f'<dsx:agent description="Task {key[-1]}">\n{key}: {text}\n</dsx:agent>' for key, text in TASKS.items()
                )
            if "<dsx:result " in prompt:
                return "All helpers reported."
            return "Hello."
        key = next((name for name in TASKS if name in prompt), None)
        if key:
            self.task_of[session] = key
            reason = self.refuse_first_of.pop(key, None)
            if reason:
                self.refused.append((key, "first", reason))
                return None, reason
            if key == "HELPER-TASK-2":
                return '<dsx:shell timeout="10">\necho hi\n</dsx:shell>'
            return '<dsx:read path="notes.txt"></dsx:read>'
        key = self.task_of.get(session)
        if "<dsx:result " in prompt and key:
            reason = self.refuse_result_of.pop(key, None)
            if reason:
                self.refused.append((key, "result", reason))
                return None, reason
            if key == "HELPER-TASK-2":
                refused = 'status="rejected"' in prompt and "cannot ask the user" in prompt
                return f"REPORT-{key[-1]}: the command was {'refused' if refused else 'run'}."
            return f"REPORT-{key[-1]}: notes say hello." if "the notes say hello" in prompt else f"REPORT-{key[-1]}: could not read."
        return "Hello."

    def handle(self, route):
        request = route.request
        path = request.url.split("?")[0].replace("https://chat.deepseek.com", "")
        self.paths.append(path)
        if path == "/api/v0/chat/completion":
            body = json.loads(request.post_data)
            session = body["chat_session_id"]
            answer = self.script(session, body["prompt"])
            self.requests.append(body)
            messages = self.sessions.setdefault(session, [])
            user_id, reply_id = self.next_id, self.next_id + 1
            self.next_id += 2
            if isinstance(answer, tuple):
                # A refusal is a normal 200 answer with an error hint. Nothing is kept of the chat.
                route.fulfill(status=200, headers={"content-type": "text/event-stream; charset=utf-8"}, body=refusal(answer[1], reply_id))
                return
            messages.append({"message_id": user_id, "role": "USER", "fragments": [{"type": "REQUEST", "content": body["prompt"]}]})
            messages.append({"message_id": reply_id, "role": "ASSISTANT", "fragments": [{"type": "THINK", "content": "Thinking."}, {"type": "RESPONSE", "content": answer}]})
            route.fulfill(status=200, headers={"content-type": "text/event-stream; charset=utf-8"}, body=with_usage(harness.sse(reply_id, answer), 1500))
        elif path == "/api/v0/chat/history_messages":
            session = re.search(r"chat_session_id=([^&]+)", request.url).group(1)
            payload = {"data": {"biz_code": 0, "biz_data": {"chat_session": {"id": session}, "chat_messages": self.sessions.get(session, []), "cache_control": "REPLACE"}}}
            route.fulfill(status=200, headers={"content-type": "application/json"}, body=json.dumps(payload))
        else:
            route.fulfill(status=200, headers={"content-type": "text/html"}, body=harness.MOCK_PAGE)


def helper_pages(context, parent):
    # Chromium also keeps its own blank tab, which is not a helper.
    return [page for page in context.pages if page != parent and not page.is_closed() and "chat.deepseek.com" in page.url]


def run(context, server):
    page = context.new_page()
    harness.active_page[0] = page
    context.route("https://chat.deepseek.com/**", server.handle)
    page.goto(CHAT_URL)
    shadow = harness.Shadow(page, context)
    worker = context.service_workers[0] if context.service_workers else context.wait_for_event("serviceworker")
    wait_until = harness.wait_until

    check("the host connects", wait_until(lambda: "Shell · Connected" in shadow.text(), message="connected pill"))
    # Reads inside this folder run by themselves in Read Only mode, which is what the helpers get.
    worker.evaluate("(cwd) => chrome.storage.local.set({ cwd, helperRetryMs: 600 })", str(WORKDIR))

    page.fill("#composer", "please start three helpers")
    page.press("#composer", "Enter")

    most_at_once = [0]
    waited = [False]

    shot = Path(sys.argv[1]) if len(sys.argv) > 1 else None
    taken = [False]

    def watch():
        most_at_once[0] = max(most_at_once[0], len(helper_pages(context, page)))
        # For a look at the menu while helpers work, only when a folder for screenshots is given.
        if shot and not taken[0] and shadow.actions("agents-menu"):
            taken[0] = True
            harness.pause(4)
            page.screenshot(path=str(shot / "agents-button-working.png"))
            shadow.click_last("agents-menu")
            harness.pause(1.2)
            page.screenshot(path=str(shot / "agents-menu-working.png"))
            page.keyboard.press("Escape")
        if "Waiting: two helpers are already working." in shadow.card_text():
            waited[0] = True
        return "All helpers reported." in harness.visible_text(page)

    check("the chat answers once all three helpers have reported", wait_until(watch, timeout=150, message="the final answer"))
    harness.pause(1)
    check("never more than two helper tabs were open at once", most_at_once[0] <= 2, str(most_at_once[0]))
    check("two helpers did work side by side", most_at_once[0] == 2, str(most_at_once[0]))
    check("the third helper was told it had to wait", waited[0])

    results = [prompt for prompt in server.parent_prompts if "<dsx:result " in prompt]
    check("the three reports came back together in one message", len(results) == 1 and results[0].count('tool="agent"') == 3, str(len(results)))
    report = results[0] if results else ""
    check("helper 1 read the file and reported", "REPORT-1: notes say hello." in report, report[-400:])
    check("helper 2 was refused a command and said so", "REPORT-2: the command was refused." in report, report[-400:])
    check("helper 3 reported after DeepSeek refused its first message", "REPORT-3: notes say hello." in report, report[-400:])
    check("the refusals were really handed out", {item[:2] for item in server.refused} == {("HELPER-TASK-3", "first"), ("HELPER-TASK-1", "result")}, str(server.refused))
    check("the reports are not shown as raw protocol text", "dsx:result" not in harness.visible_text(page) and "dsx-result:" not in harness.visible_text(page))
    check("the helper cards show their titles", "Helper: Task 1" in shadow.card_text() and "Helper: Task 3" in shadow.card_text(), shadow.card_text()[:300])
    check("all the helper tabs were closed", wait_until(lambda: not helper_pages(context, page), timeout=10, message="tabs closed"), str([p.url for p in helper_pages(context, page)]))
    check("a helper's chat never carried the helper tool", all("dsx:agent" not in body["prompt"] for body in server.requests if body["chat_session_id"] != SESSION_ID))
    check("a helper's first message carries the task and the report request", any("plain-text report" in body["prompt"] and "HELPER-TASK-1" in body["prompt"] for body in server.requests))
    look_at_agents(context, page, shadow, wait_until, server)


def look_at_agents(context, page, shadow, wait_until, server):
    shot = Path(sys.argv[1]) if len(sys.argv) > 1 else None
    page.bring_to_front()
    check("the Agents button appears with the number of helpers", wait_until(lambda: "Agents" in shadow.text() and shadow.actions("agents-menu"), message="agents button"))
    if shot:
        page.screenshot(path=str(shot / "agents-button.png"))
    shadow.click_last("agents-menu")
    check("the Agents menu lists the three helpers", wait_until(lambda: len(shadow.actions("agent-open")) == 3, message="three rows"), str(len(shadow.actions("agent-open"))))
    text = shadow.text()
    check("each row names its helper", all(f"Task {n}" in text for n in "123"))
    check("each row shows input and output tokens and a time", "Input" in text and "Output" in text and " tok" in text and re.search(r"\d+(\.\d)?s", text) is not None, text[-400:])
    check("the menu says how many helpers work at once", "Up to 2 helpers work at the same time." in text)
    if shot:
        page.screenshot(path=str(shot / "agents-menu.png"))

    before = len(context.pages)
    shadow.click_last("agent-open")
    check("a finished helper opens its chat in a new tab", wait_until(lambda: len(context.pages) > before, message="viewer tab"))
    viewer = next((p for p in context.pages if p != page and "/a/chat/s/" in p.url), None)
    check("the new tab is the helper's chat", viewer is not None and "chat.deepseek.com/a/chat/s/" in viewer.url, str([p.url for p in context.pages]))
    if viewer is None:
        return
    harness.active_page[0] = viewer
    seen = harness.Shadow(viewer, context)
    check("that tab has a way back to the main chat", wait_until(lambda: "Main chat" in seen.text() and seen.actions("agents-back"), message="back button"))
    if shot:
        viewer.screenshot(path=str(shot / "agents-viewer.png"))
    seen.click_last("agents-back")
    # The waits run on the main chat's page, which stays open while the viewer closes.
    harness.active_page[0] = page
    check("Back returns to the main chat and closes the tab that was only a viewer", wait_until(lambda: viewer.is_closed(), message="viewer closed"))
    check("the main chat is still there, with its Agents button", "Agents" in shadow.text() and bool(shadow.actions("agents-menu")))

    # Taking helpers off the list: one with its X, then the rest with "Clear finished".
    hidden = lambda: page.evaluate("document.querySelector('dsx-agents').hidden")
    shadow.click_last("agents-menu")
    check("the menu opens again", wait_until(lambda: len(shadow.actions("agent-open")) == 3, message="rows again"))
    check("every finished helper has an X, and the menu offers to clear them", len(shadow.actions("agent-dismiss")) == 3 and bool(shadow.actions("agents-clear")))
    shadow.click_last("agent-dismiss")
    check("the X takes that helper off the list and keeps the menu open", wait_until(lambda: len(shadow.actions("agent-open")) == 2, message="two rows"))
    if shot:
        page.screenshot(path=str(shot / "agents-menu-removed.png"))
    shadow.click_last("agents-clear")
    check("Clear finished empties the list and the Agents button goes away", wait_until(hidden, message="button hidden") and not shadow.actions("agent-open"))
    # Nothing was deleted on the DeepSeek side: the chats of the helpers stay in its history.
    check("removing helpers from the list sends nothing to DeepSeek", not any("delete" in path for path in server.paths), str(sorted(set(server.paths))))


def main():
    node = "node"
    install = str(ROOT / "host" / "install.js")
    already_installed = harness.IS_WINDOWS and subprocess.run(
        ["reg", "query", "HKCU\\Software\\Chromium\\NativeMessagingHosts\\com.dsx.shell_host"],
        stdout=subprocess.DEVNULL,
        stderr=subprocess.DEVNULL,
    ).returncode == 0
    subprocess.run([node, install, "--browsers", "chromium"], check=True, stdout=subprocess.DEVNULL)
    server = HelperServer()
    try:
        with tempfile.TemporaryDirectory() as profile, sync_playwright() as playwright:
            context = playwright.chromium.launch_persistent_context(
                profile,
                viewport={"width": 1100, "height": 900},
                args=[f"--disable-extensions-except={harness.EXTENSION}", f"--load-extension={harness.EXTENSION}", "--no-first-run"],
                env={**os.environ, "DSX_PROMPT_FILE": str(harness.PROMPT_FILE), "DSX_USER_DIR": str(harness.USER_DIR)},
                channel="chromium",
                headless=True,
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
