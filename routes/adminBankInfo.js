const express = require("express");
const path = require("path");
const fs = require("fs");
const multer = require("multer");
const BankInfoController = require("../controllers/BankInfoController");
const cloudinary = require("cloudinary").v2;

const router = express.Router();

// === Cloudinary Configuration ===
cloudinary.config({
  cloud_name: process.env.CLOUDINARY_CLOUD_NAME,
  api_key: process.env.CLOUDINARY_API_KEY,
  api_secret: process.env.CLOUDINARY_API_SECRET,
});

// === โฟลเดอร์เก็บไฟล์ธนาคารชั่วคราว ===
const TEMP_DIR = path.join(__dirname, "..", "temp");
fs.mkdirSync(TEMP_DIR, { recursive: true });

// === Multer Config ===
const storage = multer.diskStorage({
  destination: (_req, _file, cb) => cb(null, TEMP_DIR),
  filename: (_req, file, cb) => {
    const ext = (path.extname(file.originalname || "") || "").toLowerCase();
    const safeBase = (path.basename(file.originalname || "", ext) || "file")
      .replace(/[^\w\-]+/g, "_")
      .slice(0, 40);
    const name = `${Date.now()}-${Math.round(Math.random() * 1e9)}-${safeBase}${ext}`;
    cb(null, name);
  },
});

// ขยาย MIME ให้ครอบคลุม JFIF/pjpeg
const ALLOWED_MIME = new Set([
  "image/jpeg",
  "image/jpg",
  "image/pjpeg",   // บาง browser ส่งเป็น pjpeg
  "image/jfif",    // กันไว้สำหรับ JFIF
  "image/png",
  "image/webp",
  "image/heic",
  "image/heif",
  "application/pdf",
]);

const upload = multer({
  storage,
  limits: { fileSize: 10 * 1024 * 1024 }, // 10MB
  fileFilter: (_req, file, cb) => {
    const mt = (file.mimetype || "").toLowerCase();
    if (!ALLOWED_MIME.has(mt)) {
      console.warn("Reject upload due to MIME:", mt, "orig:", file.originalname);
      return cb(new Error("ไฟล์ต้องเป็น JPG/PNG/WEBP/HEIC/PDF และไม่เกิน 10MB"));
    }
    cb(null, true);
  },
});

// === Routes ===

// ดึงข้อมูลธนาคาร
router.get("/admin/bank-info", BankInfoController.getBankInfo);

// เพิ่มข้อมูลธนาคาร (รองรับไฟล์)
router.post(
  "/admin/bank-info",
  upload.fields([
    { name: "qrCodeImage", maxCount: 1 },
    { name: "bankLogo", maxCount: 1 },
  ]),
  async (req, res, next) => {
    // อัพโหลดไฟล์ไป Cloudinary
    try {
      if (req.files?.qrCodeImage?.[0]) {
        const qrResult = await cloudinary.uploader.upload(req.files.qrCodeImage[0].path, {
          folder: "bank_info",
          resource_type: "image",
          public_id: `qr_${Date.now()}`,
          quality: "auto:good",
          fetch_format: "auto"
        });
        req.cloudinary = req.cloudinary || {};
        req.cloudinary.qrCodeImage = qrResult;
        // ลบไฟล์ temp
        fs.promises.unlink(req.files.qrCodeImage[0].path).catch(() => {});
      }

      if (req.files?.bankLogo?.[0]) {
        const logoResult = await cloudinary.uploader.upload(req.files.bankLogo[0].path, {
          folder: "bank_info",
          resource_type: "image",
          public_id: `logo_${Date.now()}`,
          quality: "auto:good",
          fetch_format: "auto"
        });
        req.cloudinary = req.cloudinary || {};
        req.cloudinary.bankLogo = logoResult;
        // ลบไฟล์ temp
        fs.promises.unlink(req.files.bankLogo[0].path).catch(() => {});
      }

      next();
    } catch (err) {
      console.error("Cloudinary upload error:", err);
      return res.status(500).json({ error: "อัพโหลดไฟล์ไม่สำเร็จ" });
    }
  },
  BankInfoController.createBankInfo
);

// แก้ไขข้อมูลธนาคาร (รองรับไฟล์)
router.put(
  "/admin/bank-info/:id",
  upload.fields([
    { name: "qrCodeImage", maxCount: 1 },
    { name: "bankLogo", maxCount: 1 },
  ]),
  async (req, res, next) => {
    // อัพโหลดไฟล์ไป Cloudinary
    try {
      if (req.files?.qrCodeImage?.[0]) {
        const qrResult = await cloudinary.uploader.upload(req.files.qrCodeImage[0].path, {
          folder: "bank_info",
          resource_type: "image",
          public_id: `qr_${req.params.id}_${Date.now()}`,
          quality: "auto:good",
          fetch_format: "auto"
        });
        req.cloudinary = req.cloudinary || {};
        req.cloudinary.qrCodeImage = qrResult;
        // ลบไฟล์ temp
        fs.promises.unlink(req.files.qrCodeImage[0].path).catch(() => {});
      }

      if (req.files?.bankLogo?.[0]) {
        const logoResult = await cloudinary.uploader.upload(req.files.bankLogo[0].path, {
          folder: "bank_info",
          resource_type: "image",
          public_id: `logo_${req.params.id}_${Date.now()}`,
          quality: "auto:good",
          fetch_format: "auto"
        });
        req.cloudinary = req.cloudinary || {};
        req.cloudinary.bankLogo = logoResult;
        // ลบไฟล์ temp
        fs.promises.unlink(req.files.bankLogo[0].path).catch(() => {});
      }

      next();
    } catch (err) {
      console.error("Cloudinary upload error:", err);
      return res.status(500).json({ error: "อัพโหลดไฟล์ไม่สำเร็จ" });
    }
  },
  BankInfoController.updateBankInfo
);

// ลบข้อมูลธนาคาร
router.delete("/admin/bank-info/:id", BankInfoController.deleteBankInfo);

// === error handler ของ multer ===
router.use((err, _req, res, _next) => {
  if (err?.code === "LIMIT_FILE_SIZE") {
    return res.status(400).json({ ok: false, message: "ไฟล์ใหญ่เกิน 10MB" });
  }
  if (typeof err?.message === "string") {
    if (/JPG|PNG|WEBP|HEIC|PDF/i.test(err.message)) {
      return res.status(400).json({ ok: false, message: err.message });
    }
  }
  return res.status(500).json({ ok: false, message: "อัปโหลดล้มเหลว" });
});

module.exports = router;
