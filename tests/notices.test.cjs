const test = require("node:test");
const assert = require("node:assert/strict");
const { once } = require("node:events");
const { WebSocket } = require("ws");
const { createTestServer } = require("../server.cjs");

test("server notices announce joins and leaves without trusting client notice fields", async t => {
    const app = createTestServer({ adminKey: "" });
    await new Promise(resolve => app.server.listen(0, "127.0.0.1", resolve));
    t.after(() => app.close());
    const url = "ws://127.0.0.1:" + app.server.address().port + "/ws";
    const a = new WebSocket(url);
    await once(a, "open");
    const messages = [];
    a.on("message", bytes => messages.push(JSON.parse(bytes)));
    const wait = async fn => {
        for (let i = 0; i < 100; i++) {
            if (fn()) return;
            await new Promise(resolve => setTimeout(resolve, 10));
        }
        assert.fail("Missing notice");
    };
    a.send(JSON.stringify({ type: "join", name: "One", room: "LOBBY" }));
    await wait(() => messages.some(m => m.kind === "join"));
    const b = new WebSocket(url);
    await once(b, "open");
    b.send(JSON.stringify({ type: "join", name: "Two", room: "LOBBY" }));
    await wait(() => messages.some(m => m.text === "Two joined."));
    b.send(JSON.stringify({ type: "chat", text: "hello", kind: "moderation", name: "Server" }));
    await wait(() => messages.some(m => m.type === "chat"));
    const chat = messages.find(m => m.type === "chat");
    assert.equal(chat.kind, undefined);
    assert.equal(chat.name, "Two");
    b.close();
    await wait(() => messages.some(m => m.text === "Two left." && m.kind === "leave"));
    assert.ok(messages.filter(m => m.type === "notice").every(m => !m.ip));
    a.close();
});
