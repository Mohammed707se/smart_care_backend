import WebSocket from "ws";

const OPENAI_API_KEY = process.env.OPENAI_API_KEY;

export function getOpenaiWebsocketInstance() {
    return new WebSocket(
        "wss://api.openai.com/v1/realtime?model=gpt-4o-realtime-preview-2024-10-01",
        {
            headers: {
                Authorization: `Bearer ${OPENAI_API_KEY}`,
                "OpenAI-Beta": "realtime=v1",
            },
        },
    );
}

export const SYSTEM_MESSAGE = `
Role: You are an AI assistant for the Smart Care system in residential communities. Your primary role is to assist residents in reporting problems, particularly maintenance issues, by asking clear and relevant questions to gather all necessary details.

Interaction Flow:

1. *Initial Inquiry:*
   - Bot Question: "Can you please describe the issue you are experiencing?"

2. *Follow-Up for Specifics:*
   - Bot Question: "Is the [specific problem item] currently working or not?"
   - Bot Question: "Can you tell me if there is any visible damage or other important details we should know?"

3. *Confirmation:*
   - Bot Question: "Thank you for the details. To confirm, your issue is [briefly summarize the problem]. Is this correct?"

4. *Additional Assistance:*
   - Bot Question: "Is there anything else I can assist you with?"

5. *Closing the Interaction:*
   - If the resident responds they have no further issues:
     Bot Question: "Okay, thank you for contacting us. Have a nice day!"

Tone:
- Friendly, empathetic, and professional.
- Keep the conversation clear and easy to follow.

Purpose:
- Gather accurate and detailed information about the resident’s problem.
- Provide reassurance and acknowledgment that their issue will be addressed.
- Ensure a positive and polite conclusion to the conversation.
`;
export const VOICE = "echo";

// List of Event Types to log to the console
export const LOG_EVENT_TYPES = [
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

export async function sendSessionUpdate(connection) {
    const sessionUpdate = {
        type: "session.update",
        session: {
            turn_detection: { type: "server_vad" },
            input_audio_format: "g711_ulaw",
            output_audio_format: "g711_ulaw",
            voice: VOICE,
            instructions: SYSTEM_MESSAGE,
            modalities: ["text", "audio"],
            temperature: 0.8,
            input_audio_transcription: {
                model: "whisper-1",
            },
        },
    };
    console.log("Sending session update:", JSON.stringify(sessionUpdate));
    connection.send(JSON.stringify(sessionUpdate));
}

// Function to make ChatGPT API completion call with structured outputs
async function makeChatGPTCompletion(transcript) {
    console.log("Starting ChatGPT API call...");
    try {
        const response = await fetch(
            "https://api.openai.com/v1/chat/completions",
            {
                method: "POST",
                headers: {
                    Authorization: `Bearer ${OPENAI_API_KEY}`,
                    "Content-Type": "application/json",
                },
                body: JSON.stringify({
                    model: "gpt-4o-2024-08-06",
                    messages: [
                        {
                            role: "system",
                            content: `
                            Extract the following details from the transcript:
                            1. Resident's name.
                            2. Problem description (e.g., maintenance issue or                                         emergency).
                            3. Preferred timing for assistance.
                            
Today's date is ${new Date().toLocaleString()}.
Format the timing in ISO 8601 format. Ensure the problem description is concise and clear.`,
                        },
                        { role: "user", content: transcript },
                    ],
                    response_format: {
                        type: "json_schema",
                        json_schema: {
                            name: "resident_details_extraction",
                            schema: {
                                type: "object",
                                properties: {
                                    residentName: { type: "string" },
                                    problemDescription: { type: "string" },
                                    preferredServiceTime: { type: "string" },
                                },
                                required: [
                                    "residentName",
                                    "problemDescription",
                                    "preferredServiceTime",
                                ],
                            },
                        },
                    },
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

// Function to send data to a webhook
async function sendToWebhook(url, payload) {
    console.log("Sending data to webhook:", JSON.stringify(payload, null, 2));
    try {
        const response = await fetch(url, {
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

// Main function to process transcript and send extracted details
export async function processTranscriptAndSend(
    transcript,
    url,
    sessionId = null,
) {
    console.log(`Starting transcript processing for session ${sessionId}...`);
    try {
        // Make the ChatGPT completion call
        const result = await makeChatGPTCompletion(transcript);

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
                    await sendToWebhook(url, parsedContent);
                    console.log(
                        "Extracted and sent resident details:",
                        parsedContent,
                    );
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
