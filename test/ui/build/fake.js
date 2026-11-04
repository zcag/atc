const ASK = (q, opts) => [{ id: 'a1', questions: [{ question: q, options: opts.map((label) => ({ label, description: label })) }] }];

async function fakeSessions(page, base, change) {
  const real = await (await fetch(base + '/api/sessions')).json();
  const list = change(Array.isArray(real) ? real : real.sessions);
  await page.route('**/api/events', (r) => r.fulfill({
    status: 200,
    headers: { 'Content-Type': 'text/event-stream', 'Cache-Control': 'no-cache' },
    body: `event: sessions\ndata: ${JSON.stringify(list)}\n\n`,
  }));
  return list;
}

function needsIn(list, n, bays) {
  const live = list.filter((s) => ['your-turn', 'working'].includes(s.state));
  for (const s of live.slice(0, n)) {
    s.state = 'needs-you';
    s.asks = ASK('Keep both date formats, or normalise to cents?', ['Keep both', 'Normalise to cents']);
    s.activity = 'Keep both date formats, or normalise to cents?';
  }
  for (const [i, name] of (bays || []).entries()) {
    const c = JSON.parse(JSON.stringify(live[0] || list[0]));
    Object.assign(c, { sessionId: `fake-${i}-0000-0000-0000-000000000000`, id: `fake${i}`, title: `${name} session`, cwd: `/home/you/code/${name}`, state: 'needs-you', parked: false, pinned: false,
      asks: ASK('Which branch should this land on?', ['main', 'a new branch']), activity: 'Which branch should this land on?', updated: new Date().toISOString() });
    list.push(c);
  }
  return list;
}

module.exports = { fakeSessions, needsIn };
