// index.mjs
import express from 'express';
import bodyParser from 'body-parser';
import { Configuration, OpenAIApi } from 'openai';
import twilio from 'twilio';
import dotenv from 'dotenv';

dotenv.config();

const app = express();
app.use(bodyParser.urlencoded({ extended: false }));

const twilioClient = twilio(process.env.TWILIO_ACCOUNT_SID, process.env.TWILIO_AUTH_TOKEN);
const configuration = new Configuration({
    apiKey: process.env.OPENAI_API_KEY,
});
const openai = new OpenAIApi(configuration);

app.post('/voice', async (req, res) => {
    const twiml = new twilio.twiml.VoiceResponse();
    const gather = twiml.gather({
        input: 'speech',
        action: '/gather',
        speechTimeout: 'auto',
    });
    gather.say('مرحبًا! كيف يمكنني مساعدتك اليوم؟');
    res.type('text/xml');
    res.send(twiml.toString());
});

app.post('/gather', async (req, res) => {
    const userSpeech = req.body.SpeechResult;
    const prompt = `المستخدم: ${userSpeech}\nChatGPT:`;

    try {
        const response = await openai.createCompletion({
            model: 'text-davinci-003',
            prompt: prompt,
            max_tokens: 150,
            n: 1,
            stop: null,
            temperature: 0.7,
        });

        const chatGptResponse = response.data.choices[0].text.trim();
        const twiml = new twilio.twiml.VoiceResponse();
        twiml.say(chatGptResponse);
        twiml.redirect('/voice');
        res.type('text/xml');
        res.send(twiml.toString());
    } catch (error) {
        console.error('Error:', error);
        const twiml = new twilio.twiml.VoiceResponse();
        twiml.say('عذرًا، حدث خطأ. يرجى المحاولة مرة أخرى لاحقًا.');
        res.type('text/xml');
        res.send(twiml.toString());
    }
});

const port = process.env.PORT || 8000;
app.listen(port, () => {
    console.log(`Server is running on port ${port}`);
});
