const WebSocket = require('ws');
const express = require('express');
const http = require('http');
const sqlite3 = require('sqlite3').verbose();

// Инициализация приложения Express
const app = express();
const server = http.createServer(app);
const wss = new WebSocket.Server({ server });

// Инициализация базы данных SQLite
const db = new sqlite3.Database(':memory:'); // Вы можете использовать файл для постоянного хранения

// Создание таблицы комнат в базе данных
db.serialize(() => {
    db.run("CREATE TABLE IF NOT EXISTS rooms (id INTEGER PRIMARY KEY AUTOINCREMENT, name TEXT UNIQUE)");
});

// Функция для добавления комнаты в базу данных
function addRoomToDatabase(roomName, callback) {
    db.run("INSERT INTO rooms (name) VALUES (?)", [roomName], (err) => {
        if (err) {
            console.log(`Error adding room: ${err.message}`);
        }
        if (callback) callback();
    });
}

// Получение списка комнат из базы данных
function getAllRooms(callback) {
    db.all("SELECT name FROM rooms", (err, rows) => {
        if (err) {
            console.log(`Error retrieving rooms: ${err.message}`);
            return;
        }
        const rooms = rows.map(row => row.name);
        callback(rooms);
    });
}

// Комнаты: ключ - название комнаты, значение - список WebSocket подключений
const rooms = {};

// Отправка сообщения всем пользователям в комнате, кроме отправителя
function broadcastToRoom(roomName, message, sender) {
    if (rooms[roomName]) {
        rooms[roomName].forEach(client => {
            if (client !== sender && client.readyState === WebSocket.OPEN) {
                client.send(message);
            }
        });
    }
}

// Обновление списка пользователей в комнате
function updateUserList(roomName) {
    if (rooms[roomName]) {
        const users = rooms[roomName].map(client => client.username || 'Anonymous');
        const message = JSON.stringify({ type: 'updateUserList', users });
        rooms[roomName].forEach(client => {
            if (client.readyState === WebSocket.OPEN) {
                client.send(message);
            }
        });
    }
}

// Управление подключениями WebSocket
wss.on('connection', (ws) => {
    ws.room = null; // Комната по умолчанию
    ws.username = `User${Math.floor(Math.random() * 1000)}`; // Генерация случайного имени пользователя

    // При подключении отправляем список доступных комнат
    getAllRooms((roomList) => {
        ws.send(JSON.stringify({ type: 'roomList', rooms: roomList }));
    });

    ws.on('message', (message) => {
        const data = JSON.parse(message);

        // Изменение никнейма
        if (data.action === 'changeUsername') {
            ws.username = data.username;
            if (ws.room) {
                updateUserList(ws.room);
            }
        }

        // Создание новой комнаты
        if (data.action === 'createRoom') {
            const roomName = data.room;
            if (!rooms[roomName]) {
                rooms[roomName] = [];
                // Добавляем комнату в базу данных
                addRoomToDatabase(roomName, () => {
                    // После добавления комнаты в базу данных отправляем уведомление пользователю
                    ws.send(JSON.stringify({ type: 'notification', message: `Room '${roomName}' created.` }));
                    // Обновляем список комнат для всех пользователей
                    getAllRooms((roomList) => {
                        wss.clients.forEach(client => {
                            client.send(JSON.stringify({ type: 'roomList', rooms: roomList }));
                        });
                    });
                });
            }
        }

        // Присоединение к комнате
        if (data.action === 'joinRoom') {
            const roomName = data.room;

            // Покидаем предыдущую комнату, если есть
            if (ws.room) {
                rooms[ws.room] = rooms[ws.room].filter(client => client !== ws);
                updateUserList(ws.room);
            }

            // Присоединяемся к новой комнате
            ws.room = roomName;
            if (!rooms[roomName]) {
                rooms[roomName] = [];
            }
            rooms[roomName].push(ws);

            // Уведомляем всех в комнате о новом пользователе
            broadcastToRoom(roomName, JSON.stringify({
                type: 'notification',
                message: `${ws.username} joined the room`
            }), ws);

            updateUserList(roomName);
        }

        // Обработка сообщений WebRTC (SDP и ICE кандидаты)
        if (data.sdp || data.candidate) {
            if (ws.room && rooms[ws.room]) {
                broadcastToRoom(ws.room, message, ws);
            }
        }

        // Обработка текстового чата
        if (data.type === 'chat') {
            const chatMessage = {
                type: 'chat',
                username: ws.username,
                message: data.message
            };
            broadcastToRoom(ws.room, JSON.stringify(chatMessage), ws);
        }
    });

    // Обработка отключения пользователя
    ws.on('close', () => {
        if (ws.room && rooms[ws.room]) {
            rooms[ws.room] = rooms[ws.room].filter(client => client !== ws);
            broadcastToRoom(ws.room, JSON.stringify({
                type: 'notification',
                message: `${ws.username} left the room`
            }), ws);
            updateUserList(ws.room);
        }
    });
});

// Запуск сервера на порту 8000
server.listen(8000, () => {
    console.log('Server is running on port 8000');
});
