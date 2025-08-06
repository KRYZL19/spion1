const express = require('express');
const http = require('http');
const path = require('path');
const { Server } = require('socket.io');

const app = express();
const server = http.createServer(app);
const io = new Server(server, {
    cors: {
        origin: '*',
        methods: ['GET', 'POST']
    }
});

app.use(express.static(path.join(__dirname, 'public')));
app.get('/', (req, res) => {
    res.sendFile(path.join(__dirname, 'public', 'index.html'));
});

const rooms = {};
const avatars = ["😀","😎","🦊","🐻","🐼","🐵","🐸","🐯","🐶","🐱","🐹","🐰","🐢","🦄","🐙","🐧","🐦","🐠","🐷","🦁"];

io.on('connection', (socket) => {
    socket.on('createRoom', ({ playerName, roomSize, spyCount, roomId }) => {
        if (spyCount >= roomSize) return socket.emit('error', { message: 'Die Anzahl der Spione muss kleiner als die Raumgröße sein.' });
        if (rooms[roomId]) return socket.emit('error', { message: 'Diese Raum-ID ist bereits vergeben.' });

        const avatar = avatars[Math.floor(Math.random() * avatars.length)];
        rooms[roomId] = {
            roomSize,
            spyCount,
            players: [{ name: playerName, avatar, isSpy: false }],
            words: [],
            committedPlayers: [],
            gameStarted: false,
            votes: {},
            spies: []
        };
        socket.playerName = playerName;
        socket.avatar = avatar;
        socket.join(roomId);
        socket.emit('roomCreated', { roomId, players: rooms[roomId].players });
        io.to(roomId).emit('roomJoined', { roomId, players: rooms[roomId].players });
    });

    socket.on('joinRoom', ({ playerName, roomId }) => {
        const room = rooms[roomId];
        if (!room) return socket.emit('error', { message: 'Raum existiert nicht.' });
        if (room.players.length >= room.roomSize) return socket.emit('error', { message: 'Raum ist voll.' });
        if (room.players.some(p => p.name === playerName)) return socket.emit('error', { message: 'Name bereits vergeben.' });

        const avatar = avatars[Math.floor(Math.random() * avatars.length)];
        room.players.push({ name: playerName, avatar, isSpy: false });
        socket.playerName = playerName;
        socket.avatar = avatar;
        socket.join(roomId);

        io.to(roomId).emit('roomJoined', { roomId, players: room.players });

        if (room.players.length === room.roomSize) {
            io.to(roomId).emit('startWordInput');
        }
    });

    socket.on('submitWords', ({ roomId, playerName, words }) => {
        const room = rooms[roomId];
        if (!room) return socket.emit('error', { message: 'Raum existiert nicht.' });

        room.words.push(...words);
        if (!room.committedPlayers.includes(playerName)) {
            room.committedPlayers.push(playerName);
        }

        io.to(roomId).emit('wordsCommitted', { committedPlayers: room.committedPlayers, totalPlayers: room.roomSize });

        if (room.committedPlayers.length === room.roomSize) {
            let countdown = 5;
            const countdownInterval = setInterval(() => {
                io.to(roomId).emit('countdown', countdown);
                countdown--;
                if (countdown < 0) {
                    clearInterval(countdownInterval);
                    startGame(roomId);
                }
            }, 1000);
        }
    });

    function startGame(roomId) {
        const room = rooms[roomId];
        if (!room) return;

        const spyIndices = [];
        while (spyIndices.length < room.spyCount) {
            const index = Math.floor(Math.random() * room.players.length);
            if (!spyIndices.includes(index)) spyIndices.push(index);
        }

        room.spies = spyIndices.map(i => room.players[i].name);
        room.players.forEach((p, i) => p.isSpy = spyIndices.includes(i));
        const word = room.words[Math.floor(Math.random() * room.words.length)];

        room.players.forEach((player, index) => {
            const role = spyIndices.includes(index) ? 'Spion' : 'Spieler';
            const playerSocket = [...io.sockets.sockets.values()].find(s =>
                [...s.rooms].includes(roomId) && s.playerName === player.name
            );

            if (playerSocket) {
                playerSocket.emit('gameStart', {
                    role,
                    word: role !== 'Spion' ? word : null,
                    players: room.players
                });
            }
        });

        room.gameStarted = true;
        setTimeout(() => io.to(roomId).emit('startVoting', { players: room.players }), 30000); // 30 Sekunden Diskussion
    }

    socket.on('vote', ({ roomId, votedPlayer }) => {
        const room = rooms[roomId];
        if (!room) return;
        room.votes[socket.playerName] = votedPlayer;

        io.to(roomId).emit('voteUpdate', room.votes);

        if (Object.keys(room.votes).length >= Math.ceil(room.players.length / 2)) {
            const voteCounts = {};
            Object.values(room.votes).forEach(v => voteCounts[v] = (voteCounts[v] || 0) + 1);

            const [votedOut, count] = Object.entries(voteCounts).sort((a, b) => b[1] - a[1])[0];
            if (count >= Math.ceil(room.players.length / 2)) {
                const votedPlayer = room.players.find(p => p.name === votedOut);
                if (votedPlayer.isSpy) {
                    room.spies = room.spies.filter(s => s !== votedOut);
                    room.players = room.players.filter(p => p.name !== votedOut);
                    io.to(roomId).emit('voteResult', { result: 'Spion entlarvt! Spieler gewinnen diese Runde.', spiesLeft: room.spies.length });
                    if (room.spies.length === 0) {
                        io.to(roomId).emit('gameOver', { winner: 'Spieler' });
                    } else {
                        room.votes = {};
                        io.to(roomId).emit('startVoting', { players: room.players });
                    }
                } else {
                    io.to(roomId).emit('gameOver', { winner: 'Spione' });
                }
            }
        }
    });

    socket.on('leaveRoom', ({ roomId }) => {
        const room = rooms[roomId];
        if (!room) return;
        room.players = room.players.filter(p => p.name !== socket.playerName);
        room.committedPlayers = room.committedPlayers.filter(p => p !== socket.playerName);
        io.to(roomId).emit('roomJoined', { roomId, players: room.players });
        if (room.players.length === 0) delete rooms[roomId];
    });

    socket.on('disconnect', () => {
        for (const roomId in rooms) {
            const room = rooms[roomId];
            room.players = room.players.filter(p => p.name !== socket.playerName);
            room.committedPlayers = room.committedPlayers.filter(p => p !== socket.playerName);
            io.to(roomId).emit('roomJoined', { roomId, players: room.players });
            if (room.players.length === 0) delete rooms[roomId];
        }
    });
});

const PORT = process.env.PORT || 10000;
server.listen(PORT, '0.0.0.0', () => {
    console.log(`Server läuft auf Port ${PORT}`);
});
