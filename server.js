// Step 1 import ....
const express = require('express')
const app = express()
const morgan = require('morgan')
const { readdirSync } = require('fs')
const cors = require('cors')
const dialogflow = require('@google-cloud/dialogflow');
const uuid = require('uuid');
const { Pool } = require('pg');   // ✅ ใช้ Postgres แทน mysql2
require('dotenv').config();

// middleware
app.use(morgan('dev'))
app.use(express.json({ limit: '20mb' }))
app.use(cors())

// เชื่อมต่อกับ routes อื่นๆ เช่น auth, category, เป็นต้น
readdirSync('./routes')
  .map((c) => app.use('/api', require('./routes/' + c)))

// ✅ เชื่อมต่อ Supabase Postgres (ผ่าน DATABASE_URL ใน .env)
const db = new Pool({
  connectionString: process.env.DATABASE_URL,
  ssl: { rejectUnauthorized: false }, // Supabase ต้องใช้ SSL
});

db.connect()
  .then((client) => {
    console.log('✅ Connected to Supabase Postgres');
    client.release();
  })
  .catch((e) => console.error('❌ Postgres connect error:', e.message));

// ✅ ฟังก์ชันค้นหาสินค้าในฐานข้อมูล (แก้ให้ตรงสคีมาของ Supabase)
async function getProductInfo(productName) {
  const sql = `
    SELECT "id", "title", "price", "quantity"
    FROM "Product"
    WHERE "title" ILIKE $1
    ORDER BY "id" DESC
    LIMIT 1
  `;
  const { rows } = await db.query(sql, [`%${productName}%`]);
  return rows?.[0] || null;
}

// Step 2: ตั้งค่า Dialogflow (เหมือนเดิม)
const sessionClient = new dialogflow.SessionsClient();
const projectId = process.env.DIALOGFLOW_PROJECT_ID;
const sessionId = uuid.v4();
const sessionPath = sessionClient.projectAgentSessionPath(projectId, sessionId);

// ฟังก์ชันที่เชื่อมต่อกับ Dialogflow (เพิ่มเงื่อนไขถามราคาให้คืนข้อความ)
async function sendToDialogflow(message) {
  const request = {
    session: sessionPath,
    queryInput: {
      text: {
        text: message,
        languageCode: 'th',
      },
    },
  };

  try {
    const responses = await sessionClient.detectIntent(request);
    const result = responses[0].queryResult;

    const productName = result?.parameters?.fields?.product?.stringValue || null;

    if (result?.intent?.displayName === 'Greet') {
      return result.fulfillmentText || 'สวัสดีครับ! มีอะไรให้ช่วยไหมครับ?';
    }

    if (result?.intent?.displayName === 'ถามราคาสินค้า') {
      if (!productName) {
        return 'กรุณาระบุชื่อสินค้าที่ต้องการสอบถามด้วยครับ';
      }

      try {
        const productInfo = await getProductInfo(productName);
        if (productInfo) {
          return `สินค้าของเราคือ ${productInfo.title} ราคา ${productInfo.price} บาท คงเหลือในสต็อก ${productInfo.quantity} ชิ้น`;
        } else {
          return `ขออภัย ไม่พบข้อมูลของสินค้า ${productName}`;
        }
      } catch (dbErr) {
        console.error('DB error while fetching product price:', dbErr);
        return 'ขออภัย ระบบฐานข้อมูลขัดข้อง ลองใหม่อีกครั้งครับ';
      }
    }

    return result.fulfillmentText || 'ขออภัย ฉันไม่เข้าใจคำถาม';

  } catch (error) {
    console.error('Error communicating with Dialogflow:', error);
    return 'ขออภัย เกิดข้อผิดพลาดในการติดต่อกับระบบ';
  }
}

// เพิ่มการรับข้อความจาก frontend สำหรับ Chatbot (เหมือนเดิม)
app.post('/chat', async (req, res) => {
  const { message } = req.body;

  if (!message) {
    return res.status(400).send({ reply: 'กรุณาระบุข้อความ' });
  }

  const botReply = await sendToDialogflow(message);
  return res.json({ reply: botReply });
});

// Step 3 Start Server (เหมือนเดิม)
app.listen(5001, () => {
  console.log('Server is running on port 5001');
})
