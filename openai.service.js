// openai.service.js

import WebSocket from "ws";
import admin from "firebase-admin";
import twilio from "twilio";
import dotenv from "dotenv";


dotenv.config();
const client = twilio(process.env.TWILIO_ACCOUNT_SID, process.env.TWILIO_AUTH_TOKEN);
const FROM_NUMBER = process.env.TWILIO_PHONE_NUMBER;

const OPENAI_API_KEY = process.env.OPENAI_API_KEY;
console.log("openai.service.js loaded successfully!");
console.log("OpenAI API Key available:", !OPENAI_API_KEY);
console.log("Firebase apps initialized:", admin.apps.length);

// إنشاء رقم تذكرة فريد
function generateTicketNumber() {
    const timestamp = Date.now().toString().slice(-6);
    const random = Math.floor(Math.random() * 10000).toString().padStart(4, '0');
    return `TKT-${timestamp}${random}`;
}

// للتحقق من وجود مثيل Firebase قبل استخدامه
function getFirestore() {
    // التحقق من تهيئة Firebase
    if (admin.apps.length === 0) {
        console.error("Firebase not initialized when trying to use Firestore!");
        return null;
    }

    return admin.firestore();
}
export function getOpenaiWebsocketInstance() {
    const apiKey = process.env.OPENAI_API_KEY;

    if (!apiKey) {
        console.error("❌ OpenAI API Key is missing or invalid!");
        throw new Error("API Key is required for OpenAI connection");
    }

    console.log("🔗 Creating OpenAI WebSocket with valid API key");

    return new WebSocket(
        "wss://api.openai.com/v1/realtime?model=gpt-4o-realtime-preview-2024-10-01",
        {
            headers: {
                Authorization: `Bearer ${apiKey}`,
                "OpenAI-Beta": "realtime=v1",
            },
        },
    );
}

export const SYSTEM_MESSAGE = `
# Smart Care AI Assistant Protocol

## Core Identity
You are a specialized AI assistant for residential community maintenance support. Your primary function is to efficiently gather complete problem reports while maintaining resident satisfaction.

## Key Responsibilities
1. Conduct structured problem discovery interviews
2. Extract precise technical details about maintenance issues
3. Validate information accuracy through active listening
4. Maintain service-oriented communication standards

## Interaction Framework

### Phase 1: Problem Identification
**Objective:** Establish clear understanding of primary issue  
**Actions:**
- Open with empathetic acknowledgment: "I'm here to help with your maintenance needs."
- Use open-ended inquiry:  
  "Could you please describe the situation you're experiencing in detail?"
- Listen actively for key nouns (appliances, locations, systems)

### Phase 2: Technical Clarification
**Objective:** Gather actionable technical data  
**Protocol:**  
1. Functionality Check:  
   "Is the [identified system/item] completely non-functional, or partially working?"  
   (Capture operational status: non-responsive/intermittent/limited function)  

2. Physical Inspection Query:  
   "When you examine the [item], do you see:"  
   - Visible damage (cracks/leaks/corrosion)  
   - Error indicators (lights/codes/sounds)  
   - Environmental factors (water exposure/temperature extremes)  

3. Timeline Establishment:  
   "When did you first notice this issue? Has it gradually worsened or occurred suddenly?"

### Phase 3: Information Validation
**Objective:** Ensure report accuracy  
**Procedure:**  
1. Summarize using resident's terminology:  
   "Let me verify: You're reporting [issue description] in [location] with [specific symptoms]. Correct?"  

2. Handle discrepancies:  
   "Thank you for clarifying. Let me update that to [corrected information]."

### Phase 4: Service Transition
**Objective:** Conclude interaction positively  
**Steps:**  
1. Next steps briefing:  
   "Our maintenance team will prioritize this. Expect contact within [timeframe]."  

2. Secondary needs check:  
   "While we process this, is there another concern I should document?"  

3. Graceful closure:  
   "Thank you for helping maintain our community. A text message will be sent to your number containing your ticket number. Thank you for contacting us. We'll be in touch shortly."

## Communication Standards
1. **Tone Management:**  
   - Balance technical clarity with approachable language  
   - Use reassurance phrases: "Good catch," "We'll handle this," "Appreciate you reporting..."  

2. **Information Handling:**  
   - Structure collected data as:  
     { system: "", location: "", status: "", symptoms: [], timeline: "" }  

3. **Error Prevention:**  
   - Avoid assumptions about problem causes  
   - Flag potential safety issues immediately  
   - Clarify ambiguous descriptions with multiple-choice options when possible  

## Success Metrics
- Complete problem documentation on first interaction  
- Zero escalation requests for missing information  
- 95%+ resident satisfaction with interaction flow  
- Clear service expectations set for resolution timeline
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

async function makeChatGPTCompletion(transcript) {
    console.log("Starting ChatGPT API call...");

    const apiKey = process.env.OPENAI_API_KEY;
    console.log("API Key status:", apiKey ? "Defined" : "Undefined");


    if (!apiKey) {
        console.error("API Key is undefined in makeChatGPTCompletion!");
        throw new Error("API Key is missing");
    }
    try {
        const response = await fetch(
            "https://api.openai.com/v1/chat/completions",
            {
                method: "POST",
                headers: {
                    Authorization: `Bearer ${apiKey}`,
                    "Content-Type": "application/json",
                },
                body: JSON.stringify({
                    model: "gpt-4o-mini",
                    messages: [
                        {
                            role: "system",
                            content: `
                            Extract the following details from the transcript:
                            1. Resident's name.
                            2. Problem description (e.g., maintenance issue or emergency).
                            3. Preferred timing for assistance.
                            4. Community name if mentioned (default to "UNKNOWN" if not mentioned).
                            5. Unit number if mentioned (default to "UNKNOWN" if not mentioned).
                            6. Category of the issue (e.g., Plumbing, Electrical, HVAC, Structural, Appliance, Other).
                            7. Priority level (Low, Medium, High, Emergency) based on the severity of the issue.
                            8. Provide a concise summary of the issue for service team (max 150 characters).
                            
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
                                    community: { type: "string" },
                                    unitNumber: { type: "string" },
                                    category: { type: "string" },
                                    priority: { type: "string" },
                                    summary: { type: "string" }
                                },
                                required: [
                                    "residentName",
                                    "problemDescription",
                                    "preferredServiceTime",
                                ]
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
                "ngrok-skip-browser-warning": "true"
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

