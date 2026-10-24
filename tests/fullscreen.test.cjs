const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const { JSDOM } = require('jsdom');

test('fullscreen view uses the existing player and validates the popup before forwarding input', () => {
    const page = new JSDOM(fs.readFileSync('public/index.html','utf8'), { url:'https://www.kasandbox.org/test', runScripts:'outside-only' });
    const w = page.window, relayData = [], fullData = [], opened = [];
    const relay = { closed:false, postMessage:p=>relayData.push(p), close(){} };
    const child = { closed:false, postMessage:p=>fullData.push(p), focus(){} };
    w.HTMLCanvasElement.prototype.getContext = () => ({ clearRect(){} });
    w.requestAnimationFrame = () => {};
    w.open = url => { opened.push(url); return opened.length === 1 ? relay : child; };
    w.eval(w.document.querySelector('script').textContent);
    w.document.getElementById('join').dispatchEvent(new w.Event('submit',{cancelable:true}));
    const key = opened[0].split('#')[1];
    function event(source, origin, packet) {
        w.dispatchEvent(new w.MessageEvent('message',{source,origin,data:packet}));
    }
    event(relay,'https://khan-multiplayer-room.onrender.com',{channel:'ka-room-v1',key,data:{type:'welcome',id:'same-player',room:'LOBBY',chat:[],drawing:[]}});
    w.document.getElementById('full').click();
    assert.equal(opened.length,2);
    assert.match(opened[1],/game.html\?fullscreen=1#/);
    const fullKey = opened[1].split('#')[1];
    event(child,'https://other.example',{channel:'ka-full-v1',key:fullKey,type:'ready'});
    assert.equal(fullData.length,0);
    event(child,'https://khan-multiplayer-room.onrender.com',{channel:'ka-full-v1',key:fullKey,type:'ready'});
    assert.equal(fullData.find(p=>p.data.type==='welcome').data.id,'same-player');
    const before = relayData.length;
    event(child,'https://khan-multiplayer-room.onrender.com',{channel:'ka-full-v1',key:'wrong',type:'send',data:{type:'input',keys:{right:true}}});
    assert.equal(relayData.length,before);
    event(child,'https://khan-multiplayer-room.onrender.com',{channel:'ka-full-v1',key:fullKey,type:'send',data:{type:'input',keys:{right:true}}});
    assert.equal(relayData.at(-1).data.keys.right,true);
    event(child,'https://khan-multiplayer-room.onrender.com',{channel:'ka-full-v1',key:fullKey,type:'send',data:{type:'join',name:'Duplicate'}});
    assert.equal(relayData.at(-1).data.type,'input');
    event(child,'https://khan-multiplayer-room.onrender.com',{channel:'ka-full-v1',key:fullKey,type:'close'});
    assert.equal(relayData.at(-1).data.type,'input');
    assert.deepEqual(Object.keys(relayData.at(-1).data.keys),[]);
    page.window.close();
});
