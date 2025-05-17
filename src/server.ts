import express from 'express';
import http from 'http';
import path from 'path';
import { Server } from 'socket.io';
import { fromIni } from "@aws-sdk/credential-providers";
import { NovaSonicBidirectionalStreamClient } from './client';
import { Buffer } from 'node:buffer';

// Configure AWS credentials
const AWS_PROFILE_NAME = process.env.AWS_PROFILE || 'default';

// Create Express app and HTTP server
const app = express();
const server = http.createServer(app);
const io = new Server(server);

// Create the AWS Bedrock client
const bedrockClient = new NovaSonicBidirectionalStreamClient({
    requestHandlerConfig: {
        maxConcurrentStreams: 10,
    },
    clientConfig: {
        region: process.env.AWS_REGION || "us-east-1",
        credentials: fromIni({ profile: AWS_PROFILE_NAME })
    }
});

// Periodically check for and close inactive sessions (every minute)
// Sessions with no activity for over 5 minutes will be force closed
setInterval(() => {
    console.log("Session cleanup check");
    const now = Date.now();

    // Check all active sessions
    bedrockClient.getActiveSessions().forEach(sessionId => {
        const lastActivity = bedrockClient.getLastActivityTime(sessionId);

        // If no activity for 5 minutes, force close
        if (now - lastActivity > 5 * 60 * 1000) {
            console.log(`Closing inactive session ${sessionId} after 5 minutes of inactivity`);
            try {
                bedrockClient.forceCloseSession(sessionId);
            } catch (error) {
                console.error(`Error force closing inactive session ${sessionId}:`, error);
            }
        }
    });
}, 60000);

// Serve static files from the public directory
app.use(express.static(path.join(__dirname, '../public')));

