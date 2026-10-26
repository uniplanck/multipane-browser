// node test/gbar-presence.test.js — pure URL/pane matching; no Electron or network.
const P = require('../src/gbar-presence');
const GB = require('../src/grok-bots');
let bad = 0; const t = (n, ok) => { if (!ok) bad++; console.log(ok ? 'ok  ' : 'FAIL', n); };
const J = JSON.stringify, url = id => 'https://grok.com/bot/' + id;
const ids = p => [...p.openIds].sort();

t('URL: canonical ID, trailing slash, query, hash and nested conversation routes identify the same bot',
  ['', '/', '?chat=other', '#reply', '/?chat=other#reply', '/chat/thread?x=1'].every(s => P.botId(url('Agent_1-a') + s) === 'Agent_1-a'));
t('URL: normalised scheme/host and default HTTPS port; ID case stays significant',
  P.botId('HTTPS://GROK.COM:443/bot/Agent') === 'Agent' && P.botId(url('agent')) === 'agent');
t('URL: reject wrong origins, schemes, credentials, ports, missing IDs and invalid ID segments',
  [null, undefined, {}, 7, '', 'bad URL', '/bot/a', 'http://grok.com/bot/a', 'https://grok.com.evil/bot/a',
    'https://evilgrok.com/bot/a', 'https://sub.grok.com/bot/a', 'https://grok.com:444/bot/a', 'https://user@grok.com/bot/a',
    'https://user:pass@grok.com/bot/a', 'https://elsewhere.test/?url=' + url('a'), 'https://grok.com/?bot=a',
    'https://grok.com/bot/', url('bad.id'), url('a'.repeat(65)), url('__proto__')].every(u => P.botId(u) === ''));

{ const panes = [{ id: 0, url: url('bot-a') }, { id: 2, url: url('group-b') + '/?chat=1#reply' },
    { id: 3, url: url('bot-a') + '/chat/2' }, { id: 4, url: 'https://example.com/' }];
  const before = J(panes), r = P.match(panes, 0);
  t('all panes count; duplicate bot panes deduplicate; focused pane ID may be zero',
    J(ids(r)) === J(['bot-a', 'group-b']) && r.focusedId === 'bot-a');
  t('focus on another pane of the same bot still matches; groups use the same route',
    P.match(panes, 3).focusedId === 'bot-a' && P.match(panes, 2).focusedId === 'group-b');
  t('unrelated / missing focus leaves open IDs intact and clears emphasis', [4, 9, undefined].every(id => {
    const p = P.match(panes, id); return p.focusedId === '' && J(ids(p)) === J(ids(r));
  }));
  t('matching does not mutate panes and returns fresh independent sets', before === J(panes) && P.match(panes, 0).openIds !== r.openIds);
  t('navigate / close / open: recompute from current URLs, without remembering stale IDs',
    !P.match(panes.filter(p => p.id !== 2), 2).openIds.has('group-b')
    && !P.match(panes.map(p => ({ ...p, url: 'https://example.com/' })), 0).openIds.size
    && P.match([...panes, { id: 5, url: url('new') }], 5).focusedId === 'new');
}
{ const g = GB.clean({ bots: [{ id: 'a', name: 'Bot' }, { id: 'ab', name: 'Group', isGroup: true }], pins: ['ab'] }).grok;
  const view = GB.view(g), r = P.match(g.bots.map((b, i) => ({ id: i + 1, url: b.url + '?chat=x' })), 2);
  t('real group/bot view URLs match their IDs, including pins; IDs with a common prefix stay distinct',
    [...view.pins, ...view.sections.flatMap(s => s.items)].every(b => r.openIds.has(P.botId(b.url)))
    && r.focusedId === 'ab' && !P.match([{ id: 1, url: url('ab') }], 1).openIds.has('a'));
}
t('empty / non-URL panes: no open or focused item', !P.match().openIds.size && P.match().focusedId === ''
  && !P.match([null, {}, { id: 1, url: 'about:blank' }], 1).openIds.size);
t('missing focus cannot match a pane with no ID; sleeping/queued pane URLs still count as open',
  P.match([{ url: url('a') }]).focusedId === ''
  && J(ids(P.match([{ id: 1, url: url('a'), sleeping: true }, { id: 2, url: url('b'), lq: 'wait' }]))) === J(['a', 'b']));

console.log(bad ? bad + ' failed' : 'all passed'); process.exit(bad ? 1 : 0);
