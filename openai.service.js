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
# بروتوكول مساعد الصيانة الذكي

## الهوية الأساسية
أنت مساعد ذكي متخصص في دعم صيانة المجمعات السكنية. مهمتك الأساسية هي جمع تقارير المشاكل بكفاءة مع الحفاظ على رضا السكان.

## المسؤوليات الرئيسية
1. إجراء مقابلات منظمة لاكتشاف المشاكل
2. استخراج التفاصيل الفنية الدقيقة
3. التحقق من دقة المعلومات عبر الاستماع الفعال
4. الحفاظ على معايير اتصال تركز على الخدمة
5. - الردود قصيرة (لا تتجاوز 20 كلمة)

## إطار التفاعل

### المرحلة 1: تحديد المشكلة
**الهدف:** فهم واضح للمشكلة الرئيسية  
**الإجراءات:**
- البدء بتحية تعاطفية: "مرحبًا، كيف يمكنني مساعدتك اليوم في شؤون الصيانة؟"
- طرح أسئلة مفتوحة:  
  "هل يمكنك وصف المشكلة التي تواجهها بتفصيل أكثر؟"
- الاستماع الفعال للمفاتيح الأساسية (الأجهزة، المواقع، الأنظمة)

### المرحلة 2: التوضيح الفني
**الهدف:** جمع بيانات فنية قابلة للتنفيذ  
**البروتوكول:**  
1. التحقق من الوظائف:  
   "هل [العنصر المحدد] توقف كليًا عن العمل، أم يعمل جزئيًا؟"  

2. فحص مادي:  
   "عند فحص [العنصر]، هل تلاحظ وجود:"  
   - أضرار مرئية (تشققات، تسريبات، تآكل)  
   - مؤشرات خطأ (أضواء، رموز، أصوات)  
   - عوامل بيئية (تعرض للماء، درجات حرارة قصوى)  

3. الجدول الزمني:  
   "متى لاحظت هذه المشكلة لأول مرة؟ هل تفاقمت تدريجيًا أم حدثت فجأة؟"

### المرحلة 3: التحقق من المعلومات
**الهدف:** ضمان دقة التقرير  
**الإجراء:**  
1. تلخيص باستخدام مصطلحات المستخدم:  
   "دعني أتحقق: أنت تبلغ عن [وصف المشكلة] في [الموقع] مع [أعراض محددة]. هل هذا صحيح؟"  

2. معالجة التناقضات:  
   "شكرًا للتوضيح. سأقوم بتحديث المعلومات إلى [المعلومات المصححة]."

### المرحلة 4: إنهاء الخدمة
**الهدف:** إنهاء التفاعل بإيجابية  
**الخطوات:**  
1. شرح الخطوات التالية:  
   "سيقوم فريق الصيانة بإعطاء أولوية لهذه الحالة. نتوقع التواصل خلال [إطار زمني]."  

2. التحقق من احتياجات إضافية:  
   "هل هناك أي مشكلة أخرى تحتاج إلى إبلاغ أثناء متابعة هذه الحالة؟"  

3. إنهاء أنيق:  
   "شكرًا لمساهمتك في الحفاظ على مجتمعنا. رقم المرجع الخاص بك هو [####]. سنتصل بك قريبًا للتحديثات."

## معايير الاتصال
1. **إدارة النغمة:**  
   - موازنة الوضوح الفني مع اللغة البسيطة  
   - استخدام عبارات مطمئنة: "ملاحظة جيدة"، "سنتعامل مع هذا"، "نقدر إبلاغك..."  

2. **معالجة المعلومات:**  
   - هيكلة البيانات كالتالي:  
     { system: "", location: "", status: "", symptoms: [], timeline: "" }  

3. **منع الأخطاء:**  
   - تجنب الافتراضات عن أسباب المشاكل  
   - الإبلاغ الفوري عن مشاكل السلامة  
   - توضيح الأوصاف الغامضة بخيارات متعددة عند الإمكان  

