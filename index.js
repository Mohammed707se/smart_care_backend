import Fastify from "fastify";
import WebSocket from "ws";
import fs from "fs";
import dotenv from "dotenv";
import fastifyFormBody from "@fastify/formbody";
import fastifyWs from "@fastify/websocket";
import fetch from "node-fetch";
import Twilio from "twilio"; // Import Twilio

// Load environment variables from .env file
dotenv.config();

// Retrieve the OpenAI and Twilio API keys from environment variables
const {
    OPENAI_API_KEY,
    TWILIO_ACCOUNT_SID,
    TWILIO_AUTH_TOKEN,
    TWILIO_PHONE_NUMBER,
} = process.env;

if (!OPENAI_API_KEY) {
    console.error("Missing OpenAI API key. Please set it in the .env file.");
    process.exit(1);
}

if (
    !TWILIO_ACCOUNT_SID ||
    !TWILIO_AUTH_TOKEN ||
    !TWILIO_PHONE_NUMBER
) {
    console.error(
        "Missing Twilio credentials. Please set TWILIO_ACCOUNT_SID, TWILIO_AUTH_TOKEN, and TWILIO_PHONE_NUMBER in the .env file."
    );
    process.exit(1);
}

// Initialize Twilio Client
const client = Twilio(TWILIO_ACCOUNT_SID, TWILIO_AUTH_TOKEN);

// Initialize Fastify
const fastify = Fastify();
fastify.register(fastifyFormBody);
fastify.register(fastifyWs);

// Constants
const AUDIO_FILE_URL = "https://smartcare.lisn-car.com/voice.mp3";
const PORT = process.env.PORT || 8000;
const WEBHOOK_URL = "<u1ymuynewav7ute5fao8my84s3a7lgh0@hook.eu2.make.com>";

// Session management
const sessions = new Map();

// List of Event Types to log to the console
const LOG_EVENT_TYPES = [
    "response.content.done",
    "rate_limits.updated",
    "response.done",
    "input_audio_buffer.committed",
    "input_audio_buffer.speech_stopped",
    "input_audio_buffer.speech_started",
    "session.created",
    "response.text.done",
    "conversation.item.input_audio_transcription.completed",
];

// Define system messages for both languages
const SYSTEM_MESSAGES = {
    EN: "You are an AI assistant for the Smart Care system in residential communities. Assist residents in reporting maintenance issues, accessing emergency services, and providing proactive solutions. Be concise, ask up to two questions, and upon completion say, 'Your request has been forwarded to the relevant department and we will contact you shortly. Do you need anything else?' If the user indicates no, end the call.",
    AR: "أنت مساعد ذكاء اصطناعي لنظام الرعاية الذكية في المجتمعات السكنية. ساعد السكان في الإبلاغ عن مشكلات الصيانة، الوصول إلى الخدمات الطارئة، وتقديم حلول استباقية. كن موجزًا، اطرح سؤالين كحد أقصى، وعند الانتهاء قل، 'تم رفع طلبك للجهة المختصة وسيتم التواصل معك في أقرب وقت. هل لديك شيء آخر؟' إذا أشار المستخدم إلى عدم الرغبة في المزيد، انهِ المكالمة.",
};

// Voice settings based on language
const VOICES = {
    EN: "alice", // Example English voice
    AR: "male" // Example Arabic voice, adjust as needed
};

// Root Route
fastify.get("/", async (request, reply) => {
    reply.send({ message: "Smart Care Media Stream Server is running!" });
});

// Route for Twilio to handle incoming calls
fastify.post("/incoming-call", async (request, reply) => {
    const twiml = `
        <?xml version="1.0" encoding="UTF-8"?>
        <Response>
            <Gather action="/handle-gather" method="POST" timeout="5" numDigits="1" numRetries="3">
                <Play>${AUDIO_FILE_URL}</Play>
                <Say>Please press 1 for Arabic or 2 for English.</Say>
            </Gather>
            <Say>We did not receive any input. Goodbye!</Say>
            <Hangup/>
        </Response>
    `;
    reply.type("text/xml").send(twiml);
});

