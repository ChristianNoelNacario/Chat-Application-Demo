const express = require('express');
const http = require('http');
const socketIO = require('socket.io')
const path = require('path');
const pool = require('./db');
const bcrypt = require('bcrypt');
const session = require('express-session');
const mySQLStore = require('express-mysql-session')(session);
const nodemailer = require('nodemailer');
const { google } = require('googleapis');
const twilio = require('twilio');
const multer = require('multer');
const upload = multer({ dest: 'uploads/' });
const VoiceResponse = require('twilio').twiml.VoiceResponse;
const AccessToken = require('twilio').jwt.AccessToken;
const VoiceGrant = AccessToken.VoiceGrant;
const urlencoded = require('body-parser').urlencoded;

const oauth2Client = new google.auth.OAuth2(
  process.env.GMAIL_CLIENT_ID,
  process.env.GMAIL_CLIENT_SECRET,
  process.env.GMAIL_REDIRECT_URI
)

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

// Socket IO Real Time Chat Part

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


io.on('connection', socket => { 

    const { username, connectionId } = socket.handshake.auth;


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


// MAILING PORTION OF SERVER

const checkGmailAuth = async (req, res, next) => {
  try {
    const [userRow] = await pool.execute(
      'SELECT gmail_refresh_token FROM users WHERE id = ?', 
      [req.session.userId]
    );

    if (!userRow[0]?.gmail_refresh_token) {
      return res.status(401).json({ error: 'Gmail authentication required' });
    }

    oauth2Client.setCredentials({
      refresh_token: userRow[0].gmail_refresh_token
    });

    next();
  } catch (error) {
    res.status(500).json({ error: error.message });
  }
};

const transporter = nodemailer.createTransport({
  service: 'gmail',
  port: 587,
  secure: false,
  auth: {
    user: process.env.EMAIL_USERNAME,
    pass: process.env.EMAIL_PASSWORD
  },
  debug: true,
});

transporter.verify(function(error, success) {
  if (error) {
    console.log(error);
  } else {
    console.log("Server is ready to send emails");
  }
});

app.post('/send-email', async (req, res) => {
  try {
    const { recipient, subject, body, attachments = [] } = req.body;
    const userId = req.session.userId;

    const [rows] = await pool.execute('SELECT email FROM users Where id=?', [userId]);
    const sender = rows[0].email;

    const mailOptions = {
      from: sender,
      to: recipient,
      subject: subject,
      text: body
    };

    console.log('Attachments received:', attachments);
    // Only add attachments if they exist
    if (attachments && attachments.length > 0) {
      mailOptions.attachments = attachments.map(attachment => ({
        filename: attachment.name,
        content: attachment.data.split(',')[1], 
        encoding: 'base64',
        contentType: attachment.type
      }));
    }

    console.log('Mail options:', mailOptions);
    await transporter.sendMail(mailOptions);

    await pool.execute('INSERT INTO emails (sender, recipient, subject, body, attachments) VALUES (?, ?, ?, ?, ?)', [sender, recipient, subject, body, JSON.stringify(attachments)]);

    res.status(200).json({ message: `Email successfully sent`});
  }
  catch(e){
    console.error('Error sending email:', e);
    res.status(500).json({ error: e.message });
  }
})

app.get('/emails', checkGmailAuth, async (req, res) => {
  try {
    const userId = req.session.userId;
    const [userRow] = await pool.execute('SELECT email FROM users WHERE id = ?', [userId]);

    const gmail = google.gmail({version: 'v1', auth: oauth2Client});

    const response = await gmail.users.messages.list({
      userId: 'me',
      maxResults: 10
    });

    if (!response.data.messages) {
      return res.json([]);
    }

    const receivedEmails = await Promise.all(response.data.messages.map(async (message) => {
      const email = await gmail.users.messages.get({
        userId: 'me',
        id: message.id,
        format: 'full'
      });

      const headers = email.data.payload.headers;
      return {
        type: 'received',
        sender: headers.find(h => h.name === 'From')?.value || 'Unknown',
        recipient: headers.find(h => h.name === 'To')?.value || userRow[0].email,
        subject: headers.find(h => h.name === 'Subject')?.value || 'No Subject',
        body: email.data.snippet,
        created_at: new Date(parseInt(email.data.internalDate)),
        attachments: '[]'
      };
    }));

    const sortedEmails = receivedEmails.sort((a, b) => b.created_at - a.created_at);
    res.status(200).json(sortedEmails);

  } catch (error) {
    console.error('Error retrieving emails:', error);
    res.status(500).json({ error: error.message });
  }
});

app.get('/auth/google', (req, res) => {
  const authUrl = oauth2Client.generateAuthUrl({
    access_type: 'offline',
    scope: [
      'https://www.googleapis.com/auth/gmail.readonly',
      'https://www.googleapis.com/auth/gmail.send'
    ],
    prompt: 'consent' // Force refresh token generation
  });
  res.redirect(authUrl);
});

app.get('/auth/google/callback', async (req, res) => {
  try {
    const {code} = req.query;
    const {tokens} = await oauth2Client.getToken(code);
    
    await pool.execute(
      'UPDATE users SET gmail_refresh_token = ? WHERE id = ?',
      [tokens.refresh_token, req.session.userId]
    );

    res.redirect('/email.html');
  } catch (error) {
    console.error('Auth error:', error);
    res.status(500).send('Authentication failed');
  }
});

// TWILIO PORTION OF SERVER

const client = twilio(
  process.env.TWILIO_ACCOUNT_SID,
  process.env.TWILIO_AUTH_TOKEN
)

app.post('/upload-media', upload.single('file'), async (req, res) => {
  try {
    const mediaUrl = await client.messages.media.create({
      file: req.file.path
    });
    res.json({ url: mediaUrl.uri });
  } catch (error) {
    res.status(500).json({ error: error.message });
  }
});

app.post('/send-sms', async (req, res) => {
  try {
    const { recipient, message, mediaUrl } = req.body;
    const sender = process.env.TWILIO_PHONE_NUMBER;

    const messageParams = {
      body: message,
      from: sender,
      to: recipient.startsWith('+') ? recipient : `+${recipient}`
    };

    if (mediaUrl) {
      messageParams.mediaUrl = [mediaUrl];
    }

    const result = await client.messages.create(messageParams);
    const sanitizedMediaUrl = mediaUrl || null; // Convert undefined to null
    console.log('Media URL:', sanitizedMediaUrl);

    await pool.execute(
      'INSERT INTO sms_messages (sender, recipient, message, media_url) VALUES (?, ?, ?, ?)',
      [sender, recipient, message, sanitizedMediaUrl]
    );

    res.status(200).json({ message: 'Message sent successfully' });
  } catch (error) {
    console.error('Error:', error);
    res.status(500).json({ error: error.message });
  }
});

app.get('/sms-history', async (req, res) => {
  try {
    const messages = await client.messages.list({
      limit: 20
    });

    const formattedMessages = messages.map(msg => ({
      to: msg.to,
      from: msg.from,
      body: msg.body,
      mediaUrl: msg.mediaUrl ? msg.mediaUrl[0] : null,
      dateCreated: msg.dateCreated,
      status: msg.status,
      direction: msg.direction
    }));

    res.status(200).json(formattedMessages);
  } catch (error) {
    console.error('Error fetching Twilio messages:', error);
    res.status(500).json({ error: 'Failed to fetch message history' });
  }
});


app.post('/sms-webhook', express.raw({type: 'application/json'}), async (req, res) => {
  try {
    const incomingMessage = req.body;
    
    await pool.execute(
      'INSERT INTO sms_message (sender, recipient, message, media_url, direction) VALUES (?, ?, ?, ?, ?)',
      [incomingMessage.From, incomingMessage.To, incomingMessage.Body, incomingMessage.MediaUrl0, 'inbound']
    );
 
    res.status(200).send();
  } catch (error) {
    console.error('Error handling incoming SMS:', error);
    res.status(500).send();
  }
});


// THIS IS THE VOICE PART

app.post('/voice-token', (req, res) => {
  const identity = 'client-identity'; // Unique identity for the client (e.g., user ID)

  console.log('Identity:', identity);
  // Create VoiceGrant for the token
  const voiceGrant = new VoiceGrant({
    outgoingApplicationSid: process.env.TWILIO_TWIML_APP_SID, // TwiML App SID for outgoing calls
    incomingAllow: true, // Allow incoming calls to the browser
  });

  // Create an access token
  const token = new AccessToken(process.env.TWILIO_ACCOUNT_SID, process.env.TWILIO_API_KEY, process.env.TWILIO_API_SECRET, { identity: 'client-identity'});

  token.addGrant(voiceGrant);

  console.log('Token:', token.identity);

  res.json({ token: token.toJwt(),
    identity: token.identity
   });
});

app.post('/make-call', async (req, res) => {
  try {
    const { recipient } = req.body;
    const call = await client.calls.create({
      url: 'https://a2ac-61-9-103-41.ngrok-free.app/voice', // TwiML webhook URL
      to: recipient,
      from: process.env.TWILIO_PHONE_NUMBER
    });
    
    res.json({ callSid: call.sid });
  } catch (error) {
    console.error('Call error:', error);
    res.status(500).json({ error: error.message });
  }
});

app.get('/call-history', async (req, res) => {
  try {
    const calls = await client.calls.list({ limit: 20 });
    res.json(calls);
  } catch (error) {
    res.status(500).json({ error: error.message });
  }
});

// TwiML webhook for voice calls
app.use(express.json());


app.post('/voice-status', (req, res) => {
  console.log('Call Status Event:', req.body.CallStatus);
  console.log('Call SID:', req.body.CallSid);
  console.log('Full Status Update:', req.body);
  res.sendStatus(200);
});


////////////////////////////////////////

app.use(urlencoded({ extended: false }));

app.post('/voice', (request, response) => {
  const twiml = new VoiceResponse();

  // Use the `<Dial>` TwiML verb to forward the call to a specific client identity
  if (request.body.To && request.body.To !== process.env.TWILIO_PHONE_NUMBER) {
    const dial = twiml.dial({
      callerId: process.env.TWILIO_PHONE_NUMBER
    });
    
    dial.number(request.body.To);
  } 

  else {
    const dial = twiml.dial({
      callerId: request.body.From
    });
    dial.client('client-identity');
  }
  // Render the TwiML as XML for Twilio
  response.type('text/xml');
  response.send(twiml.toString());
});

const PORT = process.env.PORT || 3000;

server.listen(PORT, () => {
    console.log(`Server running on port http://localhost:${PORT}/login.html`);
})