import { AudioPlayer } from './lib/play/AudioPlayer.js';
import { ChatHistoryManager } from "./lib/util/ChatHistoryManager.js";

// Connect to the server
const socket = io();

// DOM elements
const startButton = document.getElementById('start');
const stopButton = document.getElementById('stop');
const statusElement = document.getElementById('status');
const sessionIdElement = document.getElementById('session-id');
const chatContainer = document.getElementById('chat-container');
const reinitButton = document.getElementById('reinitialize');
const reinitTimeDisplay = document.getElementById('reinit-time');

// Chat history management
let chat = { history: [] };
const chatRef = { current: chat };
const chatHistoryManager = ChatHistoryManager.getInstance(
    chatRef,
    (newChat) => {
        chat = { ...newChat };
        chatRef.current = chat;
        updateChatUI();
    }
);

// Audio processing variables
let audioContext;
let audioStream;
let isStreaming = false;
let processor;
let sourceNode;
let waitingForAssistantResponse = false;
let waitingForUserTranscription = false;
let userThinkingIndicator = null;
let assistantThinkingIndicator = null;
let transcriptionReceived = false;
let displayAssistantText = false;
let role;
const audioPlayer = new AudioPlayer();
let sessionInitialized = false;

// Track if background reinitialization is in progress
let isBackgroundReinitializing = false;
let newSessionId = null;
let currentAssistantResponseComplete = false;
let oldSessionId = null;
let isAudioBufferEmpty = false;
let hasStartedReinitialization = false;
let lastReinitializationTime = 0;  // Track when we last reinitialized
const REINITIALIZATION_COOLDOWN = 10000;  // 10 seconds cooldown

// Initialize WebSocket audio
async function initAudio() {
    try {
        statusElement.textContent = "Requesting microphone access...";
        statusElement.className = "connecting";

        // Request microphone access
        audioStream = await navigator.mediaDevices.getUserMedia({
            audio: {
                echoCancellation: true,
                noiseSuppression: true,
                autoGainControl: true
            }
        });

        audioContext = new AudioContext({
            sampleRate: 16000
        });

        await audioPlayer.start();
        
        // Add buffer empty listener
        audioPlayer.addEventListener("onBufferEmpty", () => {
            isAudioBufferEmpty = true;
            if (isBackgroundReinitializing && newSessionId && currentAssistantResponseComplete) {
                switchToNewSession();
            }
        });

        statusElement.textContent = "Microphone ready. Click Start to begin.";
        statusElement.className = "ready";
        startButton.disabled = false;
    } catch (error) {
        console.error("Error accessing microphone:", error);
        statusElement.textContent = "Error: " + error.message;
        statusElement.className = "error";
    }
}

// Initialize the session with Bedrock
async function initializeSession() {
    if (sessionInitialized) return;

    statusElement.textContent = "Initializing session...";

    try {
        // Send events in sequence with delays between each step
        console.log("Sending promptStart");
        socket.emit('promptStart');
        
        // Wait for the prompt to be set up properly
        // await new Promise(resolve => setTimeout(resolve, 300));
        
        console.log("Sending systemPrompt");
        socket.emit('systemPrompt');
        
        // Wait for the system prompt to be processed
        // await new Promise(resolve => setTimeout(resolve, 300));
        
        // Send conversation history with conversationResumption
        console.log("Sending conversationResumption with history");
        socket.emit('conversationResumption', chat.history);
        
        console.log("Sending audioStart");
        socket.emit('audioStart');

        // Mark session as initialized
        sessionInitialized = true;
        statusElement.textContent = "Session initialized successfully";
    } catch (error) {
        console.error("Failed to initialize session:", error);
        statusElement.textContent = "Error initializing session";
        statusElement.className = "error";
    }
}

