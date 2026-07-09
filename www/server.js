const WebSocket = require('ws');
const http = require('http');
const fs = require('fs');
const path = require('path');

const PORT = 3000;
const HOST = '0.0.0.0';  // 监听所有网络接口，支持局域网访问
const BOARD_SIZE = 15;

const server = http.createServer((req, res) => {
    let filePath;
    if (req.url === '/' || req.url === '/index.html') {
        filePath = path.join(__dirname, 'index.html');
    } else if (req.url === '/wu-online.html') {
        filePath = path.join(__dirname, 'wu-online.html');
    } else if (req.url === '/wu.html') {
        filePath = path.join(__dirname, 'wu.html');
    } else {
        res.writeHead(404);
        res.end('Not found');
        return;
    }

    fs.readFile(filePath, (err, data) => {
        if (err) {
            res.writeHead(500);
            res.end('Error loading file');
        } else {
            res.writeHead(200, { 'Content-Type': 'text/html' });
            res.end(data);
        }
    });
});

const wss = new WebSocket.Server({ server });

const rooms = new Map();

function generateRoomId() {
    const chars = 'ABCDEFGHJKLMNPQRSTUVWXYZ23456789';
    let id = '';
    for (let i = 0; i < 6; i++) {
        id += chars[Math.floor(Math.random() * chars.length)];
    }
    return id;
}

function createRoom(ws, playerName) {
    let roomId;
    do {
        roomId = generateRoomId();
    } while (rooms.has(roomId));

    const room = {
        id: roomId,
        players: [
            { ws, name: playerName, color: 'black', image: null, ready: false }
        ],
        board: Array(BOARD_SIZE).fill().map(() => Array(BOARD_SIZE).fill(0)),
        turn: 'black',
        gameOver: false,
        frozenPlayer: null,
        lastRemoved: null,
        powerSnapshot: null,
        doubleTurn: false  // 静如止水连下两子
    };

    rooms.set(roomId, room);
    ws.roomId = roomId;
    ws.playerColor = 'black';

    ws.send(JSON.stringify({
        type: 'roomCreated',
        roomId,
        playerColor: 'black',
        playerName,
        opponent: '对手'
    }));

    console.log(`Room ${roomId} created by ${playerName} (black)`);
}

function joinRoom(ws, roomId, playerName) {
    const room = rooms.get(roomId);
    if (!room) {
        ws.send(JSON.stringify({ type: 'error', message: '房间不存在' }));
        return false;
    }
    if (room.players.length >= 2) {
        ws.send(JSON.stringify({ type: 'error', message: '房间已满' }));
        return false;
    }

    room.players.push({ ws, name: playerName, color: 'white', image: null, ready: false });
    ws.roomId = roomId;
    ws.playerColor = 'white';

    const blackPlayer = room.players.find(p => p.color === 'black');
    ws.send(JSON.stringify({
        type: 'roomCreated',
        roomId,
        playerColor: 'white',
        playerName,
        opponent: blackPlayer ? blackPlayer.name : '对手'
    }));

    if (blackPlayer) {
        blackPlayer.ws.send(JSON.stringify({
            type: 'playerJoined',
            playerName
        }));
    }

    console.log(`${playerName} (white) joined room ${roomId}`);
    return true;
}

function broadcast(room, message, excludeColor = null) {
    room.players.forEach(player => {
        if (player.color !== excludeColor && player.ws.readyState === WebSocket.OPEN) {
            player.ws.send(JSON.stringify(message));
        }
    });
}

function sendTo(room, color, message) {
    const player = room.players.find(p => p.color === color);
    if (player && player.ws.readyState === WebSocket.OPEN) {
        player.ws.send(JSON.stringify(message));
    }
}

function checkWin(room, row, col, playerVal) {
    const dirs = [[1, 0], [0, 1], [1, 1], [1, -1]];
    for (let [dx, dy] of dirs) {
        let cnt = 1;
        for (let i = 1; i < 5; i++) {
            const nr = row + i * dx, nc = col + i * dy;
            if (nr < 0 || nr >= BOARD_SIZE || nc < 0 || nc >= BOARD_SIZE || room.board[nr][nc] !== playerVal) break;
            cnt++;
        }
        for (let i = 1; i < 5; i++) {
            const nr = row - i * dx, nc = col - i * dy;
            if (nr < 0 || nr >= BOARD_SIZE || nc < 0 || nc >= BOARD_SIZE || room.board[nr][nc] !== playerVal) break;
            cnt++;
        }
        if (cnt >= 5) return true;
    }
    return false;
}

function getOpponent(color) {
    return color === 'black' ? 'white' : 'black';
}

