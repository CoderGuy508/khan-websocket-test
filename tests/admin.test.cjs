const test = require("node:test");
const assert = require("node:assert/strict");
const { once } = require("node:events");
const { mkdtempSync, rmSync } = require("node:fs");
const { tmpdir } = require("node:os");
const path = require("node:path");
const { WebSocket } = require("ws");
const { createTestServer } = require("../server.cjs");
const pause = ms => new Promise(resolve => setTimeout(resolve, ms));
async function until(fn) {
    const end = Date.now() + 5000;
    while (!fn()) {
        if (Date.now() > end) throw Error("Timed out");
        await pause(10);
    }
}
async function setup(t) {
    const dir = mkdtempSync(path.join(tmpdir(), "room-admin-"));
    const key = "test-key-for-local-admin-only";
    const app = createTestServer({ adminKey: key, banFile: path.join(dir, "bans.json"), secure: false });
    app.server.listen(0, "127.0.0.1");
    await once(app.server, "listening");
    const origin = "http://127.0.0.1:" + app.server.address().port;
    t.after(async () => { await app.close(); rmSync(dir, { recursive: true, force: true }); });
    let cookie = "";
    async function api(route, data, extra = {}) {
        const response = await fetch(origin + "/admin/api/" + route, {
            method: data ? "POST" : "GET",
            headers: { "Content-Type": "application/json", Origin: origin, Cookie: cookie, ...extra },
            body: data ? JSON.stringify(data) : undefined
        });
        if (response.headers.get("set-cookie")) cookie = response.headers.get("set-cookie").split(";")[0];
        return { response, data: await response.json() };
    }
    async function player(name) {
        const ws = new WebSocket(origin.replace("http", "ws") + "/ws");
        const messages = [];
        ws.on("message", bytes => messages.push(JSON.parse(bytes)));
        await once(ws, "open");
        ws.send(JSON.stringify({ type: "join", room: "ADMINTEST", name }));
        await until(() => messages.some(m => m.type === "welcome"));
        return { ws, messages, send: data => ws.send(JSON.stringify(data)), id: messages.find(m => m.type === "welcome").id };
    }
    return { app, key, api, player };
}
test("admin authentication, private IPs, deletion, restore, kick and IP ban", async t => {
    const { app, key, api, player } = await setup(t);
    assert.equal((await api("state")).response.status, 401);
    assert.equal((await api("login", { key: "wrong" })).response.status, 401);
    const login = await api("login", { key });
    assert.equal(login.response.status, 200);
    assert.match(login.response.headers.get("set-cookie"), /HttpOnly/);
    assert.match(login.response.headers.get("set-cookie"), /SameSite=Strict/);
    assert.equal((await api("action", { action: "ban", ip: "127.0.0.1" }, { Origin: "https://other.example" })).response.status, 403);
    const a = await player("Painter");
    a.send({ type: "chat", text: "delete this test" });
    a.send({ type: "draw", id: "a".repeat(16), color: "#336699", size: 8, points: [[20, 30]] });
    await until(() => a.messages.some(m => m.type === "draw") && a.messages.some(m => m.type === "chat"));
    const state = (await api("state?room=ADMINTEST")).data;
    assert.equal(state.players[0].ip, "127.0.0.1");
    assert(!("ip" in a.messages.find(m => m.type === "draw")));
    const mid = state.room.chat[0].mid;
    assert.equal((await api("action", { action: "comment", room: "ADMINTEST", id: mid })).response.status, 200);
    await until(() => a.messages.some(m => m.type === "chat_delete"));
    assert.equal(app.rooms.get("ADMINTEST").chat.length, 0);
    await api("action", { action: "drawing", room: "ADMINTEST", id: "a".repeat(16) });
    assert.equal(app.rooms.get("ADMINTEST").ink.length, 0);
    const trash = (await api("state?room=ADMINTEST")).data.trash;
    for (const item of trash) await api("action", { action: "restore", id: item.id });
    assert.equal(app.rooms.get("ADMINTEST").ink.length, 1);
    assert.equal(app.rooms.get("ADMINTEST").chat.length, 1);
    await api("action", { action: "kick", id: a.id });
    await until(() => a.ws.readyState === WebSocket.CLOSED);
    const b = await player("Again");
    await api("action", { action: "ban", ip: "127.0.0.1" });
    await until(() => b.ws.readyState === WebSocket.CLOSED);
    assert.equal((await api("state")).data.bans.length, 1);
    const blocked = new WebSocket("ws://127.0.0.1:" + app.server.address().port + "/ws");
    const messages = [];
    blocked.on("message", bytes => messages.push(JSON.parse(bytes)));
    await once(blocked, "close");
    assert.match(messages[0].message, /banned/);
    await api("action", { action: "unban", ip: "127.0.0.1" });
    const c = await player("Unbanned");
    c.ws.close();
    await api("logout", {});
    assert.equal((await api("state")).response.status, 401);
});
test("Clear removes only its owner's strokes and large boards stream to late joiners", async t => {
    const { app, player } = await setup(t);
    const a = await player("One"), b = await player("Two");
    const op = { type: "draw", id: "a".repeat(16), color: "#112233", size: 5, points: [[1, 2], [4, 5]] };
    a.send(op);
    b.send({ ...op, id: "b".repeat(16) });
    await until(() => app.rooms.get("ADMINTEST").ink.length === 2);
    a.send({ type: "wipe" });
    await until(() => app.rooms.get("ADMINTEST").ink.length === 1);
    assert.equal(app.rooms.get("ADMINTEST").ink[0].owner, b.id);
    const room = app.rooms.get("ADMINTEST");
    for (let i = 0; i < 240; i++) room.ink.push({ ...op, id: i.toString(16).padStart(16, "0"), owner: a.id, order: i + 10, points: Array.from({ length: 16 }, (_, n) => [n * 10, i]) });
    assert(JSON.stringify(room.ink).length > 40000);
    const c = await player("Late");
    await until(() => c.messages.some(m => m.type === "drawing_end"));
    assert.equal(c.messages.filter(m => m.type === "drawing_chunk").flatMap(m => m.drawing).length, 241);
    assert(c.messages.filter(m => m.type === "drawing_chunk").every(m => JSON.stringify(m).length < 65536));
    a.send({ ...op, id: "f".repeat(16) });
    await until(() => room.ink.length === 242);
    a.send({ type: "cursor", active: false });
    await until(() => b.messages.some(m => m.type === "cursor" && m.id === a.id));
});
test("chat and names are filtered even through direct WebSocket messages", async t => {
    const { player } = await setup(t);
    const a = await player("shit");
    a.send({ type: "chat", text: "hello SH1T world" });
    await until(() => a.messages.some(m => m.type === "chat"));
    assert.equal(a.messages.find(m => m.type === "chat").text, "hello **** world");
    await until(() => a.messages.some(m => m.type === "snapshot"));
    assert.equal(a.messages.find(m => m.type === "snapshot").players[0].name, "****");
});

