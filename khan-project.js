var multiplayerProbe = {
    protocol: "coderguy-ws-test-v1",
    status: "Waiting for bridge userscript",
    connected: false,
    selfId: "",
    room: "",
    ping: 0,
    serverTick: 0,
    players: [],
    input: {
        up: false,
        down: false,
        left: false,
        right: false
    }
};
var dotPositions = {};
var lastDrawMs = 0;
var updateTestKey = function(code, down) {
    if (code === 87 || code === 38) {
        multiplayerProbe.input.up = down;
    }
    if (code === 83 || code === 40) {
        multiplayerProbe.input.down = down;
    }
    if (code === 65 || code === 37) {
        multiplayerProbe.input.left = down;
    }
    if (code === 68 || code === 39) {
        multiplayerProbe.input.right = down;
    }
};
keyPressed = function() {
    updateTestKey(keyCode, true);
};
keyReleased = function() {
    updateTestKey(keyCode, false);
};
draw = function() {
    var now = millis();
    var elapsed = lastDrawMs ? constrain(now - lastDrawMs, 0, 100) : 0;
    lastDrawMs = now;
    background(12, 19, 30);
    var viewScale = min(width / 800, height / 600);
    pushMatrix();
    translate((width - 800 * viewScale) / 2, (height - 600 * viewScale) / 2);
    scale(viewScale);
    stroke(100, 160, 210, 25);
    strokeWeight(1);
    for (var gridX = 0; gridX <= 800; gridX += 40) {
        line(gridX, 0, gridX, 600);
    }
    for (var gridY = 0; gridY <= 600; gridY += 40) {
        line(0, gridY, 800, gridY);
    }
    noFill();
    stroke(100, 180, 240, 100);
    rect(0, 0, 800, 600);
    var nextDots = {};
    for (var playerIndex = 0; playerIndex < multiplayerProbe.players.length; playerIndex++) {
        var player = multiplayerProbe.players[playerIndex];
        var previous = dotPositions[player.id] || {
            x: player.x,
            y: player.y
        };
        previous.x = lerp(previous.x, player.x, 1 - exp(-elapsed / 65));
        previous.y = lerp(previous.y, player.y, 1 - exp(-elapsed / 65));
        nextDots[player.id] = previous;
        var self = player.id === multiplayerProbe.selfId;
        var palette = [color(102, 202, 255), color(255, 180, 94), color(166, 238, 137), color(232, 154, 255), color(255, 127, 139), color(122, 232, 223), color(255, 242, 137), color(182, 185, 255)];
        noStroke();
        fill(palette[playerIndex % palette.length], 35);
        ellipse(previous.x, previous.y, 42, 42);
        fill(palette[playerIndex % palette.length]);
        ellipse(previous.x, previous.y, 24, 24);
        if (self) {
            noFill();
            stroke(240, 250, 255, 200);
            strokeWeight(2);
            ellipse(previous.x, previous.y, 32, 32);
        }
        fill(220, 235, 250);
        textAlign(CENTER, CENTER);
        textSize(13);
        text(player.name + (self ? " (you)" : ""), previous.x, previous.y - 27);
    }
    dotPositions = nextDots;
    popMatrix();
    noStroke();
    fill(215, 235, 255);
    textAlign(LEFT, TOP);
    textSize(16);
    text("WEBSOCKET TEST", 16, 14);
    fill(160, 190, 215);
    textSize(11);
    text(multiplayerProbe.connected ? multiplayerProbe.room + "  |  " + multiplayerProbe.players.length + "/8  |  " + multiplayerProbe.ping + " ms" : multiplayerProbe.status, 16, 39);
    textAlign(CENTER, CENTER);
    if (!multiplayerProbe.connected) {
        fill(215, 235, 255);
        textSize(17);
        text("Connect with the bridge userscript", width / 2, height / 2 - 14);
        fill(150, 185, 215);
        textSize(12);
        text("Join the same room in two browsers", width / 2, height / 2 + 14);
    }
    fill(160, 190, 215);
    textSize(11);
    text("Click canvas  |  WASD / arrows", width / 2, height - 18);
};
