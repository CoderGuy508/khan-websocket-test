const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const {once} = require('node:events');
const {JSDOM} = require('jsdom');
const {WebSocket} = require('ws');
const {createTestServer} = require('../server.cjs');
const pause = ms => new Promise(resolve => setTimeout(resolve, ms));
async function until(fn) {
    const end = Date.now() + 4000;
    while (!fn()) { if (Date.now() > end) throw Error('Timed out'); await pause(10); }
}
async function setup(t) {
    const app = createTestServer(); app.server.listen(0, '127.0.0.1'); await once(app.server, 'listening');
    t.after(() => app.close()); return {app, origin: 'http://127.0.0.1:' + app.server.address().port};
}
function helper(origin, name, room) {
    const page = new JSDOM(fs.readFileSync('public/connect.html', 'utf8'), {url: origin + '/connect#' + 'a'.repeat(32), runScripts: 'outside-only'});
    const w = page.window, received = [], peer = {closed: false, postMessage: msg => received.push(msg.data)};
    w.opener = peer; w.WebSocket = WebSocket; w.eval(w.document.querySelector('script').textContent);
    function send(data, extra = {}) { w.dispatchEvent(new w.MessageEvent('message', {source: peer, origin: 'https://www.kasandbox.org', data: {channel:'ka-room-v1',key:'a'.repeat(32),data}, ...extra})); }
    send({type:'join',name,room});
    return {w, received, send, close() { w.dispatchEvent(new w.Event('pagehide')); w.close(); }};
}
test('two companion tabs relay movement and chat, isolate rooms, and clean up when closed', async t => {
    const {origin, app} = await setup(t);
    const a=helper(origin,'One','ROOM'), b=helper(origin,'Two','ROOM'), c=helper(origin,'Other','OTHER');
    t.after(()=>{a.close();b.close();c.close();});
    await until(()=>a.received.some(p=>p.type==='snapshot' && p.players.length===2));
    const id=a.received.find(p=>p.type==='welcome').id;
    const x=app.rooms.get('ROOM').get(id).x;
    a.send({type:'input',keys:{right:true}});
    await until(()=>b.received.some(p=>p.type==='snapshot' && p.players.some(row=>row.id===id && row.x>x)));
    a.send({type:'chat',text:'hello <b>world</b>'});
    await until(()=>b.received.some(p=>p.type==='chat'));
    assert.equal(b.received.find(p=>p.type==='chat').text,'hello <b>world</b>');
    assert(!c.received.some(p=>p.type==='chat'));
    a.send({type:'chat',text:'spam'});await pause(60);
    assert.equal(b.received.filter(p=>p.type==='chat').length,1);
    a.close(); await until(()=>app.rooms.get('ROOM').size===1);
});
test('companion rejects the wrong page, key, and sender before forwarding', async t => {
    const {origin} = await setup(t), a=helper(origin,'One','ROOM');t.after(()=>a.close());
    await until(()=>a.received.some(p=>p.type==='welcome'));
    a.send({type:'chat',text:'bad origin'},{origin:'https://example.com'});
    a.send({type:'chat',text:'bad sender'},{source:{}});
    a.send({type:'chat',text:'bad key'},{data:{channel:'ka-room-v1',key:'wrong',data:{type:'chat',text:'bad key'}}});
    await pause(80);assert.equal(a.received.filter(p=>p.type==='chat').length,0);
});
test('game validates its helper and displays chat as plain text', () => {
    const page=new JSDOM(fs.readFileSync('public/index.html','utf8'),{url:'https://www.kasandbox.org/test',runScripts:'outside-only'});
    const w=page.window, sent=[], peer={closed:false,postMessage:p=>sent.push(p),close(){this.closed=true;}};
    w.HTMLCanvasElement.prototype.getContext=()=>({});w.requestAnimationFrame=()=>{};
    let url;w.open=value=>{url=value;return peer;};w.eval(w.document.querySelector('script').textContent);
    w.document.getElementById('join').dispatchEvent(new w.Event('submit',{cancelable:true}));
    const key=url.split('#')[1];
    function packet(data, origin='https://khan-multiplayer-room.onrender.com') {
        w.dispatchEvent(new w.MessageEvent('message',{source:peer,origin,data:{channel:'ka-room-v1',key,data}}));
    }
    packet({type:'welcome',id:'fake',room:'ROOM'},'https://example.com');
    assert(w.document.getElementById('send').disabled);
    packet({type:'ready'});assert(sent.some(p=>p.data.type==='join'));
    packet({type:'welcome',id:'real',room:'ROOM',chat:[]});
    packet({type:'chat',name:'<img>',text:'<script>alert(1)</script>'});
    assert.equal(w.document.querySelector('#chat img'),null);assert.equal(w.document.querySelector('#chat script'),null);
    assert(w.document.getElementById('chat').textContent.includes('<script>alert(1)</script>'));
    page.window.close();
});
test('public game and companion are served while the canceled endpoint stays disabled', async t => {
    const {origin}=await setup(t);
    assert.match(await (await fetch(origin+'/connect')).text(),/Game connection/);
    assert.match(await (await fetch(origin+'/')).text(),/Multiplayer Room/);
    const ws=new WebSocket(origin.replace('http:','ws:')+'/battlefront');ws.on('error',()=>{});
    await new Promise(resolve=>ws.once('close',resolve));
});