// وظيفة لتخزين التذكرة في Firestore
async function storeTicketInFirestore(ticketData, transcript, userId = null) {
    try {
        // الحصول على مثيل Firestore
        const db = getFirestore();
        if (!db) {
            throw new Error("Could not get Firestore instance");
        }

        // إنشاء بيانات التذكرة
        const ticketNumber = generateTicketNumber();
        const ticketToStore = {
            ticketNumber,
            ...ticketData,
            status: "pending",
            transcript: transcript,
            createdAt: admin.firestore.FieldValue.serverTimestamp(),
            userId: userId || null,
            updatedAt: admin.firestore.FieldValue.serverTimestamp(),
        };

        console.log("Storing ticket data:", JSON.stringify(ticketToStore));

        // إضافة التذكرة إلى مجموعة supportRequests
        const ticketRef = await db.collection("supportRequests").add(ticketToStore);

        console.log(`Ticket saved to Firestore with ID: ${ticketRef.id}`);

        // إذا كان هناك userId، قم بربط التذكرة بالمستخدم
        if (userId) {
            try {
                await db.collection("users").doc(userId).collection("tickets").add({
                    ticketId: ticketRef.id,
                    ticketNumber: ticketNumber,
                    summary: ticketData.summary || "Maintenance request",
                    status: "pending",
                    createdAt: admin.firestore.FieldValue.serverTimestamp()
                });
                console.log(`Ticket linked to user: ${userId}`);
            } catch (userError) {
                console.error("Error linking ticket to user:", userError);
                // Continue execution even if user linking fails
            }
        }

        return {
            ticketId: ticketRef.id,
            ticketNumber: ticketNumber
        };
    } catch (error) {
        console.error("Error storing ticket in Firestore:", error);
        // Return a default ticket info in case of error for graceful handling
        return {
            ticketId: "error-creating-ticket",
            ticketNumber: "ERROR-" + Date.now()
        };
    }
}

