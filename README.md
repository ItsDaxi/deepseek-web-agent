# DeepSeek Web Agent

A Chromium extension that lets the [DeepSeek web chat](https://chat.deepseek.com) read and edit files and run commands on your computer. It works with the free chat on the website. There is no API key and nothing to pay for.

This is unofficial and has nothing to do with DeepSeek. It relies on the site's private web API and on the structure of its pages, so a DeepSeek update can break it without warning. Check DeepSeek's terms of use before you rely on it.

## What it does

The extension adds a hidden prompt to your messages that teaches the model six tools: `read`, `write`, `edit`, `glob`, `grep` and `shell`. When the model uses one, the extension takes the call out of the response before the page draws it, shows a card in its place, and runs the call through a small native program on your machine. The result goes back to the model as a hidden message.

The hidden prompt is added to outgoing requests and removed from the history again, so it never shows up in the chat. DeepSeek's own web search and DeepThink keep working.

Developed and tested on Windows with Brave and Chromium. It should work in Chrome and Edge. macOS and Linux are supported by the host but have had much less use.

## Install on Windows

Run `DeepSeekShellToolSetup.exe`. It needs no admin rights and no Node.js, and installs into your user folder. You can remove it from Installed apps in Windows Settings.

Browsers only let you add an unpacked extension yourself, so the setup opens the right page, copies the folder path for you, and carries on once it sees the extension.

The setup is not signed, so SmartScreen may warn you. Choose More info, then Run anyway, if you trust where you got it.

The installer is not in the repository. To build it, you need Windows and a local Node.js, and the result lands in `dist`:

```bash
powershell -ExecutionPolicy Bypass -File installer/build.ps1
```

## Install from source

You need [Node.js](https://nodejs.org) 18 or newer. This is also the way to install on macOS and Linux.

1. Register the native host, which is the part that actually runs commands:

   ```bash
   node host/install.js
   ```

   Add `--browsers brave,chrome` to pick browsers. The path of the host is written into the registration, so run this again if you move the folder or change your Node installation.

   Run it from a normal terminal. On Windows, a packaged app (the Claude desktop app, for one) gets a private copy of the registry, so a registration made from inside it is invisible to a browser you start yourself.

2. Open `brave://extensions` (or `chrome://extensions`), turn on Developer mode, click Load unpacked and select the `extension` folder.

3. Restart the browser and open [chat.deepseek.com](https://chat.deepseek.com). A pill at the top right should read `Shell · Connected`.

## Using it

All controls sit on the DeepSeek page, in the row with DeepThink and Search. The extension has no toolbar popup. To turn it off, disable the extension in the browser.

- The folder icon opens your system's folder dialog and sets the working directory.
- The Manual / Bypass button switches the permission mode. A short pixel wave crosses the composer when you do: red for Bypass, white for Manual.
- "Thought for N seconds" blocks are kept collapsed. Click one to read it, and it stays open. To stop this, run `chrome.storage.local.set({ collapseThinking: false })` in the extension's service worker console.

The model chooses the timeout of each command, up to 600 seconds.

## Permission modes

| Mode | What happens |
| --- | --- |
| Manual (default) | `shell`, `write` and `edit` wait for your approval, with a diff for edits. `read`, `glob` and `grep` run by themselves inside the working directory you picked, and ask first anywhere else and for sensitive files such as `.env` and SSH keys. "Always allow in this chat" skips the question until the page is reloaded. |
| Bypass | Commands run at once, without asking. The button turns red and cards are marked `auto`. |

Both modes stop and ask after 25 automatic changes in a row. Commands replayed from a resumed stream always ask, and commands found in the chat history never run again.

## Security

Read this before you use Bypass.

- Commands run with your user's full rights. In Bypass mode nothing stands between the model and your machine.
- The model reads things you did not write: web search results, file contents, command output. They can contain instructions meant to steer it (prompt injection).
- In Bypass mode, a script running on chat.deepseek.com could trigger a command by forging the message the page hook sends. In Manual mode it could only make an approval card appear. The cards live in a closed shadow root and react only to real clicks.
- The danger labels on approval cards are pattern matches. They miss things, so read the command itself.
- Everything a tool reads and everything a command prints is sent to DeepSeek's servers, secrets included. `glob` and `grep` skip common secret files. `shell` and an approved `read` do not.

## How it works

```
page-hook.js (page world)  <->  content.js + cards.js (isolated world)  <->  background.js  <->  host/host.js  <->  shell
```

| File | Role |
| --- | --- |
| `extension/lib/protocol.js` | The hidden prompt, the tool syntax and the format of result messages |
| `extension/lib/stream-filter.js` | Removes tool syntax from the response stream and from the history |
| `extension/page-hook.js` | Wraps `XMLHttpRequest` and sends results through the page's own composer |
| `extension/content.js` | Approval decisions, the life of each command, and changes to the page |
| `extension/cards.js` | Draws the tool cards |
| `extension/page-controls.js` | The status pill, the composer buttons, tooltips and the mode animation |
| `extension/think-collapse.js` | Keeps the thinking blocks collapsed |
| `extension/background.js` | Connects tabs to the native host |
| `host/host.js` | Runs commands and tools, streams output, enforces timeouts and kills |
| `host/tools.js` | The `read`, `write`, `edit`, `glob` and `grep` tools |
| `host/pick-folder.ps1` | The folder dialog on Windows |
| `host/install.js` | Registers and removes the native host when installing from source |
| `installer/` | The Windows setup and its build script |

The model writes `<dsx:shell timeout="30">command</dsx:shell>`, with optional `cwd` and `shell` attributes. Each command is a new process with no stdin, so a `cd` does not carry over to the next one. If the model leaves out the timeout it falls back to 120 seconds, and the maximum is 600.

A reply can hold several tool tags. They run one at a time, in the order the model wrote them, so a batch that touches the same files behaves predictably. All the results go back in one message, and the 20,000-character budget is shared between them, keeping the start and the end of each.

`<dsx:shell background="true">` starts something that keeps running, such as a dev server, and answers at once with a job id like `job-1`. `<dsx:poll id="job-1" wait="30">` returns what the job printed since the last poll, waiting up to 60 seconds for something new, and says whether it is still running. `<dsx:kill id="job-1">` stops it. Background jobs have no timeout, keep their last 512 KB of output, and stop when the browser closes the connection. The Stop button on a running card ends the job too.

## Tests

```bash
npm test
```

```bash
npm run test:e2e
```

The end-to-end test needs Python with Playwright and its Chromium. It loads the real extension and the real native host against a mock of DeepSeek (`test/e2e/mock-deepseek.html`). It registers the host for Playwright's Chromium only, and removes that registration when it ends. It does not touch the real site. Tests that open the real folder dialog on your screen only run with `DSX_TEST_DIALOG=1`.

## Uninstall

Remove the extension from the browser, then run:

```bash
node host/install.js --uninstall
```

## License

MIT. See [LICENSE](LICENSE).
