// ==UserScript==
// @name         Battlefront V3 Multiplayer
// @namespace    https://github.com/CoderGuyxLemoncelloJr/Battlefront
// @version      0.1.0
// @description  The no-UI WebSocket bridge for the Battlefront multiplayer test.
// @author       Coder Guy
// @license      MIT
// @match        https://www.khanacademy.org/computer-programming/*/5684189710893056*
// @match        https://khanacademy.org/computer-programming/*/5684189710893056*
// @match        https://www.kasandbox.org/computer-programming/exec/pjs*
// @match        https://kasandbox.org/computer-programming/exec/pjs*
// @grant        unsafeWindow
// @grant        GM_getValue
// @grant        GM_setValue
// @grant        GM_setClipboard
// @run-at       document-idle
// ==/UserScript==

/*
hey, here's the setup:
1. everyone installs Tampermonkey, then this script.
2. open https://www.khanacademy.org/computer-programming/pjs/5684189710893056?editor=no. pick a name and hit Host.
3. hit Copy invite in the game and send that link to your friends.
4. they open it, pick a name, and hit Join. the host picks the map and starts.

that's it. WASD moves, click uses your held item, 1-5 swaps slots.
the script adds zero buttons or panels to the page. the game handles that.
one player runs the match; Render just passes encrypted messages around.
if the host leaves, someone still in the room takes over. keep the invite private.
*/

