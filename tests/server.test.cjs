const { test } = require('node:test');
const assert = require('node:assert/strict');
const { once } = require('node:events');
const { WebSocket } = require('ws');
const { createTestServer } = require('../server.cjs');
const pause = ms => new Promise(resolve => setTimeout(resolve, ms));
async function fixture(t) {
    const app = createTestServer();app.server.listen(0, '127.0.0.1');await once(app.server, 'listening');
    t.after(() => app.close());
    const port = app.server.address().port;
    async function connect(name = 'Player', room = 'TEST') {
        const ws = new WebSocket('ws://127.0.0.1:' + port + '/ws');ws.messages = [];
        ws.on('message', bytes => { ws.messages.push(JSON.parse(bytes.toString())); });ws.on('error', () => {});
        await once(ws, 'open');
        if (name) { ws.send(JSON.stringify({ type: 'join', name, room })); }
        return ws;
    }
    return { app, port, connect };
}
async function message(ws, predicate, start = 0) {
    const until = Date.now() + 2500;
    while (Date.now() < until) {
        const found = ws.messages.slice(start).find(predicate);
        if (found) { return found; }
        await pause(10);
    }
    throw new Error('Expected message not received: ' + JSON.stringify(ws.messages.slice(-2)));
}
test('two clients receive each other with independent identities', async t => {
    const { connect } = await fixture(t);const a = await connect('CoderGuy'), b = await connect('Friend');
    const wa = await message(a, d => d.type === 'welcome'), wb = await message(b, d => d.type === 'welcome');
    assert.notEqual(wa.id, wb.id);
    const snapshot = await message(a, d => d.type === 'snapshot' && d.players.length === 2);
    assert.deepEqual(snapshot.players.map(p => p.name), ['CoderGuy', 'Friend']);
    assert((await message(b, d => d.type === 'snapshot' && d.players.length === 2)).players.some(p => p.id === wa.id));
});
test('rooms isolate players and normalize room codes', async t => {
    const { connect } = await fixture(t);const a = await connect('A', 'same'), b = await connect('B', 'OTHER');
    assert.equal((await message(a, d => d.type === 'welcome')).room, 'SAME');
    assert.equal((await message(a, d => d.type === 'snapshot')).players.length, 1);
    assert.equal((await message(b, d => d.type === 'snapshot')).players.length, 1);
});
test('server owns movement and ignores client position injection', async t => {
    const { connect } = await fixture(t);const a = await connect('A');await message(a, d => d.type === 'welcome');
    const before = await message(a, d => d.type === 'snapshot');const start = a.messages.length;
    a.send(JSON.stringify({ type: 'input', keys: { right: true }, x: 999999, y: -999999 }));
    const after = await message(a, d => d.type === 'snapshot' && d.players[0].x > before.players[0].x, start);
    assert(after.players[0].x <= before.players[0].x + 12);assert.equal(after.players[0].y, before.players[0].y);
});
test('diagonal motion is normalized and stale inputs stop automatically', async t => {
    const { app, connect } = await fixture(t);const a = await connect('A');const welcome = await message(a, d => d.type === 'welcome');
    const player = app.rooms.get('TEST').get(welcome.id);const x = player.x, y = player.y;
    a.send(JSON.stringify({ type: 'input', keys: { right: true, down: true } }));
    await pause(70);assert(player.x > x && player.y > y);assert(Math.abs((player.x - x) - (player.y - y)) < 0.001);
    await pause(300);const stoppedX = player.x, stoppedY = player.y;await pause(120);
    assert.equal(player.x, stoppedX);assert.equal(player.y, stoppedY);
});
test('movement is clamped to the arena', async t => {
    const { app, connect } = await fixture(t);const a = await connect('A');const welcome = await message(a, d => d.type === 'welcome');
    const player = app.rooms.get('TEST').get(welcome.id);player.x = 785;player.y = 585;
    a.send(JSON.stringify({ type: 'input', keys: { right: true, down: true } }));await pause(70);
    assert.equal(player.x, 786);assert.equal(player.y, 586);
});
test('disconnects remove players and empty rooms', async t => {
    const { app, connect } = await fixture(t);const a = await connect('A');await message(a, d => d.type === 'welcome');
    const closed = once(a, 'close');a.close();await closed;await pause(20);assert.equal(app.rooms.size, 0);
});
test('ninth player is rejected without changing the eight-player room', async t => {
    const { app, connect } = await fixture(t);for (let i = 0; i < 8; i++) { const ws = await connect('P' + i);await message(ws, d => d.type === 'welcome'); }
    const extra = await connect('Extra');const error = await message(extra, d => d.type === 'error');assert.match(error.message, /full/i);
    assert.equal(app.rooms.get('TEST').size, 8);
});
test('malformed and oversized messages are closed without crashing the server', async t => {
    const { connect, port } = await fixture(t);const a = await connect(null);const closedA = once(a, 'close');a.send('{broken');assert.equal((await closedA)[0], 1007);
    const b = await connect(null);const closedB = once(b, 'close');b.send('x'.repeat(2048));assert.equal((await closedB)[0], 1009);
    assert.equal((await fetch('http://127.0.0.1:' + port + '/health')).status, 200);
});
test('HTTP health check and userscript download are available', async t => {
    const { port } = await fixture(t);const base = 'http://127.0.0.1:' + port;
    assert.equal((await (await fetch(base + '/health')).json()).ok, true);
    assert.match(await (await fetch(base + '/bridge.user.js')).text(), /Coder Guy Khan WebSocket Test Bridge/);
    assert.equal((await fetch(base + '/missing')).status, 404);
});