async function startStreaming() {
    if (isStreaming) return;

    try {
        // First, make sure the session is initialized
        if (!sessionInitialized) {
            await initializeSession();
        }

        // Create audio processor
        sourceNode = audioContext.createMediaStreamSource(audioStream);

        // Use ScriptProcessorNode for audio processing
        if (audioContext.createScriptProcessor) {
            processor = audioContext.createScriptProcessor(512, 1, 1);

            processor.onaudioprocess = (e) => {
                if (!isStreaming) return;

                const inputData = e.inputBuffer.getChannelData(0);

                // Convert to 16-bit PCM
                const pcmData = new Int16Array(inputData.length);
                for (let i = 0; i < inputData.length; i++) {
                    pcmData[i] = Math.max(-1, Math.min(1, inputData[i])) * 0x7FFF;
                }

                // Convert to base64 (browser-safe way)
                const base64Data = arrayBufferToBase64(pcmData.buffer);

                // Send to server
                socket.emit('audioInput', base64Data);
            };

            sourceNode.connect(processor);
            processor.connect(audioContext.destination);
        }

        isStreaming = true;
        startButton.disabled = true;
        stopButton.disabled = false;
        statusElement.textContent = "Streaming... Speak now";
        statusElement.className = "recording";

        // Show user thinking indicator when starting to record
        transcriptionReceived = false;
        showUserThinkingIndicator();

    } catch (error) {
        console.error("Error starting recording:", error);
        statusElement.textContent = "Error: " + error.message;
        statusElement.className = "error";
    }
}

// Convert ArrayBuffer to base64 string
function arrayBufferToBase64(buffer) {
    const binary = [];
    const bytes = new Uint8Array(buffer);
    for (let i = 0; i < bytes.byteLength; i++) {
        binary.push(String.fromCharCode(bytes[i]));
    }
    return btoa(binary.join(''));
}

function stopStreaming() {
    if (!isStreaming) return;

    isStreaming = false;

    // Clean up audio processing
    if (processor) {
        processor.disconnect();
        sourceNode.disconnect();
    }

    startButton.disabled = false;
    stopButton.disabled = true;
    statusElement.textContent = "Processing...";
    statusElement.className = "processing";

    audioPlayer.stop();
    // Tell server to finalize processing
    socket.emit('stopAudio');

    // End the current turn in chat history
    chatHistoryManager.endTurn();
}

// Base64 to Float32Array conversion
function base64ToFloat32Array(base64String) {
    try {
        const binaryString = window.atob(base64String);
        const bytes = new Uint8Array(binaryString.length);
        for (let i = 0; i < binaryString.length; i++) {
            bytes[i] = binaryString.charCodeAt(i);
        }

        const int16Array = new Int16Array(bytes.buffer);
        const float32Array = new Float32Array(int16Array.length);
        for (let i = 0; i < int16Array.length; i++) {
            float32Array[i] = int16Array[i] / 32768.0;
        }

        return float32Array;
    } catch (error) {
        console.error('Error in base64ToFloat32Array:', error);
        throw error;
    }
}

// Process message data and add to chat history
function handleTextOutput(data) {
    console.log("Processing text output:", data);
    if (data.content) {
        const messageData = {
            role: data.role,
            message: data.content
        };
        chatHistoryManager.addTextMessage(messageData);
    }
}

// Update the UI based on the current chat history
function updateChatUI() {
    if (!chatContainer) {
        console.error("Chat container not found");
        return;
    }

    // Clear existing chat messages
    chatContainer.innerHTML = '';

    // Add all messages from history
    chat.history.forEach(item => {
        if (item.endOfConversation) {
            const endDiv = document.createElement('div');
            endDiv.className = 'message system';
            endDiv.textContent = "Conversation ended";
            chatContainer.appendChild(endDiv);
            return;
        }

        if (item.role) {
            const messageDiv = document.createElement('div');
            const roleLowerCase = item.role.toLowerCase();
            messageDiv.className = `message ${roleLowerCase}`;

            const roleLabel = document.createElement('div');
            roleLabel.className = 'role-label';
            roleLabel.textContent = item.role;
            messageDiv.appendChild(roleLabel);

            const content = document.createElement('div');
            content.textContent = item.message || "No content";
            messageDiv.appendChild(content);

            chatContainer.appendChild(messageDiv);
        }
    });

    // Re-add thinking indicators if we're still waiting
    if (waitingForUserTranscription) {
        showUserThinkingIndicator();
    }

    if (waitingForAssistantResponse) {
        showAssistantThinkingIndicator();
    }

    // Scroll to bottom
    chatContainer.scrollTop = chatContainer.scrollHeight;
}

