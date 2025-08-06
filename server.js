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

// Statische Dateien bereitstellen
app.use(express.static(path.join(__dirname, 'public')));
app.get('/', (req, res) => {
    res.sendFile(path.join(__dirname, 'public', 'index.html'));
});

const rooms = {};

io.on('connection', (socket) => {
    socket.on('createRoom', ({ playerName, roomSize, spyCount }) => {
        if (spyCount >= roomSize) {
            return socket.emit('error', { message: 'Die Anzahl der Spione muss kleiner als die Raumgröße sein.' });
        }
        const roomId = Math.random().toString(36).substring(2, 8);
        rooms[roomId] = {
            roomSize,
            spyCount,
            players: [playerName],
            words: [],
            committedPlayers: [],
            gameStarted: false
        };
        socket.playerName = playerName;
        socket.join(roomId);
        socket.emit('roomCreated', { roomId, roomSize, spyCount, players: [playerName] });
    });

    socket.on('joinRoom', ({ playerName, roomId }) => {
        const room = rooms[roomId];
        if (!room) return socket.emit('error', { message: 'Raum existiert nicht.' });
        if (room.players.length >= room.roomSize) return socket.emit('error', { message: 'Raum ist voll.' });
        if (room.players.includes(playerName)) return socket.emit('error', { message: 'Name bereits vergeben.' });

        room.players.push(playerName);
        socket.playerName = playerName;
        socket.join(roomId);

        io.to(roomId).emit('roomJoined', { roomId, roomSize: room.roomSize, players: room.players });

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

        // Allen Spielern anzeigen, wer committed hat
        io.to(roomId).emit('wordsCommitted', { committedPlayers: room.committedPlayers, totalPlayers: room.roomSize });

        // Wenn alle committed haben, Countdown starten
        if (room.committedPlayers.length === room.roomSize) {
            let countdown = 5; // Sekunden Countdown
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

        const word = room.words[Math.floor(Math.random() * room.words.length)];

        // Rollen individuell an Spieler senden
        room.players.forEach((player, index) => {
            const role = spyIndices.includes(index) ? 'Spion' : 'Spieler';
            const playerSocket = [...io.sockets.sockets.values()].find(s =>
                [...s.rooms].includes(roomId) && s.playerName === player
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
    }

    socket.on('leaveRoom', ({ roomId }) => {
        const room = rooms[roomId];
        if (!room) return;
        const playerIndex = room.players.indexOf(socket.playerName);
        if (playerIndex !== -1) {
            room.players.splice(playerIndex, 1);
            room.committedPlayers = room.committedPlayers.filter(p => p !== socket.playerName);
            io.to(roomId).emit('roomJoined', { roomId, roomSize: room.roomSize, players: room.players });
            if (room.players.length === 0) delete rooms[roomId];
        }
    });

    socket.on('disconnect', () => {
        for (const roomId in rooms) {
            const room = rooms[roomId];
            const playerIndex = room.players.indexOf(socket.playerName);
            if (playerIndex !== -1) {
                room.players.splice(playerIndex, 1);
                room.committedPlayers = room.committedPlayers.filter(p => p !== socket.playerName);
                io.to(roomId).emit('roomJoined', { roomId, roomSize: room.roomSize, players: room.players });
                if (room.players.length === 0) delete rooms[roomId];
            }
        }
    });
});

const PORT = process.env.PORT || 10000;
server.listen(PORT, '0.0.0.0', () => {
    console.log(`Server läuft auf Port ${PORT}`);
});
