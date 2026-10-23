const { test } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const vm = require('node:vm');
const { once } = require('node:events');
const { JSDOM } = require('jsdom');
const { WebSocket } = require('ws');
const { createTestServer } = require('../server.cjs');
const source = fs.readFileSync(__dirname + '/../public/bridge.user.js', 'utf8');
const pause = ms => new Promise(resolve => setTimeout(resolve, ms));
async function until(fn) { const end=Date.now()+2500;while(Date.now()<end){if(fn()){return;}await pause(15);}throw new Error('Timed out'); }
function page() {
    const dom = new JSDOM('<body><iframe id="output-frame" src="https://www.kasandbox.org/computer-programming/exec/pjs"></iframe></body>', { url: 'https://www.khanacademy.org/computer-programming/test/123', runScripts: 'outside-only' });
    const w=dom.window;w.unsafeWindow=w;w.GM_getValue=(_,fallback)=>fallback;w.GM_setValue=()=>{};w.WebSocket=WebSocket;
    const output=w.document.getElementById('output-frame');const states=[];output.contentWindow.postMessage=(data,origin)=>states.push({data,origin});
    w.eval(source);
    const emit=data=>w.dispatchEvent(new w.MessageEvent('message',{source:output.contentWindow,origin:'https://www.kasandbox.org',data:{channel:'coderguy-ws-test-v1',...data}}));
    return {dom,w,emit,states};
}
test('bridge ignores unrelated frames and appears only for the test handshake',()=>{
    const {dom,w,emit}=page();try {
        assert.equal(w.document.querySelector('form'),null);
        w.dispatchEvent(new w.MessageEvent('message',{origin:'https://evil.example',data:{channel:'coderguy-ws-test-v1',kind:'ready'}}));
        assert.equal(w.document.querySelector('form'),null);emit({kind:'ready'});assert(w.document.querySelector('form'));
    } finally {dom.window.close();}
});
test('userscript connects to a real server, relays inputs and forwards snapshots',async t=>{
    const app=createTestServer();app.server.listen(0,'127.0.0.1');await once(app.server,'listening');
    const {dom,w,emit,states}=page();t.after(async()=>{dom.window.close();await app.close();});
    emit({kind:'ready'});
    w.document.querySelector('[aria-label="WebSocket server"]').value='ws://127.0.0.1:'+app.server.address().port+'/ws';
    w.document.querySelector('[aria-label="Player name"]').value='CoderGuy';
    w.document.querySelector('form').dispatchEvent(new w.Event('submit',{cancelable:true}));
    await until(()=>states.some(s=>s.data.state.connected));
    await until(()=>states.some(s=>s.data.state.players.length===1));
    const before=app.rooms.get('LOBBY').values().next().value.x;
    emit({kind:'input',keys:{right:true}});
    await until(()=>app.rooms.get('LOBBY').values().next().value.x>before);
    assert(states.every(s=>s.origin==='https://www.kasandbox.org'));
    w.document.querySelector('form').dispatchEvent(new w.Event('submit',{cancelable:true}));
    assert.equal(w.document.querySelector('button').textContent,'Connect');
});
test('userscript rejects insecure remote endpoints and invalid room names',()=>{
    const {dom,w,emit}=page();try {
        emit({kind:'ready'});w.document.querySelector('[aria-label="WebSocket server"]').value='ws://remote.example/ws';
        w.document.querySelector('form').dispatchEvent(new w.Event('submit',{cancelable:true}));
        assert.match(w.document.querySelector('[role="status"]').textContent,/secure/);
    }finally{dom.window.close();}
});
test('frame bridge finds Processing state, forwards keys and applies safe snapshots',async()=>{
    const dom=new JSDOM('<body></body>',{url:'https://www.kasandbox.org/computer-programming/exec/pjs',referrer:'https://www.khanacademy.org/',runScripts:'outside-only',pretendToBeVisual:true});
    const parent=new JSDOM('<body></body>',{url:'https://www.khanacademy.org/'});
    const w=dom.window,probe={protocol:'coderguy-ws-test-v1',input:{right:true},players:[]},sent=[];
    Object.defineProperty(w,'parent',{value:parent.window});parent.window.postMessage=(data,origin)=>sent.push({data,origin});
    w.unsafeWindow=w;w.Processing={instances:[{multiplayerProbe:probe}]};w.document.hasFocus=()=>true;
    try{
        w.eval(source);await until(()=>sent.some(m=>m.data.kind==='input'));
        probe.input.right=true;await until(()=>sent.some(m=>m.data.keys&&m.data.keys.right));
        w.dispatchEvent(new w.MessageEvent('message',{source:parent.window,origin:'https://www.khanacademy.org',data:{channel:'coderguy-ws-test-v1',kind:'state',state:{connected:true,selfId:'self',room:'TEST',players:[{id:'self',name:'CoderGuy',x:150,y:180}]}}}));
        assert.equal(probe.connected,true);assert.equal(probe.players[0].name,'CoderGuy');
        w.dispatchEvent(new w.Event('blur'));assert.equal(probe.input.right,false);
    }finally{dom.window.close();parent.window.close();}
});
test('Khan project stays ES5-compatible and renders connected and disconnected states',()=>{
    const code=fs.readFileSync(__dirname+'/../khan-project.js','utf8');require('acorn').parse(code,{ecmaVersion:5});
    const c={width:800,height:600,keyCode:0,LEFT:0,TOP:0,CENTER:1,millis:()=>100,constrain:(v,a,b)=>Math.max(a,Math.min(b,v)),min:Math.min,exp:Math.exp,lerp:(a,b,t)=>a+(b-a)*t};
    for(const fn of ['background','pushMatrix','translate','scale','stroke','strokeWeight','line','noFill','rect','noStroke','fill','ellipse','textAlign','textSize','text','popMatrix'])c[fn]=()=>{};
    c.color=(...a)=>a;vm.createContext(c);vm.runInContext(code,c);c.draw();c.multiplayerProbe.connected=true;c.multiplayerProbe.players=[{id:'self',name:'CoderGuy',x:120,y:140}];c.draw();
    c.keyCode=68;c.keyPressed();assert.equal(c.multiplayerProbe.input.right,true);c.keyReleased();assert.equal(c.multiplayerProbe.input.right,false);
});
