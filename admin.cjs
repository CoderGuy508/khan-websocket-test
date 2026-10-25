const crypto = require("node:crypto");
const fs = require("node:fs");
const { isIP } = require("node:net");

function createAdmin({ rooms, clients, send, options, notice })
{
    const key = options.adminKey ?? process.env.ADMIN_KEY ?? "";
    const file = options.banFile ?? process.env.BAN_FILE ?? "admin-bans.json";
    const secure = options.secure ?? process.env.RENDER === "true";
    const historyFile = options.historyFile ?? file + ".history.json";
    let history = [];
    try { history = JSON.parse(fs.readFileSync(historyFile, "utf8")); } catch {}
    if (!Array.isArray(history)) history = [];
    const sessions = new Map();
    const attempts = new Map();
    const authors = new Map();
    const trash = [];
    let bans = fs.existsSync(file) ? JSON.parse(fs.readFileSync(file, "utf8")) : [];

    function normalize(ip)
    {
        if (typeof ip !== "string") return "";
        ip = ip.replace(/^::ffff:/i, "");
        if (!isIP(ip)) return "";
        return isIP(ip) === 6 ? new URL("http://[" + ip + "]").hostname.slice(1, -1) : ip;
    }

    function address(req)
    {
        const forwarded = req.headers["x-forwarded-for"];
        const ip = typeof forwarded === "string" ? forwarded.split(",")[0].trim() : "";
        return normalize(process.env.RENDER === "true" && isIP(ip) ? ip : req.socket.remoteAddress || "");
    }

    function saveHistory()
    {
        if (key.length < 20) return;
        try {
            fs.writeFileSync(historyFile + ".tmp", JSON.stringify(history), { mode: 0o600 });
            fs.renameSync(historyFile + ".tmp", historyFile);
        } catch (error) { console.error("Could not save player history:", error.message); }
    }

    function remember(client)
    {
        const now = Date.now();
        client.joined = now;
        authors.set(client.id, { name: client.name, ip: client.ip });
        if (authors.size > 2048) authors.delete(authors.keys().next().value);
        let entry = history.find(h => h.ip === client.ip);
        if (!entry) {
            entry = { ip: client.ip, first: now, last: now, visits: 0, names: [], sessions: [] };
            history.push(entry);
        }
        entry.last = now;
        entry.visits++;
        let name = entry.names.find(n => n.name === client.name);
        if (!name) { name = { name: client.name, first: now, last: now, visits: 0 }; entry.names.push(name); }
        name.last = now;
        name.visits++;
        entry.names = entry.names.slice(-32);
        entry.sessions.push({ id: client.id, name: client.name, room: client.room, start: now, end: null, agent: client.agent });
        entry.sessions = entry.sessions.slice(-50);
        history = history.sort((a, b) => a.last - b.last).slice(-512);
        saveHistory();
    }

    function forget(client)
    {
        const entry = history.find(h => h.ip === client.ip);
        const session = entry?.sessions.find(s => s.id === client.id);
        if (!session) return;
        session.end = Date.now();
        entry.last = session.end;
        saveHistory();
    }

    function json(res, code, value)
    {
        res.writeHead(code, { "Content-Type": "application/json", "Cache-Control": "no-store", "X-Content-Type-Options": "nosniff" });
        res.end(JSON.stringify(value));
    }

    async function body(req)
    {
        let text = "";
        for await (const part of req) {
            text += part;
            if (text.length > 2048) throw Error("Too large");
        }
        return JSON.parse(text || "{}");
    }

    function equal(a, b)
    {
        const hash = value => crypto.createHash("sha256").update(value).digest();
        return crypto.timingSafeEqual(hash(a), hash(b));
    }

    function broadcast(room, data)
    {
        for (const client of room.values()) send(client.ws, data);
    }

    function save(next)
    {
        fs.writeFileSync(file + ".tmp", JSON.stringify(next), { mode: 0o600 });
        fs.renameSync(file + ".tmp", file);
        bans = next;
    }

    function removed(room, kind, data)
    {
        const id = crypto.randomUUID();
        const kept = rooms.get(room);
        if (kept) kept.kept = true;
        trash.push({ id, room, kind, data });
        if (trash.length > 50) trash.shift();
        return id;
    }

    function stop(client, message)
    {
        client.moderated = true;
        const room = rooms.get(client.room);
        if (room) notice(room, client.name + (message.startsWith("IP banned") ? " was banned." : " was kicked."), "moderation");
        send(client.ws, { type: "error", message });
        client.ws.close(4002, message);
    }

    async function handle(req, res)
    {
        const url = new URL(req.url, "http://localhost");
        if (key.length < 20) return json(res, 503, { error: "Set ADMIN_KEY on this server to enable admin access." });
        if (req.method !== "GET") {
            let origin;
            try { origin = new URL(req.headers.origin); } catch { return json(res, 403, { error: "Origin required" }); }
            if (origin.host !== req.headers.host || (secure && origin.protocol !== "https:")) return json(res, 403, { error: "Wrong origin" });
        }
        if (url.pathname === "/admin/api/login" && req.method === "POST") {
            const ip = address(req), now = Date.now();
            for (const [id, item] of sessions) if (item.until < now) sessions.delete(id);
            for (const [id, item] of attempts) if (item.until < now) attempts.delete(id);
            const count = attempts.get(ip) || { count: 0, until: now + 600000 };
            if (count.count >= 5 || attempts.size >= 256) return json(res, 429, { error: "Too many login attempts. Try again in ten minutes." });
            const data = await body(req);
            if (typeof data.key !== "string" || !equal(data.key, key)) {
                count.count++;
                attempts.set(ip, count);
                return json(res, 401, { error: "Incorrect admin key" });
            }
            attempts.delete(ip);
            if (sessions.size >= 16) sessions.delete(sessions.keys().next().value);
            const token = crypto.randomBytes(32).toString("hex");
            sessions.set(token, { until: now + 8 * 3600000 });
            res.setHeader("Set-Cookie", "room_admin=" + token + "; Path=/admin; HttpOnly; SameSite=Strict; Max-Age=28800" + (secure ? "; Secure" : ""));
            return json(res, 200, { ok: true });
        }
        const token = /(?:^|; )room_admin=([a-f0-9]{64})(?:;|$)/.exec(req.headers.cookie || "")?.[1];
        if (!token || !sessions.has(token) || sessions.get(token).until < Date.now()) return json(res, 401, { error: "Sign in to continue" });
        if (url.pathname === "/admin/api/logout" && req.method === "POST") {
            sessions.delete(token);
            res.setHeader("Set-Cookie", "room_admin=; Path=/admin; HttpOnly; SameSite=Strict; Max-Age=0" + (secure ? "; Secure" : ""));
            return json(res, 200, { ok: true });
        }
        if (url.pathname === "/admin/api/state" && req.method === "GET") {
            const selected = url.searchParams.get("room") || rooms.keys().next().value;
            const room = rooms.get(selected);
            return json(res, 200, {
                rooms: [...rooms].map(([name, r]) => ({ name, players: r.size, drawings: new Set(r.ink.map(op => op.id)).size })),
                players: [...clients].filter(c => c.room).map(c => ({ id: c.id, name: c.name, ip: c.ip, room: c.room, muted: !!c.muted, joined: c.joined, agent: c.agent })),
                room: room ? { name: selected, drawing: room.ink, chat: room.chat } : null,
                history: history.slice().reverse().map(h => ({ ...h,
                    banned: bans.some(b => b.ip === h.ip),
                    online: [...clients].filter(c => c.room && c.ip === h.ip).length,
                    sessions: h.sessions.map(s => ({ ...s, online: [...clients].some(c => c.id === s.id && c.room) }))
                })),
                authors: Object.fromEntries(authors), bans,
                trash: trash.map(item => ({ id: item.id, room: item.room, kind: item.kind }))
            });
        }
        if (url.pathname !== "/admin/api/action" || req.method !== "POST") return json(res, 404, { error: "Not found" });
        const data = await body(req);
        if (data.action === "ban" || data.action === "unban") data.ip = normalize(data.ip);
        const room = rooms.get(data.room);
        if (data.action === "kick") {
            const client = [...clients].find(c => c.id === data.id);
            if (!client) return json(res, 404, { error: "Player left" });
            stop(client, "Kicked by admin");
        } else if (data.action === "ban") {
            if (!isIP(data.ip || "")) return json(res, 400, { error: "Invalid IP" });
            if (!bans.some(b => b.ip === data.ip)) save([...bans, { ip: data.ip, time: Date.now() }]);
            for (const c of clients) if (c.ip === data.ip) stop(c, "IP banned by admin");
        } else if (data.action === "unban") {
            const exists = bans.some(b => b.ip === data.ip);
            save(bans.filter(b => b.ip !== data.ip));
            if (exists) for (const target of rooms.values()) notice(target, "An IP ban was removed.", "info");
        } else if (data.action === "restore") {
            const item = trash.find(t => t.id === data.id);
            const target = item && rooms.get(item.room);
            if (!target) return json(res, 404, { error: "Room is no longer available" });
            if (item.kind === "drawing") {
                target.ink = target.ink.concat(item.data).sort((a, b) => a.order - b.order);
                for (const op of item.data) target.hidden.delete(op.id);
                broadcast(target, { type: "drawing", drawing: target.ink });
            } else {
                target.chat.push(...item.data);
                target.chat = target.chat.sort((a, b) => a.time - b.time).slice(-30);
                broadcast(target, { type: "chat_reset", chat: target.chat });
            }
            notice(target, "Admin restored " + (item.kind === "drawing" ? "a drawing." : "chat messages."), "info");
            trash.splice(trash.indexOf(item), 1);
        } else if (data.action === "mute") {
            const client = [...clients].find(c => c.id === data.id && c.room);
            if (!client) return json(res, 404, { error: "Player left" });
            client.muted = data.muted === true;
            notice(rooms.get(client.room), client.name + (client.muted ? " was muted." : " was unmuted."), "moderation");
        } else if (!room) {
            return json(res, 404, { error: "Room is no longer available" });
        } else if (data.action === "announce") {
            const text = typeof data.text === "string" ? data.text.trim().slice(0, 180) : "";
            if (!text) return json(res, 400, { error: "Enter an announcement" });
            notice(room, text, "info");
        } else if (data.action === "author") {
            const ops = room.ink.filter(op => op.owner === data.id);
            if (!ops.length) return json(res, 404, { error: "No drawings from this player" });
            removed(data.room, "drawing", ops);
            const ids = new Set(ops.map(op => op.id));
            room.ink = room.ink.filter(op => op.owner !== data.id);
            for (const id of ids) { room.hidden.add(id); broadcast(room, { type: "undo", id }); }
            notice(room, "Admin removed a player's drawings.", "moderation");
        } else if (data.action === "drawing") {
            const ops = room.ink.filter(op => op.id === data.id);
            if (!ops.length) return json(res, 404, { error: "Drawing not found" });
            removed(data.room, "drawing", ops);
            room.ink = room.ink.filter(op => op.id !== data.id);
            room.hidden.add(data.id);
            broadcast(room, { type: "undo", id: data.id });
            notice(room, "Admin removed a drawing.", "moderation");
        } else if (data.action === "board") {
            if (room.ink.length) removed(data.room, "drawing", room.ink);
            for (const op of room.ink) room.hidden.add(op.id);
            room.ink = [];
            broadcast(room, { type: "wipe" });
            notice(room, "Admin cleared the whole board.", "moderation");
        } else if (data.action === "comment") {
            const messages = room.chat.filter(m => m.mid === data.id);
            if (!messages.length) return json(res, 404, { error: "Comment not found" });
            removed(data.room, "comment", messages);
            room.chat = room.chat.filter(m => m.mid !== data.id);
            broadcast(room, { type: "chat_delete", mid: data.id });
            notice(room, "Admin removed a message.", "moderation");
        } else if (data.action === "chat") {
            if (room.chat.length) removed(data.room, "comment", room.chat);
            room.chat = [];
            broadcast(room, { type: "chat_reset", chat: [] });
            notice(room, "Admin cleared the chat.", "moderation");
        } else return json(res, 400, { error: "Unknown action" });
        return json(res, 200, { ok: true });
    }
    return { handle, address, remember, forget, blocked: ip => bans.some(b => b.ip === ip) };
}
module.exports = { createAdmin };