// Route to handle Gather input
fastify.post("/handle-gather", async (request, reply) => {
    const digits = request.body.Digits;
    const callSid = request.body.CallSid;

    let language = "EN"; // Default language
    let systemMessage = SYSTEM_MESSAGES.EN;
    let voice = VOICES.EN;

    if (digits === "1") {
        language = "AR";
        systemMessage = SYSTEM_MESSAGES.AR;
        voice = VOICES.AR;
    } else if (digits === "2") {
        language = "EN";
        systemMessage = SYSTEM_MESSAGES.EN;
        voice = VOICES.EN;
    } else {
        // If invalid input, redirect back to /incoming-call to retry
        const twimlRetry = `
            <?xml version="1.0" encoding="UTF-8"?>
            <Response>
                <Gather action="/handle-gather" method="POST" timeout="5" numDigits="1" numRetries="3">
                    <Play>${AUDIO_FILE_URL}</Play>
                    <Say>Please press 1 for Arabic or 2 for English.</Say>
                </Gather>
                <Say>We did not receive any input. Goodbye!</Say>
                <Hangup/>
            </Response>
        `;
        reply.type("text/xml").send(twimlRetry);
        return;
    }

    // Store the language and system message in session based on CallSid
    sessions.set(callSid, {
        language,
        systemMessage,
        transcript: "",
        streamSid: null,
    });

    // Respond with TwiML to connect to media stream
    const twimlConnect = `
        <?xml version="1.0" encoding="UTF-8"?>
        <Response>
            <Connect>
                <Stream url="wss://${request.headers.host}/media-stream" />
            </Connect>
        </Response>
    `;
    reply.type("text/xml").send(twimlConnect);
});

// WebSocket route for media-stream
fastify.register(async (fastify) => {
    fastify.get("/media-stream", { websocket: true }, (connection, req) => {
        console.log("Client connected");

        // Extract CallSid from query parameters or headers
        const callSid = req.query.CallSid || req.headers["x-twilio-call-sid"];
        if (!callSid) {
            console.error("CallSid not found. Closing connection.");
            connection.close();
            return;
        }

        const session = sessions.get(callSid);
        if (!session) {
            console.error(`Session not found for CallSid: ${callSid}. Closing connection.`);
            connection.close();
            return;
        }

        const { language, systemMessage } = session;
        const voice = VOICES[language] || VOICES.EN;

        const openAiWs = new WebSocket(
            "wss://api.openai.com/v1/realtime?model=gpt-4o-realtime-preview-2024-10-01",
            {
                headers: {
                    Authorization: `Bearer ${OPENAI_API_KEY}`,
                    "OpenAI-Beta": "realtime=v1",
                },
            },
        );

        const sendSessionUpdate = () => {
            const sessionUpdate = {
                type: "session.update",
                session: {
                    turn_detection: { type: "server_vad" },
                    input_audio_format: "g711_ulaw",
                    output_audio_format: "g711_ulaw",
                    voice: voice,
                    instructions: systemMessage,
                    modalities: ["text", "audio"],
                    temperature: 0.8,
                    input_audio_transcription: {
                        model: "whisper-1",
                    },
                },
            };

            console.log(
                "Sending session update:",
                JSON.stringify(sessionUpdate),
            );
            openAiWs.send(JSON.stringify(sessionUpdate));
        };

        // Open event for OpenAI WebSocket
        openAiWs.on("open", () => {
            console.log("Connected to the OpenAI Realtime API");
            setTimeout(sendSessionUpdate, 250);
        });

        // Listen for messages from the OpenAI WebSocket
        openAiWs.on("message", (data) => {
            try {
                const response = JSON.parse(data);

                if (LOG_EVENT_TYPES.includes(response.type)) {
                    console.log(`Received event: ${response.type}`, response);
                }

                // User message transcription handling
                if (
                    response.type ===
                    "conversation.item.input_audio_transcription.completed"
                ) {
                    const userMessage = response.transcript.trim();
                    session.transcript += `User: ${userMessage}\n`;
                    console.log(`User (${callSid}): ${userMessage}`);
                }

                // Agent message handling
                if (response.type === "response.done") {
                    const agentMessage =
                        response.response.output[0]?.content?.find(
                            (content) => content.transcript,
                        )?.transcript || "Agent message not found";
                    session.transcript += `Agent: ${agentMessage}\n`;
                    console.log(`Agent (${callSid}): ${agentMessage}`);
                }

                if (response.type === "session.updated") {
                    console.log("Session updated successfully:", response);
                }

                if (
                    response.type === "response.audio.delta" &&
                    response.delta
                ) {
                    const audioDelta = {
                        event: "media",
                        streamSid: session.streamSid,
                        media: {
                            payload: Buffer.from(
                                response.delta,
                                "base64",
                            ).toString("base64"),
                        },
                    };
                    connection.send(JSON.stringify(audioDelta));
                }
            } catch (error) {
                console.error(
                    "Error processing OpenAI message:",
                    error,
                    "Raw message:",
                    data,
                );
            }
        });

        // Handle incoming messages from Twilio
        connection.on("message", (message) => {
            try {
                const data = JSON.parse(message);

                switch (data.event) {
                    case "media":
                        if (openAiWs.readyState === WebSocket.OPEN) {
                            const audioAppend = {
                                type: "input_audio_buffer.append",
                                audio: data.media.payload,
                            };

                            openAiWs.send(JSON.stringify(audioAppend));
                        }
                        break;
                    case "start":
                        session.streamSid = data.start.streamSid;
                        console.log(
                            "Incoming stream has started",
                            session.streamSid,
                        );
                        break;
                    default:
                        console.log("Received non-media event:", data.event);
                        break;
                }
            } catch (error) {
                console.error(
                    "Error parsing message:",
                    error,
                    "Message:",
                    message,
                );
            }
        });

        // Handle connection close and log transcript
        connection.on("close", async () => {
            if (openAiWs.readyState === WebSocket.OPEN) openAiWs.close();
            console.log(`Client disconnected (${callSid}).`);
            console.log("Full Transcript:");
            console.log(session.transcript);

            await processTranscriptAndSend(session.transcript, callSid, session.language);

            // Clean up the session
            sessions.delete(callSid);
        });

        // Handle WebSocket close and errors
        openAiWs.on("close", () => {
            console.log("Disconnected from the OpenAI Realtime API");
        });

        openAiWs.on("error", (error) => {
            console.error("Error in the OpenAI WebSocket:", error);
        });
    });
});

