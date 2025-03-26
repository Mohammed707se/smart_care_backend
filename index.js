// index.js

import Fastify from "fastify";
import WebSocket from "ws";
import fastifyFormBody from "@fastify/formbody";
import fastifyWs from "@fastify/websocket";
import twilio from "twilio";
import dotenv from "dotenv";
import fs from 'fs';
import { initializeFirebase, admin } from "./firebase-init.js";
const processedCalls = new Map();


function logToFile(message) {
  fs.appendFileSync('call_log.txt', `${new Date().toISOString()}: ${message}\n`);
}

// استخدم هذه الدالة في جميع أنحاء الكود
logToFile("🎬 Call started");
// تحميل متغيرات البيئة أولاً
dotenv.config();

// استيراد وتهيئة Firebase
const db = await initializeFirebase();


// استيراد الخدمات الأخرى
import { registerAuthRoutes } from "./firebase.service.js";
import {
  getOpenaiWebsocketInstance,
  sendSessionUpdate,
  LOG_EVENT_TYPES,
  processTranscriptAndSend,
} from "./openai.service.js";
// Constants
const PORT = process.env.PORT || 3000;
// Retrieve the OpenAI and Twilio API keys from environment variables
const {
  OPENAI_API_KEY,
  WEBHOOK_URL,
  TWILIO_ACCOUNT_SID,
  TWILIO_AUTH_TOKEN,
  TWILIO_PHONE_NUMBER,
  JWT_SECRET,
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
if (!JWT_SECRET) {
  console.warn("JWT_SECRET not set. Using default secret. This is not secure for production!");
}


// Initialize Twilio client
const twilioClient = twilio(TWILIO_ACCOUNT_SID, TWILIO_AUTH_TOKEN);

// Initialize Fastify
const fastify = Fastify();
fastify.register(fastifyFormBody);
fastify.register(fastifyWs);

registerAuthRoutes(fastify);

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
    console.log(`🔄 New WebSocket connection established. Session ID: ${sessionId}`);

    let session = sessions.get(sessionId) || {
      transcript: "",
      streamSid: null,
    };
    sessions.set(sessionId, session);

    // الحصول على مثيل OpenAI WebSocket
    console.log("🚀 Initializing OpenAI WebSocket connection...");
    const openAiWs = getOpenaiWebsocketInstance();
    openAiWs.onopen = () => {
      console.log("🖇️ Pre-initialized connection to OpenAI");
      // بدء المكالمة فقط عندما يكون الاتصال جاهزًا
    };
    // حدث الفتح لـ OpenAI WebSocket
    openAiWs.on("open", () => {
      console.log("🖇️ Connected to the OpenAI Realtime API");
      console.log("⏱️ Waiting 250ms before sending session update...");
      setTimeout(async () => {
        console.log("📤 Sending session configuration to OpenAI...");
        await sendSessionUpdate(openAiWs);
      }, 250);
    });

    // تتبع الخطوات خلال المكالمة
    let callSteps = {
      openAIConnected: false,
      sessionUpdated: false,
      userSpoke: false,
      agentResponded: false
    };

    // الاستماع للرسائل من OpenAI WebSocket
    openAiWs.on("message", (data) => {
      try {
        const response = JSON.parse(data);

        // تتبع تحديث الجلسة
        if (response.type === "session.updated") {
          callSteps.sessionUpdated = true;
          console.log("✅ Session updated successfully:", response);
        }

        // تتبع نص المستخدم
        if (response.type === "conversation.item.input_audio_transcription.completed") {
          callSteps.userSpoke = true;
          const userMessage = response.transcript.trim();
          session.transcript += `User: ${userMessage}\n`;
          console.log(`👤 User (${sessionId}): "${userMessage}"`);

          // حفظ النص المؤقت في الوقت الفعلي
          console.log("💾 Saving real-time transcript to session...");
        }

        // تتبع استجابة المساعد
        if (response.type === "response.done") {
          callSteps.agentResponded = true;
          const agentMessage = response.response.output[0]?.content?.find(
            (content) => content.transcript
          )?.transcript || "Agent message not found";
          session.transcript += `Agent: ${agentMessage}\n`;
          console.log(`🤖 Agent (${sessionId}): "${agentMessage}"`);
        }

        // إرسال الصوت إلى العميل
        if (response.type === "response.audio.delta" && response.delta) {
          const audioDelta = {
            event: "media",
            streamSid: session.streamSid,
            media: {
              payload: Buffer.from(response.delta, "base64").toString("base64"),
            },
          };
          console.log("📤 Sending audio to client, stream:", session.streamSid);
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

    // معالجة الرسائل الواردة من Twilio
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
            } else {
              console.error("❌ Cannot forward audio - OpenAI WebSocket not open");
            }
            break;
          case "start":
            session.streamSid = data.start.streamSid;
            console.log("🎬 Incoming stream has started", session.streamSid);
            break;
          case "stop":
            console.log("🛑 Stream stopped event received");
            break;
          default:
            console.log("ℹ️ Received non-media event:", data.event);
            break;
        }
      } catch (error) {
        console.error("❗️ Error parsing message:", error, "Message:", message);
      }
    });

    connection.on("close", async (code, reason) => {
      console.log(`📵 Client disconnected (${sessionId}). Code: ${code}, Reason: ${reason || "No reason provided"}`);
      console.log(`📊 Call statistics: ${JSON.stringify(callSteps)}`);

      if (openAiWs.readyState === WebSocket.OPEN) {
        console.log("🔌 Closing OpenAI WebSocket connection...");
        openAiWs.close();
      }

      console.log("=========================");
      console.log("📋 ===Full Transcript===");
      console.log(session.transcript);
      console.log("=========================");

      // معالجة النص وإنشاء تذكرة
      if (session.transcript && session.transcript.trim()) {
        console.log("🎟️ Creating ticket from transcript...");

        try {
          // إذا كان sessionId هو معرف مكالمة Twilio
          let userId = null;
          let userData = null;

          // البحث عن المستخدم باستخدام findUserByPhone فقط إذا كان معرف الجلسة هو معرف مكالمة
          if (sessionId && sessionId.startsWith('CA')) {
            try {
              // استرجاع معلومات المكالمة من Twilio
              const call = await twilioClient.calls(sessionId).fetch();
              const phoneNumber = call.to;

              // البحث عن المستخدم حسب الرقم
              const db = getFirestore();
              if (db) {
                // البحث المباشر
                const userQuery = await db.collection("users")
                  .where("phone", "==", phoneNumber)
                  .limit(1)
                  .get();

                if (!userQuery.empty) {
                  userData = userQuery.docs[0].data();
                  userId = userQuery.docs[0].id;
                  console.log("Found user from WebSocket close:", userData.firstName, userData.lastName);

                  // تحديث نص المحادثة في الفايرستور للمرجعية المستقبلية
                  await db.collection("callTranscripts").add({
                    callSid: sessionId,
                    transcript: session.transcript,
                    userId: userId,
                    timestamp: admin.firestore.FieldValue.serverTimestamp()
                  });
                }
              }
            } catch (error) {
              console.error("Error retrieving user information:", error);
            }
          }

          // إنشاء التذكرة مع معلومات المستخدم
          const ticketData = await processTranscriptAndSend(
            session.transcript,
            null,
            sessionId,
            userId,
            userData
          );

          if (ticketData) {
            console.log("✅ Ticket created successfully:", ticketData);

            // حفظ معلومات المعالجة في المخزن المشترك
            processedCalls.set(sessionId, {
              processed: true,
              ticketId: ticketData.ticketId,
              ticketNumber: ticketData.ticketNumber
            });
          } else {
            console.error("❌ Failed to create ticket");
          }
        } catch (ticketError) {
          console.error("💥 Error creating ticket:", ticketError);
        }
      } else {
        console.log("❌ No transcript available to create ticket");
      }

      // تنظيف الجلسة
      console.log("🧹 Cleaning up session...");
      sessions.delete(sessionId);
    });

    // معالجة إغلاق وأخطاء WebSocket
    openAiWs.on("close", (code, reason) => {
      console.log(`🔌 Disconnected from OpenAI API. Code: ${code}, Reason: ${reason || "No reason provided"}`);
    });

    openAiWs.on("error", (error) => {
      console.error("💥 Error in OpenAI WebSocket:", error);
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
    let userInfo = null;



    if (userId) {
      const userDoc = await db.collection("users").doc(userId).get();
      if (userDoc.exists) {
        userInfo = {
          id: userDoc.id,
          firstName: userDoc.data().firstName,
          lastName: userDoc.data().lastName,
          community: userDoc.data().community,
          unitNumber: userDoc.data().unitNumber
        };
      }
    }


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
    console.log(data);
    const aiResponse = data.choices && data.choices.length > 0 ?
      data.choices[0].message.content : 'No response from AI';


    if (userId) {
      const chatData = {
        userId,
        userMessage: text || "Image message",
        hasImage: !!image,
        aiResponse,
        timestamp: new Date()
      };

      await db.collection("chatHistory").add(chatData);
    }

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
  const { requestNumber, userId } = request.body;

  if (!requestNumber) {
    return reply.status(400).send({ error: "Request number is required" });
  }

  try {
    // البحث عن الطلب في Firestore
    const requestsSnapshot = await db.collection("supportRequests")
      .where("requestNumber", "==", requestNumber)
      .limit(1)
      .get();

    if (requestsSnapshot.empty) {
      // استخدام البيانات المزيفة إذا لم يتم العثور على البيانات
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
    }

    // إرجاع البيانات من Firestore
    const requestDoc = requestsSnapshot.docs[0];
    const requestData = requestDoc.data();

    // تسجيل أن المستخدم قام بالاستعلام عن هذا الطلب
    if (userId) {
      await db.collection("requestTracking").add({
        userId,
        requestId: requestDoc.id,
        requestNumber,
        timestamp: new Date()
      });
    }

    return reply.send({
      status: 'success',
      data: {
        id: requestDoc.id,
        ...requestData
      }
    });
  } catch (error) {
    console.error('Error tracking request:', error);
    return reply.status(500).send({
      error: 'Failed to track request',
      details: error.message
    });
  }
});
fastify.post("/create-call-ticket", async (request, reply) => {
  const { callSid, phoneNumber, duration } = request.body;

  // إنشاء محادثة افتراضية
  const defaultTranscript = `
  User: مكالمة من الرقم ${phoneNumber}
  Agent: مرحبًا بك في نظام Smart Care، كيف يمكنني مساعدتك؟
  User: لدي مشكلة في تسرب المياه في الحمام.
  Agent: أفهم، منذ متى تعاني من هذه المشكلة؟
  User: منذ يومين تقريبًا. أرجو المساعدة في أقرب وقت.
  Agent: شكراً للمعلومات. سنقوم بإنشاء تذكرة صيانة لك وسيتواصل معك الفريق المختص.
  `;

  // بيانات التذكرة الافتراضية
  const defaultTicketData = {
    residentName: "مستخدم مجهول",
    problemDescription: "تسرب مياه في الحمام",
    preferredServiceTime: new Date().toISOString(),
    community: "غير محدد",
    unitNumber: "غير محدد",
    category: "سباكة",
    priority: "متوسط",
    summary: `مكالمة من الرقم ${phoneNumber}: تسرب مياه في الحمام يحتاج إلى صيانة عاجلة`
  };

  try {
    // محاولة معالجة المحادثة وإنشاء تذكرة عبر العملية العادية
    const ticketData = await processTranscriptAndSend(defaultTranscript, null, callSid, null);

    if (ticketData) {
      return reply.send({
        success: true,
        ticketData
      });
    } else {
      // إذا فشلت المعالجة التلقائية، قم بإنشاء تذكرة يدويًا
      const dbInstance = db; // استخدام مثيل db المهيأ في index.js

      if (!dbInstance) {
        throw new Error("Firestore instance not available");
      }

      // إنشاء رقم تذكرة فريد
      const timestamp = Date.now().toString().slice(-6);
      const random = Math.floor(Math.random() * 10000).toString().padStart(4, '0');
      const ticketNumber = `TKT-MANUAL-${timestamp}${random}`;

      // إنشاء التذكرة في Firestore
      const ticketRef = await dbInstance.collection("supportRequests").add({
        ticketNumber,
        ...defaultTicketData,
        status: "pending",
        transcript: defaultTranscript,
        createdAt: admin.firestore.FieldValue.serverTimestamp(),
        updatedAt: admin.firestore.FieldValue.serverTimestamp()
      });

      return reply.send({
        success: true,
        manuallyCreated: true,
        ticketData: {
          ticketId: ticketRef.id,
          ticketNumber,
          ...defaultTicketData
        }
      });
    }
  } catch (error) {
    console.error("Error creating call ticket:", error);
    return reply.status(500).send({
      error: "Failed to create ticket",
      details: error.message
    });
  }
});

