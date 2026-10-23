const crypto = require('node:crypto');
const {WebSocketServer, WebSocket} = require('ws');

function attachBattlefrontRelay(server, options = {}) {
    const rooms = new Map();
    const clients = new Set();
    const sockets = new WebSocketServer({noServer: true, maxPayload: 262144, perMessageDeflate: false});
    const roomLifetime = options.roomLifetime || 300000;
    const hash = value => crypto.createHash('sha256').update(value).digest('hex');
    const token = value => typeof value === 'string' && /^[A-Za-z0-9_-]{32,128}$/.test(value);
    function send(client, data) {
        if (client.ws.readyState !== WebSocket.OPEN) return;
        if (client.ws.bufferedAmount > 524288) { client.ws.terminate(); return; }
        client.ws.send(JSON.stringify(data));
    }
    function roster(room) {
        const peers = [...room.members.values()].map(p => ({id: p.id, name: p.name, host: p.id === room.hostId}));
        const state = {type: 'room', hostId: room.hostId, epoch: room.epoch, hostOnline: room.members.has(room.hostId), peers};
        for (const member of room.members.values()) send(member, state);
    }
    server.on('upgrade', (request, socket, head) => {
        if (request.url !== '/battlefront') return;
        const origin = request.headers.origin;
        if ((origin && !/^https:\/\/(www\.)?(khanacademy\.org|kasandbox\.org)$/.test(origin)) || clients.size >= 128) {
            socket.end('HTTP/1.1 403 Forbidden\r\nConnection: close\r\n\r\n'); return;
        }
        sockets.handleUpgrade(request, socket, head, ws => sockets.emit('connection', ws));
    });
    sockets.on('connection', ws => {
        const client = {ws, id: crypto.randomUUID(), room: null, name: '', sequence: 0, receivedAt: Date.now(), packets: 0, rateAt: Date.now(), alive: true};
        clients.add(client);
        const joinTimer = setTimeout(() => { if (!client.room) ws.close(1008, 'Join first'); }, 15000);
        ws.on('error', () => {});
        ws.on('pong', () => { client.alive = true; });
        ws.on('close', () => {
            clearTimeout(joinTimer); clients.delete(client);
            const room = client.room;
            if (!room || room.members.get(client.id) !== client) return;
            room.members.delete(client.id); room.changedAt = Date.now();
            if (client.id === room.hostId && room.members.size) {
                const nextHost = room.members.values().next().value;
                const nextToken = crypto.randomBytes(32).toString('base64url');
                room.hostId = nextHost.id; room.hostToken = hash(nextToken); room.epoch++;
                for (const member of room.members.values()) member.sequence = 0;
                send(nextHost, {type: 'promote', hostToken: nextToken, hostId: nextHost.id, epoch: room.epoch});
            }
            roster(room);
        });
        function reject(message) { send(client, {type: 'error', message}); ws.close(1008, message); }
        ws.on('message', (bytes, binary) => {
            if (binary) { ws.close(1003, 'Text only'); return; }
            const now = Date.now();
            if (now - client.rateAt >= 1000) { client.rateAt = now; client.packets = 0; }
            if (++client.packets > 65) { reject('Slow down'); return; }
            let data;
            try { data = JSON.parse(bytes.toString()); } catch (_) { ws.close(1007, 'Bad JSON'); return; }
            if (!data || Array.isArray(data) || typeof data !== 'object') return;
            if (data.type === 'ping') { send(client, {type: 'pong', at: Number.isFinite(data.at) ? data.at : 0}); return; }
            if (data.type === 'join' && !client.room) {
                if (!/^[A-Z0-9]{6,16}$/.test(data.room || '') || !token(data.proof)) { reject('Invalid invite'); return; }
                const name = typeof data.name === 'string' ? data.name.replace(/[^a-zA-Z0-9 _-]/g, '').trim().slice(0, 16) : '';
                if (!name) { reject('Pick a name'); return; }
                let room = rooms.get(data.room);
                let assignedHostToken = '';
                if (!room) {
                    if (rooms.size >= 32) { reject('Server is full. Try again shortly.'); return; }
                    if (data.create && !token(data.hostToken)) { reject('Invalid host'); return; }
                    assignedHostToken = data.create ? data.hostToken : crypto.randomBytes(32).toString('base64url');
                    room = {id: data.room, proof: hash(data.proof), hostToken: hash(assignedHostToken), hostId: client.id, epoch: 1, members: new Map(), reservations: new Map(), changedAt: now};
                    rooms.set(room.id, room);
                } else {
                    if (room.proof !== hash(data.proof)) { reject('Invalid invite'); return; }
                    if (data.create) { reject('Room already exists'); return; }
                    if (data.hostToken) {
                        if (!token(data.hostToken) || hash(data.hostToken) !== room.hostToken) { reject('Invalid host'); return; }
                        const oldHost = room.members.get(room.hostId);
                        if (oldHost && oldHost.ws.readyState === WebSocket.OPEN) { reject('Host is already connected'); return; }
                        client.id = room.hostId; room.epoch++;
                    } else if (token(data.resumeToken) && room.reservations.has(hash(data.resumeToken))) {
                        const id = room.reservations.get(hash(data.resumeToken));
                        const previous = room.members.get(id);
                        if (previous && previous.ws.readyState === WebSocket.OPEN) { reject('Player already connected'); return; }
                        client.id = id;
                    }
                    if (room.members.size >= 8) { reject('Room is full'); return; }
                }
                if (!room.members.size && client.id !== room.hostId) {
                    assignedHostToken = crypto.randomBytes(32).toString('base64url');
                    room.hostId = client.id; room.hostToken = hash(assignedHostToken); room.epoch++;
                }
                const resumeToken = crypto.randomBytes(32).toString('base64url');
                for (const [key, id] of room.reservations) if (id === client.id) room.reservations.delete(key);
                room.reservations.set(hash(resumeToken), client.id);
                while (room.reservations.size > 32) room.reservations.delete(room.reservations.keys().next().value);
                client.name = name; client.room = room; room.members.set(client.id, client); room.changedAt = now;
                clearTimeout(joinTimer);
                send(client, {type: 'welcome', id: client.id, hostId: room.hostId, host: client.id === room.hostId, epoch: room.epoch, resumeToken});
                if (assignedHostToken) send(client, {type: 'promote', hostToken: assignedHostToken, hostId: client.id, epoch: room.epoch});
                roster(room); return;
            }
            const room = client.room;
            if (!room || data.type !== 'relay' || room.members.get(client.id) !== client) return;
            if (!Number.isSafeInteger(data.sequence) || data.sequence <= client.sequence || data.epoch !== room.epoch || typeof data.iv !== 'string' || !/^[A-Za-z0-9+/]{16}$/.test(data.iv) || typeof data.cipher !== 'string' || data.cipher.length > 240000 || !/^[A-Za-z0-9+/]+={0,2}$/.test(data.cipher)) return;
            const host = client.id === room.hostId;
            if ((host && data.kind !== 'world') || (!host && data.kind !== 'input')) { reject('Not allowed'); return; }
            client.sequence = data.sequence;
            const packet = {type: 'relay', kind: data.kind, sender: client.id, epoch: room.epoch, sequence: data.sequence, iv: data.iv, cipher: data.cipher};
            if (host) { for (const member of room.members.values()) if (member !== client) send(member, packet); }
            else { const destination = room.members.get(room.hostId); if (destination) send(destination, packet); }
        });
    });
    const heartbeat = setInterval(() => {
        for (const client of clients) {
            if (!client.alive) client.ws.terminate();
            else { client.alive = false; if (client.ws.readyState === WebSocket.OPEN) client.ws.ping(); }
        }
        for (const [id, room] of rooms) {
            if (!room.members.has(room.hostId) && Date.now() - room.changedAt > roomLifetime) {
                for (const member of room.members.values()) { send(member, {type: 'error', message: 'Host left. Room closed.'}); member.ws.close(1001); }
                rooms.delete(id);
            }
        }
    }, options.heartbeatMs || 15000);
    async function close() {
        clearInterval(heartbeat);
        for (const client of clients) client.ws.terminate();
        await new Promise(resolve => sockets.close(resolve));
    }
    return {rooms, clients, close};
}
module.exports = {attachBattlefrontRelay};