// Show the "Listening" indicator for user
function showUserThinkingIndicator() {
    hideUserThinkingIndicator();

    waitingForUserTranscription = true;
    userThinkingIndicator = document.createElement('div');
    userThinkingIndicator.className = 'message user thinking';

    const roleLabel = document.createElement('div');
    roleLabel.className = 'role-label';
    roleLabel.textContent = 'USER';
    userThinkingIndicator.appendChild(roleLabel);

    const listeningText = document.createElement('div');
    listeningText.className = 'thinking-text';
    listeningText.textContent = 'Listening';
    userThinkingIndicator.appendChild(listeningText);

    const dotContainer = document.createElement('div');
    dotContainer.className = 'thinking-dots';

    for (let i = 0; i < 3; i++) {
        const dot = document.createElement('span');
        dot.className = 'dot';
        dotContainer.appendChild(dot);
    }

    userThinkingIndicator.appendChild(dotContainer);
    chatContainer.appendChild(userThinkingIndicator);
    chatContainer.scrollTop = chatContainer.scrollHeight;
}

// Show the "Thinking" indicator for assistant
function showAssistantThinkingIndicator() {
    hideAssistantThinkingIndicator();

    waitingForAssistantResponse = true;
    assistantThinkingIndicator = document.createElement('div');
    assistantThinkingIndicator.className = 'message assistant thinking';

    const roleLabel = document.createElement('div');
    roleLabel.className = 'role-label';
    roleLabel.textContent = 'ASSISTANT';
    assistantThinkingIndicator.appendChild(roleLabel);

    const thinkingText = document.createElement('div');
    thinkingText.className = 'thinking-text';
    thinkingText.textContent = 'Thinking';
    assistantThinkingIndicator.appendChild(thinkingText);

    const dotContainer = document.createElement('div');
    dotContainer.className = 'thinking-dots';

    for (let i = 0; i < 3; i++) {
        const dot = document.createElement('span');
        dot.className = 'dot';
        dotContainer.appendChild(dot);
    }

    assistantThinkingIndicator.appendChild(dotContainer);
    chatContainer.appendChild(assistantThinkingIndicator);
    chatContainer.scrollTop = chatContainer.scrollHeight;
}

// Hide the user thinking indicator
function hideUserThinkingIndicator() {
    waitingForUserTranscription = false;
    if (userThinkingIndicator && userThinkingIndicator.parentNode) {
        userThinkingIndicator.parentNode.removeChild(userThinkingIndicator);
    }
    userThinkingIndicator = null;
}

// Hide the assistant thinking indicator
function hideAssistantThinkingIndicator() {
    waitingForAssistantResponse = false;
    if (assistantThinkingIndicator && assistantThinkingIndicator.parentNode) {
        assistantThinkingIndicator.parentNode.removeChild(assistantThinkingIndicator);
    }
    assistantThinkingIndicator = null;
}

// EVENT HANDLERS
// --------------

// Handle content start from the server
socket.on('contentStart', (data) => {
    console.log('Content start received:', data);

    if (data.type === 'TEXT') {
        role = data.role;
        if (data.role === 'USER') {
            hideUserThinkingIndicator();
            // Reset reinitialization flags when user starts speaking
            hasStartedReinitialization = false;
        }
        else if (data.role === 'ASSISTANT') {
            hideAssistantThinkingIndicator();
            let isSpeculative = false;
            try {
                if (data.additionalModelFields) {
                    const additionalFields = JSON.parse(data.additionalModelFields);
                    isSpeculative = additionalFields.generationStage === "SPECULATIVE";
                    if (isSpeculative) {
                        console.log("Received speculative content");
                        displayAssistantText = true;
                    }
                    else {
                        displayAssistantText = false;
                    }
                }
            } catch (e) {
                console.error("Error parsing additionalModelFields:", e);
            }

            // Check if enough time has passed since last reinitialization
            const now = Date.now();
            const timeSinceLastReinit = now - lastReinitializationTime;
            
            // Start background reinitialization only if:
            // 1. Not already reinitializing
            // 2. Haven't started reinitialization for this response
            // 3. Enough time has passed since last reinitialization
            if (!isBackgroundReinitializing && !hasStartedReinitialization && timeSinceLastReinit >= REINITIALIZATION_COOLDOWN) {
                console.log(`Starting background reinitialization (${timeSinceLastReinit}ms since last reinit)`);
                currentAssistantResponseComplete = false;
                isAudioBufferEmpty = false;
                oldSessionId = sessionIdElement.textContent;
                hasStartedReinitialization = true;
                lastReinitializationTime = now;
                startBackgroundReinitialization();
            } else {
                console.log(`Skipping reinitialization: inProgress=${isBackgroundReinitializing}, hasStarted=${hasStartedReinitialization}, timeSinceLast=${timeSinceLastReinit}ms`);
            }
        }
    }
    else if (data.type === 'AUDIO') {
        if (isStreaming) {
            showUserThinkingIndicator();
        }
    }
});