// نقطة نهاية لاختبار OpenAI API
fastify.get("/test-openai", async (request, reply) => {
  try {
    // اختبار اتصال API
    const response = await fetch(
      "https://api.openai.com/v1/chat/completions",
      {
        method: "POST",
        headers: {
          "Authorization": `Bearer ${OPENAI_API_KEY}`,
          "Content-Type": "application/json",
        },
        body: JSON.stringify({
          model: "gpt-4o-mini",
          messages: [
            { role: "user", content: "Say hello" }
          ],
        }),
      }
    );

    const data = await response.json();
    return reply.send({
      status: "success",
      api_working: !!data.choices,
      response: data
    });
  } catch (error) {
    return reply.status(500).send({
      status: "error",
      message: "OpenAI API test failed",
      error: error.message
    });
  }
});

const authenticate = async (request, reply) => {
  try {
    const authHeader = request.headers.authorization;
    if (!authHeader || !authHeader.startsWith('Bearer ')) {
      throw new Error('Authentication required');
    }

    const token = authHeader.substring(7);
    const jwt = await import('jsonwebtoken');
    const decoded = jwt.verify(token, process.env.JWT_SECRET || "smartcare-default-secret");

    // الحصول على المستخدم من Firestore
    const userDoc = await db.collection("users").doc(decoded.userId).get();

    if (!userDoc.exists) {
      throw new Error('User not found');
    }

    // ربط المستخدم بالطلب
    request.user = {
      id: userDoc.id,
      ...userDoc.data(),
    };

  } catch (error) {
    reply.status(401).send({
      status: "error",
      message: "Authentication failed: " + error.message
    });
    return reply;
  }
};
fastify.post("/make-call", async (request, reply) => {
  const { to } = request.body;

  if (!to) {
    return reply
      .status(400)
      .send({ error: "Missing 'to' phone number in request body." });
  }

  try {
    // تحقق من وجود WEBHOOK_URL
    const baseUrl = process.env.WEBHOOK_URL || request.headers.host;
    // تأكد من أن URL كامل مع http أو https
    const baseUrlWithProtocol = baseUrl.startsWith('http')
      ? baseUrl
      : `https://${baseUrl}`;

    const callUrl = `${baseUrlWithProtocol}/incoming-call`;

    console.log(`Initiating call to ${to} with URL: ${callUrl}`);

    const call = await twilioClient.calls.create({
      url: callUrl,
      to: to,
      from: TWILIO_PHONE_NUMBER,
      statusCallback: `${baseUrlWithProtocol}/call-status`,
      statusCallbackEvent: ['completed'],
      statusCallbackMethod: 'POST'
    });

    console.log(`Initiated call to ${to}. Call SID: ${call.sid}`);
    return reply.send({
      message: `Call initiated to ${to}`,
      callSid: call.sid,
    });
  } catch (error) {
    console.error("❗️ Error initiating call:", error);
    return reply.status(500).send({
      error: "Failed to initiate call.",
      details: error.message
    });
  }
});
// في معالج الحدث "call-status" أو عند انتهاء المكالمة:
fastify.post("/call-status", async (request, reply) => {
  const callSid = request.body.CallSid;
  const callStatus = request.body.CallStatus;
  const callTo = request.body.To;

  console.log(`Call ${callSid} status: ${callStatus}, To: ${callTo}`);

  // التحقق إذا تمت معالجة المكالمة سابقاً
  const processedCall = processedCalls.get(callSid);
  if (processedCall) {
    console.log(`Call ${callSid} was already processed with ticket: ${processedCall.ticketNumber}`);
    return reply.send({ status: "already processed" });
  }

  // إذا اكتملت المكالمة ولم تتم معالجتها بعد
  if (callStatus === 'completed') {
    try {
      // البحث عن المستخدم
      console.log("Looking for user with phone number:", callTo);

      const db = admin.firestore();

      // البحث عن المستخدم
      const userQuery = await db.collection("users")
        .where("phone", "==", callTo)
        .limit(1)
        .get();

      if (!userQuery.empty) {
        const userData = userQuery.docs[0].data();
        const userId = userQuery.docs[0].id;
        console.log("Found user:", userData.firstName, userData.lastName);

        // البحث عن نص المحادثة في قاعدة البيانات
        const transcriptQuery = await db.collection("callTranscripts")
          .where("callSid", "==", callSid)
          .limit(1)
          .get();

        if (!transcriptQuery.empty) {
          // إذا وجد نص المحادثة، استخدمه (تم تخزينه من معالج إغلاق الاتصال)
          const transcript = transcriptQuery.docs[0].data().transcript;
          console.log("Found saved transcript for call");

          // معالجة النص إذا لم تكن المكالمة قد تمت معالجتها بالفعل
          await processTranscriptAndSend(transcript, null, callSid, userId, userData);
        } else {
          // إذا لم يتم العثور على نص المحادثة، استخدم النص الافتراضي
          console.log("No transcript found for call, using default");
          const defaultTranscript = `User: مكالمة من ${userData.firstName} ${userData.lastName}
Agent: مرحبًا، كيف يمكنني مساعدتك؟
User: بلاغ عن مشكلة صيانة في التسرب.
Agent: شكرًا لإبلاغنا، سنقوم بإنشاء تذكرة لك.`;

          await processTranscriptAndSend(defaultTranscript, null, callSid, userId, userData);
        }
      } else {
        console.log("No user found with phone number:", callTo);
      }
    } catch (error) {
      console.error("Error processing call status:", error);
    }
  }

  reply.send({ status: "processed" });
});

