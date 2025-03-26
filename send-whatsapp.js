import twilio from 'twilio';


const accountSid = 'AC1669d035f7311675a89169807c02d287';
const authToken = 'b5d208367a830b148cf4aef8b87ac025';

const client = twilio(accountSid, authToken);

client.messages.create({
    from: 'whatsapp:+14155238886',
    to: 'whatsapp:+966539322900',
    contentSid: 'HX10e6460d5e02a3139c150a2da52b1a00',
    contentVariables: JSON.stringify({
        "1": "TKT-234567",
        "2": "pending",
        "3": "2025-03-26"
    }),
}).then(message => console.log("✅ Sent! SID:", message.sid))
    .catch(err => console.error("❌ Error sending:", err));