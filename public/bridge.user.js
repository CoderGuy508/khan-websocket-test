// ==UserScript==
// @name         Coder Guy Khan WebSocket Test Bridge
// @namespace    coderguy.websocket-test
// @version      0.1.0
// @description  Connect the Coder Guy Khan Academy multiplayer test to a Render WebSocket server.
// @match        https://www.khanacademy.org/computer-programming/*
// @match        https://khanacademy.org/computer-programming/*
// @match        https://www.kasandbox.org/computer-programming/exec/pjs*
// @match        https://kasandbox.org/computer-programming/exec/pjs*
// @grant        unsafeWindow
// @grant        GM_getValue
// @grant        GM_setValue
// @run-at       document-idle
// ==/UserScript==

(function() {
    'use strict';
    const channel = 'coderguy-ws-test-v1';
    const page = typeof unsafeWindow === 'undefined' ? window : unsafeWindow;
    const pageObject = value => page.JSON.parse(JSON.stringify(value));
    const isKhan = origin => /^https:\/\/(www\.)?khanacademy\.org$/.test(origin);
    if (/(^|\.)kasandbox\.org$/.test(location.hostname)) {
        let probe = null;
        let lastReady = 0;
        let parentOrigin = '';
        try { const ref = new URL(document.referrer);if (isKhan(ref.origin)) { parentOrigin = ref.origin; } } catch (_) {}
        if (!parentOrigin) { return; }
        function clearInput() {
            if (probe) { probe.input = pageObject({ up: false, down: false, left: false, right: false }); }
        }
        window.addEventListener('blur', clearInput);
        document.addEventListener('visibilitychange', () => { if (document.hidden) { clearInput(); } });
        window.addEventListener('message', event => {
            if (event.source !== window.parent || event.origin !== parentOrigin || !probe) { return; }
            const data = event.data;
            if (!data || data.channel !== channel || data.kind !== 'state') { return; }
            const state = data.state;
            if (!state || typeof state !== 'object') { return; }
            probe.status = String(state.status || '').slice(0, 120);
            probe.connected = state.connected === true;
            probe.selfId = String(state.selfId || '').slice(0, 64);
            probe.room = String(state.room || '').slice(0, 24);
            probe.ping = Number.isFinite(state.ping) ? state.ping : 0;
            probe.serverTick = Number.isFinite(state.serverTick) ? state.serverTick : 0;
            if (Array.isArray(state.players)) {
                probe.players = pageObject(state.players.slice(0, 8).filter(p => p && typeof p.id === 'string' && Number.isFinite(p.x) && Number.isFinite(p.y)).map(p => ({ id: p.id.slice(0, 64), name: String(p.name || '').slice(0, 16), color: String(p.color || ''), x: Math.max(0, Math.min(800, p.x)), y: Math.max(0, Math.min(600, p.y)) })));
            }
        });
        setInterval(() => {
            let current = null;
            const instances = page.Processing && page.Processing.instances;
            if (instances) {
                for (let i = 0; i < instances.length; i++) {
                    if (instances[i].multiplayerProbe && instances[i].multiplayerProbe.protocol === channel) { current = instances[i].multiplayerProbe;break; }
                }
            }
            if (!current) { probe = null;return; }
            if (probe !== current) { probe = current;lastReady = 0;clearInput(); }
            if (document.hidden || !document.hasFocus()) { clearInput(); }
            if (Date.now() - lastReady >= 1000) {
                window.parent.postMessage({ channel, kind: 'ready' }, parentOrigin);
                lastReady = Date.now();
            }
            const input = probe.input || {};
            window.parent.postMessage({ channel, kind: 'input', keys: { up: input.up === true, down: input.down === true, left: input.left === true, right: input.right === true } }, parentOrigin);
        }, 50);
        return;
    }
    if (!isKhan(location.origin) || window.top !== window.self) { return; }
    let frame = null;
    let frameOrigin = '';
    let ws = null;
    let reconnect = null;
    let attempt = 0;
    let wanted = false;
    let latestKeys = { up: false, down: false, left: false, right: false };
    let settings = null;
    const state = { status: 'Bridge ready', connected: false, selfId: '', room: '', ping: 0, serverTick: 0, players: [] };
    const panel = document.createElement('form');
    panel.id = 'coderguy-websocket-bridge';
    panel.style.cssText = 'position:fixed;bottom:16px;left:50%;transform:translateX(-50%);z-index:100000;display:flex;flex-wrap:wrap;gap:6px;align-items:center;max-width:95vw;padding:9px;border:1px solid #7bcfff66;border-radius:8px;background:#101e2de8;color:#dceeff;font:12px Arial,sans-serif';
    function field(label, placeholder, value, width) {
        const input = document.createElement('input');
        input.setAttribute('aria-label', label);input.placeholder = placeholder;input.value = value;
        input.style.cssText = 'box-sizing:border-box;width:' + width + 'px;max-width:80vw;padding:7px;border:1px solid #7198ad77;border-radius:4px;background:#09131ed0;color:#dceeff;font:12px Arial,sans-serif';
        panel.appendChild(input);return input;
    }
    const endpoint = field('WebSocket server', 'wss://your-service.onrender.com/ws', GM_getValue('server', 'wss://coderguy-khan-websocket-test.onrender.com/ws'), 270);
    const room = field('Room', 'LOBBY', GM_getValue('room', 'LOBBY'), 90);
    const name = field('Player name', 'Name', GM_getValue('name', 'Player'), 100);
    room.maxLength = 24;name.maxLength = 16;
    const button = document.createElement('button');button.type = 'submit';button.textContent = 'Connect';
    button.style.cssText = 'padding:8px;border:0;border-radius:4px;background:#317cb1;color:white;cursor:pointer';panel.appendChild(button);
    const status = document.createElement('span');status.setAttribute('role', 'status');status.setAttribute('aria-live', 'polite');panel.appendChild(status);
    function publish() {
        status.textContent = state.connected ? state.room + ' · ' + state.players.length + '/8 · ' + state.ping + ' ms' : state.status;
        if (frame && frame.contentWindow) { frame.contentWindow.postMessage({ channel, kind: 'state', state }, frameOrigin); }
    }
    function stop() {
        wanted = false;clearTimeout(reconnect);reconnect = null;
        const previous = ws;ws = null;if (previous) { previous.close(); }
        state.connected = false;state.players = [];state.selfId = '';state.status = 'Disconnected';button.textContent = 'Connect';publish();
    }
    function connect() {
        if (!wanted || !settings) { return; }
        state.status = attempt ? 'Reconnecting / waking server…' : 'Connecting…';publish();
        let socket;
        try { socket = new WebSocket(settings.endpoint); } catch (_) { state.status = 'Connection blocked by browser';publish();wanted = false;button.textContent = 'Connect';return; }
        ws = socket;
        socket.onopen = () => {
            if (ws !== socket || !wanted) { socket.close();return; }
            socket.send(JSON.stringify({ type: 'join', name: settings.name, room: settings.room }));
            state.status = 'Joining room…';publish();
        };
        socket.onmessage = event => {
            if (ws !== socket) { return; }
            let data;try { data = JSON.parse(event.data); } catch (_) { return; }
            if (data.type === 'welcome') {
                state.selfId = data.id;state.room = data.room;state.connected = true;state.status = 'Connected';attempt = 0;publish();
            } else if (data.type === 'snapshot' && state.connected && Array.isArray(data.players)) {
                state.players = data.players;state.serverTick = data.tick;publish();
            } else if (data.type === 'pong') {
                state.ping = Math.max(0, Math.min(60000, Date.now() - data.at));publish();
            } else if (data.type === 'error') {
                const message = String(data.message || 'Server rejected connection');stop();state.status = message;publish();
            }
        };
        socket.onerror = () => { if (ws === socket) { state.status = 'Server unavailable / waking…';publish(); } };
        socket.onclose = () => {
            if (ws !== socket) { return; }
            ws = null;state.connected = false;state.players = [];publish();
            if (wanted) { attempt++;reconnect = setTimeout(connect, Math.min(15000, 1000 * Math.pow(1.7, attempt - 1))); }
        };
    }
    panel.addEventListener('submit', event => {
        event.preventDefault();
        if (wanted) { stop();return; }
        let address;
        try { address = new URL(endpoint.value.trim()); } catch (_) { state.status = 'Enter the Render WebSocket URL';publish();return; }
        const local = ['localhost', '127.0.0.1', '[::1]'].includes(address.hostname);
        if (address.username || address.password || address.search || address.hash || (address.protocol !== 'wss:' && !(local && address.protocol === 'ws:'))) {
            state.status = 'Use a secure wss:// server URL';publish();return;
        }
        const roomName = room.value.trim().toUpperCase();
        const playerName = name.value.trim().replace(/[^a-zA-Z0-9 _-]/g, '').slice(0, 16);
        if (!/^[A-Z0-9_-]{1,24}$/.test(roomName) || !playerName) { state.status = 'Enter a name and room';publish();return; }
        address.pathname = '/ws';settings = { endpoint: address.href, room: roomName, name: playerName };
        GM_setValue('server', settings.endpoint);GM_setValue('room', roomName);GM_setValue('name', playerName);
        wanted = true;attempt = 0;button.textContent = 'Disconnect';connect();
    });
    window.addEventListener('message', event => {
        const output = document.getElementById('output-frame');
        if (!output || event.source !== output.contentWindow || !/^https:\/\/(www\.)?kasandbox\.org$/.test(event.origin)) { return; }
        const data = event.data;
        if (!data || data.channel !== channel) { return; }
        frame = output;frameOrigin = event.origin;
        if (data.kind === 'ready') { if (!panel.isConnected) { document.body.appendChild(panel); }publish(); }
        else if (data.kind === 'input' && data.keys && typeof data.keys === 'object') {
            latestKeys = { up: data.keys.up === true, down: data.keys.down === true, left: data.keys.left === true, right: data.keys.right === true };
            if (ws && ws.readyState === WebSocket.OPEN && state.connected) { ws.send(JSON.stringify({ type: 'input', keys: latestKeys })); }
        }
    });
    setInterval(() => {
        if (ws && ws.readyState === WebSocket.OPEN && state.connected) { ws.send(JSON.stringify({ type: 'ping', at: Date.now() })); }
    }, 5000);
    window.addEventListener('pagehide', stop);
}());