if (import.meta.url === `file://${process.argv[1]}`) {
  fastify.listen({ port: PORT, host: '0.0.0.0' }, (err, address) => {
    if (err) {
      console.error("Error starting server:", err);
      process.exit(1);
    }
    console.log(`Server is listening on ${address}`);
  });
}



fastify.post("/log-call", async (request, reply) => {
  const { phoneNumber, duration } = request.body;

  // إنشاء تذكرة مع بيانات افتراضية
  const mockTranscript = `User: Called from ${phoneNumber}\nAgent: Received call for ${duration} seconds`;

  const defaultTicketData = {
    residentName: "Unknown Caller",
    problemDescription: `Phone call from ${phoneNumber}`,
    preferredServiceTime: new Date().toISOString(),
    community: "UNKNOWN",
    unitNumber: "UNKNOWN",
    category: "Other",
    priority: "Medium",
    summary: `Received call from ${phoneNumber} for ${duration} seconds`
  };

  try {
    const db = await initializeFirebase();


    // توليد رقم تذكرة
    const ticketNumber = `TKT-CALL-${Date.now()}`;

    // إنشاء بيانات التذكرة
    const ticketToStore = {
      ticketNumber,
      ...defaultTicketData,
      status: "pending",
      transcript: mockTranscript,
      createdAt: admin.firestore.FieldValue.serverTimestamp(),
      userId: null,
      updatedAt: admin.firestore.FieldValue.serverTimestamp(),
    };

    // حفظ التذكرة في Firestore
    const ticketRef = await db.collection("supportRequests").add(ticketToStore);

    console.log(`Manual call log saved with ID: ${ticketRef.id}`);

    return reply.send({
      success: true,
      ticketId: ticketRef.id,
      ticketNumber
    });
  } catch (error) {
    console.error("Error logging call:", error);
    return reply.status(500).send({ error: "Failed to log call" });
  }
});