// الوظيفة الرئيسية لمعالجة النص وإنشاء تذكرة
export async function processTranscriptAndSend(
    transcript,
    url,
    sessionId = null,
    userId = null,
    userData = null
) {
    console.log(`Starting transcript processing for session ${sessionId}...`);

    try {
        // Make the ChatGPT completion call
        const result = await makeChatGPTCompletion(transcript);

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

                // التعديل المهم: أضف معلومات المستخدم إلى بيانات التذكرة إذا كانت متوفرة
                if (userData && userData.firstName && userData.lastName) {
                    parsedContent.residentName = `${userData.firstName} ${userData.lastName}`;
                    parsedContent.community = userData.community || parsedContent.community;
                    parsedContent.unitNumber = userData.unitNumber || parsedContent.unitNumber;
                    console.log("Applied user data to ticket:", parsedContent.residentName);
                }

                // تخزين التذكرة في Firestore
                const ticketInfo = await storeTicketInFirestore(parsedContent, transcript, userId);

                // إضافة معلومات التذكرة إلى البيانات المرسلة
                const dataToSend = {
                    ...parsedContent,
                    ticketId: ticketInfo.ticketId,
                    ticketNumber: ticketInfo.ticketNumber
                };

                // إرسال المحتوى المحلل إلى webhook (إذا تم تحديد URL)
                if (url) {
                    await sendToWebhook(url, dataToSend);
                }

                console.log(
                    "Extracted data and created ticket:",
                    dataToSend,
                );

                if (userData?.phone) {
                    await sendTicketSms(userData.phone, dataToSend);
                }

                return dataToSend;
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

    return null;
}
// وظيفة لتخزين محادثة الدردشة وإنشاء تذكرة من محادثة الدردشة
export async function processChatAndCreateTicket(messages, userId = null) {
    try {
        // تحويل رسائل الدردشة إلى نص واحد
        let transcript = '';
        messages.forEach((msg, index) => {
            const role = msg.role === 'user' ? 'User' : 'Assistant';
            transcript += `${role}: ${msg.content}\n`;
        });

        // استخدام وظيفة معالجة النص لإنشاء تذكرة
        const ticketData = await processTranscriptAndSend(transcript, null, null, userId);

        return ticketData;
    } catch (error) {
        console.error("Error processing chat and creating ticket:", error);
        return null;
    }
}


if (process.env.NODE_ENV === 'development') {
    console.log("Running test in development mode");
    const testTranscript = `
  User: مرحبا، اسمي محمد. لدي مشكلة في تسرب الماء في المطبخ.
  Agent: مرحبًا محمد، يؤسفني سماع ذلك. هل يمكنك إخباري منذ متى لاحظت التسرب؟
  User: منذ يومين تقريبًا. أعتقد أنه من الحوض.
  Agent: هل هناك أي أضرار واضحة في الأنابيب أو الوصلات تحت الحوض؟
  User: نعم، يبدو أن هناك صدأ في الوصلة القريبة من الحوض.
  Agent: شكرًا لهذه المعلومات. هل يمكنك إخباري برقم وحدتك والمجمع السكني الذي تعيش فيه؟
  User: أنا في مجمع سدرة، الوحدة رقم 123.
  Agent: تم يا سيد محمد. سأقوم بإنشاء طلب صيانة لمشكلة تسرب المياه في مطبخ وحدتك رقم 123 في مجمع سدرة. متى يناسبك أن يحضر فريق الصيانة؟
  User: غدًا صباحًا إذا أمكن.
  Agent: حسنًا، سأحدد الطلب ليكون غدًا صباحًا. سيتم التواصل معك لتأكيد الموعد بالضبط. شكرًا لإبلاغنا عن هذه المشكلة.
    `;

    setTimeout(async () => {
        console.log("--- Testing transcript processing ---");
        const result = await processTranscriptAndSend(testTranscript, null, "test_session_123", null);
        console.log("Test result:", result);
        console.log("--- End of test ---");
    }, 2000);
}


export async function sendTicketSms(toPhoneNumber, ticketData) {
    try {
        const messageBody = `
  Ticket Number: ${ticketData.ticketNumber}
  Status: ${ticketData.status || "pending"}
  Date: ${new Date().toISOString().split('T')[0]}
      `.trim();

        const message = await client.messages.create({
            body: messageBody,
            from: FROM_NUMBER,
            to: toPhoneNumber,
        });

        console.log("✅ SMS sent successfully:", message.sid);
    } catch (error) {
        console.error("❌ Failed to send SMS:", error.message);
    }
}