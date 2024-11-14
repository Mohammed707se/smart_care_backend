import Fastify from "fastify";
import WebSocket from "ws";
import fastifyFormBody from "@fastify/formbody";
import fastifyWs from "@fastify/websocket";
import {
  getOpenaiWebsocketInstance,
  sendSessionUpdate,
  LOG_EVENT_TYPES,
  processTranscriptAndSend,
} from "./openai.service.js";
import twilio from "twilio";
import dotenv from "dotenv";

// Load environment variables from .env file
dotenv.config();

// Constants
const PORT = process.env.PORT || 3000;
// Retrieve the OpenAI and Twilio API keys from environment variables
const {
  OPENAI_API_KEY,
  WEBHOOK_URL,
  TWILIO_ACCOUNT_SID,
  TWILIO_AUTH_TOKEN,
  TWILIO_PHONE_NUMBER,
} = process.env;

if (!OPENAI_API_KEY) {
  console.error("Missing OpenAI API key. Please set it in the .env file.");
  process.exit(1);
}

if (!TWILIO_ACCOUNT_SID || !TWILIO_AUTH_TOKEN || !TWILIO_PHONE_NUMBER) {
  console.error(
    "Missing Twilio credentials. Please set TWILIO_ACCOUNT_SID, TWILIO_AUTH_TOKEN, and TWILIO_PHONE_NUMBER in the .env file."
  );
  process.exit(1);
}

// Initialize Twilio client
const twilioClient = twilio(TWILIO_ACCOUNT_SID, TWILIO_AUTH_TOKEN);

// Initialize Fastify
const fastify = Fastify();
fastify.register(fastifyFormBody);
fastify.register(fastifyWs);

// Session management
const sessions = new Map();

// Root Route
fastify.get("/", async (request, reply) => {
  reply.send({ message: "Smart Care Media Stream Server is running!" });
});

// Route for Twilio to handle incoming and outgoing calls
fastify.all("/incoming-call", async (req, res) => {
  console.log("📲 Incoming call");
  res.type("text/xml").send(`<?xml version="1.0" encoding="UTF-8"?>
<Response>
    <Say> Smart Care system. How can we assist you today? </Say>
    <Connect>
        <Stream url="wss://${req.headers.host}/media-stream" />
    </Connect>
</Response>`);
});

// WebSocket route for media-stream
fastify.register(async (fastify) => {
  fastify.get("/media-stream", { websocket: true }, (connection, req) => {
    const sessionId = req.headers["x-twilio-call-sid"] || `session_${Date.now()}`;
    let session = sessions.get(sessionId) || {
      transcript: "",
      streamSid: null,
    };
    sessions.set(sessionId, session);

    // Get an instance of the OpenAI WebSocket
    const openAiWs = getOpenaiWebsocketInstance();

    // Open event for OpenAI WebSocket
    openAiWs.on("open", () => {
      console.log("🖇️ Connected to the OpenAI Realtime API");
      setTimeout(async () => {
        await sendSessionUpdate(openAiWs);
      }, 250);
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
          console.log(`User (${sessionId}): ${userMessage}`);
        }

        // Agent message handling
        if (response.type === "response.done") {
          const agentMessage =
            response.response.output[0]?.content?.find(
              (content) => content.transcript
            )?.transcript || "Agent message not found";
          session.transcript += `Agent: ${agentMessage}\n`;
          console.log(`Agent (${sessionId}): ${agentMessage}`);
        }

        if (response.type === "session.updated") {
          console.log("Session updated successfully:", response);
        }

        if (response.type === "response.audio.delta" && response.delta) {
          const audioDelta = {
            event: "media",
            streamSid: session.streamSid,
            media: {
              payload: Buffer.from(response.delta, "base64").toString("base64"),
            },
          };
          connection.send(JSON.stringify(audioDelta));
        }
      } catch (error) {
        console.error(
          "❗️ Error processing OpenAI message:",
          error,
          "Raw message:",
          data
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
            console.log("Incoming stream has started", session.streamSid);
            break;
          default:
            console.log("Received non-media event:", data.event);
            break;
        }
      } catch (error) {
        console.error("❗️ Error parsing message:", error, "Message:", message);
      }
    });

    // Handle connection close and log transcript
    connection.on("close", async () => {
      if (openAiWs.readyState === WebSocket.OPEN) {
        openAiWs.close();
      }
      console.log(`Client disconnected (${sessionId}).`);
      console.log("=========================");
      console.log("📋 ===Full Transcript===");
      console.log(session.transcript);
      console.log("=========================");

      // Process the transcript and send it to the webhook
      await processTranscriptAndSend(
        session.transcript,
        WEBHOOK_URL,
        sessionId
      );

      // Clean up the session
      sessions.delete(sessionId);
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

// New Endpoint to Initiate Outbound Calls
fastify.post("/make-call", async (request, reply) => {
  const { to } = request.body;

  if (!to) {
    return reply
      .status(400)
      .send({ error: "Missing 'to' phone number in request body." });
  }

  try {
    const call = await twilioClient.calls.create({
      url: `${WEBHOOK_URL}/incoming-call`, // Twilio will request this URL when the call is answered
      to: to,
      from: TWILIO_PHONE_NUMBER,
      // Optionally, you can add other parameters here
    });

    console.log(`Initiated call to ${to}. Call SID: ${call.sid}`);
    return reply.send({
      message: `Call initiated to ${to}`,
      callSid: call.sid,
    });
  } catch (error) {
    console.error("❗️ Error initiating call:", error);
    return reply.status(500).send({ error: "Failed to initiate call." });
  }
});

fastify.listen({ port: PORT, host: '0.0.0.0' }, (err, address) => {
  if (err) {
    console.error("Error starting server:", err);
    process.exit(1);
  }
  console.log(`Server is listening on ${address}`);
});
