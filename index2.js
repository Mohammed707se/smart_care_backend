// index.js
import express from 'express';
import { Configuration, OpenAIApi } from 'openai';
import twilio from 'twilio';
import axios from 'axios';
import dotenv from 'dotenv';
import fs from 'fs';
import path from 'path';

dotenv.config();

const app = express();
app.use(express.urlencoded({ extended: true }));
app.use(express.json());

const twilioClient = twilio(process.env.TWILIO_ACCOUNT_SID, process.env.TWILIO_AUTH_TOKEN);
const configuration = new Configuration({
    apiKey: process.env.OPENAI_API_KEY,
});
const openai = new OpenAIApi(configuration);

// Session storage for conversation history
const sessions = {};

/**
 * Entry point for incoming calls
 */
app.post('/voice', (req, res) => {
    const twiml = new twilio.twiml.VoiceResponse();

    // Greet the caller and prompt for input
    const gather = twiml.gather({
        input: 'speech',
        action: '/process_speech',
        method: 'POST',
        timeout: 5,
        language: 'ar-SA', // Arabic language
    });

    gather.say('مرحبًا! كيف يمكنني مساعدتك اليوم؟', { language: 'ar-SA' });

    res.type('text/xml');
    res.send(twiml.toString());
});

/**
 * Processes the caller's speech input
 */
app.post('/process_speech', async (req, res) => {
    const callSid = req.body.CallSid;
    const recordingUrl = req.body.RecordingUrl;

    if (!recordingUrl) {
        // No speech detected, prompt again
        const twiml = new twilio.twiml.VoiceResponse();
        twiml.say('لم أتمكن من سماعك. هل يمكنك تكرار ذلك من فضلك؟', { language: 'ar-SA' });
        twiml.redirect('/voice');
        res.type('text/xml');
        res.send(twiml.toString());
        return;
    }

    try {
        // Download the audio recording
        const audioResponse = await axios.get(`${recordingUrl}.wav`, { responseType: 'arraybuffer' });
        const audioBuffer = Buffer.from(audioResponse.data, 'binary');

        // Save the audio file temporarily
        const audioFileName = `recording-${callSid}.wav`;
        const audioFilePath = path.join('/tmp', audioFileName);
        fs.writeFileSync(audioFilePath, audioBuffer);

        // Transcribe using OpenAI Whisper
        const transcription = await openai.createTranscription(
            fs.createReadStream(audioFilePath),
            'whisper-1'
        );

        // Delete the temporary audio file
        fs.unlinkSync(audioFilePath);

        const userSpeech = transcription.data.text;
        console.log(`Transcription: ${userSpeech}`);

        // Retrieve or initialize session messages
        let messages = sessions[callSid] || [{ role: 'system', content: 'You are a helpful assistant that communicates in Arabic.' }];
        messages.push({ role: 'user', content: userSpeech });

        // Generate AI response
        const chatResponse = await openai.createChatCompletion({
            model: 'gpt-3.5-turbo',
            messages: messages,
            temperature: 0.7,
        });

        const aiResponse = chatResponse.data.choices[0].message.content;
        console.log(`AI Response: ${aiResponse}`);

        // Add assistant's response to the messages
        messages.push({ role: 'assistant', content: aiResponse });

        // Save the updated messages
        sessions[callSid] = messages;

        // Respond to the caller
        const twiml = new twilio.twiml.VoiceResponse();
        twiml.say(aiResponse, { language: 'ar-SA' });

        // Redirect back to /voice to continue the conversation
        twiml.redirect('/voice');

        res.type('text/xml');
        res.send(twiml.toString());
    } catch (error) {
        console.error('Error:', error.response ? error.response.data : error.message);
        const twiml = new twilio.twiml.VoiceResponse();
        twiml.say('عذرًا، حدث خطأ. يرجى المحاولة مرة أخرى لاحقًا.', { language: 'ar-SA' });
        res.type('text/xml');
        res.send(twiml.toString());
    }
});

/**
 * Endpoint to initiate a call
 */
app.post('/make-call', async (req, res) => {
    const apiKey = req.headers['x-api-key'];
    if (apiKey !== process.env.API_KEY) {
        return res.status(401).json({ success: false, message: 'Unauthorized' });
    }

    const { to } = req.body;

    // Validate the 'to' parameter
    const phoneRegex = /^\+?[1-9]\d{1,14}$/; // E.164 format
    if (!to || !phoneRegex.test(to)) {
        return res.status(400).json({ success: false, message: 'Invalid or missing "to" phone number.' });
    }

    try {
        const call = await twilioClient.calls.create({
            url: `${process.env.SERVER_URL}/voice`,
            to: to,
            from: process.env.TWILIO_PHONE_NUMBER,
        });

        console.log(`Call initiated with SID: ${call.sid}`);
        res.json({ success: true, callSid: call.sid });
    } catch (error) {
        console.error('Error initiating call:', error);
        res.status(500).json({ success: false, message: 'Failed to initiate call.', error: error.message });
    }
});

/**
 * Endpoint to handle call completion
 */
app.post('/call-completed', (req, res) => {
    const callSid = req.body.CallSid;
    delete sessions[callSid];
    res.sendStatus(200);
});

const port = process.env.PORT || 8000;
app.listen(port, () => {
    console.log(`Server is running on port ${port}`);
});
