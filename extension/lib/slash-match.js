// Decides what the composer text means for slash commands. It only reads text: drawing the menu and
// running the commands is done elsewhere, so this can be tested without a browser.
//
// A command is { name, description, group?, args? }, where args is a list of { value, description }.
(function (root) {
  'use strict';

  // The text counts as a command only while it is a single slash word, or a slash word and one
  // argument. Anything else, such as a path or a sentence that starts with a slash, is a message.
  const COMMAND_TEXT = /^\/([a-z0-9-]*)$/i;
  const ARGUMENT_TEXT = /^\/([a-z0-9-]+)[ \t]+(\S*)$/i;

  function parse(text) {
    const value = String(text === undefined || text === null ? '' : text);
    let match = COMMAND_TEXT.exec(value);
    if (match) return { kind: 'command', query: match[1].toLowerCase() };
    match = ARGUMENT_TEXT.exec(value);
    if (match) return { kind: 'argument', name: match[1].toLowerCase(), query: match[2].toLowerCase() };
    return { kind: 'none' };
  }

  // Names that start with the query come first, then the ones that only contain it.
  function filter(items, query, key) {
    const text = (item) => String(item[key]).toLowerCase();
    const starts = items.filter((item) => text(item).startsWith(query));
    const contains = items.filter((item) => !text(item).startsWith(query) && text(item).includes(query));
    return [...starts, ...contains];
  }

  // Commands may have a `group`, and the menu draws a heading for each. A filter can mix the groups
  // up, so the items of one group are put back together, keeping their order and the order of the groups.
  function groupTogether(items) {
    const groups = [];
    for (const item of items) if (!groups.includes(item.group)) groups.push(item.group);
    if (groups.length < 2) return items;
    return [...items].sort((a, b) => groups.indexOf(a.group) - groups.indexOf(b.group));
  }

  function findCommand(commands, name) {
    return commands.find((command) => command.name === name) || null;
  }

  // What the menu shows and what Tab and Enter would do for this text. Returns null when the text
  // is an ordinary message, which must reach DeepSeek untouched.
  //
  //   items       the suggestions to list
  //   selected    the one at `index`, or null when the argument typed matches none of them
  //   completion  the text Tab puts in the composer
  //   run         what Enter runs, or null when Enter should complete the text instead
  function plan(commands, text, index = 0) {
    const parsed = parse(text);
    if (parsed.kind === 'command') {
      const items = groupTogether(filter(commands, parsed.query, 'name'));
      if (!items.length) return null;
      const selected = items[Math.min(Math.max(index, 0), items.length - 1)];
      const needsArgument = Boolean(selected.args && selected.args.length);
      return {
        kind: 'command',
        items,
        selected,
        completion: `/${selected.name}${needsArgument ? ' ' : ''}`,
        run: needsArgument ? null : { name: selected.name, arg: '' },
      };
    }
    if (parsed.kind === 'argument') {
      const command = findCommand(commands, parsed.name);
      if (!command || !command.args || !command.args.length) return null;
      const items = filter(command.args, parsed.query, 'value');
      const selected = items.length ? items[Math.min(Math.max(index, 0), items.length - 1)] : null;
      return {
        kind: 'argument',
        command,
        items,
        selected,
        completion: `/${command.name} ${selected ? selected.value : parsed.query}`,
        // With no match the typed word is run as it is, and the command says what is wrong with it.
        run: { name: command.name, arg: selected ? selected.value : parsed.query },
      };
    }
    return null;
  }

  const api = { parse, filter, groupTogether, findCommand, plan };

  if (typeof module !== 'undefined' && module.exports) module.exports = api;
  else root.DsxSlashMatch = api;
})(typeof globalThis !== 'undefined' ? globalThis : this);
