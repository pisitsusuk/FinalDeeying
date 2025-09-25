const express = require('express');
const router = express.Router();
const dialogflow = require('@google-cloud/dialogflow');
const uuid = require('uuid');
require('dotenv').config();

// ตั้งค่า Dialogflow
const sessionClient = new dialogflow.SessionsClient();
const projectId = process.env.DIALOGFLOW_PROJECT_ID;

// ฟังก์ชันที่เชื่อมต่อกับ Dialogflow
async function sendToDialogflow(message) {
  const sessionId = uuid.v4();
  const sessionPath = sessionClient.projectAgentSessionPath(projectId, sessionId);

  const request = {
    session: sessionPath,
    queryInput: {
      text: {
        text: message,
        languageCode: 'th', // หรือ 'en' ภาษาอังกฤษ
      },
    },
  };

  try {
    const responses = await sessionClient.detectIntent(request);
    const result = responses[0].queryResult;

    return result.fulfillmentText || "ขออภัย ฉันไม่เข้าใจคำถาม";
  } catch (error) {
    console.error('Error communicating with Dialogflow:', error);
    return "ขออภัย เกิดข้อผิดพลาดในการติดต่อกับระบบ";
  }
}

// Endpoint สำหรับรับข้อความจาก frontend และส่งไปที่ Dialogflow
router.post('/chat', async (req, res) => {
  const { message } = req.body;  // รับข้อความจาก frontend

  if (!message) {
    return res.status(400).send({ reply: "กรุณาระบุข้อความ" });
  }

  // ส่งข้อความไปที่ Dialogflow และรับคำตอบ
  const botReply = await sendToDialogflow(message);

  return res.json({ reply: botReply });
});

module.exports = router;
