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

// Raumverwaltung
const rooms = {};

io.on('connection', (socket) => {
    // Raum erstellen
    socket.on('createRoom', ({ playerName, playerEmoji, roomSize, spyCount, roomId }) => {
        // Validierungen
        if (spyCount >= roomSize) return socket.emit('error', { message: 'Die Anzahl der Spione muss kleiner als die Raumgröße sein.' });
        if (rooms[roomId]) return socket.emit('error', { message: 'Diese Raum-ID ist bereits vergeben.' });

        // Raum initialisieren
        rooms[roomId] = {
            roomSize: parseInt(roomSize),
            spyCount: parseInt(spyCount),
            players: [{ name: playerName, avatar: playerEmoji, isSpy: false }],
            playerWords: {},
            committedPlayers: [],
            gameStarted: false,
            gameState: 'waiting', // waiting, wordInput, playing, voting, gameOver
            votes: {},
            spies: []
        };

        // Socket-Daten speichern
        socket.playerName = playerName;
        socket.avatar = playerEmoji;
        socket.join(roomId);

        // Raum-ID im Socket speichern
        socket.roomId = roomId;

        // Bestätigung senden
        socket.emit('roomCreated', { roomId, players: rooms[roomId].players });
        io.to(roomId).emit('roomJoined', {
            roomId,
            players: rooms[roomId].players,
            currentPlayers: rooms[roomId].players.length,
            maxPlayers: rooms[roomId].roomSize
        });

        console.log(`Raum ${roomId} erstellt. (${rooms[roomId].players.length}/${rooms[roomId].roomSize} Spieler)`);
    });

    // Raum beitreten
    socket.on('joinRoom', ({ playerName, playerEmoji, roomId }) => {
        // Validierungen
        const room = rooms[roomId];
        if (!room) return socket.emit('error', { message: 'Raum existiert nicht.' });
        if (room.players.length >= room.roomSize) return socket.emit('error', { message: 'Raum ist voll.' });
        if (room.players.some(p => p.name === playerName)) return socket.emit('error', { message: 'Name bereits vergeben.' });
        if (room.gameState !== 'waiting') return socket.emit('error', { message: 'Spiel bereits gestartet.' });

        // Spieler zum Raum hinzufügen
        room.players.push({ name: playerName, avatar: playerEmoji, isSpy: false });

        // Socket-Daten speichern
        socket.playerName = playerName;
        socket.avatar = playerEmoji;
        socket.join(roomId);

        // Raum-ID im Socket speichern
        socket.roomId = roomId;

        // Bestätigung an alle senden
        io.to(roomId).emit('roomJoined', {
            roomId,
            players: room.players,
            currentPlayers: room.players.length,
            maxPlayers: room.roomSize
        });

        console.log(`Spieler ${playerName} ist Raum ${roomId} beigetreten. (${room.players.length}/${room.roomSize} Spieler)`);

        // Prüfen, ob der Raum jetzt voll ist
        if (room.players.length === room.roomSize) {
            console.log(`Raum ${roomId} ist voll. Starte Begriffseingabe.`);
            room.gameState = 'wordInput';
            io.to(roomId).emit('roomFull', {
                message: `Raum ist voll (${room.players.length}/${room.roomSize})`,
                currentPlayers: room.players.length,
                maxPlayers: room.roomSize
            });
            io.to(roomId).emit('startWordInput');
        }
    });

    // Begriffe einreichen
    socket.on('submitWords', ({ roomId, playerName, words }) => {
        const room = rooms[roomId];
        if (!room) return socket.emit('error', { message: 'Raum existiert nicht.' });
        if (room.gameState !== 'wordInput') return socket.emit('error', { message: 'Aktuell keine Begriffseingabe möglich.' });

        // Prüfen, ob der Spieler bereits Begriffe eingereicht hat
        if (!room.committedPlayers.includes(playerName)) {
            room.committedPlayers.push(playerName);
            room.playerWords[playerName] = words;

            console.log(`Spieler ${playerName} hat Begriffe eingereicht. (${room.committedPlayers.length}/${room.roomSize})`);

            // Status an alle Spieler senden
            io.to(roomId).emit('wordsCommitted', {
                committedPlayers: room.committedPlayers,
                totalPlayers: room.roomSize,
                currentCount: room.committedPlayers.length
            });

            // Wenn alle Spieler Begriffe eingereicht haben, Countdown starten
            if (room.committedPlayers.length === room.roomSize) {
                console.log(`Alle Spieler in Raum ${roomId} haben Begriffe eingereicht. Starte Countdown.`);

                // Wortpool aus allen Begriffen aller Spieler erstellen
                room.words = [];
                Object.values(room.playerWords).forEach(wordArr => {
                    room.words.push(...wordArr);
                });

                // Countdown starten
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
        } else {
            // Spieler hat bereits eingereicht - nur Status aktualisieren
            socket.emit('wordsCommitted', {
                committedPlayers: room.committedPlayers,
                totalPlayers: room.roomSize,
                currentCount: room.committedPlayers.length
            });
        }
    });

    // Spiel starten
    function startGame(roomId) {
        const room = rooms[roomId];
        if (!room) return;

        room.gameState = 'playing';

        // Spione zufällig auswählen
        const spyIndices = [];
        while (spyIndices.length < room.spyCount) {
            const index = Math.floor(Math.random() * room.players.length);
            if (!spyIndices.includes(index)) spyIndices.push(index);
        }

        // Spione markieren
        room.spies = spyIndices.map(i => room.players[i].name);
        room.players.forEach((p, i) => p.isSpy = spyIndices.includes(i));

        // Geheimen Begriff auswählen
        const word = room.words[Math.floor(Math.random() * room.words.length)];
        room.secretWord = word;

        console.log(`Spiel in Raum ${roomId} gestartet. Geheimer Begriff: ${word}, Spione: ${room.spies.join(', ')}`);

        // Rollen individuell an jeden Spieler senden
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

        // Nach 30 Sekunden Abstimmung starten
        setTimeout(() => {
            if (rooms[roomId] && rooms[roomId].gameState === 'playing') {
                room.gameState = 'voting';
                io.to(roomId).emit('startVoting', { players: room.players });
                console.log(`Abstimmungsphase in Raum ${roomId} gestartet.`);
            }
        }, 30000);
    }

    // Abstimmung
    socket.on('vote', ({ roomId, votedPlayer }) => {
        const room = rooms[roomId];
        if (!room) return socket.emit('error', { message: 'Raum existiert nicht.' });
        if (room.gameState !== 'voting') return socket.emit('error', { message: 'Aktuell keine Abstimmung möglich.' });

        // Stimme speichern
        room.votes[socket.playerName] = votedPlayer;

        // Abstimmungsergebnis an alle senden
        io.to(roomId).emit('voteUpdate', room.votes);

        // Prüfen ob die Mehrheit abgestimmt hat
        const requiredVotes = Math.ceil(room.players.length / 2);
        if (Object.keys(room.votes).length >= requiredVotes) {
            // Stimmen zählen
            const voteCounts = {};
            Object.values(room.votes).forEach(v => voteCounts[v] = (voteCounts[v] || 0) + 1);

            // Spieler mit den meisten Stimmen ermitteln
            const [votedOut, count] = Object.entries(voteCounts).sort((a, b) => b[1] - a[1])[0];

            if (count >= requiredVotes) {
                const votedPlayer = room.players.find(p => p.name === votedOut);

                if (votedPlayer.isSpy) {
                    // Spion wurde enttarnt
                    room.spies = room.spies.filter(s => s !== votedOut);
                    room.players = room.players.filter(p => p.name !== votedOut);

                    io.to(roomId).emit('voteResult', {
                        result: `Spion entlarvt! ${votedOut} war ein Spion! Spieler gewinnen diese Runde.`,
                        spiesLeft: room.spies.length
                    });

                    if (room.spies.length === 0) {
                        // Alle Spione enttarnt, Spiel beenden
                        room.gameState = 'gameOver';
                        io.to(roomId).emit('gameOver', {
                            winner: 'Spieler',
                            secretWord: room.secretWord,
                            spies: room.spies
                        });
                    } else {
                        // Nächste Abstimmungsrunde
                        room.votes = {};
                        io.to(roomId).emit('startVoting', { players: room.players });
                    }
                } else {
                    // Unschuldiger wurde enttarnt, Spione gewinnen
                    room.gameState = 'gameOver';
                    io.to(roomId).emit('voteResult', {
                        result: `${votedOut} war KEIN Spion! Spione gewinnen.`,
                        spiesLeft: room.spies.length
                    });
                    io.to(roomId).emit('gameOver', {
                        winner: 'Spione',
                        secretWord: room.secretWord,
                        spies: room.spies
                    });
                }
            }
        }
    });

    // Raum verlassen
    socket.on('leaveRoom', ({ roomId }) => {
        handlePlayerLeave(socket, roomId);
    });

    // Spieler-Disconnect
    socket.on('disconnect', () => {
        if (socket.roomId) {
            handlePlayerLeave(socket, socket.roomId);
        }
    });

    // Hilfsfunktion: Spieler aus Raum entfernen
    function handlePlayerLeave(socket, roomId) {
        const room = rooms[roomId];
        if (!room) return;

        // Spieler aus Listen entfernen
        room.players = room.players.filter(p => p.name !== socket.playerName);
        room.committedPlayers = room.committedPlayers.filter(p => p !== socket.playerName);

        if (room.playerWords && socket.playerName in room.playerWords) {
            delete room.playerWords[socket.playerName];
        }

        console.log(`Spieler ${socket.playerName} hat Raum ${roomId} verlassen.`);

        // Alle anderen Spieler informieren
        io.to(roomId).emit('roomJoined', {
            roomId,
            players: room.players,
            currentPlayers: room.players.length,
            maxPlayers: room.roomSize
        });

        // Raum löschen, wenn leer
        if (room.players.length === 0) {
            delete rooms[roomId];
            console.log(`Raum ${roomId} wurde gelöscht (keine Spieler mehr).`);
        }
        // Wenn Spiel bereits läuft und ein Spion gegangen ist, Spiel evtl. beenden
        else if (room.gameState === 'playing' || room.gameState === 'voting') {
            const isSpyLeft = room.spies.includes(socket.playerName);
            if (isSpyLeft) {
                room.spies = room.spies.filter(s => s !== socket.playerName);
                if (room.spies.length === 0) {
                    // Alle Spione weg, Spieler gewinnen
                    room.gameState = 'gameOver';
                    io.to(roomId).emit('gameOver', {
                        winner: 'Spieler',
                        secretWord: room.secretWord,
                        spies: room.spies,
                        message: `Alle Spione haben das Spiel verlassen. Spieler gewinnen!`
                    });
                }
            }
        }
    }
});

const PORT = process.env.PORT || 10000;
server.listen(PORT, '0.0.0.0', () => {
    console.log(`Server läuft auf Port ${PORT}`);
});
