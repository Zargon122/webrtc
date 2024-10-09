const fs = require('fs');
const https = require('https');
const WebSocket = require('ws');
const express = require('express');
const sqlite3 = require('sqlite3').verbose();

// Инициализация приложения Express
const app = express();

// SSL сертификаты (здесь укажите правильные пути к вашим сертификатам)
const server = https.createServer({
    cert: fs.readFileSync('/path/to/fullchain.pem'), // Путь к сертификату
    key: fs.readFileSync('/path/to/privkey.pem')     // Путь к приватному ключу
});

// Инициализация WSS поверх HTTPS
const wss = new WebSocket.Server({ server });

// Инициализация базы данных SQLite
const db = new sqlite3.Database(':memory:'); // Можно использовать файл для постоянного хранения данных

// Создание таблицы комнат и сообщений в базе данных
db.serialize(() => {
    db.run("CREATE TABLE IF NOT EXISTS rooms (id INTEGER PRIMARY KEY AUTOINCREMENT, name TEXT UNIQUE)");
    db.run("CREATE TABLE IF NOT EXISTS messages (id INTEGER PRIMARY KEY AUTOINCREMENT, roomName TEXT, username TEXT, message TEXT, timestamp DATETIME DEFAULT CURRENT_TIMESTAMP)");
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

// Сохранение сообщения в базе данных
function saveMessage(roomName, username, message) {
    db.run("INSERT INTO messages (roomName, username, message) VALUES (?, ?, ?)", [roomName, username, message], (err) => {
        if (err) {
            console.log(`Error saving message: ${err.message}`);
        }
    });
}

// Получение истории сообщений для комнаты
function getChatHistory(roomName, callback) {
    db.all("SELECT username, message, timestamp FROM messages WHERE roomName = ? ORDER BY timestamp ASC", [roomName], (err, rows) => {
        if (err) {
            console.log(`Error retrieving messages: ${err.message}`);
            return;
        }
        callback(rows);
    });
}

// Комнаты: ключ - название комнаты, значение - список WebSocket подключений
const rooms = {};

// Отправка сообщения всем пользователям в комнате
function broadcastToRoom(roomName, message, sender = null) {
    if (rooms[roomName]) {
        rooms[roomName].forEach(client => {
            if (client.readyState === WebSocket.OPEN) {
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
                addRoomToDatabase(roomName, () => {
                    ws.send(JSON.stringify({ type: 'notification', message: `Room '${roomName}' created.` }));
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

            // Отправляем пользователю историю сообщений
            getChatHistory(roomName, (messages) => {
                ws.send(JSON.stringify({ type: 'chatHistory', messages }));
            });

            broadcastToRoom(roomName, JSON.stringify({
                type: 'notification',
                message: `${ws.username} joined the room`
            }), ws);

            updateUserList(roomName);
        }

        // Обработка текстового чата
        if (data.type === 'chat') {
            const chatMessage = {
                type: 'chat',
                username: ws.username,
                message: data.message
            };

            // Сохраняем сообщение в базе данных
            saveMessage(ws.room, ws.username, data.message);

            // Отправляем сообщение всем пользователям, включая отправителя
            broadcastToRoom(ws.room, JSON.stringify(chatMessage));
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

// Запуск HTTPS сервера и WSS WebSocket
server.listen(8000, () => {
    console.log('Server is running with WSS on port 8000');
});