async function checkCallStatus(callSid) {
  try {
    const call = await twilioClient.calls(callSid).fetch();
    console.log(`Call status: ${call.status}, Duration: ${call.duration}s`);
    return call;
  } catch (error) {
    console.error(`Error fetching call ${callSid}:`, error);
    return null;
  }
}

// استدعاء بعد فترة زمنية مناسبة
setTimeout(() => checkCallStatus("CA434756f6243f71930b985ab1bf4e1165"), 60000);


fastify.post("/manual-ticket", async (request, reply) => {
  const { callSid, phoneNumber } = request.body;
  const testTranscript = `
  User: مرحبًا، هذه مكالمة اختبارية من ${phoneNumber}.
  Agent: مرحبًا، كيف يمكنني مساعدتك اليوم؟
  User: لدي مشكلة في التسرب بالحمام.
  Agent: أفهم، هل يمكنك إخباري متى بدأت ملاحظة هذه المشكلة؟
  User: منذ يومين تقريبًا.
  Agent: شكرًا لك، سأقوم بإنشاء تذكرة صيانة لك.
  `;

  try {
    const result = await processTranscriptAndSend(testTranscript, null, callSid, null);
    return reply.send({
      success: true,
      ticketInfo: result
    });
  } catch (error) {
    console.error("Error creating manual ticket:", error);
    return reply.status(500).send({ error: "Failed to create ticket" });
  }
});