// Handle text output from the server
socket.on('textOutput', (data) => {
    console.log('Received text output:', data);

    if (role === 'USER') {
        // When user text is received, show thinking indicator for assistant response
        transcriptionReceived = true;
        //hideUserThinkingIndicator();

        // Add user message to chat
        handleTextOutput({
            role: data.role,
            content: data.content
        });

        // Show assistant thinking indicator after user text appears
        showAssistantThinkingIndicator();
    }
    else if (role === 'ASSISTANT') {
        //hideAssistantThinkingIndicator();
        if (displayAssistantText) {
            handleTextOutput({
                role: data.role,
                content: data.content
            });
        }
    }
});

// Handle audio output
socket.on('audioOutput', (data) => {
    if (data.content) {
        try {
            const audioData = base64ToFloat32Array(data.content);
            audioPlayer.playAudio(audioData);
            isAudioBufferEmpty = false;
        } catch (error) {
            console.error('Error processing audio data:', error);
        }
    }
});

// Handle content end events
socket.on('contentEnd', (data) => {
    console.log('Content end received:', data);

    if (data.type === 'TEXT') {
        if (role === 'USER') {
            hideUserThinkingIndicator();
            showAssistantThinkingIndicator();
        }
        else if (role === 'ASSISTANT') {
            hideAssistantThinkingIndicator();
            
            // Mark current assistant response as complete
            currentAssistantResponseComplete = true;
            
            // If we have a new session ready and the current response is complete, prepare for switch
            if (isBackgroundReinitializing && newSessionId && currentAssistantResponseComplete) {
                // Wait for audio buffer to be empty before switching
                checkAudioBufferAndSwitch();
            }
        }

        if (data.stopReason && data.stopReason.toUpperCase() === 'END_TURN') {
            chatHistoryManager.endTurn();
        } else if (data.stopReason && data.stopReason.toUpperCase() === 'INTERRUPTED') {
            console.log("Interrupted by user");
            audioPlayer.bargeIn();
        }
    }
    else if (data.type === 'AUDIO') {
        if (isStreaming) {
            showUserThinkingIndicator();
        }
    }
});

// Stream completion event
socket.on('streamComplete', () => {
    if (isStreaming) {
        stopStreaming();
    }
    statusElement.textContent = "Ready";
    statusElement.className = "ready";
});

// Handle session ID updates
socket.on('sessionId', (data) => {
    console.log('Session ID updated:', data.sessionId);
    sessionIdElement.textContent = data.sessionId;
});