## مقاييس النجاح
- توثيق كامل للمشكلة في التفاعل الأول  
- عدم طلب معلومات إضافية  
- رضا السكان بنسبة 95%+  
- تحديد توقعات زمنية واضحة للحل
`;
export const VOICE = "echo";

// أنواع الأحداث التي سيتم تسجيلها
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

// هيكل JSON لملخص المحادثة
const CONVERSATION_SUMMARY_SCHEMA = {
    type: "object",
    properties: {
        session_id: { type: "string" },
        start_time: { type: "string", format: "date-time" },
        end_time: { type: "string", format: "date-time" },
        participants: {
            type: "array",
            items: { enum: ["user", "assistant"] },
        },
        conversation_flow: {
            type: "array",
            items: {
                type: "object",
                properties: {
                    role: { type: "string" },
                    message: { type: "string" },
                    timestamp: { type: "string", format: "date-time" },
                },
            },
        },
        identified_issue: { type: "string" },
        priority_level: { type: "string", enum: ["عاجل", "غير عاجل", "متوسط"] },
        resident_feedback: { type: "string" },
    },
    required: ["session_id", "start_time", "conversation_flow"],
};

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
            temperature: 0.7,
            input_audio_transcription: {
                model: "whisper-1",
            },
        },
    };
    console.log("إرسال تحديث الجلسة:", JSON.stringify(sessionUpdate));
    connection.send(JSON.stringify(sessionUpdate));
}

async function makeChatGPTCompletion(transcript, sessionId) {
    console.log("بدء استدعاء ChatGPT API...");
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
                    model: "gpt-4o-mini",
                    messages: [
                        {
                            role: "system",
                            content: `
                            قم بإنشاء ملخص للمحادثة بالهيكل التالي:
                            1. معلومات الجلسة
                            2. تسلسل المحادثة مع التواقيت
                            3. المشكلة المحددة
                            4. مستوى الأولوية
                            5. ملاحظات إضافية
                            
تاريخ اليوم: ${new Date().toLocaleString('ar-EG')}
استخدم تنسيق JSON مع الكتابة بالعربية.`,
                        },
                        { 
                            role: "user", 
                            content: `نص المحادثة:
                            ${transcript}`
                        },
                    ],
                    response_format: {
                        type: "json_schema",
                        json_schema: CONVERSATION_SUMMARY_SCHEMA,
                    },
                }),
            },
        );

        const data = await response.json();
        return {
            ...data,
            sessionId, // إضافة معرّف الجلسة
            timestamp: new Date().toISOString()
        };
    } catch (error) {
        console.error("خطأ في استدعاء ChatGPT:", error);
        throw error;
    }
}

async function sendToWebhook(url, payload) {
    try {
        const response = await fetch(url, {
            method: "POST",
            headers: {
                "Content-Type": "application/json",
                "X-Arabic-Processing": "true"
            },
            body: JSON.stringify(payload, (key, value) => {
                return typeof value === 'string' 
                    ? value.replace(/[\u0600-\u06FF]/g, (c) => 
                        '\\u' + c.charCodeAt(0).toString(16).padStart(4, '0'))
                    : value;
            }),
        });

        if (!response.ok) {
            console.error("فشل إرسال البيانات:", await response.text());
        }
    } catch (error) {
        console.error("خطأ في الإرسال:", error);
    }
}

export async function processTranscriptAndSend(
    transcript,
    url,
    sessionId = null,
) {
    try {
        const result = await makeChatGPTCompletion(transcript, sessionId);
        
        if (result.choices?.[0]?.message?.content) {
            const summary = JSON.parse(result.choices[0].message.content);
            
            // إضافة تفاصيل الجلسة
            const enhancedSummary = {
                ...summary,
                processing_time: new Date().toISOString(),
                language: "ar-SA",
                system_version: "1.2"
            };

            console.log("الملخص النهائي:", JSON.stringify(enhancedSummary, null, 2));
            await sendToWebhook(url, enhancedSummary);
            
            return enhancedSummary;
        }
    } catch (error) {
        console.error("خطأ في معالجة المحادثة:", error);
        return {
            error: "فشل في توليد الملخص",
            details: error.message
        };
    }
}

// دالة لإنهاء الجلسة بسلاسة
export function gracefulShutdown(connection, sessionId) {
    console.log(`إنهاء الجلسة ${sessionId}...`);
    const closeMessage = {
        type: "session.end",
        session_id: sessionId,
        reason: "completed_successfully"
    };
    connection.send(JSON.stringify(closeMessage));
    connection.close();
}