// Socket.IO connection handler
io.on('connection', (socket) => {
    console.log('New client connected:', socket.id);

    // Create a unique session ID for this client
    const sessionId = socket.id;
    
    // Track whether this session has been initialized
    let sessionInitialized = false;

    try {
        // Create session with the new API
        console.log(`Creating session for ${socket.id}...`);
        const session = bedrockClient.createStreamSession(sessionId);
        
        console.log(`Initiating session for ${socket.id}...`);
        bedrockClient.initiateSession(sessionId)
            .then(() => {
                console.log(`Session ${socket.id} initialized successfully`);
            })
            .catch(error => {
                console.error(`Error initializing session ${socket.id}:`, error);
                // Send detailed error to client
                socket.emit('error', {
                    message: 'Session initialization error',
                    details: error instanceof Error ? error.message : String(error)
                });
            });

        setInterval(() => {
            const connectionCount = Object.keys(io.sockets.sockets).length;
            console.log(`Active socket connections: ${connectionCount}`);
        }, 60000);
        
        // Set up event handlers
        session.onEvent('contentStart', (data) => {
            console.log('contentStart:', data);
            socket.emit('contentStart', data);
        });

        session.onEvent('textOutput', (data) => {
            console.log('Text output:', data);
            socket.emit('textOutput', data);
        });

        session.onEvent('audioOutput', (data) => {
            //console.log('Audio output received, sending to client');
            socket.emit('audioOutput', data);
        });

        session.onEvent('error', (data) => {
            console.error('Error in session:', data);
            socket.emit('error', data);
        });

        session.onEvent('toolUse', (data) => {
            console.log('Tool use detected:', data.toolName);
            socket.emit('toolUse', data);
        });

        session.onEvent('toolResult', (data) => {
            console.log('Tool result received');
            socket.emit('toolResult', data);
        });

        session.onEvent('contentEnd', (data) => {
            console.log('Content end received', data);
            socket.emit('contentEnd', data);
        });

        session.onEvent('streamComplete', () => {
            console.log('Stream completed for client:', socket.id);
            socket.emit('streamComplete');
        });

        // Simplified audioInput handler without rate limiting
        socket.on('audioInput', async (audioData) => {
            try {
                // Convert base64 string to Buffer
                const audioBuffer = typeof audioData === 'string'
                    ? Buffer.from(audioData, 'base64')
                    : Buffer.from(audioData);

                // Stream the audio
                await session.streamAudio(audioBuffer);

            } catch (error) {
                console.error('Error processing audio:', error);
                socket.emit('error', {
                    message: 'Error processing audio',
                    details: error instanceof Error ? error.message : String(error)
                });
            }
        });

        // Generate a unique connection timestamp to ensure unique prompts
        const connectionTimestamp = Date.now().toString();

        socket.on('promptStart', async () => {
            try {
                console.log(`Prompt start received for ${socket.id}`);
                
                // If session already initialized, destroy existing events first
                if (sessionInitialized) {
                    try {
                        // Force end any existing sequences
                        await session.endAudioContent().catch(e => console.log('No audio to end'));
                        await session.endPrompt().catch(e => console.log('No prompt to end'));
                    } catch (e) {
                        console.log(`Error ending previous sequences: ${e}`);
                    }
                }
                
                // Using the default implementation without custom ID
                await session.setupPromptStart();
                console.log(`Prompt start completed for ${socket.id}`);
            } catch (error) {
                console.error(`Error processing prompt start for ${socket.id}:`, error);
                const errorDetails = error instanceof Error ? 
                    { message: error.message, stack: error.stack } : 
                    String(error);
                
                socket.emit('error', {
                    message: 'Error processing prompt start',
                    details: JSON.stringify(errorDetails)
                });
            }
        });

        socket.on('systemPrompt', async (data) => {
            try {
                console.log(`System prompt received for ${socket.id}`);
                
                // Using the default implementation
                await session.setupSystemPrompt(undefined, data);
                console.log(`System prompt completed for ${socket.id}`);
            } catch (error) {
                console.error(`Error processing system prompt for ${socket.id}:`, error);
                const errorDetails = error instanceof Error ? 
                    { message: error.message, stack: error.stack } : 
                    String(error);
                
                socket.emit('error', {
                    message: 'Error processing system prompt',
                    details: JSON.stringify(errorDetails)
                });
            }
        });

        // Here we are sending the conversation history to resume the conversation
        // This set of events need to be sent after system prompt before audio stream starts
        socket.on('conversationResumption', async () => {
            try {
                console.log(`Resume conversation received for ${socket.id}`);
                
                // Add smaller delays between history entries (reduced from 100ms to 50ms)
                await session.setupHistoryForConversationResumtion(undefined, 
                    "hi there i would like to update my hotel reservation", "USER");
                await new Promise(resolve => setTimeout(resolve, 50));
                
                await session.setupHistoryForConversationResumtion(undefined, 
                    "Hello! I'd be happy to assist you with updating your hotel reservation. To get started, could you please provide me with your full name and the check-in date for your reservation?", "ASSISTANT");
                await new Promise(resolve => setTimeout(resolve, 50));
                
                await session.setupHistoryForConversationResumtion(undefined, 
                    "yeah so my name is don smith", "USER");
                await new Promise(resolve => setTimeout(resolve, 50));
                
                await session.setupHistoryForConversationResumtion(undefined, 
                    "Thank you, Don. Now, could you please provide me with the check-in date for your reservation?", "ASSISTANT");
                await new Promise(resolve => setTimeout(resolve, 50));
                
                await session.setupHistoryForConversationResumtion(undefined, 
                    "yes so um let me check just a second", "USER");
                await new Promise(resolve => setTimeout(resolve, 50));
                
                await session.setupHistoryForConversationResumtion(undefined, 
                    "Take your time, Don. I'll be here when you're ready.", "ASSISTANT");

                console.log(`Resume conversation completed for ${socket.id}`);
            } catch (error) {
                console.error(`Error processing conversation resumption for ${socket.id}:`, error);
                const errorDetails = error instanceof Error ? 
                    { message: error.message, stack: error.stack } : 
                    String(error);
                
                socket.emit('error', {
                    message: 'Error processing conversation resumption',
                    details: JSON.stringify(errorDetails)
                });
            }
        });

        socket.on('audioStart', async (data) => {
            try {
                console.log(`Audio start received for ${socket.id}`);
                
                await session.setupStartAudio();
                
                // Mark session as initialized only after full setup
                sessionInitialized = true;
                
                console.log(`Audio start completed for ${socket.id}`);
            } catch (error) {
                console.error(`Error processing audio start for ${socket.id}:`, error);
                const errorDetails = error instanceof Error ? 
                    { message: error.message, stack: error.stack } : 
                    String(error);
                
                socket.emit('error', {
                    message: 'Error processing audio start',
                    details: JSON.stringify(errorDetails)
                });
            }
        });

        socket.on('stopAudio', async () => {
            try {
                console.log('Stop audio requested, beginning proper shutdown sequence');

                // Chain the closing sequence
                await Promise.all([
                    session.endAudioContent()
                        .then(() => session.endPrompt())
                        .then(() => session.close())
                        .then(() => console.log('Session cleanup complete'))
                ]);
            } catch (error) {
                console.error('Error processing streaming end events:', error);
                socket.emit('error', {
                    message: 'Error processing streaming end events',
                    details: error instanceof Error ? error.message : String(error)
                });
            }
        });

        // Handle disconnection
        socket.on('disconnect', async () => {
            console.log('Client disconnected:', socket.id);

            if (bedrockClient.isSessionActive(sessionId)) {
                try {
                    console.log(`Beginning cleanup for disconnected session: ${socket.id}`);

                    // Add explicit timeouts to avoid hanging promises
                    const cleanupPromise = Promise.race([
                        (async () => {
                            try {
                                // Use try/catch for each step to ensure we continue even if one fails
                                try {
                                    await session.endAudioContent();
                                    console.log(`Audio content ended for ${socket.id}`);
                                } catch (e) {
                                    console.log(`No active audio content to end for ${socket.id}`);
                                }
                                
                                try {
                                    await session.endPrompt();
                                    console.log(`Prompt ended for ${socket.id}`);
                                } catch (e) {
                                    console.log(`No active prompt to end for ${socket.id}`);
                                }
                                
                                await session.close();
                                console.log(`Session closed normally for ${socket.id}`);
                            } catch (innerError) {
                                console.error(`Error in session cleanup steps for ${socket.id}:`, innerError);
                                // Force close as a fallback
                                bedrockClient.forceCloseSession(sessionId);
                                console.log(`Force closed session: ${sessionId} after cleanup error`);
                            }
                        })(),
                        new Promise((_, reject) =>
                            setTimeout(() => {
                                console.log(`Session cleanup timeout for ${socket.id}, forcing close`);
                                bedrockClient.forceCloseSession(sessionId);
                                reject(new Error('Session cleanup timeout'));
                            }, 2000)
                        )
                    ]);

                    try {
                        await cleanupPromise;
                        console.log(`Successfully cleaned up session after disconnect: ${socket.id}`);
                    } catch (error) {
                        console.error(`Error during session cleanup after disconnect: ${socket.id}`, error);
                    }
                } catch (error) {
                    console.error(`Outer error cleaning up session: ${socket.id}`, error);
                    try {
                        bedrockClient.forceCloseSession(sessionId);
                        console.log(`Force closed session after outer error: ${sessionId}`);
                    } catch (e) {
                        console.error(`Failed even force close for session: ${sessionId}`, e);
                    }
                }
            } else {
                console.log(`No active session to clean up for ${socket.id}`);
            }
        });

    } catch (error) {
        console.error('Error creating session:', error);
        socket.emit('error', {
            message: 'Failed to initialize session',
            details: error instanceof Error ? error.message : String(error)
        });
        socket.disconnect();
    }
});

