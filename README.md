# DeepSeek Web Agent

A browser extension, for Chromium browsers and Firefox, that lets the [DeepSeek web chat](https://chat.deepseek.com) read and edit files and run commands on your computer. It works with the free chat on the website. There is no API key and nothing to pay for.

This is unofficial and has nothing to do with DeepSeek. It relies on the site's private web API and on the structure of its pages, so a DeepSeek update can break it without warning. Check DeepSeek's terms of use before you rely on it.

## What it does

The extension adds a hidden prompt to your messages that teaches the model six tools: `read`, `write`, `edit`, `glob`, `grep` and `shell`, plus helpers for long jobs (see Helpers), the tools of your MCP servers (see MCP servers), and a plan mode that makes the model show a plan before it changes anything (see Plan mode), and a task list that stays above the composer (see Task list). `read` also works on images, PDFs and Office documents (see Images, PDFs and documents). When the model uses one, the extension takes the call out of the response before the page draws it, shows a card in its place, and runs the call through a small native program on your machine. The result goes back to the model as a hidden message.

The hidden prompt is added to outgoing requests and removed from the history again, so it never shows up in the chat. DeepSeek's own web search and DeepThink keep working.

Developed and tested on Windows with Brave and Chromium. It should work in Chrome and Edge. Firefox 140 or newer is supported too, but that build is new and has had much less use than the Chromium one. macOS and Linux are supported by the host but have had much less use.

## Screenshots

The controls sit in the page's own composer: the workspace above it, the permission preset and the model panel inside it, and the connection pill at the top right.

![The DeepSeek chat with the extension's controls in the composer](docs/home.png)

A tool call shows up as a card between the thinking block and the answer. The thinking header carries the live token count.

![A write call shown as a card, with the model's answer below it](docs/tool-call.png)

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

1. Get the code and open a terminal in the project's top folder, the one that holds both `extension` and `host`. If you downloaded the zip from GitHub, unzip it and `cd` into the result (it is called `deepseek-web-agent-main`). Then register the native host, which is the part that actually runs commands:

   ```bash
   cd path/to/deepseek-web-agent-main
   node host/install.js
   ```

   The script is `host/install.js`, not `install/host.js`, and it must be run from the top folder, not from inside `extension`. A `Cannot find module` error means the terminal is in the wrong folder or the path is mistyped. Run `ls` and check that you see `extension` and `host` before you run it.

   Add `--browsers brave,chrome` to pick browsers (`chrome`, `brave`, `chromium`, `edge`, `firefox`). The path of the host is written into the registration, so run this again if you move the folder or change your Node installation.

   Run it from a normal terminal. On Windows, a packaged app (the Claude desktop app, for one) gets a private copy of the registry, so a registration made from inside it is invisible to a browser you start yourself.

2. Open `brave://extensions` (or `chrome://extensions`), turn on Developer mode, click Load unpacked and select the `extension` folder. For Firefox, see the section above.

3. Restart the browser and open [chat.deepseek.com](https://chat.deepseek.com). A pill at the top right should read `Shell · Connected`.

## Using it

All controls sit in the composer of the DeepSeek page. The extension has no toolbar popup. To turn it off, disable the extension in the browser.

- **Default workspace**, above the composer, is the working directory. Its menu lists the folders you used before; "Add workspace..." opens your system's folder dialog.
- The paperclip opens DeepSeek's own file dialog.
- The permission button (**Plan Mode**, **Read Only**, **Workspace Write**, **Full access**) opens a menu of presets. A short pixel wave crosses the composer when you change it.
- The model button opens a small panel. The model is fixed. **Effort** is on or off and works exactly like DeepSeek's DeepThink button, which the extension hides and drives for you. Search is always on, and its button is hidden too.
- "Thought for N seconds" blocks are kept collapsed. Click one to read it, and it stays open. To stop this, run `chrome.storage.local.set({ collapseThinking: false })` in the extension's service worker console.
- The model panel (click the model name above the send button) has a Context row: the tokens the chat has used against the model's 1M-token window, like `212K / 1M`, with a thin bar that turns amber and then red as it fills. It updates at the end of every reply, with the total DeepSeek counts.
- Each thinking block shows how many tokens the model spent reasoning, counted live as it streams (`1.2K tokens`). DeepSeek sends the reasoning one token per chunk, so the count is exact; blocks from an earlier visit show none.
- In a conversation, a line under the composer sums up the chat: turns and steps, the time the model spent (`LLM`), the average wait for the first token and the speed (`TTFT avg`, `tok/s`), and the tokens in and out. A turn is a message you wrote and a step is one reply of the model, so a command that goes back to the model adds a step. Input is what DeepSeek counts for the chat minus what the model wrote. A chat the tab did not follow from its first message, such as one opened from the history, shows only what happened since, and no input. The figures are kept while the tab lives, so a reload does not lose them. DeepSeek does not report cache hits to the page, so there is no such figure.
- On a new chat, before there is a conversation, the composer glows softly.

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
| `/plan` | Turns plan mode on, or off again, going back to the preset you had before. See Plan mode. |
| `/model` | Opens the model panel, like the model button. |
| `/status` | Shows the extension version, the shell host, the permissions, the workspace, the instruction files found, the MCP servers and their tools, the effort and the thinking setting. |
| `/thinking collapse` or `/thinking default` | Keeps the thinking blocks collapsed, or leaves them as DeepSeek shows them. |
| `/terminal` | Opens or closes the side terminal. See below. |
| `/update` | Asks GitHub for the latest release now, and shows the update pill again if it was closed. It works even when the automatic check is off, because you are asking for it. |
| `/help` | Lists the commands. |

A command answers in a small panel above the composer, which closes by itself or when you click it.

### Images, PDFs and documents

The model can look at files that are not text, on your computer: images (`png`, `jpg`, `gif`, `webp`, `bmp`, `tiff`, `avif`), PDFs, Word, Excel and PowerPoint files (`docx`, `xlsx`, `pptx` and the old `doc`, `xls`, `ppt`) and `epub` books. It uses the same `read` tool as for any file, and you ask for it in plain words: "look at `C:\scans\invoice.pdf`" or "what is on this screenshot, `shots/error.png`?".

`read` cannot print such a file, so the host sends its bytes to the page, and the page takes them as if you had picked the file with the paperclip. DeepSeek uploads and parses it, and the message that carries the result of the call goes out with the file attached. What the model gets is what DeepSeek makes of the file: the text of a PDF or an Office document, and the text it recognises in an image. This extension does not read the files itself, and a picture's contents that DeepSeek's chat does not describe do not reach the model.

- The call is approved like any other `read`: it runs by itself inside the workspace and asks first anywhere else. The card says which file it is.
- A file can be at most 20 MB, and one message carries at most 10 files. DeepSeek has limits of its own too, and when it refuses a file (too long, empty, unreadable) the model is told why and carries on without it.
- A message that carries a file keeps the page's own search setting instead of forcing search on, because DeepSeek does not allow both together for some models.
- The file is sent to DeepSeek's servers, like everything a tool reads. Do not ask for one you would not paste into the chat.
- A helper can attach files too, with the same rules.

### Plan mode

Plan mode makes the model look first and change nothing until you have approved a plan. Choose **Plan Mode** in the permission menu, or type `/plan`; type it again to go back to the preset you had.

While it is on:

- The model reads, lists and searches by itself, inside the workspace, and may hand a large search to a helper. A command asks you first, with a reminder that it must only look, and "Always allow in this chat" is not offered. `write`, `edit` and MCP calls are refused without asking, and the model is told so.
- The hidden prompt tells the model about plan mode with every message, so it works in a chat that was already running. It also tells the model to present its plan with a plan tag when it is ready: the goal, the files and what changes in each, the steps in order, the risks and how to check the result. A question, or a request that needs no change, is simply answered.
- The plan arrives as a card, **Approve this plan?**, with the plan written out. **Approve, ask for each change** ends plan mode in Read Only. **Approve, edit the workspace freely** ends it in Workspace Write. **Keep planning** tells the model the plan was not approved, so it asks what you want different or revises it. Either approval tells the model to carry the plan out, and the permission button shows the new preset.
- Full access and "Always allow in this chat" do not count in plan mode: nothing is skipped.
- A helper in plan mode can only look. It cannot present a plan: it reports what it found.

Plan mode steers the model, and the refusal of `write`, `edit` and MCP calls is enforced by the extension. A command is not: it can still change things once you approve it, so read it before you do.

### Task list

For work that takes three steps or more, the model keeps a task list, as the other coding agents do. It writes the whole list each time it changes, with a `todo` tag, one task to a line: `[ ]` to do, `[~]` being worked on, `[x]` done. The list is not an action on your computer, so it runs at once in every mode, without a question.

- The list sits **above the composer**, over the workspace button, for as long as the chat is open, so you can follow where the model is without scrolling. It shows a bar of how many tasks are done (`2/5`), strikes the finished ones and spins on the one in hand. Click its header to fold it into one line that names the current task, and again to open it.
- Each update also leaves a small card in the chat, `Tasks 2/5`, which opens to the list as the model wrote it.
- Every chat has its own list. It comes back when you reload the page and when you open the chat from the history, because it is rebuilt from the last list the model wrote in it.
- A list holds at most 30 tasks, each cut at 200 characters. An empty one clears it.
- It also works in plan mode. A helper has no list, since nobody would see it.

### Instruction files

The extension reads `AGENTS.md` and `CLAUDE.md`, the files other coding agents use for standing instructions, and gives them to the model in the hidden prompt.

- **For every folder.** Put them in `.dsx` in your home folder, for example `C:\Users\you\.dsx\AGENTS.md`. The folder is yours: the only thing the host ever writes there is an empty `mcp.json`, when there is none (see MCP servers), and an update never touches anything in it.
- **For one folder.** Put them in the workspace you picked, or in any folder above it up to your home folder. A project can have its own, and a folder further up can have one for all its projects.

The user's files come first, then the folders from the outermost to the working folder. When two of them disagree, the one listed last wins, so the file closest to your work has the final word. In each folder `AGENTS.md` comes before `CLAUDE.md`. Only these two names are read, only in those places, and nothing else on the disk. The files of other tools, such as `~/.claude/CLAUDE.md` or `~/.codex/AGENTS.md`, are not read: copy or link the text into `.dsx` if you want it here. Their MCP server lists are the exception: see MCP servers.

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

While a chat has helpers, an **Agents** button appears above the composer, beside the workspace, with how many there are and a pulsing dot while any is still working. It opens a list with one row per helper: its name, its state, the input and output tokens its chat has used so far (the same figures as the stats line, so input is the chat's token total minus what the model wrote), and the time it has taken, which keeps counting while it works. The list belongs to the chat that is open, so another chat in the same tab does not show these helpers, and it comes back after a reload of the page. A row opens the helper: a helper that is working is in a tab of its own, which comes to the front, and one that has ended has its chat opened in a new tab. A helper that is waiting for a free place is only shown. A helper that has ended has an X on its row (or Delete, on the highlighted row), and the menu offers Clear finished: both only take it off the list, and its chat stays in your DeepSeek history. A helper that is working cannot be removed; stop it from its card first.

In the tab of a helper, or in a tab opened to look at one, a **Main chat** button at the top right, left of the terminal button, takes you back to the chat that asked. From a tab that was opened only to look at a finished helper, it also closes that tab; a working helper's tab stays open.

A helper's chat shows up in your DeepSeek history like any other.

### MCP servers

The model can call the tools of the MCP servers you already set up for Claude Code and Codex. There is nothing to configure here: the native host reads their config files, starts the servers, lists their tools to the model in the hidden prompt, and runs the calls the model writes. A server behaves as it does in those two tools, because it is the same program speaking the same protocol, started with the same command, arguments and environment.

The host reads these places and nothing else:

| File | What is read |
| --- | --- |
| `~/.dsx/mcp.json` | `{ "mcpServers": { ... } }`, the same format as Claude Code's `.mcp.json`. Use it for a server only this tool should have. The host creates it, empty, the first time it lists the servers, and never changes it after that. |
| `~/.claude.json` | The user servers (`mcpServers`) and the servers of the workspace you picked (`projects`), minus the ones turned off for it. `CLAUDE_CONFIG_DIR` moves it. |
| `~/.codex/config.toml` | The `[mcp_servers.*]` tables, with `startup_timeout_sec`, `tool_timeout_sec`, `enabled`, `enabled_tools`, `disabled_tools`, `cwd`, `bearer_token_env_var`, `http_headers` and `env_http_headers`. `CODEX_HOME` moves it. |

When the same name is in more than one place, `~/.dsx/mcp.json` wins, then Claude Code, then Codex. Both stdio servers (a command) and streamable HTTP servers (a url) work. `${NAME}` and `${NAME:-default}` are expanded in Claude Code entries, as Claude Code does. On Windows a command such as `npx` is found the way the shell finds it.

A project's own `.mcp.json` and `.codex/config.toml` are **not** read. They would make the host start a program named by a folder you may have just downloaded, which is the same risk as a hostile `AGENTS.md`, only worse. Put the server in one of the files above if you want it here.

The servers start when the page connects to the host and when you change workspace, and stay up until the browser closes the connection. A server that takes long to start does not hold back the others: its tools reach the model with your next message once it is ready. `/status` lists each server, where it came from and how many tools it gave, or why it failed. The list in the prompt is capped at about 14,000 characters: past that, descriptions are cut first, then argument names, and only then tools.

The model writes `<dsx:mcp server="github" tool="create_issue">{"title": "x"}</dsx:mcp>`, with the arguments as one JSON object. The card is titled `MCP github: create_issue` and shows the arguments. Every call asks for approval in Read Only and in Workspace Write, because a tool of someone else's server can do anything and its effect cannot be told from its name. Full access runs them at once, and "Always allow in this chat" works as it does for commands. A helper never gets MCP tools. The timeout is the one in the server's config (`tool_timeout_sec` for Codex), 120 seconds without one, or the `timeout` attribute of the tag, up to 600 seconds.

The hidden prompt also tells the model where its own config lives on your machine: the user folder, its `AGENTS.md`, `mcp.json`, and the Claude Code and Codex files, with the format of an entry. So you can ask the chat to add an MCP server or change an instruction, and it edits the right file with its normal tools (which ask for approval like any write). The change is picked up when you reload the page or change workspace. A helper is not told, since it cannot ask for approval.

What is not supported: signing in to a server through a browser (OAuth), the old SSE transport, and anything a server asks of the client, such as sampling or roots. For an HTTP server that needs a token, put it in the headers, as `bearer_token_env_var` or `http_headers` in Codex or `headers` in Claude Code.

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
| Plan Mode | `read`, `glob` and `grep` run by themselves inside the workspace. `write`, `edit` and MCP calls are refused, and `shell` asks. The model presents a plan, and you approve it to leave this mode. See Plan mode. |
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
- Everything a tool reads and everything a command prints is sent to DeepSeek's servers, secrets included. `glob` and `grep` skip common secret files. `shell` and an approved `read` do not. An image, a PDF or a document that `read` attaches is uploaded to DeepSeek as a file, with the same approval rules as any `read`.
- MCP servers run with your rights, started by the host from your own config files, and whatever one returns is sent to DeepSeek too. The tokens in those files stay on your machine: the model is shown the names of the tools, never the config. Approve a call only after reading its arguments, and remember that what a server returns can contain instructions meant to steer the model.

## How it works

```
page-hook.js (page world)  <->  content.js + cards.js (isolated world)  <->  background.js  <->  host/host.js  <->  shell
```

| File | Role |
| --- | --- |
| `extension/lib/protocol.js` | The hidden prompt, the tool syntax and the format of result messages |
| `extension/lib/stream-filter.js` | Removes tool syntax from the response stream and from the history |
| `extension/lib/chat-stats.js` | The figures of the stats line under the composer: turns, steps, time, speed and tokens |
| `extension/lib/todo.js` | Reads the model's task list and says how far it is |
| `extension/lib/context-usage.js` | Reads the token total DeepSeek counts for a chat, and the model's token limit, for the Context row of the model panel |
| `extension/page-hook.js` | Wraps `XMLHttpRequest`, sends results through the page's own composer, and puts the files `read` attached into the page's file input |
| `extension/content.js` | Approval decisions, the life of each command, and changes to the page |
| `extension/cards.js` | Draws the tool cards |
| `extension/terminal.js` | The side terminal panel |
| `extension/lib/terminal-core.js` | What a lone `cd` means, the prompt and the history of the side terminal |
| `extension/page-controls.js` | The status pill, the composer buttons, tooltips and the mode animation |
| `extension/menus.js` | The workspace, permission and model menus |
| `extension/think-collapse.js` | Keeps the thinking blocks collapsed |
| `extension/think-tokens.js` | Shows the reasoning token count in each thinking block |
| `extension/background.js` | Connects tabs to the native host |
| `host/host.js` | Runs commands and tools, streams output, enforces timeouts and kills |
| `host/tools.js` | The `read`, `write`, `edit`, `glob` and `grep` tools, and the check that decides a file is attached rather than printed |
| `host/instructions.js` | Finds the `AGENTS.md` and `CLAUDE.md` files for the working folder |
| `host/mcp-config.js` | Reads the MCP servers set up for Claude Code (`~/.claude.json`), Codex (`~/.codex/config.toml`) and `~/.dsx/mcp.json` |
| `host/mcp.js` | The MCP client: starts the servers (stdio or streamable HTTP), lists their tools and calls them |
| `host/toml.js` | A small TOML reader for Codex's config |
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
