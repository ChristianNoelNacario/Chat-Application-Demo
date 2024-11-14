document.addEventListener('DOMContentLoaded', () => {
    // connecting to the server using socket io
    const username = localStorage.getItem('username');
    const connectionId = localStorage.getItem('connectionId');

    if (!username || !connectionId) {
        window.location.href = '/login.html';
        return;
    }

    const socket = io({
        auth: { 
            username,
            connectionId
        }
    });

    console.log('Socket connected');

    // let username; // Declare the username variable
    // let connectionId;
    

    // socket.on('username', (data) => {
    //     username = data; // Store the username when received
    // });

    // socket.on('connectionId', (data) => {
    //     connectionId = data; // Store the connectionId when received
    // });

    document.querySelector('form').addEventListener('submit', (e) => {
        e.preventDefault();
        const messageInput = document.querySelector('#message');
        const message = messageInput.value.trim();
        
        if (message) {
            socket.emit('chat message', {
                message,
                username,
                connectionId
            });
            messageInput.value = '';
        }
        return false;
    });

    document.querySelector('#message').addEventListener('keypress', () => {
        // if the user is currently typing, set it to true and emit a stop typing message
        if (!typing) {
            typing = true;
            stopTyping();
        }
        // then set a timeout for 1 second to emit a stop typing message
        setTimeout(() => {
            typing = false;
            stopTyping();
            }, 1000);
    });

    socket.on('chat message', data => {

        // on chat message, create a div element and add the message to it
        const messages = document.createElement('div');
        messages.classList.add('message');

        // create a strong element to hold the username
        const userName = document.createElement('strong');
        userName.textContent = data.username + ': ';

        // make a node for the value of the message
        const messageContent = document.createTextNode(data.message);

        // append both to the messages div
        messages.appendChild(userName);
        messages.appendChild(messageContent);

        // append the messages div to the chat div
        document.querySelector('#chat').appendChild(messages);

        messages.scrollIntoView({behavior: 'smooth'});
    });


    document.querySelector('#attach-file').onclick = () => {
        console.log("Clicked");
        document.querySelector('#file-input').click();
    }

    document.querySelector('#file-input').onchange = (e) => {
        const file = e.target.files[0];
        const message = document.querySelector('#message').value;

        if(file){
            const reader = new FileReader();
            reader.onload = (e) => {
                socket.emit('file', {
                    name: file.name,
                    type: file.type,
                    data: e.target.result,
                    message: message,
                    username: username,
                });
            };
            reader.readAsDataURL(file);
        }
    }

    socket.on('file', data => {
        
        // on chat message, create a div element and add the message to it
        const messages = document.createElement('div');
        messages.classList.add('message');

        // create a strong element to hold the username
        const userName = document.createElement('strong');
        userName.textContent = data.username + ': ';
        messages.appendChild(userName);

        const messageText = document.createElement('span');
        messageText.textContent = data.file.message;
        messages.appendChild(messageText);
        messages.appendChild(document.createElement('br'));

        if (data.file.type.startsWith('image/')) {
            // Image preview
            const image = document.createElement('img');
            image.src = data.file.data;
            image.style.maxWidth = '200px';
            image.style.maxHeight = '200px';
            image.style.marginTop = '10px';
            messages.appendChild(image);
        } else {
            // Non-image file link
            const link = document.createElement('a');
            link.href = data.file.data;
            link.download = data.file.name;
            link.className = 'download-btn';
            link.textContent = `Download: ${data.file.name}`;
            messages.appendChild(link);
        }
        
        // append the messages div to the chat div
        document.querySelector('#chat').appendChild(messages);

        const message = document.querySelector('#message');
        message.value = '';
        messages.scrollIntoView({behavior: 'smooth'});
    });
});