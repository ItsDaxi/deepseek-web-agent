'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const P = require('../../extension/lib/projects.js');

const A = '11111111-1111-4111-8111-111111111111';
const B = '22222222-2222-4222-8222-222222222222';
const C = '33333333-3333-4333-8333-333333333333';

test('sessionOf finds the chat id in an address and ignores the rest', () => {
  assert.equal(P.sessionOf(`https://chat.deepseek.com/a/chat/s/${A.toUpperCase()}`), A);
  assert.equal(P.sessionOf('/'), null);
  assert.equal(P.sessionOf(null), null);
});

test('a chat takes the folder that was selected when its first message was sent, and keeps it', () => {
  let chats = P.touchChat({}, { sessionId: A, path: 'C:\\work\\app\\', at: 1 });
  assert.deepEqual(chats[A], { path: 'C:\\work\\app', title: '', at: 1 });
  // Later messages only move the time, even if another folder is selected by then.
  chats = P.touchChat(chats, { sessionId: A, path: 'C:\\other', at: 5 });
  assert.deepEqual(chats[A], { path: 'C:\\work\\app', title: '', at: 5 });
});

test('a chat with no folder or no id is not tied to anything', () => {
  const none = {};
  assert.equal(P.touchChat(none, { sessionId: A, path: '', at: 1 }), none);
  assert.equal(P.touchChat(none, { sessionId: null, path: 'C:\\work', at: 1 }), none);
});

test('titles are copied once and leave the list alone when nothing changed', () => {
  const chats = P.touchChat({}, { sessionId: A, path: '/work/app', at: 1 });
  const named = P.setTitle(chats, A, '  Fix   the parser ');
  assert.equal(named[A].title, 'Fix the parser');
  assert.equal(P.setTitle(named, A, 'Fix the parser'), named);
  assert.equal(P.setTitle(named, A, '   '), named);
  assert.equal(P.setTitle(named, B, 'Unknown chat'), named);
});

test('removing a chat takes it out of its project, and the project goes with its last chat', () => {
  let chats = P.touchChat({}, { sessionId: A, path: '/work/app', at: 1 });
  chats = P.touchChat(chats, { sessionId: B, path: '/work/app', at: 2 });
  chats = P.removeChat(chats, A);
  assert.deepEqual(P.groupProjects(chats).map((group) => group.chats.map((chat) => chat.id)), [[B]]);
  chats = P.removeChat(chats, B);
  assert.deepEqual(P.groupProjects(chats), []);
  assert.equal(P.removeChat(chats, C), chats);
});

test('projects are the folders with chats, the newest first, and each lists its newest chat first', () => {
  let chats = {};
  chats = P.touchChat(chats, { sessionId: A, path: 'C:\\work\\app', at: 10 });
  chats = P.touchChat(chats, { sessionId: B, path: 'C:\\work\\site', at: 30 });
  chats = P.touchChat(chats, { sessionId: C, path: 'c:\\WORK\\app\\', at: 20 });
  const groups = P.groupProjects(chats);
  assert.deepEqual(groups.map((group) => group.name), ['site', 'app']);
  assert.deepEqual(groups[1].chats.map((chat) => chat.id), [C, A]);
  assert.equal(groups[1].chats[0].title, 'New chat');
});

test('two folders with one name are told apart by the folder that holds them', () => {
  const labels = P.labelsFor(['C:\\work\\app', 'C:\\play\\app', 'C:\\work\\site']);
  assert.equal(labels.get('C:\\work\\app'), 'app · work');
  assert.equal(labels.get('C:\\play\\app'), 'app · play');
  assert.equal(labels.get('C:\\work\\site'), 'site');
});

test('the stored list is capped and keeps the newest chats', () => {
  const chats = {};
  for (let index = 0; index < 5; index += 1) chats[`id-${index}`] = { path: '/work', title: '', at: index };
  assert.deepEqual(Object.keys(P.prune(chats, 3)).sort(), ['id-2', 'id-3', 'id-4']);
  assert.equal(P.prune(chats, 10), chats);
});

test('pathOf says where a chat belongs, and samePath ignores case and a closing slash', () => {
  const chats = P.touchChat({}, { sessionId: A, path: '/work/app', at: 1 });
  assert.equal(P.pathOf(chats, A), '/work/app');
  assert.equal(P.pathOf(chats, B), null);
  assert.ok(P.samePath('C:\\Work\\App\\', 'c:\\work\\app'));
  assert.ok(!P.samePath('C:\\work\\app', 'C:\\work\\apps'));
});

test('projects keep the order the user dragged them to, and a new one goes on top', () => {
  let chats = {};
  chats = P.touchChat(chats, { sessionId: A, path: '/work/app', at: 10 });
  chats = P.touchChat(chats, { sessionId: B, path: '/work/site', at: 30 });
  chats = P.touchChat(chats, { sessionId: C, path: '/work/docs', at: 20 });
  const names = (order) => P.groupProjects(chats, order).map((group) => group.name);
  assert.deepEqual(names([]), ['site', 'docs', 'app']);
  assert.deepEqual(names(['/work/app', '/work/site', '/work/docs']), ['app', 'site', 'docs']);
  // A folder that is not in the order yet is new, and comes first.
  assert.deepEqual(names(['/WORK/app/', '/work/site']), ['docs', 'app', 'site']);
  // Folders in the order that have no chat any more are ignored.
  assert.deepEqual(names(['/gone', '/work/app']), ['site', 'docs', 'app']);
});

test('reorder drops a project before or after another and leaves the rest as they are', () => {
  const shown = ['/a', '/b', '/c', '/d'];
  assert.deepEqual(P.reorder(shown, '/d', '/b', false), ['/a', '/d', '/b', '/c']);
  assert.deepEqual(P.reorder(shown, '/a', '/c', true), ['/b', '/c', '/a', '/d']);
  assert.deepEqual(P.reorder(shown, '/b', '/b', true), shown);
  assert.deepEqual(P.reorder(shown, '/missing', '/b', true), shown);
});

test('the chats of a project can be listed and removed together', () => {
  let chats = {};
  chats = P.touchChat(chats, { sessionId: A, path: '/work/app', at: 1 });
  chats = P.touchChat(chats, { sessionId: B, path: '/WORK/app/', at: 2 });
  chats = P.touchChat(chats, { sessionId: C, path: '/work/site', at: 3 });
  assert.deepEqual(P.idsOf(chats, '/work/app').sort(), [A, B]);
  const left = P.removeChats(chats, [A, B, 'not-a-chat']);
  assert.deepEqual(Object.keys(left), [C]);
  assert.equal(P.removeChats(left, [A]), left);
});