// Route to initiate a phone call
fastify.post('/make-call', async (request, reply) => {
    const { to } = request.body;

    if (!to) {
        return reply.status(400).send({ error: 'Missing "to" phone number in request body.' });
    }

    try {
        const call = await client.calls.create({
            url: `https://${request.headers.host}/incoming-call`, // TwiML URL for call instructions
            to: to,
            from: TWILIO_PHONE_NUMBER,
        });

        console.log(`Call initiated: SID ${call.sid} to ${to}`);
        return reply.send({ message: 'Call initiated successfully.', callSid: call.sid });
    } catch (error) {
        console.error('Error initiating call:', error);
        return reply.status(500).send({ error: 'Failed to initiate call.' });
    }
});

fastify.listen({ port: PORT, host: '0.0.0.0' }, (err, address) => {
    if (err) {
        console.error("Error starting server:", err);
        process.exit(1);
    }
    console.log(`Server is listening on ${address}`);
});


// Function to make ChatGPT API completion call with structured outputs
async function makeChatGPTCompletion(transcript, language) {
    console.log("Starting ChatGPT API call...");
    try {
        const systemPrompt = SYSTEM_MESSAGES[language] || SYSTEM_MESSAGES.EN;
        const response = await fetch(
            "https://api.openai.com/v1/chat/completions",
            {
                method: "POST",
                headers: {
                    Authorization: `Bearer ${OPENAI_API_KEY}`,
                    "Content-Type": "application/json",
                },
                body: JSON.stringify({
                    model: "gpt-4o-realtime-preview-2024-10-01",
                    messages: [
                        {
                            role: "system",
                            content: systemPrompt,
                        },
                        { role: "user", content: transcript },
                    ],
                    response_format: "json",
                }),
            },
        );

        console.log("ChatGPT API response status:", response.status);
        const data = await response.json();
        console.log(
            "Full ChatGPT API response:",
            JSON.stringify(data, null, 2),
        );
        return data;
    } catch (error) {
        console.error("Error making ChatGPT completion call:", error);
        throw error;
    }
}

// Function to send data to Make.com webhook
async function sendToWebhook(payload) {
    console.log("Sending data to webhook:", JSON.stringify(payload, null, 2));
    try {
        const response = await fetch(WEBHOOK_URL, {
            method: "POST",
            headers: {
                "Content-Type": "application/json",
            },
            body: JSON.stringify(payload),
        });

        console.log("Webhook response status:", response.status);
        if (response.ok) {
            console.log("Data successfully sent to webhook.");
        } else {
            console.error(
                "Failed to send data to webhook:",
                response.statusText,
            );
        }
    } catch (error) {
        console.error("Error sending data to webhook:", error);
    }
}

// Main function to extract and send resident details
async function processTranscriptAndSend(transcript, sessionId = null, language = "EN") {
    console.log(`Starting transcript processing for session ${sessionId}...`);
    try {
        // Make the ChatGPT completion call
        const result = await makeChatGPTCompletion(transcript, language);

        console.log(
            "Raw result from ChatGPT:",
            JSON.stringify(result, null, 2),
        );

        if (
            result.choices &&
            result.choices[0] &&
            result.choices[0].message &&
            result.choices[0].message.content
        ) {
            try {
                const parsedContent = JSON.parse(
                    result.choices[0].message.content,
                );
                console.log(
                    "Parsed content:",
                    JSON.stringify(parsedContent, null, 2),
                );

                if (parsedContent) {
                    // Send the parsed content directly to the webhook
                    await sendToWebhook(parsedContent);
                    console.log(
                        "Extracted and sent resident details:",
                        parsedContent,
                    );

                    // Optionally, you can add logic here to end the call if needed
                } else {
                    console.error(
                        "Unexpected JSON structure in ChatGPT response",
                    );
                }
            } catch (parseError) {
                console.error(
                    "Error parsing JSON from ChatGPT response:",
                    parseError,
                );
            }
        } else {
            console.error("Unexpected response structure from ChatGPT API");
        }
    } catch (error) {
        console.error("Error in processTranscriptAndSend:", error);
    }
}