wss.on('connection', (ws) => {
    console.log('New client connected');

    ws.on('message', (data) => {
        try {
            const msg = JSON.parse(data);
            const room = ws.roomId ? rooms.get(ws.roomId) : null;

            switch (msg.type) {
                case 'create':
                    createRoom(ws, msg.name || '玩家');
                    break;

                case 'join':
                    joinRoom(ws, msg.roomId, msg.name || '玩家');
                    break;

                case 'uploadImage':
                    if (room) {
                        const player = room.players.find(p => p.ws === ws);
                        if (player) {
                            player.image = msg.image;
                            player.ready = true;

                            broadcast(room, {
                                type: 'imageUploaded',
                                color: player.color,
                                name: player.name
                            });

                            const bothReady = room.players.every(p => p.ready);
                            if (bothReady) {
                                const blackPlayer = room.players.find(p => p.color === 'black');
                                const whitePlayer = room.players.find(p => p.color === 'white');
                                room.turn = 'black';
                                room.gameOver = false;
                                room.doubleTurn = false;

                                broadcast(room, {
                                    type: 'gameStart',
                                    turn: 'black',
                                    opponentImage: getOpponent(ws.playerColor) === 'black'
                                        ? blackPlayer.image
                                        : whitePlayer.image,
                                    opponentName: getOpponent(ws.playerColor) === 'black'
                                        ? blackPlayer.name
                                        : whitePlayer.name
                                });
                            } else {
                                sendTo(room, getOpponent(ws.playerColor), {
                                    type: 'waitingForImage'
                                });
                            }
                        }
                    }
                    break;

                case 'move':
                    if (room && !room.gameOver) {
                        const player = room.players.find(p => p.ws === ws);
                        if (player && player.color === room.turn && room.frozenPlayer !== player.color) {
                            const { row, col } = msg;
                            if (row >= 0 && row < BOARD_SIZE && col >= 0 && col < BOARD_SIZE && room.board[row][col] === 0) {
                                const playerVal = player.color === 'black' ? 1 : 2;
                                room.board[row][col] = playerVal;

                                broadcast(room, {
                                    type: 'opponentMove',
                                    row,
                                    col,
                                    player: player.color
                                });

                                if (checkWin(room, row, col, playerVal)) {
                                    room.gameOver = true;
                                    const winnerImage = player.image;
                                    broadcast(room, {
                                        type: 'gameOver',
                                        winner: player.color,
                                        winnerImage
                                    });
                                } else {
                                    // 检查是否是连下两子
                                    if (room.doubleTurn) {
                                        // 连下两子，保持回合不变
                                        room.doubleTurn = false;
                                        broadcast(room, {
                                            type: 'turnChange',
                                            turn: room.turn,
                                            doubleTurn: true
                                        });
                                    } else {
                                        room.turn = getOpponent(room.turn);
                                        if (room.frozenPlayer === room.turn) {
                                            room.frozenPlayer = null;
                                            room.turn = getOpponent(room.turn);
                                        }
                                        broadcast(room, {
                                            type: 'turnChange',
                                            turn: room.turn
                                        });
                                    }
                                }
                                refreshSkillButtons(room);
                            }
                        }
                    }
                    break;

                case 'skill':
                    if (room && !room.gameOver) {
                        const player = room.players.find(p => p.ws === ws);
                        if (player && player.color === room.turn) {
                            const { skill, target } = msg;

                            if (skill === 'sand') {
                                const targetVal = room.board[target.row][target.col];
                                if (targetVal === 0) return;

                                // 询问对手是否使用擒拿
                                const opponent = getOpponent(player.color);
                                sendTo(room, opponent, {
                                    type: 'sandChallenge',
                                    attacker: player.color,
                                    target
                                });
                            } else if (skill === 'still') {
                                // 静如止水：冻结对手，己方连下两子
                                room.frozenPlayer = getOpponent(player.color);
                                room.doubleTurn = true;  // 开启连下两子
                                room.frozenTurns = 1;
                                broadcast(room, {
                                    type: 'skillUsed',
                                    skill: 'still',
                                    player: player.color,
                                    frozen: room.frozenPlayer
                                });
                                refreshSkillButtons(room);
                            } else if (skill === 'power') {
                                // 力拔山兮：保存快照，询问对手是否东山再起
                                room.powerSnapshot = {
                                    board: room.board.map(r => [...r]),
                                    turn: room.turn,
                                    frozen: room.frozenPlayer,
                                    lastRemoved: room.lastRemoved ? {...room.lastRemoved} : null,
                                    doubleTurn: room.doubleTurn
                                };
                                const opponent = getOpponent(player.color);
                                sendTo(room, opponent, {
                                    type: 'powerChallenge',
                                    attacker: player.color
                                });
                            } else if (skill === 'return') {
                                // 拾金不昧：从什刹海捞回棋子
                                if (room.lastRemoved) {
                                    const { row, col, color } = room.lastRemoved;
                                    if (room.board[row][col] === 0) {
                                        room.board[row][col] = color;
                                        room.lastRemoved = null;
                                        broadcast(room, {
                                            type: 'skillUsed',
                                            skill: 'return',
                                            player: player.color,
                                            row, col, color
                                        });
                                    }
                                }
                            }
                        }
                    }
                    break;

                case 'sandResponse':
                    if (room) {
                        const { useCatch, target, attacker } = msg;
                        const atkRoll = Math.floor(Math.random() * 6) + 1;
                        const defRoll = Math.floor(Math.random() * 6) + 1;

                        if (!useCatch) {
                            // 不使用擒拿，直接删除棋子
                            room.lastRemoved = {
                                row: target.row,
                                col: target.col,
                                color: room.board[target.row][target.col]
                            };
                            room.board[target.row][target.col] = 0;
                            broadcast(room, {
                                type: 'sandResult',
                                success: false,
                                atkRoll,
                                defRoll,
                                target,
                                useCatch: false
                            });
                        } else {
                            // 使用擒拿，掷骰判定
                            const success = defRoll > atkRoll || (defRoll === atkRoll && Math.random() > 0.5);
                            if (success) {
                                // 防守成功，棋子保留
                                broadcast(room, {
                                    type: 'sandResult',
                                    success: true,
                                    atkRoll,
                                    defRoll,
                                    target,
                                    useCatch: true
                                });
                            } else {
                                // 防守失败，删除棋子
                                room.lastRemoved = {
                                    row: target.row,
                                    col: target.col,
                                    color: room.board[target.row][target.col]
                                };
                                room.board[target.row][target.col] = 0;
                                broadcast(room, {
                                    type: 'sandResult',
                                    success: false,
                                    atkRoll,
                                    defRoll,
                                    target,
                                    useCatch: true
                                });
                            }
                        }
                        refreshSkillButtons(room);
                    }
                    break;

                case 'powerResponse':
                    if (room) {
                        const player = room.players.find(p => p.ws === ws);
                        if (msg.use) {
                            // 使用东山再起，恢复棋盘
                            if (room.powerSnapshot) {
                                room.board = room.powerSnapshot.board.map(r => [...r]);
                                room.turn = room.powerSnapshot.turn;
                                room.frozenPlayer = room.powerSnapshot.frozen;
                                room.lastRemoved = room.powerSnapshot.lastRemoved ? {...room.powerSnapshot.lastRemoved} : null;
                                room.doubleTurn = room.powerSnapshot.doubleTurn || false;
                                room.powerSnapshot = null;
                                room.gameOver = false;
                                broadcast(room, {
                                    type: 'skillUsed',
                                    skill: 'revive',
                                    player: player.color,
                                    board: room.board,
                                    turn: room.turn,
                                    frozenPlayer: room.frozenPlayer,
                                    lastRemoved: room.lastRemoved
                                });
                                broadcast(room, { type: 'turnChange', turn: room.turn });
                            }
                        } else {
                            // 不使用东山再起，攻击方获胜
                            room.gameOver = true;
                            const attacker = room.powerSnapshot ? room.powerSnapshot.turn : room.turn;
                            broadcast(room, {
                                type: 'gameOver',
                                winner: attacker,
                                winnerImage: room.players.find(p => p.color === attacker).image
                            });
                            room.powerSnapshot = null;
                        }
                        refreshSkillButtons(room);
                    }
                    break;

                case 'restart':
                    if (room) {
                        room.board = Array(BOARD_SIZE).fill().map(() => Array(BOARD_SIZE).fill(0));
                        room.turn = 'black';
                        room.gameOver = false;
                        room.frozenPlayer = null;
                        room.lastRemoved = null;
                        room.powerSnapshot = null;
                        room.doubleTurn = false;
                        room.players.forEach(p => p.ready = false);

                        broadcast(room, {
                            type: 'gameReset'
                        });
                    }
                    break;
            }
        } catch (e) {
            console.error('Message error:', e);
        }
    });

    ws.on('close', () => {
        if (ws.roomId) {
            const room = rooms.get(ws.roomId);
            if (room) {
                const player = room.players.find(p => p.ws === ws);
                if (player) {
                    broadcast(room, {
                        type: 'playerLeft',
                        color: player.color,
                        name: player.name
                    });
                    room.players = room.players.filter(p => p.ws !== ws);
                    if (room.players.length === 0) {
                        rooms.delete(ws.roomId);
                        console.log(`Room ${ws.roomId} deleted`);
                    }
                }
            }
        }
        console.log('Client disconnected');
    });
});

function refreshSkillButtons(room) {
    if (!room) return;
    room.players.forEach(player => {
        if (player.ws.readyState === WebSocket.OPEN) {
            player.ws.send(JSON.stringify({
                type: 'refreshSkills',
                turn: room.turn,
                gameOver: room.gameOver,
                frozenPlayer: room.frozenPlayer,
                doubleTurn: room.doubleTurn
            }));
        }
    });
}

server.listen(PORT, HOST, () => {
    // 获取本机局域网 IP
    const os = require('os');
    const interfaces = os.networkInterfaces();
    let localIP = 'localhost';
    for (const name of Object.keys(interfaces)) {
        for (const iface of interfaces[name]) {
            if (iface.family === 'IPv4' && !iface.internal) {
                localIP = iface.address;
                break;
            }
        }
    }
    console.log(`服务器已启动!`);
    console.log(`本机访问: http://localhost:${PORT}`);
    console.log(`局域网访问: http://${localIP}:${PORT}`);
    console.log(`打开 http://${localIP}:${PORT}/wu-online.html 进行联机对战`);
});
