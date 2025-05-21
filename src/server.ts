import express from 'express';
import http from 'http';
import path from 'path';
import { Server, Socket } from 'socket.io';
import { fromIni } from "@aws-sdk/credential-providers";
import { NovaSonicBidirectionalStreamClient, StreamSession } from './client';
import { Buffer } from 'node:buffer';
import { randomUUID } from 'crypto';

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

// Add this function before the io.on('connection') handler
// const setupConversationHistory = async (session: any, socket: Socket) => {
//     try {
//         console.log(`Setting up conversation history for ${socket.id}`);
        
//         await session.setupHistoryForConversationResumtion(undefined, 
//             "hi there i would like to extend my hotel reservation", "USER");
//         await new Promise(resolve => setTimeout(resolve, 50));
        
//         await session.setupHistoryForConversationResumtion(undefined, 
//             "Hello! I'd be happy to assist you with extending your hotel reservation. To get started, could you please provide me with your full name and the check-in date for your reservation?", "ASSISTANT");
//         await new Promise(resolve => setTimeout(resolve, 50));
        
//         await session.setupHistoryForConversationResumtion(undefined, 
//             "My check in date was yesterday, what date was yesterday?", "USER");
//         await new Promise(resolve => setTimeout(resolve, 50));

//         console.log(`Conversation history setup completed for ${socket.id}`);
//     } catch (error) {
//         console.error(`Error setting up conversation history for ${socket.id}:`, error);
//         socket.emit('error', {
//             message: 'Error setting up conversation history',
//             details: error instanceof Error ? error.message : String(error)
//         });
//     }
// };

// Socket.IO connection handler
io.on('connection', (socket) => {
    console.log('New client connected:', socket.id);

    // Create a unique session ID for this client
    let currentSessionId = socket.id; // Track the current session ID for this socket
    
    // Track whether this session has been initialized
    let sessionInitialized = false;
    let session: StreamSession;  // Add proper type

    try {
        // Create session with the new API
        console.log(`Creating session for ${socket.id}...`);
        session = bedrockClient.createStreamSession(currentSessionId);
        
        // Emit the initial session ID
        socket.emit('sessionId', { sessionId: currentSessionId });
        
        console.log(`Initiating session for ${socket.id}...`);
        bedrockClient.initiateSession(currentSessionId)
            .catch(error => {
                console.error(`Error initializing session ${socket.id}:`, error);
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
        const setupSessionEventHandlers = (sessionObj: StreamSession) => {
            sessionObj.onEvent('contentStart', (data) => {
                console.log('contentStart:', data);
                socket.emit('contentStart', data);
            });

            sessionObj.onEvent('textOutput', (data) => {
                console.log('Text output:', data);
                socket.emit('textOutput', data);
            });

            sessionObj.onEvent('audioOutput', (data) => {
                socket.emit('audioOutput', data);
            });

            sessionObj.onEvent('error', (data) => {
                console.error('Error in session:', data);
                socket.emit('error', data);
            });

            sessionObj.onEvent('toolUse', (data) => {
                console.log('Tool use detected:', data.toolName);
                socket.emit('toolUse', data);
            });

            sessionObj.onEvent('toolResult', (data) => {
                console.log('Tool result received');
                socket.emit('toolResult', data);
            });

            sessionObj.onEvent('contentEnd', (data) => {
                console.log('Content end received', data);
                socket.emit('contentEnd', data);
            });

            sessionObj.onEvent('streamComplete', () => {
                console.log('Stream completed for client:', socket.id);
                socket.emit('streamComplete');
            });
        };
        setupSessionEventHandlers(session);

        // Simplified audioInput handler without rate limiting
        socket.on('audioInput', async (audioData) => {
            try {
                const audioBuffer = typeof audioData === 'string'
                    ? Buffer.from(audioData, 'base64')
                    : Buffer.from(audioData);
                await session.streamAudio(audioBuffer);
            } catch (error) {
                console.error('Error processing audio:', error);
                socket.emit('error', {
                    message: 'Error processing audio',
                    details: error instanceof Error ? error.message : String(error)
                });
            }
        });

        socket.on('promptStart', async () => {
            try {
                console.log(`Prompt start received for ${socket.id}`);
                if (sessionInitialized) {
                    try {
                        await session.endAudioContent().catch(e => console.log('No audio to end'));
                        await session.endPrompt().catch(e => console.log('No prompt to end'));
                    } catch (e) {
                        console.log(`Error ending previous sequences: ${e}`);
                    }
                }
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

        socket.on('conversationResumption', async (conversationHistory) => {
            try {
                console.log(`Resume conversation received for ${socket.id}`, conversationHistory);
                if (conversationHistory && conversationHistory.length > 0) {
                    for (const message of conversationHistory) {
                        await session.setupHistoryForConversationResumtion(
                            undefined,
                            message.message,
                            message.role
                        );
                    }
                } else {
                    await session.setupHistoryForConversationResumtion(undefined, 
                        "hi there i would like to extend my hotel reservation", "USER");
                    await new Promise(resolve => setTimeout(resolve, 50));
                    await session.setupHistoryForConversationResumtion(undefined, 
                        "Hello! I'd be happy to assist you with extending your hotel reservation. To get started, could you please provide me with your full name and the check-in date for your reservation?", "ASSISTANT");
                    await new Promise(resolve => setTimeout(resolve, 50));
                    await session.setupHistoryForConversationResumtion(undefined, 
                        "My name is Jane marry", "USER");
                    await new Promise(resolve => setTimeout(resolve, 50));
                }
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

        socket.on('reinitializeSession', async () => {
            try {
                console.log(`Reinitializing session for ${socket.id}`);
                if (sessionInitialized) {
                    try {
                        await session.endAudioContent().catch(e => console.log('No audio to end'));
                        await session.endPrompt().catch(e => console.log('No prompt to end'));
                        await session.close();
                    } catch (e) {
                        console.log(`Error ending previous sequences: ${e}`);
                    }
                }
                const newSessionId = randomUUID();
                console.log(`Creating new session with ID: ${newSessionId}`);
                session = bedrockClient.createStreamSession(newSessionId);
                currentSessionId = newSessionId;
                sessionInitialized = false;
                setupSessionEventHandlers(session);

                bedrockClient.initiateSession(newSessionId);
                // Emit the new session ID
                socket.emit('sessionId', { sessionId: newSessionId });
                socket.emit('sessionReinitialized', { newSessionId });
            } catch (error) {
                console.error(`Error reinitializing session for ${socket.id}:`, error);
                socket.emit('error', {
                    message: 'Error reinitializing session',
                    details: error instanceof Error ? error.message : String(error)
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

            if (bedrockClient.isSessionActive(currentSessionId)) {
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
                                bedrockClient.forceCloseSession(currentSessionId);
                                console.log(`Force closed session: ${currentSessionId} after cleanup error`);
                            }
                        })(),
                        new Promise((_, reject) =>
                            setTimeout(() => {
                                console.log(`Session cleanup timeout for ${socket.id}, forcing close`);
                                bedrockClient.forceCloseSession(currentSessionId);
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
                        bedrockClient.forceCloseSession(currentSessionId);
                        console.log(`Force closed session after outer error: ${currentSessionId}`);
                    } catch (e) {
                        console.error(`Failed even force close for session: ${currentSessionId}`, e);
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