test("admin can mute, announce, unmute and remove an author's drawings", async t => {
    const { app, key, api, player } = await setup(t);
    await api("login", { key });
    const a = await player("Painter");
    await api("action", { action: "mute", id: a.id, muted: true });
    assert.equal((await api("state")).data.players[0].muted, true);
    a.send({ type: "chat", text: "blocked" });
    await until(() => a.messages.some(m => m.text === "You are muted by admin."));
    assert.equal(app.rooms.get("ADMINTEST").chat.length, 0);
    await api("action", { action: "announce", room: "ADMINTEST", text: "Hello everyone" });
    await until(() => a.messages.some(m => m.type === "notice" && m.text === "Hello everyone"));
    await api("action", { action: "mute", id: a.id, muted: false });
    a.send({ type: "chat", text: "allowed" });
    a.send({ type: "draw", id: "b".repeat(16), color: "#336699", size: 8, points: [[20, 30]] });
    await until(() => app.rooms.get("ADMINTEST").chat.length === 1 && app.rooms.get("ADMINTEST").ink.length === 1);
    await api("action", { action: "author", room: "ADMINTEST", id: a.id });
    assert.equal(app.rooms.get("ADMINTEST").ink.length, 0);
    const trash = (await api("state")).data.trash;
    await api("action", { action: "restore", id: trash[0].id });
    assert.equal(app.rooms.get("ADMINTEST").ink.length, 1);
});
