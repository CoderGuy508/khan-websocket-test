const http = require("node:http");
const fs = require("node:fs");
const path = require("node:path");
const crypto = require("node:crypto");
const { WebSocketServer, WebSocket } = require("ws");
const { createAdmin } = require("./admin.cjs");
const { filter } = require("./filter.cjs");

function createTestServer(options = {}) {
    const rooms = new Map();
    const clients = new Set();
    const colors = [
        "#66caff",
        "#ffb45e",
        "#a6ee89",
        "#e89aff",
        "#ff7f8b",
        "#7ae8df",
        "#fff289",
        "#b6b9ff"
    ];
    const admin = createAdmin({ rooms, clients, send, options, notice });
    let tick = 0;
    const server = http.createServer((req, res) => {
        if ((req.url || "").startsWith("/admin/api/")) {
            admin.handle(req, res).catch(() => {
                if (!res.headersSent) res.writeHead(500, { "Content-Type": "application/json" });
                res.end(JSON.stringify({ error: "Request failed" }));
            });
            return;
        }
        if (req.url === "/health") {
            res.writeHead(200, { "Content-Type": "application/json", "Cache-Control": "no-store" });
            res.end(
                JSON.stringify({
                    ok: true,
                    rooms: rooms.size,
                    players: [...rooms.values()].reduce((n, r) => n + r.size, 0),
                    tick
                })
            );
            return;
        }
        const routes = {
            "/admin": ["admin.html", "text/html; charset=utf-8"],
            "/admin.js": ["admin.js", "text/javascript; charset=utf-8"],
            "/admin.css": ["admin.css", "text/css; charset=utf-8"],
            "/": ["index.html", "text/html; charset=utf-8"],
            "/connect": ["connect.html", "text/html; charset=utf-8"],
            "/game.html": ["index.html", "text/html; charset=utf-8"],
            "/bridge.user.js": ["bridge.user.js", "text/javascript; charset=utf-8"],
            "/battlefront.user.js": ["battlefront.user.js", "text/javascript; charset=utf-8"]
        };
        const route = routes[req.url && req.url.split("?")[0]];
        if (!route) {
            res.writeHead(404);
            res.end("Not found");
            return;
        }
        if (route[0].startsWith("admin")) {
            res.setHeader("Content-Security-Policy", "default-src 'self'; script-src 'self'; style-src 'self'; img-src 'self' data:; frame-ancestors 'none'; base-uri 'none'; form-action 'self'");
            res.setHeader("Referrer-Policy", "no-referrer");
        }
        res.writeHead(200, {
            "Content-Type": route[1],
            "Cache-Control": "no-store",
            "X-Content-Type-Options": "nosniff"
        });
        fs.createReadStream(path.join(options.publicDir || path.join(__dirname, "public"), route[0])).pipe(res);
    });
    const sockets = new WebSocketServer({
        noServer: true,
        maxPayload: 1024,
        perMessageDeflate: false
    });
    server.on("upgrade", (req, socket, head) => {
        if (req.url !== "/ws" || clients.size >= 128) {
            socket.end("HTTP/1.1 503 Service Unavailable\r\nConnection: close\r\n\r\n");
            return;
        }
        sockets.handleUpgrade(req, socket, head, (ws) => sockets.emit("connection", ws, req));
    });
    function syncDrawing(client, drawing) {
        const version = client.syncVersion = (client.syncVersion || 0) + 1;
        const history = drawing.slice();
        client.pending = [];
        client.syncing = true;
        send(client.ws, { type: "drawing_start" }, true);
        let at = 0;
        function step() {
            if (client.ws.readyState !== WebSocket.OPEN || version !== client.syncVersion) return;
            if (client.ws.bufferedAmount > 16384) return setTimeout(step, 20);
            if (at < history.length) {
                send(client.ws, { type: "drawing_chunk", drawing: history.slice(at, at + 8) }, true);
                at += 8;
            } else if (client.pending.length) {
                for (const data of client.pending.splice(0, 8)) send(client.ws, data, true);
            } else {
                client.syncing = false;
                send(client.ws, { type: "drawing_end" }, true);
                return;
            }
            setTimeout(step, 10);
        }
        step();
    }
    function send(ws, data, force = false) {
        const client = ws.roomClient;
        if (!force && client && data.type === "drawing") {
            syncDrawing(client, data.drawing);
            return;
        }
        if (!force && client?.syncing && ["draw", "undo", "wipe", "cursor"].includes(data.type)) {
            client.pending.push(data);
            return;
        }
        if (ws.readyState !== WebSocket.OPEN) {
            return;
        }
        if (ws.bufferedAmount > 65536) {
            ws.terminate();
            return;
        }
        ws.send(JSON.stringify(data));
    }
    function notice(room, text, kind = "info") {
        const msg = { type: "notice", time: Date.now(), mid: crypto.randomUUID(), name: "Server", text, kind };
        for (const peer of room.values()) send(peer.ws, msg);
    }
    function leave(client) {
        if (!client.room) {
            return;
        }
        const room = rooms.get(client.room);
        if (room) {
            room.delete(client.id);
            if (!client.moderated) notice(room, client.name + " left.", "leave");
            if (!room.size && !room.ink.length && !room.kept) {
                rooms.delete(client.room);
            }
        }
        client.room = "";
    }
    sockets.on("connection", (ws, req) => {
        const ip = admin.address(req);
        if (admin.blocked(ip)) {
            send(ws, { type: "error", message: "Your IP is banned from this server." });
            ws.close(4003, "Banned");
            return;
        }
        const client = {
            ws,
            id: crypto.randomUUID(),
            ip,
            room: "",
            input: {},
            lastInput: 0,
            x: 400,
            y: 300,
            name: "",
            color: "",
            lastPong: Date.now(),
            chatAt: 0,
            wipeAt: 0,
            rateStart: Date.now(),
            count: 0
        };
        ws.roomClient = client;
        clients.add(client);
        const joinTimer = setTimeout(() => {
            if (!client.room) {
                ws.close(1008, "Join required");
            }
        }, 10000);
        ws.on("error", () => {});
        ws.on("pong", () => {
            client.lastPong = Date.now();
        });
        ws.on("close", () => {
            clearTimeout(joinTimer);
            leave(client);
            clients.delete(client);
        });
        ws.on("message", (bytes, binary) => {
            if (binary) {
                ws.close(1003, "Text messages only");
                return;
            }
            const now = Date.now();
            if (now - client.rateStart >= 1000) {
                client.rateStart = now;
                client.count = 0;
            }
            if (++client.count > 60) {
                ws.close(1008, "Too many messages");
                return;
            }
            let data;
            try {
                data = JSON.parse(bytes.toString());
            } catch (_) {
                ws.close(1007, "Invalid JSON");
                return;
            }
            if (!data || typeof data !== "object" || Array.isArray(data)) {
                return;
            }
            if (data.type === "join" && !client.room) {
                const roomName =
                    typeof data.room === "string" ? data.room.trim().toUpperCase() : "";
                const name =
                    typeof data.name === "string"
                        ? filter(data.name
                              .replace(/[^a-zA-Z0-9 _-]/g, "")
                              .trim()
                              .slice(0, 16))
                        : "";
                if (!/^[A-Z0-9_-]{1,24}$/.test(roomName) || !name) {
                    send(ws, {
                        type: "error",
                        message: "Use a name and a room with letters or numbers."
                    });
                    return;
                }
                let room = rooms.get(roomName);
                if ((!room && rooms.size >= 32) || (room && room.size >= 8)) {
                    send(ws, { type: "error", message: "Room or server full." });
                    ws.close(1008, "Full");
                    return;
                }
                if (!room) {
                    room = new Map();
                    room.chat = [];
                    room.ink = [];
                    room.paintAt = 0;
                    room.hidden = new Set();
                    room.order = 0;
                    rooms.set(roomName, room);
                }
                client.room = roomName;
                client.name = name;
                admin.remember(client);
                client.color = colors[room.size % colors.length];
                client.x = 150 + (room.size % 4) * 150;
                client.y = 180 + Math.floor(room.size / 4) * 200;
                room.set(client.id, client);
                clearTimeout(joinTimer);
                send(ws, {
                    type: "welcome",
                    id: client.id,
                    room: roomName,
                    width: 800,
                    height: 600,
                    chat: room.chat,
                    drawing: []
                });
                syncDrawing(client, room.ink);
                notice(room, name + " joined.", "join");
            } else if (data.type === "input" && client.room) {
                const input = data.keys;
                if (!input || typeof input !== "object") {
                    return;
                }
                client.input = {
                    up: input.up === true,
                    down: input.down === true,
                    left: input.left === true,
                    right: input.right === true
                };
                client.lastInput = now;
            } else if (data.type === "chat" && client.room) {
                if (now - client.chatAt < 500 || typeof data.text !== "string") return;
                if (client.muted) {
                    send(client.ws, { type: "notice", name: "Server", time: Date.now(), text: "You are muted by admin.", kind: "moderation" });
                    return;
                }
                const text = filter(data.text)
                    .replace(/[\u0000-\u001f\u007f]/g, " ")
                    .trim()
                    .slice(0, 180);
                if (!text) return;
                client.chatAt = now;
                const room = rooms.get(client.room);
                if (!room) return;
                const msg = { time: Date.now(), type: "chat", id: client.id, mid: crypto.randomUUID(), name: client.name, text };
                room.chat.push(msg);
                if (room.chat.length > 30) room.chat.shift();
                for (const peer of room.values()) send(peer.ws, msg);
            } else if (data.type === "draw" && client.room) {
                const room = rooms.get(client.room);
                if (!room || typeof data.id !== "string" || !/^[a-f0-9]{16}$/.test(data.id)) return;
                if (!Array.isArray(data.points) || !data.points.length || data.points.length > 16) return;
                if (!data.points.every(p => Array.isArray(p) && p.length === 2 && p.every(Number.isFinite))) return;
                if (room.hidden.has(data.id)) return;
                const old = room.ink.find(op => op.id === data.id);
                if (old && old.owner !== client.id) return;
                if (!old && (!/^#[a-f0-9]{6}$/i.test(data.color || "") || !Number.isFinite(data.size) || data.size < 1 || data.size > 32)) return;
                const op = {
                    type: "draw", order: ++room.order, id: data.id, owner: client.id, name: client.name,
                    color: old ? old.color : data.color,
                    size: old ? old.size : Math.round(data.size),
                    erase: old ? old.erase : data.erase === true,
                    points: data.points.map(p => [Math.round(Math.max(0, Math.min(800, p[0]))), Math.round(Math.max(0, Math.min(600, p[1])))])
                };
                room.ink.push(op);
                for (const peer of room.values()) send(peer.ws, op);
            } else if (data.type === "cursor" && client.room && data.active === false) {
                const room = rooms.get(client.room);
                if (room) for (const peer of room.values()) send(peer.ws, { type: "cursor", id: client.id, active: false });
            } else if (data.type === "undo" && client.room) {
                const room = rooms.get(client.room);
                const last = room && [...room.ink].reverse().find(op => op.owner === client.id);
                if (!last) return;
                room.ink = room.ink.filter(op => op.id !== last.id);
                for (const peer of room.values()) send(peer.ws, { type: "undo", id: last.id });
            } else if (data.type === "wipe" && client.room) {
                const room = rooms.get(client.room);
                if (!room || now - client.wipeAt < 500) return;
                client.wipeAt = now;
                const own = new Set(room.ink.filter(op => op.owner === client.id).map(op => op.id));
                room.ink = room.ink.filter(op => op.owner !== client.id);
                for (const id of own) {
                    for (const peer of room.values()) send(peer.ws, { type: "undo", id });
                }
            } else if (data.type === "ping") {
                send(ws, { type: "pong", at: Number.isFinite(data.at) ? data.at : 0 });
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
                if (length) {
                    dx /= length;
                    dy /= length;
                }
                player.x = Math.max(14, Math.min(786, player.x + dx * 12));
                player.y = Math.max(14, Math.min(586, player.y + dy * 12));
            }
            const players = [...room.values()].map((p) => ({
                id: p.id,
                name: p.name,
                color: p.color,
                x: Math.round(p.x * 100) / 100,
                y: Math.round(p.y * 100) / 100
            }));
            const snapshot = { type: "snapshot", tick, players };
            for (const player of room.values()) {
                send(player.ws, snapshot);
            }
        }
    }, 50);
    const heartbeat = setInterval(() => {
        for (const client of clients) {
            if (Date.now() - client.lastPong > 45000) {
                client.ws.terminate();
            } else if (client.ws.readyState === WebSocket.OPEN) {
                client.ws.ping();
            }
        }
    }, 15000);
    async function close() {
        clearInterval(interval);
        clearInterval(heartbeat);
        for (const client of clients) {
            client.ws.terminate();
        }
        await new Promise((resolve) => sockets.close(resolve));
        await new Promise((resolve) => server.close(resolve));
    }
    return { server, rooms, close };
}
if (require.main === module) {
    const app = createTestServer();
    app.server.listen(Number(process.env.PORT) || 10000, "0.0.0.0", () => {
        console.log("WebSocket test listening");
    });
    process.once("SIGTERM", () => {
        app.close().then(() => process.exit(0));
    });
    process.once("SIGINT", () => {
        app.close().then(() => process.exit(0));
    });
}
module.exports = { createTestServer };
