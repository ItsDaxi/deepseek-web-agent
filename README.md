# DeepSeek Web Agent

A browser extension, for Chromium browsers and Firefox, that lets the [DeepSeek web chat](https://chat.deepseek.com) read and edit files and run commands on your computer. It works with the free chat on the website. There is no API key and nothing to pay for.

This is unofficial and has nothing to do with DeepSeek. It relies on the site's private web API and on the structure of its pages, so a DeepSeek update can break it without warning. Check DeepSeek's terms of use before you rely on it.

## What it does

The extension adds a hidden prompt to your messages that teaches the model six tools: `read`, `write`, `edit`, `glob`, `grep` and `shell`, plus helpers for long jobs (see Helpers). When the model uses one, the extension takes the call out of the response before the page draws it, shows a card in its place, and runs the call through a small native program on your machine. The result goes back to the model as a hidden message.

The hidden prompt is added to outgoing requests and removed from the history again, so it never shows up in the chat. DeepSeek's own web search and DeepThink keep working.

Developed and tested on Windows with Brave and Chromium. It should work in Chrome and Edge. Firefox 140 or newer is supported too, but that build is new and has had much less use than the Chromium one. macOS and Linux are supported by the host but have had much less use.

## Screenshots

The controls sit in the page's own composer: the workspace above it, the permission preset and the model panel inside it, and the connection pill at the top right.

![The DeepSeek chat with the extension's controls in the composer](docs/home.png)

A tool call shows up as a card between the thinking block and the answer. The thinking header carries the live token count.

![A write call shown as a card, with the model's answer below it](docs/tool-call.png)

Evil Mode, turned on with `/evil`, gives the page a red look and adds your own instructions from `evil.txt` to the hidden prompt.

![The same page in Evil Mode](docs/evil-mode.png)

## Install on Windows

Download `dsx-<version>-setup.exe` from the [latest release](https://github.com/ItsDaxi/deepseek-web-agent/releases/latest) and run it. It needs no admin rights and no Node.js, and installs into your user folder. You can remove it from Installed apps in Windows Settings.

Browsers only let you add an unpacked extension yourself, so the setup opens the right page, copies the folder path for you, and carries on once it sees the extension. The setup also registers the native host for Firefox, but adding the extension to Firefox is a separate step: see below.

The setup is not signed, so SmartScreen may warn you. Choose More info, then Run anyway, if you trust where you got it.

The installer is attached to each release and is not in the repository. To build it yourself, you need Windows and a local Node.js, and the result lands in `dist/<version>/`:

```bash
powershell -ExecutionPolicy Bypass -File installer/build.ps1
```

## Firefox

Firefox 140 or newer, on desktop. The native host is the same one the other browsers use: the setup registers it for Firefox as well, and from source `node host/install.js --browsers firefox` does the same.

Release Firefox only installs extensions that Mozilla has signed. There are two ways to add this one:

- **Try it from source.** Open `about:debugging#/runtime/this-firefox`, click Load Temporary Add-on and pick `extension/manifest.json`. It stays until you close Firefox. If the page shows no controls, open the extension's page in `about:addons`, then Permissions, and allow it on `chat.deepseek.com`.
- **Install it for good.** `node installer/build-firefox.js` packs the extension into `dist/<version>/dsx-<version>-firefox-unsigned.zip`. Mozilla signs an extension for free as a self-distributed ("unlisted") add-on that is not listed in their store. Upload the zip at [addons.mozilla.org/developers](https://addons.mozilla.org/developers/) and choose to distribute it on your own. Mozilla sends back a signed file with a long generated name: rename it to `dsx-<version>-firefox.xpi` and open it in Firefox. `installer/release.ps1` attaches it to the release when it is there.

The extension reloads itself after the setup updates its files, which works for Chromium. In Firefox a signed `.xpi` is updated by installing the new one.

## Install from source

You need [Node.js](https://nodejs.org) 18 or newer. This is also the way to install on macOS and Linux.

1. Register the native host, which is the part that actually runs commands:

   ```bash
   node host/install.js
   ```

   Add `--browsers brave,chrome` to pick browsers (`chrome`, `brave`, `chromium`, `edge`, `firefox`). The path of the host is written into the registration, so run this again if you move the folder or change your Node installation.

   Run it from a normal terminal. On Windows, a packaged app (the Claude desktop app, for one) gets a private copy of the registry, so a registration made from inside it is invisible to a browser you start yourself.

2. Open `brave://extensions` (or `chrome://extensions`), turn on Developer mode, click Load unpacked and select the `extension` folder. For Firefox, see the section above.

3. Restart the browser and open [chat.deepseek.com](https://chat.deepseek.com). A pill at the top right should read `Shell · Connected`.

## Using it

All controls sit in the composer of the DeepSeek page. The extension has no toolbar popup. To turn it off, disable the extension in the browser.

- **Default workspace**, above the composer, is the working directory. Its menu lists the folders you used before; "Add workspace..." opens your system's folder dialog.
- The paperclip opens DeepSeek's own file dialog.
- The permission button (**Read Only**, **Workspace Write**, **Full access**) opens a menu of presets. A short pixel wave crosses the composer when you change it: white, or red and flickering while Evil Mode is on, whatever the preset.
- The model button opens a small panel. The model is fixed. **Effort** is on or off and works exactly like DeepSeek's DeepThink button, which the extension hides and drives for you. Search is always on, and its button is hidden too. "Enable agent teamwork" is not built yet and cannot be clicked.
- "Thought for N seconds" blocks are kept collapsed. Click one to read it, and it stays open. To stop this, run `chrome.storage.local.set({ collapseThinking: false })` in the extension's service worker console.
- The model panel (click the model name above the send button) has a Context row: the tokens the chat has used against the model's 1M-token window, like `212K / 1M`, with a thin bar that turns amber and then red as it fills. It updates at the end of every reply, with the total DeepSeek counts.
- Each thinking block shows how many tokens the model spent reasoning, counted live as it streams (`1.2K tokens`). DeepSeek sends the reasoning one token per chunk, so the count is exact; blocks from an earlier visit show none.
- In a conversation, a line under the composer sums up the chat: turns and steps, the time the model spent (`LLM`), the average wait for the first token and the speed (`TTFT avg`, `tok/s`), and the tokens in and out. A turn is a message you wrote and a step is one reply of the model, so a command that goes back to the model adds a step. Input is what DeepSeek counts for the chat minus what the model wrote. A chat the tab did not follow from its first message, such as one opened from the history, shows only what happened since, and no input. The figures are kept while the tab lives, so a reload does not lose them. DeepSeek does not report cache hits to the page, so there is no such figure.
- On a new chat, before there is a conversation, the composer glows softly. In Evil Mode the glow turns red with the rest.

The model chooses the timeout of each command, up to 600 seconds.

### Slash commands

Type `/` at the start of the composer to open a menu of commands in three groups (Add, Commands, Skills), listing only what works, in DeepSeek's own dropdown style. Keep typing to filter it. Arrow keys move, **Tab** completes the highlighted command, **Enter** or a click runs it, and **Esc** closes the menu. A command that takes an argument, such as `/thinking`, completes to `/thinking ` and then suggests its arguments. **Tab** on Permission or Model opens their menu. A command is never sent to DeepSeek.

Tab does not move the focus out of the composer, so it can be used for completion. Everywhere else on the page it works as usual.

A message that only starts with a slash, such as `/etc/hosts what is this file`, is sent as usual. The menu and the keys react only to real key presses, so a script on the page cannot run a command by faking an Enter.

| Command | What it does |
| --- | --- |
| `/file` | Opens DeepSeek's file dialog, like the paperclip. |
| `/feedback` | Opens the project's issue page in a new tab. |
| `/permission` | Opens the permission presets, like the permission button. |
| `/model` | Opens the model panel, like the model button. |
| `/status` | Shows the extension version, the shell host, the permissions, the workspace, the instruction files found, the effort and the thinking setting. |
| `/thinking collapse` or `/thinking default` | Keeps the thinking blocks collapsed, or leaves them as DeepSeek shows them. |
| `/terminal` | Opens or closes the side terminal. See below. |
| `/evil` | Turns your own instructions for the model, read from `evil.txt`, on or off in the hidden prompt. See below. |
| `/update` | Asks GitHub for the latest release now, and shows the update pill again if it was closed. It works even when the automatic check is off, because you are asking for it. |
| `/help` | Lists the commands. |

A command answers in a small panel above the composer, which closes by itself or when you click it.

#### Your own instructions

`/evil` adds a text of your own to the hidden prompt, next to the one the extension already sends. The text is in a file called `evil.txt`, in the install folder beside `host` and `extension`, and it ships with the project: the Windows setup puts it in `%LOCALAPPDATA%\DeepSeekShellTool\`, and from source it is the root of the project. Edit it to make it your own: a setup update replaces it with the new shipped text only while it is still identical to a version that shipped before, so once you change it your changes stay. An `evil.txt` in your `.dsx` folder takes the place of that one, and no update can touch it. If the file is missing, `/evil` tells you the exact path where to create it.

`/evil` takes no arguments: it switches. The square flame button next to "New chat" in the sidebar does the same, and turns red while it is on. The first time it reads the file and turns the feature on, and the next time it turns it off. The text goes out with your next message in each chat, once, and again only if it changes. It sits in a hidden block, so it never shows in the chat, and `/evil` never prints it back, only its size. The file is read again every time the page loads, so after editing it reload the page. Turning it off tells a chat that already has the text to ignore it. The file has no size limit of its own: a long text travels from the host to the extension in pieces and is joined again. DeepSeek has a limit on the length of a message that this extension cannot see, so above 100,000 characters `/evil` warns you that DeepSeek may refuse it. Only that one file is read, and the text is never taken from the web.

While `/evil` is on the page wears the red look: the blue of DeepSeek becomes red, and the logo in the sidebar and the whale on an empty chat are replaced by your own (`extension/logos.css` and `extension/evil.css`). Turning `/evil` on plays a short transition (`extension/evil-awakening.js`, one second): a flickering full-screen glitch of pixel blocks in purple, magenta, blue and black covers the page, the red theme switches on underneath, then the glitch breaks up while the new logos fade in. While it is on, the greeting on an empty chat is one of five tougher lines (`extension/evil-greeting.js`) instead of DeepSeek's own. Turning it off brings the original look and greeting back at once.

### Instruction files

The extension reads `AGENTS.md` and `CLAUDE.md`, the files other coding agents use for standing instructions, and gives them to the model in the hidden prompt.

- **For every folder.** Put them in `.dsx` in your home folder, for example `C:\Users\you\.dsx\AGENTS.md`. The folder is yours: the extension never writes in it, and an update never touches it.
- **For one folder.** Put them in the workspace you picked, or in any folder above it up to your home folder. A project can have its own, and a folder further up can have one for all its projects.

The user's files come first, then the folders from the outermost to the working folder. When two of them disagree, the one listed last wins, so the file closest to your work has the final word. In each folder `AGENTS.md` comes before `CLAUDE.md`. Only these two names are read, only in those places, and nothing else on the disk. The files of other tools, such as `~/.claude/CLAUDE.md` or `~/.codex/AGENTS.md`, are not read: copy or link the text into `.dsx` if you want it here.

The text goes out with your next message in each chat, once, and again only if it changes, which includes switching workspace. It sits in a hidden block, so it never shows in the chat. A file longer than 100,000 characters is cut, and together they stay under 300,000: past that, the ones furthest from the working folder are left out. `/status` lists the files that were found. They are read when the host connects and when you change workspace, so after editing one, reload the page or pick the workspace again.

A file in a project folder is read as soon as you pick that folder, and it steers the model: do not pick a folder you did not write or do not trust. See Security.

### Side terminal

A button with a terminal icon in the top right, next to the connection pill, or `/terminal`, opens a terminal docked on the right of the page. The page makes room for it. The edge on its left can be dragged to set the width, the arrows button expands and shrinks it, and the cross, `exit` or the same button closes it. It comes back as you left it.

You type at the prompt at the end of the output, as in any terminal. Up and Down walk through what you typed, Ctrl+C stops a running command, and Ctrl+L clears. A lone `cd` is followed, so the prompt shows the folder and the next command runs there. Changing the workspace above the composer moves the terminal to it.

It runs commands through the same native host as the model, each in a process of its own. So the folder carries over, but variables do not, and a program that waits for you to type, such as `vim` or a REPL, does not work. What it runs is never sent to the model, and nothing the model writes can reach it.

### Helpers

The model can hand a long job, such as searching a large codebase or reading many files to answer one question, to a helper. A helper is another DeepSeek chat, opened by the extension in a background tab. It gets the task, works with the same tools and sends back a plain-text report, which reaches the main chat like any other result. Only the report counts against the main chat's context, not everything the helper read. The card in the main chat is titled `Helper: <description>`, and its Stop button closes the helper's tab.

Two things come from DeepSeek, measured on a real account rather than documented: an account can generate in **two chats at once**, and it refuses messages that come too fast (about 14 a minute in one test). So at most **2 helpers** work at the same time, not counting the main chat, which has nothing generating while it waits for its helpers. A third helper waits for a free place. When DeepSeek refuses a helper's message anyway (it does so inside a normal answer, with `parallel_chat_limit` or `rate_limit_reached`), the helper waits and sends it again, up to 4 times, then gives up with a report that says why.

A helper has no one to ask, so what would wait for your approval is refused instead, and the model is told so. In Read Only mode that means a helper reads inside the workspace and nothing else; Workspace Write also lets it edit there; Full access lets it do anything, like the main chat. "Always allow in this chat" does not carry over to a helper. A helper cannot start helpers. It is stopped after 40 requests or 20 minutes, and closing the main chat's tab stops its helpers.

A helper's chat shows up in your DeepSeek history like any other.

### Update notice

When you open DeepSeek, the extension asks GitHub for the latest release of this repository. If it is newer than the installed version, a blue "Update available" pill appears at the top right, next to the status pill. Click it to open the release page on GitHub, download the new setup there and run it. Close it with the × and it stays closed until the next release.

After the setup runs, the extension notices that its files on disk are newer than the version the browser has loaded and reloads itself. It also reloads the DeepSeek tabs that have nothing to lose. A tab with text in the composer, a command in progress or a card waiting for your answer is left alone and shows `Reload page`, so you decide when. Nothing is downloaded or run for this: the extension only compares two version numbers. Updating from a version older than 0.2.1 needs one manual reload of the extension in `brave://extensions`.

This is the only request the extension makes besides the ones to DeepSeek. It goes straight from your browser to `api.github.com`, carries no account and none of your data, and happens at most once an hour. Repeat requests ask GitHub only whether anything changed, which it answers without counting against its rate limit. GitHub sees your IP address, as with any visit. To turn it off, run `chrome.storage.local.set({ checkForUpdates: false })` in the extension's service worker console.

## Releasing

For maintainers. The update notice compares the `version` in `extension/manifest.json` with the latest release tag, so every release has to raise it. One script does the whole job: it raises the version, runs the tests, builds the setup, commits, pushes, and creates the GitHub release with the setup attached and its SHA-256 in the notes.

A release is named `v<version>` and holds files named `dsx-<version>-<what>`, all built into one folder per version in `dist`:

```
dist/0.6.0/
  dsx-0.6.0-setup.exe                   Windows setup, attached to the release
  dsx-0.6.0-firefox-unsigned.zip        what you send to Mozilla for signing
  dsx-0.6.0-firefox.xpi                 the signed file, attached when it is there
```

```bash
powershell -ExecutionPolicy Bypass -File installer/release.ps1 -Version 0.2.0
```

It needs Node.js, git and the [GitHub CLI](https://cli.github.com) logged in to the account that owns the repository. Add `-DryRun` to rehearse everything except the commit, the push and the publishing, and `-WithE2E` to run the end-to-end test too.

## Permission modes

| Preset | What happens |
| --- | --- |
| Read Only (default) | `shell`, `write` and `edit` wait for your approval, with a diff for edits. `read`, `glob` and `grep` run by themselves inside the workspace you picked, and ask first anywhere else and for sensitive files such as `.env` and SSH keys. "Always allow in this chat" skips the question until the page is reloaded. |
| Workspace Write | Like Read Only, and `write` and `edit` also run by themselves inside the workspace, except for sensitive files. `shell` still asks, because a command can reach anywhere. |
| Full access | Commands run at once, without asking. Cards are marked `auto`. |

Every preset stops and asks after 25 automatic changes in a row. Commands replayed from a resumed stream always ask, and commands found in the chat history never run again.

## Security

Read this before you use Full access.

- Commands run with your user's full rights. In Full access mode nothing stands between the model and your machine.
- The model reads things you did not write: web search results, file contents, command output. They can contain instructions meant to steer it (prompt injection).
- In Full access mode, a script running on chat.deepseek.com could trigger a command by forging the message the page hook sends. In Read Only mode it could only make an approval card appear. The cards live in a closed shadow root and react only to real clicks.
- The danger labels on approval cards are pattern matches. They miss things, so read the command itself.
- `AGENTS.md` and `CLAUDE.md` in a folder you pick are given to the model as instructions from you, without asking. A repository you downloaded can contain text meant to steer the model into running commands. Pick only folders you trust, and keep Read Only or Workspace Write for anything else. `/status` shows which files were read.
- The side terminal runs what you type with your own rights, without asking: it is you typing. Pasting a command from a web page into it is as dangerous as in any terminal. Only your own keys and clicks work in it: a script on the page cannot type into it.
- Everything a tool reads and everything a command prints is sent to DeepSeek's servers, secrets included. `glob` and `grep` skip common secret files. `shell` and an approved `read` do not.

## How it works

```
page-hook.js (page world)  <->  content.js + cards.js (isolated world)  <->  background.js  <->  host/host.js  <->  shell
```

| File | Role |
| --- | --- |
| `extension/lib/protocol.js` | The hidden prompt, the tool syntax and the format of result messages |
| `extension/lib/stream-filter.js` | Removes tool syntax from the response stream and from the history |
| `extension/lib/chat-stats.js` | The figures of the stats line under the composer: turns, steps, time, speed and tokens |
| `extension/lib/context-usage.js` | Reads the token total DeepSeek counts for a chat, and the model's token limit, for the Context row of the model panel |
| `extension/page-hook.js` | Wraps `XMLHttpRequest` and sends results through the page's own composer |
| `extension/content.js` | Approval decisions, the life of each command, and changes to the page |
| `extension/cards.js` | Draws the tool cards |
| `extension/evil-awakening.js` | The animation played when `/evil` is turned on |
| `extension/evil-greeting.js` | The tougher greetings on an empty chat while `/evil` is on |
| `extension/terminal.js` | The side terminal panel |
| `extension/lib/terminal-core.js` | What a lone `cd` means, the prompt and the history of the side terminal |
| `extension/page-controls.js` | The status pill, the composer buttons, tooltips and the mode animation |
| `extension/menus.js` | The workspace, permission and model menus |
| `extension/think-collapse.js` | Keeps the thinking blocks collapsed |
| `extension/think-tokens.js` | Shows the reasoning token count in each thinking block |
| `extension/background.js` | Connects tabs to the native host |
| `host/host.js` | Runs commands and tools, streams output, enforces timeouts and kills |
| `host/tools.js` | The `read`, `write`, `edit`, `glob` and `grep` tools |
| `host/instructions.js` | Finds the `AGENTS.md` and `CLAUDE.md` files for the working folder |
| `host/pick-folder.ps1` | The folder dialog on Windows |
| `host/install.js` | Registers and removes the native host when installing from source |
| `installer/` | The Windows setup, the Firefox package, and the build and release scripts |

The model writes `<dsx:shell timeout="30">command</dsx:shell>`, with optional `cwd` and `shell` attributes. Each command is a new process with no stdin, so a `cd` does not carry over to the next one. If the model leaves out the timeout it falls back to 120 seconds, and the maximum is 600.

A reply can hold several tool tags. They run one at a time, in the order the model wrote them, so a batch that touches the same files behaves predictably. All the results go back in one message, and the 20,000-character budget is shared between them, keeping the start and the end of each.

`<dsx:agent description="short title">task</dsx:agent>` hands a self-contained job to a helper. The exception to the one-at-a-time rule above: helpers start at once and run beside the other calls of the reply, so several in one reply work in parallel. See Helpers.

`<dsx:shell background="true">` starts something that keeps running, such as a dev server, and answers at once with a job id like `job-1`. `<dsx:poll id="job-1" wait="30">` returns what the job printed since the last poll, waiting up to 60 seconds for something new, and says whether it is still running. `<dsx:kill id="job-1">` stops it. Background jobs have no timeout, keep their last 512 KB of output, and stop when the browser closes the connection. The Stop button on a running card ends the job too.

## Tests

```bash
npm test
```

```bash
npm run test:e2e
```

The end-to-end test needs Python with Playwright and its Chromium. It loads the real extension and the real native host against a mock of DeepSeek (`test/e2e/mock-deepseek.html`). `helpers.py` covers the helpers: three at once with two places, a refused command, and DeepSeek refusing messages. It registers the host for Playwright's Chromium only, and removes that registration when it ends. It does not touch the real site. Tests that open the real folder dialog on your screen only run with `DSX_TEST_DIALOG=1`.

`test/manual/context-probe.js` is not a test but a measurement. The limit in the model panel comes from the page's model settings, which is not a promise about the real context window. The probe sends one message of about 1,000,000 tokens from your own page, with five codes hidden in it, and reports what DeepSeek counted, whether it refused the message, and which codes the model could read back. The steps to run it are at the top of the file. It uses your account: only run it when you want that.

## Uninstall

Remove the extension from the browser, then run:

```bash
node host/install.js --uninstall
```

## License

MIT. See [LICENSE](LICENSE).
