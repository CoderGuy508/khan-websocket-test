const test = require('node:test');
const assert = require('node:assert/strict');
const http = require('node:http');
const crypto = require('node:crypto');
const fs = require('node:fs');
const {JSDOM} = require('jsdom');
const {WebSocket} = require('ws');
const {attachBattlefrontRelay} = require('../battlefront-relay.cjs');
const pause = ms => new Promise(resolve => setTimeout(resolve, ms));
async function until(fn, message = 'Timed out') {
    const started = Date.now();
    while (!fn()) { if (Date.now() - started > 4000) throw Error(message); await pause(10); }
}
async function setup(t) {
    const server = http.createServer((req, res) => { res.end('ok'); });
    const relay = attachBattlefrontRelay(server);
    await new Promise(resolve => server.listen(0, '127.0.0.1', resolve));
    const address = 'ws://127.0.0.1:' + server.address().port + '/battlefront';
    t.after(async () => { await relay.close(); await new Promise(resolve => server.close(resolve)); });
    return {relay, address};
}
async function connect(address) {
    const ws = new WebSocket(address);
    const messages = [];
    ws.on('message', bytes => messages.push(JSON.parse(bytes.toString())));
    ws.on('error', () => {});
    await new Promise(resolve => ws.once('open', resolve));
    return {ws, messages, send: packet => ws.send(JSON.stringify(packet))};
}
const room = 'TESTROOM01';
const proof = crypto.randomBytes(32).toString('base64url');
const hostToken = crypto.randomBytes(32).toString('base64url');
test('room authority, encrypted routing, host election and reconnect identities', async t => {
    const {address, relay} = await setup(t);
    const host = await connect(address);
    host.send({type: 'join', room, proof, hostToken, create: true, name: 'Host'});
    await until(() => host.messages.some(m => m.type === 'welcome'));
    const hostWelcome = host.messages.find(m => m.type === 'welcome');
    const guest = await connect(address);
    guest.send({type: 'join', room, proof, name: 'Guest'});
    await until(() => guest.messages.some(m => m.type === 'welcome'));
    const guestWelcome = guest.messages.find(m => m.type === 'welcome');
    assert(hostWelcome.host); assert.equal(guestWelcome.host, false);
    const encrypted = {type: 'relay', kind: 'world', epoch: 1, sequence: 1, iv: Buffer.alloc(12).toString('base64'), cipher: Buffer.from('opaque encrypted bytes').toString('base64')};
    host.send(encrypted);
    await until(() => guest.messages.some(m => m.type === 'relay'));
    assert.equal(guest.messages.find(m => m.type === 'relay').sender, hostWelcome.id);
    guest.send({...encrypted, kind: 'input'});
    await until(() => host.messages.some(m => m.type === 'relay'));
    assert.equal(host.messages.find(m => m.type === 'relay').sender, guestWelcome.id);
    const before = guest.messages.filter(m => m.type === 'relay').length;
    host.send(encrypted); await pause(30);
    assert.equal(guest.messages.filter(m => m.type === 'relay').length, before);
    host.ws.close();
    await until(() => guest.messages.some(m => m.type === 'promote'));
    const promotion = guest.messages.find(m => m.type === 'promote');
    assert.equal(promotion.hostId, guestWelcome.id); assert.equal(promotion.epoch, 2);
    assert(promotion.hostToken); assert.equal(relay.rooms.get(room).hostId, guestWelcome.id);
    const returning = await connect(address);
    returning.send({type: 'join', room, proof, resumeToken: hostWelcome.resumeToken, name: 'Host back'});
    await until(() => returning.messages.some(m => m.type === 'welcome'));
    const returned = returning.messages.find(m => m.type === 'welcome');
    assert.equal(returned.id, hostWelcome.id); assert.equal(returned.host, false);
    guest.send({...encrypted, epoch: 2});
    await until(() => returning.messages.some(m => m.type === 'relay'));
    assert.equal(returning.messages.find(m => m.type === 'relay').sender, guestWelcome.id);
});
test('wrong invites, forged host tokens, guest snapshots and duplicate identities are rejected', async t => {
    const {address} = await setup(t);
    const host = await connect(address);
    host.send({type: 'join', room, proof, hostToken, create: true, name: 'Host'});
    await until(() => host.messages.some(m => m.type === 'welcome'));
    for (const extra of [{proof: 'X'.repeat(43)}, {hostToken: 'X'.repeat(43)}]) {
        const intruder = await connect(address);
        intruder.send({type: 'join', room, proof, name: 'Nope', ...extra});
        await until(() => intruder.messages.some(m => m.type === 'error'));
    }
    const guest = await connect(address);
    guest.send({type: 'join', room, proof, name: 'Guest'});
    await until(() => guest.messages.some(m => m.type === 'welcome'));
    const welcome = guest.messages.find(m => m.type === 'welcome');
    const duplicate = await connect(address);
    duplicate.send({type: 'join', room, proof, resumeToken: welcome.resumeToken, name: 'Duplicate'});
    await until(() => duplicate.messages.some(m => m.type === 'error'));
    guest.send({type: 'relay', kind: 'world', epoch: 1, sequence: 1, iv: Buffer.alloc(12).toString('base64'), cipher: 'YWJjZA=='});
    await until(() => guest.messages.some(m => m.type === 'error'));
    assert.equal(guest.messages.at(-1).message, 'Not allowed');
});
function bridge(address) {
    const project = '5684189710893056';
    const dom = new JSDOM('<iframe id="output-frame"></iframe>', {url: 'https://www.khanacademy.org/computer-programming/pjs/' + project, runScripts: 'outside-only'});
    const page = dom.window;
    const saved = new Map(), frames = [];
    Object.defineProperty(page, 'crypto', {value: crypto.webcrypto});
    page.TextEncoder = TextEncoder; page.TextDecoder = TextDecoder; page.WebSocket = WebSocket;
    page.GM_getValue = (key, fallback) => saved.has(key) ? saved.get(key) : fallback;
    page.GM_setValue = (key, value) => saved.set(key, structuredClone(value));
    page.GM_setClipboard = text => { page.copied = text; };
    const frame = page.document.getElementById('output-frame');
    frame.contentWindow.postMessage = packet => frames.push(structuredClone(packet));
    let source = fs.readFileSync(require('node:path').join(__dirname, '../public/battlefront.user.js'), 'utf8');
    source = source.replace('wss://coderguy-khan-websocket-test.onrender.com/battlefront', address);
    page.eval(source);
    const dispatch = packet => page.dispatchEvent(new page.MessageEvent('message', {source: frame.contentWindow, origin: 'https://www.kasandbox.org', data: {channel: 'battlefront-v3-wss-1', projectId: project, ...packet}}));
    dispatch({kind: 'ready'});
    return {page, frames, saved, dispatch, state: () => frames.filter(p => p.kind === 'state').at(-1)?.state, close: () => { page.dispatchEvent(new page.Event('pagehide')); page.close(); }};
}
test('real bridges encrypt both directions, add no UI, copy invites and transfer host ownership', async t => {
    const {address, relay} = await setup(t);
    const host = bridge(address), guest = bridge(address);
    t.after(() => { host.close(); guest.close(); });
    host.dispatch({kind: 'request', request: {type: 'create', name: 'Host'}});
    await until(() => host.state()?.connected, 'Host did not connect');
    const invite = host.state().invite;
    assert.match(invite, /5684189710893056\?editor=no#bf=/);
    guest.dispatch({kind: 'request', request: {type: 'join', name: 'Guest', invite}});
    await until(() => guest.state()?.connected, 'Guest did not connect');
    assert.equal(host.page.document.body.children.length, 1);
    assert.equal(guest.page.document.body.children.length, 1);
    const world = {round: 2, actors: [{id: 'sample', x: 314, health: 88}], objects: []};
    host.dispatch({kind: 'send', packet: {kind: 'world', data: world}});
    await until(() => guest.frames.some(p => p.kind === 'packet'));
    assert.deepEqual(guest.frames.find(p => p.kind === 'packet').packet.data, world);
    guest.dispatch({kind: 'send', packet: {kind: 'input', data: {right: true, click: 7}}});
    await until(() => host.frames.some(p => p.kind === 'packet'));
    assert.equal(host.frames.find(p => p.kind === 'packet').packet.data.click, 7);
    host.dispatch({kind: 'request', request: {type: 'copy'}});
    assert.equal(host.page.copied, invite);
    const roomState = [...relay.rooms.values()][0];
    const hostId = host.state().id;
    roomState.members.get(hostId).ws.close();
    await until(() => guest.state()?.host === true, 'Guest was not promoted');
    assert.equal(guest.state().epoch, 2);
    assert.equal([...guest.saved.values()].at(-1).wasHost, true);
    guest.dispatch({kind: 'send', packet: {kind: 'world', data: {round: 2, migrated: true}}});
    assert(!guest.state().invite.includes([...guest.saved.values()].at(-1).hostToken));
});

test('old invites reopen rooms after a relay restart and elect a host after everyone leaves', async t => {
    const {address, relay} = await setup(t);
    const host = bridge(address), guest = bridge(address), returning = bridge(address);
    t.after(() => { host.close(); guest.close(); returning.close(); });
    host.dispatch({kind: 'request', request: {type: 'create', name: 'Host'}});
    await until(() => host.state()?.connected);
    const invite = host.state().invite;
    host.close();
    await until(() => [...relay.rooms.values()][0].members.size === 0);
    guest.dispatch({kind: 'request', request: {type: 'join', name: 'Guest', invite}});
    await until(() => guest.state()?.connected && guest.state()?.host);
    assert([...guest.saved.values()].at(-1).hostToken);
    guest.close();
    await until(() => [...relay.rooms.values()][0].members.size === 0);
    relay.rooms.clear();
    returning.dispatch({kind: 'request', request: {type: 'join', name: 'Returning', invite}});
    await until(() => returning.state()?.connected && returning.state()?.host);
    assert([...returning.saved.values()].at(-1).hostToken);
    assert.equal(returning.state().invite, invite);
});

test('public server list, shared joins, host status and automatic ownership work without invites', async t => {
    const {address} = await setup(t);
    const host=bridge(address), guest=bridge(address), browser=bridge(address);
    t.after(()=>{host.close();guest.close();browser.close();});
    browser.dispatch({kind:'request',request:{type:'list'}});
    await until(()=>browser.state()?.servers?.length===3);
    assert.equal(browser.state().servers[0].players,0);
    host.dispatch({kind:'request',request:{type:'server',server:'BFPUBLIC01',name:'Host'}});
    await until(()=>host.state()?.connected && host.state()?.host);
    guest.dispatch({kind:'request',request:{type:'server',server:'BFPUBLIC01',name:'Guest'}});
    await until(()=>guest.state()?.connected && host.state()?.peers?.length===2);
    assert(!guest.state().host);assert.equal(host.page.location.hash,'');assert.equal(guest.page.location.hash,'');
    const world={stage:'Play',map:'Jakku',mode:'Battle Royale',phase:'live',round:3};
    host.dispatch({kind:'send',packet:{kind:'world',data:world}});
    await until(()=>guest.frames.some(p=>p.kind==='packet'));
    assert.deepEqual(guest.frames.find(p=>p.kind==='packet').packet.data,world);
    browser.dispatch({kind:'request',request:{type:'list'}});
    await until(()=>browser.state()?.servers?.[0]?.players===2);
    assert.equal(browser.state().servers[0].map,'Jakku');assert.equal(browser.state().servers[0].mode,'Battle Royale');
    host.close();await until(()=>guest.state()?.host);
});