(function() {
    'use strict';
    const projectId = '5684189710893056';
    const channel = 'battlefront-v3-wss-1';
    const endpoint = 'wss://coderguy-khan-websocket-test.onrender.com/battlefront';
    const page = typeof unsafeWindow === 'undefined' ? window : unsafeWindow;
    const isKhan = origin => /^https:\/\/(www\.)?khanacademy\.org$/.test(origin);
    const isSandbox = origin => /^https:\/\/(www\.)?kasandbox\.org$/.test(origin);
    const pageValue = value => page.JSON.parse(JSON.stringify(value));
    if (isSandbox(location.origin) && window.parent !== window) {
        let game;
        let lastReady = 0;
        const findGame = () => {
            try {
                const instances = page.Processing && page.Processing.instances;
                if (instances) for (const instance of instances) {
                    const candidate = instance.battlefrontNet;
                    if (candidate && candidate.protocol === channel && candidate.projectId === projectId) return candidate;
                }
            } catch (_) {}
            return null;
        };
        window.addEventListener('message', event => {
            if (event.source !== window.parent || !isKhan(event.origin)) return;
            const packet = event.data;
            if (!packet || packet.channel !== channel || packet.projectId !== projectId) return;
            game = findGame();
            if (!game) return;
            if (packet.kind === 'state') game.state = pageValue(packet.state);
            if (packet.kind === 'packet') {
                if (game.inbox.length > 24) game.inbox.splice(0, game.inbox.length - 16);
                game.inbox.push(pageValue(packet.packet));
            }
        });
        document.addEventListener('paste', event => {
            game = findGame();
            if (game && game.lobby && event.clipboardData) game.pasted = String(event.clipboardData.getData('text')).slice(0, 600);
        });
        const clearKeys = () => {
            if (game) game.focused = false;
            const instances = page.Processing && page.Processing.instances;
            if (instances) for (const instance of instances) {
                if (instance.battlefrontNet === game && instance.clearGameInput) instance.clearGameInput();
            }
        };
        window.addEventListener('blur', clearKeys);
        document.addEventListener('visibilitychange', () => { if (document.hidden) clearKeys(); });
        window.addEventListener('focus', () => { if (game) game.focused = true; });
        setInterval(() => {
            game = findGame();
            if (!game) return;
            game.focused = document.hasFocus() && !document.hidden;
            if (Date.now() - lastReady > 1000) {
                window.parent.postMessage({channel, projectId, kind: 'ready'}, '*');
                lastReady = Date.now();
            }
            if (game.request) {
                window.parent.postMessage({channel, projectId, kind: 'request', request: JSON.parse(JSON.stringify(game.request))}, '*');
                game.request = null;
            }
            const outgoing = game.outbox.splice(0, game.outbox.length);
            for (const packet of outgoing.slice(-3)) window.parent.postMessage({channel, projectId, kind: 'send', packet: JSON.parse(JSON.stringify(packet))}, '*');
        }, 25);
        return;
    }
    if (window.top !== window || !isKhan(location.origin) || !new RegExp('/computer-programming/[^/]+/' + projectId + '/?$').test(location.pathname)) return;
    const bytesToBase64 = bytes => {
        let text = '';
        for (let offset = 0; offset < bytes.length; offset += 8192) text += String.fromCharCode(...bytes.subarray(offset, offset + 8192));
        return btoa(text);
    };
    const base64ToBytes = value => Uint8Array.from(atob(value), ch => ch.charCodeAt(0));
    const urlToken = bytes => bytesToBase64(bytes).replace(/\+/g, '-').replace(/\//g, '_').replace(/=+$/, '');
    const randomToken = () => urlToken(crypto.getRandomValues(new Uint8Array(32)));
    const digest = async value => new Uint8Array(await crypto.subtle.digest('SHA-256', new TextEncoder().encode(value)));
    let frame;
    let frameOrigin;
    let auth;
    let key;
    let socket;
    let retry;
    let attempt = 0;
    let sequence = 0;
    let active = false;
    let encrypting = false;
    let pendingWorld;
    let pendingInput;
    let reading = Promise.resolve();
    const received = new Map();
    const state = {connected: false, host: false, id: '', hostId: '', epoch: 0, peers: [], ping: 0, invite: '', message: 'Ready'};
    const sendFrame = (kind, extra) => {
        if (frame && frame.contentWindow) frame.contentWindow.postMessage({channel, projectId, kind, ...extra}, frameOrigin);
    };
    const publish = () => sendFrame('state', {state});
    const save = () => {
        if (auth) GM_setValue('battlefront-room-' + auth.room, auth);
    };
    const inviteUrl = () => 'https://www.khanacademy.org/computer-programming/pjs/' + projectId + '?editor=no#bf=' + auth.room + '.' + auth.secret;
    async function configure(request) {
        if (request.type === 'copy') {
            if (auth) { GM_setClipboard(inviteUrl(), 'text'); state.message = 'Invite copied'; publish(); }
            return;
        }
        if (request.type === 'leave') { stop(); return; }
        if (request.type !== 'create' && request.type !== 'join') return;
        stop();
        const name = String(request.name || 'Player').replace(/[^a-zA-Z0-9 _-]/g, '').trim().slice(0, 16) || 'Player';
        if (request.type === 'create') {
            auth = {room: randomToken().replace(/[^A-Z0-9]/gi, '').slice(0, 10).toUpperCase(), secret: randomToken(), hostToken: randomToken(), resumeToken: '', create: true, wasHost: true, name};
        } else {
            const match = String(request.invite || location.hash).match(/(?:#bf=|^)([A-Z0-9]{6,16})\.([A-Za-z0-9_-]{43})$/);
            if (!match) { state.message = 'Paste the full invite link'; publish(); return; }
            const saved = GM_getValue('battlefront-room-' + match[1], null);
            auth = saved && saved.secret === match[2] ? {...saved, create: false, name} : {room: match[1], secret: match[2], hostToken: '', resumeToken: '', create: false, wasHost: false, name};
        }
        key = await crypto.subtle.importKey('raw', await digest('battlefront-key:' + auth.secret), 'AES-GCM', false, ['encrypt', 'decrypt']);
        auth.proof = urlToken(await digest('battlefront-room:' + auth.secret));
        state.invite = inviteUrl(); history.replaceState(null, '', state.invite); save(); active = true; attempt = 0; connect();
    }
    function stop() {
        active = false; clearTimeout(retry); retry = null;
        const previous = socket; socket = null; if (previous) previous.close();
        pendingWorld = null; pendingInput = null; received.clear();
        state.connected = false; state.host = false; state.peers = []; state.message = 'Disconnected'; publish();
    }
    const aad = (sender, epoch, number, kind) => new TextEncoder().encode([channel, auth.room, sender, epoch, number, kind].join('|'));
    async function flush() {
        if (encrypting || !socket || socket.readyState !== WebSocket.OPEN || !state.connected) return;
        encrypting = true;
        try {
            while (socket && socket.readyState === WebSocket.OPEN && state.connected && (pendingWorld || pendingInput)) {
                const packet = state.host ? pendingWorld : pendingInput;
                pendingWorld = null; pendingInput = null;
                if (!packet || socket.bufferedAmount > 262144) continue;
                const ws = socket, epoch = state.epoch, number = ++sequence;
                const iv = crypto.getRandomValues(new Uint8Array(12));
                const text = JSON.stringify(packet.data);
                if (text.length > 165000) continue;
                const encrypted = await crypto.subtle.encrypt({name: 'AES-GCM', iv, additionalData: aad(state.id, epoch, number, packet.kind)}, key, new TextEncoder().encode(text));
                if (ws !== socket || epoch !== state.epoch || ws.readyState !== WebSocket.OPEN) continue;
                ws.send(JSON.stringify({type: 'relay', kind: packet.kind, epoch, sequence: number, iv: bytesToBase64(iv), cipher: bytesToBase64(new Uint8Array(encrypted))}));
            }
        } catch (_) { state.message = 'Connection interrupted'; publish(); }
        finally { encrypting = false; }
    }
    function connect() {
        if (!active) return;
        state.message = attempt ? 'Reconnecting…' : 'Connecting…'; publish();
        const ws = new WebSocket(endpoint); socket = ws;
        ws.onopen = () => {
            if (ws !== socket) return;
            ws.send(JSON.stringify({type: 'join', room: auth.room, proof: auth.proof, hostToken: auth.hostToken, resumeToken: auth.resumeToken, create: auth.create, name: auth.name}));
        };
        ws.onmessage = event => {
            if (ws !== socket || typeof event.data !== 'string' || event.data.length > 262144) return;
            let packet; try { packet = JSON.parse(event.data); } catch (_) { return; }
            if (packet.type === 'welcome') {
                Object.assign(state, {connected: true, id: packet.id, hostId: packet.hostId, host: packet.host, epoch: packet.epoch, message: packet.host ? 'You are hosting' : 'Connected'});
                auth.resumeToken = packet.resumeToken; auth.create = false; auth.wasHost = packet.host;
                sequence = 0; received.clear(); attempt = 0; save(); publish();
            } else if (packet.type === 'promote') {
                auth.hostToken = packet.hostToken; auth.wasHost = true; save();
                Object.assign(state, {host: true, hostId: packet.hostId, epoch: packet.epoch, message: 'You are hosting'});
                sequence = 0; received.clear(); pendingInput = null; publish();
            } else if (packet.type === 'room') {
                if (packet.epoch !== state.epoch) { sequence = 0; received.clear(); }
                state.epoch = packet.epoch; state.hostId = packet.hostId; state.host = state.id === packet.hostId;
                state.peers = packet.peers; state.message = packet.hostOnline ? state.host ? 'You are hosting' : 'Connected' : 'Waiting for host'; publish();
            } else if (packet.type === 'relay') {
                reading = reading.then(async () => {
                    if (ws !== socket || packet.epoch !== state.epoch || typeof packet.sender !== 'string' || !Number.isSafeInteger(packet.sequence) || packet.sequence <= (received.get(packet.sender) || 0)) return;
                    if ((state.host && packet.kind !== 'input') || (!state.host && (packet.kind !== 'world' || packet.sender !== state.hostId))) return;
                    try {
                        const plain = await crypto.subtle.decrypt({name: 'AES-GCM', iv: base64ToBytes(packet.iv), additionalData: aad(packet.sender, packet.epoch, packet.sequence, packet.kind)}, key, base64ToBytes(packet.cipher));
                        if (ws !== socket || packet.epoch !== state.epoch) return;
                        const data = JSON.parse(new TextDecoder().decode(plain));
                        received.set(packet.sender, packet.sequence);
                        sendFrame('packet', {packet: {sender: packet.sender, kind: packet.kind, data}});
                    } catch (_) {}
                }).catch(() => {});
            } else if (packet.type === 'pong') { state.ping = Math.max(0, Math.min(60000, Date.now() - packet.at)); publish(); }
            else if (packet.type === 'error') {
                state.message = String(packet.message || 'Connection refused'); publish();
                if (packet.message === 'Invalid host') { auth.hostToken = ''; auth.wasHost = false; save(); }
                else if (packet.message === 'Room unavailable' && auth.wasHost) { auth.create = true; save(); }
                else if (packet.message === 'Room already exists') { auth.create = false; save(); }
                else { active = false; }
            }
        };
        ws.onerror = () => { if (ws === socket) { state.message = 'Waking the server…'; publish(); } };
        ws.onclose = () => {
            if (ws !== socket) return;
            socket = null; state.connected = false; publish();
            if (active) retry = setTimeout(connect, Math.min(10000, 700 * Math.pow(1.6, attempt++)));
        };
    }
    window.addEventListener('message', event => {
        const output = document.getElementById('output-frame');
        if (!output || event.source !== output.contentWindow || !isSandbox(event.origin)) return;
        const packet = event.data;
        if (!packet || packet.channel !== channel || packet.projectId !== projectId) return;
        frame = output; frameOrigin = event.origin;
        if (packet.kind === 'ready') {
            if (!auth && location.hash.includes('#bf=')) state.invite = location.href;
            publish();
        } else if (packet.kind === 'request') configure(packet.request || {}).catch(() => { state.message = 'Could not open the room'; publish(); });
        else if (packet.kind === 'send' && packet.packet && state.connected) {
            if (state.host && packet.packet.kind === 'world') pendingWorld = packet.packet;
            if (!state.host && packet.packet.kind === 'input') pendingInput = packet.packet;
            flush();
        }
    });
    setInterval(() => { if (socket && socket.readyState === WebSocket.OPEN) socket.send(JSON.stringify({type: 'ping', at: Date.now()})); }, 5000);
    window.addEventListener('pagehide', stop);
}());