// Handle connection status updates
socket.on('connect', async () => {
    statusElement.textContent = "Connected to server, initializing...";
    statusElement.className = "connecting";
    sessionInitialized = false;
    
    try {
        // Wait a moment before starting initialization
        
        // Reinitialize the audio system if this is a reconnection
        if (window.reconnectStartTime) {
            console.log("Reconnection detected, reinitializing audio system");
            
            // Make sure audio context is running
            if (audioContext && audioContext.state !== "running") {
                await audioContext.resume();
                console.log("Audio context resumed");
            }
            
            // Restart audio player if needed
            if (audioPlayer) {
                await audioPlayer.start();
                console.log("Audio player restarted");
            }
            
            // If we lost the audio stream, try to get it again
            if (!audioStream) {
                try {
                    audioStream = await navigator.mediaDevices.getUserMedia({
                        audio: {
                            echoCancellation: true,
                            noiseSuppression: true,
                            autoGainControl: true
                        }
                    });
                    console.log("Microphone access regained");
                } catch (micError) {
                    console.error("Error re-accessing microphone:", micError);
                }
            }
        }
        
        // Initialize the session with proper sequencing
        await initializeSession();
        
        // Update status
        statusElement.textContent = "Connected and initialized";
        statusElement.className = "connected";
        
        // If this is a reconnection from the reinitialize button, calculate the time and auto-start streaming
        if (window.reconnectStartTime) {
            const reconnectTime = Date.now() - window.reconnectStartTime;
            reinitTimeDisplay.textContent = `Reinitialization took ${reconnectTime}ms`;
            reinitButton.disabled = false;
            window.reconnectStartTime = null; // Clear the timestamp
            
            // Automatically start streaming
            console.log("Auto-starting streaming after reinitialization");
            await startStreaming();
        } else {
            // Normal connection, just enable the start button
            startButton.disabled = false;
        }
    } catch (error) {
        console.error("Error during initialization after connect:", error);
        statusElement.textContent = "Error initializing session";
        statusElement.className = "error";
        
        // Make sure reinitialize button is enabled even if there's an error
        if (window.reconnectStartTime) {
            reinitButton.disabled = false;
            window.reconnectStartTime = null;
        }
    }
});

socket.on('disconnect', () => {
    statusElement.textContent = "Disconnected from server";
    statusElement.className = "disconnected";
    sessionIdElement.textContent = "-";
    startButton.disabled = true;
    stopButton.disabled = true;
    sessionInitialized = false;
    hideUserThinkingIndicator();
    hideAssistantThinkingIndicator();
});

// Handle errors
socket.on('error', (error) => {
    console.error("Server error:", error);
    statusElement.textContent = "Error: " + (error.message || JSON.stringify(error).substring(0, 100));
    statusElement.className = "error";
    hideUserThinkingIndicator();
    hideAssistantThinkingIndicator();
});

// Check audio buffer and switch sessions if empty
function checkAudioBufferAndSwitch() {
    if (isAudioBufferEmpty) {
        switchToNewSession();
    } else {
        // Check again after a short delay
        setTimeout(checkAudioBufferAndSwitch, 100);
    }
}

// Start background reinitialization
async function startBackgroundReinitialization() {
    if (isBackgroundReinitializing) {
        console.log("Background reinitialization already in progress, skipping");
        return;
    }
    
    console.log("Starting background reinitialization");
    isBackgroundReinitializing = true;
    newSessionId = null;

    try {
        // Request background session reinitialization with a different event name
        console.log("Requesting background session reinitialization");
        socket.emit('backgroundReinitializeSession');
        
        // Wait for reinitialization to complete
        await new Promise((resolve) => {
            socket.once('backgroundSessionReinitialized', (data) => {
                console.log("New background session created with ID:", data.newSessionId);
                newSessionId = data.newSessionId;
                resolve();
            });
        });
        
        // Wait a moment for the server to set up the new session
        await new Promise(resolve => setTimeout(resolve, 500));
        
        // Initialize the new session with background-specific events
        console.log("Initializing new background session");
        socket.emit('backgroundPromptStart');
        await new Promise(resolve => setTimeout(resolve, 300));
        
        socket.emit('backgroundSystemPrompt');
        await new Promise(resolve => setTimeout(resolve, 300));
        
        socket.emit('backgroundConversationResumption', chat.history);
        await new Promise(resolve => setTimeout(resolve, 300));
        
        socket.emit('backgroundAudioStart');
        await new Promise(resolve => setTimeout(resolve, 500));
        
        console.log("Background reinitialization complete");
    } catch (error) {
        console.error("Error during background reinitialization:", error);
        isBackgroundReinitializing = false;
        newSessionId = null;
        hasStartedReinitialization = false;
        lastReinitializationTime = 0;  // Reset the timer on error
    }
}