// Health check endpoint
app.get('/health', (req, res) => {
    res.status(200).json({ status: 'ok', timestamp: new Date().toISOString() });
});

// Start the server
const PORT = process.env.PORT || 3000;
server.listen(PORT, () => {
    console.log(`Server listening on port ${PORT}`);
    console.log(`Open http://localhost:${PORT} in your browser to access the application`);
});

process.on('SIGINT', async () => {
    console.log('Shutting down server...');

    const forceExitTimer = setTimeout(() => {
        console.error('Forcing server shutdown after timeout');
        process.exit(1);
    }, 5000);

    try {
        // First close Socket.IO server which manages WebSocket connections
        await new Promise(resolve => io.close(resolve));
        console.log('Socket.IO server closed');

        // Then close all active sessions
        const activeSessions = bedrockClient.getActiveSessions();
        console.log(`Closing ${activeSessions.length} active sessions...`);

        await Promise.all(activeSessions.map(async (sessionId) => {
            try {
                await bedrockClient.closeSession(sessionId);
                console.log(`Closed session ${sessionId} during shutdown`);
            } catch (error) {
                console.error(`Error closing session ${sessionId} during shutdown:`, error);
                bedrockClient.forceCloseSession(sessionId);
            }
        }));

        // Now close the HTTP server with a promise
        await new Promise(resolve => server.close(resolve));
        clearTimeout(forceExitTimer);
        console.log('Server shut down');
        process.exit(0);
    } catch (error) {
        console.error('Error during server shutdown:', error);
        process.exit(1);
    }
});