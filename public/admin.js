(function()
{
    "use strict";
    const $ = id => document.getElementById(id);
    let signed = false, busy = false, state = null, limit = 24;

    function message(text, error = false)
    {
        $("status").textContent = text;
        $("status").className = error ? "error" : "";
    }

    async function api(path, data)
    {
        const response = await fetch("/admin/api/" + path, data ? {
            method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify(data)
        } : { cache: "no-store" });
        const value = await response.json();
        if (!response.ok) {
            if (response.status === 401) show(false);
            throw Error(value.error || "Request failed");
        }
        return value;
    }

    function show(value)
    {
        signed = value;
        $("login").hidden = value;
        $("dashboard").hidden = !value;
        $("logout").hidden = !value;
    }

    function node(tag, text, cls)
    {
        const el = document.createElement(tag);
        if (text !== undefined) el.textContent = text;
        if (cls) el.className = cls;
        return el;
    }

    function button(text, run, danger = false)
    {
        const el = node("button", text, danger ? "danger" : "");
        el.type = "button";
        el.onclick = run;
        return el;
    }

    async function act(action, extra = {})
    {
        if (busy) return;
        busy = true;
        try {
            await api("action", { action, room: $("room").value, ...extra });
            message("Updated.");
            await refresh();
        } catch (error) { message(error.message, true); }
        finally { busy = false; }
    }

    function ban(ip)
    {
        if (window.confirm("Ban " + ip + "? Everyone on that IP will be disconnected and blocked. You can unban it here.")) act("ban", { ip });
    }

    function draw(canvas, ops, preview = false)
    {
        const ctx = canvas.getContext("2d");
        ctx.clearRect(0, 0, canvas.width, canvas.height);
        ctx.save();
        ctx.scale(canvas.width / 800, canvas.height / 600);
        for (const op of ops) {
            ctx.globalCompositeOperation = op.erase && !preview ? "destination-out" : "source-over";
            ctx.strokeStyle = ctx.fillStyle = op.erase && preview ? "#8291a7" : op.color;
            ctx.lineWidth = op.size;
            ctx.lineCap = ctx.lineJoin = "round";
            ctx.beginPath();
            ctx.arc(op.points[0][0], op.points[0][1], op.size / 2, 0, Math.PI * 2);
            ctx.fill();
            ctx.beginPath();
            ctx.moveTo(op.points[0][0], op.points[0][1]);
            for (const p of op.points.slice(1)) ctx.lineTo(p[0], p[1]);
            ctx.stroke();
        }
        ctx.restore();
    }

    function row(parent, title, sub, actions)
    {
        const el = node("div", undefined, "row");
        const text = node("div");
        text.append(node("strong", title), node("div", sub, "muted small"));
        const buttons = node("div", undefined, "actions");
        buttons.append(...actions);
        el.append(text, buttons);
        parent.append(el);
    }

    function empty(parent, text)
    {
        if (!parent.children.length) parent.append(node("p", text, "muted"));
    }

    function render()
    {
        const selected = $("room").value;
        $("room").replaceChildren();
        for (const r of state.rooms) {
            const option = node("option", r.name + " · " + r.players + " players");
            option.value = r.name;
            $("room").append(option);
        }
        $("room").value = state.room ? state.room.name : selected;
        $("count").textContent = state.players.length + " online";
        $("players").replaceChildren();
        for (const player of state.players) row($("players"), player.name, player.ip + " · " + player.room + " · joined " + new Date(player.joined).toLocaleString() + " · " + (player.agent || "Unknown browser"), [
            button("Kick", () => act("kick", { id: player.id })),
            button(player.muted ? "Unmute" : "Mute", () => act("mute", { id: player.id, muted: !player.muted })),
            button("Delete drawings", () => act("author", { id: player.id, room: player.room }), true),
            button("Ban IP", () => ban(player.ip), true)
        ]);
        empty($("players"), "No players online.");
        const room = state.room;
        draw($("board"), room ? room.drawing : []);
        $("clearBoard").disabled = !room || !room.drawing.length;
        $("clearChat").disabled = !room || !room.chat.length;
        const groups = new Map();
        for (const op of room ? room.drawing : []) {
            if (!groups.has(op.id)) groups.set(op.id, []);
            groups.get(op.id).push(op);
        }
        $("drawCount").textContent = groups.size + " strokes";
        $("drawings").replaceChildren();
        for (const [id, ops] of [...groups].reverse().slice(0, limit)) {
            const card = node("div", undefined, "drawing");
            const canvas = document.createElement("canvas");
            canvas.width = 240;
            canvas.height = 180;
            draw(canvas, ops, true);
            const author = state.authors[ops[0].owner] || { name: "Player left", ip: "Unavailable" };
            card.append(canvas, node("strong", author.name), node("p", author.ip, "muted small"),
                node("p", ops[0].erase ? "Eraser stroke" : ops[0].color, "muted small"),
                button("Delete drawing", () => act("drawing", { id }), true));
            $("drawings").append(card);
        }
        empty($("drawings"), "No drawings in this room.");
        $("more").hidden = groups.size <= limit;
        $("comments").replaceChildren();
        for (const comment of room ? room.chat : []) row($("comments"), comment.name + " · " + new Date(comment.time).toLocaleTimeString(), comment.text, [button("Delete", () => act("comment", { id: comment.mid }), true)]);
        empty($("comments"), "No chat messages.");
        $("bans").replaceChildren();
        for (const entry of state.bans) row($("bans"), entry.ip, new Date(entry.time).toLocaleString(), [button("Unban", () => act("unban", { ip: entry.ip }))]);
        empty($("bans"), "No IP bans.");
        renderHistory();
        $("trash").replaceChildren();
        for (const item of state.trash.slice().reverse()) row($("trash"), item.kind === "drawing" ? "Drawing" : "Chat message", item.room, [button("Restore", () => act("restore", { id: item.id }))]);
        empty($("trash"), "Nothing deleted yet.");
    }

    function renderHistory()
    {
        const query = $("historySearch").value.trim().toLowerCase();
        const open = new Set([...$("history").querySelectorAll("details[open]")].map(el => el.dataset.ip));
        $("history").replaceChildren();
        for (const entry of state.history || []) {
            if (query && !entry.ip.includes(query) && !entry.names.some(n => n.name.toLowerCase().includes(query))) continue;
            const details = node("details");
            details.dataset.ip = entry.ip;
            details.open = open.has(entry.ip);
            details.append(node("summary", entry.ip + " · " + entry.visits + " visits · " + entry.online + " online" + (entry.banned ? " · BANNED" : "")));
            details.append(node("p", "First: " + new Date(entry.first).toLocaleString() + " · Last: " + new Date(entry.last).toLocaleString(), "muted small"));
            for (const name of entry.names) details.append(node("p", name.name + " · " + name.visits + " visits · last " + new Date(name.last).toLocaleString()));
            details.append(button(entry.banned ? "Unban IP" : "Ban IP", () => entry.banned ? act("unban", { ip: entry.ip }) : ban(entry.ip), !entry.banned));
            for (const visit of entry.sessions.slice().reverse()) {
                const end = visit.online ? "online now" : visit.end ? new Date(visit.end).toLocaleString() : "server session ended";
                details.append(node("p", visit.name + " · " + visit.room + " · " + new Date(visit.start).toLocaleString() + " → " + end + " · " + (visit.agent || "Unknown browser"), "muted small"));
            }
            $("history").append(details);
        }
        empty($("history"), "No matching history.");
    }

    async function refresh()
    {
        state = await api("state?room=" + encodeURIComponent($("room").value));
        show(true);
        render();
    }

    $("login").onsubmit = async function(event)
    {
        event.preventDefault();
        try {
            await api("login", { key: $("key").value });
            $("key").value = "";
            await refresh();
            message("Connected. Updates every four seconds.");
        } catch (error) { message(error.message, true); }
    };
    $("logout").onclick = async function()
    {
        try { await api("logout", {}); show(false); message("Signed out."); }
        catch (error) { message(error.message, true); }
    };
    $("historySearch").oninput = () => { if (state) renderHistory(); };
    $("room").onchange = () => { limit = 24; refresh().catch(error => message(error.message, true)); };
    $("more").onclick = () => { limit += 24; render(); };
    $("clearBoard").onclick = () => act("board");
    $("clearChat").onclick = () => act("chat");
    $("announce").onsubmit = event => { event.preventDefault(); act("announce", { text: $("announcement").value }); };
    $("banForm").onsubmit = event => { event.preventDefault(); ban($("ip").value.trim()); };
    setInterval(() => {
        if (signed && !busy && !document.hidden) refresh().catch(error => message(error.message, true));
    }, 4000);
    refresh().then(() => message("Connected. Updates every four seconds.")).catch(error => {
        if (!signed && error.message !== "Sign in to continue") message(error.message, true);
    });
})();
