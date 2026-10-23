const http = require('node:http');
const fs = require('node:fs');
const path = require('node:path');
const crypto = require('node:crypto');
const { WebSocketServer, WebSocket } = require('ws');
const { attachBattlefrontRelay } = require('./battlefront-relay.cjs');

function createTestServer(options = {}) {
    const rooms = new Map();
    const clients = new Set();
    const colors = ['#66caff', '#ffb45e', '#a6ee89', '#e89aff', '#ff7f8b', '#7ae8df', '#fff289', '#b6b9ff'];
    let tick = 0;
    const server = http.createServer((req, res) => {
        if (req.url === '/health') {
            res.writeHead(200, { 'Content-Type': 'application/json', 'Cache-Control': 'no-store' });
            res.end(JSON.stringify({ ok: true, rooms: rooms.size, players: [...rooms.values()].reduce((n, r) => n + r.size, 0), tick }));
            return;
        }
        const routes = { '/': ['index.html', 'text/html; charset=utf-8'], '/bridge.user.js': ['bridge.user.js', 'text/javascript; charset=utf-8'], '/battlefront.user.js': ['battlefront.user.js', 'text/javascript; charset=utf-8'] };
        const route = routes[req.url && req.url.split('?')[0]];
        if (!route) { res.writeHead(404);res.end('Not found');return; }
        res.writeHead(200, { 'Content-Type': route[1], 'Cache-Control': 'no-store', 'X-Content-Type-Options': 'nosniff' });
        fs.createReadStream(path.join(__dirname, 'public', route[0])).pipe(res);
    });
    const sockets = new WebSocketServer({ noServer: true, maxPayload: 1024, perMessageDeflate: false });
    const battlefront = attachBattlefrontRelay(server);
    server.on('upgrade', (req, socket, head) => {
        if (req.url === '/battlefront') { return; }
        if (req.url !== '/ws' || clients.size >= 128) { socket.end('HTTP/1.1 503 Service Unavailable\r\nConnection: close\r\n\r\n');return; }
        sockets.handleUpgrade(req, socket, head, ws => sockets.emit('connection', ws));
    });
    function send(ws, data) {
        if (ws.readyState !== WebSocket.OPEN) { return; }
        if (ws.bufferedAmount > 65536) { ws.terminate();return; }
        ws.send(JSON.stringify(data));
    }
    function leave(client) {
        if (!client.room) { return; }
        const room = rooms.get(client.room);
        if (room) { room.delete(client.id);if (!room.size) { rooms.delete(client.room); } }
        client.room = '';
    }
    sockets.on('connection', ws => {
        const client = { ws, id: crypto.randomUUID(), room: '', input: {}, lastInput: 0, x: 400, y: 300, name: '', color: '', lastPong: Date.now(), rateStart: Date.now(), count: 0 };
        clients.add(client);
        const joinTimer = setTimeout(() => { if (!client.room) { ws.close(1008, 'Join required'); } }, 10000);
        ws.on('error', () => {});
        ws.on('pong', () => { client.lastPong = Date.now(); });
        ws.on('close', () => { clearTimeout(joinTimer);leave(client);clients.delete(client); });
        ws.on('message', (bytes, binary) => {
            if (binary) { ws.close(1003, 'Text messages only');return; }
            const now = Date.now();
            if (now - client.rateStart >= 1000) { client.rateStart = now;client.count = 0; }
            if (++client.count > 60) { ws.close(1008, 'Too many messages');return; }
            let data;
            try { data = JSON.parse(bytes.toString()); } catch (_) { ws.close(1007, 'Invalid JSON');return; }
            if (!data || typeof data !== 'object' || Array.isArray(data)) { return; }
            if (data.type === 'join' && !client.room) {
                const roomName = typeof data.room === 'string' ? data.room.trim().toUpperCase() : '';
                const name = typeof data.name === 'string' ? data.name.replace(/[^a-zA-Z0-9 _-]/g, '').trim().slice(0, 16) : '';
                if (!/^[A-Z0-9_-]{1,24}$/.test(roomName) || !name) { send(ws, { type: 'error', message: 'Use a name and a room with letters or numbers.' });return; }
                let room = rooms.get(roomName);
                if ((!room && rooms.size >= 32) || (room && room.size >= 8)) { send(ws, { type: 'error', message: 'Room or server full.' });ws.close(1008, 'Full');return; }
                if (!room) { room = new Map();rooms.set(roomName, room); }
                client.room = roomName;client.name = name;client.color = colors[room.size % colors.length];
                client.x = 150 + (room.size % 4) * 150;client.y = 180 + Math.floor(room.size / 4) * 200;
                room.set(client.id, client);clearTimeout(joinTimer);
                send(ws, { type: 'welcome', id: client.id, room: roomName, width: 800, height: 600 });
            } else if (data.type === 'input' && client.room) {
                const input = data.keys;
                if (!input || typeof input !== 'object') { return; }
                client.input = { up: input.up === true, down: input.down === true, left: input.left === true, right: input.right === true };
                client.lastInput = now;
            } else if (data.type === 'ping') {
                send(ws, { type: 'pong', at: Number.isFinite(data.at) ? data.at : 0 });
            }
        });
    });
    const interval = setInterval(() => {
        tick++;
        const now = Date.now();
        for (const room of rooms.values()) {
            for (const player of room.values()) {
                const input = now - player.lastInput < 250 ? player.input : {};
                let dx = Number(!!input.right) - Number(!!input.left);
                let dy = Number(!!input.down) - Number(!!input.up);
                const length = Math.hypot(dx, dy);
                if (length) { dx /= length;dy /= length; }
                player.x = Math.max(14, Math.min(786, player.x + dx * 12));
                player.y = Math.max(14, Math.min(586, player.y + dy * 12));
            }
            const players = [...room.values()].map(p => ({ id: p.id, name: p.name, color: p.color, x: Math.round(p.x * 100) / 100, y: Math.round(p.y * 100) / 100 }));
            const snapshot = { type: 'snapshot', tick, players };
            for (const player of room.values()) { send(player.ws, snapshot); }
        }
    }, 50);
    const heartbeat = setInterval(() => {
        for (const client of clients) {
            if (Date.now() - client.lastPong > 45000) { client.ws.terminate(); }
            else if (client.ws.readyState === WebSocket.OPEN) { client.ws.ping(); }
        }
    }, 15000);
    async function close() {
        clearInterval(interval);clearInterval(heartbeat);
        await battlefront.close();
        for (const client of clients) { client.ws.terminate(); }
        await new Promise(resolve => sockets.close(resolve));
        await new Promise(resolve => server.close(resolve));
    }
    return { server, rooms, close };
}
if (require.main === module) {
    const app = createTestServer();
    app.server.listen(Number(process.env.PORT) || 10000, '0.0.0.0', () => { console.log('WebSocket test listening'); });
    process.once('SIGTERM', () => { app.close().then(() => process.exit(0)); });
    process.once('SIGINT', () => { app.close().then(() => process.exit(0)); });
}
module.exports = { createTestServer };
