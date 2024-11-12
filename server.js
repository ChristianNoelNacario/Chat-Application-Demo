const express = require('express');
const http = require('http');
const socketIO = require('socket.io')
const path = require('path');
// Required modules

// Creating an express app, a server, and a socket instance from that server
const app = express();
const server = http.createServer(app);
const io = socketIO(server);

app.use(express.static(path.join(__dirname, 'public')));

let userCount = 0;

io.on('connection', socket => {
    userCount++;
    // Need to change this to their account names when implemented
    socket.userName = `User ${userCount}`;

    io.emit('chat message', {
        user: 'System',
        message: `${socket.userName} has joined the chat`
    });

    console.log(`${socket.userName} has connected`);


    //Listening for chat message events
    socket.on('chat message', data => {
        io.emit('chat message', {
            user: socket.userName,
            message: data
        });
    });

// listening for typing events
    socket.on('typing', () =>{
        socket.broadcast.emit('typing', socket.userName);
    });

    // listening for stop typing events
    socket.on('typing', () =>{
        socket.broadcast.emit('stopped typing');
    });

    socket.on('disconnect', () => {
        userCount--;
        io.emit('chat message', {
            user: 'System',
            message: `${socket.userName} has left the chat`})
        console.log(`${socket.userName} has disconnected`);
    });

    socket.on('file', fileData => {
        io.emit('file', {
            user: socket.userName,
            file: fileData,
        });
    });
});

const PORT = process.env.PORT || 3000;

server.listen(PORT, () => {
    console.log(`Server running on port http://localhost:${PORT}/home.html`);
})