// Switch to the new session
async function switchToNewSession() {
    if (!newSessionId || !currentAssistantResponseComplete) {
        console.log("Cannot switch sessions - newSessionId:", newSessionId, "currentAssistantResponseComplete:", currentAssistantResponseComplete);
        return;
    }
    
    console.log("Switching to new background session:", newSessionId);
    
    try {
        // Update session ID display
        sessionIdElement.textContent = newSessionId;
        
        // Reset state
        isBackgroundReinitializing = false;
        newSessionId = null;
        currentAssistantResponseComplete = false;
        oldSessionId = null;
        isAudioBufferEmpty = false;
        hasStartedReinitialization = false;
        
        // Start streaming with new session
        if (!isStreaming) {
            await startStreaming();
        }
    } catch (error) {
        console.error("Error switching to new background session:", error);
        isBackgroundReinitializing = false;
        newSessionId = null;
        currentAssistantResponseComplete = false;
        oldSessionId = null;
        isAudioBufferEmpty = false;
        hasStartedReinitialization = false;
        lastReinitializationTime = 0;  // Reset the timer on error
    }
}

async function reinitializeSession() {
    if (isStreaming) {
        stopStreaming();
    }
    
    statusElement.textContent = "Reinitializing session...";
    statusElement.className = "connecting";
    
    // Reset session state
    sessionInitialized = false;
    
    // Reset audio-related variables
    if (processor) {
        try {
            processor.disconnect();
        } catch (e) {
            console.log("Error disconnecting processor:", e);
        }
        processor = null;
    }
    
    if (sourceNode) {
        try {
            sourceNode.disconnect();
        } catch (e) {
            console.log("Error disconnecting source node:", e);
        }
        sourceNode = null;
    }
    
    // Stop audio player
    audioPlayer.stop();
    
    // Track start time
    const startTime = Date.now();
    window.reconnectStartTime = startTime;
    
    // Display the button as disabled during reinitialization
    reinitButton.disabled = true;
    
    try {
        // First step: Send stopAudio to properly clean up any active audio
        console.log("Sending stopAudio to clean up active streams");
        // socket.emit('stopAudio');
        
        // Wait for cleanup
        await new Promise(resolve => setTimeout(resolve, 500));
        
        // Request session reinitialization (LLM session only)
        console.log("Requesting LLM session reinitialization");
        socket.emit('reinitializeSession');
        
        // Wait for reinitialization to complete
        await new Promise((resolve) => {
            socket.once('sessionReinitialized', (data) => {
                console.log("LLM session reinitialized with new ID:", data.newSessionId);                
                resolve();
            });
        });
        
        // Wait a moment for the server to set up the new session
        // await new Promise(resolve => setTimeout(resolve, 500));
        
        // Re-send system prompt and chat history, then continue as normal
        console.log("Sending promptStart");
        socket.emit('promptStart');
        await new Promise(resolve => setTimeout(resolve, 300));
        
        console.log("Sending systemPrompt");
        socket.emit('systemPrompt');
        await new Promise(resolve => setTimeout(resolve, 300));
        
        console.log("Sending conversationResumption with history");
        socket.emit('conversationResumption', chat.history);
        await new Promise(resolve => setTimeout(resolve, 300));
        
        console.log("Sending audioStart");
        socket.emit('audioStart');

        sessionInitialized = true;
        
        // Calculate and display reinitialization time
        const reconnectTime = Date.now() - startTime;
        reinitTimeDisplay.textContent = `Reinitialization took ${reconnectTime}ms`;
        reinitButton.disabled = false;
        window.reconnectStartTime = null;
        
        // Auto-start streaming
        console.log("Auto-starting streaming after reinitialization");
        await audioPlayer.start();
        await startStreaming();
        
    } catch (error) {
        console.error("Error during reinitialization:", error);
        statusElement.textContent = "Error reinitializing session, please try again";
        statusElement.className = "error";
        reinitButton.disabled = false;
    }
}

// Button event listeners
startButton.addEventListener('click', startStreaming);
stopButton.addEventListener('click', stopStreaming);
reinitButton.addEventListener('click', reinitializeSession);

// Initialize the app when the page loads
document.addEventListener('DOMContentLoaded', initAudio);
document.addEventListener('DOMContentLoaded', initAudio);