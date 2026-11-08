// The parts of the side terminal that need no page: what a lone `cd` means, the command that finds out
// where it leads, how the prompt reads, and the history of what was typed.
//
// The terminal runs each command as a process of its own, exactly like the model's commands do, so a
// directory change cannot live inside a command. The panel keeps the working folder itself: a lone `cd`
// is turned into a small command that asks the shell where it would end up, and the panel remembers
// the answer for the next command.
(function (root) {
  'use strict';

  const MAX_HISTORY = 100;

  // Only a lone cd counts. Anything joined to another command (`cd x; npm test`) runs as it is, inside
  // its own process, where the cd works for that command and then is gone.
  const CD = /^\s*(?:cd|chdir|sl|set-location)(?=\s|$)\s*(.*?)\s*$/i;
  const JOINED = /[;&|\n\r]|\$\(|`/;

  function stripQuotes(text) {
    const match = /^(["'])(.*)\1$/.exec(text);
    return match ? match[2] : text;
  }

  // Returns { target } for a lone cd, or null. The target is '' for "go home" and '-' for "go back".
  function parseCd(command) {
    const match = CD.exec(String(command));
    if (!match) return null;
    let rest = match[1];
    if (JOINED.test(rest)) return null;
    // cmd's /d switch and PowerShell's -Path and -LiteralPath only name the target.
    rest = rest.replace(/^\/d\s+/i, '').replace(/^-(?:literalpath|path)\s+/i, '');
    return { target: stripQuotes(rest.trim()) };
  }

  function isPowerShell(shell) {
    return shell === 'powershell' || shell === 'pwsh';
  }

  // Where `target` leads from `cwd`: the target as typed, with ~ meaning the home folder.
  function expandTarget(target, home) {
    if (target === '' || target === '~') return home || '';
    if (home && /^~[\\/]/.test(target)) return `${home}${target.slice(1)}`;
    return target;
  }

  // The command that changes into `target` and prints the folder it ended in. It runs in the current
  // folder, so a relative target and `..` mean what they mean at the prompt.
  function cdCommand(shell, target) {
    if (isPowerShell(shell)) return `Set-Location -LiteralPath '${target.replace(/'/g, "''")}'; (Get-Location).Path`;
    if (shell === 'cmd') return `cd /d "${target.replace(/"/g, '')}" && cd`;
    return `cd -- '${target.replace(/'/g, "'\\''")}' && pwd`;
  }

  // The last line of what the command printed, which is the folder.
  function folderFrom(output) {
    const lines = String(output).split('\n').map((line) => line.trim()).filter(Boolean);
    return lines.length ? lines[lines.length - 1] : '';
  }

  const same = (a, b, windows) => (windows ? a.toLowerCase() === b.toLowerCase() : a === b);

  // "PS C:\\Users\\me\\work>" in PowerShell, "~/work $" elsewhere, the way each shell writes it.
  function formatPrompt(cwd, shell, home, windows = false) {
    if (isPowerShell(shell)) return `PS ${cwd}>`;
    if (shell === 'cmd') return `${cwd}>`;
    let shown = cwd;
    if (home && cwd.length >= home.length && same(cwd.slice(0, home.length), home, windows)) {
      const rest = cwd.slice(home.length);
      if (rest === '' || /^[\\/]/.test(rest)) shown = `~${rest}`;
    }
    return `${shown} $`;
  }

  // The list with `command` added, newest last. A blank line and a repeat of the last one are not kept.
  function pushHistory(history, command) {
    const text = String(command).trim();
    if (!text || history[history.length - 1] === text) return history;
    return [...history, text].slice(-MAX_HISTORY);
  }

  // Moves through the history with the arrow keys. `index` is the position, history.length meaning
  // "the line being typed". Returns { index, text }, where text is null for the line being typed.
  function stepHistory(history, index, direction) {
    const next = Math.min(Math.max(index + direction, 0), history.length);
    return { index: next, text: next === history.length ? null : history[next] };
  }

  const api = { parseCd, expandTarget, cdCommand, folderFrom, formatPrompt, pushHistory, stepHistory, MAX_HISTORY };

  if (typeof module !== 'undefined' && module.exports) module.exports = api;
  else root.DsxTerminalCore = api;
})(typeof globalThis !== 'undefined' ? globalThis : this);
