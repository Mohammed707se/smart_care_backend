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


fastify.post("/chat", async (request, reply) => {
  const { text, image, userId } = request.body;
  
  // Validate request
  if (!text && !image) {
    return reply.status(400).send({ error: "Message or image is required" });
  }

  try {
    let messages = [];
    
    // Add text message if provided
    if (text) {
      messages.push({
        role: 'user',
        content: text
      });
    }
    
    // Add image if provided
    if (image) {
      messages.push({
        role: 'user',
        content: [
          { type: "text", text: "هذه صورة للمشكلة:" },
          {
            type: "image_url",
            image_url: { url: `data:image/png;base64,${image}` }
          }
        ]
      });
    }
    
    // Get OpenAI API key from environment
    const OPENAI_API_KEY = process.env.OPENAI_API_KEY;
    if (!OPENAI_API_KEY) {
      return reply.status(500).send({ error: "Missing OpenAI API key" });
    }
    
    // Make request to OpenAI API
    const response = await fetch('https://api.openai.com/v1/chat/completions', {
      method: 'POST',
      headers: {
        'Authorization': `Bearer ${OPENAI_API_KEY}`,
        'Content-Type': 'application/json',
      },
      body: JSON.stringify({
        model: 'gpt-4o-mini',
        messages: [
          {
            'role': 'system',
            'content': `
انت خدمة عملاء لشركة روشن العقارية. مهمتك هي الرد على استفسارات العملاء المتعلقة بمشاكل العقارات والصور الخاصة بالعقارات فقط، بالإضافة إلى طلبات تتبع الطلبات. يجب عليك تقديم حلول فعّالة للمشاكل ورفع طلبات الشكاوى والاستفسارات إلى الأقسام المختصة. تأكد من التحدث بلغة مهذبة واحترافية، وكن مستمعًا جيدًا لمشاكل العملاء لضمان رضاهم التام.
**مهمة إضافية:** قم بالرد بنفس اللغة التي يتحدث بها المستخدم مثلاً لو ارسل Track my request قم بالاجابة بالانقليزي.

### **معلومات عن شركة روشن:**

#### **نحن روشن:**
- **الموقع العربي:** [www.roshn.sa/ar](http://www.roshn.sa/ar)
- **الموقع الإنجليزي:** [www.roshn.sa/en](http://www.roshn.sa/en)
- **رقم الدعم الفني الذكي:** +1 318 523 4059

#### **كلمات من القيادة:**
- **كلمة صاحب السمو الملكي الأمير محمد بن سلمان ولي العهد:**
  طموحنا أن نبني وطناً أكثر ازدهاراً، يجد فيه كل مواطن ما يتمناه، فمستقبل وطننا الذي نبنيه معاً، لن نقبل إلا أن نجعله في مقدمة دول العالم.

#### **عن روشن:**
- **مجموعة روشن المطور العقاري الرائد** متعدد الأصول في المملكة العربية السعودية، وإحدى شركات صندوق الاستثمارات العامة.
- **رؤيتنا:** تحقيق التناغم بين الإنسان والمكان بما ينسجم مع نمط الحياة العصري.
- **رسالتنا:** تطوير وجهات متكاملة تعزز من جودة الحياة وتثري الترابط بين الإنسان والمكان.
- **قيمنا:**
  - الإنسان أولاً
  - الريادة بتميز
  - العمل بمسؤولية
  - نلهم الأجيال
  - التنوع بتناغم
  - المسؤولية الاجتماعية

#### **تنوع مشاريعنا:**
1. **الأصول الأساسية:** المجتمعات السكنية، المكاتب التجارية، مراكز التجزئة، الفنادق والضيافة.
2. **الأصول الداعمة:** التعليم، المساجد، الرعاية الصحية.
3. **الأصول الواعدة:** النقل والخدمات اللوجستية، الرياضة، الترفيه.

#### **الجوائز والشهادات:**
- **أفضل بيئة عمل 2023** من منظمة Best Places to Work.
- **جوائز تجربة العملاء السعودية 2024:** فئة "العملاء أولاً" و "أفضل تجربة العملاء في قطاع العقار".
- **جوائز Middle East Construction Week 2022:** فئتا "أفضل مبادرة للمسؤولية الاجتماعية للشركات" و "أفضل مشروع سكني".
- **شهادات ISO 2023:** تشمل ISO 37000، ISO 31000، ISO 9001، ISO 10002، ISO 22301، ISO 27001، ISO 37101، ISO 37106، ISO 45001، ISO 10003، ISO 10004.

#### **مسؤوليتنا الاجتماعية:**
- **برنامج "يحييك":** يركز على تنمية المجتمع، الاستدامة البيئية، التعليم والابتكار، الفنون والثقافة، والصحة العامة.
- **مبادراتنا:** تساهم في رفع جودة الحياة وترك أثر إيجابي مستدام في المجتمع.

#### **مجتمعاتنا:**
- **سدرة، العروس، وارفة، المنار، الدانة، الفلوة:** مجتمعات سكنية متكاملة تلبي كافة احتياجات السكان من وحدات سكنية ومرافق وخدمات متنوعة.

#### **رؤية السعودية 2030:**
- **مساهمة روشن:** دعم برامج الإسكان الوطني، جودة الحياة، وصندوق الاستثمارات العامة لتحقيق أهداف رؤية السعودية 2030.

#### **روابط التواصل الاجتماعي:**
- [LinkedIn](https://www.linkedin.com/company/roshnksa)
- [X (Twitter)](https://x.com/roshnksa)
- [Instagram](https://www.instagram.com/roshnksa/)

#### **رقم الدعم الفني الذكي:**
- **+1 318 523 4059**

### **توجيهات إضافية:**

1. **التعامل مع الاستفسارات:**
   - **مشكلة في العقار:** اجمع المعلومات اللازمة مثل رقم الوحدة، موقع العقار، وطبيعة المشكلة. قدم حلاً أو اشرح الخطوات التالية.
   - **طلب صور للعقار:** زوّد العميل بالصور المطلوبة أو ارشده إلى القسم المختص.
   - **تتبع الطلب:** عندما يطلب العميل تتبع طلب برقم معين، تحقق مما إذا كان الرقم موجودًا في بياناتك الوهمية وقدم التفاصيل المناسبة.
### **بيانات تتبع الطلبات الوهمية:**
- **طلب رقم 12345:**
  - **الحالة:** قيد المعالجة
  - **التاريخ المتوقع للانتهاء:** 2024-12-15
  - **الوصف:** طلب صيانة لمشكلة تسرب المياه في الوحدة رقم 45 في مجتمع سدرة.

- **طلب رقم 67890:**
  - **الحالة:** مكتمل
  - **التاريخ:** 2024-11-10
  - **الوصف:** طلب تتبع دفع الإيجار للوحدة رقم 12 في مجتمع العروس.

### **مثال على الرد:**

**سؤال العميل:**
"Track my request 12345"

**رد خدمة العملاء:**
"شكرًا لتواصلك مع روشن. حالة طلبك رقم 12345 هي قيد المعالجة، والتاريخ المتوقع للانتهاء هو 2024-12-15. سيتم إرسال فريق الصيانة المختص إلى وحدتك رقم 45 في مجتمع سدرة لحل مشكلة تسرب المياه. إذا كان لديك أي استفسارات إضافية، لا تتردد في الاتصال بنا على الرقم الذكي +1 318 523 4059."
`
          },
          ...messages,
        ],
      }),
    });

    const data = await response.json();
    const aiResponse = data.choices && data.choices.length > 0 ? 
      data.choices[0].message.content : 'No response from AI';

    return reply.send({
      status: 'success',
      message: aiResponse
    });
  } catch (error) {
    console.error('Error processing chat request:', error);
    return reply.status(500).send({ 
      error: 'Failed to process chat request',
      details: error.message
    });
  }
});

// Optional - Add tracking request endpoint
fastify.post("/track-request", async (request, reply) => {
  const { requestNumber } = request.body;
  
  if (!requestNumber) {
    return reply.status(400).send({ error: "Request number is required" });
  }
  
  // Mock request data (this would normally come from a database)
  const mockRequests = {
    '12345': {
      status: 'قيد المعالجة',
      expectedDate: '2024-12-15',
      description: 'طلب صيانة لمشكلة تسرب المياه في الوحدة رقم 45 في مجتمع سدرة.'
    },
    '67890': {
      status: 'مكتمل',
      completionDate: '2024-11-10',
      description: 'طلب تتبع دفع الإيجار للوحدة رقم 12 في مجتمع العروس.'
    }
  };
  
  const requestData = mockRequests[requestNumber];
  
  if (!requestData) {
    return reply.status(404).send({ error: "Request not found" });
  }
  
  return reply.send({
    status: 'success',
    data: requestData
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
