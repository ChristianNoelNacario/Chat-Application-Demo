const express = require('express');
const http = require('http');
const socketIO = require('socket.io')
const path = require('path');
const pool = require('./db');
const bcrypt = require('bcrypt');
const session = require('express-session');
const mySQLStore = require('express-mysql-session')(session);

// Creating an express app, a server, and a socket instance from that server
const app = express();
const server = http.createServer(app);
const io = socketIO(server);

const sessionStore = new mySQLStore({
    createDatabaseTable: true, // Create the sessions table if it doesn't exist
    schema: {
      tableName: 'sessions',
      columnNames: {
        session_id: 'session_id',
        expires: 'expires',
        data: 'data'
      }
    }
  }, pool);

const sessionMiddleware = session({
    store: sessionStore,
    secret: process.env.SESSION_SECRET,
    resave: false,
    saveUninitialized: true,
    cookie: {
        secure: false, // set to true if using HTTPS
        httpOnly: true,
        maxAge: 24 * 60 * 60 * 1000 // 24 hours
    }
});

// Middleware
app.use(express.json());
app.use(sessionMiddleware);
app.use(express.static(path.join(__dirname, 'public')));

const activeConnections = new Map();



app.post('/register', async (req, res) => {
    try {
        const { username, password, email } = req.body;
        // hash the password for safe keeping
        const hashedPassword = await bcrypt.hash(password, 10);
        
        await pool.execute('INSERT INTO users (username, password, email) VALUES (?, ?, ?)',[username, hashedPassword, email]);

        // if successful send a message
        res.status(201).json({ message: 'User has been registered successfully' });
    } catch (error) {
        res.status(500).json({ error: error.message });
    }
});

app.post('/login', async (req, res) => {
    try {
      const { username, password } = req.body;
      const [rows] = await pool.execute('SELECT * FROM users WHERE username = ?', [username]);
  
      if (!rows.length || !(await bcrypt.compare(password, rows[0].password))) {
        return res.status(401).json({ error: 'Invalid credentials' });
      }
  
      req.session.regenerate((err) => {
        if (err) {
          console.error('Session regenerate error:', err);
          return res.status(500).json({ error: 'Session error' });
        }
  
        req.session.userId = rows[0].id;
        req.session.username = rows[0].username;
        req.session.save((err) => {
          if (err) {
            console.error('Session save error:', err);
            return res.status(500).json({ error: 'Session save error' });
          }
          res.json({
            message: 'Logged in successfully',
            username: rows[0].username
          });
        });
      });
    } catch (error) {
      console.error('Login error:', error);
      res.status(500).json({ error: error.message });
    }
  });

app.post('/logout', (req, res) => {
    req.session.destroy((err) => {
        if (err) {
            return res.status(500).json({ error: 'Error logging out' });
        }
        res.json({ message: 'Logged out successfully' });
    });
});

io.use((socket, next) => {
    console.log("Session before middleware:", socket.request.session);
    sessionMiddleware(socket.request, {}, (err) => {
        console.log("Session after middleware:", socket.request.session);
        next(err);
    });
});

// io.use((socket, next) => {
//     const username = socket.handshake.auth.username;
//     if (!username) {
//         return next(new Error('Invalid username'));
//     }
    
//     // Get user data from database
//     pool.execute('SELECT * FROM users WHERE username = ?', [username])
//         .then(([rows]) => {
//             if (rows.length === 0) {
//                 return next(new Error('User not found'));
//             }
//             socket.username = username;
//             socket.userId = rows[0].id;
//             next();
//         })
//         .catch(err => next(err));
// });

let userCount = 0;

io.on('connection', socket => { 
    // userCount++;
    // socket.userName = `Guest ${userCount}`;
    // const userId = socket.request.session.userId;
    // const username = socket.request.session.username;
    // const connectionId = socket.id;
    const { username, connectionId } = socket.handshake.auth;

    // console.log('User connected:', { userId, username, connectionId });
    
    // if (!userId || !username) {
    //     // If session data is not available, disconnect the socket
    //     socket.disconnect();
    //     return;
    //   }

    // socket.emit('username', username);
    // socket.emit('connectionId', connectionId);

    // Store connection info
    activeConnections.set(connectionId, {
        username,
        socketId: socket.id
    });

    // Announce user join
    io.emit('chat message', {
        username: 'System',
        message: `${username} has joined the chat`
    });

    //Listening for chat message events
    socket.on('chat message', data => {
        io.emit('chat message', {
            username: data.username,
            message: data.message
        });
    });

    socket.on('disconnect', () => {
        // userCount--;
        // io.emit('chat message', {
        //     user: 'System',
        //     message: `${socket.userName} has left the chat`
        // });
        // console.log(`${socket.userName} has disconnected`);
        const connection = Array.from(activeConnections.entries())
            .find(([_, value]) => value.socketId === socket.id);
            
        if (connection) {
            const [connectionId, { username }] = connection;
            activeConnections.delete(connectionId);
            
            io.emit('chat message', {
                username: 'System',
                message: `${username} has left the chat`
            });
        }
    });

    socket.on('file', fileData => {
        io.emit('file', {
            username: fileData.username,
            file: fileData,
        });
    });
});

const PORT = process.env.PORT || 3000;

server.listen(PORT, () => {
    console.log(`Server running on port http://localhost:${PORT}/login.html`);
})