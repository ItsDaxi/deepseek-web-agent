// Projects: the chats of the sidebar grouped by the folder they were started in. A chat is tied to the
// workspace that was selected when its first message was sent, and every folder with at least one chat is a
// project. Nothing here touches the page: it is the bookkeeping the sidebar section draws from.
//
//   chats = { [sessionId]: { path: 'C:\\work\\app', title: 'Fix the parser', at: 1731430000000 } }
(function (root) {
  'use strict';

  const MAX_CHATS = 300;
  const MAX_TITLE_CHARS = 120;
  const SESSION = /[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}/i;
  const PLACEHOLDER_TITLE = 'New chat';

  function sessionOf(text) {
    const match = SESSION.exec(String(text || ''));
    return match ? match[0].toLowerCase() : null;
  }

  function cleanPath(path) {
    return String(path || '').trim().replace(/[\\/]+$/, '');
  }

  function samePath(a, b) {
    return cleanPath(a).toLowerCase() === cleanPath(b).toLowerCase();
  }

  function baseName(path) {
    const parts = cleanPath(path).split(/[\\/]+/).filter(Boolean);
    return parts.length ? parts[parts.length - 1] : cleanPath(path);
  }

  function cleanTitle(title) {
    const text = String(title || '').replace(/\s+/g, ' ').trim();
    return text.length > MAX_TITLE_CHARS ? text.slice(0, MAX_TITLE_CHARS) : text;
  }

  function isEntry(value) {
    return Boolean(value) && typeof value.path === 'string' && value.path !== '';
  }

  // Keeps the newest chats when there are too many, so the stored list cannot grow for ever.
  function prune(chats, max = MAX_CHATS) {
    const ids = Object.keys(chats);
    if (ids.length <= max) return chats;
    const keep = ids.sort((a, b) => (chats[b].at || 0) - (chats[a].at || 0)).slice(0, max);
    const next = {};
    for (const id of keep) next[id] = chats[id];
    return next;
  }

  // A message was sent in `sessionId`. A chat with no folder yet takes `path`; one that has one keeps it,
  // and only its time moves. Without a folder there is nothing to tie it to. Returns the same object when
  // nothing changed, so the caller can skip the write.
  function touchChat(chats, { sessionId, path, at }) {
    const id = sessionOf(sessionId);
    if (!id) return chats;
    const known = chats[id];
    if (isEntry(known)) return { ...chats, [id]: { ...known, at } };
    const folder = cleanPath(path);
    if (!folder) return chats;
    return prune({ ...chats, [id]: { path: folder, title: '', at } });
  }

  // The sidebar shows the title DeepSeek gave the chat. A chat that is new has none yet.
  function setTitle(chats, sessionId, title) {
    const id = sessionOf(sessionId);
    const text = cleanTitle(title);
    if (!id || !isEntry(chats[id]) || !text || chats[id].title === text) return chats;
    return { ...chats, [id]: { ...chats[id], title: text } };
  }

  function removeChat(chats, sessionId) {
    return removeChats(chats, [sessionId]);
  }

  function removeChats(chats, sessionIds) {
    let next = chats;
    for (const sessionId of sessionIds) {
      const id = sessionOf(sessionId);
      if (!id || !(id in next)) continue;
      if (next === chats) next = { ...chats };
      delete next[id];
    }
    return next;
  }

  // The ids of every chat of a folder.
  function idsOf(chats, path) {
    return Object.keys(chats).filter((id) => isEntry(chats[id]) && samePath(chats[id].path, path));
  }

  // Two folders with one name are told apart by the folder that holds them: "app · work" and "app · play".
  function labelsFor(paths) {
    const byName = new Map();
    for (const path of paths) {
      const name = baseName(path).toLowerCase();
      byName.set(name, (byName.get(name) || 0) + 1);
    }
    const labels = new Map();
    for (const path of paths) {
      const name = baseName(path);
      if (byName.get(name.toLowerCase()) < 2) {
        labels.set(path, name);
        continue;
      }
      const parts = cleanPath(path).split(/[\\/]+/).filter(Boolean);
      labels.set(path, parts.length > 1 ? `${name} · ${parts[parts.length - 2]}` : name);
    }
    return labels;
  }

  // The projects to draw: the folders that have chats, and in each the newest chat first. Chats of one folder
  // written with another case or a trailing slash are one project. The user can drag the projects into an order
  // of their own: `order` lists the folders in it. A folder that is not in it yet, a new project, goes on top,
  // the one used last first; the rest follow in the order given.
  function groupProjects(chats, order = []) {
    const groups = new Map();
    for (const [id, entry] of Object.entries(chats || {})) {
      if (!isEntry(entry)) continue;
      const key = cleanPath(entry.path).toLowerCase();
      if (!groups.has(key)) groups.set(key, { path: cleanPath(entry.path), chats: [], at: 0 });
      const group = groups.get(key);
      group.chats.push({ id, title: entry.title || PLACEHOLDER_TITLE, at: entry.at || 0 });
      group.at = Math.max(group.at, entry.at || 0);
    }
    const rank = new Map();
    (Array.isArray(order) ? order : []).forEach((path, index) => {
      const key = cleanPath(path).toLowerCase();
      if (typeof path === 'string' && !rank.has(key)) rank.set(key, index);
    });
    const placed = (group) => rank.get(group.path.toLowerCase());
    const list = [...groups.values()].sort((a, b) => {
      const first = placed(a);
      const second = placed(b);
      if (first === undefined && second === undefined) return b.at - a.at || a.path.localeCompare(b.path);
      if (first === undefined) return -1;
      if (second === undefined) return 1;
      return first - second;
    });
    const labels = labelsFor(list.map((group) => group.path));
    for (const group of list) {
      group.chats.sort((a, b) => b.at - a.at || a.id.localeCompare(b.id));
      group.name = baseName(group.path);
      group.label = labels.get(group.path);
    }
    return list;
  }

  // The order of the projects after `from` is dropped before `to`, or after it. Takes and returns folders
  // in the order they are shown, so what the user sees is what gets saved.
  function reorder(paths, from, to, after) {
    const rest = paths.filter((path) => !samePath(path, from));
    const moved = paths.find((path) => samePath(path, from));
    const at = rest.findIndex((path) => samePath(path, to));
    if (moved === undefined || at < 0) return paths;
    rest.splice(after ? at + 1 : at, 0, moved);
    return rest;
  }

  // Which folder a chat belongs to, or null.
  function pathOf(chats, sessionId) {
    const id = sessionOf(sessionId);
    return id && isEntry(chats[id]) ? chats[id].path : null;
  }

  root.DsxProjects = { sessionOf, samePath, baseName, touchChat, setTitle, removeChat, removeChats, idsOf, reorder, groupProjects, pathOf, prune, labelsFor, MAX_CHATS, PLACEHOLDER_TITLE };
  if (typeof module !== 'undefined' && module.exports) module.exports = root.DsxProjects;
})(typeof globalThis !== 'undefined' ? globalThis : this);