fastify.get("/api-status", (request, reply) => {
  const apiKey = process.env.OPENAI_API_KEY || '';
  const maskKey = apiKey ? `${apiKey.substring(0, 3)}...${apiKey.substring(apiKey.length - 4)}` : 'undefined';

  reply.send({
    api_key_defined: !!process.env.OPENAI_API_KEY,
    api_key_preview: maskKey,
    environment_variables: {
      NODE_ENV: process.env.NODE_ENV,
      PORT: process.env.PORT,
      // لا تكشف عن التفاصيل الكاملة للمتغيرات الحساسة
      TWILIO_ACCOUNT_SID: process.env.TWILIO_ACCOUNT_SID ? 'defined' : 'undefined',
      WEBHOOK_URL: process.env.WEBHOOK_URL || 'undefined',
      // إضافة أي متغيرات بيئية أخرى ترغب في التحقق منها
    }
  });
});

async function findUserByPhone(phoneNumber) {
  if (!phoneNumber) return null;

  try {
    console.log("Searching for user with phone number:", phoneNumber);

    // تنظيف الرقم
    let cleanedNumber = phoneNumber;
    if (cleanedNumber.startsWith('+')) {
      // حفظ الرقم كما هو وأيضًا بدون علامة +
      const noPlus = cleanedNumber.substring(1);

      // البحث باستخدام الرقم الأصلي
      let usersQuery = await db.collection("users")
        .where("phone", "==", cleanedNumber)
        .limit(1)
        .get();

      if (!usersQuery.empty) {
        return {
          id: usersQuery.docs[0].id,
          ...usersQuery.docs[0].data()
        };
      }

      // البحث بدون علامة +
      usersQuery = await db.collection("users")
        .where("phone", "==", noPlus)
        .limit(1)
        .get();

      if (!usersQuery.empty) {
        return {
          id: usersQuery.docs[0].id,
          ...usersQuery.docs[0].data()
        };
      }

      // البحث في آخر 9 أرقام
      const last9 = cleanedNumber.slice(-9);
      usersQuery = await db.collection("users")
        .where("phone", "endsWith", last9)  // ملاحظة: قد لا يكون endsWith متاحًا في Firestore
        .limit(10)  // خذ عدة نتائج وقم بتصفيتها
        .get();

      // تصفية النتائج يدويًا
      for (const doc of usersQuery.docs) {
        const userPhone = doc.data().phone || "";
        if (userPhone.endsWith(last9)) {
          return {
            id: doc.id,
            ...doc.data()
          };
        }
      }
    }

    return null;
  } catch (error) {
    console.error("Error searching for user:", error);
    return null;
  }
}

// نقطة اختبار للبحث عن رقم محدد
fastify.get("/find-exact-user", async (request, reply) => {
  const phoneNumber = "+966539322900"; // الرقم المخزن بالضبط

  try {
    const db = admin.firestore();
    const userQuery = await db.collection("users")
      .where("phone", "==", phoneNumber)
      .limit(1)
      .get();

    if (userQuery.empty) {
      return reply.send({ found: false, message: "User not found with exact phone match" });
    }

    const userData = userQuery.docs[0].data();
    return reply.send({
      found: true,
      user: {
        id: userQuery.docs[0].id,
        name: `${userData.firstName} ${userData.lastName}`,
        phone: userData.phone
      }
    });
  } catch (error) {
    return reply.status(500).send({ error: error.message });
  }
});